// The Node host end to end: static files with security headers, config.js, and the API on real files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { startServer } from '../src/node/server.js';
import { runSmoke } from './smoke.js';

test('Node host serves the app and the API', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'whisperer-'));
  const server = startServer({ dataDir, port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  t.after(() => {
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.match(await page.text(), /Passive Perception/);

  assert.equal((await fetch(`${base}/_headers`)).status, 404, '_ files are never served');
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);

  const config = await (await fetch(`${base}/config.js`)).text();
  assert.match(config, /"mode":"local"/);

  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.host, 'node');

  const created = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Campaign', seats: ['Ana'] }),
  });
  assert.equal(created.status, 201);
  const { code } = await created.json();
  assert.deepEqual(readdirSync(join(dataDir, 'rooms')).filter((f) => f.endsWith('.sqlite')), [`${code}.sqlite`]);

  const info = await fetch(`${base}/api/rooms/${code}`);
  assert.equal((await info.json()).seats[0].name, 'Ana');

  assert.equal((await fetch(`${base}/api/rooms/ZZZZZZ`)).status, 404);
  assert.equal(readdirSync(join(dataDir, 'rooms')).filter((f) => f.endsWith('.sqlite')).length, 1, 'no file for a guessed code');

  await runSmoke(base);

  // Deleting a room removes its file (and SQLite's side files) from disk.
  const made = await (await fetch(`${base}/api/rooms`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Gone', seats: ['Ana'] }),
  })).json();
  const del = await fetch(`${base}/api/rooms/${made.code}/room`, { method: 'DELETE', headers: { authorization: `Bearer ${made.adminKey}` } });
  assert.equal(del.status, 200);
  assert.ok(!readdirSync(join(dataDir, 'rooms')).some((f) => f.startsWith(made.code)), 'room files deleted');
  assert.equal((await fetch(`${base}/api/rooms/${made.code}`)).status, 404);
});

test('deleting a room with a player connected signs them out and leaves the server running', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'whisperer-'));
  const server = startServer({ dataDir, port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  t.after(() => {
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const post = async (path, body) => (await fetch(`${base}/api${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).json();

  const room = await post('/rooms', { name: 'Gone', seats: ['Ana'] });
  const { seats: [ana] } = await (await fetch(`${base}/api/rooms/${room.code}`)).json();
  const { token } = await post(`/rooms/${room.code}/claim`, { seatId: ana.id });
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/rooms/${room.code}/ws`);
  const messages = [];
  ws.onmessage = (event) => messages.push(JSON.parse(event.data));
  await new Promise((resolve) => { ws.onopen = resolve; });
  ws.send(JSON.stringify({ t: 'hello', role: 'player', token }));
  while (!messages.length) await new Promise((resolve) => setTimeout(resolve, 10));

  const closed = new Promise((resolve) => { ws.onclose = resolve; });
  const deleted = await fetch(`${base}/api/rooms/${room.code}/room`, { method: 'DELETE', headers: { authorization: `Bearer ${room.adminKey}` } });
  assert.equal(deleted.status, 200);
  await closed;
  await new Promise((resolve) => setTimeout(resolve, 50)); // the server's own close event comes around now
  assert.equal(messages.at(-1).reason, 'roomDeleted');
  assert.ok((await post('/rooms', { name: 'Still here', seats: ['Ana'] })).code, 'the server still answers');
});
