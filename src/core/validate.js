// @ts-check
// Input checks shared by every route. Errors are neutral codes; the client translates them.

export const LIMITS = {
  roomName: 80,
  seatName: 40,
  seats: 12,
  cards: 1000,
  title: 120,
  body: 4000,
  group: 40,
};

export class InputError extends Error {
  /** @param {string} code  e.g. 'room_name_required' */
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/**
 * Trims, collapses whitespace and normalizes Unicode (NFC), so the same name always compares equal.
 * @param {unknown} value
 */
export function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * @param {unknown} input  The body of POST /api/rooms.
 * @returns {{ name: string, seats: string[] }}
 */
export function parseNewRoom(input) {
  const body = /** @type {any} */ (input) ?? {};
  const name = cleanText(body.name);
  if (!name) throw new InputError('room_name_required');
  if (name.length > LIMITS.roomName) throw new InputError('room_name_too_long');

  if (!Array.isArray(body.seats)) throw new InputError('seats_required');
  const seats = body.seats.map(cleanText).filter(Boolean);
  if (seats.length === 0) throw new InputError('seats_required');
  if (seats.length > LIMITS.seats) throw new InputError('too_many_seats');
  if (seats.some((seat) => seat.length > LIMITS.seatName)) throw new InputError('seat_name_too_long');
  const lower = seats.map((seat) => seat.toLocaleLowerCase());
  if (new Set(lower).size !== lower.length) throw new InputError('duplicate_seat_names');

  return { name, seats };
}

/**
 * Multi-line text: keeps line breaks (at most two blank lines in a row), trims each end, normalizes Unicode.
 * @param {unknown} value
 */
export function cleanBody(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

/** @param {unknown} value */
export function parseSeatName(value) {
  const name = cleanText(value);
  if (!name) throw new InputError('seat_name_required');
  if (name.length > LIMITS.seatName) throw new InputError('seat_name_too_long');
  return name;
}

/**
 * A new card or changes to one. Only the fields present are returned, so PATCH can change one field.
 * @param {unknown} input
 * @returns {{ title?: string, body?: string, grp?: string | null }}
 */
export function parseCardFields(input) {
  const body = /** @type {any} */ (input) ?? {};
  /** @type {{ title?: string, body?: string, grp?: string | null }} */
  const fields = {};
  if ('title' in body) {
    fields.title = cleanText(body.title);
    if (fields.title.length > LIMITS.title) throw new InputError('title_too_long');
  }
  if ('body' in body) {
    fields.body = cleanBody(body.body);
    if (fields.body.length > LIMITS.body) throw new InputError('body_too_long');
  }
  if ('grp' in body) {
    fields.grp = cleanText(body.grp) || null;
    if (fields.grp && fields.grp.length > LIMITS.group) throw new InputError('group_too_long');
  }
  return fields;
}

/**
 * A list of ids from a client: strings only, no duplicates, bounded.
 * @param {unknown} value @param {number} [max]
 * @returns {string[]}
 */
export function idList(value, max = 200) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id) => typeof id === 'string' && id.length <= 64))].slice(0, max);
}
