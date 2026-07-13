import fs from 'fs';
import path from 'path';
import { resolvePdfHfMapPath } from './paths.js';
import { normalizeMapKey } from './r2-pdfs.js';

export { normalizeMapKey };

/** Path prefix inside the HF dataset repo. */
export const HF_PDF_PREFIX = 'pdf';

let urlMap = null;

function loadUrlMap() {
  if (urlMap) return urlMap;
  urlMap = new Map();
  const mapPath = resolvePdfHfMapPath();
  if (!fs.existsSync(mapPath)) return urlMap;
  try {
    const raw = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
    if (raw && typeof raw === 'object') {
      for (const [key, url] of Object.entries(raw)) {
        if (key && url) urlMap.set(normalizeMapKey(key), String(url));
      }
    }
  } catch (err) {
    console.warn(`Failed to load HF PDF map (${mapPath}):`, err.message);
  }
  return urlMap;
}

export function reloadPdfHfUrlMap() {
  urlMap = null;
  return loadUrlMap();
}

export function hfRepoPath(mapKey) {
  return `${HF_PDF_PREFIX}/${normalizeMapKey(mapKey)}`;
}

/**
 * Public raw PDF URL on Hugging Face Hub.
 * Example: https://huggingface.co/datasets/user/repo/resolve/main/pdf/2025/INFY/a.pdf
 */
export function publicHfUrlForKey(mapKey, {
  repo = process.env.HF_DATASET_REPO,
  revision = process.env.HF_REVISION || 'main',
} = {}) {
  const name = String(repo || '').replace(/^datasets\//, '');
  if (!name) return null;
  const encodedPath = hfRepoPath(mapKey)
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `https://huggingface.co/datasets/${name}/resolve/${revision}/${encodedPath}`;
}

/**
 * Look up a public Hugging Face URL for a PDF.
 * @param {{ year?: string|number, symbol?: string, pdfUrl?: string, filename?: string, mapKey?: string }} opts
 */
export function resolveHfPdfUrl(opts = {}) {
  const map = loadUrlMap();
  let mapKey = opts.mapKey || null;

  if (!mapKey && opts.year != null && opts.symbol && (opts.filename || opts.pdfUrl)) {
    let filename = opts.filename || null;
    if (!filename && opts.pdfUrl) {
      try {
        filename = path.basename(new URL(opts.pdfUrl).pathname);
      } catch {
        filename = path.basename(String(opts.pdfUrl).split('?')[0].split('#')[0]);
      }
    }
    if (filename) {
      mapKey = normalizeMapKey(opts.year, opts.symbol, filename);
    }
  }

  if (!mapKey) return null;
  const fromMap = map.get(normalizeMapKey(mapKey));
  if (fromMap) return fromMap.split('#')[0];

  if (process.env.HF_DATASET_REPO && process.env.HF_ASSUME_UPLOADED === 'true') {
    return publicHfUrlForKey(mapKey);
  }
  return null;
}

export function getPdfHfMapSize() {
  return loadUrlMap().size;
}
