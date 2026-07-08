import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { resolveFromProject } from './paths.js';
import { CITABLE_METRICS } from './report-sources.js';

const PDF_CACHE_DIR = process.env.PDF_CACHE_DIR
  ? path.resolve(process.env.PDF_CACHE_DIR)
  : resolveFromProject('data', 'pdf_cache');

function ensureCacheDir() {
  if (!fs.existsSync(PDF_CACHE_DIR)) {
    fs.mkdirSync(PDF_CACHE_DIR, { recursive: true });
  }
}

function cachePathForUrl(pdfUrl) {
  const hash = crypto.createHash('sha1').update(pdfUrl).digest('hex');
  return path.join(PDF_CACHE_DIR, `${hash}.pdf`);
}

export async function downloadPdf(pdfUrl) {
  ensureCacheDir();
  const cachePath = cachePathForUrl(pdfUrl);
  if (fs.existsSync(cachePath)) {
    return cachePath;
  }

  const response = await fetch(pdfUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SusTallyBRSR/1.0)',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download PDF (${response.status})`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(cachePath, buffer);
  return cachePath;
}

async function extractPageTexts(pdfPath) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await getDocument({ data, useSystemFonts: true }).promise;
  const pages = [];

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str).join(' '));
  }

  return pages;
}

function numberVariants(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return [];

  const variants = new Set();
  const abs = Math.abs(num);

  variants.add(String(num));
  variants.add(String(Math.round(num)));
  variants.add(abs.toFixed(2));
  variants.add(abs.toLocaleString('en-IN', { maximumFractionDigits: 2 }));
  variants.add(abs.toLocaleString('en-US', { maximumFractionDigits: 2 }));

  const plain = String(abs);
  if (plain.includes('.')) {
    variants.add(plain.replace(/\.0+$/, ''));
  }

  return [...variants].filter((v) => v.length >= 2);
}

function pageContainsValue(pageText, value) {
  const normalizedPage = pageText.replace(/\s+/g, ' ').toLowerCase();
  for (const variant of numberVariants(value)) {
    const needle = variant.replace(/,/g, '').toLowerCase();
    if (needle.length < 2) continue;
    if (normalizedPage.includes(needle)) return true;
    if (normalizedPage.includes(variant.toLowerCase())) return true;
  }
  return false;
}

export async function findMetricPages(pdfUrl, metricValues) {
  const pages = {};
  if (!pdfUrl) return pages;

  try {
    const pdfPath = await downloadPdf(pdfUrl);
    const pageTexts = await extractPageTexts(pdfPath);

    for (const [metric, value] of Object.entries(metricValues)) {
      if (value == null || value === '') continue;
      for (let i = 0; i < pageTexts.length; i += 1) {
        if (pageContainsValue(pageTexts[i], value)) {
          pages[metric] = i + 1;
          break;
        }
      }
    }
  } catch (err) {
    console.warn(`Page index failed for ${pdfUrl}: ${err.message}`);
  }

  return pages;
}

export function extractMetricValuesFromRow(row) {
  const values = {};
  for (const metric of CITABLE_METRICS) {
    const num = Number(row[metric]);
    if (Number.isFinite(num)) {
      values[metric] = num;
    }
  }
  return values;
}
