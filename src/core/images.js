// @ts-check
// Image checks done by the server, which never trusts the client's resizing.
// The type comes from the file's first bytes (magic numbers), never from headers or names. No SVG: it can carry scripts.

export const IMAGE_LIMITS = {
  bytes: 1_500_000,
  thumbBytes: 150_000,
  side: 4096,
  perCard: 4,
  roomBytes: 50_000_000,
  uploadsPerHour: 60,
};

/**
 * Reads the type and size of a JPEG, PNG or WebP image from its header.
 * @param {Uint8Array} b
 * @returns {{ mime: 'image/jpeg' | 'image/png' | 'image/webp', w: number, h: number } | null}
 */
export function sniffImage(b) {
  if (b.length < 30) return null;

  // PNG: signature, then the IHDR chunk with big-endian width and height.
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[12] === 0x49 && b[13] === 0x48) {
    return { mime: 'image/png', w: readU32(b, 16), h: readU32(b, 20) };
  }

  // JPEG: walk the segments until a start-of-frame marker, which holds height and width.
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) { i++; continue; } // fill byte
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; } // no length
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return { mime: 'image/jpeg', h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
    return null;
  }

  // WebP: RIFF....WEBP, then a VP8, VP8L or VP8X chunk.
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const chunk = ascii(b, 12, 4);
    if (chunk === 'VP8 ') return { mime: 'image/webp', w: (b[26] | (b[27] << 8)) & 0x3fff, h: (b[28] | (b[29] << 8)) & 0x3fff };
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { mime: 'image/webp', w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
      return { mime: 'image/webp', w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    }
  }
  return null;
}

/**
 * Checks an upload. Returns an error code, or the sniffed image.
 * @param {Uint8Array} bytes @param {number} maxBytes
 */
export function checkImage(bytes, maxBytes) {
  if (bytes.length === 0) return { error: 'image_empty' };
  if (bytes.length > maxBytes) return { error: 'image_too_large' };
  const image = sniffImage(bytes);
  if (!image) return { error: 'image_type' };
  if (!image.w || !image.h || image.w > IMAGE_LIMITS.side || image.h > IMAGE_LIMITS.side) return { error: 'image_dimensions' };
  return { image };
}

/** @param {Uint8Array} b @param {number} at */
const readU32 = (b, at) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];

/** @param {Uint8Array} b @param {number} at @param {number} length */
const ascii = (b, at, length) => String.fromCharCode(...b.subarray(at, at + length));
