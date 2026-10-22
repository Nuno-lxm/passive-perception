// @ts-check
// The operator's page: read reports, look at the reported card, freeze or delete a room. English only.
// The token is kept for this browser tab only (sessionStorage).
import { $, h, openDialog, closeButton, snackbar } from './ui.js';
import { formatRoomCode, normalizeRoomCode } from './room-code.js';

const KEY = 'whisperer.adminToken';
const REASONS = { illegal: 'Illegal content', abuse: 'Harassment, hate or threats', child: 'Sexual content involving a minor', other: 'Something else' };

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
