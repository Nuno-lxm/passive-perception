// @ts-check
// Self-hosted Tabletop Whisperer: serves public/ and /api/* from one Node process.
// Data: DATA_DIR/rooms/<CODE>.sqlite, one file per room. Port: PORT (default 8080).
import { createServer } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from '../core/api.js';
import { Room } from '../core/room.js';
import { openStore } from './adapter.js';
import { findAsset, readHeadersFile } from './static.js';

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../public');
const MAX_BODY = 2 * 1024 * 1024;

/**
 * @param {{ dataDir: string, port: number, host?: string }} options
 */
export function startServer({ dataDir, port, host = '0.0.0.0' }) {
  const roomsDir = join(dataDir, 'rooms');
  mkdirSync(roomsDir, { recursive: true });
  const securityHeaders = readHeadersFile(join(PUBLIC_DIR, '_headers'));

  /** @type {Map<string, Room>} */
  const rooms = new Map();

  /** @type {import('../core/api.js').Host} */
  const apiHost = {
    room(code, { create }) {
      let room = rooms.get(code);
      if (!room) {
        const file = join(roomsDir, `${code}.sqlite`);
        if (!create && !existsSync(file)) return null; // don't create files for codes people guess
        room = new Room(openStore(file));
        rooms.set(code, room);
      }
      const opened = room;
      return { fetch: (request) => opened.handle(request) };
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
        response = await handleApi(await toRequest(req, url), apiHost);
      } else if (url.pathname === '/config.js') {
        response = configScript(port);
      } else {
        const asset = await findAsset(PUBLIC_DIR, decodeURIComponent(url.pathname));
        const notFound = asset ? null : await findAsset(PUBLIC_DIR, '/404.html');
        response = asset
          ? new Response(new Uint8Array(asset.body), { headers: { 'content-type': asset.type } })
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

/** Replaces public/config.js: tells the client it runs self-hosted and where players can reach it. */
function configScript(/** @type {number} */ port) {
  const config = { mode: 'local', lanUrls: lanUrls(port) };
  return new Response(`export const config = ${JSON.stringify(config)};\n`, {
    headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8080);
  const dataDir = resolve(process.env.DATA_DIR ?? 'data');
  startServer({ dataDir, port });
  console.log(`Tabletop Whisperer on http://localhost:${port}  (data: ${dataDir})`);
  for (const url of lanUrls(port)) console.log(`  players on this network: ${url}`);
}
