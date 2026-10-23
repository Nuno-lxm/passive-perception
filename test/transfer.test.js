// Campaign export and import: everything the DM prepared and revealed survives; no secret leaves the room.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakePng, testRoom } from './helpers.js';
import { sha256 } from '../src/core/ids.js';

async function campaign() {
  const r = testRoom();
  const { key, seats, tokens } = await r.setup(['Ana', 'Bruno']);
  const map = (await r.call('POST', '/cards', { auth: key, body: { title: 'Torn map', body: 'A map.', grp: 'Items', note: 'after the fight', forSeats: [seats.Ana] } })).data.card;
  await r.call('POST', `/cards/${map.id}/images`, { auth: key, raw: fakePng(64, 48, 300) });
  const clue = (await r.call('POST', '/cards', { auth: key, body: { title: 'Cold draft' } })).data.card;
  await r.call('POST', `/cards/${map.id}/reveal`, { auth: key, body: { everyone: true } });
  await r.call('POST', `/cards/${clue.id}/reveal`, { auth: key, body: { seats: [seats.Bruno] } });
  await r.call('POST', `/seats/${seats.Ana}/link`, { auth: key });
  const exported = await r.call('GET', '/export', { auth: key });
  return { r, key, seats, tokens, exported };
}

test('export: one JSON file with seats, cards, images, notes and reveals, and no secrets', async () => {
  const { r, key, tokens, exported } = await campaign();
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-disposition') ?? '', /attachment; filename="campaign-\d{4}-\d{2}-\d{2}\.passive-perception\.json"/);
  const text = new TextDecoder().decode(exported.data);
  const file = JSON.parse(text);
  assert.equal(file.format, 'passive-perception');
  assert.deepEqual(file.seats.map((s) => s.name), ['Ana', 'Bruno']);
  assert.deepEqual(file.cards.map((c) => c.title), ['Torn map', 'Cold draft']);
  assert.equal(file.cards[0].note, 'after the fight');
  assert.equal(file.cards[0].images.length, 1);
  assert.notEqual(file.cards[0].publicAt, null);
  assert.equal(file.cards[1].grants.length, 1);

  const meta = r.room.meta();
  const secrets = [key, tokens.Ana, tokens.Bruno, meta.admin_hash, ...r.store.sql('SELECT token_hash, link_hash FROM seats').flatMap((s) => [s.token_hash, s.link_hash])];
  for (const secret of secrets.filter(Boolean)) assert.ok(!text.includes(secret), 'a secret is in the export');
  assert.ok(!/token|hash|adminKey|claim|receipt/i.test(text), 'no secret-looking fields');
  assert.equal((await r.call('GET', '/export', { auth: tokens.Ana })).status, 403, 'players cannot export');
});

/** Imports an export file into a new room the way the landing page does. */
async function importInto(file, { keepReveals }) {
  const target = testRoom();
  const created = await target.call('POST', '/create', { body: { code: 'NEW111', name: file.room.name, seats: file.seats.map((s) => s.name), import: true } });
  const key = created.data.adminKey;
  const info = (await target.call('GET', '/info')).data;
  const byName = new Map(info.seats.map((s) => [s.name, s.id]));
  const newSeat = new Map(file.seats.map((s) => [s.id, byName.get(s.name)]));
  const cards = file.cards.map((c) => ({
    ...c,
    forSeats: c.forSeats.map((id) => newSeat.get(id)).filter(Boolean),
    grants: keepReveals ? c.grants.map((g) => ({ ...g, seatId: newSeat.get(g.seatId) })) : [],
    publicAt: keepReveals ? c.publicAt : null,
  }));
  const batch = await target.call('POST', '/import', { auth: key, body: { cards, sessions: keepReveals ? file.sessions : [] } });
  assert.equal(batch.status, 200, JSON.stringify(batch.data));
  assert.equal((await target.call('POST', '/import/done', { auth: key })).status, 200);
  return { target, key, info, byName };
}

test('import, keeping who has what: same cards, images, notes, players and reveals', async () => {
  const { exported } = await campaign();
  const file = JSON.parse(new TextDecoder().decode(exported.data));
  const { target, key, byName } = await importInto(file, { keepReveals: true });
  const dm = await target.join({ role: 'dm', key });
  const cards = dm.last('welcome').cards;
  assert.deepEqual(cards.map((c) => c.title), ['Torn map', 'Cold draft']);
  assert.equal(cards[0].note, 'after the fight');
  assert.deepEqual(cards[0].forSeats, [byName.get('Ana')]);
  assert.notEqual(cards[0].publicAt, null);
  assert.deepEqual(Object.keys(cards[1].seats), [byName.get('Bruno')]);
  const image = await target.call('GET', `/images/${cards[0].images[0].id}`, { auth: key });
  assert.equal(image.data.length, 300);
  assert.equal(target.store.sql('SELECT count(*) AS n FROM claims')[0].n, 0);
  assert.equal(target.store.sql('SELECT count(*) AS n FROM seats WHERE token_hash IS NOT NULL OR link_hash IS NOT NULL')[0].n, 0, 'seats start unclaimed');
});

test('import, starting fresh: same prep, nothing revealed', async () => {
  const { exported } = await campaign();
  const file = JSON.parse(new TextDecoder().decode(exported.data));
  const { target, key } = await importInto(file, { keepReveals: false });
  const cards = (await target.join({ role: 'dm', key })).last('welcome').cards;
  assert.equal(cards.length, 2);
  assert.ok(cards.every((c) => c.publicAt == null && Object.keys(c.seats).length === 0));
});

test('import only works in a room made for it, within its first hour, and checks every image', async () => {
  const plain = testRoom();
  const { key } = await plain.setup(['Ana']);
  assert.deepEqual((await plain.call('POST', '/import', { auth: key, body: { cards: [] } })).data, { error: 'import_closed' });

  const fresh = testRoom();
  const made = await fresh.call('POST', '/create', { body: { code: 'NEW111', name: 'X', seats: ['Ana'], import: true } });
  const k = made.data.adminKey;
  const svg = btoa('<svg onload=alert(1)>'.padEnd(100));
  const bad = await fresh.call('POST', '/import', { auth: k, body: { cards: [{ title: 'A' }, { title: 'B', images: [{ data: svg }] }] } });
  assert.deepEqual(bad.data, { error: 'image_type' });
  assert.equal(fresh.store.sql('SELECT count(*) AS n FROM cards')[0].n, 0, 'the whole batch is rejected');

  await fresh.call('POST', '/import/done', { auth: k });
  assert.deepEqual((await fresh.call('POST', '/import', { auth: k, body: { cards: [{ title: 'A' }] } })).data, { error: 'import_closed' });

  const late = testRoom();
  const lateMade = await late.call('POST', '/create', { body: { code: 'NEW111', name: 'X', seats: ['Ana'], import: true } });
  late.clock.now += 61 * 60 * 1000;
  assert.deepEqual((await late.call('POST', '/import', { auth: lateMade.data.adminKey, body: { cards: [] } })).data, { error: 'import_closed' });
  void sha256;
});
