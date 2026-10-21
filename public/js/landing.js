// @ts-check
// Landing page: join a room by code, or create one (which opens the DM page with the new DM link).
import { errorText, LANGUAGES, lang, setLanguage, translatePage } from './i18n.js';
import { api } from './net.js';
import { normalizeRoomCode } from './room-code.js';
import { saveDmRoom } from './storage.js';
import { $, h } from './ui.js';
import { t } from './i18n.js';

translatePage();

const language = /** @type {HTMLSelectElement} */ ($('#language'));
language.replaceChildren(...LANGUAGES.map((l) => h('option', { value: l.code, selected: l.code === lang }, l.name)));
language.addEventListener('change', () => {
  setLanguage(language.value);
  translatePage();
});

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
  saveDmRoom(result.data.code, { key: result.data.adminKey, name, savedLink: false });
  location.href = `/dm#r=${result.data.code}&k=${result.data.adminKey}`;
});
