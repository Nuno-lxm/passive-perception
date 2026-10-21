// @ts-check
// Room codes as people type them. Mirrors src/core/ids.js (the server checks again).

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** @param {unknown} input @returns {string | null} */
export function normalizeRoomCode(input) {
  if (typeof input !== 'string') return null;
  const code = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (code.length !== 6 || [...code].some((c) => !ALPHABET.includes(c))) return null;
  return code;
}

/** @param {string} code */
export const formatRoomCode = (code) => `${code.slice(0, 3)}-${code.slice(3)}`;
