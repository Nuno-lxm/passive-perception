// @ts-check
// One Durable Object per room. It only adapts Cloudflare's storage and WebSockets to the core's interfaces;
// all room logic lives in src/core/room.js.
//
// WebSockets use the Hibernation API: between messages the object can be evicted from memory and isn't billed
// for duration. So no timers here, and per-connection state lives in the socket's attachment, not in fields.
import { DurableObject } from 'cloudflare:workers';
import { Room } from '../core/room.js';

export class RoomDO extends DurableObject {
  /** @param {DurableObjectState} ctx @param {any} env */
  constructor(ctx, env) {
    super(ctx, env);
    const storage = ctx.storage;
    /** @type {import('../core/store.js').Store} */
    const store = {
      sql: (query, ...bindings) => storage.sql.exec(query, ...bindings.map(toSqlValue)).toArray().map(fromSqlRow),
      tx: (fn) => storage.transactionSync(fn),
      now: () => Date.now(),
    };
    /** @type {import('../core/sockets.js').Sockets} */
    const sockets = {
      all: () => ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN).map((ws) => this.conn(ws)),
    };
    this.room = new Room(store, sockets, {
      expiryDays: env.ROOM_EXPIRY_DAYS === undefined ? 60 : Number(env.ROOM_EXPIRY_DAYS),
      setAlarm: (at) => void storage.setAlarm(at),
      destroy: async () => {
        await storage.deleteAlarm();
        await storage.deleteAll(); // the room's whole database, images included
      },
      // Usage stats for the admin page: one small request to the AdminDO, never awaited by the room.
      notify: (event) => {
        if (!env.ADMIN) return;
        const admins = env.DO_JURISDICTION ? env.ADMIN.jurisdiction(env.DO_JURISDICTION) : env.ADMIN;
        const sent = admins.get(admins.idFromName('admin'))
          .fetch(new Request('https://admin/event', { method: 'POST', body: JSON.stringify(event) }))
          .catch(() => {});
        ctx.waitUntil?.(sent);
      },
    });
    // Clients send "ping" every 25 s; Cloudflare answers "pong" without waking this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /** @param {Request} request */
  async fetch(request) {
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    return this.room.handle(request);
  }

  /** The expiry alarm set by the room (see Room.scheduleExpiry). */
  async alarm() {
    await this.room.onAlarm();
  }

  /** @param {WebSocket} ws @param {string | ArrayBuffer} message */
  async webSocketMessage(ws, message) {
    await this.room.onSocketMessage(this.conn(ws), message);
  }

  /** @param {WebSocket} ws @param {number} code @param {string} reason */
  async webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
    this.room.onSocketClose(this.conn(ws));
  }

  /** @param {WebSocket} ws */
  async webSocketError(ws) {
    this.room.onSocketClose(this.conn(ws));
  }

  /**
   * @param {WebSocket} ws
   * @returns {import('../core/sockets.js').Conn}
   */
  conn(ws) {
    return {
      send: (text) => ws.send(text),
      close: (code, reason) => ws.close(code, reason),
      meta: () => ws.deserializeAttachment() ?? null,
      setMeta: (meta) => ws.serializeAttachment(meta),
      lastPong: () => this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null,
    };
  }
}

/** Durable Object SQL takes blobs as ArrayBuffer. @param {unknown} value */
function toSqlValue(value) {
  if (value instanceof Uint8Array) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  return value;
}

/** …and returns them as ArrayBuffer; the core expects Uint8Array, like node:sqlite gives. @param {Record<string, any>} row */
function fromSqlRow(row) {
  for (const key in row) if (row[key] instanceof ArrayBuffer) row[key] = new Uint8Array(row[key]);
  return row;
}
