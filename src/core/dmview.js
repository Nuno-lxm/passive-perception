// @ts-check
// What the DM sees: everything, including who has each card and their receipts.

/** @typedef {import('./store.js').Store} Store */

/**
 * @typedef {object} DmCard
 * @property {string} id
 * @property {string} title
 * @property {string} body
 * @property {string | null} grp
 * @property {string} note           Private to the DM: when to reveal.
 * @property {string[]} forSeats     Players the card is usually for (pre-selected when revealing).
 * @property {boolean} quick
 * @property {number} sort
 * @property {number | null} publicAt
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {{ id: string, w: number, h: number, bytes: number }[]} images
 * @property {Record<string, { revealedAt: number | null, delivered: boolean, seen: boolean, acked: boolean }>} seats
 *   One entry per seat that can see the card (revealedAt is null when it's visible only as a public card).
 */

/**
 * @param {Store} store @param {string} [cardId]  All cards, or just one.
 * @returns {DmCard[]}
 */
export function dmCards(store, cardId) {
  const where = cardId ? 'WHERE id = ?' : '';
  const bind = cardId ? [cardId] : [];
  const cards = store.sql(
    `SELECT id, title, body, grp, quick, sort, note, for_seats, public_at, created_at, updated_at FROM cards ${where} ORDER BY sort`,
    ...bind,
  );
  const cardWhere = cardId ? 'WHERE card_id = ?' : '';
  const images = store.sql(`SELECT id, card_id, w, h, bytes FROM images ${cardWhere} ORDER BY sort`, ...bind);
  const grants = store.sql(`SELECT card_id, seat_id, revealed_at FROM grants ${cardWhere}`, ...bind);
  const receipts = store.sql(`SELECT card_id, seat_id, delivered_at, seen_at, ack_at FROM receipts ${cardWhere}`, ...bind);
  const seatIds = store.sql(`SELECT id FROM seats`).map((row) => String(row.id));

  return cards.map((card) => {
    /** @type {DmCard['seats']} */
    const seats = {};
    const receiptFor = (/** @type {string} */ seatId) =>
      receipts.find((r) => r.card_id === card.id && r.seat_id === seatId);
    const add = (/** @type {string} */ seatId, /** @type {number | null} */ revealedAt) => {
      const receipt = receiptFor(seatId);
      seats[seatId] = {
        revealedAt,
        delivered: receipt?.delivered_at != null,
        seen: receipt?.seen_at != null,
        acked: receipt?.ack_at != null,
      };
    };
    for (const grant of grants) if (grant.card_id === card.id) add(grant.seat_id, Number(grant.revealed_at));
    if (card.public_at != null) for (const seatId of seatIds) if (!seats[seatId]) add(seatId, null);

    return {
      id: String(card.id),
      title: String(card.title),
      body: String(card.body),
      grp: card.grp == null ? null : String(card.grp),
      note: String(card.note ?? ''),
      forSeats: JSON.parse(String(card.for_seats ?? '[]')).filter((/** @type {string} */ id) => seatIds.includes(id)),
      quick: Boolean(card.quick),
      sort: Number(card.sort),
      publicAt: card.public_at == null ? null : Number(card.public_at),
      createdAt: Number(card.created_at),
      updatedAt: Number(card.updated_at),
      images: images
        .filter((image) => image.card_id === card.id)
        .map((image) => ({ id: String(image.id), w: Number(image.w), h: Number(image.h), bytes: Number(image.bytes) })),
      seats,
    };
  });
}
