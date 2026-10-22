// @ts-check
// The single Durable Object that keeps content reports. Logic in src/core/admin.js.
import { DurableObject } from 'cloudflare:workers';
import { Admin } from '../core/admin.js';

export class AdminDO extends DurableObject {
  /** @param {DurableObjectState} ctx @param {any} env */
  constructor(ctx, env) {
    super(ctx, env);
    const storage = ctx.storage;
    this.admin = new Admin({
      sql: (query, ...bindings) => storage.sql.exec(query, ...bindings).toArray(),
      tx: (fn) => storage.transactionSync(fn),
      now: () => Date.now(),
    });
  }

  /** @param {Request} request */
  fetch(request) {
    return this.admin.handle(request);
  }
}
