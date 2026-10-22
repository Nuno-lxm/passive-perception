// Rooms delete themselves after 60 days without use, and the DM can delete one at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/core/room.js';
import { openStore } from '../src/node/adapter.js';
import { internal } from '../src/core/api.js';
import { testRoom } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;

function alarmedRoom() {
  const store = openStore(':memory:');
  const clock = { now: 1_800_000_000_000 };
  store.now = () => clock.now;
  const alarms = [];
  const room = new Room(store, undefined, { setAlarm: (at) => alarms.push(at) });
  return { store, clock, alarms, room };
}

test('creating a room schedules its expiry 60 days out; using it pushes the date back', async () => {
  const { clock, alarms, room } = alarmedRoom();
  await room.handle(internal('POST', '/create', { code: 'K7QF2M', name: 'C', seats: ['Ana'] }));
  assert.deepEqual(alarms, [clock.now + 60 * DAY]);

  clock.now += 10 * DAY;
  room.touch();
  assert.equal(alarms.at(-1), clock.now + 60 * DAY);
  const before = alarms.length;
  room.touch(); // within the hour: no extra write
  assert.equal(alarms.length, before);
});

test('the alarm deletes an unused room, but not one used since the alarm was set', async () => {
  const { store, clock, alarms, room } = alarmedRoom();
  await room.handle(internal('POST', '/create', { code: 'K7QF2M', name: 'C', seats: ['Ana'] }));

  clock.now += 30 * DAY;
  room.touch();
  clock.now += 31 * DAY; // the first alarm time has passed, but the room was used 31 days ago
  assert.equal(await room.onAlarm(), false);
  assert.equal(alarms.at(-1), clock.now - 31 * DAY + 60 * DAY, 'rescheduled');

  clock.now += 30 * DAY;
  assert.equal(await room.onAlarm(), true);
  assert.equal(store.sql(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'`)[0].n, 0, 'everything gone');
  assert.equal((await room.handle(internal('GET', '/info'))).status, 404);
});

test('expiryDays 0 keeps rooms forever', async () => {
  const store = openStore(':memory:');
  const alarms = [];
  const room = new Room(store, undefined, { expiryDays: 0, setAlarm: (at) => alarms.push(at) });
  await room.handle(internal('POST', '/create', { code: 'K7QF2M', name: 'C', seats: ['Ana'] }));
  assert.deepEqual(alarms, []);
  assert.equal(await room.onAlarm(), false);
});

test('the DM can delete the room now; connected devices are told; players cannot do it', async () => {
  const r = testRoom();
  const { key, tokens } = await r.setup(['Ana']);
  const ana = await r.join({ role: 'player', token: tokens.Ana });
  const dm = await r.join({ role: 'dm', key });
  assert.equal((await r.call('DELETE', '/room', { auth: tokens.Ana })).status, 403);

  const deleted = await r.call('DELETE', '/room', { auth: key });
  assert.equal(deleted.status, 200);
  assert.equal(ana.last('signedOut').reason, 'roomDeleted');
  assert.equal(dm.last('signedOut').reason, 'roomDeleted');
  assert.equal((await r.call('GET', '/info')).status, 404);

  const late = await r.join({ role: 'player', token: tokens.Ana });
  assert.equal(late.last('signedOut').reason, 'roomDeleted');
});

test('the DM sees when the room would expire', async () => {
  const r = testRoom();
  const { key } = await r.setup(['Ana']);
  const dm = await r.join({ role: 'dm', key });
  const { room } = dm.last('welcome');
  assert.equal(room.expiryDays, 60);
  assert.equal(room.expiresAt, room.lastActiveAt + 60 * DAY);
});
