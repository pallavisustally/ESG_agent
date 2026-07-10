import { CITABLE_METRICS } from './report-sources.js';
import {
  extractMetricValuesFromRow,
  verifyValueOnPdfPage,
} from './page-index.js';

const CITATION_RE = /p\.\s*(\d+)\s*\[source\]\(([^)]+)\)|\[p\.\s*(\d+)\]\(([^)]+)\)/gi;

function normalizePdfUrl(url) {
  if (!url) return null;
  return String(url).split('#')[0];
}

function parseNumericToken(token) {
  if (!token) return null;
  const cleaned = String(token).replace(/,/g, '');
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function extractValueBeforeCitation(line, citationStart) {
  const before = line.slice(0, citationStart);
  const matches = [...before.matchAll(/(\d[\d,]*(?:\.\d+)?)/g)];
  if (!matches.length) return null;

  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const num = parseNumericToken(matches[i][1]);
    if (num == null) continue;
    if (/^20\d{2}$/.test(matches[i][1])) continue;
    if (Math.abs(num) < 1) continue;
    return num;
  }
  return null;
}

export function parseCitationsFromText(text) {
  if (!text) return [];

  const citations = [];
  const lines = String(text).split('\n');

  for (const line of lines) {
    let match;
    CITATION_RE.lastIndex = 0;
    while ((match = CITATION_RE.exec(line)) !== null) {
      const page = Number(match[1] || match[3]);
      const rawUrl = match[2] || match[4];
      const pdfUrl = normalizePdfUrl(rawUrl);
      const value = extractValueBeforeCitation(line, match.index);

      citations.push({
        value,
        page,
        pdfUrl,
        raw: match[0],
        line: line.trim(),
      });
    }
  }

  return citations;
}

export async function verifySourceRowMetrics(row) {
  if (!row?.pdf_url) {
    return {
      company: row?.company || null,
      year: row?.year || null,
      pdfUrl: null,
      checks: [],
      summary: { total: 0, verified: 0, failed: 0, skipped: 0 },
    };
  }

  let metricPages = {};
  if (row.metric_pages_json) {
    try {
      metricPages = JSON.parse(row.metric_pages_json) || {};
    } catch {
      metricPages = {};
    }
  }

  const metricValues = extractMetricValuesFromRow(row);
  const checks = [];

  for (const metric of CITABLE_METRICS) {
    const value = metricValues[metric];
    if (value == null) continue;

    const page = metricPages[metric];
    if (!page) {
      checks.push({
        metric,
        value,
        page: null,
        verified: null,
        status: 'no_page_index',
      });
      continue;
    }

    const result = await verifyValueOnPdfPage(row.pdf_url, page, value, { metric, row });
    checks.push({
      metric,
      value,
      page,
      verified: result.verified,
      status: result.status,
      snippet: result.snippet,
      error: result.error || null,
    });
  }

  const verified = checks.filter((c) => c.verified === true).length;
  const failed = checks.filter((c) => c.verified === false).length;
  const skipped = checks.filter((c) => c.verified == null).length;

  return {
    company: row.company,
    year: row.year,
    pdfUrl: row.pdf_url,
    checks,
    summary: {
      total: checks.length,
      verified,
      failed,
      skipped,
    },
  };
}

export async function verifyParsedCitations(citations = []) {
  const checks = [];

  for (const citation of citations) {
    if (!citation.pdfUrl || !citation.page) {
      checks.push({
        ...citation,
        verified: null,
        status: 'incomplete_citation',
      });
      continue;
    }

    if (citation.value == null) {
      checks.push({
        ...citation,
        verified: null,
        status: 'value_not_found_near_citation',
      });
      continue;
    }

    const result = await verifyValueOnPdfPage(
      citation.pdfUrl,
      citation.page,
      citation.value,
    );
    checks.push({
      ...citation,
      verified: result.verified,
      status: result.status,
      snippet: result.snippet,
      error: result.error || null,
    });
  }

  const verified = checks.filter((c) => c.verified === true).length;
  const failed = checks.filter((c) => c.verified === false).length;
  const skipped = checks.filter((c) => c.verified == null).length;

  return {
    checks,
    summary: {
      total: checks.length,
      verified,
      failed,
      skipped,
    },
  };
}

export async function verifyAgentCitations(text, sourceRows = [], options = {}) {
  const auditSourceRows = options.auditSourceRows
    ?? process.env.VERIFY_FULL_SOURCE_CITATIONS === 'true';

  const parsedCitations = parseCitationsFromText(text);
  const responseVerification = await verifyParsedCitations(parsedCitations);

  const sourceVerifications = [];
  if (auditSourceRows) {
    for (const row of sourceRows) {
      if (!row?.pdf_url) continue;
      sourceVerifications.push(await verifySourceRowMetrics(row));
    }
  }

  const sourceVerified = sourceVerifications.reduce((sum, item) => sum + item.summary.verified, 0);
  const sourceFailed = sourceVerifications.reduce((sum, item) => sum + item.summary.failed, 0);
  const responseVerified = responseVerification.summary.verified;
  const responseFailed = responseVerification.summary.failed;

  const pass = responseFailed === 0 && sourceFailed === 0;

  return {
    pass,
    response: responseVerification,
    sources: sourceVerifications,
    summary: {
      responseVerified,
      responseFailed,
      sourceVerified,
      sourceFailed,
      parsedCitations: parsedCitations.length,
    },
  };
}
