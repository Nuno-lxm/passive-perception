// @ts-check
// Cloudflare host. Static files in public/ are served by Cloudflare before this runs (free, unlimited);
// only requests with no matching file reach the Worker, i.e. /api/*.
import { handleApi, internal } from '../core/api.js';
import { fail } from '../core/http.js';

export { RoomDO } from './room-do.js';

/**
 * @typedef {object} Env
 * @property {DurableObjectNamespace} ROOM
 * @property {string} [DO_JURISDICTION]  'eu' keeps room data in the EU. Fixed for good once rooms exist.
 * @property {{ limit(options: { key: string }): Promise<{ success: boolean }> }} [JOIN_LIMIT]
 */

export default {
  /** @param {Request} request @param {Env} env */
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith('/api/')) return fail('not_found', 404);
    try {
      return await handleApi(request, cloudflareHost(env));
    } catch (error) {
      console.error(error);
      // Over a free-tier limit, Durable Object calls throw; the client then shows a calm "busy today" message.
      // The exact error text gets checked against real limit errors in M2.
      if (/exceeded|limit/i.test(String(error))) return fail('over_capacity', 503);
      return fail('server_error', 500);
    }
  },
};

/** @param {Env} env @returns {import('../core/api.js').Host} */
function cloudflareHost(env) {
  const rooms = env.DO_JURISDICTION ? env.ROOM.jurisdiction(/** @type {any} */ (env.DO_JURISDICTION)) : env.ROOM;
  return {
    // A Durable Object exists as soon as it's addressed; Room writes nothing until create().
    room: (code) => rooms.get(rooms.idFromName(code)),
    async health(request) {
      const checks = { ok: true, host: 'cloudflare', jurisdiction: env.DO_JURISDICTION ?? null };
      try {
        const ping = await rooms.get(rooms.idFromName('__health')).fetch(internal('GET', '/ping'));
        Object.assign(checks, { durableObject: await ping.json() });
      } catch (error) {
        Object.assign(checks, { ok: false, durableObject: String(error) });
      }
      if (env.JOIN_LIMIT) {
        const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
        const result = await env.JOIN_LIMIT.limit({ key: `health:${ip}` }).catch((error) => String(error));
        Object.assign(checks, { rateLimit: result });
      } else {
        Object.assign(checks, { rateLimit: 'no binding' });
      }
      return checks;
    },
  };
}
