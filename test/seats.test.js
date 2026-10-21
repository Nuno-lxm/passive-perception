import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testRoom } from './helpers.js';

async function freshRoom(seats = ['Ana', 'Bruno']) {
  const r = testRoom();
  await r.call('POST', '/create', { body: { code: 'K7QF2M', name: 'Campaign', seats } });
  const { data: info } = await r.call('GET', '/info');
  const ids = Object.fromEntries(info.seats.map((s) => [s.name, s.id]));
  const key = (await r.call('POST', '/rotate-key', { auth: await adminKeyOf(r) })).data?.adminKey;
  return { ...r, ids, key };
}

/** The tests can't read the original key back (only its hash is stored), so set a known one. */
async function adminKeyOf(r) {
  const { sha256 } = await import('../src/core/ids.js');
  const key = 'test-admin-key-0123456789';
  r.store.sql(`UPDATE meta SET value = ? WHERE key = 'admin_hash'`, await sha256(key));
  return key;
}

test('the first claim of a seat is free; the token then logs in', async () => {
  const r = await freshRoom();
  const claim = await r.call('POST', '/claim', { body: { seatId: r.ids.Ana } });
  assert.equal(claim.status, 200);
  assert.equal(claim.data.seat.name, 'Ana');
  const ana = await r.join({ role: 'player', token: claim.data.token });
  assert.equal(ana.last('welcome').seat.name, 'Ana');
  assert.equal((await r.call('GET', '/info')).data.seats[0].claimed, true);
});

test('claiming a taken seat waits for the DM; approving moves the seat and signs the old device out', async () => {
  const r = await freshRoom();
  const dm = await r.join({ role: 'dm', key: r.key });
  const first = await r.call('POST', '/claim', { body: { seatId: r.ids.Ana } });
  const oldPhone = await r.join({ role: 'player', token: first.data.token });

  const second = await r.call('POST', '/claim', { body: { seatId: r.ids.Ana } });
  assert.equal(second.status, 202);
  assert.ok(second.data.pending);
  assert.equal(second.data.token, undefined);
  assert.equal(dm.last('claims').claims[0].seatId, r.ids.Ana);

  const newPhone = await r.join({ role: 'pending', claim: second.data.pending });
  assert.equal(newPhone.sent.length, 0, 'waiting quietly');

  const approve = await r.call('POST', `/claims/${second.data.pending}/approve`, { auth: r.key });
  assert.equal(approve.status, 200);
  const { token } = newPhone.last('approved');
  assert.ok(token);
  assert.deepEqual(oldPhone.last('signedOut'), { t: 'signedOut', reason: 'moved' });
  assert.equal(oldPhone.closed.code, 4000);
  assert.deepEqual(dm.last('claims').claims, []);

  const back = await r.join({ role: 'player', token: first.data.token });
  assert.equal(back.last('signedOut').reason, 'bad_token', 'the old token no longer works');
  assert.equal((await r.join({ role: 'player', token })).last('welcome').seat.name, 'Ana');
});

test('an approved claim waits for a device that was asleep, but only for 10 minutes', async () => {
  const r = await freshRoom();
  await r.call('POST', '/claim', { body: { seatId: r.ids.Ana } });
  const { data } = await r.call('POST', '/claim', { body: { seatId: r.ids.Ana } });
  await r.call('POST', `/claims/${data.pending}/approve`, { auth: r.key });

  const later = await r.join({ role: 'pending', claim: data.pending });
  assert.ok(later.last('approved').token);
  const again = await r.join({ role: 'pending', claim: data.pending });
  assert.equal(again.last('signedOut').reason, 'claim_expired', 'a claim is used once');

  const { data: other } = await r.call('POST', '/claim', { body: { seatId: r.ids.Ana } });
  r.clock.now += 11 * 60 * 1000;
  assert.equal((await r.join({ role: 'pending', claim: other.pending })).last('signedOut').reason, 'claim_expired');
});

test('denying a claim tells the waiting device', async () => {
  const r = await freshRoom();
  await r.call('POST', '/claim', { body: { seatId: r.ids.Ana } });
  const { data } = await r.call('POST', '/claim', { body: { seatId: r.ids.Ana } });
  const waiting = await r.join({ role: 'pending', claim: data.pending });
  await r.call('POST', `/claims/${data.pending}/deny`, { auth: r.key });
  assert.equal(waiting.last('signedOut').reason, 'denied');
  assert.equal((await r.call('POST', `/claims/${data.pending}/approve`, { auth: r.key })).status, 404);
});

test('locking joins makes even free seats wait for approval', async () => {
  const r = await freshRoom();
  await r.call('PATCH', '/room', { auth: r.key, body: { joinLocked: true } });
  const claim = await r.call('POST', '/claim', { body: { seatId: r.ids.Bruno } });
  assert.equal(claim.status, 202);
  assert.equal((await r.call('GET', '/info')).data.joinLocked, true);
});

test('a personal link takes the seat without approval; a new link replaces the old one', async () => {
  const r = await freshRoom();
  const taken = await r.call('POST', '/claim', { body: { seatId: r.ids.Ana } });
  const prankster = await r.join({ role: 'player', token: taken.data.token });

  const { data: link1 } = await r.call('POST', `/seats/${r.ids.Ana}/link`, { auth: r.key });
  const { data: link2 } = await r.call('POST', `/seats/${r.ids.Ana}/link`, { auth: r.key });
  assert.equal((await r.call('POST', '/redeem', { body: { secret: link1.secret } })).status, 404, 'old link is dead');

  const redeemed = await r.call('POST', '/redeem', { body: { secret: link2.secret } });
  assert.equal(redeemed.status, 200);
  assert.equal(prankster.last('signedOut').reason, 'moved');
  assert.equal((await r.join({ role: 'player', token: redeemed.data.token })).last('welcome').seat.name, 'Ana');
  assert.equal((await r.call('POST', '/redeem', { body: { secret: 'short' } })).status, 400);
});

test('the DM can release a seat; a player can leave', async () => {
  const r = await freshRoom();
  const ana = await r.call('POST', '/claim', { body: { seatId: r.ids.Ana } });
  const bruno = await r.call('POST', '/claim', { body: { seatId: r.ids.Bruno } });
  const anaConn = await r.join({ role: 'player', token: ana.data.token });

  await r.call('POST', `/seats/${r.ids.Ana}/release`, { auth: r.key });
  assert.equal(anaConn.last('signedOut').reason, 'released');
  assert.equal((await r.call('POST', '/claim', { body: { seatId: r.ids.Ana } })).status, 200, 'free again');

  assert.equal((await r.call('POST', '/leave', { auth: bruno.data.token })).status, 200);
  assert.equal((await r.call('GET', '/info')).data.seats.find((s) => s.name === 'Bruno').claimed, false);
});

test('seats can be added, renamed and removed, with the same name rules as at creation', async () => {
  const r = await freshRoom();
  assert.equal((await r.call('POST', '/seats', { auth: r.key, body: { name: 'carla' } })).status, 201);
  assert.deepEqual((await r.call('POST', '/seats', { auth: r.key, body: { name: 'ANA' } })).data, { error: 'duplicate_seat_names' });
  assert.equal((await r.call('PATCH', `/seats/${r.ids.Ana}`, { auth: r.key, body: { name: 'Ana Sofia' } })).status, 200);

  const card = (await r.call('POST', '/cards', { auth: r.key, body: { title: 'x' } })).data.card;
  await r.call('POST', `/cards/${card.id}/reveal`, { auth: r.key, body: { seats: [r.ids.Bruno] } });
  await r.call('DELETE', `/seats/${r.ids.Bruno}`, { auth: r.key });
  assert.deepEqual((await r.call('GET', '/info')).data.seats.map((s) => s.name), ['Ana Sofia', 'carla']);
  assert.equal(r.store.sql('SELECT count(*) AS n FROM grants')[0].n, 0);
});

test("rotating the DM key signs out every DM device and the old key stops working", async () => {
  const r = await freshRoom();
  const dm = await r.join({ role: 'dm', key: r.key });
  const { data } = await r.call('POST', '/rotate-key', { auth: r.key });
  assert.equal(dm.last('signedOut').reason, 'key_rotated');
  assert.equal((await r.call('POST', '/cards', { auth: r.key, body: {} })).status, 401);
  assert.equal((await r.call('POST', '/cards', { auth: data.adminKey, body: {} })).status, 201);
});

test('repeated requests for the same seat leave one banner; the older waiting device is told', async () => {
  const r = await freshRoom();
  const dm = await r.join({ role: 'dm', key: r.key });
  await r.call('POST', '/claim', { body: { seatId: r.ids.Ana } });
  const first = await r.call('POST', '/claim', { body: { seatId: r.ids.Ana } });
  const waiting = await r.join({ role: 'pending', claim: first.data.pending });
  for (let i = 0; i < 5; i++) await r.call('POST', '/claim', { body: { seatId: r.ids.Ana } });
  const last = await r.call('POST', '/claim', { body: { seatId: r.ids.Ana } });

  assert.equal(dm.last('claims').claims.length, 1);
  assert.equal(r.store.sql('SELECT count(*) AS n FROM claims')[0].n, 1);
  assert.equal(waiting.last('signedOut').reason, 'replaced');
  assert.equal((await r.call('POST', `/claims/${first.data.pending}/approve`, { auth: r.key })).status, 404);
  assert.equal((await r.call('POST', `/claims/${last.data.pending}/approve`, { auth: r.key })).status, 200);

  await r.call('POST', '/claim', { body: { seatId: r.ids.Bruno } });
  await r.call('POST', '/claim', { body: { seatId: r.ids.Bruno } });
  assert.equal(dm.last('claims').claims.length, 1, 'other seats still get their own request');
});

test('the waiting device can withdraw its request, and the banner goes away', async () => {
  const r = await freshRoom();
  const dm = await r.join({ role: 'dm', key: r.key });
  await r.call('POST', '/claim', { body: { seatId: r.ids.Ana } });
  const { data } = await r.call('POST', '/claim', { body: { seatId: r.ids.Ana } });
  assert.equal(dm.last('claims').claims.length, 1);
  await r.call('POST', '/cancel-claim', { body: { claim: data.pending } });
  assert.deepEqual(dm.last('claims').claims, []);
  assert.equal((await r.call('POST', `/claims/${data.pending}/approve`, { auth: r.key })).status, 404);
});
