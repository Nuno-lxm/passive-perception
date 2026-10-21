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
