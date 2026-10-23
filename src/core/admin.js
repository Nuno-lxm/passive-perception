// @ts-check
// The one private place for content reports (EU Digital Services Act: anyone must be able to flag illegal content).
// Cloudflare: a single AdminDO. Node: data/admin.sqlite. Only the API router talks to it, and only the operator
// (holding ADMIN_TOKEN) can read it. Closed reports are deleted after 90 days.
import { migrate } from './schema.js';
import { newId } from './ids.js';
import { fail, json, readJson } from './http.js';

const DAY = 24 * 60 * 60 * 1000;
const KEEP_CLOSED = 90 * DAY;
export const REPORT_REASONS = ['bug', 'illegal', 'abuse', 'child', 'other'];

/** @type {string[][]} */
const ADMIN_MIGRATIONS = [
  [
    `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`,
    `CREATE TABLE reports (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, kind TEXT NOT NULL,
       room_code TEXT, card_id TEXT, reason TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', contact TEXT NOT NULL DEFAULT '',
       snapshot TEXT, status TEXT NOT NULL DEFAULT 'open', closed_at INTEGER)`,
  ],
  // 2: usage stats. Counts per day and one row per existing room (for storage and "active"). Nothing personal.
  [
    `CREATE TABLE days (day TEXT PRIMARY KEY, rooms_created INTEGER NOT NULL DEFAULT 0, reveals INTEGER NOT NULL DEFAULT 0,
       joins INTEGER NOT NULL DEFAULT 0, rooms_deleted INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE rooms (code TEXT PRIMARY KEY, created_at INTEGER, last_active_at INTEGER, bytes INTEGER NOT NULL DEFAULT 0)`,
  ],
];
const STORAGE_LIMIT = 5_000_000_000; // the Durable Objects free tier

/** @param {unknown} value @param {number} max */
const text = (value, max) => (typeof value === 'string' ? value.normalize('NFC').trim().slice(0, max) : '');

export class Admin {
  /** @param {import('./store.js').Store} store */
  constructor(store) {
    this.store = store;
    migrate(store, ADMIN_MIGRATIONS);
  }

  /** @param {Request} request  Internal requests from the API router (which checked ADMIN_TOKEN where needed). */
  async handle(request) {
    const { pathname } = new URL(request.url);
    this.store.sql(`DELETE FROM reports WHERE status = 'closed' AND closed_at < ?`, this.store.now() - KEEP_CLOSED);
    let m;
    if (request.method === 'POST' && pathname === '/report') return this.addReport(await readJson(request));
    if (request.method === 'POST' && pathname === '/event') return this.event(await readJson(request));
    if (request.method === 'GET' && pathname === '/stats') return this.stats();
    if (request.method === 'GET' && pathname === '/reports') return this.listReports();
    if (request.method === 'POST' && (m = pathname.match(/^\/reports\/([^/]+)\/(close|reopen)$/))) return this.setStatus(m[1], m[2] === 'close');
    if (request.method === 'DELETE' && (m = pathname.match(/^\/reports\/([^/]+)$/))) {
      this.store.sql(`DELETE FROM reports WHERE id = ?`, m[1]);
      return json({ ok: true });
    }
    return fail('not_found', 404);
  }

  /** @param {any} body  { kind: 'player' | 'public', roomCode, cardId, reason, note, contact, snapshot } */
  addReport(body) {
    const kind = body?.kind === 'player' ? 'player' : 'public';
    const reason = REPORT_REASONS.includes(body?.reason) ? body.reason : 'other';
    const note = text(body?.note, 2000);
    if (kind === 'public' && !note) return fail('report_empty', 400);
    const [{ open }] = this.store.sql(`SELECT count(*) AS open FROM reports WHERE status = 'open'`);
    if (open >= 1000) return fail('rate_limited', 429); // a flood: someone is abusing the form
    const id = newId();
    this.store.sql(
      `INSERT INTO reports (id, created_at, kind, room_code, card_id, reason, note, contact, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, this.store.now(), kind, text(body?.roomCode, 12) || null, text(body?.cardId, 20) || null, reason, note,
      text(body?.contact, 200), body?.snapshot ? JSON.stringify(body.snapshot).slice(0, 20_000) : null,
    );
    return json({ ok: true }, 201);
  }

  /**
   * Something happened in a room. Rooms send these themselves (see RoomHooks.notify); they carry no personal data.
   * @param {any} body  { type: 'created' | 'active' | 'reveal' | 'join' | 'bytes' | 'deleted', code, bytes? }
   */
  event(body) {
    const code = typeof body?.code === 'string' ? body.code.slice(0, 12) : '';
    const now = this.store.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const bump = (/** @type {string} */ column) => {
      this.store.sql(`INSERT OR IGNORE INTO days (day) VALUES (?)`, day);
      this.store.sql(`UPDATE days SET ${column} = ${column} + 1 WHERE day = ?`, day);
    };
    const room = () => this.store.sql(`INSERT OR IGNORE INTO rooms (code, created_at, last_active_at) VALUES (?, ?, ?)`, code, now, now);
    switch (body?.type) {
      case 'created': room(); bump('rooms_created'); break;
      case 'active': room(); this.store.sql(`UPDATE rooms SET last_active_at = ? WHERE code = ?`, now, code); break;
      case 'reveal': bump('reveals'); break;
      case 'join': bump('joins'); break;
      case 'bytes': room(); this.store.sql(`UPDATE rooms SET bytes = ? WHERE code = ?`, Math.max(0, Number(body.bytes) || 0), code); break;
      case 'deleted': this.store.sql(`DELETE FROM rooms WHERE code = ?`, code); bump('rooms_deleted'); break;
      default: return fail('bad_event', 400);
    }
    this.store.sql(`DELETE FROM days WHERE day < ?`, new Date(now - 400 * DAY).toISOString().slice(0, 10));
    return json({ ok: true });
  }

  /** Numbers for the admin page: rooms, storage, the last 30 days, open reports. */
  stats() {
    const now = this.store.now();
    const [rooms] = this.store.sql(
      `SELECT count(*) AS total, sum(last_active_at > ?) AS week, sum(last_active_at > ?) AS month, coalesce(sum(bytes), 0) AS bytes FROM rooms`,
      now - 7 * DAY, now - 30 * DAY,
    );
    const since = new Date(now - 29 * DAY).toISOString().slice(0, 10);
    const rows = new Map(this.store.sql(`SELECT * FROM days WHERE day >= ?`, since).map((d) => [String(d.day), d]));
    const days = Array.from({ length: 30 }, (_, i) => {
      const day = new Date(now - (29 - i) * DAY).toISOString().slice(0, 10);
      const d = rows.get(day);
      return { day, roomsCreated: Number(d?.rooms_created ?? 0), reveals: Number(d?.reveals ?? 0), joins: Number(d?.joins ?? 0) };
    });
    const [{ open }] = this.store.sql(`SELECT count(*) AS open FROM reports WHERE status = 'open'`);
    return json({
      rooms: { total: Number(rooms.total), activeWeek: Number(rooms.week ?? 0), activeMonth: Number(rooms.month ?? 0) },
      storage: { bytes: Number(rooms.bytes), limit: STORAGE_LIMIT },
      days,
      reports: { open: Number(open) },
    });
  }

  listReports() {
    const reports = this.store
      .sql(`SELECT * FROM reports ORDER BY status = 'open' DESC, created_at DESC LIMIT 200`)
      .map((r) => ({
        id: String(r.id), createdAt: Number(r.created_at), kind: String(r.kind), roomCode: r.room_code, cardId: r.card_id,
        reason: String(r.reason), note: String(r.note), contact: String(r.contact),
        snapshot: r.snapshot ? JSON.parse(String(r.snapshot)) : null, status: String(r.status),
        closedAt: r.closed_at == null ? null : Number(r.closed_at),
      }));
    return json({ reports });
  }

  /** @param {string} id @param {boolean} close */
  setStatus(id, close) {
    this.store.sql(`UPDATE reports SET status = ?, closed_at = ? WHERE id = ?`, close ? 'closed' : 'open', close ? this.store.now() : null, id);
    return json({ ok: true });
  }
}
