// @ts-check
// The DM's page: prepare cards, reveal them to chosen players, see who has seen what, manage seats.
import { config } from '../config.js';
import { errorText, formatWhen, LANGUAGES, lang, setLanguage, t, translatePage } from './i18n.js';
import { prepareImage } from './image-prep.js';
import { parseCards } from './import-text.js';
import { api, connectRoom, imageUrl } from './net.js';
import { formatRoomCode, normalizeRoomCode } from './room-code.js';
import * as storage from './storage.js';
import { $, closeButton, closeDialogThen, copyText, h, icon, openDialog, qrSvg, screenWakeLock, snackbar, themeField } from './ui.js';
import { openViewer } from './viewer.js';

/**
 * @typedef {{ id: string, name: string, claimed: boolean, hasLink: boolean, lastSeenAt: number | null, status?: string }} Seat
 * @typedef {{ revealedAt: number | null, delivered: boolean, seen: boolean, acked: boolean }} Receipt
 * @typedef {{ id: string, title: string, body: string, grp: string | null, note: string, forSeats: string[], quick: boolean, sort: number,
 *   publicAt: number | null, createdAt: number, updatedAt: number,
 *   images: { id: string, w: number, h: number, bytes: number }[], seats: Record<string, Receipt> }} Card
 */

const app = $('#app');
const wake = screenWakeLock();
/** Wide screens show the open card in a third column instead of a sheet over everything. */
const wide = matchMedia('(min-width: 1100px)');

const state = {
  /** @type {string} */ code: '',
  /** @type {string} */ key: '',
  /** @type {{ code: string, name: string, joinLocked: boolean } | null} */ room: null,
  /** @type {Seat[]} */ seats: [],
  /** @type {Map<string, Card>} */ cards: new Map(),
  /** @type {{ id: string, seatId: string, createdAt: number }[]} */ claims: [],
  tab: 'table',
  search: '',
  group: '',
  /** Which cards the list shows: 'all', 'unrevealed' or 'revealed'. Remembered on this device. */
  status: storage.prefs().cardFilter ?? 'all',
  /** Seats picked in the quick-whisper box. @type {Set<string>} */ quickSeats: new Set(),
  quickEveryone: false,
};

/** Re-renders whatever is open after any change. */
const listeners = new Set();
const changed = () => listeners.forEach((fn) => fn());

/** @type {ReturnType<typeof connectRoom> | null} */
let socket = null;

async function start() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const code = normalizeRoomCode(fragment.get('r'));
  if (!code) return showRoomList();
  const saved = storage.dmRooms()[code];
  // The key stays in the address bar (after the #, so it never reaches the server): bookmarks and
  // "Add to Home Screen" then keep working. A key in the address wins, but the one this device already
  // had is kept as a fallback, in case the address is an old bookmark from before "Reset DM link".
  const key = fragment.get('k') ?? saved?.key;
  if (!key) {
    return app.replaceChildren(h('section.screen', null,
      h('h1', null, formatRoomCode(code)), h('p', null, t('dm.noKey')), h('a.button', { href: '/dm' }, t('dm.myRooms'))));
  }
  // A room deleted by its DM or by expiry: say so, and forget it here.
  if ((await api(`/rooms/${code}`)).status === 404) return roomGone(code, t('dm.roomGone'));
  fallbackKey = saved?.key && saved.key !== key ? saved.key : null;
  state.code = code;
  setKey(key);
  buildShell();
  if (!storage.dmRooms()[code]?.savedLink) showSaveLink(true);
  socket = connectRoom(code, () => ({ role: 'dm', key: state.key }), { onMessage, onStatus });
  wake.set(storage.prefs().keepAwake === true);
}

/** A key that worked on this device before, tried if the one in the address is rejected. @type {string | null} */
let fallbackKey = null;
/** True while this device resets the DM link, so its own sign-out isn't shown as an error. */
let rotating = false;

/** Uses a DM key: remembers it and puts it in the address bar (without reloading). @param {string} key */
function setKey(key) {
  state.key = key;
  storage.saveDmRoom(state.code, { key });
  history.replaceState(null, '', dmLink());
}

/** The full DM link for this room. @param {string} [origin] */
const dmLink = (origin = '') => `${origin}/dm#r=${state.code}&k=${state.key}`;

/** The room no longer exists: forget it on this device. @param {string} code @param {string} message */
function roomGone(code, message) {
  socket?.close();
  storage.saveDmRoom(code, undefined);
  app.replaceChildren(h('section.screen', null,
    h('h1', null, formatRoomCode(code)), h('p', null, message), h('a.button', { href: '/dm' }, t('dm.myRooms'))));
}

function showRoomList() {
  const rooms = Object.entries(storage.dmRooms());
  app.replaceChildren(h('section.screen', null,
    h('h1', null, t('dm.myRooms')),
    rooms.length
      ? h('div.stack', null, ...rooms.map(([code, room]) => h('a.button', { href: `/dm#r=${code}&k=${room.key}` }, `${room.name ?? ''} ${formatRoomCode(code)}`)))
      : h('p', null, t('dm.noRooms')),
    h('a.button.primary', { href: '/#create' }, t('landing.create')),
  ));
}

// ---------- Live updates

/** @param {any} message */
function onMessage(message) {
  switch (message.t) {
    case 'welcome':
      state.room = message.room;
      state.seats = message.seats;
      state.cards = new Map(message.cards.map((/** @type {Card} */ c) => [c.id, c]));
      state.claims = message.claims;
      storage.saveDmRoom(state.code, { key: state.key, name: message.room.name });
      break;
    case 'room':
      state.room = message.room;
      break;
    case 'seats':
      state.seats = message.seats;
      break;
    case 'presence':
      for (const { id, status } of message.seats) {
        const seat = state.seats.find((s) => s.id === id);
        if (seat) seat.status = status;
      }
      break;
    case 'card':
      state.cards.set(message.card.id, message.card);
      break;
    case 'cards':
      state.cards = new Map(message.cards.map((/** @type {Card} */ c) => [c.id, c]));
      break;
    case 'cardRemoved':
      state.cards.delete(message.id);
      break;
    case 'claims':
      state.claims = message.claims;
      break;
    case 'receipt': {
      const card = state.cards.get(message.cardId);
      const receipt = card?.seats[message.seatId];
      if (receipt) Object.assign(receipt, message.receipt);
      break;
    }
    case 'signedOut':
      if (message.reason === 'roomDeleted') return roomGone(state.code, t('dm.roomGone'));
      if (message.reason === 'key_rotated' && rotating) return; // this device did it; resetKey() reconnects
      if (message.reason === 'bad_key' && fallbackKey) {
        setKey(fallbackKey); // the address held an outdated key; the one this device had still works
        fallbackKey = null;
        socket?.reconnect();
        return;
      }
      app.replaceChildren(h('section.screen', null,
        h('h1', null, state.room?.name ?? formatRoomCode(state.code)),
        h('p', null, message.reason === 'key_rotated' ? t('dm.keyRotated') : t('dm.badKey')),
        h('a.button', { href: '/dm' }, t('dm.myRooms'))));
      return;
  }
  changed();
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let offlineTimer;
/** @param {string} status */
function onStatus(status) {
  const el = document.querySelector('.bar .status');
  if (!(el instanceof HTMLElement)) return;
  clearTimeout(offlineTimer);
  el.dataset.state = status;
  el.title = t(`status.${status}`);
  el.textContent = '';
  if (status !== 'open') offlineTimer = setTimeout(() => (el.textContent = t('status.reconnecting')), 3000);
  // Ask for fresh presence now and then: phones that went to sleep stop pinging.
  if (status === 'open') presencePoll();
}

/** @type {ReturnType<typeof setInterval> | undefined} */
let presenceTimer;
function presencePoll() {
  clearInterval(presenceTimer);
  presenceTimer = setInterval(() => socket?.send({ t: 'presence' }), 20_000);
}

/** A DM API call with error reporting. @param {string} path @param {Parameters<typeof api>[1]} [options] */
async function call(path, options = {}) {
  const result = await api(`/rooms/${state.code}${path}`, { ...options, auth: state.key });
  if (!result.ok) snackbar(errorText(result.error));
  return result;
}

// ---------- Layout

function buildShell() {
  const title = h('h1');
  const code = h('span.code');
  const claims = h('div.claims');
  const tabs = h('nav.tabs', { role: 'tablist' },
    ...['table', 'cards', 'room', 'settings'].map((tab) => h(`button.tab-${tab}`, {
      type: 'button', role: 'tab', dataset: { tab }, onclick: () => setTab(tab),
    }, t(`dm.tab.${tab}`))));

  app.replaceChildren(
    h('header.bar', null,
      h('div.titles', null, title, code),
      h('span.status', { role: 'status' }),
      h('button.join-button', { type: 'button', 'aria-label': t('dm.showJoin'), title: t('dm.showJoin'), onclick: showJoin },
        icon('qr'), h('span', null, t('dm.join')))),
    claims,
    h('main.dm-panes', null, tablePane(), cardsPane(), roomPane(), settingsPane(), detailPane()),
    tabs,
  );
  setTab(state.tab);
  document.addEventListener('keydown', shortcuts);

  listeners.add(() => {
    title.textContent = state.room?.name ?? '';
    code.textContent = formatRoomCode(state.code);
    document.title = `${state.room?.name ?? ''} · Whisperer`;
    const frozenBanner = /** @type {any} */ (state.room)?.frozen ? [h('div.claim.frozen', { role: 'status' }, h('span', null, t('error.room_frozen')))] : [];
    claims.replaceChildren(...frozenBanner, ...state.claims.map((claim) => {
      const seat = state.seats.find((s) => s.id === claim.seatId);
      return h('div.claim', { role: 'alert' },
        h('span', null, t('dm.claim', { name: seat?.name ?? '?' })),
        h('button.primary', { type: 'button', onclick: () => call(`/claims/${claim.id}/approve`, { method: 'POST' }) }, t('dm.approve')),
        h('button', { type: 'button', onclick: () => call(`/claims/${claim.id}/deny`, { method: 'POST' }) }, t('dm.deny')));
    }));
  });
}

/** @param {string} tab */
function setTab(tab) {
  if (tab === 'table' && matchMedia('(min-width: 800px)').matches) tab = 'cards'; // the table column is always shown there
  state.tab = tab;
  document.body.dataset.tab = tab;
  for (const button of document.querySelectorAll('.tabs button')) {
    button.setAttribute('aria-selected', String(/** @type {HTMLElement} */ (button).dataset.tab === tab));
  }
}

// ---------- Table: quick whisper + recent reveals

function tablePane() {
  const text = /** @type {HTMLTextAreaElement} */ (h('textarea', {
    id: 'quick-text', rows: 3, maxlength: 4000, placeholder: t('dm.quickPlaceholder'), 'aria-label': t('dm.quickTitle'),
  }));
  const photo = /** @type {HTMLInputElement} */ (h('input', { type: 'file', accept: 'image/*', id: 'quick-photo', class: 'visually-hidden' }));
  const photoLabel = h('label.button', { for: 'quick-photo' }, t('dm.addPhoto'));
  photo.addEventListener('change', () => {
    const file = photo.files?.[0];
    photoLabel.replaceChildren(icon('image', 18), h('span.file-name', null, file ? file.name : t('dm.addPhoto')));
  });
  photoLabel.replaceChildren(icon('image', 18), h('span.file-name', null, t('dm.addPhoto')));
  const chips = h('div.chips');
  const send = /** @type {HTMLButtonElement} */ (h('button.primary.reveal', { type: 'button', 'aria-keyshortcuts': 'Control+Enter' }));
  const recent = h('div.recent');

  send.addEventListener('click', async () => {
    const seats = [...state.quickSeats];
    const everyone = state.quickEveryone;
    if (!text.value.trim() && !photo.files?.length) return snackbar(t('dm.quickEmpty'));
    if (!seats.length && !everyone) return snackbar(t('dm.pickSomeone'));
    send.disabled = true;
    try {
      const created = await call('/cards', { method: 'POST', body: { body: text.value, quick: true } });
      if (!created.ok) return;
      const card = created.data.card;
      if (photo.files?.[0] && !(await uploadImage(card.id, photo.files[0]))) return;
      const revealed = await revealCard(card.id, seats, everyone);
      if (revealed) {
        text.value = '';
        photo.value = '';
        photoLabel.replaceChildren(icon('image', 18), h('span.file-name', null, t('dm.addPhoto')));
        state.quickSeats.clear();
        state.quickEveryone = false;
        changed();
      }
    } finally {
      send.disabled = false;
    }
  });

  listeners.add(() => {
    chips.replaceChildren(...seatChips(state.quickSeats, () => state.quickEveryone, (v) => (state.quickEveryone = v), changed));
    send.textContent = revealLabel(state.quickSeats, state.quickEveryone);
    const revealed = [...state.cards.values()]
      .map((card) => ({ card, last: lastReveal(card) }))
      .filter((x) => x.last)
      .sort((a, b) => b.last - a.last)
      .slice(0, 30);
    recent.replaceChildren(
      h('h2', null, t('dm.recent')),
      revealed.length ? h('div.list', null, ...revealed.map(({ card }) => cardRow(card))) : h('p.hint', null, t('dm.noReveals')));
  });

  return h('section.pane.table', null,
    h('div.quick', null,
      h('h2', null, t('dm.quickTitle')),
      text,
      h('div.row', null, photo, photoLabel),
      chips,
      send),
    recent);
}

/** @param {Card} card */
function lastReveal(card) {
  const times = Object.values(card.seats).map((r) => r.revealedAt ?? 0);
  return Math.max(card.publicAt ?? 0, ...times, 0);
}

/**
 * Chips to pick recipients: one per seat (with its status dot) plus "Everyone".
 * @param {Set<string>} selected @param {() => boolean} getEveryone @param {(v: boolean) => void} setEveryone
 * @param {() => void} onChange @param {Card} [card]  When given, seats that already have it are shown as such.
 */
function seatChips(selected, getEveryone, setEveryone, onChange, card) {
  const chips = state.seats.map((seat) => {
    const has = card && (card.publicAt != null || card.seats[seat.id]);
    return h('button.chip', {
      type: 'button',
      'aria-pressed': String(selected.has(seat.id)),
      disabled: Boolean(has),
      onclick: () => {
        if (selected.has(seat.id)) selected.delete(seat.id);
        else selected.add(seat.id);
        onChange();
      },
    }, h('span.dot', { dataset: { status: seat.status ?? 'offline' }, 'aria-label': t(`presence.${seat.status ?? 'offline'}`) }), seat.name,
    has ? h('span.receipt', null, receiptIcon(card.seats[seat.id])) : null);
  });
  const everyoneDone = card?.publicAt != null;
  chips.push(h('button.chip.everyone', {
    type: 'button',
    'aria-pressed': String(getEveryone()),
    disabled: everyoneDone,
    onclick: () => {
      setEveryone(!getEveryone());
      onChange();
    },
  }, t('dm.everyone')));
  return chips;
}

/** @param {Set<string>} seats @param {boolean} everyone */
function revealLabel(seats, everyone) {
  if (everyone) return t('dm.revealEveryone');
  const names = state.seats.filter((s) => seats.has(s.id)).map((s) => s.name);
  return names.length ? t('dm.revealTo', { names: names.join(', ') }) : t('dm.reveal');
}

/** ✓ delivered, ✓✓ seen, 👍 acknowledged, ○ not delivered yet. @param {Receipt | undefined} receipt */
function receiptIcon(receipt) {
  if (!receipt) return '';
  if (receipt.acked) return '👍';
  if (receipt.seen) return '✓✓';
  if (receipt.delivered) return '✓';
  return '○';
}

/**
 * Reveals, then offers Undo for a few seconds (which un-reveals what was just added).
 * @param {string} cardId @param {string[]} seats @param {boolean} everyone
 */
async function revealCard(cardId, seats, everyone) {
  const before = state.cards.get(cardId);
  const newSeats = seats.filter((id) => !before?.seats[id]);
  const newlyPublic = everyone && before?.publicAt == null;
  const result = await call(`/cards/${cardId}/reveal`, { method: 'POST', body: { seats, everyone } });
  if (!result.ok) return false;
  const names = everyone ? t('dm.everyone') : state.seats.filter((s) => seats.includes(s.id)).map((s) => s.name).join(', ');
  snackbar(t('dm.revealed', { names }), {
    action: t('dm.undo'),
    ms: 6000,
    onAction: () => call(`/cards/${cardId}/unreveal`, { method: 'POST', body: { seats: newSeats, everyone: newlyPublic } }),
  });
  return true;
}

/** True once anyone can see the card. @param {Card} card */
const isRevealed = (card) => card.publicAt != null || Object.values(card.seats).some((r) => r.revealedAt != null);

/**
 * One card in a list: title or text, your note, who it's for, then who has it.
 * @param {Card} card
 * @param {{ view: Card[] }} [reorder]  When given, the row gets a handle to drag it within `view`.
 */
function cardRow(card, reorder) {
  const holders = card.publicAt != null
    ? [h('span.holder', null, t('dm.everyone'))]
    : state.seats.filter((s) => card.seats[s.id]).map((s) => h('span.holder', null, `${s.name} ${receiptIcon(card.seats[s.id])}`));
  const waitingFor = card.publicAt != null ? [] : state.seats.filter((s) => card.forSeats.includes(s.id) && !card.seats[s.id]);
  const row = h('button.card-row', { type: 'button', dataset: { id: card.id }, onclick: () => openCard(card.id) },
    h('strong', null, card.title || firstLine(card.body) || t('dm.untitled')),
    card.title && card.body && h('span.snippet', null, firstLine(card.body)),
    card.note && h('span.dm-note-line', null, icon('note', 14), h('span', null, firstLine(card.note))),
    h('span.meta', null,
      card.images.length > 0 && h('span.count', { 'aria-label': t('dm.imageCount', { count: card.images.length }) },
        icon('image', 16), String(card.images.length)),
      card.grp && h('span.tag', null, card.grp),
      card.quick && h('span.tag', null, t('dm.quick')),
      waitingFor.length > 0 && h('span.for-names', null, t('dm.forNames', { names: waitingFor.map((s) => s.name).join(', ') }))),
    holders.length > 0 && h('span.holders', null, ...holders));
  if (!reorder) return row;
  const grip = h('button.grip', {
    type: 'button',
    'aria-label': t('dm.moveCard', { title: card.title || t('dm.untitled') }),
    title: t('dm.moveHint'),
    dataset: { id: card.id },
  }, icon('grip', 18));
  const item = h('div.card-item', { dataset: { id: card.id } }, grip, row);
  grip.addEventListener('pointerdown', (event) => dragCard(/** @type {PointerEvent} */ (event), item, reorder.view));
  grip.addEventListener('keydown', (event) => {
    const index = reorder.view.findIndex((c) => c.id === card.id);
    if (event.key === 'ArrowUp' && index > 0) moveCard(reorder.view, index, index - 1);
    else if (event.key === 'ArrowDown' && index < reorder.view.length - 1) moveCard(reorder.view, index, index + 1);
    else return;
    event.preventDefault();
  });
  return item;
}

/**
 * Drag a card by its handle. The others slide out of the way; on release the card gets a sort value between
 * its new neighbours (only that one card changes on the server).
 * @param {PointerEvent} event @param {HTMLElement} item @param {Card[]} view
 */
function dragCard(event, item, view) {
  event.preventDefault();
  const grip = /** @type {HTMLElement} */ (event.currentTarget);
  grip.setPointerCapture(event.pointerId);
  const items = /** @type {HTMLElement[]} */ ([...(item.parentElement?.querySelectorAll(':scope > .card-item') ?? [])]);
  const rects = items.map((el) => el.getBoundingClientRect());
  const from = items.indexOf(item);
  const height = rects[from].height;
  const startY = event.clientY;
  let to = from;
  item.classList.add('dragging');

  const move = (/** @type {PointerEvent} */ e) => {
    const dy = e.clientY - startY;
    item.style.transform = `translateY(${dy}px)`;
    const centre = rects[from].top + height / 2 + dy;
    to = from;
    rects.forEach((rect, i) => {
      const middle = rect.top + rect.height / 2;
      if (i < from && centre < middle) to = Math.min(to, i);
      if (i > from && centre > middle) to = Math.max(to, i);
    });
    items.forEach((el, i) => {
      if (el === item) return;
      const shift = from < to && i > from && i <= to ? -height : from > to && i >= to && i < from ? height : 0;
      el.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  };
  const end = () => {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', end);
    grip.removeEventListener('pointercancel', end);
    for (const el of items) el.style.transform = '';
    item.classList.remove('dragging');
    if (to !== from) moveCard(view, from, to);
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
}

/**
 * Moves view[from] to position `to`, giving it a sort value between its new neighbours.
 * @param {Card[]} view @param {number} from @param {number} to
 */
async function moveCard(view, from, to) {
  const order = view.slice();
  const [card] = order.splice(from, 1);
  order.splice(to, 0, card);
  const before = order[to - 1];
  const after = order[to + 1];
  const sort = before && after ? (before.sort + after.sort) / 2 : before ? before.sort + 1 : after.sort - 1;
  const previous = card.sort;
  card.sort = sort; // move it now; the server's answer confirms it
  changed(); // the list redraw keeps focus on this card's handle
  const result = await call(`/cards/${card.id}`, { method: 'PATCH', body: { sort } });
  if (!result.ok) {
    card.sort = previous;
    changed();
  }
}

/** @param {string} text */
const firstLine = (text) => text.split('\n')[0].slice(0, 120);

// ---------- Cards: library

function cardsPane() {
  const search = /** @type {HTMLInputElement} */ (h('input', { type: 'search', placeholder: t('dm.search'), 'aria-label': t('dm.search') }));
  search.addEventListener('input', () => {
    state.search = search.value.trim().toLocaleLowerCase();
    changed();
  });
  const groupBar = h('div.group-bar', { role: 'tablist', 'aria-label': t('dm.groups') });
  const statusBar = h('div.segmented', { role: 'radiogroup', 'aria-label': t('dm.show') },
    ...['unrevealed', 'revealed', 'all'].map((status) => h('button', {
      type: 'button',
      role: 'radio',
      dataset: { status },
      onclick: () => {
        state.status = status;
        storage.savePrefs({ cardFilter: status });
        changed();
      },
    }, t(`dm.filter.${status}`))));
  const list = h('div.list');

  listeners.add(() => {
    const all = [...state.cards.values()];
    const groups = [...new Set(all.map((c) => c.grp).filter((g) => g != null))].sort((a, b) => String(a).localeCompare(String(b)));
    if (state.group && state.group !== '__quick' && state.group !== '__none' && !groups.includes(state.group)) state.group = '';
    /** @type {[string, string][]} */
    const tabs = [['', t('dm.filter.all')], ...groups.map((g) => /** @type {[string, string]} */ ([String(g), String(g)]))];
    if (all.some((c) => c.grp == null && !c.quick)) tabs.push(['__none', t('dm.noGroup')]);
    if (all.some((c) => c.quick)) tabs.push(['__quick', t('dm.quickGroup')]);
    groupBar.replaceChildren(...tabs.map(([value, label]) => h('button', {
      type: 'button',
      role: 'tab',
      'aria-selected': String(state.group === value),
      onclick: () => {
        state.group = value;
        changed();
      },
    }, label)));
    for (const button of statusBar.children) {
      button.setAttribute('aria-checked', String(/** @type {HTMLElement} */ (button).dataset.status === state.status));
    }

    const view = all
      .filter((c) => !state.group || (state.group === '__quick' ? c.quick : state.group === '__none' ? c.grp == null && !c.quick : c.grp === state.group))
      .filter((c) => state.status === 'all' || (state.status === 'revealed') === isRevealed(c))
      .filter((c) => !state.search || `${c.title}\n${c.body}\n${c.grp ?? ''}\n${c.note}`.toLocaleLowerCase().includes(state.search))
      .sort((a, b) => a.sort - b.sort);
    // Dragging only makes sense in the plain list, not in search results.
    const reorder = state.search ? undefined : { view };
    // Redrawing replaces the rows, so keep keyboard focus on the same card's handle or row.
    const focused = /** @type {HTMLElement | null} */ (document.activeElement);
    const keep = list.contains(focused) && focused?.dataset.id ? { id: focused.dataset.id, grip: focused.classList.contains('grip') } : null;
    list.replaceChildren(...(view.length
      ? view.map((card) => cardRow(card, reorder))
      : [h('p.hint', null, state.cards.size ? t('dm.noMatches') : t('dm.noCards'))]));
    if (keep) /** @type {HTMLElement | null} */ (list.querySelector(`${keep.grip ? '.grip' : '.card-row'}[data-id="${CSS.escape(keep.id)}"]`))?.focus();
  });

  return h('section.pane.cards', null,
    h('div.toolbar', null,
      search,
      h('button', { type: 'button', onclick: importCardsDialog }, t('dm.import')),
      h('button.primary', { type: 'button', onclick: () => editCard(null) }, t('dm.newCard'))),
    groupBar,
    statusBar,
    list);
}

/** Paste prep notes or pick a .txt/.md file; preview; then create all the cards at once. */
function importCardsDialog() {
  const text = /** @type {HTMLTextAreaElement} */ (h('textarea', {
    id: 'import-text', rows: 12, spellcheck: false, placeholder: t('dm.importExample'),
  }));
  const file = /** @type {HTMLInputElement} */ (h('input', { type: 'file', id: 'import-file', accept: '.txt,.md,.markdown,text/plain,text/markdown' }));
  const preview = h('div.import-preview', { role: 'status', 'aria-live': 'polite' });
  const go = /** @type {HTMLButtonElement} */ (h('button.primary', { type: 'button', disabled: true }, t('dm.importButton', { count: 0 })));
  /** @type {ReturnType<typeof parseCards> | null} */
  let parsed = null;

  const update = () => {
    parsed = text.value.trim() ? parseCards(text.value, state.seats) : null;
    if (!parsed) {
      preview.replaceChildren();
      go.disabled = true;
      go.textContent = t('dm.importButton', { count: 0 });
      return;
    }
    const groups = new Set(parsed.cards.map((c) => c.grp ?? ''));
    const describe = (/** @type {import('./import-text.js').ImportWarning} */ w) =>
      t(`import.${w.code}`, { card: w.card ?? '', value: w.value ?? '' });
    preview.replaceChildren(...[
      parsed.errors.length > 0 && h('ul.import-errors', null, ...parsed.errors.map((e) => h('li', null, describe(e)))),
      parsed.cards.length > 0 && h('p', null,
        h('strong', null, t('dm.importCount', { count: parsed.cards.length })), ' ', t('dm.importGroups', { count: groups.size })),
      parsed.warnings.length > 0 && h('ul.import-warnings', null, ...parsed.warnings.map((w) => h('li', null, describe(w)))),
      parsed.cards.length > 0 && h('ol.import-list', null,
        ...parsed.cards.slice(0, 8).map((c) => h('li', null,
          c.grp && h('span.tag', null, c.grp), ' ', c.title || firstLine(c.body) || t('dm.untitled'))),
        parsed.cards.length > 8 && h('li.more', null, t('dm.importMore', { count: parsed.cards.length - 8 }))),
    ].filter((x) => x instanceof Node));
    go.disabled = parsed.errors.length > 0;
    go.textContent = t('dm.importButton', { count: parsed.cards.length });
  };
  text.addEventListener('input', update);
  file.addEventListener('change', async () => {
    const picked = file.files?.[0];
    if (!picked) return;
    text.value = await picked.text();
    update();
  });
  go.addEventListener('click', async () => {
    if (!parsed || parsed.errors.length) return;
    go.disabled = true;
    const result = await call('/cards/bulk', {
      method: 'POST',
      body: { cards: parsed.cards.map(({ title, body, grp, note, forSeats }) => ({ title, body, grp, note, forSeats })) },
    });
    go.disabled = false;
    if (!result.ok) return;
    snackbar(t('dm.imported', { count: result.data.imported }));
    state.group = '';
    dialog.close();
  });

  const dialog = openDialog([
    closeButton(t('common.close')),
    h('h2', null, t('dm.importTitle')),
    h('p', null, t('dm.importHint')),
    h('details.import-format', null,
      h('summary', null, t('dm.importFormat')),
      h('pre', null, t('dm.importExample')),
      h('p.hint', null, t('dm.importFormatHint'))),
    h('label', { for: 'import-file' }, t('dm.importFile')), file,
    h('label', { for: 'import-text' }, t('dm.importText')), text,
    preview,
    h('div.dialog-footer', null, go),
  ], { className: 'editor' });
  text.focus();
}

/** What the open card's keyboard shortcuts act on. @type {{ toggleSeat: (i: number) => void, toggleEveryone: () => void, reveal: () => void } | null} */
let openCardKeys = null;
/** Stops re-rendering the card in the detail column. @type {(() => void) | null} */
let closeDetail = null;

/**
 * The open card: content, recipients, reveal / take back, edit, delete.
 * A third column on wide screens, a sheet on phones and tablets.
 * @param {string} cardId
 */
function openCard(cardId) {
  // The players this card is usually for start out picked, unless they already have it.
  const initial = state.cards.get(cardId);
  /** @type {Set<string>} */
  const selected = new Set(initial && initial.publicAt == null ? initial.forSeats.filter((id) => !initial.seats[id]) : []);
  let everyone = false;
  const content = h('div.sheet-content');
  /** @type {HTMLDialogElement | null} */
  let dialog = null;
  const close = () => {
    listeners.delete(render);
    openCardKeys = null;
    if (dialog) dialog.close();
    else {
      closeDetail = null;
      $('.pane.detail').replaceChildren(h('p.hint.empty-detail', null, t('dm.pickCard')));
      for (const row of document.querySelectorAll('.card-row[aria-current]')) row.removeAttribute('aria-current');
    }
  };

  const doReveal = async () => {
    const card = state.cards.get(cardId);
    if (!card || (!selected.size && !everyone)) return;
    if (await revealCard(card.id, [...selected], everyone)) {
      selected.clear();
      everyone = false;
      render();
    }
  };

  function render() {
    const card = state.cards.get(cardId);
    if (!card) return close();
    for (const row of document.querySelectorAll('.card-row')) {
      if (/** @type {HTMLElement} */ (row).dataset.id === cardId && !dialog) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
    }
    const reveal = h('button.primary.reveal', {
      type: 'button',
      disabled: !selected.size && !everyone,
      onclick: doReveal,
      'aria-keyshortcuts': 'Control+Enter',
    }, revealLabel(selected, everyone));

    const holders = state.seats.filter((s) => card.seats[s.id] && card.seats[s.id].revealedAt != null);
    content.replaceChildren(...[
      // The card exactly as players see it: the same parchment slip as their feed.
      h('article.note.preview', null,
        card.title && h('h3', null, card.title),
        card.body && h('p.body', null, card.body),
        card.images.length > 0 && h('div.images', { dataset: { count: String(card.images.length) } },
          ...card.images.map((image) => dmThumb(image, card.title))),
        !card.title && !card.body && !card.images.length && h('p.hint', null, t('dm.untitled'))),
      card.note && h('aside.dm-note-box', null,
        h('span.label', null, icon('note', 14), t('dm.onlyYou')),
        h('p', null, card.note)),
      h('h3', null, t('dm.whoGetsIt')),
      h('div.chips', null, ...seatChips(selected, () => everyone, (v) => (everyone = v), render, card)),
      reveal,
      (holders.length > 0 || card.publicAt != null) && h('div.holders-list', null,
        h('h3', null, t('dm.hasIt')),
        card.publicAt != null && h('div.holder-row', null,
          h('span', null, `${t('dm.everyone')} · ${formatWhen(card.publicAt)}`),
          h('button.link', { type: 'button', onclick: () => takeBack(card, [], true) }, t('dm.takeBack'))),
        ...holders.map((seat) => h('div.holder-row', null,
          h('span', null, `${seat.name} ${receiptIcon(card.seats[seat.id])} · ${formatWhen(/** @type {number} */ (card.seats[seat.id].revealedAt))}`),
          h('button.link', { type: 'button', onclick: () => takeBack(card, [seat.id], false) }, t('dm.takeBack'))))),
      h('div.row.actions', null,
        h('button', { type: 'button', onclick: () => closeDialogThen(dialog, () => editCard(card.id)) }, t('dm.edit')),
        h('button', {
          type: 'button',
          onclick: async () => {
            const result = await call(`/cards/${card.id}/duplicate`, { method: 'POST' });
            if (!result.ok) return;
            snackbar(t('dm.duplicated'));
            closeDialogThen(dialog, () => openCard(result.data.card.id));
          },
        }, t('dm.duplicate')),
        h('button.danger', {
          type: 'button',
          onclick: async () => {
            if (confirm(t('dm.deleteConfirm'))) await call(`/cards/${card.id}`, { method: 'DELETE' });
          },
        }, t('dm.delete'))),
      wide.matches && h('p.hint.keys', null, t('dm.keysHint')),
    ].filter((x) => x instanceof Node));
  }

  openCardKeys = {
    toggleSeat(index) {
      const seat = state.seats[index];
      const card = state.cards.get(cardId);
      if (!seat || !card || card.publicAt != null || card.seats[seat.id]) return;
      if (selected.has(seat.id)) selected.delete(seat.id);
      else selected.add(seat.id);
      render();
    },
    toggleEveryone() {
      everyone = !everyone;
      render();
    },
    reveal: doReveal,
  };

  closeDetail?.();
  listeners.add(render);
  if (wide.matches) {
    closeDetail = () => listeners.delete(render);
    $('.pane.detail').replaceChildren(
      h('button.icon.close', { type: 'button', 'aria-label': t('common.close'), onclick: close }, '×'), content);
  } else {
    dialog = openDialog([closeButton(t('common.close')), content], {
      className: 'card-sheet',
      onClose: () => {
        listeners.delete(render);
        openCardKeys = null;
      },
    });
  }
  render();
}

function detailPane() {
  return h('aside.pane.detail', { 'aria-label': t('dm.cardDetail') }, h('p.hint.empty-detail', null, t('dm.pickCard')));
}

/**
 * Desktop shortcuts. Typing in a field never triggers them, except Ctrl/⌘+Enter, which sends from the
 * quick whisper box. Revealing a card always needs Ctrl/⌘ so a stray Enter can't reveal anything.
 * @param {KeyboardEvent} event
 */
function shortcuts(event) {
  const target = /** @type {HTMLElement} */ (event.target);
  const typing = target.matches('input, textarea, select, [contenteditable]');
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key === 'Enter') {
    if (target.id === 'quick-text') return /** @type {HTMLButtonElement} */ ($('.quick .reveal')).click();
    if (!typing && openCardKeys) return openCardKeys.reveal();
  }
  const openDialogEl = document.querySelector('dialog[open]');
  if (typing || mod || event.altKey || (openDialogEl && !openDialogEl.classList.contains('card-sheet'))) return;
  if (event.key === '/') {
    event.preventDefault();
    if (!wide.matches) setTab('cards');
    /** @type {HTMLInputElement} */ ($('.pane.cards input[type=search]')).focus();
  } else if (openCardKeys && /^[1-9]$/.test(event.key)) {
    openCardKeys.toggleSeat(Number(event.key) - 1);
  } else if (openCardKeys && event.key.toLowerCase() === 'e') {
    openCardKeys.toggleEveryone();
  } else if (event.key === 'Escape' && openCardKeys && !document.querySelector('dialog[open]')) {
    /** @type {HTMLElement | null} */ (document.querySelector('.pane.detail .close'))?.click();
  }
}

/** @param {Card} card @param {string[]} seats @param {boolean} everyone */
async function takeBack(card, seats, everyone) {
  await call(`/cards/${card.id}/unreveal`, { method: 'POST', body: { seats, everyone } });
  snackbar(t('dm.takenBack'));
}

/** @param {{ id: string, w: number, h: number }} image @param {string} alt */
function dmThumb(image, alt) {
  const img = /** @type {HTMLImageElement} */ (h('img', { alt: '', width: image.w, height: image.h }));
  imageUrl(state.code, image.id, state.key, true).then((url) => url && (img.src = url));
  return h('button.thumb', {
    type: 'button',
    style: `aspect-ratio: ${image.w} / ${image.h}`,
    onclick: async () => {
      const url = await imageUrl(state.code, image.id, state.key, false);
      if (url) openViewer(url, alt);
    },
  }, img);
}

/** Uploads one image (resized here first). @param {string} cardId @param {File} file */
async function uploadImage(cardId, file) {
  let prepared;
  try {
    prepared = await prepareImage(file);
  } catch (error) {
    snackbar(errorText(/** @type {Error} */ (error).message));
    return false;
  }
  const uploaded = await call(`/cards/${cardId}/images`, { method: 'POST', raw: prepared.full });
  if (!uploaded.ok) return false;
  await call(`/images/${uploaded.data.image.id}/thumb`, { method: 'PUT', raw: prepared.thumb });
  return true;
}

/** New card (null) or edit one. @param {string | null} cardId */
function editCard(cardId) {
  const card = cardId ? state.cards.get(cardId) : null;
  const title = /** @type {HTMLInputElement} */ (h('input', { id: 'card-title', maxlength: 120, value: card?.title ?? '' }));
  const body = /** @type {HTMLTextAreaElement} */ (h('textarea', { id: 'card-body', rows: 8, maxlength: 4000 }));
  body.value = card?.body ?? '';
  const groups = [...new Set([...state.cards.values()].map((c) => c.grp).filter(Boolean))];
  const group = /** @type {HTMLInputElement} */ (h('input', { id: 'card-group', maxlength: 40, list: 'groups', value: card?.grp ?? '' }));
  const removed = new Set();
  const existing = h('div.images.editable', null, ...(card?.images ?? []).map((image) => {
    const wrap = h('div.image-edit', null, dmThumb(image, ''),
      h('button.icon.remove', {
        type: 'button',
        'aria-label': t('dm.removeImage'),
        onclick: () => {
          removed.add(image.id);
          wrap.remove();
        },
      }, '×'));
    return wrap;
  }));
  /** @type {Set<string>} */
  const usuallyFor = new Set(card?.forSeats ?? []);
  const forChips = h('div.chips', { role: 'group', 'aria-labelledby': 'card-for-label' });
  const drawForChips = () => forChips.replaceChildren(...state.seats.map((seat) => h('button.chip', {
    type: 'button',
    'aria-pressed': String(usuallyFor.has(seat.id)),
    onclick: () => {
      if (usuallyFor.has(seat.id)) usuallyFor.delete(seat.id);
      else usuallyFor.add(seat.id);
      drawForChips();
    },
  }, seat.name)));
  drawForChips();
  const note = /** @type {HTMLTextAreaElement} */ (h('textarea', { id: 'card-note', rows: 2, maxlength: 1000, placeholder: t('dm.noteHint') }));
  note.value = card?.note ?? '';
  const files = /** @type {HTMLInputElement} */ (h('input', { type: 'file', id: 'card-images', accept: 'image/*', multiple: true }));
  const progress = h('p.hint', { role: 'status' });
  const save = /** @type {HTMLButtonElement} */ (h('button.primary', { type: 'submit' }, t('common.save')));

  const form = h('form.stack', {
    onsubmit: async (/** @type {Event} */ event) => {
      event.preventDefault();
      save.disabled = true;
      try {
        const fields = { title: title.value, body: body.value, grp: group.value, note: note.value, forSeats: [...usuallyFor] };
        const result = card
          ? await call(`/cards/${card.id}`, { method: 'PATCH', body: fields })
          : await call('/cards', { method: 'POST', body: fields });
        if (!result.ok) return;
        const id = result.data.card.id;
        for (const imageId of removed) await call(`/images/${imageId}`, { method: 'DELETE' });
        const picked = [...(files.files ?? [])];
        for (const [index, file] of picked.entries()) {
          progress.textContent = t('dm.uploading', { n: index + 1, count: picked.length });
          if (!(await uploadImage(id, file))) return;
        }
        closeDialogThen(dialog, () => !card && openCard(id));
      } finally {
        save.disabled = false;
      }
    },
  },
  h('h2', null, card ? t('dm.editCard') : t('dm.newCard')),
  h('label', { for: 'card-title' }, t('dm.cardTitle')), title,
  h('label', { for: 'card-body' }, t('dm.cardBody')), body,
  h('label', { for: 'card-group' }, t('dm.group')), group,
  h('datalist', { id: 'groups' }, ...groups.map((g) => h('option', { value: g }))),
  h('p.hint', null, t('dm.groupHint')),
  h('span.label-like', { id: 'card-for-label' }, t('dm.usuallyFor')), forChips,
  h('p.hint', null, t('dm.usuallyForHint')),
  h('label', { for: 'card-note' }, t('dm.note')), note,
  existing,
  h('label', { for: 'card-images' }, t('dm.images')), files,
  h('p.hint', null, t('dm.imagesHint')),
  progress,
  h('div.row.actions', null, save));

  const dialog = openDialog([closeButton(t('common.close')), form], { className: 'editor' });
  (card ? body : title).focus();
}

// ---------- Room: seats, joining, links, settings

function roomPane() {
  const name = /** @type {HTMLInputElement} */ (h('input', { id: 'room-name', maxlength: 80 }));
  const lock = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', id: 'lock' }));
  lock.addEventListener('change', () => call('/room', { method: 'PATCH', body: { joinLocked: lock.checked } }));
  const seats = h('div.list');
  const expiry = h('p.hint');
  const newSeat = /** @type {HTMLInputElement} */ (h('input', { maxlength: 40, placeholder: t('dm.seatName'), 'aria-label': t('dm.seatName') }));

  listeners.add(() => {
    const room = /** @type {any} */ (state.room);
    expiry.textContent = room?.expiresAt
      ? t('dm.expiryText', { days: room.expiryDays, date: new Intl.DateTimeFormat(lang, { dateStyle: 'long' }).format(room.expiresAt) })
      : t('dm.noExpiry');
    if (document.activeElement !== name) name.value = state.room?.name ?? '';
    lock.checked = Boolean(state.room?.joinLocked);
    seats.replaceChildren(...state.seats.map((seat) => h('div.seat-row', null,
      h('span.dot', { dataset: { status: seat.status ?? 'offline' } }),
      h('span.name', null, seat.name, h('small', null, t(`presence.${seat.status ?? (seat.claimed ? 'offline' : 'unclaimed')}`))),
      h('button', { type: 'button', onclick: () => personalLink(seat) }, t('dm.personalLink')),
      h('button', { type: 'button', onclick: () => seatMenu(seat) }, '⋯'))));
  });

  return h('section.pane.room', null,
    h('form.row', {
      onsubmit: (/** @type {Event} */ e) => {
        e.preventDefault();
        call('/room', { method: 'PATCH', body: { name: name.value } }).then((r) => r.ok && snackbar(t('common.saved')));
      },
    }, h('label', { for: 'room-name' }, t('dm.roomName')), name, h('button', { type: 'submit' }, t('common.save'))),

    h('h2', null, t('dm.players')),
    seats,
    h('form.row', {
      onsubmit: async (/** @type {Event} */ e) => {
        e.preventDefault();
        if ((await call('/seats', { method: 'POST', body: { name: newSeat.value } })).ok) newSeat.value = '';
      },
    }, newSeat, h('button', { type: 'submit' }, t('dm.addSeat'))),
    h('div.field.check', null, lock, h('label', { for: 'lock' }, t('dm.lockJoin')), h('small', null, t('dm.lockJoinHint'))),
    h('button', { type: 'button', onclick: showJoin }, t('dm.showJoin')),

    h('h2', null, t('dm.yourLink')),
    h('p.hint', null, t('dm.yourLinkHint')),
    h('div.row', null,
      h('button', { type: 'button', onclick: () => showSaveLink(false) }, t('dm.showLink')),
      h('button.danger', { type: 'button', onclick: resetKey }, t('dm.resetLink'))),

    h('h2', null, t('dm.keeping')),
    expiry,
    h('p.hint', null, t('dm.exportHint')),
    h('div.row', null,
      h('button', { type: 'button', onclick: (/** @type {Event} */ e) => exportCampaign(/** @type {HTMLButtonElement} */ (e.currentTarget)) }, t('dm.export')),
      h('button.danger', { type: 'button', onclick: deleteRoomDialog }, t('dm.deleteRoom'))),
  );
}

/** Downloads the whole campaign as one file (cards, images, notes, who has what). @param {HTMLButtonElement} button */
async function exportCampaign(button) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = t('dm.exporting');
  try {
    const response = await fetch(`/api/rooms/${state.code}/export`, { headers: { authorization: `Bearer ${state.key}` } }).catch(() => null);
    if (!response?.ok) return snackbar(errorText(response ? 'generic' : 'network'));
    const blob = await response.blob();
    const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'campaign.whisperer.json';
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: name, hidden: true });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

/** Deleting is permanent, so the DM types the room code to confirm. */
function deleteRoomDialog() {
  const code = formatRoomCode(state.code);
  const input = /** @type {HTMLInputElement} */ (h('input', {
    id: 'delete-confirm', autocomplete: 'off', autocapitalize: 'characters', spellcheck: false, placeholder: code,
  }));
  const go = /** @type {HTMLButtonElement} */ (h('button.danger', { type: 'button', disabled: true }, t('dm.deleteRoom')));
  input.addEventListener('input', () => (go.disabled = normalizeRoomCode(input.value) !== state.code));
  go.addEventListener('click', async () => {
    go.disabled = true;
    const result = await call('/room', { method: 'DELETE' });
    if (!result.ok) return void (go.disabled = false);
    dialog.close();
    roomGone(state.code, t('dm.roomDeleted'));
  });
  const dialog = openDialog([
    closeButton(t('common.close')),
    h('h2', null, t('dm.deleteRoomTitle')),
    h('p', null, t('dm.deleteRoomText')),
    h('label', { for: 'delete-confirm' }, t('dm.deleteRoomType', { code })), input,
    h('div.dialog-footer', null, go),
  ]);
  input.focus();
}

/** This device's preferences (not the room's): keep screen on, theme, language. */
function settingsPane() {
  const awake = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', id: 'dm-awake', checked: storage.prefs().keepAwake === true, disabled: !wake.supported }));
  awake.addEventListener('change', () => {
    storage.savePrefs({ keepAwake: awake.checked });
    wake.set(awake.checked);
  });
  const language = /** @type {HTMLSelectElement} */ (h('select', { id: 'dm-language' },
    ...LANGUAGES.map((l) => h('option', { value: l.code, selected: l.code === lang }, l.name))));
  language.addEventListener('change', () => {
    setLanguage(language.value);
    location.reload();
  });

  return h('section.pane.settings', null,
    h('h2', null, t('dm.thisDevice')),
    h('div.field.check', null, awake, h('label', { for: 'dm-awake' }, t('settings.keepAwake')),
      h('small', null, wake.supported ? t('settings.keepAwakeHint') : t('settings.noKeepAwake'))),
    themeField('dm-theme', t('settings.theme'), (theme) => t(`theme.${theme}`), storage),
    h('div.field', null, h('label', { for: 'dm-language' }, t('settings.language')), language),
    h('p', null, h('a', { href: '/privacy' }, t('settings.privacy'))),
  );
}

/** @param {Seat} seat */
function seatMenu(seat) {
  openDialog([
    closeButton(t('common.close')),
    h('h2', null, seat.name),
    h('div.stack', null,
      h('button', {
        type: 'button',
        onclick: async (/** @type {Event} */ e) => {
          const next = prompt(t('dm.rename'), seat.name);
          if (next && next !== seat.name) await call(`/seats/${seat.id}`, { method: 'PATCH', body: { name: next } });
          /** @type {HTMLElement} */ (e.target).closest('dialog')?.close();
        },
      }, t('dm.rename')),
      seat.claimed && h('button', {
        type: 'button',
        onclick: async (/** @type {Event} */ e) => {
          if (!confirm(t('dm.releaseConfirm', { name: seat.name }))) return;
          await call(`/seats/${seat.id}/release`, { method: 'POST' });
          /** @type {HTMLElement} */ (e.target).closest('dialog')?.close();
        },
      }, t('dm.release')),
      h('button.danger', {
        type: 'button',
        onclick: async (/** @type {Event} */ e) => {
          if (!confirm(t('dm.removeSeatConfirm', { name: seat.name }))) return;
          await call(`/seats/${seat.id}`, { method: 'DELETE' });
          /** @type {HTMLElement} */ (e.target).closest('dialog')?.close();
        },
      }, t('dm.removeSeat'))),
  ]);
}

/**
 * Where players' phones reach this server. On a laptop the DM sees "localhost", which a phone can't use,
 * so self-hosted mode offers the machine's network addresses instead.
 */
function joinBases() {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (config.mode === 'local' && (local || config.lanUrls.length)) return config.lanUrls.length ? config.lanUrls : [location.origin];
  return [location.origin];
}

function showJoin() {
  const bases = joinBases();
  const holder = h('div.join');
  const draw = (/** @type {string} */ base) => {
    const url = `${base}/play?r=${state.code}`;
    holder.replaceChildren(
      qrSvg(url),
      h('p.code-big', null, formatRoomCode(state.code)),
      linkBox(url, t('dm.joinTitle')));
  };
  const picker = bases.length > 1 && h('select', {
    'aria-label': t('dm.address'),
    onchange: (/** @type {Event} */ e) => draw(/** @type {HTMLSelectElement} */ (e.target).value),
  }, ...bases.map((b) => h('option', { value: b }, b)));
  openDialog([closeButton(t('common.close')), h('h2', null, t('dm.joinTitle')), picker, holder,
    config.mode === 'local' && h('p.hint', null, t('dm.localJoinHint'))], { className: 'join-dialog' });
  draw(bases[0]);
}

/** A new personal link for a seat (the previous one stops working). @param {Seat} seat */
async function personalLink(seat) {
  if (seat.hasLink && !confirm(t('dm.newLinkConfirm', { name: seat.name }))) return;
  const result = await call(`/seats/${seat.id}/link`, { method: 'POST' });
  if (!result.ok) return;
  const url = `${joinBases()[0]}/play#r=${state.code}&s=${result.data.secret}`;
  openDialog([
    closeButton(t('common.close')),
    h('h2', null, t('dm.linkFor', { name: seat.name })),
    h('p.hint', null, t('dm.linkHint')),
    qrSvg(url),
    linkBox(url, t('dm.linkFor', { name: seat.name })),
  ], { className: 'join-dialog' });
}

/**
 * A read-only link with its Copy button joined to it.
 * @param {string} url @param {string} label @param {string} [failed]  What to say if copying isn't possible.
 */
function linkBox(url, label, failed = url) {
  const field = /** @type {HTMLInputElement} */ (h('input', { readonly: true, value: url, 'aria-label': label }));
  field.addEventListener('focus', () => field.select());
  return h('div.input-group', null, field,
    h('button.primary', { type: 'button', onclick: async () => snackbar((await copyText(url)) ? t('common.copied') : failed) }, t('common.copy')));
}

/** Asks the DM to save their link (the only way back into the room). @param {boolean} first */
function showSaveLink(first) {
  const link = dmLink(location.origin);
  const saved = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', id: 'saved-link' }));
  const done = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', disabled: first }, t('common.continue')));
  saved.addEventListener('change', () => {
    done.disabled = !saved.checked;
    done.classList.toggle('primary', saved.checked); // once saved, Continue becomes the thing to press
  });
  const mail = `mailto:?subject=${encodeURIComponent(t('dm.mailSubject'))}&body=${encodeURIComponent(link)}`;

  const dialog = openDialog([
    !first && closeButton(t('common.close')),
    h('h2', null, t('dm.saveLinkTitle')),
    h('p', null, t('dm.saveLinkText')),
    // The link with its Copy button joined to it; emailing is the quieter alternative below.
    linkBox(link, t('dm.yourLink'), t('dm.copyFailed')),
    h('p.alt', null, h('a', { href: mail }, t('dm.emailLink'))),
    h('div.dialog-footer', null,
      first && h('div.field.check', null, saved, h('label', { for: 'saved-link' }, t('dm.savedIt'))),
      done),
  ].filter(/** @returns {x is HTMLElement} */ (x) => Boolean(x)), { className: 'save-link' });
  done.addEventListener('click', () => {
    storage.saveDmRoom(state.code, { key: state.key, savedLink: true });
    dialog.close();
  });
  if (first) dialog.addEventListener('cancel', (e) => e.preventDefault()); // Escape can't skip it
}

async function resetKey() {
  if (!confirm(t('dm.resetConfirm'))) return;
  rotating = true;
  const result = await call('/rotate-key', { method: 'POST' });
  if (result.ok) {
    fallbackKey = null;
    setKey(result.data.adminKey);
    storage.saveDmRoom(state.code, { key: state.key, savedLink: false });
  }
  socket?.reconnect();
  rotating = false;
  if (result.ok) showSaveLink(true);
}

// The room is chosen by the #fragment (e.g. links on "My rooms"), and changing only the fragment doesn't
// reload the page, so start over when it changes. (start() itself uses replaceState, which doesn't trigger this.)
addEventListener('hashchange', () => location.reload());

// Last, so every module-level variable above exists before anything runs.
translatePage();
start();
