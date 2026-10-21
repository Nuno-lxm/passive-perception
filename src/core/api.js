// @ts-check
// The public /api/* router, shared by both hosts. It checks input that doesn't need a room,
// then forwards to the right room as an internal request.
import { newRoomCode, normalizeRoomCode } from './ids.js';
import { json, fail, readJson } from './http.js';

/**
 * What each host provides to the router.
 * @typedef {object} Host
 * @property {(code: string, options: { create: boolean }) => RoomStub | null} room
 *   The room for a code. With create: false a host may return null for a room that doesn't exist.
 * @property {(request: Request) => Promise<Record<string, unknown>>} health
 *
 * @typedef {{ fetch(request: Request): Promise<Response> }} RoomStub
 */

const CREATE_ATTEMPTS = 5;

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

  const match = path.match(/^\/api\/rooms\/([^/]+)$/);
  if (match && request.method === 'GET') {
    const code = normalizeRoomCode(decodeURIComponent(match[1]));
    if (!code) return fail('room_not_found', 404);
    const room = host.room(code, { create: false });
    if (!room) return fail('room_not_found', 404);
    return room.fetch(internal('GET', '/info'));
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
