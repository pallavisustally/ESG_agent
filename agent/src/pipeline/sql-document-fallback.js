/**
 * SQL → company-scoped document fallback (narrative/data_json → single PDF).
 *
 * Order (after structured SQL + derived resolution already attempted):
 *   1) retrieveCompanyNarrative (one company + year)
 *   2) getReportSourceRow → resolvePdfUrlForRow → searchPdfPagesForQuery
 *   3) company-specific unavailable
 *
 * Never searches all reports. Never used for rankings / sector / Top-N / aggregates.
 * Enable/disable: SQL_DOCUMENT_FALLBACK=true|false (default: true).
 * Max companies: SQL_DOCUMENT_FALLBACK_MAX_COMPANIES (default: 3).
 */

import { INTENTS } from '../intent/classify-intent.js';
import {
  METRIC_RESOLUTION,
  looksLikeMetricQuestion,
  COMPANY_METRIC_UNAVAILABLE_RESPONSE,
} from '../intent/metric-resolution.js';
import { getReportSourceRow, getCompanyList } from '../db.js';
import { resolvePdfUrlForRow, isUsablePdfUrl } from '../report-sources.js';
import { searchPdfPagesForQuery } from '../page-index.js';
import {
  retrieveCompanyNarrative,
  formatNarrativeAnswer,
} from '../rag/brsr-chunks.js';
import { validateRagEvidence } from '../validation/response-validator.js';
import { resolveCompanyEntity } from '../sql-agent/company-resolve.js';
import {
  scoreNarrativeConfidence,
  scorePdfConfidence,
  shouldAcceptRetrieval,
  DEFAULT_MIN_ACCEPT,
} from '../retrieval/confidence-retrieval.js';
import { attachReportPdfVisualization } from '../answers/response-media.js';

const DEFAULT_DOCUMENT_FALLBACK_MAX_COMPANIES = 3;
const ABS_DOCUMENT_FALLBACK_MAX_COMPANIES = 20;

/**
 * Configurable cap for company-scoped document fallback.
 * Env (either name):
 *   SQL_DOCUMENT_FALLBACK_MAX_COMPANIES (preferred)
 *   MAX_DOCUMENT_FALLBACK_COMPANIES (alias)
 * Default 3, hard cap 20.
 */
export function getDocumentFallbackMaxCompanies() {
  const raw = parseInt(
    process.env.SQL_DOCUMENT_FALLBACK_MAX_COMPANIES
      || process.env.MAX_DOCUMENT_FALLBACK_COMPANIES
      || '',
    10,
  );
  if (Number.isFinite(raw) && raw >= 1) {
    return Math.min(raw, ABS_DOCUMENT_FALLBACK_MAX_COMPANIES);
  }
  return DEFAULT_DOCUMENT_FALLBACK_MAX_COMPANIES;
}

/** @deprecated Prefer getDocumentFallbackMaxCompanies() — kept for callers expecting a constant. */
export const DOCUMENT_FALLBACK_MAX_COMPANIES = DEFAULT_DOCUMENT_FALLBACK_MAX_COMPANIES;

/** Intents that must never use PDF/document fallback. */
export const DOCUMENT_FALLBACK_BLOCKED_INTENTS = new Set([
  INTENTS.LIST_ALL_COMPANIES,
  INTENTS.COUNT_COMPANIES,
  INTENTS.FILTER_BY_SECTOR,
  INTENTS.TOP_METRIC,
  INTENTS.BOTTOM_METRIC,
  INTENTS.SECTOR_SUMMARY,
  INTENTS.PAGINATE_CONTINUE,
  INTENTS.CHART_REQUEST,
  INTENTS.TREND_ANALYSIS,
]);

/** Rankings / aggregates stay SQL-only — COMPARE is blocked unless unsupported company metric. */

export function isSqlDocumentFallbackEnabled() {
  const flag = process.env.SQL_DOCUMENT_FALLBACK;
  if (flag == null || flag === '') return true;
  return flag === '1' || /^true$/i.test(flag);
}

export function companyMetricUnavailableResponse(company = null, year = null) {
  if (company) {
    return year
      ? `The requested metric is not available in this company's BRSR report (**${company}**, ${year}).`
      : `The requested metric is not available in this company's BRSR report (**${company}**).`;
  }
  return COMPANY_METRIC_UNAVAILABLE_RESPONSE;
}

/**
 * Resolve company hints for fallback (classification entities / memory / SQL data).
 */
export function resolveFallbackCompanies(classification = null, memory = null, sqlData = null) {
  const fromSql = sqlData?.resolvedCompany ? [sqlData.resolvedCompany] : [];
  const fromClass = Array.isArray(classification?.entities) ? classification.entities : [];
  const fromMemory = Array.isArray(memory?.lastCompanies) && memory.lastCompanies.length
    ? memory.lastCompanies
    : (memory?.resolvedCompany ? [memory.resolvedCompany] : []);
  const filtersCompany = classification?.filters?.resolvedCompany
    ? [classification.filters.resolvedCompany]
    : [];
  const merged = [...fromSql, ...fromClass, ...filtersCompany, ...fromMemory]
    .map((c) => String(c || '').trim())
    .filter(Boolean);
  return [...new Set(merged)].slice(0, getDocumentFallbackMaxCompanies());
}

export function resolveFallbackYear(classification = null, memory = null, sqlData = null) {
  const y = classification?.filters?.years?.[0]
    ?? sqlData?.year
    ?? memory?.lastYear
    ?? null;
  if (y == null || y === '') return null;
  const n = Number(y);
  return Number.isFinite(n) ? n : null;
}

/**
 * True when document fallback is allowed for this turn.
 */
export function isCompanyScopedDocumentFallbackEligible({
  classification = null,
  plan = null,
  companies = [],
  userMessage = '',
} = {}) {
  if (!isSqlDocumentFallbackEnabled()) return false;

  const intent = classification?.intent || plan?.intent || null;
  if (!intent || DOCUMENT_FALLBACK_BLOCKED_INTENTS.has(intent)) return false;

  const list = Array.isArray(companies) ? companies.filter(Boolean) : [];
  if (!list.length || list.length > getDocumentFallbackMaxCompanies()) return false;

  const unsupported = classification?.metricResolution === METRIC_RESOLUTION.UNSUPPORTED
    || classification?.filters?.unsupportedMetric
    || plan?.strategy === 'unsupported_metric';

  // Numeric compare rankings stay SQL-only; allow COMPARE only for unsupported company metrics.
  if (intent === INTENTS.COMPARE_COMPANIES && !unsupported) return false;

  const companyScopedIntent = intent === INTENTS.METRIC_LOOKUP
    || intent === INTENTS.REPORT_LOOKUP
    || intent === INTENTS.COMPARE_COMPANIES
    || unsupported;

  if (!companyScopedIntent) return false;

  const hasMetric = Boolean(
    classification?.metric
    || classification?.filters?.metric
    || plan?.metric,
  );

  if (unsupported || hasMetric) return true;
  if (looksLikeMetricQuestion(userMessage)) return true;
  return intent === INTENTS.METRIC_LOOKUP || intent === INTENTS.REPORT_LOOKUP;
}

function metricLabel(metric) {
  if (!metric) return 'the requested metric';
  if (metric === 'total_emissions') return 'total GHG emissions (Scope 1+2+3)';
  return String(metric).replace(/_/g, ' ');
}

function formatPdfFallbackAnswer({
  company,
  year,
  pdfUrl,
  hits,
  query,
  metric,
}) {
  const lines = [
    `### BRSR PDF excerpt — ${company}${year ? ` (${year})` : ''}`,
    '',
    `Structured SQL did not return **${metricLabel(metric)}** for this company. `
      + 'The following is from that company\'s BRSR PDF only (not a cross-company search):',
    '',
  ];
  for (const hit of hits.slice(0, 3)) {
    lines.push(`- **Page ${hit.page}**: ${hit.snippet}`);
  }
  if (pdfUrl) {
    const page = hits[0]?.page;
    const href = page ? `${pdfUrl}#page=${page}` : pdfUrl;
    lines.push('', `PDF: [source${page ? ` p.${page}` : ''}](${href})`);
  }
  if (query) {
    lines.push('', `_Matched query terms against the resolved company report for “${query}”._`);
  }
  return lines.join('\n');
}

/**
 * Search one company's narrative/data_json, then that company's PDF only.
 * Phase 8: each stage is confidence-gated — weak narrative does not block PDF;
 * weak PDF is rejected in favor of unavailable.
 * Optional `deps` overrides exist for regression tests (do not use in production paths).
 * @returns {Promise<{ ok: boolean, text?: string, source?: string, company?: string, year?: number|null, data?: object, confidence?: number, attempts?: object[] }>}
 */
export async function tryCompanyDocumentFallback({
  companyHint,
  year = null,
  query = '',
  metric = null,
  onProgress = null,
  deps = null,
  minAccept = DEFAULT_MIN_ACCEPT,
} = {}) {
  const {
    resolveCompany = resolveCompanyEntity,
    listCompanies = getCompanyList,
    retrieveNarrative = retrieveCompanyNarrative,
    getSourceRow = getReportSourceRow,
    resolvePdfUrl = resolvePdfUrlForRow,
    searchPdf = searchPdfPagesForQuery,
    validateEvidence = validateRagEvidence,
    formatNarrative = formatNarrativeAnswer,
  } = deps || {};

  const attempts = [];

  if (!companyHint) {
    return { ok: false, reason: 'no_company', confidence: 0, attempts };
  }

  const resolved = await resolveCompany(companyHint, listCompanies);
  if (resolved.status === 'ambiguous') {
    return { ok: true, text: resolved.message, source: 'clarify', data: resolved, confidence: 1, attempts };
  }
  if (resolved.status !== 'resolved') {
    return { ok: false, reason: 'company_not_found', data: resolved, confidence: 0, attempts };
  }
  const company = resolved.company;

  onProgress?.({
    status: 'tool_start',
    tool: 'document_fallback_narrative',
    message: `Searching ${company} BRSR narrative / data_json…`,
  });

  const narrative = await retrieveNarrative(query || metricLabel(metric), {
    companyHint: company,
    year,
    limit: 8,
  });

  onProgress?.({
    status: 'tool_end',
    tool: 'document_fallback_narrative',
    message: `Found ${narrative.chunks?.length || 0} snippet(s).`,
  });

  if (narrative.status === 'ambiguous') {
    return { ok: true, text: narrative.message, source: 'clarify', data: narrative, confidence: 1, attempts };
  }

  if (narrative.chunks?.length) {
    const ragValidation = validateEvidence({
      chunks: narrative.chunks,
      company: narrative.company || company,
      minChunks: 1,
    });
    const narrativeScore = scoreNarrativeConfidence({
      chunks: narrative.chunks,
      company: narrative.company || company,
      query: query || metricLabel(metric),
    });
    attempts.push({
      source: 'narrative',
      confidence: narrativeScore.confidence,
      reason: narrativeScore.reason,
    });

    if (ragValidation.ok && shouldAcceptRetrieval(narrativeScore.confidence, { minAccept })) {
      const rawText = formatNarrative({
        company: narrative.company || company,
        year: narrative.year ?? year,
        pdf_url: narrative.pdf_url,
        chunks: narrative.chunks,
        query: query || metricLabel(metric),
      });
      const text = attachReportPdfVisualization(rawText, {
        company: narrative.company || company,
        year: narrative.year ?? year,
        userMessage: query || metricLabel(metric),
        fromPdf: false,
      });
      return {
        ok: true,
        text,
        source: 'narrative',
        company: narrative.company || company,
        year: narrative.year ?? year,
        data: { chunks: narrative.chunks, pdf_url: narrative.pdf_url },
        confidence: narrativeScore.confidence,
        attempts,
      };
    }
    // Low narrative confidence → continue to PDF (Phase 8 ladder).
  } else {
    attempts.push({ source: 'narrative', confidence: 0, reason: 'no_chunks' });
  }

  const reportYear = narrative.year ?? year;
  onProgress?.({
    status: 'tool_start',
    tool: 'document_fallback_pdf',
    message: `Opening ${company}${reportYear ? ` (${reportYear})` : ''} BRSR PDF…`,
  });

  let row = null;
  if (reportYear) {
    row = await getSourceRow(company, reportYear);
  }
  if (!row && !reportYear) {
    const latestNarrative = await retrieveNarrative('strategy', {
      companyHint: company,
      year: null,
      limit: 1,
    });
    if (latestNarrative.year) {
      row = await getSourceRow(company, latestNarrative.year);
    }
  }

  if (!row) {
    onProgress?.({
      status: 'tool_end',
      tool: 'document_fallback_pdf',
      message: 'No report row for PDF search.',
    });
    return {
      ok: false,
      reason: 'no_report_row',
      company,
      year: reportYear,
      text: companyMetricUnavailableResponse(company, reportYear),
      confidence: 0,
      attempts,
    };
  }

  const pdfUrl = resolvePdfUrl(row);
  if (!pdfUrl || !isUsablePdfUrl(pdfUrl)) {
    onProgress?.({
      status: 'tool_end',
      tool: 'document_fallback_pdf',
      message: 'PDF URL unavailable.',
    });
    return {
      ok: false,
      reason: 'no_pdf',
      company: row.company,
      year: row.year,
      text: companyMetricUnavailableResponse(row.company, row.year),
      confidence: 0,
      attempts,
    };
  }

  const search = await searchPdf(pdfUrl, {
    query: query || metricLabel(metric),
    metric,
    limit: 3,
    minScore: 8,
  });

  onProgress?.({
    status: 'tool_end',
    tool: 'document_fallback_pdf',
    message: search.hits?.length
      ? `Found ${search.hits.length} PDF page hit(s).`
      : 'No matching PDF pages.',
  });

  const pdfScore = scorePdfConfidence({ hits: search.hits || [] });
  attempts.push({
    source: 'pdf',
    confidence: pdfScore.confidence,
    reason: pdfScore.reason,
    bestScore: pdfScore.bestScore,
  });

  if (search.hits?.length && shouldAcceptRetrieval(pdfScore.confidence, { minAccept })) {
    const rawText = formatPdfFallbackAnswer({
      company: row.company,
      year: row.year,
      pdfUrl,
      hits: search.hits,
      query,
      metric,
    });
    const text = attachReportPdfVisualization(rawText, {
      company: row.company,
      year: row.year,
      userMessage: query || metricLabel(metric),
      fromPdf: true,
    });
    return {
      ok: true,
      text,
      source: 'pdf',
      company: row.company,
      year: row.year,
      data: { pdf_url: pdfUrl, hits: search.hits, scannedAllPages: search.scannedAllPages },
      confidence: pdfScore.confidence,
      attempts,
    };
  }

  // Prefer best weak attempt only when it still has some signal; else unavailable.
  const bestAttempt = [...attempts].sort((a, b) => b.confidence - a.confidence)[0];
  if (bestAttempt?.source === 'narrative' && bestAttempt.confidence > 0 && narrative.chunks?.length) {
    // Extremely weak — still do not return misleading narrative when below floor.
  }

  return {
    ok: false,
    reason: pdfScore.confidence > 0 ? 'pdf_low_confidence' : 'not_found',
    company: row.company,
    year: row.year,
    text: companyMetricUnavailableResponse(row.company, row.year),
    confidence: Math.max(pdfScore.confidence, bestAttempt?.confidence || 0),
    attempts,
  };
}

/**
 * Run document fallback for one or more resolved companies (≤ MAX).
 * Returns first successful answer, or a consolidated unavailable message.
 */
export async function runSqlDocumentFallback({
  classification = null,
  plan = null,
  memory = null,
  sqlData = null,
  userMessage = '',
  onProgress = null,
  returnUnavailable = true,
  deps = null,
} = {}) {
  const companies = resolveFallbackCompanies(classification, memory, sqlData);
  if (!isCompanyScopedDocumentFallbackEligible({
    classification,
    plan,
    companies,
    userMessage,
  })) {
    return null;
  }

  const year = resolveFallbackYear(classification, memory, sqlData);
  const metric = classification?.metric
    || classification?.filters?.metric
    || plan?.metric
    || null;

  const parts = [];
  let anyOk = false;
  const lastFail = { company: companies[0], year };

  for (const hint of companies) {
    const result = await tryCompanyDocumentFallback({
      companyHint: hint,
      year,
      query: userMessage,
      metric,
      onProgress,
      deps,
    });
    if (result.ok && result.text) {
      anyOk = true;
      parts.push(result.text);
      if (companies.length === 1) {
        return {
          handled: true,
          text: result.text,
          source: result.source,
          company: result.company,
          year: result.year,
          data: result.data,
          confidence: result.confidence,
          attempts: result.attempts,
          forbidLlmFallback: true,
        };
      }
    } else if (result.text && result.reason) {
      lastFail.company = result.company || hint;
      lastFail.year = result.year ?? year;
    }
  }

  if (anyOk) {
    return {
      handled: true,
      text: parts.join('\n\n---\n\n'),
      source: 'document_fallback',
      forbidLlmFallback: true,
    };
  }

  if (!returnUnavailable) return null;

  return {
    handled: true,
    text: companyMetricUnavailableResponse(lastFail.company, lastFail.year),
    source: 'unavailable',
    company: lastFail.company,
    year: lastFail.year,
    forbidLlmFallback: true,
  };
}
