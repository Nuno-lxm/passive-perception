// @ts-check
// The public /api/* router, shared by both hosts. It checks what doesn't need a room,
// then forwards /api/rooms/<code>/<path> to that room as https://room/<path>.
import { newRoomCode, normalizeRoomCode, sha256 } from './ids.js';
import { json, fail, readJson } from './http.js';

/**
 * What each host provides to the router.
 * @typedef {object} Host
 * @property {(code: string, options: { create: boolean }) => RoomStub | null} room
 *   The room for a code. With create: false a host may return null for a room that doesn't exist.
 * @property {(request: Request) => Promise<Record<string, unknown>>} health
 * @property {(request: Request, bucket: 'create' | 'join' | 'report') => Promise<boolean>} [allow]
 *   Rate limiting; true lets the request through. Hosts without it allow everything.
 * @property {() => RoomStub} [admin]  The reports store. Hosts without it have no reporting.
 * @property {string} [adminToken]      ADMIN_TOKEN: unlocks /api/admin/…. Unset = no admin page.
 *
 * @typedef {{ fetch(request: Request): Promise<Response> }} RoomStub
 */

const CREATE_ATTEMPTS = 5;

/** Set only on requests adminApi() makes to a room; stripped from anything a client sends. */
export const ADMIN_HEADER = 'x-whisperer-admin';

/** Room routes anyone with the code can call; they're rate limited against guessing. */
const JOIN_PATHS = new Set(['', '/info', '/claim', '/cancel-claim', '/redeem', '/ws']);

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

  // A report from anyone (the form on /report).
  if (path === '/api/report' && request.method === 'POST') {
    if (!host.admin) return fail('not_found', 404);
    if (host.allow && !(await host.allow(request, 'report'))) return fail('rate_limited', 429);
    const body = await readJson(request);
    const code = normalizeRoomCode(body?.roomCode ?? '');
    return host.admin().fetch(internal('POST', '/report', {
      kind: 'public', roomCode: code, reason: body?.reason, note: body?.note, contact: body?.contact,
    }));
  }

  if (path.startsWith('/api/admin/')) return adminApi(request, url, host);

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
    if (rest.startsWith('/admin')) return fail('not_found', 404); // operator-only; see adminApi
    const room = host.room(code, { create: false });
    if (!room) return fail('room_not_found', 404);

    // A player's report: the room checks it and builds the snapshot; the admin store keeps it.
    if (rest === '/report' && request.method === 'POST') {
      if (!host.admin) return fail('not_found', 404);
      if (host.allow && !(await host.allow(request, 'report'))) return fail('rate_limited', 429);
      const headers = new Headers(request.headers);
      headers.delete(ADMIN_HEADER);
      const checked = await room.fetch(new Request('https://room/report', { method: 'POST', headers, body: await request.arrayBuffer() }));
      if (!checked.ok) return checked;
      const { report } = await checked.json();
      return host.admin().fetch(internal('POST', '/report', report));
    }
    // Forward method, headers (Authorization, WebSocket upgrade) and body under the room's own path.
    // Bodies are small (≤ 1.5 MB images), so reading them whole avoids streaming differences between hosts.
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
    const headers = new Headers(request.headers);
    headers.delete(ADMIN_HEADER);
    return room.fetch(new Request(`https://room${rest || '/info'}${url.search}`, { method: request.method, headers, body }));
  }

  return fail('not_found', 404);
}

/**
 * The operator's API: reports, and freezing / deleting / inspecting a reported room. Needs ADMIN_TOKEN.
 * @param {Request} request @param {URL} url @param {Host} host
 */
async function adminApi(request, url, host) {
  if (!host.admin || !host.adminToken) return fail('not_found', 404);
  const given = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
  if (!given) return fail('unauthorized', 401);
  // Compare hashes, so the time taken says nothing about how much of a guess was right.
  const ok = (await sha256(given)) === (await sha256(host.adminToken));
  // The admin store counts wrong tokens and, after too many, refuses even the right one for a while.
  const gate = await host.admin().fetch(new Request('https://admin/login', { method: 'POST', body: JSON.stringify({ ok }) }));
  if (!gate.ok) return gate;
  const path = url.pathname.slice('/api/admin'.length);
  const method = request.method;
  if (path === '/stats' && method === 'GET') return host.admin().fetch(new Request('https://admin/stats'));
  if (path === '/reports' || path.startsWith('/reports/')) {
    return host.admin().fetch(new Request(`https://admin${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : await request.arrayBuffer() }));
  }
  const m = path.match(/^\/rooms\/([^/]+)(\/.*)$/);
  const code = m && normalizeRoomCode(m[1]);
  if (!code) return fail('not_found', 404);
  const room = host.room(code, { create: false });
  if (!room) return fail('room_not_found', 404);
  const routes = { 'GET /info': '/admin/info', 'POST /freeze': '/admin/freeze', 'POST /delete': '/admin/delete' };
  const target = /** @type {Record<string, string>} */ (routes)[`${method} ${m[2]}`]
    ?? (method === 'GET' && /^\/images\/[^/]+$/.test(m[2]) ? `/admin${m[2]}` : null);
  if (!target) return fail('not_found', 404);
  return room.fetch(new Request(`https://room${target}${url.search}`, {
    method, headers: { 'content-type': 'application/json', [ADMIN_HEADER]: '1' }, body: method === 'GET' ? undefined : await request.arrayBuffer(),
  }));
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
