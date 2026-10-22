// @ts-check
// The public report form: anyone can flag content, not only players in the room.
import { config } from '../config.js';
import { errorText, translatePage } from './i18n.js';
import { api } from './net.js';
import { $ } from './ui.js';

translatePage();

const form = /** @type {HTMLFormElement} */ ($('#report-form'));
if (!config.reports) {
  form.hidden = true;
  $('#report-off').hidden = false;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = /** @type {HTMLButtonElement} */ (form.querySelector('button[type=submit]'));
  button.disabled = true;
  const value = (/** @type {string} */ id) => /** @type {HTMLInputElement} */ ($(id)).value;
  const result = await api('/report', {
    method: 'POST',
    body: { reason: value('#reason'), roomCode: value('#room'), note: value('#note'), contact: value('#contact') },
  });
  button.disabled = false;
  if (!result.ok) return void ($('#report-error').textContent = errorText(result.error));
  form.hidden = true;
  $('#report-done').hidden = false;
});
