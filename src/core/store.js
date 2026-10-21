// @ts-check
// The storage interface each host gives the core. Both hosts are real SQLite, so the same SQL runs on both:
//   Cloudflare: ctx.storage.sql.exec(query, ...bindings).toArray() and ctx.storage.transactionSync(fn)
//   Node:       node:sqlite DatabaseSync, prepare(query).all(...bindings) and BEGIN … COMMIT
// One statement per sql() call. Bind only null, numbers, strings and Uint8Array/ArrayBuffer (no booleans).

/**
 * @typedef {Record<string, any>} Row
 * @typedef {object} Store
 * @property {(query: string, ...bindings: any[]) => Row[]} sql
 * @property {<T>(fn: () => T) => T} tx  Runs fn in a transaction; rolls back if it throws.
 * @property {() => number} now          Milliseconds since the epoch.
 */

export {};
