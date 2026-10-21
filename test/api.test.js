import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleApi } from '../src/core/api.js';
import { formatRoomCode } from '../src/core/ids.js';
import { api, memoryHost, postJson } from './helpers.js';

test('create a room, then look it up with the code as people type it', async () => {
  const host = memoryHost();
  const created = await handleApi(postJson('/api/rooms', { name: 'Campaign', seats: ['Ana', 'Bruno'] }), host);
  assert.equal(created.status, 201);
  const { code, adminKey } = await created.json();
  assert.ok(adminKey);

  const typed = formatRoomCode(code).toLowerCase();
  const info = await handleApi(api(`/api/rooms/${typed}`), host);
  assert.equal(info.status, 200);
  assert.equal((await info.json()).name, 'Campaign');
});

test('unknown and malformed codes are 404 and create nothing', async () => {
  const host = memoryHost();
  for (const code of ['ZZZZZZ', 'nope', '..%2F..']) {
    const response = await handleApi(api(`/api/rooms/${code}`), host);
    assert.equal(response.status, 404);
  }
  assert.equal(host.rooms.size, 0);
});

test('a taken code is skipped and another one is tried', async () => {
  const host = memoryHost();
  const original = host.room;
  let calls = 0;
  host.room = (code, options) => {
    calls++;
    if (calls === 1) return { fetch: async () => new Response('{"error":"room_exists"}', { status: 409 }) };
    return original(code, options);
  };
  const response = await handleApi(postJson('/api/rooms', { name: 'A', seats: ['Ana'] }), host);
  assert.equal(response.status, 201);
  assert.equal(calls, 2);
});

test('requests from another site are refused', async () => {
  const request = new Request('http://localhost/api/rooms', {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'A', seats: ['Ana'] }),
  });
  const response = await handleApi(request, memoryHost());
  assert.equal(response.status, 403);
});

test('bad JSON and unknown routes', async () => {
  const host = memoryHost();
  const badJson = await handleApi(api('/api/rooms', { method: 'POST', body: '{nope' }), host);
  assert.deepEqual([badJson.status, await badJson.json()], [400, { error: 'bad_json' }]);
  assert.equal((await handleApi(api('/api/whatever'), host)).status, 404);
});
