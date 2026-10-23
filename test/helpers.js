// Shared test setup: rooms on in-memory node:sqlite, the same engine family as the Durable Objects.
import { Room } from '../src/core/room.js';
import { Admin } from '../src/core/admin.js';
import { openStore } from '../src/node/adapter.js';

/** A Host for the API router that keeps every room in memory. Pass an adminToken to turn on reports. */
export function memoryHost({ adminToken } = {}) {
  const rooms = new Map();
  const admin = adminToken ? new Admin(openStore(':memory:')) : null;
  return {
    rooms,
    adminToken,
    admin: admin ? () => ({ fetch: (request) => admin.handle(request) }) : undefined,
    room(code, { create }) {
      if (!rooms.has(code)) {
        if (!create) return null;
        const notify = admin ? (event) => admin.handle(new Request('https://admin/event', { method: 'POST', body: JSON.stringify(event) })) : undefined;
        rooms.set(code, new Room(openStore(':memory:'), undefined, { notify }));
      }
      return { fetch: (request) => rooms.get(code).handle(request) };
    },
    async health() {
      return { ok: true, host: 'test' };
    },
  };
}

export const api = (path, init) => new Request(`http://localhost${path}`, init);

export const postJson = (path, body) =>
  api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/**
 * A room with a fake clock and fake sockets, plus helpers to act as the DM or a player.
 * Every message a connection receives is kept in conn.sent (parsed JSON), and conn.raw (exact text).
 */
export function testRoom() {
  const store = openStore(':memory:');
  const clock = { now: 1_800_000_000_000 };
  store.now = () => clock.now;
  const open = new Set();
  const room = new Room(store, { all: () => [...open] });

  /** Calls the room as the API router would. */
  async function call(method, path, { auth, body, raw, contentType } = {}) {
    const headers = {};
    if (auth) headers.authorization = `Bearer ${auth}`;
    if (contentType) headers['content-type'] = contentType;
    const response = await room.handle(
      new Request(`https://room${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }),
    );
    const type = response.headers.get('content-type') ?? '';
    const download = (response.headers.get('content-disposition') ?? '').startsWith('attachment');
    const data = type.startsWith('application/json') && !download ? await response.json() : new Uint8Array(await response.arrayBuffer());
    return { status: response.status, data, headers: response.headers };
  }

  /** Opens a fake WebSocket. */
  function connect() {
    let meta = null;
    const conn = {
      sent: [],
      raw: [],
      closed: null,
      pong: null,
      send(text) {
        conn.raw.push(text);
        conn.sent.push(text === 'pong' ? text : JSON.parse(text));
      },
      close(code, reason) {
        conn.closed = { code, reason };
        open.delete(conn);
        room.onSocketClose(conn);
      },
      meta: () => meta,
      setMeta(next) {
        meta = next;
      },
      lastPong: () => conn.pong,
      notePong() {
        conn.pong = clock.now;
      },
      message: (obj) => room.onSocketMessage(conn, typeof obj === 'string' ? obj : JSON.stringify(obj)),
      last: (t) => conn.sent.filter((m) => m.t === t).at(-1),
      all: (t) => conn.sent.filter((m) => m.t === t),
    };
    open.add(conn);
    return conn;
  }

  /** Creates a room with the given seats and claims each one. Returns keys, tokens and seat ids by name. */
  async function setup(seatNames = ['Ana', 'Bruno']) {
    const created = await call('POST', '/create', { body: { code: 'K7QF2M', name: 'Campaign', seats: seatNames } });
    const key = created.data.adminKey;
    const { data: info } = await call('GET', '/info');
    const seats = {};
    const tokens = {};
    for (const seat of info.seats) {
      seats[seat.name] = seat.id;
      const claimed = await call('POST', '/claim', { body: { seatId: seat.id } });
      tokens[seat.name] = claimed.data.token;
    }
    return { key, seats, tokens };
  }

  /** Connects and says hello. */
  async function join(hello) {
    const conn = connect();
    await conn.message({ t: 'hello', ...hello });
    return conn;
  }

  return { store, room, clock, call, connect, setup, join, open };
}

/** A minimal valid PNG header of the given size (enough for the server's checks). */
export function fakePng(w = 64, h = 48, padTo = 100) {
  const bytes = new Uint8Array(padTo);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, w);
  new DataView(bytes.buffer).setUint32(20, h);
  return bytes;
}
