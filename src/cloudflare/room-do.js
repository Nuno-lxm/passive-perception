// @ts-check
// One Durable Object per room. It only adapts Cloudflare's storage to the core's Store interface;
// all room logic lives in src/core/room.js.
import { DurableObject } from 'cloudflare:workers';
import { Room } from '../core/room.js';

export class RoomDO extends DurableObject {
  /** @param {DurableObjectState} ctx @param {any} env */
  constructor(ctx, env) {
    super(ctx, env);
    const storage = ctx.storage;
    /** @type {import('../core/store.js').Store} */
    const store = {
      sql: (query, ...bindings) => storage.sql.exec(query, ...bindings).toArray(),
      tx: (fn) => storage.transactionSync(fn),
      now: () => Date.now(),
    };
    this.room = new Room(store);
  }

  /** @param {Request} request */
  fetch(request) {
    return this.room.handle(request);
  }
}
