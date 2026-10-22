// @ts-check
// The privacy page: shows the text in the current language and fills in who runs this copy (site.js).
import { config } from '../config.js';
import { site } from '../site.js';
import { lang, translatePage } from './i18n.js';

translatePage();

if (config.mode === 'local') {
  /** @type {HTMLElement} */ (document.getElementById('local-notice')).hidden = false;
} else {
  const article = document.querySelector(`article[data-lang="${lang}"]`) ?? document.querySelector('article[data-lang="en"]');
  /** @type {HTMLElement} */ (article).hidden = false;
  for (const el of document.querySelectorAll('[data-site]')) {
    const key = /** @type {keyof typeof site} */ (/** @type {HTMLElement} */ (el).dataset.site);
    if (el instanceof HTMLAnchorElement) el.href = site[key];
    else el.textContent = site[key];
  }
  for (const el of document.querySelectorAll('a[data-site-email]')) {
    /** @type {HTMLAnchorElement} */ (el).href = `mailto:${site.contactEmail}`;
    el.textContent = site.contactEmail;
  }
}
