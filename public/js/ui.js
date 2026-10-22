// @ts-check
// Small DOM helpers. User content is only ever set as text (textContent), never as HTML.

/**
 * Creates an element. Strings among the children become text nodes.
 * @param {string} tag  e.g. 'button.primary'
 * @param {Record<string, any> | null} [attrs]  on* keys become listeners; class, dataset, and attributes otherwise.
 * @param {...(Node | string | number | false | null | undefined | (Node | string)[])} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name);
  if (classes.length) el.className = classes.join(' ');
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = [el.className, value].filter(Boolean).join(' ');
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'text') el.textContent = value;
    else if (key === 'style') el.style.cssText = value; // via CSSOM: the CSP blocks style="" attributes, not this
    else if (key in el && typeof value !== 'string') /** @type {any} */ (el)[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

/** @param {string} selector @returns {HTMLElement} */
export const $ = (selector) => /** @type {HTMLElement} */ (document.querySelector(selector));

/**
 * A short message at the bottom of the screen, optionally with an action (e.g. Undo).
 * @param {string} text @param {{ action?: string, onAction?: () => void, ms?: number }} [options]
 */
export function snackbar(text, { action, onAction, ms = 4000 } = {}) {
  document.querySelector('.snackbar')?.remove();
  const bar = h('div.snackbar', { role: 'status' }, h('span', null, text));
  if (action && onAction) {
    bar.append(h('button.link', { type: 'button', onclick: () => { bar.remove(); onAction(); } }, action));
  }
  document.body.append(bar);
  setTimeout(() => bar.remove(), ms);
}

/**
 * A modal dialog that closes with the back gesture too (it pushes a history entry).
 * @param {HTMLElement[]} content @param {{ className?: string, onClose?: () => void }} [options]
 */
export function openDialog(content, { className = '', onClose } = {}) {
  const dialog = /** @type {HTMLDialogElement} */ (h(`dialog.${['sheet', className].filter(Boolean).join('.')}`, null, ...content));
  document.body.append(dialog);
  dialog.showModal();
  history.pushState({ dialog: true }, '');
  const onPop = () => dialog.open && dialog.close();
  window.addEventListener('popstate', onPop);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close(); // tap on the backdrop
  });
  dialog.addEventListener('close', () => {
    window.removeEventListener('popstate', onPop);
    if (history.state?.dialog) history.back();
    dialog.remove();
    onClose?.();
  });
  return dialog;
}

/** The close (×) button used at the top of dialogs. @param {string} label */
export const closeButton = (label) =>
  h('button.icon.close', {
    type: 'button',
    'aria-label': label,
    onclick: (/** @type {Event} */ e) => /** @type {HTMLElement} */ (e.currentTarget).closest('dialog')?.close(),
  }, '×');

/**
 * Small line icons drawn in the current text colour, so they follow the theme. 24×24, built with DOM calls
 * (no innerHTML). Each shape is [tag, attributes]; `fill: true` fills it instead of outlining it.
 * @type {Record<string, [string, Record<string, string | number | boolean>][]>}
 */
const ICONS = {
  // Three finder squares and a few modules: reads as "QR code" at any size.
  qr: [
    ['rect', { x: 3.5, y: 3.5, width: 7, height: 7, rx: 1 }],
    ['rect', { x: 13.5, y: 3.5, width: 7, height: 7, rx: 1 }],
    ['rect', { x: 3.5, y: 13.5, width: 7, height: 7, rx: 1 }],
    ['rect', { x: 6, y: 6, width: 2, height: 2, fill: true }],
    ['rect', { x: 16, y: 6, width: 2, height: 2, fill: true }],
    ['rect', { x: 6, y: 16, width: 2, height: 2, fill: true }],
    ['rect', { x: 13.5, y: 13.5, width: 3, height: 3, fill: true }],
    ['rect', { x: 17.5, y: 17.5, width: 3, height: 3, fill: true }],
    ['rect', { x: 17.5, y: 13.5, width: 3, height: 2, fill: true }],
    ['rect', { x: 13.5, y: 18.5, width: 2, height: 2, fill: true }],
  ],
};

/** @param {keyof typeof ICONS} name */
export function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: 22, height: 22, 'aria-hidden': 'true', class: 'icon-svg' })) {
    svg.setAttribute(k, String(v));
  }
  for (const [tag, attrs] of ICONS[name]) {
    const shape = document.createElementNS(ns, tag);
    const { fill, ...rest } = attrs;
    for (const [k, v] of Object.entries(rest)) shape.setAttribute(k, String(v));
    shape.setAttribute('fill', fill ? 'currentColor' : 'none');
    if (!fill) {
      shape.setAttribute('stroke', 'currentColor');
      shape.setAttribute('stroke-width', '1.8');
    }
    svg.append(shape);
  }
  return svg;
}

/**
 * A QR code as SVG, drawn from qrcode-generator's matrix (vendor/qrcode.js).
 * @param {string} text
 */
export function qrSvg(text) {
  const qr = /** @type {any} */ (globalThis).qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `-4 -4 ${n + 8} ${n + 8}`);
  svg.setAttribute('class', 'qr');
  svg.setAttribute('role', 'img');
  const bg = document.createElementNS(ns, 'rect');
  Object.entries({ x: -4, y: -4, width: n + 8, height: n + 8, fill: '#fff' }).forEach(([k, v]) => bg.setAttribute(k, String(v)));
  svg.append(bg);
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000');
  svg.append(path);
  return svg;
}

/**
 * Copies text. navigator.clipboard needs HTTPS; on a plain-http LAN, fall back to selecting it.
 * @param {string} text @returns {Promise<boolean>}
 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = /** @type {HTMLTextAreaElement} */ (h('textarea', { readonly: true, class: 'offscreen' }));
    field.value = text;
    document.body.append(field);
    field.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    field.remove();
    return ok;
  }
}

/** Keeps the screen on while the page is visible, if the browser allows it (HTTPS only). */
export function screenWakeLock() {
  /** @type {any} */
  let lock = null;
  let wanted = false;
  const supported = 'wakeLock' in navigator && isSecureContext;
  async function acquire() {
    if (!wanted || lock || document.visibilityState !== 'visible') return;
    try {
      lock = await /** @type {any} */ (navigator).wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
    } catch {
      lock = null;
    }
  }
  // The browser releases the lock when the page is hidden; take it again on return.
  document.addEventListener('visibilitychange', acquire);
  return {
    supported,
    /** @param {boolean} on */
    set(on) {
      wanted = on && supported;
      if (wanted) acquire();
      else lock?.release().catch(() => {});
    },
  };
}

/**
 * The theme picker used in every Settings screen. Saves the choice and applies it at once.
 * @param {string} id @param {string} label @param {(theme: string) => string} optionLabel
 * @param {{ prefs: () => { theme?: string }, savePrefs: (p: { theme: string }) => void }} storage
 */
export function themeField(id, label, optionLabel, storage) {
  const saved = storage.prefs().theme ?? 'candlelit';
  const current = saved === 'daylight' ? 'light' : saved; // renamed
  const select = /** @type {HTMLSelectElement} */ (h('select', { id },
    ...THEMES.map((theme) => h('option', { value: theme, selected: theme === current }, optionLabel(theme)))));
  select.addEventListener('change', () => {
    storage.savePrefs({ theme: select.value });
    applyTheme(select.value);
  });
  return h('div.field', null, h('label', { for: id }, label), select);
}

/** The themes a device can pick; 'auto' follows the device's light/dark setting (Light or Dark). */
export const THEMES = ['candlelit', 'light', 'dark', 'auto'];
const BAR_COLOURS = { candlelit: '#1c1612', light: '#1f1f23', dark: '#0f1011' };

/**
 * Switches theme now (js/theme.js applies it on page load). Saved per device.
 * @param {string} choice  'candlelit' | 'light' | 'dark' | 'auto'
 */
export function applyTheme(choice) {
  const light = matchMedia('(prefers-color-scheme: light)').matches;
  const theme = choice === 'auto' ? (light ? 'light' : 'dark') : choice;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themeChoice = choice;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BAR_COLOURS[/** @type {keyof BAR_COLOURS} */ (theme)] ?? BAR_COLOURS.candlelit);
}

// "Match this device" follows the device when it switches between light and dark.
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (document.documentElement.dataset.themeChoice === 'auto') applyTheme('auto');
});
