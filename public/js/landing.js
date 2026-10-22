// @ts-check
// Landing page: join a room by code, or create one (which opens the DM page with the new DM link).
import { errorText, LANGUAGES, lang, setLanguage, translatePage } from './i18n.js';
import { api } from './net.js';
import { formatRoomCode } from './room-code.js';
import { config } from '../config.js';
import { site } from '../site.js';
import { normalizeRoomCode } from './room-code.js';
import * as storage from './storage.js';
import { $, h, themeField } from './ui.js';
import { t } from './i18n.js';

translatePage();

// Links from site.js; a self-hosted copy skips the introduction and goes straight to joining and creating.
/** @type {HTMLAnchorElement} */ ($('#repo-link')).href = site.repoUrl;
/** @type {HTMLAnchorElement} */ ($('#selfhost-link')).href = `${site.repoUrl}#run-your-own`;
if (config.mode === 'local') for (const el of document.querySelectorAll('.marketing')) /** @type {HTMLElement} */ (el).hidden = true;

const language = /** @type {HTMLSelectElement} */ ($('#language'));
language.replaceChildren(...LANGUAGES.map((l) => h('option', { value: l.code, selected: l.code === lang }, l.name)));
language.addEventListener('change', () => {
  setLanguage(language.value);
  location.reload(); // also re-labels the theme picker
});
/** @type {HTMLElement} */ ($('#language').closest('.field')).after(themeField('theme', t('settings.theme'), (theme) => t(`theme.${theme}`), storage));

$('#join').addEventListener('submit', (event) => {
  event.preventDefault();
  const code = normalizeRoomCode(/** @type {HTMLInputElement} */ ($('#join-code')).value);
  if (!code) return ($('#join-error').textContent = t('join.badCode'));
  location.href = `/play?r=${code}`;
});

$('#create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = /** @type {HTMLButtonElement} */ ($('#create-form button[type=submit]'));
  button.disabled = true;
  const name = /** @type {HTMLInputElement} */ ($('#room-name')).value;
  const seats = /** @type {HTMLTextAreaElement} */ ($('#seats')).value.split('\n').map((s) => s.trim()).filter(Boolean);
  const result = await api('/rooms', { method: 'POST', body: { name, seats } });
  button.disabled = false;
  if (!result.ok) return ($('#create-error').textContent = errorText(result.error));
  storage.saveDmRoom(result.data.code, { key: result.data.adminKey, name, savedLink: false });
  location.href = `/dm#r=${result.data.code}&k=${result.data.adminKey}`;
});

// ---------- Start from an export file

const BATCH_BYTES = 3_500_000; // keeps each upload well under the servers' request limits

$('#import-file').addEventListener('change', async (event) => {
  const input = /** @type {HTMLInputElement} */ (event.target);
  const summary = $('#import-summary');
  const picked = input.files?.[0];
  summary.replaceChildren();
  if (!picked) return;
  /** @type {any} */
  let file;
  try {
    file = JSON.parse(await picked.text());
  } catch {
    file = null;
  }
  if (!file || file.format !== 'tabletop-whisperer' || !Array.isArray(file.cards) || !Array.isArray(file.seats)) {
    return summary.replaceChildren(h('p.error', null, t('landing.badFile')));
  }
  if (file.version > 1) return summary.replaceChildren(h('p.error', null, t('landing.newerFile')));

  const images = file.cards.reduce((n, c) => n + (c.images?.length ?? 0), 0);
  const revealed = file.cards.some((c) => c.publicAt != null || c.grants?.length);
  const keep = /** @type {HTMLInputElement} */ (h('input', { type: 'radio', name: 'reveals', id: 'keep', value: 'keep', checked: true }));
  const fresh = /** @type {HTMLInputElement} */ (h('input', { type: 'radio', name: 'reveals', id: 'fresh', value: 'fresh' }));
  const progress = h('p.hint', { role: 'status' });
  const error = h('p.error', { role: 'alert' });
  const go = /** @type {HTMLButtonElement} */ (h('button.primary', { type: 'button' }, t('landing.createFromFile')));
  go.addEventListener('click', () => importCampaign(file, revealed && keep.checked, go, progress, error));

  summary.replaceChildren(
    h('p', null, h('strong', null, file.room?.name ?? ''), ' · ',
      [t('landing.cardCount', { count: file.cards.length }), t('landing.imageCount', { count: images }), t('landing.playerCount', { count: file.seats.length })].join(', ')),
    revealed && h('div.choice', null,
      h('label.option', { for: 'keep' }, keep, h('span', null, h('strong', null, t('landing.keepReveals')), h('small', null, t('landing.keepRevealsHint')))),
      h('label.option', { for: 'fresh' }, fresh, h('span', null, h('strong', null, t('landing.startFresh')), h('small', null, t('landing.startFreshHint'))))),
    error, progress, go,
  );
});

/**
 * Creates a room for the file, then sends the cards in batches of a few MB. Seat ids in the file are mapped to the
 * new room's by name. If anything fails, the half-made room is deleted again.
 * @param {any} file @param {boolean} keepReveals @param {HTMLButtonElement} go @param {HTMLElement} progress @param {HTMLElement} error
 */
async function importCampaign(file, keepReveals, go, progress, error) {
  go.disabled = true;
  error.textContent = '';
  progress.textContent = t('landing.creatingRoom');
  const made = await api('/rooms', { method: 'POST', body: { name: file.room?.name, seats: file.seats.map((s) => s.name), import: true } });
  if (!made.ok) {
    go.disabled = false;
    progress.textContent = '';
    return (error.textContent = errorText(made.error));
  }
  const { code, adminKey } = made.data;
  const fail = async (/** @type {string | undefined} */ reason) => {
    await api(`/rooms/${code}/room`, { method: 'DELETE', auth: adminKey });
    go.disabled = false;
    progress.textContent = '';
    error.textContent = errorText(reason);
  };

  const info = await api(`/rooms/${code}`);
  if (!info.ok) return fail(info.error);
  const byName = new Map(info.data.seats.map((/** @type {any} */ s) => [s.name.toLocaleLowerCase(), s.id]));
  const seatId = new Map(file.seats.map((/** @type {any} */ s) => [s.id, byName.get(String(s.name).toLocaleLowerCase())]));
  const cards = file.cards.map((/** @type {any} */ c) => ({
    ...c,
    forSeats: (c.forSeats ?? []).map((/** @type {string} */ id) => seatId.get(id)).filter(Boolean),
    grants: keepReveals ? (c.grants ?? []).map((/** @type {any} */ g) => ({ ...g, seatId: seatId.get(g.seatId) })).filter((/** @type {any} */ g) => g.seatId) : [],
    publicAt: keepReveals ? c.publicAt : null,
  }));

  let sent = 0;
  /** @type {any[]} */
  let batch = [];
  let size = 0;
  const flush = async () => {
    const result = await api(`/rooms/${code}/import`, {
      method: 'POST', auth: adminKey, body: { cards: batch, sessions: sent === 0 && keepReveals ? file.sessions ?? [] : [] },
    });
    if (!result.ok) return result.error ?? 'generic';
    sent += batch.length;
    batch = [];
    size = 0;
    progress.textContent = t('landing.importing', { n: sent, count: cards.length });
    return null;
  };
  for (const card of cards) {
    const cardSize = JSON.stringify(card).length;
    if (batch.length && (size + cardSize > BATCH_BYTES || batch.length >= 100)) {
      const failed = await flush();
      if (failed) return fail(failed);
    }
    batch.push(card);
    size += cardSize;
  }
  if (batch.length || sent === 0) {
    const failed = await flush();
    if (failed) return fail(failed);
  }
  const done = await api(`/rooms/${code}/import/done`, { method: 'POST', auth: adminKey });
  if (!done.ok) return fail(done.error);

  storage.saveDmRoom(code, { key: adminKey, name: file.room?.name, savedLink: false });
  progress.textContent = formatRoomCode(code);
  location.href = `/dm#r=${code}&k=${adminKey}`;
}
