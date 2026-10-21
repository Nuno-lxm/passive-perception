// @ts-check
// Input checks shared by every route. Errors are neutral codes; the client translates them.

export const LIMITS = {
  roomName: 80,
  seatName: 40,
  seats: 12,
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
