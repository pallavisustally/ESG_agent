import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { resolveFromProject, resolvePdfDir } from './paths.js';
import {
  CITABLE_METRICS,
  LOCAL_PDF_MOUNT,
  lookupNseMetadata,
  resolveLocalPdfPath,
} from './report-sources.js';
import { resolveR2PdfUrl } from './r2-pdfs.js';
import { resolveHfPdfUrl } from './hf-pdfs.js';

const PDF_CACHE_DIR = process.env.PDF_CACHE_DIR
  ? path.resolve(process.env.PDF_CACHE_DIR)
  : (process.env.VERCEL
    ? '/tmp/pdf_cache'
    : resolveFromProject('data', 'pdf_cache'));

const PAGE_TEXT_CACHE_MAX = parseInt(process.env.PDF_PAGE_TEXT_CACHE_MAX, 10) || 20;
const pageTextCache = new Map();

const SHARE_METRICS = new Set(['female_employee_share', 'female_board_share', 'renewable_energy_share']);

const MIN_METRIC_PAGE_SCORE = parseInt(process.env.MIN_METRIC_PAGE_SCORE, 10) || 18;

const METRIC_CONTEXT = {
  scope1_emissions: /\bscope\s*[-]?\s*1\b|scope1\b|direct\s+(?:ghg\s+)?emission/i,
  scope2_emissions: /\bscope\s*[-]?\s*2\b|scope2\b|indirect\s+(?:ghg\s+)?emission/i,
  scope3_emissions: /\bscope\s*[-]?\s*3\b|scope3\b|value\s+chain\s+emission/i,
  energy_consumption: /\benergy\s+consumption\b|\btotal\s+energy\b/i,
  renewable_energy_share: /\brenewable\b|\bsolar\b|\bwind\s+energy\b|\bclean\s+energy\b/i,
  water_consumption: /\bwater\s+consumption\b|\bwater\s+used\b/i,
  water_withdrawal: /\bwater\s+withdrawal\b/i,
  waste_generated: /\bwaste\s+generated\b|\btotal\s+waste\b/i,
  total_revenue: /\bturnover\b|\brevenue\b|\bnet\s+worth\b/i,
  emissions_intensity: /\bemissions?\s+intensity\b|\bcarbon\s+intensity\b|\btco2e?\s*\/\s*/i,
  energy_intensity: /\benergy\s+intensity\b/i,
  water_intensity: /\bwater\s+intensity\b/i,
  waste_intensity: /\bwaste\s+intensity\b/i,
  female_employee_share: /\bemployees?\s+and\s+workers\b|\bparticipation\b.*\bwomen\b|\bgender\b/i,
  female_board_share: /\bboard\s+of\s+directors\b|\bkey\s+management\b|\bkmp\b|\bwomen\b.*\bboard\b/i,
  safety_ltifr: /\bltifr\b|\blost\s+time\s+injury\b|\bsafety\s+incident\b/i,
};

const NEGATIVE_PAGE_CONTEXT = [
  { pattern: /\bregistered\s+office\b|\bscrip\s+code\b|\bbse\s+limited\b|\bnational\s+stock\s+exchange\b/i, penalty: 18 },
  { pattern: /\btraining\s+given\s+to\s+employees\b|\bhuman\s+rights\s+training\b/i, penalty: 14 },
  { pattern: /\bminimum\s+wage\b|\bequal\s+to\s+minimum\s+wage\b/i, penalty: 14 },
  { pattern: /\bunion\b|\bassociation\(s\)\b/i, penalty: 10 },
  { pattern: /\bwell[- ]being\s+of\s+employees\b|\bhealth\s+insurance\b/i, penalty: 10 },
  { pattern: /\bresolution\b|\bresolved\s+that\b|\bagm\b/i, penalty: 16 },
];

const BRSR_SHARE_ANCHORS = {
  female_employee_share: [
    { pattern: /employees?\s+and\s+workers\s*\(including\s+differently\s+abled\)/i, score: 28 },
    { pattern: /particulars.*\btotal\b.*\bmale\b.*\bfemale\b/i, score: 18 },
    { pattern: /\bpermanent\s*\([de]\)/i, score: 10 },
    { pattern: /\bessential\s+indicators?\b/i, score: 6 },
  ],
  female_board_share: [
    { pattern: /participation\/inclusion\/representation\s+of\s+women/i, score: 28 },
    { pattern: /\bboard\s+of\s+directors\b.*\bfemale\b|\bfemale\b.*\bboard\b/i, score: 18 },
    { pattern: /\bessential\s+indicators?\b/i, score: 6 },
  ],
  renewable_energy_share: [
    { pattern: /\brenewable\s+energy\b|\bnon[- ]renewable\s+energy\b/i, score: 22 },
    { pattern: /\benergy\s+consumption\b|\btotal\s+energy\b/i, score: 12 },
    { pattern: /\bessential\s+indicators?\b/i, score: 6 },
  ],
};

function rememberPageTexts(pdfPath, pages) {
  if (pageTextCache.has(pdfPath)) {
    pageTextCache.delete(pdfPath);
  }
  pageTextCache.set(pdfPath, pages);
  while (pageTextCache.size > PAGE_TEXT_CACHE_MAX) {
    const oldest = pageTextCache.keys().next().value;
    pageTextCache.delete(oldest);
  }
}

function isPdfFontNoise(message) {
  return /Warning:\s*TT:\s*(?:undefined function|invalid function id):/i.test(message)
    || /Warning:\s*fetchStandardFontData/i.test(message)
    || /Warning:\s*Required "glyf" table is not found/i.test(message)
    || /Warning:\s*Indexing all PDF objects/i.test(message);
}

const originalConsoleLog = console.log.bind(console);
const originalConsoleWarn = console.warn.bind(console);
console.log = (...args) => {
  const message = args.map((arg) => String(arg)).join(' ');
  if (isPdfFontNoise(message)) return;
  originalConsoleLog(...args);
};
console.warn = (...args) => {
  const message = args.map((arg) => String(arg)).join(' ');
  if (isPdfFontNoise(message)) return;
  originalConsoleWarn(...args);
};

/** Failed PDF downloads (404 etc.) — skip re-fetch for this process lifetime. */
const failedPdfDownloads = new Map();
const FAILED_PDF_TTL_MS = parseInt(process.env.PDF_FAIL_CACHE_TTL_MS, 10) || 6 * 60 * 60 * 1000;
const warnedFailedPdf = new Set();

export const PDF_UNAVAILABLE_MARKER = '__pdf_unavailable';

export function isPdfMarkedUnavailable(metricPages) {
  return Boolean(metricPages && typeof metricPages === 'object' && metricPages[PDF_UNAVAILABLE_MARKER]);
}

export function isPdfDownloadFailed(pdfUrl) {
  if (!pdfUrl) return true;
  const entry = failedPdfDownloads.get(pdfUrl);
  if (!entry) return false;
  if (Date.now() - entry.at > FAILED_PDF_TTL_MS) {
    failedPdfDownloads.delete(pdfUrl);
    return false;
  }
  return true;
}

function markPdfDownloadFailed(pdfUrl, reason) {
  if (!pdfUrl) return;
  failedPdfDownloads.set(pdfUrl, { at: Date.now(), reason: String(reason || 'failed') });
}

function ensureCacheDir() {
  if (!fs.existsSync(PDF_CACHE_DIR)) {
    fs.mkdirSync(PDF_CACHE_DIR, { recursive: true });
  }
}

function cachePathForUrl(pdfUrl) {
  const hash = crypto.createHash('sha1').update(pdfUrl).digest('hex');
  return path.join(PDF_CACHE_DIR, `${hash}.pdf`);
}

export async function downloadPdf(pdfUrl, hints = {}) {
  if (!pdfUrl) {
    throw new Error('Failed to download PDF (no url)');
  }
  if (isPdfDownloadFailed(pdfUrl)) {
    const entry = failedPdfDownloads.get(pdfUrl);
    throw new Error(`Failed to download PDF (${entry?.reason || 'cached failure'})`);
  }

  const bareUrl = String(pdfUrl).split('#')[0];

  // Same-origin /local-pdf/YYYY/SYMBOL/file.pdf → filesystem
  if (bareUrl.startsWith(LOCAL_PDF_MOUNT + '/')) {
    const rel = bareUrl.slice(LOCAL_PDF_MOUNT.length + 1)
      .split('/')
      .map((part) => decodeURIComponent(part));
    const localFromMount = path.join(resolvePdfDir(), ...rel);
    if (fs.existsSync(localFromMount)) {
      return localFromMount;
    }
  }

  // Prefer durable archive under data/pdf/YYYY/SYMBOL/ when available
  const meta = lookupNseMetadata({
    filename: hints.filename,
    company: hints.company,
    year: hints.year,
  });
  const localArchive = resolveLocalPdfPath({
    year: hints.year ?? meta?.year,
    symbol: hints.symbol ?? meta?.symbol,
    pdfUrl: bareUrl.startsWith('http') ? bareUrl : (meta?.pdfUrl || bareUrl),
  });
  if (localArchive) {
    return localArchive;
  }

  // Hugging Face / R2 public URLs (production) — fetch into pdf_cache
  const pdfHint = bareUrl.startsWith('http') ? bareUrl : (meta?.pdfUrl || bareUrl);
  const hfUrl = resolveHfPdfUrl({
    year: hints.year ?? meta?.year,
    symbol: hints.symbol ?? meta?.symbol,
    pdfUrl: pdfHint,
  });
  const r2Url = resolveR2PdfUrl({
    year: hints.year ?? meta?.year,
    symbol: hints.symbol ?? meta?.symbol,
    pdfUrl: pdfHint,
  });
  const fetchUrl = hfUrl || r2Url || (/^https?:\/\//i.test(bareUrl) ? bareUrl : null);

  ensureCacheDir();
  const cachePath = cachePathForUrl(fetchUrl || bareUrl);
  if (fs.existsSync(cachePath)) {
    return cachePath;
  }

  if (!fetchUrl) {
    markPdfDownloadFailed(pdfUrl, 'not a remote url');
    throw new Error('Failed to download PDF (not a remote url)');
  }

  const response = await fetch(fetchUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SusTallyBRSR/1.0)',
    },
  });

  if (!response.ok) {
    markPdfDownloadFailed(pdfUrl, String(response.status));
    throw new Error(`Failed to download PDF (${response.status})`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(cachePath, buffer);
  return cachePath;
}

async function extractPageTexts(pdfPath) {
  if (pageTextCache.has(pdfPath)) {
    const cached = pageTextCache.get(pdfPath);
    pageTextCache.delete(pdfPath);
    pageTextCache.set(pdfPath, cached);
    return cached;
  }

  const pages = await (async () => {
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const doc = await getDocument({
      data,
      useSystemFonts: true,
      disableFontFace: true,
    }).promise;

    const extracted = [];
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      extracted.push(content.items.map((item) => item.str).join(' '));
    }
    await doc.destroy();
    return extracted;
  })();

  rememberPageTexts(pdfPath, pages);
  return pages;
}

function normalizePageText(pageText) {
  return String(pageText).replace(/\s+/g, ' ');
}

function numberVariants(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return [];

  const variants = new Set();
  const abs = Math.abs(num);

  variants.add(String(num));
  variants.add(String(Math.round(num)));
  variants.add(abs.toFixed(2));
  variants.add(abs.toFixed(4));
  variants.add(abs.toLocaleString('en-IN', { maximumFractionDigits: 2 }));
  variants.add(abs.toLocaleString('en-US', { maximumFractionDigits: 2 }));

  const plain = String(abs);
  if (plain.includes('.')) {
    variants.add(plain.replace(/\.0+$/, ''));
  }

  return [...variants].filter((v) => v.replace(/,/g, '').length >= 2);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordBoundaryContains(pageText, value) {
  const normalized = normalizePageText(pageText);
  for (const variant of numberVariants(value)) {
    const escaped = escapeRegex(variant.replace(/,/g, ',?'));
    const re = new RegExp(`(?:^|[^\\d.,])${escaped}(?:[^\\d.,%]|$)`, 'i');
    if (re.test(normalized)) return true;
  }
  return false;
}

function pageContainsValue(pageText, value) {
  if (wordBoundaryContains(pageText, value)) return true;

  const normalizedPage = normalizePageText(pageText).toLowerCase();
  for (const variant of numberVariants(value)) {
    const needle = variant.replace(/,/g, '').toLowerCase();
    if (needle.length < 2) continue;
    if (normalizedPage.includes(needle)) return true;
    if (normalizedPage.includes(variant.toLowerCase())) return true;
  }
  return false;
}

function sharePercentOnPage(pageText, share) {
  const num = Number(share);
  if (!Number.isFinite(num)) return false;
  if (pageContainsValue(pageText, num)) return true;

  const rounded = Math.round(num);
  const normalized = normalizePageText(pageText);
  const pctPatterns = [
    new RegExp(`\\b${escapeRegex(String(num.toFixed(2)))}\\s*%`, 'i'),
    new RegExp(`\\b${rounded}\\s*%`, 'i'),
    new RegExp(`\\b${Math.round(num * 10) / 10}\\s*%`, 'i'),
  ];
  return pctPatterns.some((re) => re.test(normalized));
}

function pagePenalty(pageText, pageIndex) {
  let penalty = 0;
  const normalized = normalizePageText(pageText);
  for (const { pattern, penalty: value } of NEGATIVE_PAGE_CONTEXT) {
    if (pattern.test(normalized)) penalty += value;
  }
  if (pageIndex < 3 && !/\bessential\s+indicators?\b/i.test(normalized)) {
    penalty += 12;
  }
  return penalty;
}

function scoreShareMetricPage(pageText, metric, row = {}, pageIndex = 0) {
  const normalized = normalizePageText(pageText);
  let score = 0;

  for (const anchor of BRSR_SHARE_ANCHORS[metric] || []) {
    if (anchor.pattern.test(normalized)) score += anchor.score;
  }

  const contextRe = METRIC_CONTEXT[metric];
  if (contextRe?.test(normalized)) score += 4;

  if (metric === 'female_employee_share') {
    const female = Number(row.female_employee_count);
    const total = Number(row.total_employee_count);
    const share = Number(row.female_employee_share);
    if (Number.isFinite(female) && female > 0 && wordBoundaryContains(normalized, female)) score += 12;
    if (Number.isFinite(total) && total > 0 && wordBoundaryContains(normalized, total)) score += 12;
    if (Number.isFinite(share) && sharePercentOnPage(normalized, share)) score += 16;
  }

  if (metric === 'female_board_share') {
    const female = Number(row.female_board_count);
    const total = Number(row.total_board_count);
    const share = Number(row.female_board_share);
    if (Number.isFinite(female) && female > 0 && wordBoundaryContains(normalized, female)) score += 12;
    if (Number.isFinite(total) && total > 0 && wordBoundaryContains(normalized, total)) score += 12;
    if (Number.isFinite(share) && sharePercentOnPage(normalized, share)) score += 16;
  }

  if (metric === 'renewable_energy_share') {
    const renewable = Number(row.renewable_energy_consumption ?? row.renewable_energy);
    const share = Number(row.renewable_energy_share);
    if (Number.isFinite(renewable) && renewable > 0 && wordBoundaryContains(normalized, renewable)) score += 14;
    if (Number.isFinite(share) && sharePercentOnPage(normalized, share)) score += 14;
  }

  score -= pagePenalty(normalized, pageIndex);
  return score;
}

function scoreMetricPage(pageText, metric, value, row = {}, pageIndex = 0) {
  if (SHARE_METRICS.has(metric)) {
    return scoreShareMetricPage(pageText, metric, row, pageIndex);
  }

  const normalized = normalizePageText(pageText);
  let score = 0;

  const contextRe = METRIC_CONTEXT[metric];
  if (contextRe?.test(normalized)) score += 12;
  if (wordBoundaryContains(normalized, value)) score += 16;
  else if (pageContainsValue(normalized, value)) score += 8;

  score -= pagePenalty(normalized, pageIndex);
  return score;
}

function pageContainsShareMetric(pageText, metric, row = {}) {
  return scoreShareMetricPage(pageText, metric, row, 0) >= MIN_METRIC_PAGE_SCORE;
}

function pageContainsMetric(pageText, metric, value, row = {}) {
  if (SHARE_METRICS.has(metric)) {
    return pageContainsShareMetric(pageText, metric, row);
  }
  return scoreMetricPage(pageText, metric, value, row, 0) >= Math.max(12, MIN_METRIC_PAGE_SCORE - 6);
}

function findBestPageForMetric(pageTexts, metric, value, row = {}) {
  let bestPage = null;
  let bestScore = 0;

  for (let i = 0; i < pageTexts.length; i += 1) {
    const score = scoreMetricPage(pageTexts[i], metric, value, row, i);
    if (score > bestScore) {
      bestScore = score;
      bestPage = i + 1;
    }
  }

  if (bestScore < MIN_METRIC_PAGE_SCORE) return null;
  return bestPage;
}

export {
  pageContainsValue,
  pageContainsShareMetric,
  scoreMetricPage,
  scoreShareMetricPage,
  numberVariants,
  wordBoundaryContains,
};

export async function getPdfPageTexts(pdfUrl) {
  if (!pdfUrl) return [];
  const pdfPath = await downloadPdf(pdfUrl);
  return extractPageTexts(pdfPath);
}

export async function verifyValueOnPdfPage(pdfUrl, pageNum, value, options = {}) {
  const { metric = null, row = {} } = options;
  if (!pdfUrl || !pageNum || value == null) {
    return {
      verified: false,
      status: 'missing_input',
      pageNum: pageNum ?? null,
      value,
      pdfUrl: pdfUrl || null,
      snippet: null,
    };
  }

  try {
    const pageTexts = await getPdfPageTexts(pdfUrl);
    const pageIndex = Number(pageNum) - 1;
    if (pageIndex < 0 || pageIndex >= pageTexts.length) {
      return {
        verified: false,
        status: 'page_out_of_range',
        pageNum: Number(pageNum),
        value,
        pdfUrl,
        totalPages: pageTexts.length,
        snippet: null,
      };
    }

    const pageText = pageTexts[pageIndex];
    const verified = metric && SHARE_METRICS.has(metric)
      ? scoreShareMetricPage(pageText, metric, row, pageIndex) >= MIN_METRIC_PAGE_SCORE
      : pageContainsMetric(pageText, metric || '_', value, row) || pageContainsValue(pageText, value);

    return {
      verified,
      status: verified ? 'match' : 'value_not_on_page',
      pageNum: Number(pageNum),
      value,
      pdfUrl,
      snippet: normalizePageText(pageText).trim().slice(0, 240),
    };
  } catch (err) {
    return {
      verified: false,
      status: 'pdf_error',
      pageNum: Number(pageNum),
      value,
      pdfUrl,
      error: err.message,
      snippet: null,
    };
  }
}

/**
 * @returns {{ pages: Record<string, number>, unavailable: boolean }}
 */
export async function findMetricPagesResult(pdfUrl, metricValues, row = {}) {
  const pages = {};
  if (!pdfUrl) return { pages, unavailable: true };

  if (isPdfDownloadFailed(pdfUrl)) {
    if (!warnedFailedPdf.has(pdfUrl)) {
      warnedFailedPdf.add(pdfUrl);
      originalConsoleWarn(`Page index skipped (PDF unavailable): ${pdfUrl}`);
    }
    return { pages, unavailable: true };
  }

  const pending = Object.entries(metricValues).filter(
    ([, value]) => value != null && value !== '',
  );
  if (pending.length === 0) return { pages, unavailable: false };

  try {
    const pdfPath = await downloadPdf(pdfUrl, row);
    const pageTexts = await extractPageTexts(pdfPath);

    for (const [metric, value] of pending) {
      const bestPage = findBestPageForMetric(pageTexts, metric, value, row);
      if (bestPage != null) {
        pages[metric] = bestPage;
      }
    }
    return { pages, unavailable: false };
  } catch (err) {
    markPdfDownloadFailed(pdfUrl, err.message);
    if (!warnedFailedPdf.has(pdfUrl)) {
      warnedFailedPdf.add(pdfUrl);
      originalConsoleWarn(`Page index failed for ${pdfUrl}: ${err.message}`);
    }
    return { pages, unavailable: true };
  }
}

export async function findMetricPages(pdfUrl, metricValues, row = {}) {
  const { pages } = await findMetricPagesResult(pdfUrl, metricValues, row);
  return pages;
}

export async function verifyShareMetricPage(pdfUrl, metric, pageNum, row = {}) {
  if (!pdfUrl || !pageNum || !SHARE_METRICS.has(metric)) return false;
  try {
    const pageTexts = await getPdfPageTexts(pdfUrl);
    const pageIndex = Number(pageNum) - 1;
    const pageText = pageTexts[pageIndex];
    if (!pageText) return false;

    const storedScore = scoreShareMetricPage(pageText, metric, row, pageIndex);
    if (storedScore < MIN_METRIC_PAGE_SCORE) return false;

    const bestPage = findBestPageForMetric(pageTexts, metric, row[metric], row);
    return bestPage == null || bestPage === Number(pageNum);
  } catch {
    return false;
  }
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
