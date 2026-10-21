// @ts-check
// Talking to the server: JSON API calls and the room's WebSocket, which reconnects by itself.

/**
 * @typedef {{ ok: boolean, status: number, data: any, error?: string }} ApiResult
 */

/**
 * @param {string} path  e.g. '/rooms/K7QF2M/cards'
 * @param {{ method?: string, auth?: string, body?: unknown, raw?: Blob }} [options]
 * @returns {Promise<ApiResult>}
 */
export async function api(path, { method = 'GET', auth, body, raw } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (auth) headers.authorization = `Bearer ${auth}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (raw) headers['content-type'] = raw.type || 'application/octet-stream';
  let response;
  try {
    response = await fetch(`/api${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  } catch {
    return { ok: false, status: 0, data: null, error: 'network' };
  }
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('json')) {
    // Cloudflare's own pages (e.g. error 1027, over the free daily limit) aren't JSON.
    const error = response.status === 429 || response.status >= 500 ? 'over_capacity' : 'generic';
    return { ok: response.ok, status: response.status, data: response.ok ? await response.blob() : null, error: response.ok ? undefined : error };
  }
  const data = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, data, error: response.ok ? undefined : data?.error ?? 'generic' };
}

/** An image the user may see, fetched with their token. Cached by id (ids never change). */
const imageUrls = new Map();

/**
 * @param {string} code @param {string} imageId @param {string} auth @param {boolean} thumb
 * @returns {Promise<string | null>}  An object URL for <img src>.
 */
export async function imageUrl(code, imageId, auth, thumb) {
  const key = `/img/${code}/${imageId}${thumb ? '/thumb' : ''}`;
  const known = imageUrls.get(key);
  if (known) return known;
  // Cache Storage only exists on HTTPS (not on a plain-http LAN); then images are re-fetched per visit.
  const cache = 'caches' in globalThis ? await caches.open('whisperer-images').catch(() => null) : null;
  let blob = cache ? await (await cache.match(key))?.blob() : null;
  if (!blob) {
    const result = await api(`/rooms/${code}/images/${imageId}${thumb ? '?thumb=1' : ''}`, { auth });
    if (!result.ok || !(result.data instanceof Blob)) return null;
    blob = result.data;
    await cache?.put(key, new Response(blob, { headers: { 'content-type': blob.type } })).catch(() => {});
  }
  const url = URL.createObjectURL(blob);
  imageUrls.set(key, url);
  return url;
}

/** Forgets cached images, e.g. after un-reveal or leaving a room. @param {string} code @param {string[]} [ids] */
export async function forgetImages(code, ids) {
  const cache = 'caches' in globalThis ? await caches.open('whisperer-images').catch(() => null) : null;
  for (const key of [...imageUrls.keys(), ...((await cache?.keys()) ?? []).map((r) => new URL(r.url).pathname)]) {
    if (!key.startsWith(`/img/${code}/`)) continue;
    if (ids && !ids.some((id) => key.startsWith(`/img/${code}/${id}`))) continue;
    const url = imageUrls.get(key);
    if (url) URL.revokeObjectURL(url);
    imageUrls.delete(key);
    await cache?.delete(key);
  }
}

const BACKOFF = [500, 1000, 2000, 5000, 10000];
const PING_EVERY = 25_000;
const PONG_TIMEOUT = 10_000;

/**
 * The room's live connection. Reconnects after drops, sleep, network changes; the server answers each hello
 * with a full snapshot, so nothing is missed.
 * @param {string} code
 * @param {() => object} hello  Called on every (re)connect, so it can use the latest token.
 * @param {{ onMessage: (message: any) => void, onStatus: (status: 'connecting' | 'open' | 'offline' | 'stopped') => void }} handlers
 */
export function connectRoom(code, hello, { onMessage, onStatus }) {
  /** @type {WebSocket | null} */
  let ws = null;
  let attempt = 0;
  let stopped = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let retryTimer;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let pongTimer;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let pingTimer;

  function open() {
    clearTimeout(retryTimer);
    if (stopped) return;
    onStatus('connecting');
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/rooms/${code}/ws`;
    const socket = new WebSocket(url);
    ws = socket;
    socket.onopen = () => {
      attempt = 0;
      socket.send(JSON.stringify({ t: 'hello', ...hello(), visible: document.visibilityState === 'visible' }));
      onStatus('open');
      clearInterval(pingTimer);
      pingTimer = setInterval(ping, PING_EVERY);
    };
    socket.onmessage = (event) => {
      if (event.data === 'pong') return clearTimeout(pongTimer);
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.t === 'signedOut') stopped = true;
      onMessage(message);
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      clearInterval(pingTimer);
      clearTimeout(pongTimer);
      ws = null;
      if (stopped) return onStatus('stopped');
      onStatus('offline');
      const delay = BACKOFF[Math.min(attempt++, BACKOFF.length - 1)];
      retryTimer = setTimeout(open, delay * (0.75 + Math.random() / 2));
    };
  }

  function ping() {
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send('ping');
    clearTimeout(pongTimer);
    pongTimer = setTimeout(() => ws?.close(), PONG_TIMEOUT); // silent socket: assume dead, reconnect
  }

  /** Coming back from sleep or the background: check the socket right away instead of waiting. */
  function wake() {
    if (stopped) return;
    if (ws?.readyState === WebSocket.OPEN) {
      ping();
      send({ t: 'state', visible: document.visibilityState === 'visible' });
    } else if (!ws || ws.readyState === WebSocket.CLOSED) {
      attempt = 0;
      open();
    }
  }

  /** @param {object} message */
  function send(message) {
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(message));
    return true;
  }

  const onVisibility = () => {
    if (document.visibilityState === 'visible') wake();
    else send({ t: 'state', visible: false });
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', wake);
  window.addEventListener('pageshow', wake);
  open();

  return {
    send,
    reconnect: () => {
      stopped = false;
      attempt = 0;
      ws?.close();
      if (!ws) open();
    },
    close() {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(pingTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', wake);
      window.removeEventListener('pageshow', wake);
      ws?.close();
    },
  };
}
