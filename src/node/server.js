// @ts-check
// Self-hosted Passive Perception: serves public/ and /api/* from one Node process.
// Data: DATA_DIR/rooms/<CODE>.sqlite, one file per room. Port: PORT (default 8080).
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { handleApi } from '../core/api.js';
import { normalizeRoomCode } from '../core/ids.js';
import { Room } from '../core/room.js';
import { Admin } from '../core/admin.js';
import { openStore } from './adapter.js';
import { findAsset, readHeadersFile } from './static.js';

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../public');
const MAX_BODY = 8 * 1024 * 1024; // import batches are a few MB of base64 images
const HEARTBEAT = 30 * 1000; // drop sockets whose phone vanished without closing them
const EXPIRY_SWEEP = 60 * 60 * 1000; // check for rooms unused for ROOM_EXPIRY_DAYS once an hour

/** Simple in-memory rate limits, per client IP: [requests, window in ms]. */
const RATE_LIMITS = { create: [5, 60 * 60 * 1000], join: [20, 60 * 1000], report: [10, 60 * 60 * 1000] };

/**
 * @param {{ dataDir: string, port: number, host?: string, expiryDays?: number, adminToken?: string }} options
 *   expiryDays: delete rooms unused this long (0 = keep forever). Default 60, like the hosted version.
 *   adminToken: turns on content reports and the /admin page (for a public self-hosted server).
 */
export function startServer({ dataDir, port, host = '0.0.0.0', expiryDays = 60, adminToken }) {
  const roomsDir = join(dataDir, 'rooms');
  mkdirSync(roomsDir, { recursive: true });
  const securityHeaders = readHeadersFile(join(PUBLIC_DIR, '_headers'));

  const admin = adminToken ? new Admin(openStore(join(dataDir, 'admin.sqlite'))) : null;

  /** @type {Map<string, { room: Room, conns: Set<import('../core/sockets.js').Conn> }>} */
  const rooms = new Map();

  /** The room for a code, opening its file. With create: false, unknown codes give null and create no file. */
  function openRoom(/** @type {string} */ code, /** @type {boolean} */ create) {
    let entry = rooms.get(code);
    if (!entry) {
      const file = join(roomsDir, `${code}.sqlite`);
      if (!create && !existsSync(file)) return null;
      /** @type {Set<import('../core/sockets.js').Conn>} */
      const conns = new Set();
      const store = openStore(file);
      const room = new Room(store, { all: () => [...conns] }, {
        expiryDays,
        notify: (event) => {
          admin?.handle(new Request('https://admin/event', { method: 'POST', body: JSON.stringify(event) })).catch(() => {});
        },
        // No per-room timers here: the hourly sweep below asks every room.
        destroy: () => {
          store.close();
          for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
          rooms.delete(code);
        },
      });
      entry = { room, conns };
      rooms.set(code, entry);
    }
    return entry;
  }

  /** @type {Map<string, { count: number, resetAt: number }>} */
  const counters = new Map();


  /** @type {import('../core/api.js').Host} */
  const apiHost = {
    admin: admin ? () => ({ fetch: (request) => admin.handle(request) }) : undefined,
    adminToken,
    room(code, { create }) {
      const entry = openRoom(code, create);
      return entry && { fetch: (request) => entry.room.handle(request) };
    },
    async allow(request, bucket) {
      const [limit, windowMs] = RATE_LIMITS[bucket];
      const key = `${bucket}:${request.headers.get('x-client-ip')}`;
      const now = Date.now();
      const counter = counters.get(key);
      if (!counter || counter.resetAt < now) {
        if (counters.size > 10_000) counters.clear();
        counters.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }
      return ++counter.count <= limit;
    },
    async health() {
      const probe = openStore(':memory:');
      const [row] = probe.sql('SELECT sqlite_version() AS version');
      probe.close();
      return { ok: true, host: 'node', sqlite: row.version, node: process.version };
    },
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      /** @type {Response} */
      let response;
      if (url.pathname.startsWith('/api/')) {
        const request = await toRequest(req, url);
        request.headers.set('x-client-ip', req.socket.remoteAddress ?? '');
        response = await handleApi(request, apiHost);
      } else if (url.pathname === '/config.js') {
        response = configScript(port, Boolean(adminToken));
      } else {
        const asset = await findAsset(PUBLIC_DIR, decodeURIComponent(url.pathname));
        const notFound = asset ? null : await findAsset(PUBLIC_DIR, '/404.html');
        // Same caching as public/_headers: always check scripts/styles/pages (no-cache), keep fonts for a year.
        const cache = url.pathname.startsWith('/fonts/') ? 'public, max-age=31536000, immutable' : 'no-cache';
        response = asset
          ? new Response(new Uint8Array(asset.body), { headers: { 'content-type': asset.type, 'cache-control': cache } })
          : new Response(notFound ? new Uint8Array(notFound.body) : 'Not found', {
              status: 404,
              headers: { 'content-type': notFound?.type ?? 'text/plain; charset=utf-8' },
            });
      }
      res.writeHead(response.status, { ...securityHeaders, ...Object.fromEntries(response.headers) });
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        res.writeHead(413, { 'content-type': 'application/json' }).end('{"error":"too_large"}');
        return;
      }
      console.error(error);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"server_error"}');
    }
  });

  // WebSockets: /api/rooms/<code>/ws. Same checks as the API: origin, room exists, rate limit.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const match = url.pathname.match(/^\/api\/rooms\/([^/]+)\/ws$/);
    const code = match && normalizeRoomCode(decodeURIComponent(match[1]));
    const origin = req.headers.origin;
    const reject = (/** @type {string} */ status) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    if (!code) return reject('404 Not Found');
    if (origin && origin !== url.origin) return reject('403 Forbidden');
    const limited = new Request(url, { headers: { 'x-client-ip': req.socket.remoteAddress ?? '' } });
    if (!(await apiHost.allow?.(limited, 'join'))) return reject('429 Too Many Requests');
    const entry = openRoom(code, false);
    if (!entry) return reject('404 Not Found');

    wss.handleUpgrade(req, socket, head, (ws) => {
      /** @type {import('../core/sockets.js').ConnMeta | null} */
      let meta = null;
      /** @type {number | null} */
      let lastPong = null;
      let alive = true;
      /** @type {import('../core/sockets.js').Conn} */
      const conn = {
        send: (text) => ws.send(text),
        close: (closeCode, reason) => ws.close(closeCode, reason),
        meta: () => meta,
        setMeta: (next) => { meta = next; },
        lastPong: () => lastPong,
        notePong: () => { lastPong = Date.now(); },
      };
      entry.conns.add(conn);
      ws.on('pong', () => { alive = true; });
      const heartbeat = setInterval(() => {
        if (!alive) return ws.terminate();
        alive = false;
        ws.ping();
      }, HEARTBEAT);
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        entry.room.onSocketMessage(conn, data.toString()).catch((error) => console.error(error));
      });
      ws.on('close', () => {
        clearInterval(heartbeat);
        entry.conns.delete(conn);
        entry.room.onSocketClose(conn);
      });
    });
  });

  // Expiry: ask every room whether it has gone unused for too long (rooms decide; see Room.onAlarm).
  const sweep = async () => {
    if (expiryDays <= 0) return;
    for (const file of readdirSync(roomsDir).filter((f) => f.endsWith('.sqlite'))) {
      const entry = openRoom(file.slice(0, -'.sqlite'.length), false);
      if (entry && !entry.conns.size) await entry.room.onAlarm().catch((error) => console.error(error));
    }
  };
  const sweeper = setInterval(sweep, EXPIRY_SWEEP);
  sweeper.unref();
  sweep();
  server.on('close', () => clearInterval(sweeper));

  server.listen(port, host);
  return server;
}

class BodyTooLarge extends Error {}

/**
 * Turns a Node request into a web standard Request, so the shared router can handle it.
 * @param {import('node:http').IncomingMessage} req @param {URL} url
 */
async function toRequest(req, url) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new BodyTooLarge();
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  }
  return new Request(url, { method: req.method, headers, body });
}

/** The LAN addresses players can reach this machine on, e.g. http://192.168.1.23:8080. */
export function lanUrls(/** @type {number} */ port) {
  return Object.values(networkInterfaces())
    .flat()
    .filter((net) => net && net.family === 'IPv4' && !net.internal)
    .map((net) => `http://${net?.address}:${port}`);
}

/**
 * Replaces public/config.js: tells the client it runs self-hosted and where players can reach it.
 * PUBLIC_URL overrides the detected addresses; inside Docker they are the container's, not the machine's.
 */
function configScript(/** @type {number} */ port, /** @type {boolean} */ reports) {
  const publicUrl = process.env.PUBLIC_URL?.replace(/\/+$/, '');
  const config = { mode: 'local', lanUrls: publicUrl ? [publicUrl] : lanUrls(port), reports };
  return new Response(`export const config = ${JSON.stringify(config)};\n`, {
    headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8080);
  const dataDir = resolve(process.env.DATA_DIR ?? 'data');
  const expiryDays = Number(process.env.ROOM_EXPIRY_DAYS ?? 60);
  startServer({ dataDir, port, expiryDays, adminToken: process.env.ADMIN_TOKEN || undefined });
  console.log(`Passive Perception on http://localhost:${port}  (data: ${dataDir})`);
  if (process.env.PUBLIC_URL) console.log(`  players join at: ${process.env.PUBLIC_URL}`);
  else if (existsSync('/.dockerenv')) {
    console.log('  In Docker: set PUBLIC_URL (e.g. http://192.168.1.23:8080) so the join QR code shows this machine\'s address.');
  } else for (const url of lanUrls(port)) console.log(`  players on this network: ${url}`);
}
