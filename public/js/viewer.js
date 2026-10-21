// @ts-check
// Full-screen image viewer: pinch to zoom, drag to pan, double-tap to zoom in/out, swipe down or back to close.
// Pointer events only, no library.
import { closeButton, h, openDialog } from './ui.js';
import { t } from './i18n.js';

const MAX_SCALE = 6;

/** @param {string} src  An object URL. @param {string} [alt] */
export function openViewer(src, alt = '') {
  const img = /** @type {HTMLImageElement} */ (h('img', { src, alt, draggable: false }));
  const stage = h('div.viewer-stage', null, img);
  openDialog([closeButton(t('common.close')), stage], { className: 'viewer' });

  let scale = 1;
  let x = 0;
  let y = 0;
  /** @type {Map<number, { x: number, y: number }>} */
  const pointers = new Map();
  /** @type {{ dist: number, scale: number, mid: { x: number, y: number }, x: number, y: number } | null} */
  let pinch = null;
  let lastTap = 0;
  let swipeStartY = /** @type {number | null} */ (null);

  const apply = () => {
    img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  };

  /** Keeps the image from being dragged entirely off screen. */
  const clamp = () => {
    const rect = stage.getBoundingClientRect();
    const maxX = (rect.width * (scale - 1)) / 2;
    const maxY = (rect.height * (scale - 1)) / 2;
    x = Math.max(-maxX, Math.min(maxX, x));
    y = Math.max(-maxY, Math.min(maxY, y));
  };

  /** Zooms around a point on screen. @param {number} next @param {number} cx @param {number} cy */
  const zoomAt = (next, cx, cy) => {
    const rect = stage.getBoundingClientRect();
    const px = cx - rect.left - rect.width / 2;
    const py = cy - rect.top - rect.height / 2;
    const ratio = next / scale;
    x = px - (px - x) * ratio;
    y = py - (py - y) * ratio;
    scale = next;
    if (scale <= 1) { scale = 1; x = 0; y = 0; }
    clamp();
    apply();
  };

  stage.addEventListener('pointerdown', (event) => {
    stage.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, x, y };
    } else if (pointers.size === 1) {
      const now = Date.now();
      if (now - lastTap < 300) {
        zoomAt(scale > 1 ? 1 : 2.5, event.clientX, event.clientY);
        lastTap = 0;
      } else {
        lastTap = now;
      }
      swipeStartY = scale === 1 ? event.clientY : null;
    }
  });

  stage.addEventListener('pointermove', (event) => {
    const prev = pointers.get(event.pointerId);
    if (!prev) return;
    const point = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, point);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const next = Math.max(1, Math.min(MAX_SCALE, (pinch.scale * dist) / pinch.dist));
      zoomAt(next, pinch.mid.x, pinch.mid.y);
    } else if (pointers.size === 1 && scale > 1) {
      x += point.x - prev.x;
      y += point.y - prev.y;
      clamp();
      apply();
    } else if (swipeStartY !== null) {
      img.style.transform = `translateY(${Math.max(0, point.y - swipeStartY)}px)`;
    }
  });

  const end = (/** @type {PointerEvent} */ event) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (swipeStartY !== null && pointers.size === 0) {
      const dragged = event.clientY - swipeStartY;
      swipeStartY = null;
      if (dragged > 120) return /** @type {HTMLDialogElement} */ (stage.closest('dialog')).close();
      apply();
    }
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);

  stage.addEventListener('wheel', (event) => {
    event.preventDefault();
    zoomAt(Math.max(1, Math.min(MAX_SCALE, scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15))), event.clientX, event.clientY);
  }, { passive: false });
}
