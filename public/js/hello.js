// @ts-check
// M0 placeholder: shows which host is serving the app and whether its storage works.
import { config } from '../config.js';

const status = /** @type {HTMLElement} */ (document.getElementById('status'));
try {
  const health = await fetch('/api/health').then((r) => r.json());
  status.textContent = JSON.stringify({ config, health }, null, 2);
} catch (error) {
  status.textContent = `Server unreachable: ${error}`;
}
