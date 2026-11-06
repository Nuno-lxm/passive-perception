// End-to-end check against a running host, over real HTTP and WebSockets.
//   node test/smoke.js http://localhost:8787          (wrangler dev)
//   node test/smoke.js https://<staging>.workers.dev   (staging; creates a small test room and deletes it)
// test/server.test.js runs it against the Node host on every `pnpm test`.
import assert from 'node:assert/strict';

const SECRET = 'smoke-secret-' + Math.random().toString(36).slice(2);

/** A 1×1 PNG, small but real. */
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

/** @param {string} base */
export async function runSmoke(base) {
  const api = async (method, path, { auth, body, raw } = {}) => {
    const headers = {};
    if (auth) headers.authorization = `Bearer ${auth}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers,
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const type = response.headers.get('content-type') ?? '';
    return { status: response.status, data: type.includes('json') ? await response.json() : await response.arrayBuffer() };
  };

  // A Worker's address can take a few seconds to answer after its first deploy: wait for the health check.
  for (let attempt = 1; ; attempt++) {
    const health = await api('GET', '/health').catch(() => null);
    if (health?.status === 200 && health.data?.ok) break;
    if (attempt === 30) assert.fail(`${base}/api/health never answered ok (last status ${health?.status})`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  const created = await api('POST', '/rooms', { body: { name: 'Smoke test', seats: ['Ana', 'Bruno'] } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const { code, adminKey } = created.data;
  const { data: info } = await api('GET', `/rooms/${code}`);
  const seat = Object.fromEntries(info.seats.map((s) => [s.name, s.id]));
  const ana = (await api('POST', `/rooms/${code}/claim`, { body: { seatId: seat.Ana } })).data.token;
  const bruno = (await api('POST', `/rooms/${code}/claim`, { body: { seatId: seat.Bruno } })).data.token;
  assert.ok(ana && bruno, 'both seats claimed');

  const wsBase = base.replace(/^http/, 'ws');
  const anaWs = await socket(`${wsBase}/api/rooms/${code}/ws`, { t: 'hello', role: 'player', token: ana });
  const brunoWs = await socket(`${wsBase}/api/rooms/${code}/ws`, { t: 'hello', role: 'player', token: bruno });
  const dmWs = await socket(`${wsBase}/api/rooms/${code}/ws`, { t: 'hello', role: 'dm', key: adminKey });
  assert.equal(anaWs.first.t, 'welcome');
  assert.equal(dmWs.first.role, 'dm');

  const card = (await api('POST', `/rooms/${code}/cards`, { auth: adminKey, body: { title: SECRET, body: 'only Ana' } })).data.card;
  const uploaded = await api('POST', `/rooms/${code}/cards/${card.id}/images`, { auth: adminKey, raw: PNG });
  // A service at its storage cap refuses images on purpose. That's no reason to fail a deploy; the text checks still run.
  const storageFull = uploaded.data.error === 'storage_full';
  if (storageFull) console.warn('storage is at its cap: skipping the image checks');
  const image = uploaded.data.image;
  assert.ok(storageFull || image?.id, 'image uploaded');
  await api('POST', `/rooms/${code}/cards/${card.id}/reveal`, { auth: adminKey, body: { seats: [seat.Ana] } });

  const item = await anaWs.waitFor((m) => m.t === 'item' && m.item.id === card.id);
  assert.equal(item.fresh, true);
  if (image) {
    assert.equal(item.item.images[0].id, image.id);
    assert.equal((await api('GET', `/rooms/${code}/images/${image.id}`, { auth: ana })).status, 200);
    assert.equal((await api('GET', `/rooms/${code}/images/${image.id}`, { auth: bruno })).status, 404);
  }

  anaWs.send({ t: 'seen', ids: [card.id] });
  await dmWs.waitFor((m) => m.t === 'receipt' && m.receipt.seen);

  // Give any stray message time to arrive, then check Bruno got nothing about the card.
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const leak of [SECRET, card.id, ...(image ? [image.id] : [])]) assert.ok(!brunoWs.raw.join('\n').includes(leak), `Bruno received ${leak}`);
  const brunoAgain = await socket(`${wsBase}/api/rooms/${code}/ws`, { t: 'hello', role: 'player', token: bruno });
  assert.deepEqual(brunoAgain.first.feed, []);

  await api('POST', `/rooms/${code}/cards/${card.id}/unreveal`, { auth: adminKey, body: { seats: [seat.Ana] } });
  await anaWs.waitFor((m) => m.t === 'remove' && m.id === card.id);
  if (image) assert.equal((await api('GET', `/rooms/${code}/images/${image.id}`, { auth: ana })).status, 404);

  for (const s of [anaWs, brunoWs, dmWs, brunoAgain]) s.close();

  // Live hosts run this on every deploy, so leave nothing behind.
  assert.equal((await api('DELETE', `/rooms/${code}/room`, { auth: adminKey })).status, 200);
  assert.equal((await api('GET', `/rooms/${code}`)).status, 404);
  return { code };
}

/**
 * Opens a WebSocket, sends hello, and resolves with the first reply.
 * @param {string} url @param {object} hello
 */
function socket(url, hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    /** @type {any[]} */
    const messages = [];
    /** @type {string[]} */
    const raw = [];
    /** @type {{ test: (m: any) => boolean, resolve: (m: any) => void }[]} */
    let waiters = [];
    const timer = setTimeout(() => reject(new Error(`no reply on ${url}`)), 10_000);
    ws.onerror = () => reject(new Error(`socket error on ${url}`));
    ws.onopen = () => ws.send(JSON.stringify(hello));
    ws.onmessage = (event) => {
      raw.push(String(event.data));
      const message = event.data === 'pong' ? 'pong' : JSON.parse(String(event.data));
      messages.push(message);
      waiters = waiters.filter((w) => (w.test(message) ? (w.resolve(message), false) : true));
      if (messages.length === 1) {
        clearTimeout(timer);
        resolve({
          first: message,
          raw,
          send: (/** @type {object} */ m) => ws.send(JSON.stringify(m)),
          close: () => ws.close(),
          /** @param {(m: any) => boolean} test */
          waitFor: (test) =>
            new Promise((done, fail) => {
              const found = messages.find(test);
              if (found) return done(found);
              waiters.push({ test, resolve: done });
              setTimeout(() => fail(new Error('timed out waiting for a message')), 10_000);
            }),
        });
      }
    };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = (process.argv[2] ?? 'http://localhost:8080').replace(/\/+$/, '');
  runSmoke(base).then(
    ({ code }) => console.log(`smoke test passed on ${base} (room ${code})`),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
