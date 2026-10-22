// @ts-check
// One room (a campaign): its cards, seats and reveals live in its own SQLite database.
// Cloudflare runs one Room inside each RoomDO; the Node host keeps one Room per database file.
// The API router forwards /api/rooms/<code>/<path> here as https://room/<path>.
//
// Security model (see PLAN.md §5): a player's connection only ever receives cards from feed.js,
// which returns what was revealed to that seat. Messages about a card go only to seats that can see it,
// or that could see it just before (a `remove`).
import { hasSchema, migrate } from './schema.js';
import { newId, newSecret, sha256 } from './ids.js';
import { json, fail, readJson } from './http.js';
import { InputError, LIMITS, idList, parseCardFields, parseNewRoom, parseSeatName } from './validate.js';
import { canSee, feedFor, playerItem, seatsSeeing } from './feed.js';
import { dmCards } from './dmview.js';
import { IMAGE_LIMITS, checkImage } from './images.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SESSION_GAP = 6 * HOUR; // the first reveal after this long starts a new session
const CLAIM_TTL = 10 * 60 * 1000;
const MAX_PENDING_CLAIMS = 20;
const PONG_STALE = 45 * 1000;
const MAX_MESSAGE = 4096;

/** @typedef {import('./sockets.js').Conn} Conn */
/**
 * What else the host does for a room.
 * @typedef {object} RoomHooks
 * @property {number} [expiryDays]  Delete the room after this many days without use (0 = never). Default 60.
 * @property {(at: number) => void} [setAlarm]  Call onAlarm() at this time. Cloudflare: a DO alarm. Node sweeps instead.
 * @property {() => void | Promise<void>} [destroy]  Remove the room's storage entirely. Default: drop its tables.
 */
/** @typedef {{ role: 'dm' } | { role: 'player', seat: { id: string, name: string } }} Auth */

/** @param {Uint8Array} bytes */
function parseJson(bytes) {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export class Room {
  /**
   * @param {import('./store.js').Store} store
   * @param {import('./sockets.js').Sockets} [sockets]
   * @param {RoomHooks} [hooks]
   */
  constructor(store, sockets = { all: () => [] }, hooks = {}) {
    this.store = store;
    this.sockets = sockets;
    this.hooks = hooks;
    this.expiryDays = hooks.expiryDays ?? 60;
    // Migrate rooms that already exist; a fresh database stays empty until create().
    if (hasSchema(store)) migrate(store);
  }

  // ---------- HTTP

  /** @param {Request} request */
  async handle(request) {
    const { pathname, searchParams } = new URL(request.url);
    const method = request.method;
    try {
      if (method === 'POST' && pathname === '/create') return await this.create(await readJson(request));
      if (method === 'GET' && pathname === '/ping') return this.ping();
      if (!hasSchema(this.store)) return fail('room_not_found', 404);

      // Anyone with the room code.
      if (method === 'GET' && pathname === '/info') return this.info();
      if (method === 'POST' && pathname === '/claim') return await this.claim(await readJson(request));
      if (method === 'POST' && pathname === '/redeem') return await this.redeem(await readJson(request));
      if (method === 'POST' && pathname === '/cancel-claim') return this.cancelClaim(await readJson(request));

      const auth = await this.authenticate(request);
      if (!auth) return fail('unauthorized', 401);

      // A player or the DM.
      let m = pathname.match(/^\/images\/([^/]+)$/);
      if (method === 'GET' && m) return this.image(auth, m[1], searchParams.get('thumb') === '1');
      if (method === 'POST' && pathname === '/leave') {
        if (auth.role !== 'player') return fail('forbidden', 403);
        return this.releaseSeat(auth.seat.id, 'left');
      }

      if (auth.role !== 'dm') return fail('forbidden', 403);
      // Read the body once: JSON for most routes, raw bytes for image uploads.
      const raw = method === 'GET' || method === 'DELETE' ? null : new Uint8Array(await request.arrayBuffer());
      const body = raw ? parseJson(raw) : null;

      if (method === 'PATCH' && pathname === '/room') return this.patchRoom(body);
      if (method === 'DELETE' && pathname === '/room') return await this.deleteRoom('deleted');
      if (method === 'POST' && pathname === '/rotate-key') return await this.rotateKey();
      if (method === 'POST' && pathname === '/seats') return this.addSeat(body);
      if ((m = pathname.match(/^\/seats\/([^/]+)$/))) {
        if (method === 'PATCH') return this.renameSeat(m[1], body);
        if (method === 'DELETE') return this.deleteSeat(m[1]);
      }
      if (method === 'POST' && (m = pathname.match(/^\/seats\/([^/]+)\/release$/))) return this.releaseSeat(m[1], 'released');
      if (method === 'POST' && (m = pathname.match(/^\/seats\/([^/]+)\/link$/))) return await this.newLink(m[1]);
      if (method === 'POST' && (m = pathname.match(/^\/claims\/([^/]+)\/(approve|deny)$/))) {
        return await this.decideClaim(m[1], m[2] === 'approve');
      }
      if (method === 'POST' && pathname === '/cards') return this.addCard(body);
      if (method === 'POST' && pathname === '/cards/bulk') return this.importCards(body);
      if (method === 'POST' && (m = pathname.match(/^\/cards\/([^/]+)\/duplicate$/))) return this.duplicateCard(m[1]);
      if ((m = pathname.match(/^\/cards\/([^/]+)$/))) {
        if (method === 'PATCH') return this.editCard(m[1], body);
        if (method === 'DELETE') return this.deleteCard(m[1]);
      }
      if (method === 'POST' && (m = pathname.match(/^\/cards\/([^/]+)\/reveal$/))) return this.reveal(m[1], body);
      if (method === 'POST' && (m = pathname.match(/^\/cards\/([^/]+)\/unreveal$/))) return this.unreveal(m[1], body);
      if (method === 'POST' && (m = pathname.match(/^\/cards\/([^/]+)\/images$/))) {
        return this.addImage(m[1], /** @type {Uint8Array} */ (raw));
      }
      if (method === 'PUT' && (m = pathname.match(/^\/images\/([^/]+)\/thumb$/))) {
        return this.setThumb(m[1], /** @type {Uint8Array} */ (raw));
      }
      if (method === 'DELETE' && (m = pathname.match(/^\/images\/([^/]+)$/))) return this.deleteImage(m[1]);
      return fail('not_found', 404);
    } catch (error) {
      if (error instanceof InputError) return fail(error.code, 400);
      throw error;
    }
  }

  /** @param {Request} request @returns {Promise<Auth | null>} */
  async authenticate(request) {
    const header = request.headers.get('authorization') ?? '';
    if (!header.startsWith('Bearer ')) return null;
    const secret = header.slice(7).trim();
    if (await this.isDmKey(secret)) return { role: 'dm' };
    const seat = await this.seatFromToken(secret);
    return seat ? { role: 'player', seat } : null;
  }

  /** @param {unknown} key */
  async isDmKey(key) {
    if (typeof key !== 'string' || key.length < 16 || key.length > 64) return false;
    return (await sha256(key)) === this.meta().admin_hash;
  }

  /** @param {unknown} token @returns {Promise<{ id: string, name: string } | null>} */
  async seatFromToken(token) {
    if (typeof token !== 'string' || token.length < 16 || token.length > 64) return null;
    const [seat] = this.store.sql(`SELECT id, name FROM seats WHERE token_hash = ?`, await sha256(token));
    return seat ? { id: String(seat.id), name: String(seat.name) } : null;
  }

  // ---------- Room

  /** @param {any} body  { code, name, seats }: code comes from the API router, the rest from the DM. */
  async create(body) {
    if (hasSchema(this.store)) return fail('room_exists', 409);
    const { name, seats } = parseNewRoom(body);
    const adminKey = newSecret();
    const adminHash = await sha256(adminKey);
    const now = this.store.now();

    migrate(this.store);
    this.store.tx(() => {
      const meta = { code: body.code, name, created_at: now, last_active_at: now, admin_hash: adminHash, join_locked: 0 };
      for (const [key, value] of Object.entries(meta)) this.setMeta(key, value);
      seats.forEach((seat, index) => {
        this.store.sql(`INSERT INTO seats (id, name, sort) VALUES (?, ?, ?)`, newId(), seat, index);
      });
    });
    this.scheduleExpiry(now);
    return json({ code: body.code, adminKey }, 201);
  }

  /** What anyone with the room code may see: the room name and seat names. Nothing else. */
  info() {
    const meta = this.meta();
    const seats = this.store
      .sql(`SELECT id, name, token_hash IS NOT NULL AS claimed FROM seats ORDER BY sort`)
      .map((seat) => ({ id: String(seat.id), name: String(seat.name), claimed: Boolean(seat.claimed) }));
    return json({ code: meta.code, name: meta.name, joinLocked: meta.join_locked === '1', seats });
  }

  /** Health check. Reads nothing from the room and writes nothing. (Durable Objects block sqlite_version().) */
  ping() {
    const [row] = this.store.sql(`SELECT 1 AS ok`);
    return json({ ok: row.ok === 1 });
  }

  /** @param {any} body  { name?, joinLocked? } */
  patchRoom(body) {
    if (body && 'name' in body) {
      const { name } = parseNewRoom({ name: body.name, seats: ['x'] });
      this.setMeta('name', name);
      this.toPlayers(() => ({ t: 'room', room: this.playerRoom() }));
    }
    if (body && 'joinLocked' in body) this.setMeta('join_locked', body.joinLocked ? 1 : 0);
    this.toDms({ t: 'room', room: this.dmRoom() });
    return json({ room: this.dmRoom() });
  }

  /** A new DM key. Every DM device is signed out and must open the new link. */
  async rotateKey() {
    const adminKey = newSecret();
    this.setMeta('admin_hash', await sha256(adminKey));
    for (const conn of this.conns('dm')) this.signOutConn(conn, 'key_rotated');
    return json({ adminKey });
  }

  // ---------- Seats

  /** @param {any} body  { seatId } */
  async claim(body) {
    const seat = this.seat(body?.seatId);
    if (!seat) return fail('seat_not_found', 404);
    const now = this.store.now();
    this.store.sql(`DELETE FROM claims WHERE created_at < ?`, now - CLAIM_TTL);

    if (seat.token_hash == null && this.meta().join_locked !== '1') {
      const token = newSecret();
      this.store.sql(`UPDATE seats SET token_hash = ?, claimed_at = ? WHERE id = ?`, await sha256(token), now, seat.id);
      this.toDms({ t: 'seats', seats: this.dmSeats() });
      return json({ token, seat: { id: seat.id, name: seat.name } });
    }

    // One open request per seat: a newer one replaces it, so the DM never sees a pile of banners for one seat.
    // The device that made the older request is told, and can ask again.
    const older = this.store.sql(`SELECT id FROM claims WHERE seat_id = ? AND token IS NULL`, seat.id).map((c) => String(c.id));
    for (const conn of this.conns('pending')) {
      if (older.includes(/** @type {any} */ (conn.meta()).claimId)) this.signOutConn(conn, 'replaced');
    }
    this.store.sql(`DELETE FROM claims WHERE seat_id = ? AND token IS NULL`, seat.id);

    const [{ n }] = this.store.sql(`SELECT count(*) AS n FROM claims`);
    if (n >= MAX_PENDING_CLAIMS) return fail('too_many_claims', 429);
    const claimId = newSecret();
    this.store.sql(`INSERT INTO claims (id, seat_id, created_at) VALUES (?, ?, ?)`, claimId, seat.id, now);
    this.toDms({ t: 'claims', claims: this.claims() });
    return json({ pending: claimId, seat: { id: seat.id, name: seat.name } }, 202);
  }

  /** The waiting device withdraws its own request (the claim id is its proof). @param {any} body  { claim } */
  cancelClaim(body) {
    if (typeof body?.claim !== 'string') return fail('claim_not_found', 404);
    this.store.sql(`DELETE FROM claims WHERE id = ? AND token IS NULL`, body.claim);
    this.toDms({ t: 'claims', claims: this.claims() });
    return json({ ok: true });
  }

  /** A personal link: takes the seat without the DM's approval. @param {any} body  { secret } */
  async redeem(body) {
    const secret = body?.secret;
    if (typeof secret !== 'string' || secret.length < 16 || secret.length > 64) return fail('bad_link', 400);
    const [seat] = this.store.sql(`SELECT id, name FROM seats WHERE link_hash = ?`, await sha256(secret));
    if (!seat) return fail('bad_link', 404);
    const token = await this.giveSeat(String(seat.id), 'moved');
    return json({ token, seat: { id: seat.id, name: seat.name } });
  }

  /**
   * @param {string} claimId @param {boolean} approve
   */
  async decideClaim(claimId, approve) {
    const [claim] = this.store.sql(`SELECT id, seat_id FROM claims WHERE id = ?`, claimId);
    if (!claim) return fail('claim_not_found', 404);
    const waiting = this.conns('pending').filter((conn) => /** @type {any} */ (conn.meta()).claimId === claimId);

    if (!approve) {
      this.store.sql(`DELETE FROM claims WHERE id = ?`, claimId);
      for (const conn of waiting) this.signOutConn(conn, 'denied');
    } else {
      const seat = /** @type {any} */ (this.seat(claim.seat_id));
      const token = await this.giveSeat(seat.id, 'moved');
      if (waiting.length) {
        this.store.sql(`DELETE FROM claims WHERE id = ?`, claimId);
        for (const conn of waiting) this.send(conn, { t: 'approved', token, seat: { id: seat.id, name: seat.name } });
      } else {
        // The device isn't connected right now; it picks the token up on its next hello (within CLAIM_TTL).
        this.store.sql(`UPDATE claims SET token = ? WHERE id = ?`, token, claimId);
      }
    }
    this.toDms({ t: 'claims', claims: this.claims() });
    return json({ ok: true });
  }

  /**
   * Gives a seat a new token. Devices holding the old one are signed out.
   * @param {string} seatId @param {string} reason
   */
  async giveSeat(seatId, reason) {
    const token = newSecret();
    this.store.sql(`UPDATE seats SET token_hash = ?, claimed_at = ? WHERE id = ?`, await sha256(token), this.store.now(), seatId);
    for (const conn of this.seatConns(seatId)) this.signOutConn(conn, reason);
    this.toDms({ t: 'seats', seats: this.dmSeats() });
    return token;
  }

  /** @param {string} seatId @param {string} reason  'released' (by the DM) or 'left' (by the player) */
  releaseSeat(seatId, reason) {
    if (!this.seat(seatId)) return fail('seat_not_found', 404);
    this.store.sql(`UPDATE seats SET token_hash = NULL, claimed_at = NULL WHERE id = ?`, seatId);
    for (const conn of this.seatConns(seatId)) this.signOutConn(conn, reason);
    this.toDms({ t: 'seats', seats: this.dmSeats() });
    return json({ ok: true });
  }

  /** @param {string} seatId */
  async newLink(seatId) {
    if (!this.seat(seatId)) return fail('seat_not_found', 404);
    const secret = newSecret();
    this.store.sql(`UPDATE seats SET link_hash = ? WHERE id = ?`, await sha256(secret), seatId);
    this.toDms({ t: 'seats', seats: this.dmSeats() });
    return json({ secret });
  }

  /** @param {any} body  { name } */
  addSeat(body) {
    const name = parseSeatName(body?.name);
    const seats = this.store.sql(`SELECT name, sort FROM seats`);
    if (seats.length >= LIMITS.seats) throw new InputError('too_many_seats');
    this.assertUniqueSeatName(name);
    const sort = Math.max(-1, ...seats.map((s) => Number(s.sort))) + 1;
    const id = newId();
    this.store.sql(`INSERT INTO seats (id, name, sort) VALUES (?, ?, ?)`, id, name, sort);
    this.toDms({ t: 'seats', seats: this.dmSeats() });
    return json({ seat: { id, name } }, 201);
  }

  /** @param {string} seatId @param {any} body  { name } */
  renameSeat(seatId, body) {
    if (!this.seat(seatId)) return fail('seat_not_found', 404);
    const name = parseSeatName(body?.name);
    this.assertUniqueSeatName(name, seatId);
    this.store.sql(`UPDATE seats SET name = ? WHERE id = ?`, name, seatId);
    for (const conn of this.seatConns(seatId)) this.send(conn, { t: 'seat', seat: { id: seatId, name } });
    this.toDms({ t: 'seats', seats: this.dmSeats() });
    return json({ ok: true });
  }

  /** @param {string} seatId */
  deleteSeat(seatId) {
    if (!this.seat(seatId)) return fail('seat_not_found', 404);
    for (const conn of this.seatConns(seatId)) this.signOutConn(conn, 'removed');
    this.store.tx(() => {
      for (const table of ['grants', 'receipts', 'claims']) this.store.sql(`DELETE FROM ${table} WHERE seat_id = ?`, seatId);
      this.store.sql(`DELETE FROM seats WHERE id = ?`, seatId);
    });
    this.toDms({ t: 'seats', seats: this.dmSeats() });
    this.toDms({ t: 'cards', cards: dmCards(this.store) });
    return json({ ok: true });
  }

  /** @param {string} name @param {string} [exceptId] */
  assertUniqueSeatName(name, exceptId) {
    const taken = this.store
      .sql(`SELECT id, name FROM seats`)
      .some((seat) => seat.id !== exceptId && String(seat.name).toLocaleLowerCase() === name.toLocaleLowerCase());
    if (taken) throw new InputError('duplicate_seat_names');
  }

  // ---------- Cards

  /** @param {any} body  { title, body, grp, note, forSeats, quick } */
  addCard(body) {
    const fields = parseCardFields(body);
    this.assertRoomForCards(1);
    const id = this.insertCard(fields, { quick: Boolean(body?.quick) });
    return this.cardChanged(id, 201);
  }

  /**
   * Many cards at once (the "Import cards" box). All or nothing: one bad card rejects the whole import.
   * @param {any} body  { cards: [{ title, body, grp, note, forSeats }] }
   */
  importCards(body) {
    const list = Array.isArray(body?.cards) ? body.cards : [];
    if (!list.length) throw new InputError('nothing_to_import');
    if (list.length > LIMITS.importCards) throw new InputError('too_many_to_import');
    const parsed = list.map((card) => parseCardFields(card));
    this.assertRoomForCards(parsed.length);
    const ids = this.store.tx(() => parsed.map((fields) => this.insertCard(fields)));
    this.toDms({ t: 'cards', cards: dmCards(this.store) });
    return json({ imported: ids.length, ids }, 201);
  }

  /** A copy right after the original: text, group, note, players and images, but nothing revealed. @param {string} cardId */
  duplicateCard(cardId) {
    const [card] = this.store.sql(`SELECT title, body, grp, note, for_seats, sort FROM cards WHERE id = ?`, cardId);
    if (!card) return fail('card_not_found', 404);
    this.assertRoomForCards(1);
    const images = this.store.sql(`SELECT mime, w, h, bytes, data, thumb, sort FROM images WHERE card_id = ? ORDER BY sort`, cardId);
    const [{ total }] = this.store.sql(`SELECT coalesce(sum(bytes), 0) AS total FROM images`);
    const extra = images.reduce((sum, image) => sum + Number(image.bytes), 0);
    if (total + extra > IMAGE_LIMITS.roomBytes) return fail('room_storage_full', 400);
    const [next] = this.store.sql(`SELECT min(sort) AS s FROM cards WHERE sort > ?`, card.sort);
    const sort = next?.s == null ? Number(card.sort) + 1 : (Number(card.sort) + Number(next.s)) / 2;
    const now = this.store.now();
    const id = this.store.tx(() => {
      const copy = this.insertCard({
        title: String(card.title), body: String(card.body), grp: card.grp == null ? null : String(card.grp),
        note: String(card.note), forSeats: JSON.parse(String(card.for_seats)), sort,
      });
      for (const image of images) {
        this.store.sql(
          `INSERT INTO images (id, card_id, sort, mime, w, h, bytes, data, thumb, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          newId(), copy, image.sort, image.mime, image.w, image.h, image.bytes, image.data, image.thumb ?? null, now,
        );
      }
      return copy;
    });
    return this.cardChanged(id, 201);
  }

  /** @param {number} adding */
  assertRoomForCards(adding) {
    const [{ n }] = this.store.sql(`SELECT count(*) AS n FROM cards`);
    if (n + adding > LIMITS.cards) throw new InputError('too_many_cards');
  }

  /**
   * Inserts one card (fields already parsed). New cards go to the end unless a sort is given.
   * @param {ReturnType<typeof parseCardFields>} fields @param {{ quick?: boolean }} [options]
   */
  insertCard(fields, { quick = false } = {}) {
    const id = newId();
    const now = this.store.now();
    const [{ top }] = this.store.sql(`SELECT max(sort) AS top FROM cards`);
    this.store.sql(
      `INSERT INTO cards (id, title, body, grp, quick, sort, note, for_seats, created_at, updated_at, content_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, fields.title ?? '', fields.body ?? '', fields.grp ?? null, quick ? 1 : 0, fields.sort ?? (top ?? 0) + 1,
      fields.note ?? '', JSON.stringify(this.existingSeats(fields.forSeats ?? [])), now, now, now,
    );
    return id;
  }

  /** @param {string} cardId @param {any} body  any of { title, body, grp, note, forSeats, sort } */
  editCard(cardId, body) {
    const [card] = this.store.sql(`SELECT title, body, grp, note, for_seats, sort FROM cards WHERE id = ?`, cardId);
    if (!card) return fail('card_not_found', 404);
    const changes = parseCardFields(body);
    const fields = {
      title: card.title, body: card.body, grp: card.grp, note: card.note, sort: card.sort,
      forSeats: JSON.parse(String(card.for_seats)), ...changes,
    };
    // Only what players see counts as an edit for them; group, note, players and order are the DM's business.
    const contentChanged = fields.title !== card.title || fields.body !== card.body;
    const now = this.store.now();
    this.store.sql(
      `UPDATE cards SET title = ?, body = ?, grp = ?, note = ?, for_seats = ?, sort = ?, updated_at = ?,
         content_at = CASE WHEN ? THEN ? ELSE content_at END
       WHERE id = ?`,
      fields.title, fields.body, fields.grp, fields.note, JSON.stringify(this.existingSeats(fields.forSeats)), fields.sort, now,
      contentChanged ? 1 : 0, now, cardId,
    );
    if (contentChanged) this.pushToPlayers(cardId, seatsSeeing(this.store, cardId));
    return this.cardChanged(cardId);
  }

  /** @param {string} cardId */
  deleteCard(cardId) {
    const before = seatsSeeing(this.store, cardId);
    if (!this.cardExists(cardId)) return fail('card_not_found', 404);
    this.store.tx(() => {
      for (const table of ['images', 'grants', 'receipts']) this.store.sql(`DELETE FROM ${table} WHERE card_id = ?`, cardId);
      this.store.sql(`DELETE FROM cards WHERE id = ?`, cardId);
    });
    this.pushToPlayers(cardId, before);
    this.toDms({ t: 'cardRemoved', id: cardId });
    return json({ ok: true });
  }

  /**
   * Reveals a card to some seats and/or the whole table.
   * @param {string} cardId @param {any} body  { seats: string[], everyone?: boolean }
   */
  reveal(cardId, body) {
    if (!this.cardExists(cardId)) return fail('card_not_found', 404);
    const seatIds = this.existingSeats(idList(body?.seats));
    const everyone = body?.everyone === true;
    if (!seatIds.length && !everyone) throw new InputError('no_recipients');

    const before = seatsSeeing(this.store, cardId);
    const now = this.store.now();
    this.store.tx(() => {
      const session = this.sessionForReveal(now);
      if (everyone) {
        this.store.sql(`UPDATE cards SET public_at = ?, public_session = ? WHERE id = ? AND public_at IS NULL`, now, session, cardId);
      }
      for (const seatId of seatIds) {
        this.store.sql(
          `INSERT OR IGNORE INTO grants (card_id, seat_id, revealed_at, session) VALUES (?, ?, ?, ?)`,
          cardId, seatId, now, session,
        );
      }
      this.setMeta('last_reveal_at', now);
    });
    this.touch();
    this.pushToPlayers(cardId, before);
    return this.cardChanged(cardId);
  }

  /**
   * Takes a card back. Removes it from those players' feeds; it can't make anyone un-see it.
   * @param {string} cardId @param {any} body  { seats: string[], everyone?: boolean }
   */
  unreveal(cardId, body) {
    if (!this.cardExists(cardId)) return fail('card_not_found', 404);
    const seatIds = idList(body?.seats);
    const before = seatsSeeing(this.store, cardId);
    this.store.tx(() => {
      if (body?.everyone === true) {
        this.store.sql(`UPDATE cards SET public_at = NULL, public_session = NULL WHERE id = ?`, cardId);
      }
      for (const seatId of seatIds) this.store.sql(`DELETE FROM grants WHERE card_id = ? AND seat_id = ?`, cardId, seatId);
      const after = seatsSeeing(this.store, cardId);
      for (const seatId of before) {
        if (!after.has(seatId)) this.store.sql(`DELETE FROM receipts WHERE card_id = ? AND seat_id = ?`, cardId, seatId);
      }
    });
    this.pushToPlayers(cardId, before);
    return this.cardChanged(cardId);
  }

  /** Tells the DMs about a card and returns it. @param {string} cardId @param {number} [status] */
  cardChanged(cardId, status = 200) {
    const [card] = dmCards(this.store, cardId);
    this.toDms({ t: 'card', card });
    return json({ card }, status);
  }

  // ---------- Images

  /** @param {string} cardId @param {Uint8Array} bytes */
  addImage(cardId, bytes) {
    if (!this.cardExists(cardId)) return fail('card_not_found', 404);
    const checked = checkImage(bytes, IMAGE_LIMITS.bytes);
    if (!checked.image) return fail(/** @type {string} */ (checked.error), 400);
    const now = this.store.now();
    const [{ onCard }] = this.store.sql(`SELECT count(*) AS onCard FROM images WHERE card_id = ?`, cardId);
    if (onCard >= IMAGE_LIMITS.perCard) return fail('too_many_images', 400);
    const [{ recent, total }] = this.store.sql(
      `SELECT sum(created_at > ?) AS recent, coalesce(sum(bytes), 0) AS total FROM images`, now - HOUR,
    );
    if ((recent ?? 0) >= IMAGE_LIMITS.uploadsPerHour) return fail('too_many_uploads', 429);
    if (total + bytes.length > IMAGE_LIMITS.roomBytes) return fail('room_storage_full', 400);

    const id = newId();
    const { mime, w, h } = checked.image;
    this.store.sql(
      `INSERT INTO images (id, card_id, sort, mime, w, h, bytes, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, cardId, onCard, mime, w, h, bytes.length, bytes, now,
    );
    this.imagesChanged(cardId, now);
    return json({ image: { id, w, h, bytes: bytes.length } }, 201);
  }

  /** @param {string} imageId @param {Uint8Array} bytes */
  setThumb(imageId, bytes) {
    if (!this.store.sql(`SELECT 1 FROM images WHERE id = ?`, imageId).length) return fail('image_not_found', 404);
    const checked = checkImage(bytes, IMAGE_LIMITS.thumbBytes);
    if (!checked.image) return fail(/** @type {string} */ (checked.error), 400);
    this.store.sql(`UPDATE images SET thumb = ? WHERE id = ?`, bytes, imageId);
    return json({ ok: true });
  }

  /** @param {string} imageId */
  deleteImage(imageId) {
    const [image] = this.store.sql(`SELECT card_id FROM images WHERE id = ?`, imageId);
    if (!image) return fail('image_not_found', 404);
    this.store.sql(`DELETE FROM images WHERE id = ?`, imageId);
    this.imagesChanged(String(image.card_id), this.store.now());
    return json({ ok: true });
  }

  /** @param {string} cardId @param {number} now */
  imagesChanged(cardId, now) {
    this.store.sql(`UPDATE cards SET content_at = ?, updated_at = ? WHERE id = ?`, now, now, cardId);
    this.pushToPlayers(cardId, seatsSeeing(this.store, cardId));
    this.cardChanged(cardId);
  }

  /**
   * Serves an image to the DM, or to a player whose seat can see its card.
   * @param {Auth} auth @param {string} imageId @param {boolean} thumb
   */
  image(auth, imageId, thumb) {
    const [image] = this.store.sql(`SELECT card_id, mime, data, thumb FROM images WHERE id = ?`, imageId);
    // Same answer for "doesn't exist" and "not yours", so players can't probe for ids.
    if (!image || (auth.role === 'player' && !canSee(this.store, String(image.card_id), auth.seat.id))) {
      return fail('image_not_found', 404);
    }
    const bytes = thumb && image.thumb ? image.thumb : image.data;
    const sniffed = thumb && image.thumb ? checkImage(new Uint8Array(bytes), IMAGE_LIMITS.thumbBytes).image : null;
    return new Response(bytes, {
      headers: {
        'content-type': sniffed?.mime ?? String(image.mime),
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      },
    });
  }

  // ---------- WebSockets

  /**
   * @param {Conn} conn @param {string | ArrayBuffer} data
   */
  async onSocketMessage(conn, data) {
    if (data === 'ping') {
      // Cloudflare answers pings itself without waking the room; this is the Node host.
      conn.send('pong');
      conn.notePong?.();
      return;
    }
    if (typeof data !== 'string' || data.length > MAX_MESSAGE) return;
    /** @type {any} */
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (!hasSchema(this.store)) return this.signOutConn(conn, 'roomDeleted');

    const meta = conn.meta();
    if (!meta) {
      if (message.t === 'hello') await this.hello(conn, message);
      return;
    }
    if (meta.role === 'player') {
      if (message.t === 'got' || message.t === 'seen') this.receipts(meta.seatId, idList(message.ids), message.t);
      else if (message.t === 'ack' && typeof message.id === 'string') this.receipts(meta.seatId, [message.id], 'ack');
      else if (message.t === 'state') {
        conn.setMeta({ ...meta, visible: message.visible !== false });
        this.toDms({ t: 'presence', seats: this.presence() });
      }
    } else if (meta.role === 'dm' && message.t === 'presence') {
      this.send(conn, { t: 'presence', seats: this.presence() });
    }
  }

  /** @param {Conn} conn */
  onSocketClose(conn) {
    if (conn.meta()?.role === 'player') this.toDms({ t: 'presence', seats: this.presence() });
  }

  /**
   * The first message on every connection.
   * @param {Conn} conn @param {any} message  { t: 'hello', role: 'player' | 'dm' | 'pending', token | key | claim }
   */
  async hello(conn, message) {
    const now = this.store.now();
    if (message.role === 'player') {
      const seat = await this.seatFromToken(message.token);
      if (!seat) return this.signOutConn(conn, 'bad_token');
      conn.setMeta({ role: 'player', seatId: seat.id, visible: message.visible !== false });
      this.store.sql(`UPDATE seats SET last_seen_at = ? WHERE id = ?`, now, seat.id);
      this.touch();
      this.send(conn, {
        t: 'welcome', role: 'player', room: this.playerRoom(), seat,
        feed: feedFor(this.store, seat.id), sessions: this.sessions(), serverTime: now,
      });
      this.toDms({ t: 'presence', seats: this.presence() });
    } else if (message.role === 'dm') {
      if (!(await this.isDmKey(message.key))) return this.signOutConn(conn, 'bad_key');
      conn.setMeta({ role: 'dm' });
      this.touch();
      this.send(conn, {
        t: 'welcome', role: 'dm', room: this.dmRoom(), seats: this.dmSeats(), cards: dmCards(this.store),
        claims: this.claims(), sessions: this.sessions(), serverTime: now,
      });
    } else if (message.role === 'pending' && typeof message.claim === 'string') {
      const [claim] = this.store.sql(
        `SELECT c.id, c.token, s.id AS seat_id, s.name FROM claims c JOIN seats s ON s.id = c.seat_id
         WHERE c.id = ? AND c.created_at > ?`, message.claim, now - CLAIM_TTL,
      );
      if (!claim) return this.signOutConn(conn, 'claim_expired');
      if (claim.token) {
        this.store.sql(`DELETE FROM claims WHERE id = ?`, claim.id);
        this.send(conn, { t: 'approved', token: claim.token, seat: { id: claim.seat_id, name: claim.name } });
        return;
      }
      conn.setMeta({ role: 'pending', claimId: String(claim.id) });
    } else {
      this.signOutConn(conn, 'bad_hello');
    }
  }

  /**
   * Records delivered / seen / 👍 for cards this seat can see. Writes only what changed.
   * @param {string} seatId @param {string[]} cardIds @param {'got' | 'seen' | 'ack'} kind
   */
  receipts(seatId, cardIds, kind) {
    const now = this.store.now();
    for (const cardId of cardIds) {
      if (!canSee(this.store, cardId, seatId)) continue;
      const [old] = this.store.sql(
        `SELECT delivered_at, seen_at, ack_at FROM receipts WHERE card_id = ? AND seat_id = ?`, cardId, seatId,
      );
      const next = {
        delivered_at: old?.delivered_at ?? now,
        seen_at: old?.seen_at ?? (kind === 'got' ? null : now),
        ack_at: old?.ack_at ?? (kind === 'ack' ? now : null),
      };
      if (old && old.delivered_at === next.delivered_at && old.seen_at === next.seen_at && old.ack_at === next.ack_at) continue;
      this.store.sql(
        `INSERT OR REPLACE INTO receipts (card_id, seat_id, delivered_at, seen_at, ack_at) VALUES (?, ?, ?, ?, ?)`,
        cardId, seatId, next.delivered_at, next.seen_at, next.ack_at,
      );
      this.toDms({
        t: 'receipt', cardId, seatId,
        receipt: { delivered: true, seen: next.seen_at != null, acked: next.ack_at != null },
      });
      if (kind === 'ack') {
        const item = playerItem(this.store, cardId, seatId);
        for (const conn of this.seatConns(seatId)) this.send(conn, { t: 'item', item, fresh: false });
      }
    }
  }

  /**
   * Sends a card's new state to the players affected: seats that can see it now get the item
   * (`fresh` if they couldn't before), seats that could see it before but not now get `remove`.
   * Nobody else hears anything about it.
   * @param {string} cardId @param {Set<string>} before
   */
  pushToPlayers(cardId, before) {
    const after = seatsSeeing(this.store, cardId);
    for (const conn of this.conns('player')) {
      const seatId = /** @type {any} */ (conn.meta()).seatId;
      if (after.has(seatId)) {
        this.send(conn, { t: 'item', item: playerItem(this.store, cardId, seatId), fresh: !before.has(seatId) });
      } else if (before.has(seatId)) {
        this.send(conn, { t: 'remove', id: cardId });
      }
    }
  }

  /** Seat status for the DM: online (page open and recently pinging), away, offline or unclaimed. */
  presence() {
    const now = this.store.now();
    const players = this.conns('player');
    return this.store.sql(`SELECT id, token_hash IS NOT NULL AS claimed FROM seats ORDER BY sort`).map((seat) => {
      const conns = players.filter((conn) => /** @type {any} */ (conn.meta()).seatId === seat.id);
      const online = conns.some((conn) => {
        const pong = conn.lastPong();
        return /** @type {any} */ (conn.meta()).visible && (pong == null || now - pong < PONG_STALE);
      });
      const status = online ? 'online' : conns.length ? 'away' : seat.claimed ? 'offline' : 'unclaimed';
      return { id: String(seat.id), status };
    });
  }

  // ---------- Helpers

  /** @param {Conn} conn @param {unknown} message */
  send(conn, message) {
    try {
      conn.send(JSON.stringify(message));
    } catch {
      // The socket is closing; its close handler cleans up.
    }
  }

  /** @param {Conn} conn @param {string} reason */
  signOutConn(conn, reason) {
    this.send(conn, { t: 'signedOut', reason });
    try {
      conn.close(4000, reason);
    } catch {
      // already closed
    }
  }

  /** @param {'player' | 'dm' | 'pending'} role */
  conns(role) {
    return this.sockets.all().filter((conn) => conn.meta()?.role === role);
  }

  /** @param {string} seatId */
  seatConns(seatId) {
    return this.conns('player').filter((conn) => /** @type {any} */ (conn.meta()).seatId === seatId);
  }

  /** @param {unknown} message */
  toDms(message) {
    for (const conn of this.conns('dm')) this.send(conn, message);
  }

  /** Sends each player a message built for their seat. @param {(seatId: string) => unknown} build */
  toPlayers(build) {
    for (const conn of this.conns('player')) this.send(conn, build(/** @type {any} */ (conn.meta()).seatId));
  }

  /** @returns {Record<string, string>} */
  meta() {
    return Object.fromEntries(this.store.sql(`SELECT key, value FROM meta`).map((row) => [row.key, row.value]));
  }

  /** @param {string} key @param {string | number} value */
  setMeta(key, value) {
    this.store.sql(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, key, String(value));
  }

  /** Marks the room as used (for expiry), at most once an hour to save writes. */
  touch() {
    const now = this.store.now();
    if (now - Number(this.meta().last_active_at ?? 0) > HOUR) {
      this.setMeta('last_active_at', now);
      this.scheduleExpiry(now);
    }
  }

  // ---------- Expiry and deletion

  /** @param {number} lastActive */
  scheduleExpiry(lastActive) {
    if (this.expiryDays > 0) this.hooks.setAlarm?.(lastActive + this.expiryDays * DAY);
  }

  /** When the room would be deleted if nobody uses it, or null if rooms never expire here. */
  expiresAt() {
    return this.expiryDays > 0 ? Number(this.meta().last_active_at) + this.expiryDays * DAY : null;
  }

  /** The host's timer (Cloudflare alarm, Node sweep): delete the room if it has gone unused long enough. */
  async onAlarm() {
    if (!hasSchema(this.store)) return false;
    const at = this.expiresAt();
    if (at == null) return false;
    if (this.store.now() >= at) {
      await this.deleteRoom('expired');
      return true;
    }
    this.hooks.setAlarm?.(at); // used since the alarm was set: check again at the new date
    return false;
  }

  /**
   * Deletes everything: cards, images, seats, reveals. Connected devices are told and signed out first.
   * @param {'deleted' | 'expired'} reason
   */
  async deleteRoom(reason) {
    for (const conn of this.sockets.all()) this.signOutConn(conn, 'roomDeleted');
    if (this.hooks.destroy) {
      await this.hooks.destroy();
    } else {
      const tables = this.store.sql(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((t) => String(t.name));
      this.store.tx(() => {
        for (const table of tables) this.store.sql(`DROP TABLE IF EXISTS "${table}"`);
      });
    }
    return json({ ok: true, reason });
  }

  /** @param {unknown} seatId */
  seat(seatId) {
    if (typeof seatId !== 'string') return null;
    return this.store.sql(`SELECT id, name, token_hash FROM seats WHERE id = ?`, seatId)[0] ?? null;
  }

  /** @param {string[]} ids */
  existingSeats(ids) {
    return ids.filter((id) => this.seat(id));
  }

  /** @param {string} cardId */
  cardExists(cardId) {
    return this.store.sql(`SELECT 1 FROM cards WHERE id = ?`, cardId).length > 0;
  }

  /** The session a reveal belongs to; starts a new one after a long gap. @param {number} now */
  sessionForReveal(now) {
    const [last] = this.store.sql(`SELECT n, started_at FROM sessions ORDER BY n DESC LIMIT 1`);
    const lastReveal = Number(this.meta().last_reveal_at ?? 0);
    if (!last || now - Math.max(lastReveal, Number(last.started_at)) > SESSION_GAP) return this.startSession(now);
    return Number(last.n);
  }

  /** @param {number} now */
  startSession(now) {
    const [{ top }] = this.store.sql(`SELECT max(n) AS top FROM sessions`);
    const n = (top ?? 0) + 1;
    this.store.sql(`INSERT INTO sessions (n, started_at) VALUES (?, ?)`, n, now);
    return n;
  }

  sessions() {
    return this.store.sql(`SELECT n, started_at FROM sessions ORDER BY n`).map((s) => ({ n: Number(s.n), startedAt: Number(s.started_at) }));
  }

  playerRoom() {
    const meta = this.meta();
    return { code: meta.code, name: meta.name };
  }

  dmRoom() {
    const meta = this.meta();
    return {
      code: meta.code, name: meta.name, joinLocked: meta.join_locked === '1',
      createdAt: Number(meta.created_at), lastActiveAt: Number(meta.last_active_at),
      expiryDays: this.expiryDays, expiresAt: this.expiresAt(),
    };
  }

  dmSeats() {
    const status = new Map(this.presence().map((p) => [p.id, p.status]));
    return this.store
      .sql(`SELECT id, name, sort, token_hash IS NOT NULL AS claimed, link_hash IS NOT NULL AS has_link, last_seen_at FROM seats ORDER BY sort`)
      .map((seat) => ({
        id: String(seat.id), name: String(seat.name), claimed: Boolean(seat.claimed), hasLink: Boolean(seat.has_link),
        lastSeenAt: seat.last_seen_at == null ? null : Number(seat.last_seen_at), status: status.get(String(seat.id)),
      }));
  }

  claims() {
    return this.store
      .sql(`SELECT id, seat_id, created_at FROM claims WHERE created_at > ? AND token IS NULL ORDER BY created_at`, this.store.now() - CLAIM_TTL)
      .map((c) => ({ id: String(c.id), seatId: String(c.seat_id), createdAt: Number(c.created_at) }));
  }
}
