// @ts-check
// Everything this device remembers, in localStorage. No cookies.
// localStorage can be missing or throw (private mode, blocked storage), so every access is guarded.

const PREFIX = 'whisperer.';

/** @param {string} key @param {any} fallback */
function read(key, fallback) {
  try {
    const value = localStorage.getItem(PREFIX + key);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** @param {string} key @param {any} value */
function write(key, value) {
  try {
    if (value === undefined) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the app still works for this visit.
  }
}

/**
 * @typedef {{ lang?: string, keepAwake?: boolean, textSize?: number, theme?: string }} Prefs
 * @returns {Prefs}
 */
export const prefs = () => read('prefs', {});
/** @param {Prefs} changes */
export const savePrefs = (changes) => write('prefs', { ...prefs(), ...changes });

/** DM keys by room code: { CODE: { key, name, savedLink } } */
export const dmRooms = () => /** @type {Record<string, { key: string, name?: string, savedLink?: boolean }>} */ (read('dm', {}));
/** @param {string} code @param {{ key: string, name?: string, savedLink?: boolean } | undefined} room */
export function saveDmRoom(code, room) {
  const all = dmRooms();
  if (room) all[code] = { ...all[code], ...room };
  else delete all[code];
  write('dm', all);
}

/** Seat tokens by room code: { CODE: { token, seatId, seatName, roomName } } */
export const seats = () => /** @type {Record<string, { token: string, seatId: string, seatName: string, roomName?: string }>} */ (read('seats', {}));
/** @param {string} code @param {{ token: string, seatId: string, seatName: string, roomName?: string } | undefined} seat */
export function saveSeat(code, seat) {
  const all = seats();
  if (seat) all[code] = { ...all[code], ...seat };
  else delete all[code];
  write('seats', all);
}

/** The last feed seen for a room, so the page shows it instantly while reconnecting. */
export const cachedFeed = (/** @type {string} */ code) => read(`feed.${code}`, null);
export const saveFeed = (/** @type {string} */ code, /** @type {any} */ feed) => write(`feed.${code}`, feed);

/** A join request waiting for the DM, per room, so tapping again resumes it instead of asking twice. */
export const pendingClaim = (/** @type {string} */ code) =>
  /** @type {{ seatId: string, claimId: string } | null} */ (read(`pending.${code}`, null));
export const savePendingClaim = (/** @type {string} */ code, /** @type {{ seatId: string, claimId: string } | undefined} */ claim) =>
  write(`pending.${code}`, claim);
