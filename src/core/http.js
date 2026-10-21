// @ts-check
// Small Response helpers. Request/Response are web standards available on both hosts.

/** @param {unknown} data @param {number} [status] */
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** @param {string} code  A neutral error code the client translates. @param {number} status */
export const fail = (code, status) => json({ error: code }, status);

/** @param {Request} request */
export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
