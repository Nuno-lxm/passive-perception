// @ts-check
// The public /api/* router, shared by both hosts. It checks what doesn't need a room,
// then forwards /api/rooms/<code>/<path> to that room as https://room/<path>.
import { newRoomCode, normalizeRoomCode } from './ids.js';
import { json, fail, readJson } from './http.js';

/**
 * What each host provides to the router.
 * @typedef {object} Host
 * @property {(code: string, options: { create: boolean }) => RoomStub | null} room
 *   The room for a code. With create: false a host may return null for a room that doesn't exist.
 * @property {(request: Request) => Promise<Record<string, unknown>>} health
 * @property {(request: Request, bucket: 'create' | 'join') => Promise<boolean>} [allow]
 *   Rate limiting; true lets the request through. Hosts without it allow everything.
 *
 * @typedef {{ fetch(request: Request): Promise<Response> }} RoomStub
 */

const CREATE_ATTEMPTS = 5;

/** Room routes anyone with the code can call; they're rate limited against guessing. */
const JOIN_PATHS = new Set(['', '/info', '/claim', '/redeem', '/ws']);

/**
 * @param {Request} request
 * @param {Host} host
 */
export async function handleApi(request, host) {
  const url = new URL(request.url);
  const path = url.pathname;

  // Other sites must not use this API as a free backend. Non-browser clients send no Origin.
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return fail('bad_origin', 403);

  if (path === '/api/health' && request.method === 'GET') return json(await host.health(request));

  if (path === '/api/rooms' && request.method === 'POST') {
    if (host.allow && !(await host.allow(request, 'create'))) return fail('rate_limited', 429);
    const body = await readJson(request);
    if (!body || typeof body !== 'object') return fail('bad_json', 400);
    for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++) {
      const code = newRoomCode();
      const room = host.room(code, { create: true });
      if (!room) return fail('room_unavailable', 500);
      const response = await room.fetch(internal('POST', '/create', { ...body, code }));
      if (response.status !== 409) return response; // 409: that code is taken, try another
    }
    return fail('room_code_exhausted', 503);
  }

  const match = path.match(/^\/api\/rooms\/([^/]+)(\/.*)?$/);
  if (match) {
    const code = normalizeRoomCode(decodeURIComponent(match[1]));
    const rest = match[2] ?? '';
    if (JOIN_PATHS.has(rest) && host.allow && !(await host.allow(request, 'join'))) return fail('rate_limited', 429);
    if (!code) return fail('room_not_found', 404);
    const room = host.room(code, { create: false });
    if (!room) return fail('room_not_found', 404);
    // Forward method, headers (Authorization, WebSocket upgrade) and body under the room's own path.
    // Bodies are small (≤ 1.5 MB images), so reading them whole avoids streaming differences between hosts.
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
    return room.fetch(new Request(`https://room${rest || '/info'}${url.search}`, { method: request.method, headers: request.headers, body }));
  }

  return fail('not_found', 404);
}

/**
 * A request from the router to a room. The host is ignored; rooms only look at method and path.
 * @param {string} method @param {string} path @param {unknown} [body]
 */
export function internal(method, path, body) {
  return new Request(`https://room${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
