// @ts-check
// The core's Store interface on top of node:sqlite (built into Node ≥ 22.13).
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';

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
    // On disk: the database file and its write-ahead log. In memory (tests): unknown, so the room counts images.
    size: path === ':memory:' ? undefined
      : () => ['', '-wal'].reduce((total, suffix) => total + (statSync(`${path}${suffix}`, { throwIfNoEntry: false })?.size ?? 0), 0),
    close: () => db.close(),
  };
}
