// @ts-check
// The one private place for content reports (EU Digital Services Act: anyone must be able to flag illegal content).
// Cloudflare: a single AdminDO. Node: data/admin.sqlite. Only the API router talks to it, and only the operator
// (holding ADMIN_TOKEN) can read it. Closed reports are deleted after 90 days.
import { migrate } from './schema.js';
import { newId } from './ids.js';
import { fail, json, readJson } from './http.js';

const DAY = 24 * 60 * 60 * 1000;
const KEEP_CLOSED = 90 * DAY;
export const REPORT_REASONS = ['illegal', 'abuse', 'child', 'other'];

/** @type {string[][]} */
const ADMIN_MIGRATIONS = [
  [
    `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`,
    `CREATE TABLE reports (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, kind TEXT NOT NULL,
       room_code TEXT, card_id TEXT, reason TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', contact TEXT NOT NULL DEFAULT '',
       snapshot TEXT, status TEXT NOT NULL DEFAULT 'open', closed_at INTEGER)`,
  ],
];

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
