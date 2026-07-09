import fs from 'fs';
import path from 'path';
import { resolveFromProject } from './paths.js';

const METADATA_PATH = process.env.METADATA_PATH
  ? path.resolve(process.env.METADATA_PATH)
  : resolveFromProject('data', 'nse_sustainability_metadata.json');

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

export function buildSourcesPayload(row, metricPages = null) {
  const pages = metricPages && typeof metricPages === 'object' ? metricPages : {};
  const pdfUrl = row.pdf_url || row.report_pdf_url || null;
  const xbrlUrl = row.xbrl_url || row.report_xbrl_url || null;

  const metrics = {};
  const readyCitations = {};
  const flatFields = {};

  for (const metric of CITABLE_METRICS) {
    const num = Number(row[metric]);
    if (!Number.isFinite(num)) continue;
    const page = pages[metric] ?? null;
    const citation = page && pdfUrl
      ? `[p. ${page}](${pdfUrl})`
      : pdfUrl
        ? `[report](${pdfUrl})`
        : null;
    metrics[metric] = {
      value: num,
      page,
      citation,
    };
    if (citation) {
      readyCitations[metric] = citation;
      flatFields[`${metric}_page`] = page;
      flatFields[`${metric}_citation`] = citation;
    }
  }

  return {
    company: row.company,
    year: row.year,
    report_pdf_url: pdfUrl,
    report_xbrl_url: xbrlUrl,
    metrics,
    ready_citations: readyCitations,
    flat_fields: flatFields,
    citation_hint: pdfUrl
      ? 'REQUIRED format: VALUE UNIT followed by the exact markdown from <metric>_citation (prefer [p. N](url) over [report](url)). Example: 56,820 tCO2e ([p. 39](https://...pdf))'
      : 'No PDF URL available for this report; cite company and year only.',
  };
}

function attachMetadataUrls(row) {
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
    if (!sourceRow) {
      const withMeta = attachMetadataUrls(row);
      const sources = buildSourcesPayload(withMeta);
      return {
        ...withMeta,
        ...sources.flat_fields,
        report_pdf_url: sources.report_pdf_url,
        report_xbrl_url: sources.report_xbrl_url,
        sources,
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

    const merged = attachMetadataUrls({ ...row, ...sourceRow });
    const sources = buildSourcesPayload(merged, metricPages);
    return {
      ...row,
      ...sources.flat_fields,
      report_pdf_url: sourceRow.pdf_url || row.report_pdf_url || null,
      report_xbrl_url: sourceRow.xbrl_url || row.report_xbrl_url || null,
      sources,
    };
  });
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

  const flatRow = {
    company: reportData.company,
    year: reportData.year,
    pdf_url: sourceRow?.pdf_url || null,
    xbrl_url: sourceRow?.xbrl_url || null,
  };

  for (const metric of CITABLE_METRICS) {
    const fromMetrics = reportData.metrics?.[metric];
    flatRow[metric] = typeof fromMetrics === 'object' ? fromMetrics?.value : fromMetrics;
  }

  const sources = buildSourcesPayload(flatRow, metricPages);
  return {
    ...reportData,
    ...sources.flat_fields,
    report_pdf_url: sources.report_pdf_url,
    report_xbrl_url: sources.report_xbrl_url,
    sources,
  };
}

function preferredPageForRow(pages = {}) {
  return pages.scope1_emissions
    || pages.scope2_emissions
    || pages.renewable_energy_share
    || pages.female_employee_share
    || Object.values(pages).find(Boolean)
    || null;
}

function citationMarkdown(page, pdfUrl) {
  return page ? `[p. ${page}](${pdfUrl})` : `[report](${pdfUrl})`;
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Model-invented relative links like [source](report) resolve to /report on the app host. */
const BROKEN_RELATIVE_LINK_RE = /\[(?:source|report)\]\((?:report|\/report|null|report_pdf_url|#?)\)/gi;

function resolvePdfUrlForRow(row) {
  let pdfUrl = row.pdf_url || row.report_pdf_url || null;
  if (!pdfUrl) {
    const meta = lookupNseMetadata({
      filename: row.filename,
      company: row.company,
      year: row.year,
    });
    pdfUrl = meta?.pdfUrl || null;
  }
  return pdfUrl;
}

function repairBrokenLinksNearCompany(out, company, citation) {
  const companyEsc = escapeRegex(company);
  if (!companyEsc) return out;

  return out.replace(
    new RegExp(
      `^([^\n]*${companyEsc}[^\n]*?)(\\[(?:source|report)\\]\\([^\\)]*\\)|\\(no citation available\\)|\\bno citation available\\b)`,
      'gim',
    ),
    (_, prefix) => `${prefix}${citation}`,
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

  const byPdf = [];
  for (const row of sourceRows) {
    let pages = {};
    if (row.metric_pages_json) {
      try {
        pages = JSON.parse(row.metric_pages_json) || {};
      } catch {
        pages = {};
      }
    }
    const pdfUrl = resolvePdfUrlForRow(row);
    if (!pdfUrl) continue;
    byPdf.push({ row, pages, pdfUrl, preferredPage: preferredPageForRow(pages) });
  }

  // Company-local broken placeholders -> real citation (with or without page numbers)
  for (const { row, pdfUrl, preferredPage } of byPdf) {
    const pageCitation = citationMarkdown(preferredPage, pdfUrl);
    out = repairBrokenLinksNearCompany(out, row.company, pageCitation);
  }

  // [report](exact-url) -> [p. N](url)
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
    out = out.replace(/\[report\]\(null\)/gi, pageCitation);
    out = out.replace(/\[source\]\([^)]*\)/gi, pageCitation);
    out = out.replace(/\(no citation available\)/gi, `(${pageCitation})`);
    out = out.replace(/\bno citation available\b/gi, pageCitation);
  } else {
    out = out.replace(/\[source\]\(report_pdf_url\)/gi, '');
  }

  out = repairOrphanedBrokenLinks(out, byPdf);

  // Inject citation after known metric VALUES (with ESG unit or clear standalone decimals).
  for (const { row, pages, pdfUrl } of byPdf) {
    for (const metric of CITABLE_METRICS) {
      const page = pages[metric];
      const value = Number(row[metric]);
      if (!page || !Number.isFinite(value) || value === 0) continue;

      const citation = citationMarkdown(page, pdfUrl);
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
          const after = out.slice(offset + full.length, offset + full.length + 80);
          if (/\[p\.\s*\d+\]\(|\[report\]\(|\[source\]\(/.test(after)) return full;
          // Skip if this number is part of a year-like 20xx already cited nearby
          if (/^20\d{2}$/.test(num)) return full;
          didReplace = true;
          return `${prefix}${num}${unit} (${citation})`;
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

  const urls = [...new Set(byPdf.map((x) => x.pdfUrl).filter(Boolean))];
  if (urls.length) {
    const sourcesBlock = urls.map((u) => `- ${u}`).join('\n');
    if (/##\s*Sources/i.test(out)) {
      out = out.replace(/##\s*Sources[\s\S]*$/i, `## Sources\n${sourcesBlock}\n`);
    } else {
      out += `\n\n## Sources\n${sourcesBlock}\n`;
    }
  }

  // Restore the original code blocks literally to avoid any $ issue
  for (const block of codeBlocks) {
    out = out.split(block.placeholder).join(block.content);
  }

  return out;
}
