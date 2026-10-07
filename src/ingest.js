// Ingestion: pulls public community proxy lists, normalises them into one
// compact tuple format, and stores one KV value per source.
//
// Tuple: [host, port, protocol, country|null, anonymity|null, latencySeconds|null]

export const PROTOCOLS = ['http', 'https', 'socks4', 'socks5'];
export const ANONYMITY = ['elite', 'anonymous', 'transparent'];

export const SOURCES = {
  monosans: {
    name: 'monosans',
    label: 'monosans/proxy-list',
    tier: 1,
    verified: true,
    homepage: 'https://github.com/monosans/proxy-list',
    license: 'MIT',
    description:
      'Re-checked hourly with a full real-page fetch. Sorted fastest-first upstream. Carries response time, country and ASN.',
  },
  proxifly: {
    name: 'proxifly',
    label: 'proxifly/free-proxy-list',
    tier: 2,
    verified: false,
    homepage: 'https://github.com/proxifly/free-proxy-list',
    license: 'see upstream',
    description:
      'Very large raw pool with anonymity and country fields. Not verified by us; anonymity is mostly "transparent" and the upstream score field carries no signal.',
  },
  thespeedx: {
    name: 'thespeedx',
    label: 'TheSpeedX/PROXY-List',
    tier: 3,
    verified: false,
    homepage: 'https://github.com/TheSpeedX/PROXY-List',
    license: 'see upstream',
    description:
      'Daily plain host:port lists with no metadata and no verification evidence. Supplement only.',
  },
};

export const SOURCE_ORDER = ['monosans', 'proxifly', 'thespeedx'];

// Cap how many entries of one protocol we keep from a single source.
export const MAX_PER_SOURCE_PROTOCOL = 10000;

const URLS = {
  monosansJson: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies.json',
  monosansTxt: (p) => `https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/${p}.txt`,
  proxiflyJson: (p) =>
    `https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/${p}/data.json`,
  proxiflyTxt: (p) =>
    `https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/${p}/data.txt`,
  speedxTxt: (p) => `https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/${p}.txt`,
};

// ---------- normalisation helpers ----------

export function isPublicIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return false;
  const [a, b] = o;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  return true;
}

export function validPort(p) {
  return Number.isInteger(p) && p >= 1 && p <= 65535;
}

export function normCountry(c) {
  if (typeof c !== 'string') return null;
  const u = c.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(u) ? u : null;
}

export function normAnonymity(a) {
  if (typeof a !== 'string') return null;
  const s = a.trim().toLowerCase();
  if (s === 'elite' || s.startsWith('high')) return 'elite';
  if (s === 'anonymous' || s === 'anonymous proxy') return 'anonymous';
  if (s === 'transparent') return 'transparent';
  return null;
}

export function normLatency(t) {
  const n = typeof t === 'number' ? t : parseFloat(t);
  return Number.isFinite(n) && n > 0 && n < 120 ? Math.round(n * 100) / 100 : null;
}

function makeTuple(host, port, proto, country = null, anon = null, latency = null) {
  const p = typeof port === 'string' ? parseInt(port, 10) : port;
  if (!PROTOCOLS.includes(proto)) return null;
  if (typeof host !== 'string' || !isPublicIPv4(host) || !validPort(p)) return null;
  return [host, p, proto, normCountry(country), normAnonymity(anon), normLatency(latency)];
}

/** Parse "[scheme://]host:port" lines. */
export function parseTxtList(text, defaultProto, cap = MAX_PER_SOURCE_PROTOCOL) {
  const out = [];
  const seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let proto = defaultProto;
    let rest = line;
    const sch = /^([a-z0-9]+):\/\/(.*)$/i.exec(line);
    if (sch) {
      proto = sch[1].toLowerCase();
      rest = sch[2];
    }
    if (rest.includes('@')) continue; // credentialed entries are not public
    const i = rest.lastIndexOf(':');
    if (i < 0) continue;
    const t = makeTuple(rest.slice(0, i), rest.slice(i + 1), proto);
    if (!t) continue;
    const k = `${t[2]}|${t[0]}:${t[1]}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}

export function normalizeMonosans(arr) {
  const out = [];
  const counts = {};
  if (!Array.isArray(arr)) return out;
  for (const e of arr) {
    if (!e || e.username || e.password) continue;
    const proto = typeof e.protocol === 'string' ? e.protocol.toLowerCase() : '';
    const g = e.geolocation || {};
    const country = g.country && typeof g.country === 'object' ? g.country.iso_code : g.country;
    const t = makeTuple(e.host, e.port, proto, country, null, e.timeout);
    if (!t) continue;
    counts[proto] = (counts[proto] || 0) + 1;
    if (counts[proto] > MAX_PER_SOURCE_PROTOCOL) continue;
    out.push(t);
  }
  return out;
}

export function normalizeProxifly(arr, proto) {
  const out = [];
  if (!Array.isArray(arr)) return out;
  for (const e of arr) {
    if (!e) continue;
    let host = e.ip;
    let port = e.port;
    if (!host && typeof e.proxy === 'string') {
      const m = /^(?:[a-z0-9]+:\/\/)?([^:/]+):(\d+)/i.exec(e.proxy);
      if (m) [host, port] = [m[1], m[2]];
    }
    const g = e.geolocation || {};
    const country = g.country && typeof g.country === 'object' ? g.country.iso_code : g.country;
    const t = makeTuple(host, port, proto, country, e.anonymity, null);
    if (!t) continue;
    out.push(t);
    if (out.length >= MAX_PER_SOURCE_PROTOCOL) break;
  }
  return out;
}

// ---------- fetching ----------

async function get(url, as = 'text') {
  const res = await fetch(url, {
    headers: { 'user-agent': 'heardlist/1.0 (+public proxy list aggregator)' },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > 60 * 1024 * 1024) throw new Error(`too large: ${url}`);
  return as === 'json' ? res.json() : res.text();
}

async function loadMonosans() {
  try {
    return { items: normalizeMonosans(await get(URLS.monosansJson, 'json')), partial: [] };
  } catch (jsonErr) {
    // Fallback: plain text lists (no latency / country).
    const protos = ['http', 'socks4', 'socks5'];
    const res = await Promise.allSettled(protos.map((p) => get(URLS.monosansTxt(p))));
    const items = [];
    const failed = [];
    res.forEach((r, i) => {
      if (r.status === 'fulfilled') items.push(...parseTxtList(r.value, protos[i]));
      else failed.push(protos[i]);
    });
    if (failed.length === protos.length) throw jsonErr;
    return { items, partial: failed, note: 'json unavailable, used txt fallback' };
  }
}

async function loadProxifly() {
  const jobs = [
    ['http', () => get(URLS.proxiflyJson('http'), 'json').then((j) => normalizeProxifly(j, 'http'))],
    ['https', () => get(URLS.proxiflyJson('https'), 'json').then((j) => normalizeProxifly(j, 'https'))],
    ['socks4', () => get(URLS.proxiflyJson('socks4'), 'json').then((j) => normalizeProxifly(j, 'socks4'))],
    // socks5 is ~45k entries; the txt file keeps CPU and memory small.
    ['socks5', () => get(URLS.proxiflyTxt('socks5')).then((t) => parseTxtList(t, 'socks5'))],
  ];
  const res = await Promise.allSettled(jobs.map(([, fn]) => fn()));
  const items = [];
  const failed = [];
  res.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value);
    else failed.push(jobs[i][0]);
  });
  if (failed.length === jobs.length) throw new Error('all proxifly files failed');
  return { items, partial: failed };
}

async function loadSpeedx() {
  const protos = ['http', 'socks4', 'socks5'];
  const res = await Promise.allSettled(protos.map((p) => get(URLS.speedxTxt(p))));
  const items = [];
  const failed = [];
  res.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...parseTxtList(r.value, protos[i]));
    else failed.push(protos[i]);
  });
  if (failed.length === protos.length) throw new Error('all TheSpeedX files failed');
  return { items, partial: failed };
}

const LOADERS = { monosans: loadMonosans, proxifly: loadProxifly, thespeedx: loadSpeedx };

// ---------- refresh ----------

const SRC_TTL = 12 * 60 * 60; // drop data nobody refreshed for 12h; stale lists are worse than none

/**
 * Refresh every source. A failing source keeps its previous data
 * (for whole-source failure) or previous entries for the failed protocols.
 */
export async function refreshAll(env, now = Date.now()) {
  const kv = env.PROXIES;
  const prevMeta = (await kv.get('meta', 'json')) || { sources: {} };
  const meta = { updated_at: new Date(now).toISOString(), sources: {} };

  await Promise.all(
    SOURCE_ORDER.map(async (name) => {
      const prev = await kv.get(`src:${name}`, 'json');
      try {
        const r = await LOADERS[name]();
        let items = r.items;
        if (r.partial.length && prev && Array.isArray(prev.items)) {
          items = items.concat(prev.items.filter((t) => r.partial.includes(t[2])));
        }
        await kv.put(
          `src:${name}`,
          JSON.stringify({ fetched_at: new Date(now).toISOString(), items }),
          { expirationTtl: SRC_TTL },
        );
        meta.sources[name] = {
          ok: true,
          fetched_at: new Date(now).toISOString(),
          count: items.length,
          ...(r.partial.length ? { partial_failure: r.partial } : {}),
          ...(r.note ? { note: r.note } : {}),
        };
      } catch (err) {
        const old = prevMeta.sources?.[name] || {};
        meta.sources[name] = {
          ok: false,
          fetched_at: old.fetched_at || null,
          count: old.count || 0,
          error: String(err && err.message ? err.message : err).slice(0, 200),
          last_attempt: new Date(now).toISOString(),
        };
      }
    }),
  );

  await kv.put('meta', JSON.stringify(meta));
  return meta;
}
