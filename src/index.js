import { CORS, json, problem } from './util.js';
import { refreshAll, SOURCES, SOURCE_ORDER, PROTOCOLS } from './ingest.js';
import {
  loadIndex,
  parseQuery,
  runQuery,
  toJson,
  toTxt,
  toCsv,
  computeStats,
  QueryError,
} from './query.js';

const TXT = 'text/plain; charset=utf-8';
const CSV = 'text/csv; charset=utf-8';

const ENDPOINTS = {
  proxies: '/v1/proxies',
  random: '/v1/random',
  by_protocol_txt: '/v1/{http|https|socks4|socks5}.txt',
  stats: '/v1/stats',
  sources: '/v1/sources',
  health: '/v1/health',
  docs: '/docs/',
};

async function handleList(request, env, url, overrides, forceFormat) {
  let q;
  try {
    q = parseQuery(url.searchParams, overrides);
  } catch (e) {
    if (e instanceof QueryError) return problem(400, e.code, e.message);
    throw e;
  }
  if (forceFormat) q.format = forceFormat;

  const index = await loadIndex(env);
  const { total, rows } = runQuery(index.records, q);
  const updated = index.meta.updated_at;

  // Short browser cache, longer shared cache. Random draws are never cached.
  const cacheable = q.sort !== 'random';
  const headers = {
    'cache-control': cacheable ? 'public, max-age=60, s-maxage=300' : 'no-store',
    'x-total-count': String(total),
    ...(updated ? { 'x-updated-at': updated } : {}),
  };

  if (q.format === 'txt') {
    return new Response(toTxt(rows, q.scheme), { headers: { 'content-type': TXT, ...CORS, ...headers } });
  }
  if (q.format === 'csv') {
    return new Response(toCsv(rows), { headers: { 'content-type': CSV, ...CORS, ...headers } });
  }
  return json(
    {
      meta: {
        count: rows.length,
        total,
        limit: q.limit,
        offset: q.sort === 'random' ? 0 : q.offset,
        sort: q.sort,
        updated_at: updated,
      },
      data: rows.map(toJson),
    },
    200,
    { headers },
  );
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/v1') {
    return json({ name: 'Heardlist', version: 1, docs: '/docs/', endpoints: ENDPOINTS });
  }
  if (path === '/v1/health') {
    const index = await loadIndex(env);
    const s = computeStats(index);
    return json({ ok: s.total > 0 && !s.stale, total: s.total, updated_at: s.updated_at, stale: s.stale }, s.total > 0 ? 200 : 503, {
      headers: { 'cache-control': 'no-store' },
    });
  }
  if (path === '/v1/proxies') return handleList(request, env, url, {}, null);
  if (path === '/v1/random') return handleList(request, env, url, { sort: 'random', limit: url.searchParams.get('limit') || '1' }, null);

  const m = /^\/v1\/(http|https|socks4|socks5)\.txt$/.exec(path);
  if (m) return handleList(request, env, url, { protocol: m[1] }, 'txt');

  if (path === '/v1/stats') {
    const index = await loadIndex(env);
    return json(computeStats(index), 200, { headers: { 'cache-control': 'public, max-age=60, s-maxage=120' } });
  }
  if (path === '/v1/sources') {
    const index = await loadIndex(env);
    const data = SOURCE_ORDER.map((n) => ({
      ...SOURCES[n],
      status: index.meta.sources?.[n] || null,
    }));
    return json({ data }, 200, { headers: { 'cache-control': 'public, max-age=300' } });
  }
  if (path === '/v1/admin/refresh') {
    if (request.method !== 'POST' || !env.ADMIN_TOKEN) return problem(404, 'not_found', 'Not found.');
    if (request.headers.get('authorization') !== `Bearer ${env.ADMIN_TOKEN}`) {
      return problem(401, 'unauthorized', 'Bad or missing bearer token.');
    }
    ctx.waitUntil(refreshAll(env));
    return json({ accepted: true }, 202);
  }
  return problem(404, 'not_found', `No such endpoint. See ${url.origin}/docs/`);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    if (!url.pathname.startsWith('/v1')) {
      // run_worker_first only sends /v1/* here; anything else belongs to static assets.
      return env.ASSETS ? env.ASSETS.fetch(request) : problem(404, 'not_found', 'Not found.');
    }
    if (request.method !== 'GET' && request.method !== 'HEAD' && url.pathname !== '/v1/admin/refresh') {
      return problem(405, 'method_not_allowed', 'Only GET is supported.', { headers: { allow: 'GET, HEAD, OPTIONS' } });
    }

    if (env.RATE_LIMITER) {
      const ip = request.headers.get('cf-connecting-ip') || 'anon';
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) {
        return problem(429, 'rate_limited', 'Too many requests. Slow down and retry in a minute.', {
          headers: { 'retry-after': '60' },
        });
      }
    }

    // Shared edge cache for identical, cacheable GETs.
    const canCache = request.method === 'GET' && typeof caches !== 'undefined' && !url.pathname.endsWith('/random') && url.searchParams.get('sort') !== 'random' && url.pathname !== '/v1/admin/refresh';
    const cache = canCache ? caches.default : null;
    if (cache) {
      const hit = await cache.match(request);
      if (hit) return hit;
    }

    let res;
    try {
      res = await route(request, env, ctx);
    } catch (err) {
      console.error('unhandled', err && err.stack ? err.stack : err);
      return problem(500, 'internal_error', 'Something went wrong on our side.');
    }
    if (cache && res.status === 200 && res.headers.get('cache-control')?.includes('s-maxage')) {
      ctx.waitUntil(cache.put(request, res.clone()));
    }
    return res;
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshAll(env).then((m) => console.log('refreshed', JSON.stringify(m))));
  },
};

export { PROTOCOLS };
