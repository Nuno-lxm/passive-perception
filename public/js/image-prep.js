// @ts-check
// Shrinks photos on the DM's device before upload: smaller files, faster tables, and re-encoding drops EXIF
// metadata (including GPS location). The server checks the result again; this is just the polite part.

const MAX_SIDE = 2048;
const SMALLER_SIDE = 1600;
const THUMB_SIDE = 480;
const MAX_BYTES = 1_500_000;
const THUMB_MAX_BYTES = 150_000;

/**
 * @param {File} file
 * @returns {Promise<{ full: Blob, thumb: Blob }>}
 * @throws {Error} with message 'image_decode' or 'image_too_large'
 */
export async function prepareImage(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('image_decode'); // e.g. HEIC on a desktop browser
  }
  const keepPng = file.type === 'image/png' && file.size <= MAX_BYTES && hasTransparency(bitmap);
  const full = keepPng
    ? await encode(bitmap, MAX_SIDE, 'image/png')
    : await firstUnder(MAX_BYTES, [
        () => encode(bitmap, MAX_SIDE, 'image/jpeg', 0.85),
        () => encode(bitmap, MAX_SIDE, 'image/jpeg', 0.75),
        () => encode(bitmap, SMALLER_SIDE, 'image/jpeg', 0.75),
        () => encode(bitmap, SMALLER_SIDE, 'image/jpeg', 0.6),
      ]);
  if (full.size > MAX_BYTES) throw new Error('image_too_large');
  const thumb = await firstUnder(THUMB_MAX_BYTES, [
    () => encode(bitmap, THUMB_SIDE, 'image/jpeg', 0.7),
    () => encode(bitmap, THUMB_SIDE, 'image/jpeg', 0.5),
  ]);
  bitmap.close();
  return { full, thumb };
}

/** @param {number} limit @param {(() => Promise<Blob>)[]} attempts */
async function firstUnder(limit, attempts) {
  let blob = /** @type {Blob} */ (/** @type {unknown} */ (null));
  for (const attempt of attempts) {
    blob = await attempt();
    if (blob.size <= limit) break;
  }
  return blob;
}

/**
 * @param {ImageBitmap} bitmap @param {number} maxSide @param {string} type @param {number} [quality]
 * @returns {Promise<Blob>}
 */
function encode(bitmap, maxSide, type, quality) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#1b1d23'; // transparent areas become the card colour, not black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('image_decode'))), type, quality),
  );
}

/** Samples a small copy of the image for any non-opaque pixel. @param {ImageBitmap} bitmap */
function hasTransparency(bitmap) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.min(64, bitmap.width);
  canvas.height = Math.min(64, bitmap.height);
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}
