import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { refreshAll, parseTxtList, normalizeMonosans, normalizeProxifly, isPublicIPv4 } from '../src/ingest.js';
import { resetMemo } from '../src/query.js';

// ---- fixtures ----
const monosansJson = [
  { protocol: 'socks5', host: '8.8.4.4', port: 1080, timeout: 0.18, geolocation: { country: { iso_code: 'US' } } },
  { protocol: 'http', host: '1.1.1.9', port: 8080, timeout: 2.55, geolocation: { country: { iso_code: 'DE' } } },
  { protocol: 'http', host: '10.0.0.5', port: 8080, timeout: 1 },            // private -> dropped
  { protocol: 'http', host: '5.5.5.5', port: 99999, timeout: 1 },            // bad port -> dropped
  { protocol: 'http', host: '6.6.6.6', port: 80, username: 'u', password: 'p' }, // credentialed -> dropped
];
const proxiflyHttp = [
  { ip: '1.1.1.9', port: 8080, protocol: 'http', anonymity: 'elite', geolocation: { country: 'DE' }, score: 1 }, // dup of monosans
  { ip: '2.2.2.2', port: 3128, protocol: 'http', anonymity: 'transparent', geolocation: { country: 'FR' } },
];
const proxiflyHttps = [{ proxy: 'https://3.3.3.3:443', protocol: 'https', anonymity: 'elite', geolocation: { country: 'US' } }];
const text = {
  'proxifly/free-proxy-list@main/proxies/protocols/socks5/data.txt': 'socks5://4.4.4.4:1080\nsocks5://4.4.4.4:1080\nsocks5://192.168.1.1:1080\n',
  'TheSpeedX/PROXY-List/master/http.txt': '7.7.7.7:8000\n1.1.1.9:8080\n',
  'TheSpeedX/PROXY-List/master/socks4.txt': '7.7.7.8:1081\n',
  'TheSpeedX/PROXY-List/master/socks5.txt': '7.7.7.9:1082\n',
};

function fakeFetch(failMatch) {
  return async (url) => {
    const u = String(url);
    if (failMatch && u.includes(failMatch)) return new Response('nope', { status: 500 });
    if (u.endsWith('monosans/proxy-list/main/proxies.json')) return Response.json(monosansJson);
    if (u.includes('protocols/http/data.json')) return Response.json(proxiflyHttp);
    if (u.includes('protocols/https/data.json')) return Response.json(proxiflyHttps);
    if (u.includes('protocols/socks4/data.json')) return Response.json([]);
    for (const [k, v] of Object.entries(text)) if (u.includes(k)) return new Response(v);
    return new Response('not found', { status: 404 });
  };
}

function fakeKV() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k); return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
  };
}
const ctx = { waitUntil() {} };
const call = async (env, path, init) => worker.fetch(new Request('https://x.test' + path, init), env, ctx);

test('ip + parse helpers', () => {
  assert.equal(isPublicIPv4('8.8.8.8'), true);
  for (const bad of ['10.1.1.1', '127.0.0.1', '192.168.0.1', '172.20.0.1', '169.254.1.1', '0.0.0.0', '999.1.1.1', '100.64.0.1', 'abc'])
    assert.equal(isPublicIPv4(bad), false, bad);
  assert.equal(parseTxtList('1.2.3.4:80\n# c\nbad\nhttp://5.6.7.8:8080\nuser:pw@9.9.9.9:80', 'http').length, 2);
  assert.equal(normalizeMonosans(monosansJson).length, 2);
  assert.equal(normalizeProxifly(proxiflyHttps, 'https')[0][0], '3.3.3.3');
});

test('refresh, dedupe, filter, formats', async () => {
  globalThis.fetch = fakeFetch();
  resetMemo();
  const env = { PROXIES: fakeKV() };
  const meta = await refreshAll(env);
  assert.ok(Object.values(meta.sources).every((s) => s.ok));

  // all
  let j = await (await call(env, '/v1/proxies?limit=1000')).json();
  // monosans 2 + proxifly (2.2.2.2, 3.3.3.3, 4.4.4.4) + speedx (7.7.7.7, .8, .9)  [1.1.1.9 deduped]
  assert.equal(j.meta.total, 8);
  assert.equal(j.data[0].source, 'monosans');
  assert.equal(j.data[0].latency, 0.18);             // fastest verified first
  assert.equal(j.data.find((r) => r.proxy === '1.1.1.9:8080').source, 'monosans');

  // filters
  j = await (await call(env, '/v1/proxies?protocol=socks5&country=us')).json();
  assert.deepEqual(j.data.map((r) => r.proxy), ['8.8.4.4:1080']);
  j = await (await call(env, '/v1/proxies?verified=true')).json();
  assert.equal(j.meta.total, 2);
  j = await (await call(env, '/v1/proxies?anonymity=elite&source=proxifly')).json();
  assert.deepEqual(j.data.map((r) => r.proxy), ['3.3.3.3:443']);
  j = await (await call(env, '/v1/proxies?max_latency=1')).json();
  assert.equal(j.meta.total, 1);
  j = await (await call(env, '/v1/proxies?sort=latency&limit=1&offset=1')).json();
  assert.equal(j.data[0].proxy, '1.1.1.9:8080');
  j = await (await call(env, '/v1/proxies?limit=2&offset=2')).json();
  assert.equal(j.meta.count, 2);

  // txt / csv / scheme
  let r = await call(env, '/v1/socks5.txt?verified=true');
  assert.equal(await r.text(), '8.8.4.4:1080\n');
  assert.match(r.headers.get('content-type'), /text\/plain/);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  r = await call(env, '/v1/proxies?format=txt&scheme=true&protocol=https');
  assert.equal(await r.text(), 'http://3.3.3.3:443\n'); // https entries are HTTP proxies that tunnel TLS
  r = await call(env, '/v1/proxies?format=csv&protocol=https');
  assert.equal(await r.text(), 'host,port,protocol,country,anonymity,latency,source,verified\n3.3.3.3,443,https,US,elite,,proxifly,false\n');

  // random
  r = await call(env, '/v1/random?protocol=http');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  j = await r.json();
  assert.equal(j.data.length, 1);
  assert.equal(j.data[0].protocol, 'http');
  j = await (await call(env, '/v1/random?limit=3')).json();
  assert.equal(new Set(j.data.map((d) => d.proxy)).size, 3);

  // stats / sources / health
  const s = await (await call(env, '/v1/stats')).json();
  assert.equal(s.total, 8);
  assert.equal(s.verified, 2);
  assert.equal(s.stale, false);
  assert.equal(s.by_protocol.socks5, 3);
  const src = await (await call(env, '/v1/sources')).json();
  assert.equal(src.data.length, 3);
  assert.equal((await call(env, '/v1/health')).status, 200);
});

test('validation + routing errors', async () => {
  resetMemo();
  const env = { PROXIES: fakeKV() };
  for (const q of ['protocol=ftp', 'limit=0', 'limit=99999', 'country=USA', 'sort=best', 'format=xml', 'verified=maybe', 'max_latency=-1', 'offset=-3']) {
    const r = await call(env, '/v1/proxies?' + q);
    assert.equal(r.status, 400, q);
    assert.equal((await r.json()).error.code, 'invalid_param');
  }
  assert.equal((await call(env, '/v1/nope')).status, 404);
  assert.equal((await call(env, '/v1/proxies', { method: 'POST' })).status, 405);
  assert.equal((await call(env, '/v1/proxies', { method: 'OPTIONS' })).status, 204);
  assert.equal((await call(env, '/v1/health')).status, 503);       // empty store
  const empty = await (await call(env, '/v1/proxies')).json();     // empty store still answers
  assert.deepEqual(empty.data, []);
  assert.equal((await call(env, '/v1/admin/refresh', { method: 'POST' })).status, 404); // no token configured
});

test('admin refresh needs token', async () => {
  resetMemo();
  const env = { PROXIES: fakeKV(), ADMIN_TOKEN: 's3cret' };
  assert.equal((await call(env, '/v1/admin/refresh', { method: 'POST' })).status, 401);
  assert.equal((await call(env, '/v1/admin/refresh', { method: 'POST', headers: { authorization: 'Bearer s3cret' } })).status, 202);
});

test('rate limiter returns 429', async () => {
  resetMemo();
  const env = { PROXIES: fakeKV(), RATE_LIMITER: { limit: async () => ({ success: false }) } };
  const r = await call(env, '/v1/proxies');
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '60');
});

test('a failing source keeps its previous data; partial failure carries old protocol entries', async () => {
  resetMemo();
  const env = { PROXIES: fakeKV() };
  globalThis.fetch = fakeFetch();
  await refreshAll(env);
  // now everything TheSpeedX is down, and proxifly https is down
  globalThis.fetch = fakeFetch('TheSpeedX');
  let meta = await refreshAll(env);
  assert.equal(meta.sources.thespeedx.ok, false);
  assert.equal(meta.sources.thespeedx.count, 4); // raw count, before cross-source dedupe
  resetMemo();
  let s = await (await call(env, '/v1/stats')).json();
  assert.equal(s.by_source.thespeedx, 3);               // old data survives
  globalThis.fetch = fakeFetch('protocols/https/data.json');
  meta = await refreshAll(env);
  assert.deepEqual(meta.sources.proxifly.partial_failure, ['https']);
  resetMemo();
  const j = await (await call(env, '/v1/proxies?protocol=https')).json();
  assert.equal(j.data.length, 1);                        // carried over
});
