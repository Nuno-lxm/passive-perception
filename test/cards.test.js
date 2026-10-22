import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakePng, testRoom } from './helpers.js';
import { sniffImage } from '../src/core/images.js';

const HOUR = 60 * 60 * 1000;

test('receipts: delivered, then seen, then 👍, each told to the DM once', async () => {
  const r = testRoom();
  const { key, seats, tokens } = await r.setup();
  const dm = await r.join({ role: 'dm', key });
  const ana = await r.join({ role: 'player', token: tokens.Ana });
  const { data } = await r.call('POST', '/cards', { auth: key, body: { title: 'Clue' } });
  await r.call('POST', `/cards/${data.card.id}/reveal`, { auth: key, body: { seats: [seats.Ana] } });

  await ana.message({ t: 'got', ids: [data.card.id] });
  await ana.message({ t: 'got', ids: [data.card.id] });
  await ana.message({ t: 'seen', ids: [data.card.id] });
  await ana.message({ t: 'ack', id: data.card.id });
  assert.deepEqual(dm.all('receipt').map((m) => m.receipt), [
    { delivered: true, seen: false, acked: false },
    { delivered: true, seen: true, acked: false },
    { delivered: true, seen: true, acked: true },
  ]);
  assert.equal(ana.last('item').item.acked, true);

  const dmAgain = await r.join({ role: 'dm', key });
  assert.deepEqual(dmAgain.last('welcome').cards[0].seats[seats.Ana], { revealedAt: r.clock.now, delivered: true, seen: true, acked: true });
});

test('sessions: reveals within 6 hours share a session, a longer gap starts the next one', async () => {
  const r = testRoom();
  const { key, seats, tokens } = await r.setup();
  const reveal = async () => {
    const { data } = await r.call('POST', '/cards', { auth: key, body: { title: 't' } });
    await r.call('POST', `/cards/${data.card.id}/reveal`, { auth: key, body: { seats: [seats.Ana] } });
  };
  await reveal();
  r.clock.now += 3 * HOUR;
  await reveal();
  r.clock.now += 7 * 24 * HOUR;
  await reveal();
  const ana = await r.join({ role: 'player', token: tokens.Ana });
  const { feed, sessions } = ana.last('welcome');
  assert.deepEqual(feed.map((i) => i.session), [2, 1, 1], 'newest first');
  assert.equal(sessions.length, 2);
});

test('revealing to more players later adds them to the same card', async () => {
  const r = testRoom();
  const { key, seats, tokens } = await r.setup(['Ana', 'Bruno', 'Carla']);
  const ana = await r.join({ role: 'player', token: tokens.Ana });
  const { data } = await r.call('POST', '/cards', { auth: key, body: { title: 'Rune' } });
  await r.call('POST', `/cards/${data.card.id}/reveal`, { auth: key, body: { seats: [seats.Ana] } });
  const firstAt = ana.last('item').item.at;
  r.clock.now += 60_000;
  const { data: after } = await r.call('POST', `/cards/${data.card.id}/reveal`, { auth: key, body: { seats: [seats.Ana, seats.Bruno] } });
  assert.deepEqual(Object.keys(after.card.seats).sort(), [seats.Ana, seats.Bruno].sort());
  assert.equal(after.card.seats[seats.Ana].revealedAt, firstAt, "Ana's reveal time doesn't move");
  assert.equal(r.store.sql('SELECT count(*) AS n FROM cards')[0].n, 1);
});

test('card input is cleaned and limited', async () => {
  const r = testRoom();
  const { key } = await r.setup();
  const { data } = await r.call('POST', '/cards', { auth: key, body: { title: '  A   title ', body: 'line 1\r\nline 2\n\n\n\n\nend  ', grp: ' ' } });
  assert.equal(data.card.title, 'A title');
  assert.equal(data.card.body, 'line 1\nline 2\n\n\nend');
  assert.equal(data.card.grp, null);
  assert.deepEqual((await r.call('POST', '/cards', { auth: key, body: { body: 'x'.repeat(4001) } })).data, { error: 'body_too_long' });
  assert.deepEqual((await r.call('POST', `/cards/${data.card.id}/reveal`, { auth: key, body: { seats: ['nope'] } })).data, { error: 'no_recipients' });
});

test('images: type sniffed from bytes, size and count limits, thumbnails served on request', async () => {
  const r = testRoom();
  const { key } = await r.setup();
  const card = (await r.call('POST', '/cards', { auth: key, body: { title: 'Map' } })).data.card;
  const upload = (raw) => r.call('POST', `/cards/${card.id}/images`, { auth: key, raw, contentType: 'image/png' });

  assert.deepEqual((await upload(new TextEncoder().encode('<svg onload="alert(1)">'.padEnd(100)))).data, { error: 'image_type' });
  assert.deepEqual((await upload(fakePng(5000, 10))).data, { error: 'image_dimensions' });
  assert.deepEqual((await upload(fakePng(10, 10, 1_500_001))).data, { error: 'image_too_large' });

  const first = await upload(fakePng(800, 600));
  assert.deepEqual(first.data.image.w, 800);
  for (let i = 0; i < 3; i++) await upload(fakePng());
  assert.deepEqual((await upload(fakePng())).data, { error: 'too_many_images' });

  const thumb = fakePng(80, 60, 50);
  assert.equal((await r.call('PUT', `/images/${first.data.image.id}/thumb`, { auth: key, raw: thumb })).status, 200);
  const served = await r.call('GET', `/images/${first.data.image.id}?thumb=1`, { auth: key });
  assert.equal(served.data.length, 50);
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');

  await r.call('DELETE', `/images/${first.data.image.id}`, { auth: key });
  assert.equal(r.store.sql('SELECT count(*) AS n FROM images')[0].n, 3);
});

test('images: per-room storage cap and hourly upload limit', async () => {
  const r = testRoom();
  const { key } = await r.setup();
  const card = async () => (await r.call('POST', '/cards', { auth: key, body: {} })).data.card.id;
  const big = fakePng(10, 10, 1_400_000);
  let error;
  for (let i = 0; i < 40 && !error; i++) {
    const id = await card();
    for (let j = 0; j < 4 && !error; j++) {
      r.clock.now += 2 * HOUR; // stay under the hourly limit
      const res = await r.call('POST', `/cards/${id}/images`, { auth: key, raw: big });
      if (res.status !== 201) error = res.data.error;
    }
  }
  assert.equal(error, 'room_storage_full');

  const r2 = testRoom();
  const { key: key2 } = await r2.setup();
  let limited;
  for (let i = 0; i < 20 && !limited; i++) {
    const id = (await r2.call('POST', '/cards', { auth: key2, body: {} })).data.card.id;
    for (let j = 0; j < 4; j++) {
      const res = await r2.call('POST', `/cards/${id}/images`, { auth: key2, raw: fakePng() });
      if (res.status === 429) limited = res.data.error;
    }
  }
  assert.equal(limited, 'too_many_uploads');
});

test('sniffImage reads JPEG and WebP sizes', () => {
  const jpeg = new Uint8Array(40);
  // SOI, an APP0 segment of length 6, then SOF0 with height 300, width 400
  jpeg.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x06, 0, 0, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90]);
  assert.deepEqual(sniffImage(jpeg), { mime: 'image/jpeg', w: 400, h: 300 });

  const webp = new Uint8Array(40);
  webp.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
  webp.set([...'WEBPVP8X'].map((c) => c.charCodeAt(0)), 8);
  webp.set([0x1f, 0x03, 0x00, 0xdf, 0x01, 0x00], 24); // 800 x 480
  assert.deepEqual(sniffImage(webp), { mime: 'image/webp', w: 800, h: 480 });
});

test('presence: online, away when hidden or silent, offline when gone', async () => {
  const r = testRoom();
  const { key, seats, tokens } = await r.setup(['Ana', 'Bruno', 'Carla']);
  r.store.sql(`UPDATE seats SET token_hash = NULL WHERE id = ?`, seats.Carla);
  const dm = await r.join({ role: 'dm', key });
  const ana = await r.join({ role: 'player', token: tokens.Ana });
  const status = () => Object.fromEntries(dm.last('presence').seats.map((s) => [s.id, s.status]));

  assert.deepEqual(status(), { [seats.Ana]: 'online', [seats.Bruno]: 'offline', [seats.Carla]: 'unclaimed' });
  await ana.message({ t: 'state', visible: false });
  assert.equal(status()[seats.Ana], 'away');
  await ana.message({ t: 'state', visible: true });
  await ana.message('ping');
  assert.equal(ana.sent.at(-1), 'pong');
  r.clock.now += 60_000;
  await dm.message({ t: 'presence' });
  assert.equal(status()[seats.Ana], 'away', 'no ping for 60 s');
  ana.close(1000, 'bye');
  assert.equal(status()[seats.Ana], 'offline');
});
