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
const SESSION_GAP = 6 * HOUR; // the first reveal after this long starts a new session
const CLAIM_TTL = 10 * 60 * 1000;
const MAX_PENDING_CLAIMS = 20;
const PONG_STALE = 45 * 1000;
const MAX_MESSAGE = 4096;

/** @typedef {import('./sockets.js').Conn} Conn */
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
   */
  constructor(store, sockets = { all: () => [] }) {
    this.store = store;
    this.sockets = sockets;
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
      if (method === 'POST' && pathname === '/rotate-key') return await this.rotateKey();
      if (method === 'POST' && pathname === '/sessions') return this.newSession();
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

  newSession() {
    const n = this.startSession(this.store.now());
    this.toDms({ t: 'sessions', sessions: this.sessions() });
    return json({ session: n });
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

    const [{ n }] = this.store.sql(`SELECT count(*) AS n FROM claims`);
    if (n >= MAX_PENDING_CLAIMS) return fail('too_many_claims', 429);
    const claimId = newSecret();
    this.store.sql(`INSERT INTO claims (id, seat_id, created_at) VALUES (?, ?, ?)`, claimId, seat.id, now);
    this.toDms({ t: 'claims', claims: this.claims() });
    return json({ pending: claimId, seat: { id: seat.id, name: seat.name } }, 202);
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

  /** @param {any} body  { title, body, grp, quick } */
  addCard(body) {
    const fields = parseCardFields(body);
    const [{ n, top }] = this.store.sql(`SELECT count(*) AS n, max(sort) AS top FROM cards`);
    if (n >= LIMITS.cards) throw new InputError('too_many_cards');
    const id = newId();
    const now = this.store.now();
    this.store.sql(
      `INSERT INTO cards (id, title, body, grp, quick, sort, created_at, updated_at, content_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, fields.title ?? '', fields.body ?? '', fields.grp ?? null, body?.quick ? 1 : 0, (top ?? 0) + 1, now, now, now,
    );
    return this.cardChanged(id, 201);
  }

  /** @param {string} cardId @param {any} body */
  editCard(cardId, body) {
    const [card] = this.store.sql(`SELECT title, body, grp FROM cards WHERE id = ?`, cardId);
    if (!card) return fail('card_not_found', 404);
    const fields = { title: card.title, body: card.body, grp: card.grp, ...parseCardFields(body) };
    const contentChanged = fields.title !== card.title || fields.body !== card.body;
    const now = this.store.now();
    this.store.sql(
      `UPDATE cards SET title = ?, body = ?, grp = ?, updated_at = ?, content_at = CASE WHEN ? THEN ? ELSE content_at END
       WHERE id = ?`,
      fields.title, fields.body, fields.grp, now, contentChanged ? 1 : 0, now, cardId,
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
    if (!message || typeof message !== 'object' || !hasSchema(this.store)) return;

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
    if (now - Number(this.meta().last_active_at ?? 0) > HOUR) this.setMeta('last_active_at', now);
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
