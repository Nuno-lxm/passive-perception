// @ts-check
// The WebSocket interface each host gives the core.
//   Cloudflare: hibernatable WebSockets; meta lives in serializeAttachment, lastPong in getWebSocketAutoResponseTimestamp.
//   Node:       `ws` sockets kept in memory.

/**
 * What the room remembers about a connection after its `hello`.
 * @typedef {{ role: 'player', seatId: string, visible: boolean }
 *   | { role: 'dm' }
 *   | { role: 'pending', claimId: string }} ConnMeta
 *
 * @typedef {object} Conn
 * @property {(text: string) => void} send
 * @property {(code?: number, reason?: string) => void} close
 * @property {() => ConnMeta | null} meta
 * @property {(meta: ConnMeta) => void} setMeta
 * @property {() => number | null} lastPong   When the last "ping" was answered, if known.
 * @property {() => void} [notePong]          Node only: Cloudflare answers pings without waking the room.
 *
 * @typedef {{ all(): Conn[] }} Sockets  The room's open connections.
 */

export {};
