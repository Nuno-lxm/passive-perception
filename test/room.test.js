import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/core/room.js';
import { hasSchema, MIGRATIONS, migrate } from '../src/core/schema.js';
import { internal } from '../src/core/api.js';
import { sha256 } from '../src/core/ids.js';
import { openStore } from '../src/node/adapter.js';

const newRoom = () => {
  const store = openStore(':memory:');
  return { store, room: new Room(store) };
};
const create = (room, body) => room.handle(internal('POST', '/create', { code: 'K7QF2M', ...body }));

test('create stores the room, seats in order, and only a hash of the DM key', async () => {
  const { store, room } = newRoom();
  const response = await create(room, { name: '  The  Sunless Citadel ', seats: ['Ana', 'Bruno', 'Carla'] });
  assert.equal(response.status, 201);
  const { code, adminKey } = await response.json();
  assert.equal(code, 'K7QF2M');

  const meta = room.meta();
  assert.equal(meta.name, 'The Sunless Citadel');
  assert.equal(meta.admin_hash, await sha256(adminKey));
  assert.ok(!JSON.stringify(store.sql('SELECT * FROM meta')).includes(adminKey), 'raw key must not be stored');
  assert.deepEqual(store.sql('SELECT name FROM seats ORDER BY sort').map((s) => s.name), ['Ana', 'Bruno', 'Carla']);
});

test('a room can only be created once', async () => {
  const { room } = newRoom();
  assert.equal((await create(room, { name: 'A', seats: ['Ana'] })).status, 201);
  assert.equal((await create(room, { name: 'B', seats: ['Bruno'] })).status, 409);
});

test('info shows names and seat claims, never secrets', async () => {
  const { store, room } = newRoom();
  await create(room, { name: 'Campaign', seats: ['Ana', 'Bruno'] });
  store.sql(`UPDATE seats SET token_hash = 'secret-hash', link_hash = 'link-hash' WHERE name = 'Ana'`);

  const info = await (await room.handle(internal('GET', '/info'))).json();
  assert.deepEqual(Object.keys(info).sort(), ['code', 'joinLocked', 'name', 'seats']);
  assert.deepEqual(info.seats.map(({ name, claimed }) => ({ name, claimed })), [
    { name: 'Ana', claimed: true },
    { name: 'Bruno', claimed: false },
  ]);
  for (const seat of info.seats) assert.deepEqual(Object.keys(seat).sort(), ['claimed', 'id', 'name']);
  assert.ok(!JSON.stringify(info).includes('hash'));
});

test('looking up a room that does not exist writes nothing', async () => {
  const { store, room } = newRoom();
  assert.equal((await room.handle(internal('GET', '/info'))).status, 404);
  assert.equal((await room.handle(internal('GET', '/ping'))).status, 200);
  assert.equal(store.sql(`SELECT count(*) AS n FROM sqlite_master`)[0].n, 0);
});

test('invalid rooms are rejected with neutral error codes', async () => {
  const cases = [
    [{ name: '', seats: ['Ana'] }, 'room_name_required'],
    [{ name: 'x'.repeat(81), seats: ['Ana'] }, 'room_name_too_long'],
    [{ name: 'A', seats: [] }, 'seats_required'],
    [{ name: 'A', seats: ['  '] }, 'seats_required'],
    [{ name: 'A', seats: Array.from({ length: 13 }, (_, i) => `P${i}`) }, 'too_many_seats'],
    [{ name: 'A', seats: ['Ana', 'ana '] }, 'duplicate_seat_names'],
  ];
  for (const [body, error] of cases) {
    const { store, room } = newRoom();
    const response = await create(room, body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error });
    assert.equal(hasSchema(store), false, 'a rejected room leaves nothing behind');
  }
});

test('migrate is idempotent and records the schema version', () => {
  const store = openStore(':memory:');
  migrate(store);
  migrate(store);
  assert.equal(store.sql(`SELECT value FROM meta WHERE key = 'schema_version'`)[0].value, String(MIGRATIONS.length));
});

test('tx rolls back everything when it throws', () => {
  const store = openStore(':memory:');
  migrate(store);
  assert.throws(() =>
    store.tx(() => {
      store.sql(`INSERT INTO seats (id, name, sort) VALUES ('a', 'Ana', 0)`);
      throw new Error('boom');
    }),
  );
  assert.equal(store.sql('SELECT count(*) AS n FROM seats')[0].n, 0);
});
