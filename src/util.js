export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-expose-headers': 'x-updated-at, x-total-count, retry-after',
  'access-control-max-age': '86400',
};

export function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...CORS,
      ...(extra.headers || {}),
    },
  });
}

export function problem(status, code, message, extra = {}) {
  return json({ error: { code, message } }, status, extra);
}
