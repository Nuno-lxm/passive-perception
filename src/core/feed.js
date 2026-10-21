// @ts-check
// What a player is allowed to see. THE security-critical file:
// every card, image and receipt a player's device receives goes through these functions.
// A card is visible to a seat when it was revealed to everyone (public_at) or to that seat (a grant).

/** @typedef {import('./store.js').Store} Store */

/**
 * The item a player sees. Built field by field from an allowlist, so columns added to cards later
 * (e.g. private DM notes) can't leak by accident. Never includes who else received it.
 * @typedef {object} PlayerItem
 * @property {string} id
 * @property {string} title
 * @property {string} body
 * @property {{ id: string, w: number, h: number }[]} images
 * @property {number} at        When it was revealed to this player (or to everyone, if earlier).
 * @property {number} session
 * @property {boolean} edited   Changed after it was revealed to this player.
 * @property {boolean} shared   Revealed to the whole table.
 * @property {boolean} acked    This player tapped 👍.
 */

const VISIBLE_CARDS = `
  SELECT c.id, c.title, c.body, c.public_at, c.public_session, c.content_at,
         g.revealed_at, g.session, r.ack_at
  FROM cards c
  LEFT JOIN grants g ON g.card_id = c.id AND g.seat_id = ?
  LEFT JOIN receipts r ON r.card_id = c.id AND r.seat_id = ?
  WHERE (c.public_at IS NOT NULL OR g.seat_id IS NOT NULL)`;

const VISIBLE_IMAGES = `
  SELECT i.id, i.card_id, i.w, i.h
  FROM images i
  JOIN cards c ON c.id = i.card_id
  LEFT JOIN grants g ON g.card_id = c.id AND g.seat_id = ?
  WHERE (c.public_at IS NOT NULL OR g.seat_id IS NOT NULL)`;

/**
 * Everything revealed to a seat, newest first.
 * @param {Store} store @param {string} seatId
 * @returns {PlayerItem[]}
 */
export function feedFor(store, seatId) {
  const images = groupImages(store.sql(`${VISIBLE_IMAGES} ORDER BY i.sort`, seatId));
  return store
    .sql(VISIBLE_CARDS, seatId, seatId)
    .map((row) => toPlayerItem(row, images.get(row.id) ?? []))
    .sort((a, b) => b.at - a.at);
}

/**
 * One card as this seat sees it, or null if the seat may not see it.
 * @param {Store} store @param {string} cardId @param {string} seatId
 */
export function playerItem(store, cardId, seatId) {
  const [row] = store.sql(`${VISIBLE_CARDS} AND c.id = ?`, seatId, seatId, cardId);
  if (!row) return null;
  const images = store.sql(`${VISIBLE_IMAGES} AND c.id = ? ORDER BY i.sort`, seatId, cardId);
  return toPlayerItem(row, images.map(toImage));
}

/** @param {Store} store @param {string} cardId @param {string} seatId */
export function canSee(store, cardId, seatId) {
  return store.sql(`${VISIBLE_CARDS} AND c.id = ?`, seatId, seatId, cardId).length > 0;
}

/**
 * The seats that can currently see a card.
 * @param {Store} store @param {string} cardId
 * @returns {Set<string>}
 */
export function seatsSeeing(store, cardId) {
  const [card] = store.sql(`SELECT public_at FROM cards WHERE id = ?`, cardId);
  if (!card) return new Set();
  const rows = card.public_at != null
    ? store.sql(`SELECT id AS seat_id FROM seats`)
    : store.sql(`SELECT seat_id FROM grants WHERE card_id = ?`, cardId);
  return new Set(rows.map((row) => row.seat_id));
}

/**
 * @param {import('./store.js').Row} row @param {{ id: string, w: number, h: number }[]} images
 * @returns {PlayerItem}
 */
function toPlayerItem(row, images) {
  const viaGrant = row.revealed_at != null ? { at: row.revealed_at, session: row.session } : null;
  const viaPublic = row.public_at != null ? { at: row.public_at, session: row.public_session } : null;
  const first = viaGrant && viaPublic ? (viaGrant.at <= viaPublic.at ? viaGrant : viaPublic) : (viaGrant ?? viaPublic);
  const { at, session } = /** @type {{ at: number, session: number }} */ (first);
  return {
    id: String(row.id),
    title: String(row.title),
    body: String(row.body),
    images,
    at: Number(at),
    session: Number(session),
    edited: Number(row.content_at) > Number(at),
    shared: viaPublic != null,
    acked: row.ack_at != null,
  };
}

/** @param {import('./store.js').Row} row */
const toImage = (row) => ({ id: String(row.id), w: Number(row.w), h: Number(row.h) });

/** @param {import('./store.js').Row[]} rows */
function groupImages(rows) {
  /** @type {Map<string, { id: string, w: number, h: number }[]>} */
  const byCard = new Map();
  for (const row of rows) {
    const list = byCard.get(row.card_id) ?? [];
    list.push(toImage(row));
    byCard.set(row.card_id, list);
  }
  return byCard;
}
