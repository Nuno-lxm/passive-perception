// @ts-check
// Room codes, ids, secret tokens and hashing. Web standard APIs only (crypto), so it runs on both hosts.

/** Crockford base32: no I, L, O, U, so codes are easy to read aloud. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ROOM_CODE_LENGTH = 6;

/** @param {number} length */
function randomBase32(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte & 31]; // 256 is a multiple of 32, so no bias
  return out;
}

/** A new room code, e.g. 'K7QF2M'. Shown to people as 'K7Q-F2M' (see formatRoomCode). */
export const newRoomCode = () => randomBase32(ROOM_CODE_LENGTH);

/** A random id for cards, seats, images… Never sequential, so ids say nothing about how many exist. */
export const newId = () => randomBase32(10).toLowerCase();

/** A 128-bit secret (DM key, seat token, personal link), base64url. */
export function newSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Turns whatever a person typed into a room code, or null if it can't be one.
 * Case-insensitive; ignores spaces and dashes; reads O as 0 and I/L as 1.
 * @param {unknown} input
 */
export function normalizeRoomCode(input) {
  if (typeof input !== 'string') return null;
  const code = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (const char of code) if (!ALPHABET.includes(char)) return null;
  return code;
}

/** @param {string} code */
export const formatRoomCode = (code) => `${code.slice(0, 3)}-${code.slice(3)}`;

/**
 * Hex SHA-256. Secrets are 128-bit random, so a fast hash is enough to keep stored hashes useless to an attacker.
 * @param {string} text
 */
export async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
