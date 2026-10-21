// Shared test setup: rooms on in-memory node:sqlite, the same engine family as the Durable Objects.
import { Room } from '../src/core/room.js';
import { openStore } from '../src/node/adapter.js';

/** A Host for the API router that keeps every room in memory. */
export function memoryHost() {
  const rooms = new Map();
  return {
    rooms,
    room(code, { create }) {
      if (!rooms.has(code)) {
        if (!create) return null;
        rooms.set(code, new Room(openStore(':memory:')));
      }
      return { fetch: (request) => rooms.get(code).handle(request) };
    },
    async health() {
      return { ok: true, host: 'test' };
    },
  };
}

export const api = (path, init) => new Request(`http://localhost${path}`, init);

export const postJson = (path, body) =>
  api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
