// @ts-check
// One room (a campaign): its cards, seats and reveals live in its own SQLite database.
// Cloudflare runs one Room inside each RoomDO; the Node host keeps one Room per database file.
// Hosts forward internal requests (https://room/<action>) to handle().
import { hasSchema, migrate } from './schema.js';
import { newId, newSecret, sha256 } from './ids.js';
import { json, fail, readJson } from './http.js';
import { InputError, parseNewRoom } from './validate.js';

export class Room {
  /** @param {import('./store.js').Store} store */
  constructor(store) {
    this.store = store;
    // Migrate rooms that already exist; a fresh database stays empty until create().
    if (hasSchema(store)) migrate(store);
  }

  /** @param {Request} request */
  async handle(request) {
    const { pathname } = new URL(request.url);
    try {
      if (request.method === 'POST' && pathname === '/create') return await this.create(await readJson(request));
      if (request.method === 'GET' && pathname === '/info') return this.info();
      if (request.method === 'GET' && pathname === '/ping') return this.ping();
      return fail('not_found', 404);
    } catch (error) {
      if (error instanceof InputError) return fail(error.code, 400);
      throw error;
    }
  }

  /** @param {any} body  { code, name, seats } — code comes from the API router, the rest from the DM. */
  async create(body) {
    if (hasSchema(this.store)) return fail('room_exists', 409);
    const { name, seats } = parseNewRoom(body);
    const adminKey = newSecret();
    const adminHash = await sha256(adminKey);
    const now = this.store.now();

    migrate(this.store);
    this.store.tx(() => {
      const meta = { code: body.code, name, created_at: now, last_active_at: now, admin_hash: adminHash, join_locked: 0 };
      for (const [key, value] of Object.entries(meta)) {
        this.store.sql(`INSERT INTO meta (key, value) VALUES (?, ?)`, key, String(value));
      }
      seats.forEach((seat, index) => {
        this.store.sql(`INSERT INTO seats (id, name, sort) VALUES (?, ?, ?)`, newId(), seat, index);
      });
    });
    return json({ code: body.code, adminKey }, 201);
  }

  /** What anyone with the room code may see: the room name and seat names. Nothing else. */
  info() {
    if (!hasSchema(this.store)) return fail('room_not_found', 404);
    const meta = this.meta();
    const seats = this.store
      .sql(`SELECT id, name, token_hash IS NOT NULL AS claimed FROM seats ORDER BY sort`)
      .map((seat) => ({ id: seat.id, name: seat.name, claimed: Boolean(seat.claimed) }));
    return json({ code: meta.code, name: meta.name, joinLocked: meta.join_locked === '1', seats });
  }

  /** Health check. Reads nothing from the room and writes nothing. (Durable Objects block sqlite_version().) */
  ping() {
    const [row] = this.store.sql(`SELECT 1 AS ok`);
    return json({ ok: row.ok === 1 });
  }

  /** @returns {Record<string, string>} */
  meta() {
    return Object.fromEntries(this.store.sql(`SELECT key, value FROM meta`).map((row) => [row.key, row.value]));
  }
}
