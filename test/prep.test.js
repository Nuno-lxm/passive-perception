// Prep helpers: private notes, pre-picked players, bulk import, duplicate, reorder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakePng, testRoom } from './helpers.js';

test("the DM's note and pre-picked players never reach players", async () => {
  const r = testRoom();
  const { key, seats, tokens } = await r.setup(['Ana', 'Bruno']);
  const ana = await r.join({ role: 'player', token: tokens.Ana });
  const NOTE = 'only if they pass DC 15 Perception';
  const { data } = await r.call('POST', '/cards', { auth: key, body: { title: 'Clue', body: 'A draft.', note: NOTE, forSeats: [seats.Ana] } });
  assert.equal(data.card.note, NOTE);
  assert.deepEqual(data.card.forSeats, [seats.Ana]);

  await r.call('POST', `/cards/${data.card.id}/reveal`, { auth: key, body: { seats: [seats.Ana] } });
  await r.call('PATCH', `/cards/${data.card.id}`, { auth: key, body: { note: `${NOTE}!`, body: 'A cold draft.' } });
  const again = await r.join({ role: 'player', token: tokens.Ana });
  for (const conn of [ana, again]) {
    const raw = conn.raw.join('\n');
    assert.ok(!raw.includes('DC 15'), 'note leaked');
    assert.ok(!raw.includes('forSeats') && !raw.includes('for_seats'), 'pre-picked players leaked');
  }
  assert.equal(again.last('welcome').feed[0].body, 'A cold draft.');
});

test('changing only the note, players, group or order does not tell players anything', async () => {
  const r = testRoom();
  const { key, seats, tokens } = await r.setup(['Ana', 'Bruno']);
  const ana = await r.join({ role: 'player', token: tokens.Ana });
  const { data } = await r.call('POST', '/cards', { auth: key, body: { title: 'Clue' } });
  await r.call('POST', `/cards/${data.card.id}/reveal`, { auth: key, body: { seats: [seats.Ana] } });
  const before = ana.sent.length;
  await r.call('PATCH', `/cards/${data.card.id}`, { auth: key, body: { note: 'x', forSeats: [seats.Bruno], grp: 'G', sort: 99 } });
  assert.equal(ana.sent.length, before);
});

test('pre-picked players must be seats of this room; removed seats drop out', async () => {
  const r = testRoom();
  const { key, seats } = await r.setup(['Ana', 'Bruno']);
  const { data } = await r.call('POST', '/cards', { auth: key, body: { title: 'x', forSeats: [seats.Ana, 'not-a-seat', seats.Bruno] } });
  assert.deepEqual(data.card.forSeats, [seats.Ana, seats.Bruno]);
  await r.call('DELETE', `/seats/${seats.Bruno}`, { auth: key });
  const dm = await r.join({ role: 'dm', key });
  assert.deepEqual(dm.last('welcome').cards[0].forSeats, [seats.Ana]);
});

test('bulk import creates every card in order, or none if one is invalid', async () => {
  const r = testRoom();
  const { key, seats } = await r.setup(['Ana']);
  const dm = await r.join({ role: 'dm', key });
  const good = await r.call('POST', '/cards/bulk', {
    auth: key,
    body: { cards: [
      { title: 'One', grp: 'Manor', forSeats: [seats.Ana], note: 'n' },
      { title: 'Two', grp: 'Manor' },
      { title: 'Three', body: 'text' },
    ] },
  });
  assert.equal(good.status, 201);
  assert.equal(good.data.imported, 3);
  assert.deepEqual(dm.last('cards').cards.map((c) => c.title), ['One', 'Two', 'Three']);

  const bad = await r.call('POST', '/cards/bulk', { auth: key, body: { cards: [{ title: 'Four' }, { title: 'x'.repeat(121) }] } });
  assert.deepEqual(bad.data, { error: 'title_too_long' });
  assert.equal(r.store.sql('SELECT count(*) AS n FROM cards')[0].n, 3, 'nothing from the bad import');
  assert.deepEqual((await r.call('POST', '/cards/bulk', { auth: key, body: { cards: [] } })).data, { error: 'nothing_to_import' });
  const tooMany = Array.from({ length: 201 }, (_, i) => ({ title: `c${i}` }));
  assert.deepEqual((await r.call('POST', '/cards/bulk', { auth: key, body: { cards: tooMany } })).data, { error: 'too_many_to_import' });
});

test('duplicate copies text, note, players and images, right after the original, with nothing revealed', async () => {
  const r = testRoom();
  const { key, seats } = await r.setup(['Ana']);
  const first = (await r.call('POST', '/cards', { auth: key, body: { title: 'A', note: 'n', forSeats: [seats.Ana], grp: 'G' } })).data.card;
  const last = (await r.call('POST', '/cards', { auth: key, body: { title: 'B' } })).data.card;
  await r.call('POST', `/cards/${first.id}/images`, { auth: key, raw: fakePng() });
  await r.call('POST', `/cards/${first.id}/reveal`, { auth: key, body: { seats: [seats.Ana] } });

  const { status, data } = await r.call('POST', `/cards/${first.id}/duplicate`, { auth: key });
  assert.equal(status, 201);
  const copy = data.card;
  assert.notEqual(copy.id, first.id);
  assert.deepEqual([copy.title, copy.note, copy.grp, copy.forSeats], ['A', 'n', 'G', [seats.Ana]]);
  assert.equal(copy.images.length, 1);
  assert.notEqual(copy.images[0].id, (await r.join({ role: 'dm', key })).last('welcome').cards[0].images[0].id);
  assert.deepEqual(copy.seats, {}, 'not revealed to anyone');
  assert.ok(copy.sort > first.sort && copy.sort < last.sort, 'placed between the original and the next card');
});

test('reordering: sort can be set to any number between neighbours', async () => {
  const r = testRoom();
  const { key } = await r.setup(['Ana']);
  const ids = [];
  for (const title of ['A', 'B', 'C']) ids.push((await r.call('POST', '/cards', { auth: key, body: { title } })).data.card.id);
  const cards = () => r.store.sql('SELECT title FROM cards ORDER BY sort').map((c) => c.title).join('');
  await r.call('PATCH', `/cards/${ids[2]}`, { auth: key, body: { sort: 0.5 } });
  assert.equal(cards(), 'CAB');
  assert.deepEqual((await r.call('PATCH', `/cards/${ids[0]}`, { auth: key, body: { sort: 'top' } })).data, { error: 'bad_sort' });
});

test('rooms created before notes existed upgrade in place', async () => {
  const { openStore } = await import('../src/node/adapter.js');
  const { MIGRATIONS } = await import('../src/core/schema.js');
  const { Room } = await import('../src/core/room.js');
  const store = openStore(':memory:');
  for (const statement of MIGRATIONS[0]) store.sql(statement);
  store.sql(`INSERT INTO meta (key, value) VALUES ('schema_version', '1'), ('code', 'K7QF2M'), ('name', 'Old')`);
  store.sql(`INSERT INTO cards (id, title, sort, created_at, updated_at, content_at) VALUES ('c1', 'Old card', 1, 1, 1, 1)`);
  new Room(store);
  const [card] = store.sql(`SELECT note, for_seats FROM cards WHERE id = 'c1'`);
  assert.deepEqual({ ...card }, { note: '', for_seats: '[]' });
  assert.equal(store.sql(`SELECT value FROM meta WHERE key = 'schema_version'`)[0].value, String(MIGRATIONS.length));
});
