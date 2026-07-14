import fs from 'fs';
import path from 'path';
import { resolveFromProject, resolvePdfDir } from './paths.js';
import { buildShareBreakdown } from './share-breakdown.js';
import { resolveR2PdfUrl } from './r2-pdfs.js';
import { resolveHfPdfUrl } from './hf-pdfs.js';

const METADATA_PATH = process.env.METADATA_PATH
  ? path.resolve(process.env.METADATA_PATH)
  : resolveFromProject('data', 'nse_sustainability_metadata.json');

/** Same-origin mount for downloaded PDFs (see server.js). */
export const LOCAL_PDF_MOUNT = '/local-pdf';

/** DB metric columns that can be cited with page numbers. */
export const CITABLE_METRICS = [
  'scope1_emissions',
  'scope2_emissions',
  'scope3_emissions',
  'energy_consumption',
  'renewable_energy_share',
  'water_consumption',
  'water_withdrawal',
  'waste_generated',
  'total_revenue',
  'emissions_intensity',
  'energy_intensity',
  'water_intensity',
  'waste_intensity',
  'female_employee_share',
  'female_board_share',
  'safety_ltifr',
];

let metadataByFilename = null;
let metadataByCompanyYear = null;

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function loadMetadataIndex() {
  if (metadataByFilename) return;

  metadataByFilename = new Map();
  metadataByCompanyYear = new Map();

  if (!fs.existsSync(METADATA_PATH)) {
    return;
  }

  const filings = JSON.parse(fs.readFileSync(METADATA_PATH, 'utf-8'));
  for (const filing of filings) {
    const entry = {
      companyName: filing.companyName,
      symbol: filing.symbol,
      year: filing.fyTo ?? filing.fyFrom,
      pdfUrl: filing.attachmentFile || null,
      xbrlUrl: filing.xbrlFile || null,
      submissionDate: filing.submissionDate || null,
    };

    if (filing.xbrlFile) {
      const filename = path.basename(filing.xbrlFile);
      metadataByFilename.set(filename.toLowerCase(), entry);
    }

    const key = `${normalizeName(filing.companyName)}|${entry.year}`;
    if (!metadataByCompanyYear.has(key) || filing.xbrlFile) {
      metadataByCompanyYear.set(key, entry);
    }
  }
}

export function lookupNseMetadata({ filename, company, year }) {
  loadMetadataIndex();

  if (filename) {
    const byFile = metadataByFilename.get(String(filename).toLowerCase());
    if (byFile) return byFile;
  }

  if (company && year != null) {
    const byCompany = metadataByCompanyYear.get(`${normalizeName(company)}|${year}`);
    if (byCompany) return byCompany;
  }

  return null;
}

function pdfBasename(pdfUrl) {
  if (!pdfUrl) return null;
  try {
    return path.basename(new URL(pdfUrl).pathname);
  } catch {
    return path.basename(String(pdfUrl).split('?')[0].split('#')[0]);
  }
}

/** Absolute path under data/pdf/YYYY/SYMBOL/ when the file was downloaded. */
export function resolveLocalPdfPath({ year, symbol, pdfUrl }) {
  if (!pdfUrl || year == null || !symbol) return null;
  const filename = pdfBasename(pdfUrl);
  if (!filename || !filename.toLowerCase().endsWith('.pdf')) return null;
  const localPath = path.join(
    resolvePdfDir(),
    String(year),
    String(symbol).toUpperCase(),
    filename,
  );
  return fs.existsSync(localPath) ? localPath : null;
}

/** Public URL for a downloaded PDF, or null if not on disk. */
export function toPublicPdfUrl({ year, symbol, pdfUrl }) {
  const localPath = resolveLocalPdfPath({ year, symbol, pdfUrl });
  if (!localPath) return null;
  const filename = path.basename(localPath);
  return [
    LOCAL_PDF_MOUNT,
    encodeURIComponent(String(year)),
    encodeURIComponent(String(symbol).toUpperCase()),
    encodeURIComponent(filename),
  ].join('/');
}

/** NSE (or other remote) PDF URL for a report row — used for download/index fallback. */
export function resolveRemotePdfUrlForRow(row) {
  if (row?.pdf_unavailable) return null;
  const candidates = [row?.pdf_url, row?.report_pdf_url].filter(Boolean);
  for (const candidate of candidates) {
    const url = String(candidate).split('#')[0];
    if (url.startsWith(LOCAL_PDF_MOUNT)) continue;
    if (/\.r2\.dev\//i.test(url) || /r2\.cloudflarestorage\.com\//i.test(url)) continue;
    if (/huggingface\.co\//i.test(url)) continue;
    if (/^https?:\/\//i.test(url) && /\.pdf$/i.test(url.split('?')[0])) return url;
  }
  const meta = lookupNseMetadata({
    filename: row?.filename,
    company: row?.company,
    year: row?.year,
  });
  return meta?.pdfUrl || null;
}

/**
 * Citation/link URL for the UI:
 *   1) local /local-pdf/... when file is on disk
 *   2) Hugging Face Hub URL when mapped
 *   3) Cloudflare R2 URL when mapped
 *   4) NSE attachment URL as fallback
 */
export function resolvePdfUrlForRow(row) {
  if (row?.pdf_unavailable) return null;

  const meta = lookupNseMetadata({
    filename: row?.filename,
    company: row?.company,
    year: row?.year,
  });

  const remoteUrl = resolveRemotePdfUrlForRow(row);
  const year = row?.year ?? meta?.year;
  const symbol = meta?.symbol;
  const pdfHint = remoteUrl || meta?.pdfUrl || null;

  if (remoteUrl) {
    const localPublic = toPublicPdfUrl({ year, symbol, pdfUrl: remoteUrl });
    if (localPublic) return localPublic;
  }

  const hfUrl = resolveHfPdfUrl({ year, symbol, pdfUrl: pdfHint });
  if (hfUrl) return hfUrl;

  const r2Url = resolveR2PdfUrl({ year, symbol, pdfUrl: pdfHint });
  if (r2Url) return r2Url;

  // Already a local public URL from a prior enrich step
  for (const candidate of [row?.report_pdf_url, row?.pdf_url]) {
    if (candidate && String(candidate).startsWith(LOCAL_PDF_MOUNT)) {
      return String(candidate).split('#')[0];
    }
  }

  return remoteUrl;
}

/** SQL aliases that mean this row is a computed aggregate, not a company filing. */
const AGGREGATE_ALIAS_RE = /^(avg_|average_|sum_|count_|min_|max_|median_)/i;
const AGGREGATE_EXACT_KEYS = new Set(['avg', 'average', 'sum', 'count', 'median']);

export function isComputedMetricRow(row) {
  if (!row || typeof row !== 'object') return false;
  // Sector / AVG() rows often omit company; those are aggregates.
  if (!row.company || row.year == null) return true;

  const keys = Object.keys(row);
  // Explicit aggregate aliases only (avg_scope1, sum_emissions, count, …).
  // Native columns like total_revenue / total_employee_count are NOT aggregates.
  return keys.some(
    (key) => AGGREGATE_ALIAS_RE.test(key) || AGGREGATE_EXACT_KEYS.has(key),
  );
}

function buildAggregateSourcesPayload(row) {
  return {
    company: row.company ?? null,
    year: row.year ?? null,
    report_pdf_url: null,
    report_xbrl_url: null,
    metrics: {},
    ready_citations: {},
    flat_fields: {},
    citable: false,
    citation_policy: 'aggregate',
    citation_hint:
      'COMPUTED_AGGREGATE: This row is a SQL aggregate or sector summary. Show the computed value only — do not add p. N, [source](...), or "(Source: SQLite aggregate…)" labels.',
  };
}

export function buildSourcesPayload(row, metricPages = null) {
  if (isComputedMetricRow(row)) {
    return buildAggregateSourcesPayload(row);
  }

  const pages = metricPages && typeof metricPages === 'object' ? metricPages : {};
  const pdfUnavailable = Boolean(row.pdf_unavailable) || Boolean(pages.__pdf_unavailable);
  const usablePages = { ...pages };
  delete usablePages.__pdf_unavailable;

  const pdfUrl = pdfUnavailable ? null : resolvePdfUrlForRow(row);
  const xbrlUrl = row.xbrl_url || row.report_xbrl_url || null;

  const metrics = {};
  const readyCitations = {};
  const flatFields = {};

  for (const metric of CITABLE_METRICS) {
    const num = Number(row[metric]);
    if (!Number.isFinite(num)) continue;
    const page = usablePages[metric] ?? null;
    const citation = pdfUrl && page ? citationMarkdown(page, pdfUrl) : null;
    metrics[metric] = {
      value: num,
      page: citation ? page : null,
      citation,
    };
    if (citation) {
      readyCitations[metric] = citation;
      flatFields[`${metric}_page`] = page;
      flatFields[`${metric}_citation`] = citation;
    }
  }

  const citable = Boolean(pdfUrl && Object.keys(readyCitations).length > 0);

  return {
    company: row.company,
    year: row.year,
    report_pdf_url: citable ? pdfUrl : null,
    report_xbrl_url: xbrlUrl,
    metrics,
    ready_citations: readyCitations,
    flat_fields: flatFields,
    citable,
    citation_hint: citable
      ? 'REQUIRED citation format: p. N [source](pdf_url#page=N) — page number as plain text, [source] as the clickable link to the PDF page. Copy the exact URL from ready_citations / *_citation (Hugging Face, R2, /local-pdf/..., or NSE). Never use [report], [p. N](url), or a ## Sources footer.'
      : 'No PDF page citations for this report. Show metric values only — do not add p. N, [source](...), or any source links.',
  };
}

function attachMetadataUrls(row) {
  if (row?.pdf_unavailable) {
    return {
      ...row,
      pdf_url: null,
      xbrl_url: row.xbrl_url || null,
    };
  }
  const meta = lookupNseMetadata({
    filename: row.filename,
    company: row.company,
    year: row.year,
  });
  if (!row.pdf_url && !row.xbrl_url && !meta?.pdfUrl && !meta?.xbrlUrl) return row;
  return {
    ...row,
    pdf_url: row.pdf_url || meta?.pdfUrl || null,
    xbrl_url: row.xbrl_url || meta?.xbrlUrl || null,
  };
}

export function enrichSqlRows(rows, sourceRowsByKey = new Map()) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;

  return rows.map((row) => {
    const key = `${row.company}|${row.year}`;
    const sourceRow = sourceRowsByKey.get(key);
    const mergedForBreakdown = sourceRow ? { ...sourceRow, ...row } : row;
    const shareBreakdown = buildShareBreakdown(mergedForBreakdown);

    if (!sourceRow) {
      const withMeta = attachMetadataUrls(row);
      const sources = buildSourcesPayload(withMeta);
      return {
        ...withMeta,
        ...sources.flat_fields,
        report_pdf_url: sources.report_pdf_url,
        report_xbrl_url: sources.report_xbrl_url,
        sources,
        share_breakdown: shareBreakdown,
      };
    }

    let metricPages = null;
    if (sourceRow.metric_pages_json) {
      try {
        metricPages = JSON.parse(sourceRow.metric_pages_json);
      } catch {
        metricPages = null;
      }
    }

    const merged = attachMetadataUrls({
      ...row,
      ...sourceRow,
      pdf_unavailable:
        sourceRow.pdf_unavailable
        || row.pdf_unavailable
        || Boolean(metricPages?.__pdf_unavailable),
    });
    const sources = buildSourcesPayload(
      merged,
      metricPages?.__pdf_unavailable ? null : metricPages,
    );
    return {
      ...row,
      ...sources.flat_fields,
      report_pdf_url: sources.report_pdf_url,
      report_xbrl_url: sourceRow.xbrl_url || row.report_xbrl_url || null,
      sources,
      share_breakdown: shareBreakdown,
    };
  });
}

function metricPlainValue(metrics, key) {
  const raw = metrics?.[key];
  if (raw == null) return null;
  return typeof raw === 'object' ? (raw.value ?? null) : raw;
}

export function enrichCompanyReport(reportData, sourceRow) {
  if (!reportData || reportData.error) return reportData;

  let metricPages = null;
  if (sourceRow?.metric_pages_json) {
    try {
      metricPages = JSON.parse(sourceRow.metric_pages_json);
    } catch {
      metricPages = null;
    }
  }

  const sector = metricPlainValue(reportData.metrics, 'sector');
  const industry = metricPlainValue(reportData.metrics, 'industry');

  const flatRow = {
    company: reportData.company,
    year: reportData.year,
    filename: sourceRow?.filename || null,
    pdf_url: sourceRow?.pdf_url || null,
    xbrl_url: sourceRow?.xbrl_url || null,
    sector,
    industry,
  };

  for (const metric of CITABLE_METRICS) {
    const fromMetrics = reportData.metrics?.[metric];
    flatRow[metric] = typeof fromMetrics === 'object' ? fromMetrics?.value : fromMetrics;
  }

  const sources = buildSourcesPayload(
    { ...flatRow, pdf_unavailable: sourceRow?.pdf_unavailable },
    metricPages,
  );
  const shareBreakdown = buildShareBreakdown({ ...flatRow, ...sourceRow });
  return {
    ...reportData,
    sector,
    industry,
    ...sources.flat_fields,
    report_pdf_url: sources.report_pdf_url,
    report_xbrl_url: sources.report_xbrl_url,
    sources,
    share_breakdown: shareBreakdown,
  };
}

function preferredPageForRow(pages = {}) {
  const usable = { ...pages };
  delete usable.__pdf_unavailable;
  return usable.scope1_emissions
    || usable.scope2_emissions
    || usable.renewable_energy_share
    || usable.female_employee_share
    || Object.values(usable).find(Boolean)
    || null;
}

function pdfUrlWithPage(pdfUrl, page) {
  if (!pdfUrl) return null;
  const base = String(pdfUrl).split('#')[0];
  if (page != null && Number(page) > 0) return `${base}#page=${page}`;
  return base;
}

function citationMarkdown(page, pdfUrl) {
  // Only emit citations when both a real PDF URL and a page number exist.
  if (!pdfUrl || page == null || Number(page) <= 0) return '';
  const url = pdfUrlWithPage(pdfUrl, page);
  if (!url) return '';
  return `p. ${page} [source](${url})`;
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Model-invented relative links like [source](report) resolve to /report on the app host. */
const BROKEN_RELATIVE_LINK_RE = /\[(?:source|report)\]\((?:report|\/report|null|report_pdf_url|#?)\)/gi;

function repairBrokenLinksNearCompany(out, company, citation) {
  const companyEsc = escapeRegex(company);
  if (!companyEsc) return out;

  return out.replace(
    new RegExp(
      `^([^\\n]*${companyEsc}[^\\n]*?)(\\[(?:source|report)\\]\\((?:report|\\/report|null|report_pdf_url|#?)\\)|\\(no citation available\\)|\\bno citation available\\b)`,
      'gim',
    ),
    (full, prefix) => {
      if (/p\.\s*\d+\s*\[source\]\(/i.test(full)) return full;
      return `${prefix}${citation}`;
    },
  );
}

function repairOrphanedBrokenLinks(out, byPdf) {
  const sorted = [...byPdf].sort(
    (a, b) => (b.row.company?.length || 0) - (a.row.company?.length || 0),
  );

  return out.replace(BROKEN_RELATIVE_LINK_RE, (match, offset, whole) => {
    const lineStart = whole.lastIndexOf('\n', offset - 1) + 1;
    const lineEnd = whole.indexOf('\n', offset);
    const line = whole.slice(lineStart, lineEnd === -1 ? whole.length : lineEnd);

    for (const { row, pdfUrl, preferredPage } of sorted) {
      if (row.company && line.includes(row.company)) {
        return citationMarkdown(preferredPage, pdfUrl);
      }
    }
    return '';
  });
}

function numberVariantsForCitation(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num === 0) return [];

  // Avoid tiny bare integers that can appear inside years/page refs (e.g. 20 in 2023).
  if (Number.isInteger(num) && Math.abs(num) < 100) return [];

  const abs = Math.abs(num);
  const variants = new Set([
    String(num),
    abs.toLocaleString('en-US', { maximumFractionDigits: 4 }),
    abs.toLocaleString('en-IN', { maximumFractionDigits: 4 }),
  ]);

  if (Number.isInteger(num) || Math.abs(num - Math.round(num)) < 1e-9) {
    variants.add(String(Math.round(num)));
    variants.add(Math.round(num).toLocaleString('en-US'));
    variants.add(Math.round(num).toLocaleString('en-IN'));
  }

  return [...variants].filter((v) => v.replace(/,/g, '').length >= 3);
}

const METRIC_LINE_HINTS = {
  scope1_emissions: /\bscope\s*1\b|scope1|direct emission/i,
  scope2_emissions: /\bscope\s*2\b|scope2/i,
  scope3_emissions: /\bscope\s*3\b|scope3/i,
  energy_consumption: /\benergy consumption\b|\btotal energy\b/i,
  renewable_energy_share: /\brenewable\b/i,
  water_consumption: /\bwater consumption\b|\bwater use\b/i,
  water_withdrawal: /\bwater withdrawal\b/i,
  waste_generated: /\bwaste generated\b|\bwaste\b/i,
  emissions_intensity: /\bemissions intensity\b|\bcarbon intensity\b/i,
  energy_intensity: /\benergy intensity\b/i,
  water_intensity: /\bwater intensity\b/i,
  waste_intensity: /\bwaste intensity\b/i,
  female_employee_share: /\bfemale\b|\bworkforce\b|\bdiversity\b|\bgender\b|\bemployee share\b/i,
  female_board_share: /\bboard\b|\bdirector\b/i,
  safety_ltifr: /\bltifr\b|\bsafety\b|\blost time\b/i,
  total_revenue: /\brevenue\b|\bturnover\b/i,
};

const FEMALE_BREAKDOWN_RE = /\s*\([^)]*\bfemale (?:permanent )?employees of[^)]*\btotal (?:permanent )?employees\)/gi;
const FEMALE_BOARD_BREAKDOWN_RE = /\s*\([^)]*\bfemale board directors of[^)]*\btotal board directors\)/gi;
const EMISSION_OR_ENERGY_LINE_RE = /\bscope\s*[123]\b|scope[123]|emission|renewable|carbon|tco2|energy intensity/i;

function lineMatchesMetric(line, metric) {
  const hint = METRIC_LINE_HINTS[metric];
  if (!hint) return true;

  const metricLabel = (line.match(/\*\*([^*]+)\*\*/)?.[1] || line.split(':')[0] || line).toLowerCase();

  if ((metric === 'female_employee_share' || metric === 'female_board_share')
    && EMISSION_OR_ENERGY_LINE_RE.test(metricLabel)
    && !/\bfemale\b|\bworkforce\b|\bdiversity\b|\bgender\b|\bboard\b/i.test(metricLabel)) {
    return false;
  }

  if ((metric === 'renewable_energy_share' || metric.startsWith('scope'))
    && /\bfemale (?:permanent )?employees\b|\bfemale board directors\b/i.test(line)
    && !hint.test(metricLabel)) {
    return false;
  }

  return hint.test(metricLabel) || hint.test(line);
}

/** True if this line names the company, or sits under a ### Company heading. */
function lineBelongsToCompany(text, lineStart, company) {
  if (!company) return false;
  const lineEnd = text.indexOf('\n', lineStart);
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
  if (line.includes(company)) return true;

  // Walk backwards for nearest markdown heading; match ### Company Name sections.
  const before = text.slice(0, lineStart);
  const headingRe = /^#{1,4}\s+(.+?)\s*$/gm;
  let lastHeading = null;
  let match;
  while ((match = headingRe.exec(before)) !== null) {
    lastHeading = match[1].trim();
  }
  if (!lastHeading) return false;
  // Stop at major section headings (## Key Findings) — only ### company subs count.
  if (/^(executive summary|key findings|analysis|recommendation|insight|chart)/i.test(lastHeading)) {
    return false;
  }
  return lastHeading === company
    || lastHeading.toLowerCase() === company.toLowerCase()
    || lastHeading.includes(company)
    || company.includes(lastHeading);
}

function stripInventedSourceLabels(text) {
  return String(text)
    .replace(/\s*\(\s*Source:\s*SQLite aggregate[^)]*\)/gi, '')
    .replace(/\s*\*\(\s*Source:\s*SQLite aggregate[^*]*\)\*/gi, '')
    .replace(/\s*Source:\s*SQLite aggregate(?:,\s*year\s*\d{4})?/gi, '');
}

function stripIrrelevantShareBreakdowns(text) {
  return String(text).split('\n').map((line) => {
    const metricLabel = (line.match(/\*\*([^*]+)\*\*/)?.[1] || line.split(':')[0] || line).toLowerCase();
    const isDiversityLine = /female|workforce|diversity|gender|board/.test(metricLabel);
    if (isDiversityLine) return line;
    if (!EMISSION_OR_ENERGY_LINE_RE.test(line)) return line;

    return line
      .replace(FEMALE_BREAKDOWN_RE, '')
      .replace(FEMALE_BOARD_BREAKDOWN_RE, '');
  }).join('\n');
}

function normalizeLegacyCitations(text, byPdf) {
  let out = text;

  out = out.replace(/\[p\.\s*(\d+)\]\(([^)]+)\)/gi, (_, page, url) => {
    const base = String(url).split('#')[0];
    return `p. ${page} [source](${base}#page=${page})`;
  });

  for (const { pdfUrl, preferredPage } of byPdf) {
    const base = pdfUrl.split('#')[0];
    const escaped = escapeRegex(base);
    const replacement = citationMarkdown(preferredPage, pdfUrl);
    out = out.replace(new RegExp(`\\[report\\]\\(${escaped}[^)]*\\)`, 'gi'), replacement);
  }

  for (const { row, pdfUrl, preferredPage } of byPdf) {
    if (!row.company || !preferredPage) continue;
    const companyEsc = escapeRegex(row.company);
    const citation = citationMarkdown(preferredPage, pdfUrl);
    out = out.replace(
      new RegExp(
        `(^[^\\n]*${companyEsc}[^\\n]*?)(?<!p\\.\\s*\\d+\\s)\\[source\\]\\((?:https?|\\/local-pdf)[^\\)]+\\)`,
        'gim',
      ),
      `$1${citation}`,
    );
  }

  if (byPdf.length === 1 && byPdf[0].preferredPage) {
    const { pdfUrl, preferredPage } = byPdf[0];
    const base = escapeRegex(pdfUrl.split('#')[0]);
    const citation = citationMarkdown(preferredPage, pdfUrl);
    out = out.replace(
      new RegExp(`(?<!p\\.\\s*\\d+\\s)\\[source\\]\\(${base}[^)]*\\)`, 'gi'),
      citation,
    );
  }

  return out;
}

function dedupeInlineCitations(text) {
  let out = text.replace(
    /(?:p\.\s*\d+\s*)+\[source\]\(([^)]+)\)/gi,
    (match, url) => {
      const pageMatch = match.match(/p\.\s*(\d+)/i);
      return pageMatch ? `p. ${pageMatch[1]} [source](${url})` : `[source](${url})`;
    },
  );
  out = out.replace(/\(p\.\s*(\d+)\s*\[source\]\(([^)]+)\)\)/gi, ' p. $1 [source]($2)');

  // Same line often gets citation after the % AND after the (breakdown) — keep one.
  out = out.split('\n').map((line) => {
    const citations = [...line.matchAll(/\s*p\.\s*(\d+)\s*\[source\]\(([^)]+)\)/gi)];
    if (citations.length < 2) return line;

    // Prefer the first citation's page/url; strip all, then append once after the primary value.
    const page = citations[0][1];
    const url = citations[0][2];
    let cleaned = line.replace(/\s*p\.\s*\d+\s*\[source\]\([^)]+\)/gi, '');
    cleaned = cleaned.replace(/\s+$/g, '');

    // Insert after first % / unit / number cluster when possible; else append.
    const insertAt = cleaned.search(
      /\d[\d,]*(?:\.\d+)?\s*%|\d[\d,]*(?:\.\d+)?\s*(?:tCO2e|MtCO2e|MtCO2|tCO₂e)\b/i,
    );
    if (insertAt >= 0) {
      const matched = cleaned.slice(insertAt).match(
        /^(\d[\d,]*(?:\.\d+)?\s*(?:%|tCO2e|MtCO2e|MtCO2|tCO₂e))/i,
      );
      if (matched) {
        const end = insertAt + matched[1].length;
        return `${cleaned.slice(0, end)} p. ${page} [source](${url})${cleaned.slice(end)}`;
      }
    }
    return `${cleaned} p. ${page} [source](${url})`;
  }).join('\n');

  return out;
}

function lineAlreadyHasCitation(line) {
  return /p\.\s*\d+\s*\[source\]\(|\[p\.\s*\d+\]\(|\[source\]\((?:https?:|\/local-pdf\/)/i.test(line);
}

function stripSourcesFooter(text) {
  return text.replace(/\n##\s*Sources[\s\S]*$/i, '').trimEnd();
}

const SECTOR_HEADING_RE = /^(#{1,4}\s+)?(Materials|Consumer Services|Telecommunications|Other\/Industrial|Healthcare|Utilities|Consumer Defensive|Consumer Cyclical|Financial Services|Energy(?:\s*&\s*Renewables)?|Industrials|Technology)\b/i;
const AGGREGATE_LINE_RE = /\b(average|avg\.?|median|aggregate|ranking|per sector|sector average|across all sectors|sector rankings)\b/i;

function isSectorOrAggregateLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (AGGREGATE_LINE_RE.test(trimmed)) return true;
  if (SECTOR_HEADING_RE.test(trimmed)) return true;
  return false;
}

function stripMalformedCitationLinks(text) {
  return text
    .replace(/\[(?:source|report)\]\([^)\n]*$/gim, '')
    .replace(/\[(?:source|report)\]\(\s*\)/gi, '')
    .replace(/\s+p\.\s*\d+\s*source\b/gi, '');
}

function stripMisleadingCitationsFromAggregates(text, companyNames = []) {
  return text.split('\n').map((line) => {
    if (companyNames.some((name) => name && line.includes(name))) return line;
    if (!isSectorOrAggregateLine(line)) return line;

    return line
      .replace(/\s*p\.\s*\d+\s*\[source\]\([^)]+\)/gi, '')
      .replace(/\s*\[source\]\([^)]+\)/gi, '')
      .replace(/\s*\[source\]\([^)\n]+$/gi, '')
      .replace(/\s*\[report\]\([^)]+\)/gi, '')
      .trimEnd();
  }).join('\n');
}

/**
 * Prefer metric-specific pages when upgrading [report](pdf) links.
 * Also repair broken placeholders the model invents: [report](null), [source](...), etc.
 * Does NOT inject into year numbers.
 */
export function upgradeReportCitations(text, sourceRows = []) {
  if (!text || !sourceRows.length) return text;

  // Extract all code blocks (like ```json-chart ... ```) to prevent citations from being injected into them
  const codeBlocks = [];
  const codePlaceholderPrefix = `__CODE_BLOCK_PLACEHOLDER_${Date.now()}_`;
  let placeholderIndex = 0;

  let out = text.replace(/(```[\s\S]*?```)/g, (match) => {
    const placeholder = `${codePlaceholderPrefix}${placeholderIndex++}__`;
    codeBlocks.push({ placeholder, content: match });
    return placeholder;
  });

  // Model often invents this label for single-company rows — always remove first.
  out = stripInventedSourceLabels(out);

  const byPdf = [];
  for (const row of sourceRows) {
    if (row?.pdf_unavailable) continue;
    let pages = {};
    if (row.metric_pages_json) {
      try {
        pages = JSON.parse(row.metric_pages_json) || {};
      } catch {
        pages = {};
      }
    }
    if (pages.__pdf_unavailable) continue;
    const pdfUrl = resolvePdfUrlForRow(row);
    const remoteUrl = resolveRemotePdfUrlForRow(row);
    const preferredPage = preferredPageForRow(pages);
    // Only cite when we have both a live PDF URL and at least one page number.
    if (!pdfUrl || !preferredPage) continue;
    byPdf.push({ row, pages, pdfUrl, remoteUrl, preferredPage });
  }

  // If the model pasted NSE URLs, rewrite them to local /local-pdf/ or R2 links when available.
  for (const { pdfUrl, remoteUrl } of byPdf) {
    if (!remoteUrl || !pdfUrl || remoteUrl === pdfUrl) continue;
    const remoteBase = escapeRegex(remoteUrl.split('#')[0]);
    const localBase = pdfUrl.split('#')[0];
    out = out.replace(new RegExp(remoteBase, 'gi'), localBase);
  }

  // Company-local broken placeholders -> real citation (only when page exists)
  for (const { row, pdfUrl, preferredPage } of byPdf) {
    const pageCitation = citationMarkdown(preferredPage, pdfUrl);
    if (!pageCitation) continue;
    out = repairBrokenLinksNearCompany(out, row.company, pageCitation);
  }

  // [report](exact-url) -> p. N [source](url)
  for (const { pdfUrl, preferredPage } of byPdf) {
    if (!preferredPage) continue;
    const escapedUrl = pdfUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(
      new RegExp(`\\[report\\]\\(${escapedUrl}\\)`, 'gi'),
      citationMarkdown(preferredPage, pdfUrl),
    );
  }

  // Global broken placeholders when a single report is in context
  if (byPdf.length === 1) {
    const { pdfUrl, preferredPage } = byPdf[0];
    const pageCitation = citationMarkdown(preferredPage, pdfUrl);
    if (pageCitation) {
      out = out.replace(/\[report\]\(null\)/gi, pageCitation);
      out = out.replace(/\[source\]\((?:report|\/report|null|report_pdf_url)\)/gi, pageCitation);
      out = out.replace(/\(no citation available\)/gi, pageCitation);
      out = out.replace(/\bno citation available\b/gi, pageCitation);
    }
  }

  // Always strip invented / empty citation placeholders when we cannot repair them.
  out = out.replace(/\s*\[(?:source|report)\]\((?:report|\/report|null|report_pdf_url|#?)\)/gi, '');
  out = out.replace(/\s*\(no citation available\)/gi, '');
  out = out.replace(/\s*\bno citation available\b/gi, '');

  out = repairOrphanedBrokenLinks(out, byPdf);

  const companyNames = byPdf.map((entry) => entry.row.company).filter(Boolean);

  // Inject citation after known metric VALUES only when the line (or ### heading) names that company.
  for (const { row, pages, pdfUrl } of byPdf) {
    if (!row.company) continue;

    for (const metric of CITABLE_METRICS) {
      const page = pages[metric];
      const value = Number(row[metric]);
      if (!page || !Number.isFinite(value) || value === 0) continue;

      const citation = citationMarkdown(page, pdfUrl);
      if (!citation) continue;
      if (out.includes(`${value}`) === false
        && out.replace(/,/g, '').includes(String(value).replace(/,/g, '')) === false) {
        continue;
      }

      const variants = numberVariantsForCitation(value);
      for (const variant of variants) {
        const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(
          `(^|[^\\d.,])(${escaped})(\\s*(?:tCO2e|MtCO2e|MtCO2|tCO₂e|%)?)`,
          'gi',
        );

        let didReplace = false;
        out = out.replace(re, (full, prefix, num, unit = '', offset) => {
          const lineStart = out.lastIndexOf('\n', offset - 1) + 1;
          if (!lineBelongsToCompany(out, lineStart, row.company)) return full;

          const lineEnd = out.indexOf('\n', offset);
          const line = out.slice(lineStart, lineEnd === -1 ? out.length : lineEnd);
          if (!lineMatchesMetric(line, metric)) return full;
          // Model already cited this bullet (often after the breakdown) — don't add another.
          if (lineAlreadyHasCitation(line)) return full;

          const after = out.slice(offset + full.length, offset + full.length + 80);
          if (/p\.\s*\d+\s*\[source\]\(|\[p\.\s*\d+\]\(|\[source\]\(/.test(after)) return full;
          if (/^20\d{2}$/.test(num)) return full;
          didReplace = true;
          return `${prefix}${num}${unit} ${citation}`;
        });
        if (didReplace) break;
      }
    }
  }

  if (byPdf.some((x) => x.pdfUrl)) {
    out = out.replace(/Unfortunately, there is no available PDF link[^.]*\./gi, '');
    out = out.replace(/there is no available PDF link for further reference\.?/gi, '');
    out = out.replace(/there are no available citations or PDF links for this report\.?/gi, '');
    out = out.replace(/However, there is no available PDF link[^.]*\./gi, '');
    out = out.replace(/The absence of a PDF link[^.]*\./gi, '');
  }

  out = normalizeLegacyCitations(out, byPdf);
  out = dedupeInlineCitations(out);
  out = stripMisleadingCitationsFromAggregates(out, companyNames);
  out = stripMalformedCitationLinks(out);
  out = stripIrrelevantShareBreakdowns(out);
  out = stripSourcesFooter(out);

  // Restore the original code blocks literally to avoid any $ issue
  for (const block of codeBlocks) {
    out = out.split(block.placeholder).join(block.content);
  }

  return out;
}
