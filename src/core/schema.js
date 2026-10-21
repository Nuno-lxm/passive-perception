// @ts-check
// SQL migrations for one room's database. Each migration is a list of single statements,
// because the two hosts run SQL one statement at a time (see store.js).
// Never edit a migration that has shipped; add a new one.

/** @type {string[][]} */
export const MIGRATIONS = [
  [
    `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`,
    `CREATE TABLE seats (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL,
       token_hash TEXT, link_hash TEXT, claimed_at INTEGER, last_seen_at INTEGER)`,
    // A request to take over a claimed seat. Once approved, the new token waits here (≤ 10 min) for the device to pick it up.
    `CREATE TABLE claims (id TEXT PRIMARY KEY, seat_id TEXT NOT NULL, created_at INTEGER NOT NULL, token TEXT)`,
    `CREATE TABLE cards (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
       grp TEXT, quick INTEGER NOT NULL DEFAULT 0, sort REAL NOT NULL, public_at INTEGER, public_session INTEGER,
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, content_at INTEGER NOT NULL)`,
    `CREATE TABLE images (id TEXT PRIMARY KEY, card_id TEXT NOT NULL, sort INTEGER NOT NULL, mime TEXT NOT NULL,
       w INTEGER NOT NULL, h INTEGER NOT NULL, bytes INTEGER NOT NULL, data BLOB NOT NULL, thumb BLOB,
       created_at INTEGER NOT NULL)`,
    `CREATE TABLE grants (card_id TEXT NOT NULL, seat_id TEXT NOT NULL, revealed_at INTEGER NOT NULL,
       session INTEGER NOT NULL, PRIMARY KEY (card_id, seat_id))`,
    `CREATE TABLE receipts (card_id TEXT NOT NULL, seat_id TEXT NOT NULL,
       delivered_at INTEGER, seen_at INTEGER, ack_at INTEGER, PRIMARY KEY (card_id, seat_id))`,
    `CREATE TABLE sessions (n INTEGER PRIMARY KEY, started_at INTEGER NOT NULL)`,
  ],
];

/** True once the room's tables exist. Read-only, so looking up an unknown room code writes nothing. */
export function hasSchema(/** @type {import('./store.js').Store} */ store) {
  return store.sql(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).length > 0;
}

/** Brings the database up to the latest migration. */
export function migrate(/** @type {import('./store.js').Store} */ store) {
  store.tx(() => {
    let version = 0;
    if (hasSchema(store)) {
      const row = store.sql(`SELECT value FROM meta WHERE key = 'schema_version'`)[0];
      version = row ? Number(row.value) : 0;
    }
    for (let i = version; i < MIGRATIONS.length; i++) {
      for (const statement of MIGRATIONS[i]) store.sql(statement);
    }
    if (version < MIGRATIONS.length) {
      store.sql(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`, String(MIGRATIONS.length));
    }
  });
}
