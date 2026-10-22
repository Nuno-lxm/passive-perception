// @ts-check
// The player's page: join a room, then a feed of everything the DM revealed to you, newest first.
import { errorText, formatDate, formatWhen, LANGUAGES, lang, setLanguage, t, translatePage } from './i18n.js';
import { api, connectRoom, forgetImages, imageUrl } from './net.js';
import { formatRoomCode, normalizeRoomCode } from './room-code.js';
import * as storage from './storage.js';
import { $, closeButton, h, icon, openDialog, screenWakeLock, snackbar, themeField } from './ui.js';
import { openViewer } from './viewer.js';

const app = $('#app');
const wake = screenWakeLock();

/** @type {string | null} */
let code = null;
/** @type {ReturnType<typeof connectRoom> | null} */
let socket = null;

async function start() {
  const query = new URLSearchParams(location.search);
  const fragment = new URLSearchParams(location.hash.slice(1));
  code = normalizeRoomCode(fragment.get('r') ?? query.get('r'));
  const linkSecret = fragment.get('s');
  if (location.hash) history.replaceState(null, '', code ? `/play?r=${code}` : '/play'); // never leave secrets in the address bar

  if (code && linkSecret) return redeemLink(code, linkSecret);
  if (!code) return showCodeEntry();
  if (storage.seats()[code]) {
    // The room may have been deleted (by the DM, or after a long time unused) since this phone was last here.
    if ((await api(`/rooms/${code}`)).status === 404) return roomGone(code);
    return showFeed();
  }
  return showSeatPicker();
}

/** @param {string} roomCode */
async function roomGone(roomCode) {
  await forgetLocal(roomCode);
  wake.set(false);
  screen(formatRoomCode(roomCode), h('p', null, t('signedOut.roomDeleted')), h('a.button', { href: '/play' }, t('join.otherCode')));
}

/** @param {string} title @param {...(Node | string | null | false)} content */
function screen(title, ...content) {
  socket?.close();
  socket = null;
  app.replaceChildren(h('section.screen', null, h('h1', null, title), ...content));
}

// ---------- Joining

function showCodeEntry() {
  const input = /** @type {HTMLInputElement} */ (h('input.code-input', {
    id: 'code', name: 'code', autocomplete: 'off', autocapitalize: 'characters', spellcheck: false,
    maxlength: 7, placeholder: 'K7Q-F2M', required: true, 'aria-label': t('join.code'),
  }));
  const error = h('p.error', { role: 'alert' });
  const form = h('form.stack', {
    onsubmit: (/** @type {Event} */ event) => {
      event.preventDefault();
      const typed = normalizeRoomCode(input.value);
      if (!typed) return (error.textContent = t('join.badCode'));
      location.href = `/play?r=${typed}`;
    },
  }, h('label', { for: 'code' }, t('join.code')), input, error, h('button.primary', { type: 'submit' }, t('join.continue')));

  const saved = Object.entries(storage.seats());
  screen(t('join.title'), form, saved.length > 0 && h('div.stack',
    null,
    h('h2', null, t('join.yourRooms')),
    ...saved.map(([roomCode, seat]) =>
      h('a.button', { href: `/play?r=${roomCode}` }, `${seat.roomName ?? formatRoomCode(roomCode)} · ${seat.seatName}`)),
  ));
  input.focus();
}

async function showSeatPicker(/** @type {string} */ notice = '') {
  if (!code) return showCodeEntry();
  screen(t('join.loading'));
  const result = await api(`/rooms/${code}`);
  if (!result.ok) {
    return screen(t('join.title'), h('p.error', null, result.status === 404 ? t('join.notFound') : errorText(result.error)),
      h('a.button', { href: '/play' }, t('join.otherCode')));
  }
  const room = result.data;
  const roomCode = code;
  screen(room.name,
    notice && h('p.notice', null, notice),
    h('p', null, t('join.whoAreYou')),
    h('div.seat-list', null, ...room.seats.map((/** @type {any} */ seat) =>
      h('button.seat', {
        type: 'button',
        onclick: async () => {
          // One request at a time: no double taps while it's on its way.
          for (const button of document.querySelectorAll('.seat')) /** @type {HTMLButtonElement} */ (button).disabled = true;
          await claim(roomCode, room.name, seat);
          for (const button of document.querySelectorAll('.seat')) /** @type {HTMLButtonElement} */ (button).disabled = false;
        },
      },
        h('span', null, seat.name),
        seat.claimed && h('small', null, t('join.taken'))))),
    room.joinLocked && h('p.hint', null, t('join.locked')),
    h('p.hint', null, t('join.code'), ' ', h('strong', null, formatRoomCode(roomCode))),
  );
}

/** @param {string} roomCode @param {string} roomName @param {{ id: string, name: string }} seat */
async function claim(roomCode, roomName, seat) {
  // Already asked for this seat from this device: keep waiting on that request rather than sending another.
  const pending = storage.pendingClaim(roomCode);
  if (pending?.seatId === seat.id) return waitForApproval(roomCode, roomName, pending.claimId, seat);
  const result = await api(`/rooms/${roomCode}/claim`, { method: 'POST', body: { seatId: seat.id } });
  if (!result.ok) return snackbar(errorText(result.error));
  if (result.data.token) {
    storage.saveSeat(roomCode, { token: result.data.token, seatId: seat.id, seatName: seat.name, roomName });
    return showFeed();
  }
  storage.savePendingClaim(roomCode, { seatId: seat.id, claimId: result.data.pending });
  waitForApproval(roomCode, roomName, result.data.pending, seat);
}

/** @param {string} roomCode @param {string} roomName @param {string} claimId @param {{ id: string, name: string }} seat */
function waitForApproval(roomCode, roomName, claimId, seat) {
  screen(roomName,
    h('p.big', null, t('join.askDm', { name: seat.name })),
    h('div.spinner', { 'aria-hidden': 'true' }),
    h('button', {
      type: 'button',
      onclick: () => {
        storage.savePendingClaim(roomCode, undefined);
        api(`/rooms/${roomCode}/cancel-claim`, { method: 'POST', body: { claim: claimId } });
        showSeatPicker();
      },
    }, t('common.cancel')),
  );
  socket = connectRoom(roomCode, () => ({ role: 'pending', claim: claimId }), {
    onStatus: () => {},
    onMessage(message) {
      if (message.t === 'approved') {
        storage.savePendingClaim(roomCode, undefined);
        storage.saveSeat(roomCode, { token: message.token, seatId: message.seat.id, seatName: message.seat.name, roomName });
        showFeed();
      } else if (message.t === 'signedOut') {
        storage.savePendingClaim(roomCode, undefined);
        const notice = { denied: 'join.denied', replaced: 'join.replaced' }[/** @type {string} */ (message.reason)] ?? 'join.expired';
        showSeatPicker(t(notice));
      }
    },
  });
}

/** A personal link from the DM: takes the seat directly. @param {string} roomCode @param {string} secret */
async function redeemLink(roomCode, secret) {
  screen(t('join.loading'));
  const result = await api(`/rooms/${roomCode}/redeem`, { method: 'POST', body: { secret } });
  if (!result.ok) return showSeatPicker(t('join.badLink'));
  const info = await api(`/rooms/${roomCode}`);
  storage.saveSeat(roomCode, {
    token: result.data.token, seatId: result.data.seat.id, seatName: result.data.seat.name, roomName: info.data?.name,
  });
  showFeed();
}

// ---------- Feed

/**
 * @typedef {{ id: string, title: string, body: string, images: { id: string, w: number, h: number }[],
 *   at: number, session: number, edited: boolean, shared: boolean, acked: boolean }} Item
 */

function showFeed() {
  const roomCode = /** @type {string} */ (code);
  const seat = storage.seats()[roomCode];
  const cached = storage.cachedFeed(roomCode);
  /** @type {Item[]} */
  let items = cached?.items ?? [];
  /** @type {{ n: number, startedAt: number }[]} */
  let sessions = cached?.sessions ?? [];
  /** Items not yet seen on this device: they glow until seen. */
  const unseen = new Set();
  /** @type {Set<string>} */
  const seenSent = new Set();
  /** @type {Set<string>} */
  let seenQueue = new Set();

  const status = h('span.status', { role: 'status', 'aria-live': 'polite' });
  const roomTitle = h('h1', null, seat.roomName ?? formatRoomCode(roomCode));
  const seatName = h('span.seat-name', null, seat.seatName);
  const list = h('div.feed', { 'aria-live': 'polite' });
  const newPill = h('button.new-pill', { type: 'button', hidden: true, onclick: () => scrollTo({ top: 0, behavior: 'smooth' }) });

  socket?.close();
  app.replaceChildren(
    h('header.bar', null,
      h('div.titles', null, roomTitle, seatName),
      status,
      h('button.icon', { type: 'button', 'aria-label': t('settings.title'), title: t('settings.title'), onclick: openSettings }, icon('settings')),
    ),
    newPill,
    list,
  );
  wake.set(storage.prefs().keepAwake === true);

  // "Seen" = at least half of the item on screen for a second, with the page visible.
  const timers = new Map();
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const id = /** @type {HTMLElement} */ (entry.target).dataset.id;
      if (!id) continue;
      if (entry.isIntersecting) {
        if (!timers.has(id)) timers.set(id, setTimeout(() => markSeen(id), 1000));
      } else {
        clearTimeout(timers.get(id));
        timers.delete(id);
      }
    }
  }, { threshold: 0.5 });

  /** @param {string} id */
  function markSeen(id) {
    timers.delete(id);
    if (document.visibilityState !== 'visible') return;
    if (unseen.delete(id)) list.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.remove('new');
    updatePill();
    if (!seenSent.has(id)) seenQueue.add(id);
  }

  const flush = setInterval(() => {
    if (!seenQueue.size || !socket) return;
    if (socket.send({ t: 'seen', ids: [...seenQueue] })) {
      for (const id of seenQueue) seenSent.add(id);
      seenQueue = new Set();
    }
  }, 2000);

  function updatePill() {
    const offscreen = [...unseen].filter((id) => {
      const el = list.querySelector(`[data-id="${CSS.escape(id)}"]`);
      return el && el.getBoundingClientRect().bottom < 0;
    }).length;
    newPill.hidden = offscreen === 0;
    newPill.textContent = t('feed.newAbove', { count: offscreen });
  }
  addEventListener('scroll', updatePill, { passive: true });

  function save() {
    storage.saveFeed(roomCode, { items, sessions });
  }

  function render() {
    observer.disconnect();
    if (!items.length) {
      list.replaceChildren(h('div.empty', null,
        h('p', null, t('feed.empty')),
        h('p.hint', null, wake.supported ? t('feed.emptyHintAwake') : t('feed.emptyHint'))));
      return;
    }
    const bySession = new Map();
    for (const item of [...items].sort((a, b) => b.at - a.at)) {
      if (!bySession.has(item.session)) bySession.set(item.session, []);
      bySession.get(item.session).push(item);
    }
    const blocks = [];
    for (const [n, sessionItems] of bySession) {
      const started = sessions.find((s) => s.n === n)?.startedAt ?? sessionItems.at(-1).at;
      blocks.push(h('h2.session', null, t('feed.session', { n, date: formatDate(started) })));
      for (const item of sessionItems) blocks.push(renderItem(item));
    }
    list.replaceChildren(...blocks);
    for (const el of list.querySelectorAll('.item')) observer.observe(el);
    updatePill();
  }

  /** @param {Item} item */
  function renderItem(item) {
    const images = h('div.images', { dataset: { count: String(item.images.length) } },
      ...item.images.map((image) => {
        const img = /** @type {HTMLImageElement} */ (h('img', { alt: '', width: image.w, height: image.h, loading: 'lazy' }));
        imageUrl(roomCode, image.id, seat.token, true).then((url) => url && (img.src = url));
        return h('button.thumb', {
          type: 'button',
          'aria-label': t('feed.openImage'),
          style: `aspect-ratio: ${image.w} / ${image.h}`,
          onclick: async () => {
            const url = await imageUrl(roomCode, image.id, seat.token, false);
            if (url) openViewer(url, item.title);
          },
        }, img);
      }));
    const ack = h('button.ack', {
      type: 'button',
      'aria-pressed': String(item.acked),
      disabled: item.acked,
      onclick: () => socket?.send({ t: 'ack', id: item.id }),
    }, item.acked ? `✓ ${t('feed.acked')}` : `👍 ${t('feed.ack')}`);

    return h(`article.item.note${unseen.has(item.id) ? '.new' : ''}`, { dataset: { id: item.id } },
      item.title && h('h3', null, item.title),
      item.body && h('p.body', { tabindex: 0, role: 'button', 'aria-label': t('feed.readLarger'), onclick: () => openReader(item) }, item.body),
      item.images.length > 0 && images,
      h('footer', null,
        h('span.meta', null,
          formatWhen(item.at),
          item.shared && h('span.tag', null, t('feed.shared')),
          item.edited && h('span.tag', null, t('feed.edited'))),
        ack));
  }

  /** @param {any} message */
  function onMessage(message) {
    switch (message.t) {
      case 'welcome': {
        const known = new Set(items.map((i) => i.id));
        items = message.feed;
        sessions = message.sessions;
        roomTitle.textContent = message.room.name;
        seatName.textContent = message.seat.name;
        storage.saveSeat(roomCode, { ...seat, seatName: message.seat.name, roomName: message.room.name });
        const arrived = items.filter((i) => !known.has(i.id));
        // Anything that arrived while away glows until it has been seen.
        for (const item of arrived) unseen.add(item.id);
        socket?.send({ t: 'got', ids: items.map((i) => i.id) });
        save();
        render();
        break;
      }
      case 'item': {
        const index = items.findIndex((i) => i.id === message.item.id);
        if (index >= 0) items[index] = message.item;
        else items.push(message.item);
        if (message.fresh) {
          unseen.add(message.item.id);
          socket?.send({ t: 'got', ids: [message.item.id] });
        }
        save();
        render();
        break;
      }
      case 'remove': {
        const removed = items.find((i) => i.id === message.id);
        items = items.filter((i) => i.id !== message.id);
        unseen.delete(message.id);
        if (removed) forgetImages(roomCode, removed.images.map((image) => image.id));
        save();
        render();
        break;
      }
      case 'room':
        roomTitle.textContent = message.room.name;
        break;
      case 'seat':
        seatName.textContent = message.seat.name;
        break;
      case 'signedOut':
        clearInterval(flush);
        signedOut(message.reason);
        break;
    }
  }

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let offlineTimer;
  /** @param {string} state */
  function onStatus(state) {
    clearTimeout(offlineTimer);
    status.dataset.state = state;
    status.title = t(`status.${state}`);
    status.textContent = '';
    // Brief drops are normal (the phone slept); only say "reconnecting" after 3 s.
    if (state !== 'open') offlineTimer = setTimeout(() => (status.textContent = t('status.reconnecting')), 3000);
  }

  render();
  socket = connectRoom(roomCode, () => ({ role: 'player', token: storage.seats()[roomCode]?.token }), { onMessage, onStatus });
}

/** @param {Item} item */
function openReader(item) {
  const scale = () => storage.prefs().textSize ?? 1.4;
  const body = h('div.reader-text', { style: `--reader-scale: ${scale()}` }, item.title && h('h2', null, item.title), h('p', null, item.body));
  const resize = (/** @type {number} */ delta) => {
    const next = Math.min(2.6, Math.max(1, Math.round((scale() + delta) * 10) / 10));
    storage.savePrefs({ textSize: next });
    body.style.setProperty('--reader-scale', String(next));
  };
  openDialog([
    h('div.dialog-bar', null,
      h('button', { type: 'button', 'aria-label': t('reader.smaller'), onclick: () => resize(-0.2) }, 'A−'),
      h('button', { type: 'button', 'aria-label': t('reader.larger'), onclick: () => resize(0.2) }, 'A+'),
      closeButton(t('common.close'))),
    body,
  ], { className: 'reader' });
}

function openSettings() {
  const roomCode = /** @type {string} */ (code);
  const p = storage.prefs();
  const awake = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', id: 'awake', checked: p.keepAwake === true, disabled: !wake.supported }));
  awake.addEventListener('change', () => {
    storage.savePrefs({ keepAwake: awake.checked });
    wake.set(awake.checked);
  });
  const language = /** @type {HTMLSelectElement} */ (h('select', { id: 'language' },
    ...LANGUAGES.map((l) => h('option', { value: l.code, selected: l.code === lang }, l.name))));
  language.addEventListener('change', () => {
    setLanguage(language.value);
    location.reload();
  });

  openDialog([
    closeButton(t('common.close')),
    h('h2', null, t('settings.title')),
    h('div.field.check', null, awake, h('label', { for: 'awake' }, t('settings.keepAwake')),
      h('small', null, wake.supported ? t('settings.keepAwakeHint') : t('settings.noKeepAwake'))),
    themeField('theme', t('settings.theme'), (theme) => t(`theme.${theme}`), storage),
    h('div.field', null, h('label', { for: 'language' }, t('settings.language')), language),
    h('button.danger', {
      type: 'button',
      onclick: async () => {
        if (!confirm(t('settings.leaveConfirm'))) return;
        await api(`/rooms/${roomCode}/leave`, { method: 'POST', auth: storage.seats()[roomCode]?.token });
        await forgetLocal(roomCode);
        location.href = '/play';
      },
    }, t('settings.leave')),
  ]);
}

/** @param {string} roomCode */
async function forgetLocal(roomCode) {
  storage.saveSeat(roomCode, undefined);
  storage.saveFeed(roomCode, undefined);
  await forgetImages(roomCode);
}

/** @param {string} reason */
async function signedOut(reason) {
  const roomCode = /** @type {string} */ (code);
  if (reason === 'roomDeleted') return roomGone(roomCode);
  await forgetLocal(roomCode);
  wake.set(false);
  const key = ['moved', 'released', 'removed', 'left'].includes(reason) ? `signedOut.${reason}` : 'signedOut.other';
  showSeatPicker(t(key));
}

// A personal link opened in a tab already on /play changes only the #fragment, which doesn't reload the page.
addEventListener('hashchange', () => location.reload());

// Last, so every module-level variable above exists before anything runs.
translatePage();
start();
