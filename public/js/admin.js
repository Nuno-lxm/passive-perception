// @ts-check
// The operator's page: read reports, look at the reported card, freeze or delete a room. English only.
// The token is kept for this browser tab only (sessionStorage).
import { $, h, openDialog, closeButton, snackbar } from './ui.js';
import { formatRoomCode, normalizeRoomCode } from './room-code.js';

const KEY = 'whisperer.adminToken';
const REASONS = { bug: 'Bug or problem with the app', illegal: 'Illegal content', abuse: 'Harassment, hate or threats', child: 'Sexual content involving a minor', other: 'Something else' };

/** @param {string} path @param {RequestInit} [init] */
async function adminFetch(path, init = {}) {
  const token = sessionStorage.getItem(KEY) ?? '';
  const response = await fetch(`/api/admin${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
  }).catch(() => null);
  if (response?.status === 401) {
    sessionStorage.removeItem(KEY);
    showLogin('That token is not right.');
  }
  return response;
}

/** @param {string} [message] */
function showLogin(message = '') {
  $('#login').hidden = false;
  $('#admin-error').textContent = message;
  $('#reports').replaceChildren();
}

$('#login').addEventListener('submit', (event) => {
  event.preventDefault();
  sessionStorage.setItem(KEY, /** @type {HTMLInputElement} */ ($('#token')).value.trim());
  $('#login').hidden = true;
  load();
});

async function load() {
  loadStats();
  const response = await adminFetch('/reports');
  if (!response) return void ($('#admin-error').textContent = 'No connection.');
  if (response.status === 404) return void ($('#admin-error').textContent = 'Reporting is not set up on this server (no ADMIN_TOKEN).');
  if (!response.ok) return;
  $('#admin-error').textContent = '';
  const { reports } = await response.json();
  $('#reports').replaceChildren(
    ...(reports.length ? reports.map(reportCard) : [h('p.hint', null, 'No reports. 🎉')]),
  );
}

// ---------- Stats

async function loadStats() {
  const response = await adminFetch('/stats');
  if (!response?.ok) return;
  const stats = await response.json();
  const mb = (/** @type {number} */ bytes) => `${(bytes / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
  const share = stats.storage.bytes / stats.storage.limit;
  const sum = (/** @type {string} */ key) => stats.days.reduce((n, d) => n + d[key], 0);
  $('#stats').replaceChildren(
    h('div.stat-tiles', null,
      tile('Active rooms', stats.rooms.activeWeek, `used in the last 7 days · ${stats.rooms.activeMonth} in 30 days`),
      tile('Rooms', stats.rooms.total, 'existing now (unused ones expire after 60 days)'),
      h('div.tile', null,
        h('span.tile-label', null, 'Storage'),
        h('strong.tile-value', null, mb(stats.storage.bytes)),
        h('div.meter', { role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': stats.storage.limit, 'aria-valuenow': stats.storage.bytes, 'aria-label': 'Storage used' },
          h('span', { style: `width: ${Math.min(100, share * 100).toFixed(1)}%` })),
        h('span.tile-note', null, `of ${mb(stats.storage.limit)} free · ${(share * 100).toFixed(1)}% used`)),
      tile('Open reports', stats.reports.open, stats.reports.open ? 'see below' : 'nothing to do')),
    barChart('Reveals per day', 'reveals', stats.days, sum('reveals')),
    barChart('Rooms created per day', 'roomsCreated', stats.days, sum('roomsCreated')),
    barChart('Players joining per day', 'joins', stats.days, sum('joins')),
    h('details.stat-table', null,
      h('summary', null, 'Show the last 30 days as a table'),
      h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Day'), h('th', null, 'Reveals'), h('th', null, 'Rooms created'), h('th', null, 'Players joining'))),
        h('tbody', null, ...[...stats.days].reverse().map((d) =>
          h('tr', null, h('td', null, d.day), h('td', null, d.reveals), h('td', null, d.roomsCreated), h('td', null, d.joins)))))),
  );
}

/** @param {string} label @param {number} value @param {string} note */
function tile(label, value, note) {
  return h('div.tile', null, h('span.tile-label', null, label), h('strong.tile-value', null, value.toLocaleString()), h('span.tile-note', null, note));
}

/**
 * One series per chart (never two scales on one chart). Bars share the theme's accent; values on hover/focus.
 * @param {string} title @param {string} key @param {any[]} days @param {number} total
 */
function barChart(title, key, days, total) {
  const max = Math.max(1, ...days.map((d) => d[key]));
  const tip = h('div.bar-tip', { role: 'status', hidden: true });
  const label = (/** @type {any} */ d) => `${new Date(`${d.day}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}: ${d[key].toLocaleString()}`;
  const bars = h('div.bars', null, ...days.map((d) => {
    const bar = h('div.bar-slot', { tabindex: 0, 'aria-label': label(d) },
      h('span.bar-fill', { style: `height: ${d[key] ? Math.max(2, (d[key] / max) * 100) : 0}%` }));
    const show = () => {
      tip.textContent = label(d);
      tip.hidden = false;
      tip.style.left = `${bar.offsetLeft + bar.offsetWidth / 2}px`;
    };
    bar.addEventListener('pointerenter', show);
    bar.addEventListener('focus', show);
    bar.addEventListener('pointerleave', () => (tip.hidden = true));
    bar.addEventListener('blur', () => (tip.hidden = true));
    return bar;
  }));
  return h('figure.bar-chart', null,
    h('figcaption', null, h('strong', null, title), h('span.tile-note', null, ` ${total.toLocaleString()} in 30 days · peak ${max.toLocaleString()}`)),
    h('div.bar-area', null, h('span.bar-max', null, max.toLocaleString()), bars, tip),
    h('div.bar-axis', null, h('span', null, days[0].day.slice(5)), h('span', null, 'today')));
}

// ---------- Reports

/** @param {any} report */
function reportCard(report) {
  const roomBox = h('div.admin-room');
  const snapshot = report.snapshot;
  const card = h(`article.note${report.status === 'closed' ? '.closed' : ''}`, null,
    h('p.meta', null,
      `${new Date(report.createdAt).toLocaleString()} · ${report.kind === 'player' ? 'from a player' : 'from the public form'} · `,
      h('strong', null, REASONS[/** @type {keyof REASONS} */ (report.reason)] ?? report.reason),
      report.status === 'closed' ? ' · closed' : ''),
    report.note && h('p', null, h('strong', null, 'Note: '), report.note),
    report.contact && h('p', null, h('strong', null, 'Contact: '), h('a', { href: `mailto:${report.contact}` }, report.contact)),
    snapshot && h('div.snapshot', null,
      h('p.meta', null, `Room “${snapshot.roomName}”, reported by seat “${snapshot.seat}”`),
      snapshot.title && h('h3', null, snapshot.title),
      snapshot.body && h('p.body', null, snapshot.body),
      snapshot.images?.length > 0 && h('div.images', null, ...snapshot.images.map((/** @type {string} */ id) => adminImage(report.roomCode, id)))),
    report.roomCode && roomBox,
    h('div.row.actions', null,
      h('button', { type: 'button', onclick: async () => { await adminFetch(`/reports/${report.id}/${report.status === 'open' ? 'close' : 'reopen'}`, { method: 'POST', body: '{}' }); load(); } },
        report.status === 'open' ? 'Close report' : 'Reopen'),
      h('button.danger', { type: 'button', onclick: async () => { if (confirm('Delete this report?')) { await adminFetch(`/reports/${report.id}`, { method: 'DELETE' }); load(); } } }, 'Delete report')));
  if (report.roomCode) loadRoom(report.roomCode, roomBox);
  return card;
}

/** @param {string} code @param {HTMLElement} box */
async function loadRoom(code, box) {
  const response = await adminFetch(`/rooms/${code}/info`);
  if (!response?.ok) return box.replaceChildren(h('p.meta', null, `Room ${formatRoomCode(code)}: no longer exists.`));
  const room = await response.json();
  box.replaceChildren(
    h('p.meta', null, `Room ${formatRoomCode(code)} “${room.name}” · ${room.cards} cards · ${(room.imageBytes / 1e6).toFixed(1)} MB images · last used ${new Date(room.lastActiveAt).toLocaleDateString()}${room.frozen ? ' · FROZEN' : ''}`),
    h('div.row', null,
      h('button', {
        type: 'button',
        onclick: async () => {
          await adminFetch(`/rooms/${code}/freeze`, { method: 'POST', body: JSON.stringify({ frozen: !room.frozen }) });
          snackbar(room.frozen ? 'Room unfrozen.' : 'Room frozen: the DM can’t change it, players see nothing.');
          loadRoom(code, box);
        },
      }, room.frozen ? 'Unfreeze room' : 'Freeze room'),
      h('button.danger', { type: 'button', onclick: () => deleteRoom(code, box) }, 'Delete room')));
}

/** @param {string} code @param {HTMLElement} box */
function deleteRoom(code, box) {
  const input = /** @type {HTMLInputElement} */ (h('input', { autocomplete: 'off', placeholder: formatRoomCode(code) }));
  const go = /** @type {HTMLButtonElement} */ (h('button.danger', { type: 'button', disabled: true }, 'Delete room'));
  input.addEventListener('input', () => (go.disabled = normalizeRoomCode(input.value) !== code));
  go.addEventListener('click', async () => {
    await adminFetch(`/rooms/${code}/delete`, { method: 'POST', body: '{}' });
    dialog.close();
    loadRoom(code, box);
  });
  const dialog = openDialog([closeButton('Close'), h('h2', null, 'Delete this room?'),
    h('p', null, 'Everything in it is deleted for good, and everyone in it is signed out.'),
    h('label', null, `Type ${formatRoomCode(code)} to confirm`), input, h('div.dialog-footer', null, go)]);
}

/** @param {string} code @param {string} id */
function adminImage(code, id) {
  const img = /** @type {HTMLImageElement} */ (h('img', { alt: '' }));
  adminFetch(`/rooms/${code}/images/${id}?thumb=1`).then(async (r) => {
    if (r?.ok) img.src = URL.createObjectURL(await r.blob());
    else img.alt = 'image no longer available';
  });
  return h('div.thumb', null, img);
}

if (sessionStorage.getItem(KEY)) load();
else showLogin();
