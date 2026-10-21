import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRoomCode, newId, newRoomCode, newSecret, normalizeRoomCode, sha256 } from '../src/core/ids.js';

test('room codes are 6 readable characters and survive being typed sloppily', () => {
  const code = newRoomCode();
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{6}$/);
  assert.equal(normalizeRoomCode(formatRoomCode(code).toLowerCase()), code);
  assert.equal(normalizeRoomCode(' k7q-f2m '), 'K7QF2M');
  assert.equal(normalizeRoomCode('O1I-L00'), '011100'); // O→0, I/L→1
});

test('normalizeRoomCode rejects anything that cannot be a code', () => {
  for (const bad of ['', 'K7QF2', 'K7QF2MM', 'K7QF2U', '../../x', null, 42]) {
    assert.equal(normalizeRoomCode(bad), null, String(bad));
  }
});

test('ids and secrets are random and the right size', () => {
  assert.match(newId(), /^[0-9a-z]{10}$/);
  assert.notEqual(newId(), newId());
  const secret = newSecret();
  assert.match(secret, /^[A-Za-z0-9_-]{22}$/); // 128 bits, base64url
  assert.notEqual(secret, newSecret());
});

test('sha256 matches the known test vector', async () => {
  assert.equal(await sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
