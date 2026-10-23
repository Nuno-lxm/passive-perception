// @ts-check
// Campaign export and import: one JSON file with the room's name, seats, cards, images and reveal history.
// Never exported: the DM key, seat tokens, personal links, join requests, receipts.
//
// Export streams card by card (a room can hold ~50 MB of images, ~70 MB as base64), so the room never builds
// the whole file in memory. Import goes into a brand-new room, in batches the client sizes to a few MB each,
// during the room's first hour only; every field is checked like normal input.
import { checkImage, IMAGE_LIMITS } from './images.js';
import { InputError, LIMITS, parseCardFields } from './validate.js';

export const FORMAT = 'passive-perception';
/** Files exported before the app was renamed (Tabletop Whisperer) import the same way. */
export const OLD_FORMATS = ['tabletop-whisperer'];
export const VERSION = 1;
export const IMPORT_WINDOW = 60 * 60 * 1000;

/** @typedef {import('./store.js').Store} Store */

/**
 * @param {Store} store
 * @param {Record<string, string>} meta
 * @returns {ReadableStream<Uint8Array>}
 */
export function exportStream(store, meta) {
  const encoder = new TextEncoder();
  const seats = store.sql(`SELECT id, name, sort FROM seats ORDER BY sort`)
    .map((s) => ({ id: String(s.id), name: String(s.name) }));
  const sessions = store.sql(`SELECT n, started_at FROM sessions ORDER BY n`)
    .map((s) => ({ n: Number(s.n), startedAt: Number(s.started_at) }));
  const cardIds = store.sql(`SELECT id FROM cards ORDER BY sort`).map((c) => String(c.id));
  const head = JSON.stringify({
    format: FORMAT, version: VERSION, exportedAt: store.now(), room: { name: meta.name }, seats, sessions,
  });
  let index = -1; // -1: the head; then one card per pull; then the closing brackets

  return new ReadableStream({
    pull(controller) {
      if (index === -1) {
        controller.enqueue(encoder.encode(`${head.slice(0, -1)},"cards":[`));
      } else if (index < cardIds.length) {
        const card = exportCard(store, cardIds[index]);
        if (card) controller.enqueue(encoder.encode(`${index > 0 ? ',' : ''}${JSON.stringify(card)}`));
      } else {
        controller.enqueue(encoder.encode(']}'));
        controller.close();
      }
      index++;
    },
  });
}

/** @param {Store} store @param {string} id */
function exportCard(store, id) {
  const [c] = store.sql(
    `SELECT title, body, grp, quick, sort, note, for_seats, public_at, public_session, created_at FROM cards WHERE id = ?`, id,
  );
  if (!c) return null;
  const images = store.sql(`SELECT mime, w, h, data, thumb FROM images WHERE card_id = ? ORDER BY sort`, id).map((i) => ({
    mime: String(i.mime), w: Number(i.w), h: Number(i.h),
    data: toBase64(i.data), thumb: i.thumb ? toBase64(i.thumb) : null,
  }));
  const grants = store.sql(`SELECT seat_id, revealed_at, session FROM grants WHERE card_id = ?`, id)
    .map((g) => ({ seatId: String(g.seat_id), revealedAt: Number(g.revealed_at), session: Number(g.session) }));
  return {
    title: String(c.title), body: String(c.body), grp: c.grp == null ? null : String(c.grp), quick: Boolean(c.quick),
    sort: Number(c.sort), note: String(c.note), forSeats: JSON.parse(String(c.for_seats)),
    publicAt: c.public_at == null ? null : Number(c.public_at),
    publicSession: c.public_session == null ? null : Number(c.public_session),
    createdAt: Number(c.created_at), images, grants,
  };
}

/**
 * One batch of an import into this (new) room. Seat ids in the batch are the new room's (the client maps them by
 * name). All or nothing per batch.
 * @param {Store} store
 * @param {any} body  { cards: [...exported cards], sessions?: [...] }
 * @param {() => string} newId
 */
export function importBatch(store, body, newId) {
  const cards = Array.isArray(body?.cards) ? body.cards : [];
  const sessions = Array.isArray(body?.sessions) ? body.sessions : [];
  if (cards.length > LIMITS.importCards) throw new InputError('too_many_to_import');
  const seatIds = new Set(store.sql(`SELECT id FROM seats`).map((s) => String(s.id)));
  const now = store.now();
  const time = (/** @type {unknown} */ value) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= now ? value : now;
  const session = (/** @type {unknown} */ value) =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 100_000 ? value : 1;

  // Check everything first, so a bad card rejects the batch before anything is written.
  const [{ n }] = store.sql(`SELECT count(*) AS n FROM cards`);
  if (n + cards.length > LIMITS.cards) throw new InputError('too_many_cards');
  const [{ total }] = store.sql(`SELECT coalesce(sum(bytes), 0) AS total FROM images`);
  let bytes = Number(total);
  const prepared = cards.map((/** @type {any} */ card) => {
    const fields = parseCardFields(card);
    const images = (Array.isArray(card.images) ? card.images : []).slice(0, IMAGE_LIMITS.perCard).map((/** @type {any} */ image) => {
      const data = fromBase64(image?.data);
      const checked = checkImage(data, IMAGE_LIMITS.bytes);
      if (!checked.image) throw new InputError(/** @type {string} */ (checked.error));
      const thumb = image?.thumb ? fromBase64(image.thumb) : null;
      if (thumb && !checkImage(thumb, IMAGE_LIMITS.thumbBytes).image) throw new InputError('image_type');
      bytes += data.length;
      return { ...checked.image, data, thumb };
    });
    const grants = (Array.isArray(card.grants) ? card.grants : [])
      .filter((/** @type {any} */ g) => typeof g?.seatId === 'string' && seatIds.has(g.seatId))
      .map((/** @type {any} */ g) => ({ seatId: g.seatId, revealedAt: time(g.revealedAt), session: session(g.session) }));
    return {
      fields, images, grants, quick: card.quick === true,
      publicAt: card.publicAt == null ? null : time(card.publicAt),
      publicSession: card.publicAt == null ? null : session(card.publicSession),
      createdAt: time(card.createdAt),
    };
  });
  if (bytes > IMAGE_LIMITS.roomBytes) throw new InputError('room_storage_full');

  store.tx(() => {
    for (const s of sessions) {
      store.sql(`INSERT OR IGNORE INTO sessions (n, started_at) VALUES (?, ?)`, session(s?.n), time(s?.startedAt));
    }
    for (const card of prepared) {
      const id = newId();
      const f = card.fields;
      const [{ top }] = store.sql(`SELECT max(sort) AS top FROM cards`);
      store.sql(
        `INSERT INTO cards (id, title, body, grp, quick, sort, note, for_seats, public_at, public_session, created_at, updated_at, content_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, f.title ?? '', f.body ?? '', f.grp ?? null, card.quick ? 1 : 0, (top ?? 0) + 1, f.note ?? '',
        JSON.stringify((f.forSeats ?? []).filter((s) => seatIds.has(s))), card.publicAt, card.publicSession,
        card.createdAt, now, card.createdAt,
      );
      card.images.forEach((image, sort) => {
        store.sql(
          `INSERT INTO images (id, card_id, sort, mime, w, h, bytes, data, thumb, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          newId(), id, sort, image.mime, image.w, image.h, image.data.length, image.data, image.thumb, now,
        );
      });
      for (const g of card.grants) {
        store.sql(`INSERT OR IGNORE INTO grants (card_id, seat_id, revealed_at, session) VALUES (?, ?, ?, ?)`, id, g.seatId, g.revealedAt, g.session);
      }
    }
  });
  return prepared.length;
}

/** @param {Uint8Array | ArrayBuffer} bytes */
export function toBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** @param {unknown} text */
export function fromBase64(text) {
  if (typeof text !== 'string' || text.length > IMAGE_LIMITS.bytes * 1.4) throw new InputError('image_too_large');
  let binary;
  try {
    binary = atob(text);
  } catch {
    throw new InputError('image_type');
  }
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
