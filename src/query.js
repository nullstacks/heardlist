import { PROTOCOLS, ANONYMITY, SOURCES, SOURCE_ORDER } from './ingest.js';

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 5000;

const ANON_RANK = { elite: 0, anonymous: 1, transparent: 2 };

// ---------- index (in-memory per isolate, short TTL) ----------

let memo = { at: 0, index: null };
const MEMO_MS = 60_000;

export function resetMemo() {
  memo = { at: 0, index: null };
}

export function buildIndex(meta, perSource) {
  const seen = new Set();
  const records = [];
  for (const name of SOURCE_ORDER) {
    const data = perSource[name];
    if (!data || !Array.isArray(data.items)) continue;
    const verified = SOURCES[name].verified;
    for (const [host, port, protocol, country, anonymity, latency] of data.items) {
      const key = `${protocol}|${host}:${port}`;
      if (seen.has(key)) continue; // higher-tier source wins
      seen.add(key);
      records.push({
        proxy: `${host}:${port}`,
        host,
        port,
        protocol,
        country,
        anonymity,
        latency,
        source: name,
        verified,
      });
    }
  }
  // Default "quality" order: source tier, then measured latency, then anonymity.
  const tier = (r) => SOURCES[r.source].tier;
  records.sort(
    (a, b) =>
      tier(a) - tier(b) ||
      (a.latency ?? Infinity) - (b.latency ?? Infinity) ||
      (ANON_RANK[a.anonymity] ?? 3) - (ANON_RANK[b.anonymity] ?? 3),
  );
  return { meta: meta || { updated_at: null, sources: {} }, records };
}

export async function loadIndex(env, now = Date.now()) {
  if (memo.index && now - memo.at < MEMO_MS) return memo.index;
  const [meta, ...rest] = await Promise.all([
    env.PROXIES.get('meta', 'json'),
    ...SOURCE_ORDER.map((n) => env.PROXIES.get(`src:${n}`, 'json')),
  ]);
  const perSource = {};
  SOURCE_ORDER.forEach((n, i) => (perSource[n] = rest[i]));
  const index = buildIndex(meta, perSource);
  memo = { at: now, index };
  return index;
}

// ---------- query parsing ----------

const csv = (v) =>
  v == null || v === ''
    ? null
    : v
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);

export class QueryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function enumList(params, key, allowed) {
  const list = csv(params.get(key));
  if (!list) return null;
  const bad = list.filter((x) => !allowed.includes(x));
  if (bad.length) {
    throw new QueryError('invalid_param', `Invalid ${key}: ${bad.join(', ')}. Allowed: ${allowed.join(', ')}.`);
  }
  return new Set(list);
}

function intParam(params, key, def, min, max) {
  const v = params.get(key);
  if (v == null || v === '') return def;
  if (!/^\d+$/.test(v)) throw new QueryError('invalid_param', `${key} must be an integer.`);
  const n = parseInt(v, 10);
  if (n < min || n > max) throw new QueryError('invalid_param', `${key} must be between ${min} and ${max}.`);
  return n;
}

function boolParam(params, key) {
  const v = params.get(key);
  if (v == null || v === '') return null;
  if (['true', '1', 'yes'].includes(v.toLowerCase())) return true;
  if (['false', '0', 'no'].includes(v.toLowerCase())) return false;
  throw new QueryError('invalid_param', `${key} must be true or false.`);
}

export function parseQuery(params, overrides = {}) {
  const p = new URLSearchParams(params);
  for (const [k, v] of Object.entries(overrides)) p.set(k, v);

  let country = csv(p.get('country'));
  if (country) {
    const bad = country.filter((c) => !/^[a-z]{2}$/.test(c));
    if (bad.length) throw new QueryError('invalid_param', `Invalid country: ${bad.join(', ')}. Use ISO 3166-1 alpha-2 codes such as US,DE.`);
    country = new Set(country.map((c) => c.toUpperCase()));
  }

  const sort = (p.get('sort') || 'quality').toLowerCase();
  if (!['quality', 'latency', 'random'].includes(sort)) {
    throw new QueryError('invalid_param', 'sort must be quality, latency or random.');
  }
  const format = (p.get('format') || 'json').toLowerCase();
  if (!['json', 'txt', 'csv'].includes(format)) {
    throw new QueryError('invalid_param', 'format must be json, txt or csv.');
  }
  let maxLatency = null;
  if (p.get('max_latency')) {
    maxLatency = parseFloat(p.get('max_latency'));
    if (!Number.isFinite(maxLatency) || maxLatency <= 0 || maxLatency > 120) {
      throw new QueryError('invalid_param', 'max_latency must be a number of seconds between 0 and 120.');
    }
  }

  return {
    protocol: enumList(p, 'protocol', PROTOCOLS),
    anonymity: enumList(p, 'anonymity', ANONYMITY),
    source: enumList(p, 'source', SOURCE_ORDER),
    country,
    verified: boolParam(p, 'verified'),
    maxLatency,
    sort,
    format,
    scheme: boolParam(p, 'scheme') === true,
    limit: intParam(p, 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT),
    offset: intParam(p, 'offset', 0, 0, 1_000_000),
  };
}

// ---------- execution ----------

export function runQuery(records, q, rng = Math.random) {
  let rows = records.filter(
    (r) =>
      (!q.protocol || q.protocol.has(r.protocol)) &&
      (!q.country || (r.country && q.country.has(r.country))) &&
      (!q.anonymity || (r.anonymity && q.anonymity.has(r.anonymity))) &&
      (!q.source || q.source.has(r.source)) &&
      (q.verified == null || r.verified === q.verified) &&
      (q.maxLatency == null || (r.latency != null && r.latency <= q.maxLatency)),
  );
  const total = rows.length;

  if (q.sort === 'latency') {
    rows = rows.filter((r) => r.latency != null).sort((a, b) => a.latency - b.latency);
    return { total: rows.length, rows: rows.slice(q.offset, q.offset + q.limit) };
  }
  if (q.sort === 'random') {
    // partial Fisher-Yates over a copy: only `limit` swaps
    rows = rows.slice();
    const n = Math.min(q.limit, rows.length);
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(rng() * (rows.length - i));
      [rows[i], rows[j]] = [rows[j], rows[i]];
    }
    return { total, rows: rows.slice(0, n) };
  }
  return { total, rows: rows.slice(q.offset, q.offset + q.limit) };
}

// ---------- formatting ----------

// The URL scheme says how a client talks TO the proxy. "https" entries are
// plain HTTP proxies that tunnel TLS via CONNECT, so their URL scheme is http://.
export const proxyScheme = (r) => (r.protocol === 'https' ? 'http' : r.protocol);

export function toJson(r) {
  return {
    proxy: r.proxy,
    url: `${proxyScheme(r)}://${r.proxy}`,
    protocol: r.protocol,
    host: r.host,
    port: r.port,
    country: r.country,
    anonymity: r.anonymity,
    latency: r.latency,
    source: r.source,
    verified: r.verified,
  };
}

export function toTxt(rows, scheme) {
  return rows.map((r) => (scheme ? `${proxyScheme(r)}://${r.proxy}` : r.proxy)).join('\n') + (rows.length ? '\n' : '');
}

export function toCsv(rows) {
  const head = 'host,port,protocol,country,anonymity,latency,source,verified';
  const lines = rows.map((r) =>
    [r.host, r.port, r.protocol, r.country ?? '', r.anonymity ?? '', r.latency ?? '', r.source, r.verified].join(','),
  );
  return [head, ...lines].join('\n') + '\n';
}

export function computeStats(index, now = Date.now()) {
  const byProtocol = Object.fromEntries(PROTOCOLS.map((p) => [p, 0]));
  const bySource = Object.fromEntries(SOURCE_ORDER.map((s) => [s, 0]));
  const countries = new Set();
  let verified = 0;
  for (const r of index.records) {
    byProtocol[r.protocol]++;
    bySource[r.source]++;
    if (r.verified) verified++;
    if (r.country) countries.add(r.country);
  }
  const updated = index.meta.updated_at;
  const ageMin = updated ? Math.max(0, Math.round((now - Date.parse(updated)) / 60000)) : null;
  return {
    total: index.records.length,
    verified,
    countries: countries.size,
    by_protocol: byProtocol,
    by_source: bySource,
    updated_at: updated,
    age_minutes: ageMin,
    stale: ageMin == null ? true : ageMin > 180,
    sources: index.meta.sources || {},
  };
}
