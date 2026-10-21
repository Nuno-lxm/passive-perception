// @ts-check
// Translations. Locale files are flat { key: string | { one, other } } objects.
// Language: saved choice → browser languages → English. Any pt-* gets pt-PT until someone contributes pt-BR.
import en from './locales/en.js';
import ptPT from './locales/pt-PT.js';
import { prefs, savePrefs } from './storage.js';

/** @type {Record<string, Record<string, string | Record<string, string>>>} */
const LOCALES = { en, 'pt-PT': ptPT };
export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'pt-PT', name: 'Português' },
];

export let lang = pickLanguage();

function pickLanguage() {
  const saved = prefs().lang;
  if (saved && LOCALES[saved]) return saved;
  for (const wanted of navigator.languages ?? [navigator.language]) {
    if (LOCALES[wanted]) return wanted;
    if (wanted.toLowerCase().startsWith('pt')) return 'pt-PT';
    if (wanted.toLowerCase().startsWith('en')) return 'en';
  }
  return 'en';
}

/** @param {string} code */
export function setLanguage(code) {
  if (!LOCALES[code]) return;
  lang = code;
  savePrefs({ lang: code });
  document.documentElement.lang = code;
}

/**
 * @param {string} key
 * @param {Record<string, string | number>} [vars]  {name} placeholders; `count` also picks the plural form.
 */
export function t(key, vars = {}) {
  let entry = LOCALES[lang][key] ?? en[key];
  if (entry === undefined) {
    console.warn(`missing translation: ${key}`);
    return key;
  }
  if (typeof entry === 'object') {
    const form = new Intl.PluralRules(lang).select(Number(vars.count ?? 0));
    entry = entry[form] ?? entry.other;
  }
  return String(entry).replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

/** Translates an error code from the server or the network layer. @param {string | undefined} code */
export function errorText(code) {
  const key = `error.${code}`;
  return key in en ? t(key) : t('error.generic');
}

/** Fills elements that have a data-i18n attribute (text), or data-i18n-placeholder / -aria-label / -title. */
export function translatePage(root = document) {
  document.documentElement.lang = lang;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(/** @type {string} */ (el.getAttribute('data-i18n')));
  for (const attr of ['placeholder', 'aria-label', 'title']) {
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) {
      el.setAttribute(attr, t(/** @type {string} */ (el.getAttribute(`data-i18n-${attr}`))));
    }
  }
}

/** "21 Oct", "21 out." */
export const formatDate = (/** @type {number} */ ms) =>
  new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short' }).format(ms);

/** "20:45" */
export const formatTime = (/** @type {number} */ ms) =>
  new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' }).format(ms);

/** "Today 20:45", "21 Oct 20:45" */
export function formatWhen(/** @type {number} */ ms) {
  const sameDay = new Date(ms).toDateString() === new Date().toDateString();
  return sameDay ? formatTime(ms) : `${formatDate(ms)} ${formatTime(ms)}`;
}
