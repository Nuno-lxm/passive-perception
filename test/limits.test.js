// The limits that stop one person filling the free tier's storage: rooms per address and the service-wide image cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleApi } from '../src/core/api.js';
import { STORAGE_CAP, storageFull } from '../src/core/admin.js';
import { api, fakePng, memoryHost } from './helpers.js';

const TOKEN = 'operator-secret-token-123';
const HOUR = 60 * 60 * 1000;
const MIDNIGHT = Date.UTC(2030, 0, 1);

/** A host with the Cloudflare limits on, a clock for the admin store, and helpers to call it. */
function limited() {
  const host = memoryHost({ adminToken: TOKEN, storageCap: STORAGE_CAP, clientIp: true });
  const clock = { now: MIDNIGHT };
  host.adminStore.now = () => clock.now;
  const send = async (path, init = {}) => {
    const r = await handleApi(api(path, init), host);
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  const json = (method, path, body, auth) => send(path, {
    method, headers: { 'content-type': 'application/json', ...(auth && { authorization: `Bearer ${auth}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const create = (ip = '198.51.100.7', extra = {}) => send('/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-client-ip': ip },
    body: JSON.stringify({ name: 'Campaign', seats: ['Ana'], ...extra }),
  });
  /** Sets the tally, as a room's own event would, and waits out the minute it's kept for. */
  const setTally = async (bytes, code = 'BIG') => {
    await host.admin().fetch(new Request('https://admin/event', { method: 'POST', body: JSON.stringify({ type: 'bytes', code, bytes }) }));
    clock.now += 61 * 1000;
  };
  return { host, clock, send, json, create, setTally };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10)); // room events are fire-and-forget

test('one address can create 5 rooms an hour; other addresses are not affected', async () => {
  const { create, clock } = limited();
  for (let i = 0; i < 5; i++) assert.equal((await create()).status, 201);
  assert.deepEqual(await create(), { status: 429, data: { error: 'too_many_rooms' } });
  assert.equal((await create('203.0.113.9')).status, 201);
  clock.now += HOUR + 1;
  assert.equal((await create()).status, 201, 'an hour later');
});

test('one address can create 20 rooms a day, and the count starts again the next UTC day', async () => {
  const { create, clock } = limited();
  for (let hour = 0; hour < 4; hour++) {
    for (let i = 0; i < 5; i++) assert.equal((await create()).status, 201);
    clock.now += HOUR + 1;
  }
  assert.equal((await create()).data.error, 'too_many_rooms', '20 today, though none in the last hour');
  clock.now = MIDNIGHT + 24 * HOUR;
  assert.equal((await create()).status, 201);
});

test('addresses are never kept, and yesterday\'s hashes and salt are deleted', async () => {
  const { host, create, clock } = limited();
  const ip = '198.51.100.7';
  await create(ip);
  const before = host.adminStore.sql(`SELECT * FROM room_creations`);
  assert.equal(before.length, 1);
  assert.deepEqual(Object.keys(before[0]).sort(), ['at', 'ip_hash']);
  const salt = host.adminStore.sql(`SELECT value FROM meta WHERE key = 'ip_salt'`)[0].value;
  const everything = JSON.stringify([before, host.adminStore.sql(`SELECT * FROM meta`), host.adminStore.sql(`SELECT * FROM rooms`), host.adminStore.sql(`SELECT * FROM days`)]);
  assert.ok(!everything.includes(ip), 'the address is stored nowhere');

  clock.now = MIDNIGHT + 24 * HOUR;
  await create(ip);
  const after = host.adminStore.sql(`SELECT * FROM room_creations`);
  assert.equal(after.length, 1, 'only today\'s');
  assert.notEqual(after[0].ip_hash, before[0].ip_hash, 'the same address gets a hash that can\'t be linked to yesterday\'s');
  assert.notEqual(host.adminStore.sql(`SELECT value FROM meta WHERE key = 'ip_salt'`)[0].value, salt);
});

test('IPv6 counts per /64, however the address is written; IPv4 written as IPv6 stays separate', async () => {
  const { create } = limited();
  for (const ip of ['2001:db8:1:2::1', '2001:db8:1:2::2', '2001:DB8:1:2:aaaa:bbbb:cccc:dddd', '2001:0db8:0001:0002::3', '2001:db8:1:2:0:0:0:4']) {
    assert.equal((await create(ip)).status, 201, ip);
  }
  assert.equal((await create('2001:db8:1:2::ffff')).data.error, 'too_many_rooms', 'the same /64');
  assert.equal((await create('2001:db8:1:3::1')).status, 201, 'another /64');
  for (let i = 0; i < 5; i++) assert.equal((await create('::ffff:198.51.100.1')).status, 201);
  assert.equal((await create('::ffff:198.51.100.2')).status, 201, 'not lumped together with other IPv4 addresses');
});

test('a request that is refused anyway uses up nothing; hosts without clientIp have no such limit', async () => {
  const { host, send } = limited();
  const bad = await send('/api/rooms', { method: 'POST', headers: { 'x-client-ip': '198.51.100.7' }, body: '{nope' });
  assert.equal(bad.data.error, 'bad_json');
  assert.equal(host.adminStore.sql(`SELECT count(*) AS n FROM room_creations`)[0].n, 0);

  const node = memoryHost({ adminToken: TOKEN });
  for (let i = 0; i < 25; i++) {
    const r = await handleApi(api('/api/rooms', { method: 'POST', body: JSON.stringify({ name: 'A', seats: ['Ana'] }) }), node);
    assert.equal(r.status, 201);
  }
});

test('over the cap, images are refused and everything else keeps working', async () => {
  const { json, send, create, setTally } = limited();
  const { data: room } = await create();
  const base = `/api/rooms/${room.code}`;
  const auth = { authorization: `Bearer ${room.adminKey}` };
  const { data: { seats: [ana] } } = await send(base);
  const token = (await json('POST', `${base}/claim`, { seatId: ana.id })).data.token;
  const addCard = async (title) => (await json('POST', `${base}/cards`, { title }, room.adminKey)).data.card.id;
  const upload = (id) => send(`${base}/cards/${id}/images`, { method: 'POST', headers: auth, body: fakePng(10, 10, 500) });

  const withImage = await addCard('Map');
  assert.equal((await upload(withImage)).status, 201, 'under the cap');
  const plain = await addCard('Text');

  await setTally(STORAGE_CAP - 1_000_000); // the room's own bytes count too
  assert.equal((await upload(plain)).status, 201, 'just under the cap');

  await setTally(STORAGE_CAP);
  assert.deepEqual(await upload(plain), { status: 507, data: { error: 'storage_full' } });
  assert.equal((await json('POST', `${base}/cards/${withImage}/duplicate`, undefined, room.adminKey)).data.error, 'storage_full');

  const textOnly = await addCard('Still text');
  assert.equal((await json('POST', `${base}/cards/${textOnly}/duplicate`, undefined, room.adminKey)).status, 201);
  assert.equal((await json('PATCH', `${base}/cards/${textOnly}`, { title: 'Edited' }, room.adminKey)).status, 200);
  assert.equal((await json('POST', `${base}/cards/${textOnly}/reveal`, { seats: [ana.id] }, room.adminKey)).status, 200);
  const image = (await json('GET', `${base}/images/none`, undefined, token)).status;
  assert.equal(image, 404, 'reading still goes through the normal checks');
});

test('over the cap, a campaign imports without its images only if it has none', async () => {
  const { json, create, setTally } = limited();
  await setTally(STORAGE_CAP);
  const { data: room } = await create('198.51.100.7', { import: true });
  const base = `/api/rooms/${room.code}`;
  const data = Buffer.from(fakePng(10, 10, 300)).toString('base64');
  assert.equal((await json('POST', `${base}/import`, { cards: [{ title: 'Map', images: [{ data }] }] }, room.adminKey)).data.error, 'storage_full');
  assert.equal((await json('POST', `${base}/import`, { cards: [{ title: 'Text' }] }, room.adminKey)).status, 200);
});

test('only uploads the room would accept ask the admin store about the cap', async () => {
  const { host, json, send, create } = limited();
  const { data: room } = await create();
  const base = `/api/rooms/${room.code}`;
  const id = (await json('POST', `${base}/cards`, { title: 'x' }, room.adminKey)).data.card.id;
  await flush();
  let asked = 0;
  const stub = host.admin();
  const real = stub.fetch;
  stub.fetch = (request) => {
    if (new URL(request.url).pathname === '/storage') asked++;
    return real(request);
  };

  const post = (body, auth) => send(`${base}/cards/${id}/images`, {
    method: 'POST', headers: auth ? { authorization: `Bearer ${auth}` } : {}, body,
  });
  assert.equal((await post(fakePng(10, 10, 500))).status, 401, 'no key');
  assert.equal((await post(fakePng(10, 10, 500), 'wrong')).status, 401, 'wrong key');
  assert.equal((await post(new Uint8Array(500), room.adminKey)).data.error, 'image_type');
  assert.equal(asked, 0);
  assert.equal((await post(fakePng(10, 10, 500), room.adminKey)).status, 201);
  assert.equal(asked, 1);
});

test('the tally is summed at most once a minute, and deleting rooms frees space again', async () => {
  const { host, clock, json, send, create, setTally } = limited();
  const stub = host.admin();
  await setTally(100, 'ONE');
  assert.equal(await storageFull(stub, 100), true);
  await host.admin().fetch(new Request('https://admin/event', { method: 'POST', body: JSON.stringify({ type: 'bytes', code: 'ONE', bytes: 1 }) }));
  assert.equal(await storageFull(stub, 100), true, 'still the kept figure');
  clock.now += 61 * 1000;
  assert.equal(await storageFull(stub, 100), false, 'the new figure');

  await setTally(STORAGE_CAP, 'TWO');
  const { data: room } = await create();
  const id = (await json('POST', `/api/rooms/${room.code}/cards`, { title: 'x' }, room.adminKey)).data.card.id;
  const upload = () => send(`/api/rooms/${room.code}/cards/${id}/images`, {
    method: 'POST', headers: { authorization: `Bearer ${room.adminKey}` }, body: fakePng(10, 10, 500),
  });
  assert.equal((await upload()).status, 507);
  await host.admin().fetch(new Request('https://admin/event', { method: 'POST', body: JSON.stringify({ type: 'deleted', code: 'TWO' }) }));
  clock.now += 61 * 1000;
  assert.equal((await upload()).status, 201);
});

test('if the admin store cannot answer, uploads carry on and it is logged', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  assert.equal(await storageFull({ fetch: async () => { throw new Error('over the limit'); } }), false);
  assert.equal(await storageFull({ fetch: async () => new Response('not json', { status: 200 }) }), false);
  assert.equal(await storageFull({ fetch: async () => Response.json({ error: 'server_error' }, { status: 500 }) }), false);
  assert.equal(logged.mock.callCount(), 3);
});

test('the quota and storage routes of the admin store are not reachable from outside', async () => {
  const { send, json } = limited();
  assert.equal((await send('/api/storage')).status, 404);
  assert.equal((await send('/api/room-quota', { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await json('GET', '/api/admin/storage', undefined, TOKEN)).status, 404);
  assert.equal((await json('POST', '/api/admin/room-quota', { ip: 'x' }, TOKEN)).status, 404);
});
