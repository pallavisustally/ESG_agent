import fs from 'fs';
import path from 'path';
import { resolvePdfR2MapPath } from './paths.js';

/** Object key prefix inside the R2 bucket. */
export const R2_PDF_PREFIX = 'pdf';

let urlMap = null;

function loadUrlMap() {
  if (urlMap) return urlMap;
  urlMap = new Map();
  const mapPath = resolvePdfR2MapPath();
  if (!fs.existsSync(mapPath)) return urlMap;
  try {
    const raw = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
    if (raw && typeof raw === 'object') {
      for (const [key, url] of Object.entries(raw)) {
        if (key && url) urlMap.set(normalizeMapKey(key), String(url));
      }
    }
  } catch (err) {
    console.warn(`Failed to load R2 PDF map (${mapPath}):`, err.message);
  }
  return urlMap;
}

/** Reload map from disk (used by upload script after writes). */
export function reloadPdfR2UrlMap() {
  urlMap = null;
  return loadUrlMap();
}

export function normalizeMapKey(yearOrKey, symbol, filename) {
  if (symbol == null && filename == null) {
    return String(yearOrKey || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/^pdf\//i, '');
  }
  return [String(yearOrKey), String(symbol).toUpperCase(), String(filename)]
    .join('/')
    .replace(/\\/g, '/');
}

export function r2ObjectKey(mapKey) {
  const key = normalizeMapKey(mapKey);
  return `${R2_PDF_PREFIX}/${key}`;
}

export function publicUrlForKey(mapKey, publicBaseUrl = process.env.R2_PUBLIC_BASE_URL) {
  const base = String(publicBaseUrl || '').replace(/\/+$/, '');
  if (!base) return null;
  const key = r2ObjectKey(mapKey)
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `${base}/${key}`;
}

/**
 * Look up a public R2 URL for a PDF.
 * @param {{ year?: string|number, symbol?: string, pdfUrl?: string, filename?: string, mapKey?: string }} opts
 */
export function resolveR2PdfUrl(opts = {}) {
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

  // Optional optimistic URL when map is incomplete but public base is configured
  if (process.env.R2_PUBLIC_BASE_URL && process.env.R2_ASSUME_UPLOADED === 'true') {
    return publicUrlForKey(mapKey);
  }
  return null;
}

export function getPdfR2MapSize() {
  return loadUrlMap().size;
}
