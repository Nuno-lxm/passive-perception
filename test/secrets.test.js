// The hard requirement: a player's device only ever receives what was revealed to that player.
// These tests look at the raw text each connection received, not just the parsed shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakePng, testRoom } from './helpers.js';

const SECRET = 'The butler is the lich';

async function secretCardFor(t, seatName) {
  const r = testRoom();
  const { key, seats, tokens } = await r.setup(['Ana', 'Bruno', 'Carla']);
  const ana = await r.join({ role: 'player', token: tokens.Ana });
  const bruno = await r.join({ role: 'player', token: tokens.Bruno });
  const dm = await r.join({ role: 'dm', key });

  const { data } = await r.call('POST', '/cards', { auth: key, body: { title: SECRET, body: 'Only you notice the cold.' } });
  const cardId = data.card.id;
  const upload = await r.call('POST', `/cards/${cardId}/images`, { auth: key, raw: fakePng() });
  const imageId = upload.data.image.id;
  await r.call('POST', `/cards/${cardId}/reveal`, { auth: key, body: { seats: [seats[seatName]] } });
  return { ...r, key, seats, tokens, ana, bruno, dm, cardId, imageId };
}

/** Everything a connection ever received, as one string. */
const received = (conn) => conn.raw.join('\n');

test('a card revealed to Ana never reaches Bruno, live or on reconnect', async (t) => {
  const r = await secretCardFor(t, 'Ana');

  assert.match(received(r.ana), new RegExp(SECRET));
  assert.equal(r.ana.last('item').fresh, true);

  for (const leak of [SECRET, r.cardId, r.imageId, 'cold']) assert.ok(!received(r.bruno).includes(leak), `Bruno got ${leak}`);

  const brunoAgain = await r.join({ role: 'player', token: r.tokens.Bruno });
  assert.deepEqual(brunoAgain.last('welcome').feed, []);
  assert.ok(!received(brunoAgain).includes(r.cardId));
});

test("players can't fetch images of cards they can't see, and get the same 404 as for a missing image", async (t) => {
  const r = await secretCardFor(t, 'Ana');
  const asAna = await r.call('GET', `/images/${r.imageId}`, { auth: r.tokens.Ana });
  assert.equal(asAna.status, 200);
  assert.equal(asAna.headers.get('content-type'), 'image/png');

  const asBruno = await r.call('GET', `/images/${r.imageId}`, { auth: r.tokens.Bruno });
  const missing = await r.call('GET', '/images/doesnotexist', { auth: r.tokens.Bruno });
  assert.deepEqual([asBruno.status, asBruno.data], [404, { error: 'image_not_found' }]);
  assert.deepEqual([missing.status, missing.data], [asBruno.status, asBruno.data]);

  assert.equal((await r.call('GET', `/images/${r.imageId}`)).status, 401);
  assert.equal((await r.call('GET', `/images/${r.imageId}`, { auth: 'x'.repeat(22) })).status, 401);
});

test('player items carry only allowlisted fields, never other recipients', async (t) => {
  const r = await secretCardFor(t, 'Ana');
  await r.call('POST', `/cards/${r.cardId}/reveal`, { auth: r.key, body: { seats: [r.seats.Bruno] } });
  const item = r.ana.last('item').item;
  assert.deepEqual(Object.keys(item).sort(), ['acked', 'at', 'body', 'edited', 'id', 'images', 'session', 'shared', 'title']);
  assert.ok(!received(r.ana).includes(r.seats.Bruno), "Ana must not learn Bruno's seat id");
  assert.ok(!received(r.bruno).includes(r.seats.Ana), "Bruno must not learn Ana's seat id");
});

test('un-revealing removes the card, its receipts, and access to its images', async (t) => {
  const r = await secretCardFor(t, 'Ana');
  await r.ana.message({ t: 'seen', ids: [r.cardId] });
  await r.call('POST', `/cards/${r.cardId}/unreveal`, { auth: r.key, body: { seats: [r.seats.Ana] } });

  assert.deepEqual(r.ana.last('remove'), { t: 'remove', id: r.cardId });
  assert.equal((await r.call('GET', `/images/${r.imageId}`, { auth: r.tokens.Ana })).status, 404);
  assert.equal(r.store.sql('SELECT count(*) AS n FROM receipts')[0].n, 0);
  assert.equal(r.bruno.all('remove').length, 0, "Bruno never had it, so he isn't told it's gone");

  const anaAgain = await r.join({ role: 'player', token: r.tokens.Ana });
  assert.deepEqual(anaAgain.last('welcome').feed, []);
});

test('"everyone" reaches all seats, including players who join later, and can be taken back', async (t) => {
  const r = await secretCardFor(t, 'Ana');
  await r.call('POST', `/cards/${r.cardId}/reveal`, { auth: r.key, body: { everyone: true } });
  assert.equal(r.bruno.last('item').fresh, true);
  assert.equal(r.bruno.last('item').item.shared, true);
  assert.equal(r.ana.last('item').fresh, false, 'Ana already had it');

  const carla = await r.join({ role: 'player', token: r.tokens.Carla });
  assert.deepEqual(carla.last('welcome').feed.map((i) => i.id), [r.cardId]);

  await r.call('POST', `/cards/${r.cardId}/unreveal`, { auth: r.key, body: { everyone: true } });
  assert.deepEqual(r.bruno.last('remove'), { t: 'remove', id: r.cardId });
  assert.deepEqual(carla.last('remove'), { t: 'remove', id: r.cardId });
  assert.equal(r.ana.all('remove').length, 0, 'Ana still has her own grant');
});

test('editing a revealed card updates only those who can see it, marked edited, without buzzing', async (t) => {
  const r = await secretCardFor(t, 'Ana');
  r.clock.now += 1000;
  await r.call('PATCH', `/cards/${r.cardId}`, { auth: r.key, body: { body: 'Fixed typo.' } });
  const update = r.ana.last('item');
  assert.equal(update.fresh, false);
  assert.equal(update.item.edited, true);
  assert.equal(update.item.body, 'Fixed typo.');
  assert.ok(!received(r.bruno).includes('Fixed typo'));

  const before = r.ana.sent.length;
  await r.call('PATCH', `/cards/${r.cardId}`, { auth: r.key, body: { grp: 'Manor' } });
  assert.equal(r.ana.sent.length, before, "changing the DM's group label tells players nothing");
});

test('deleting a card removes it only from the feeds that had it', async (t) => {
  const r = await secretCardFor(t, 'Ana');
  await r.call('DELETE', `/cards/${r.cardId}`, { auth: r.key });
  assert.deepEqual(r.ana.last('remove'), { t: 'remove', id: r.cardId });
  assert.equal(r.bruno.all('remove').length, 0);
  assert.equal(r.store.sql('SELECT count(*) AS n FROM images')[0].n, 0);
});

test('unrevealed cards never reach players', async (t) => {
  const r = await secretCardFor(t, 'Ana');
  const draft = await r.call('POST', '/cards', { auth: r.key, body: { title: 'Draft twist', body: 'not yet' } });
  for (const conn of [r.ana, r.bruno]) assert.ok(!received(conn).includes('Draft twist'));
  const anaAgain = await r.join({ role: 'player', token: r.tokens.Ana });
  assert.ok(!received(anaAgain).includes(draft.data.card.id));
});

test('players cannot use DM routes, and receipts for invisible cards are ignored', async (t) => {
  const r = await secretCardFor(t, 'Ana');
  const routes = [
    ['POST', '/cards'], ['PATCH', `/cards/${r.cardId}`], ['POST', `/cards/${r.cardId}/reveal`],
    ['POST', `/seats/${r.seats.Bruno}/release`], ['POST', '/rotate-key'], ['PATCH', '/room'],
  ];
  for (const [method, path] of routes) {
    const response = await r.call(method, path, { auth: r.tokens.Bruno, body: { seats: [r.seats.Bruno] } });
    assert.equal(response.status, 403, `${method} ${path}`);
  }
  await r.bruno.message({ t: 'seen', ids: [r.cardId] });
  await r.bruno.message({ t: 'ack', id: r.cardId });
  assert.equal(r.store.sql('SELECT count(*) AS n FROM receipts')[0].n, 0);
});

test('bad hellos are closed and receive nothing', async () => {
  const r = testRoom();
  const { key } = await r.setup();
  for (const hello of [{ role: 'player', token: 'nope'.repeat(6) }, { role: 'dm', key: key.slice(1) + 'x' }, { role: 'admin' }]) {
    const conn = await r.join(hello);
    assert.equal(conn.closed?.code, 4000);
    assert.deepEqual(conn.sent.map((m) => m.t), ['signedOut']);
  }
  const silent = r.connect();
  await silent.message({ t: 'seen', ids: ['x'] });
  assert.deepEqual(silent.sent, [], 'nothing before hello');
});

test('a socket that never says hello is closed after 5 s; one that does stays open', async () => {
  const r = testRoom();
  const { tokens } = await r.setup();
  const silent = r.connect();
  r.clock.now += 4_000;
  const ana = await r.join({ role: 'player', token: tokens.Ana });
  assert.equal(silent.closed, null, 'still within its 5 s');
  r.clock.now += 1_000;
  r.room.closeSilent(); // the Node host's timer; on Cloudflare the next socket event does the same
  assert.deepEqual(silent.closed, { code: 4002, reason: 'no_hello' });
  assert.deepEqual(silent.sent, []);
  assert.equal(ana.closed, null);

  // A late hello is too late.
  const late = r.connect();
  r.clock.now += 6_000;
  await late.message({ t: 'hello', role: 'player', token: tokens.Bruno });
  assert.equal(late.closed?.code, 4002);
  assert.deepEqual(late.sent, []);
});

test('a socket that floods messages is closed; normal use never is', async () => {
  const r = testRoom();
  const { key, tokens } = await r.setup();
  const dm = await r.join({ role: 'dm', key });
  const ana = await r.join({ role: 'player', token: tokens.Ana });
  // A busy evening, sped up: receipts every 2 s, pings, tab switches.
  for (let i = 0; i < 300; i++) {
    r.clock.now += 1_000;
    await ana.message(i % 2 ? { t: 'seen', ids: [] } : { t: 'state', visible: i % 4 === 0 });
  }
  assert.equal(ana.closed, null);

  const bruno = await r.join({ role: 'player', token: tokens.Bruno });
  const before = dm.all('presence').length;
  for (let i = 0; i < 100 && !bruno.closed; i++) await bruno.message({ t: 'state', visible: true });
  assert.deepEqual(bruno.closed, { code: 4003, reason: 'too_fast' });
  const presence = dm.all('presence').length;
  assert.ok(presence - before <= 20, `the DM got ${presence} presence updates`);
  await bruno.message({ t: 'state', visible: false });
  assert.equal(dm.all('presence').length, presence, 'nothing handled after closing');
});
