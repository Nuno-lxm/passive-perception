// @ts-check
// The core's Store interface on top of node:sqlite (built into Node ≥ 22.13).
import { DatabaseSync } from 'node:sqlite';

/**
 * @param {string} path  A file path, or ':memory:' for tests.
 * @returns {import('../core/store.js').Store & { close(): void }}
 */
export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  return {
    sql: (query, ...bindings) => /** @type {any[]} */ (db.prepare(query).all(...bindings)),
    tx(fn) {
      if (db.isTransaction) return fn(); // nested: join the outer transaction, like transactionSync
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    now: () => Date.now(),
    close: () => db.close(),
  };
}
