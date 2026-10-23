// Content reports and the operator's tools. Reports reach only the operator; operator routes need ADMIN_TOKEN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleApi } from '../src/core/api.js';
import { api, memoryHost, postJson } from './helpers.js';

const TOKEN = 'operator-secret-token-123';

async function setup() {
  const host = memoryHost({ adminToken: TOKEN });
  const send = (path, init = {}) => handleApi(api(path, init), host).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
  const json = (method, path, body, auth) => send(path, {
    method, headers: { 'content-type': 'application/json', ...(auth && { authorization: `Bearer ${auth}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const { data: room } = await send('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Campaign', seats: ['Ana', 'Bruno'] }) });
  const { data: info } = await send(`/api/rooms/${room.code}`);
  const seat = Object.fromEntries(info.seats.map((s) => [s.name, s.id]));
  const ana = (await json('POST', `/api/rooms/${room.code}/claim`, { seatId: seat.Ana })).data.token;
  const bruno = (await json('POST', `/api/rooms/${room.code}/claim`, { seatId: seat.Bruno })).data.token;
  const card = (await json('POST', `/api/rooms/${room.code}/cards`, { title: 'Bad card', body: 'something awful' }, room.adminKey)).data.card;
  await json('POST', `/api/rooms/${room.code}/cards/${card.id}/reveal`, { seats: [seat.Ana] }, room.adminKey);
  return { host, send, json, room, seat, ana, bruno, card };
}

test('a player reports a card they received; the operator sees a snapshot, the DM is not involved', async () => {
  const { json, room, ana, card } = await setup();
  const sent = await json('POST', `/api/rooms/${room.code}/report`, { cardId: card.id, reason: 'abuse', note: 'not ok' }, ana);
  assert.equal(sent.status, 201);
  const { data } = await json('GET', '/api/admin/reports', undefined, TOKEN);
  const [report] = data.reports;
  assert.equal(report.kind, 'player');
  assert.equal(report.roomCode, room.code);
  assert.equal(report.reason, 'abuse');
  assert.equal(report.snapshot.title, 'Bad card');
  assert.equal(report.snapshot.body, 'something awful');
  assert.equal(report.snapshot.seat, 'Ana');
});

test("players can only report cards they actually received", async () => {
  const { json, room, bruno, card } = await setup();
  const sent = await json('POST', `/api/rooms/${room.code}/report`, { cardId: card.id, reason: 'illegal' }, bruno);
  assert.equal(sent.status, 404);
  assert.equal((await json('POST', `/api/rooms/${room.code}/report`, { cardId: card.id }, room.adminKey)).status, 403, 'not the DM either');
});

test('anyone can send the public form; an empty one is refused', async () => {
  const { json, room } = await setup();
  assert.equal((await json('POST', '/api/report', { roomCode: room.code.toLowerCase(), reason: 'child', note: 'see room', contact: 'me@example.org' })).status, 201);
  assert.deepEqual((await json('POST', '/api/report', { note: '   ' })).data, { error: 'report_empty' });
  const { data } = await json('GET', '/api/admin/reports', undefined, TOKEN);
  assert.equal(data.reports[0].roomCode, room.code);
  assert.equal(data.reports[0].contact, 'me@example.org');
});

test('admin routes need the token; operator paths cannot be reached through room routes', async () => {
  const { json, send, room } = await setup();
  assert.equal((await json('GET', '/api/admin/reports')).status, 401);
  assert.equal((await json('GET', '/api/admin/reports', undefined, 'wrong')).status, 401);
  assert.equal((await json('POST', `/api/admin/rooms/${room.code}/freeze`, { frozen: true }, room.adminKey)).status, 401, 'the DM key is not the admin token');
  for (const path of ['/admin/info', '/admin/freeze', '/admin/delete']) {
    const spoof = await send(`/api/rooms/${room.code}${path}`, {
      method: path === '/admin/info' ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-whisperer-admin': '1', authorization: `Bearer ${room.adminKey}` },
      body: path === '/admin/info' ? undefined : '{"frozen":true}',
    });
    assert.equal(spoof.status, 404, path);
  }
  assert.equal((await send(`/api/rooms/${room.code}`)).status, 200, 'room untouched');
});

test('freezing a room: the DM can look but not change; players see nothing; unfreezing restores it', async () => {
  const { json, host, room, ana, card } = await setup();
  assert.deepEqual((await json('POST', `/api/admin/rooms/${room.code}/freeze`, { frozen: true }, TOKEN)).data, { frozen: true });
  assert.deepEqual((await json('POST', `/api/rooms/${room.code}/cards`, { title: 'x' }, room.adminKey)).data, { error: 'room_frozen' });
  assert.deepEqual((await json('DELETE', `/api/rooms/${room.code}/room`, undefined, room.adminKey)).data, { error: 'room_frozen' });

  const roomObject = host.rooms.get(room.code);
  const sent = [];
  let meta = null;
  const conn = { send: (t) => sent.push(JSON.parse(t)), close() {}, meta: () => meta, setMeta: (m) => (meta = m), lastPong: () => null };
  await roomObject.onSocketMessage(conn, JSON.stringify({ t: 'hello', role: 'player', token: ana }));
  assert.equal(sent[0].frozen, true);
  assert.deepEqual(sent[0].feed, []);

  const info = await json('GET', `/api/admin/rooms/${room.code}/info`, undefined, TOKEN);
  assert.equal(info.data.frozen, true);
  assert.equal(info.data.cards, 1);

  await json('POST', `/api/admin/rooms/${room.code}/freeze`, { frozen: false }, TOKEN);
  assert.equal((await json('POST', `/api/rooms/${room.code}/cards`, { title: 'ok again' }, room.adminKey)).status, 201);
  void card;
});

test('the operator can delete a room and close reports; closed reports go after 90 days', async () => {
  const { json, send, room, ana, card } = await setup();
  await json('POST', `/api/rooms/${room.code}/report`, { cardId: card.id, reason: 'illegal' }, ana);
  assert.equal((await json('POST', `/api/admin/rooms/${room.code}/delete`, {}, TOKEN)).status, 200);
  assert.equal((await send(`/api/rooms/${room.code}`)).status, 404);

  const { data } = await json('GET', '/api/admin/reports', undefined, TOKEN);
  const id = data.reports[0].id;
  await json('POST', `/api/admin/reports/${id}/close`, {}, TOKEN);
  assert.equal((await json('GET', '/api/admin/reports', undefined, TOKEN)).data.reports[0].status, 'closed');
  assert.equal((await json('DELETE', `/api/admin/reports/${id}`, undefined, TOKEN)).status, 200);
  assert.deepEqual((await json('GET', '/api/admin/reports', undefined, TOKEN)).data.reports, []);
});

test('without an admin token there is no reporting and no admin API', async () => {
  const host = memoryHost();
  const r = await handleApi(postJson('/api/report', { note: 'x' }), host);
  assert.equal(r.status, 404);
  assert.equal((await handleApi(api('/api/admin/reports'), host)).status, 404);
});

test('stats: rooms, joins, reveals, storage and open reports, with nothing personal', async () => {
  const { json, send, room, card, ana } = await setup();
  await new Promise((resolve) => setTimeout(resolve, 20)); // notifications are fire-and-forget
  const { status, data } = await json('GET', '/api/admin/stats', undefined, TOKEN);
  assert.equal(status, 200);
  assert.equal(data.rooms.total, 1);
  assert.equal(data.rooms.activeWeek, 1);
  const today = data.days.at(-1);
  assert.equal(data.days.length, 30);
  assert.deepEqual([today.roomsCreated, today.joins, today.reveals], [1, 2, 1]);
  assert.equal(data.storage.limit, 5_000_000_000);
  assert.equal(data.reports.open, 0);
  const text = JSON.stringify(data);
  for (const leak of ['Ana', 'Bad card', ana, room.adminKey]) assert.ok(!text.includes(leak), `stats contain ${leak}`);

  await json('POST', `/api/rooms/${room.code}/report`, { cardId: card.id, reason: 'other' }, ana);
  await send(`/api/rooms/${room.code}/room`, { method: 'DELETE', headers: { authorization: `Bearer ${room.adminKey}` } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const after = (await json('GET', '/api/admin/stats', undefined, TOKEN)).data;
  assert.equal(after.rooms.total, 0, 'deleted rooms leave the registry');
  assert.equal(after.reports.open, 1);
  assert.equal((await json('GET', '/api/admin/stats')).status, 401);
});

test('bug reports: from players or the public form, with a description', async () => {
  const { json, room } = await setup();
  assert.equal((await json('POST', '/api/report', { reason: 'bug', roomCode: room.code, note: 'The QR code does not scan on my iPad' })).status, 201);
  assert.deepEqual((await json('POST', '/api/report', { reason: 'bug', note: '' })).data, { error: 'report_empty' });
  const { data } = await json('GET', '/api/admin/reports', undefined, TOKEN);
  assert.equal(data.reports[0].reason, 'bug');
  assert.equal(data.reports[0].roomCode, room.code);
});
