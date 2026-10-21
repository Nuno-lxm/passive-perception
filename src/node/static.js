// @ts-check
// Serves public/ the way Cloudflare's static assets do: /dm → dm.html, /x/ → x/index.html,
// with the security headers from public/_headers (the /* block), so both hosts send the same ones.
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Reads the headers listed under `/*` in a Cloudflare `_headers` file.
 * @param {string} file
 * @returns {Record<string, string>}
 */
export function readHeadersFile(file) {
  /** @type {Record<string, string>} */
  const headers = {};
  let inBlock = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      inBlock = line.trim() === '/*';
      continue;
    }
    const colon = line.indexOf(':');
    if (inBlock && colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return headers;
}

/**
 * @param {string} root  Absolute path of public/.
 * @param {string} pathname  Already URL-decoded.
 * @returns {Promise<{ body: Buffer, type: string } | null>}
 */
export async function findAsset(root, pathname) {
  const clean = normalize(pathname).replace(/^([/\\])+/, '');
  if (clean.split(sep).some((part) => part === '..' || part.startsWith('_'))) return null; // no _headers etc.
  const base = join(root, clean);
  const candidates = pathname.endsWith('/') ? [join(base, 'index.html')] : [base, `${base}.html`, join(base, 'index.html')];
  for (const file of candidates) {
    const info = await stat(file).catch(() => null);
    if (info?.isFile()) {
      return { body: await readFile(file), type: TYPES[/** @type {keyof TYPES} */ (extname(file))] ?? 'application/octet-stream' };
    }
  }
  return null;
}
