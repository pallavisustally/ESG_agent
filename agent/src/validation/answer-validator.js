/**
 * Unified Answer Validation — mandatory gate after engines / before final return.
 *
 * Verdicts: PASS | WARNING | ERROR
 * - PASS: hard checks ok (info-only issues allowed)
 * - WARNING: soft issues only — return answer, record warnings
 * - ERROR: hard trust failure — repair once, else safe failure
 *
 * Wraps existing response-validator + chart-validate; does not replace engines.
 */

import { INTENTS } from '../intent/classify-intent.js';
import { issuerIdFromName } from '../sql-agent/company-identity.js';
import { validateChartSpec } from '../visualization/chart-validate.js';
import {
  validateResponse,
  repairListResponse,
  repairFabricatedLlmAnswer,
} from './response-validator.js';
import { explainSqlFailure } from '../answers/sql-failure.js';

export const VERDICTS = Object.freeze({
  PASS: 'PASS',
  WARNING: 'WARNING',
  ERROR: 'ERROR',
});

const SAFE_FAILURE_MESSAGE = [
  'I couldn\'t verify that this answer fully matches the requested company / metric / year from trusted BRSR sources, so I\'m not returning unverified results.',
  '',
  'Please retry or rephrase — I won\'t invent ESG figures.',
].join('\n');

/** Error codes that warrant a replan / grounded failure (not a soft warning). */
const HARD_ERROR_RE = /metric_mismatch|sql_metric_mismatch|company_mismatch|year_mismatch|wrong_source|metric_answered_by_narrative|empty_response|empty_dataset|ranking_not_sorted|ranking_empty|llm_possible_fabricated|llm_admits_fabrication|chart_data_mismatch|chart_company_mismatch|chart_value_mismatch|citations_required_missing|incomplete_compare|sample_instead_of_all|incomplete_list|count_missing|insufficient_rag|rag_chunks_wrong/i;

/**
 * @typedef {Object} ValidationIssue
 * @property {'error'|'warning'|'info'} severity
 * @property {string} code
 * @property {string} message
 */

/**
 * @typedef {Object} AnswerValidation
 * @property {'PASS'|'WARNING'|'ERROR'} verdict
 * @property {boolean} ok
 * @property {ValidationIssue[]} issues
 * @property {string[]} errors
 * @property {string[]} warnings
 * @property {boolean} shouldReplan
 * @property {string|null} reason
 * @property {object} checks
 */

/**
 * Feature flag — default ON. Set UNIFIED_ANSWER_VALIDATION=false to skip.
 */
export function isUnifiedAnswerValidationEnabled() {
  return process.env.UNIFIED_ANSWER_VALIDATION !== 'false';
}

/**
 * Validate a composed answer against request context + engine data.
 * Sync. Call applyAnswerValidation for repair + optional citation verify.
 *
 * @param {object} envelope
 * @returns {AnswerValidation}
 */
export function validateAnswer(envelope = {}) {
  const {
    text = '',
    classification = null,
    executionPlan = null,
    engineResults = [],
    data = null,
    visualization = null,
    citations = [],
    source = 'composer',
    ragChunks = null,
    company = null,
    hasToolEvidence = null,
    wantsAll = false,
    requireCitations = null,
    skipEntityChecks = false,
  } = envelope;

  const issues = [];
  const checks = {};

  // Clarifications are intentional incomplete answers.
  if (executionPlan?.needsClarification || classification?.needsClarification) {
    return buildResult({
      issues: [issue('info', 'clarification_skip', 'Clarification response — entity checks skipped.')],
      checks: { skipped: 'clarification' },
      shouldReplan: false,
    });
  }

  if (skipEntityChecks) {
    return buildResult({
      issues: [issue('info', 'entity_checks_skipped', 'Entity checks skipped by caller.')],
      checks: { skipped: 'caller' },
      shouldReplan: false,
    });
  }

  const intent = classification?.intent || null;
  const resolvedData = data || pickPrimaryData(engineResults);
  const resolvedSource = source || inferSource({ executionPlan, engineResults, classification });
  const citationsRequired = requireCitations != null
    ? Boolean(requireCitations)
    : shouldRequireCitations({ classification, executionPlan, source: resolvedSource });

  // 1) Core response checks (metric / company / year / source / completeness)
  const core = validateResponse({
    text,
    intent,
    wantsAll: wantsAll || classification?.wantsAll,
    data: resolvedData,
    classification,
    ragChunks,
    company: company || classification?.entities?.[0] || null,
    hasToolEvidence,
    source: mapSourceForCore(resolvedSource),
  });
  checks.core = {
    ok: core.ok,
    reason: core.reason || null,
    errors: core.errors || [],
    warnings: core.warnings || [],
  };
  for (const code of core.errors || []) {
    issues.push(issue('error', code, codeToMessage(code)));
  }
  for (const code of core.warnings || []) {
    issues.push(issue('warning', code, codeToMessage(code)));
  }

  // 2) Multi-entity completeness for compares
  const compareCheck = validateCompareCompleteness({
    classification,
    data: resolvedData,
    text,
  });
  checks.compare = compareCheck;
  issues.push(...compareCheck.issues);

  // 3) Chart integrity + chart ↔ data cross-check
  const chartPayload = resolveChartPayload(visualization, text);
  if (chartPayload) {
    const chartIntegrity = validateChartSpec(normalizeSpecFromConfig(chartPayload));
    checks.chartIntegrity = {
      ok: chartIntegrity.ok,
      errors: (chartIntegrity.errors || []).map((e) => e.code),
      warnings: (chartIntegrity.warnings || []).map((w) => w.code),
    };
    for (const e of chartIntegrity.errors || []) {
      issues.push(issue('error', e.code || 'CHART_INVALID', e.message || 'Chart invalid.'));
    }
    for (const w of chartIntegrity.warnings || []) {
      issues.push(issue('warning', w.code || 'CHART_WARNING', w.message || 'Chart warning.'));
    }
    for (const i of chartIntegrity.infos || []) {
      issues.push(issue('info', i.code || 'CHART_INFO', i.message || 'Chart info.'));
    }

    const cross = validateChartAgainstData({
      chart: chartPayload,
      data: resolvedData,
      classification,
    });
    checks.chartData = cross;
    issues.push(...cross.issues);
  } else {
    checks.chartIntegrity = { ok: true, skipped: true };
    checks.chartData = { ok: true, skipped: true };
  }

  // 4) Citations when required
  const citationCheck = validateCitationPresence({
    text,
    citations,
    required: citationsRequired,
  });
  checks.citations = citationCheck;
  issues.push(...citationCheck.issues);

  const shouldReplan = Boolean(core.shouldReplan)
    || issues.some((i) => i.severity === 'error' && HARD_ERROR_RE.test(i.code));

  return buildResult({ issues, checks, shouldReplan, reason: core.reason || null });
}

/**
 * Validate + repair once + return final text.
 * Optional async citationVerification from caller can be merged via options.citationVerification.
 *
 * @param {object} envelope - same as validateAnswer
 * @param {object} [options]
 * @param {object|null} [options.sqlResult] - for list repair
 * @param {object|null} [options.citationVerification] - from verifyAgentCitations
 * @returns {Promise<{ text: string, validation: AnswerValidation, repaired: boolean, repairActions: string[] }>}
 */
export async function applyAnswerValidation(envelope = {}, options = {}) {
  if (!isUnifiedAnswerValidationEnabled()) {
    return {
      text: String(envelope.text || ''),
      validation: buildResult({
        issues: [issue('info', 'validation_disabled', 'Unified answer validation disabled.')],
        checks: { disabled: true },
        shouldReplan: false,
      }),
      repaired: false,
      repairActions: [],
    };
  }

  let text = String(envelope.text || '');
  const repairActions = [];
  let validation = validateAnswer({ ...envelope, text });

  // Merge optional async citation verification results
  if (options.citationVerification) {
    validation = mergeCitationVerification(validation, options.citationVerification);
  }

  if (validation.verdict !== VERDICTS.ERROR) {
    return { text, validation, repaired: false, repairActions };
  }

  const repaired = repairAnswer({ ...envelope, text }, validation, options);
  if (repaired.text && repaired.text !== text) {
    text = repaired.text;
    repairActions.push(...repaired.repairActions);
    validation = validateAnswer({ ...envelope, text });
    if (options.citationVerification) {
      validation = mergeCitationVerification(validation, options.citationVerification);
    }
    // One repair attempt only
    if (validation.verdict === VERDICTS.ERROR) {
      text = safeFailureMessage(envelope, validation);
      repairActions.push('safe_failure');
      validation = {
        ...validation,
        reason: validation.reason || 'unrepairable_error',
        checks: { ...validation.checks, safeFailure: true, repairActions },
      };
    }
    return { text, validation, repaired: true, repairActions };
  }

  text = safeFailureMessage(envelope, validation);
  repairActions.push('safe_failure');
  return {
    text,
    validation: {
      ...validation,
      reason: validation.reason || 'unrepairable_error',
      checks: { ...validation.checks, safeFailure: true, repairActions },
    },
    repaired: true,
    repairActions,
  };
}

/**
 * Attempt deterministic repairs for ERROR verdicts.
 */
export function repairAnswer(envelope, validation, options = {}) {
  const repairActions = [];
  let text = String(envelope.text || '');
  const errors = validation?.errors || [];

  // List completeness → prefer SQL text
  if (errors.some((e) => /sample_instead_of_all|incomplete_list/i.test(e))) {
    const listRepaired = repairListResponse({
      validation: { ok: false, ...validation },
      sqlResult: options.sqlResult || envelope.sqlResult || null,
    });
    if (listRepaired) {
      repairActions.push('repair_list_response');
      return { text: listRepaired, repairActions };
    }
  }

  // Fabrication / narrative-for-metric
  if (errors.some((e) => /fabricat|metric_answered_by_narrative|wrong_source|ungrounded/i.test(e))) {
    const fab = repairFabricatedLlmAnswer({
      validation: { ok: false, errors },
      intent: envelope.classification?.intent,
      classification: envelope.classification,
    });
    if (fab) {
      repairActions.push('repair_fabricated_llm_answer');
      return { text: fab, repairActions };
    }
  }

  // Chart mismatch → strip chart, keep text
  if (errors.some((e) => /chart_|CHART_|LENGTH_MISMATCH|DUPLICATE_|EMPTY_SERIES|ALL_NULL/i.test(e))) {
    const stripped = stripChartBlocks(text);
    if (stripped !== text) {
      repairActions.push('strip_chart_block');
      text = stripped;
      // If only chart errors remain conceptually, still return stripped text for re-validate
      return { text, repairActions };
    }
  }

  // Broken/missing citations → strip citation lines when not strictly required after strip
  if (errors.some((e) => /citation/i.test(e))) {
    const stripped = stripBrokenCitationPlaceholders(text);
    if (stripped !== text) {
      repairActions.push('strip_bad_citations');
      return { text: stripped, repairActions };
    }
  }

  // Structured mismatch with engine dataText available → prefer dataText
  if (errors.some((e) => /metric_mismatch|company_mismatch|year_mismatch/i.test(e))) {
    const dataText = pickDataText(envelope.engineResults);
    if (dataText && dataText.trim() && dataText.trim() !== text.trim()) {
      repairActions.push('prefer_engine_data_text');
      return { text: dataText, repairActions };
    }
  }

  return { text: null, repairActions };
}

/**
 * Cross-check chart labels/values against structured rows.
 */
export function validateChartAgainstData({
  chart = null,
  data = null,
  classification = null,
} = {}) {
  const issues = [];
  if (!chart) return { ok: true, issues, skipped: true };

  const rows = Array.isArray(data?.rows) ? data.rows : [];
  if (!rows.length) {
    // Chart without structured rows — soft warning only (report/narrative charts)
    issues.push(issue(
      'warning',
      'chart_without_structured_rows',
      'Chart present without structured row payload for cross-check.',
    ));
    return { ok: true, issues };
  }

  const labels = extractChartLabels(chart);
  const values = extractChartPrimaryValues(chart);
  if (!labels.length) {
    issues.push(issue('error', 'chart_data_mismatch', 'Chart has no labels to compare against data.'));
    return { ok: false, issues };
  }

  // Company labels (ranking / compare): match against row companies
  const rowCompanies = rows.map((r) => r.company).filter(Boolean);
  const rowIds = new Set(rowCompanies.map((c) => issuerIdFromName(c)).filter(Boolean));
  const labelLooksLikeYears = labels.every((l) => /^\d{4}$/.test(String(l).trim()));

  if (!labelLooksLikeYears && rowIds.size) {
    let matched = 0;
    for (const label of labels) {
      const id = issuerIdFromName(label);
      if (id && rowIds.has(id)) {
        matched += 1;
        continue;
      }
      // Fuzzy: label substring of company name
      const lower = String(label).toLowerCase();
      if (rowCompanies.some((c) => String(c).toLowerCase().includes(lower.slice(0, 8))
        || lower.includes(String(c).toLowerCase().slice(0, 8)))) {
        matched += 1;
      }
    }
    const ratio = matched / labels.length;
    if (matched === 0) {
      issues.push(issue(
        'error',
        'chart_company_mismatch',
        'Chart labels do not match any returned company rows.',
      ));
    } else if (ratio < 0.5) {
      issues.push(issue(
        'error',
        'chart_company_mismatch',
        `Only ${matched}/${labels.length} chart labels match returned companies.`,
      ));
    } else if (ratio < 1) {
      issues.push(issue(
        'warning',
        'chart_partial_company_match',
        `${matched}/${labels.length} chart labels match returned companies.`,
      ));
    }
  }

  // Year labels (trend): match row years when present
  if (labelLooksLikeYears) {
    const rowYears = new Set(
      rows.map((r) => Number(r.year)).filter((y) => Number.isFinite(y)),
    );
    if (rowYears.size) {
      const missing = labels
        .map((l) => Number(String(l).trim()))
        .filter((y) => Number.isFinite(y) && !rowYears.has(y));
      if (missing.length === labels.length) {
        issues.push(issue(
          'error',
          'chart_data_mismatch',
          'Chart years do not match returned data years.',
        ));
      } else if (missing.length) {
        issues.push(issue(
          'warning',
          'chart_partial_year_match',
          `Chart includes year(s) not in rows: ${missing.slice(0, 5).join(', ')}.`,
        ));
      }
    }
  }

  // Value cross-check when lengths align with rows
  if (values.length && values.length === rows.length && !labelLooksLikeYears) {
    const rowVals = rows.map((r) => (
      r.metric_value != null ? Number(r.metric_value)
        : (r.value != null ? Number(r.value) : null)
    ));
    let mismatches = 0;
    for (let i = 0; i < values.length; i += 1) {
      const cv = values[i];
      const rv = rowVals[i];
      if (cv == null || rv == null || !Number.isFinite(cv) || !Number.isFinite(rv)) continue;
      if (!approxEqual(cv, rv)) mismatches += 1;
    }
    if (mismatches > 0 && mismatches >= Math.ceil(values.length * 0.5)) {
      issues.push(issue(
        'error',
        'chart_value_mismatch',
        `Chart values disagree with row metric values (${mismatches}/${values.length}).`,
      ));
    } else if (mismatches > 0) {
      issues.push(issue(
        'warning',
        'chart_partial_value_mismatch',
        `${mismatches} chart value(s) differ from row metric values.`,
      ));
    }
  }

  // Metric metadata on chart vs requested
  const requestedMetric = classification?.metric || data?.metric || null;
  const chartMetric = chart.metric || chart.meta?.metric || null;
  if (requestedMetric && chartMetric && chartMetric !== requestedMetric && chartMetric !== 'total_emissions') {
    issues.push(issue(
      'error',
      'chart_data_mismatch',
      `Chart metric ${chartMetric} != requested ${requestedMetric}.`,
    ));
  }

  const hasError = issues.some((i) => i.severity === 'error');
  return { ok: !hasError, issues };
}

/**
 * Citation presence when required for report/PDF answers.
 */
export function validateCitationPresence({
  text = '',
  citations = [],
  required = false,
} = {}) {
  const issues = [];
  if (!required) {
    return { ok: true, issues, required: false };
  }

  const list = Array.isArray(citations) ? citations.filter(Boolean) : [];
  const body = String(text || '');
  const hasInline = /\[[^\]]+\]\((https?:\/\/|\/local-pdf\/)[^)]+\)/i.test(body)
    || /\bp\.\s*\d+/i.test(body)
    || /\*\*Sources?\*\*/i.test(body)
    || /ready_citations|report_pdf/i.test(body);
  const hasCitations = list.length > 0 || hasInline;

  if (!hasCitations) {
    issues.push(issue(
      'error',
      'citations_required_missing',
      'Answer requires citations but none were found.',
    ));
    return { ok: false, issues, required: true };
  }

  return { ok: true, issues, required: true };
}

export function shouldRequireCitations({
  classification = null,
  executionPlan = null,
  source = null,
} = {}) {
  const intent = classification?.intent;
  // Structured analytics/rankings do not require PDF citations.
  if (
    intent === INTENTS.TOP_METRIC
    || intent === INTENTS.BOTTOM_METRIC
    || intent === INTENTS.COMPARE_COMPANIES
    || intent === INTENTS.LIST_ALL_COMPANIES
    || intent === INTENTS.COUNT_COMPANIES
    || intent === INTENTS.SECTOR_SUMMARY
    || intent === INTENTS.METRIC_LOOKUP
    || intent === INTENTS.CHART_REQUEST
    || intent === INTENTS.TREND_ANALYSIS
    || intent === INTENTS.INFORMATIONAL
    || intent === INTENTS.HOW_TO
  ) {
    return false;
  }
  if (intent === INTENTS.REPORT_LOOKUP) return true;
  if (executionPlan?.needsPdf) return true;
  // Report engine only (not analytics+report hybrid) → require citations
  if (source === 'report' || source === 'rag') return true;
  if (
    executionPlan?.needsReport
    && !executionPlan?.needsSql
    && intent === INTENTS.COMPANY_SUMMARY
  ) {
    return true;
  }
  return false;
}

export function safeFailureMessage(envelope = {}, validation = null) {
  const intent = envelope.classification?.intent || null;
  const metric = envelope.classification?.metric || null;
  const companies = envelope.classification?.entities || [];
  const year = envelope.classification?.filters?.years?.[0] ?? null;

  // Prefer intent-specific SQL failure copy when structured
  if (
    intent === INTENTS.TOP_METRIC
    || intent === INTENTS.BOTTOM_METRIC
    || intent === INTENTS.COMPARE_COMPANIES
    || intent === INTENTS.METRIC_LOOKUP
  ) {
    const explained = explainSqlFailure({
      intent,
      error: validation?.reason || 'validation_failed',
      metric,
      companies,
      year,
    });
    if (explained) return explained;
  }

  return SAFE_FAILURE_MESSAGE;
}

// ── helpers ──────────────────────────────────────────────────────────────

function buildResult({
  issues = [],
  checks = {},
  shouldReplan = false,
  reason = null,
} = {}) {
  const errors = issues.filter((i) => i.severity === 'error').map((i) => i.code);
  const warnings = issues.filter((i) => i.severity === 'warning').map((i) => i.code);
  let verdict = VERDICTS.PASS;
  if (errors.length) verdict = VERDICTS.ERROR;
  else if (warnings.length) verdict = VERDICTS.WARNING;

  return {
    verdict,
    ok: verdict !== VERDICTS.ERROR,
    issues,
    errors,
    warnings,
    shouldReplan: Boolean(shouldReplan) && verdict === VERDICTS.ERROR,
    reason: reason || (errors[0] || null),
    checks,
  };
}

function issue(severity, code, message) {
  return { severity, code: String(code), message: String(message || code) };
}

function codeToMessage(code) {
  return String(code || 'validation_issue').replace(/_/g, ' ');
}

function validateCompareCompleteness({ classification, data, text }) {
  const issues = [];
  const intent = classification?.intent;
  if (intent !== INTENTS.COMPARE_COMPANIES) {
    return { ok: true, issues, skipped: true };
  }
  const want = (classification?.entities || []).filter(Boolean);
  if (want.length < 2) return { ok: true, issues, skipped: true };

  const rows = Array.isArray(data?.rows) ? data.rows : [];
  if (!rows.length) {
    if (!/no .*found|not available|could not|couldn't/i.test(String(text || ''))) {
      issues.push(issue(
        'warning',
        'incomplete_compare',
        'Compare requested but no structured rows were returned.',
      ));
    }
    return { ok: true, issues };
  }

  const returnedIds = new Set(rows.map((r) => issuerIdFromName(r.company)).filter(Boolean));
  const missing = want.filter((name) => {
    const id = issuerIdFromName(name);
    return id && !returnedIds.has(id);
  });

  if (missing.length === want.length) {
    issues.push(issue(
      'error',
      'incomplete_compare',
      'None of the requested compare companies appear in returned rows.',
    ));
  } else if (missing.length) {
    issues.push(issue(
      'warning',
      'incomplete_compare_partial',
      `Missing from compare rows: ${missing.slice(0, 3).join(', ')}.`,
    ));
  }

  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

function pickPrimaryData(engineResults = []) {
  for (const r of engineResults || []) {
    if (r?.data?.rows || r?.data?.metric || r?.data?.year != null) return r.data;
  }
  for (const r of engineResults || []) {
    if (r?.dataset) return r.dataset;
  }
  return null;
}

function pickDataText(engineResults = []) {
  for (const r of engineResults || []) {
    if (r?.ok && r?.dataText) return r.dataText;
  }
  return null;
}

function inferSource({ executionPlan, engineResults, classification }) {
  if (executionPlan?.needsSql) return 'sql';
  if (executionPlan?.needsReport || executionPlan?.needsPdf) return 'report';
  if (executionPlan?.needsKnowledge) return 'knowledge';
  const engines = (engineResults || []).map((r) => r?.engine).filter(Boolean);
  if (engines.includes('analytics')) return 'sql';
  if (engines.includes('report')) return 'report';
  if (classification?.intent === INTENTS.INFORMATIONAL) return 'knowledge';
  return 'composer';
}

function mapSourceForCore(source) {
  if (source === 'report') return 'rag';
  if (source === 'knowledge' || source === 'guidance' || source === 'compliance') return 'rag';
  if (source === 'composer') return 'sql';
  return source || 'sql';
}

function resolveChartPayload(visualization, text) {
  if (visualization?.chartSpec) return visualization.chartSpec;
  if (visualization?.spec) return visualization.spec;
  if (visualization?.config) return visualization.config;
  if (visualization?.chartBlock) {
    const parsed = parseChartBlock(visualization.chartBlock);
    if (parsed) return parsed;
  }
  const fromText = parseChartBlock(text);
  return fromText;
}

function parseChartBlock(text) {
  const m = String(text || '').match(/```json-chart\s*([\s\S]*?)\s*```/i);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function normalizeSpecFromConfig(chart) {
  if (!chart || typeof chart !== 'object') return chart;
  // ChartSpec shape
  if (Array.isArray(chart.series)) return chart;
  // Renderer config shape → ChartSpec-like
  const datasets = Array.isArray(chart.datasets) ? chart.datasets : [];
  return {
    chartType: chart.chartType || chart.type || 'bar',
    intent: chart.intent || null,
    labels: Array.isArray(chart.labels) ? chart.labels : [],
    series: datasets.map((d, i) => ({
      id: d.label || `series_${i}`,
      label: d.label || `Series ${i + 1}`,
      values: Array.isArray(d.data) ? d.data.map((v) => (v && typeof v === 'object' ? v.y : v)) : [],
      unit: d.unit || chart.unit || null,
    })),
    meta: {
      title: chart.title,
      unit: chart.unit,
      reportingYear: chart.reportingYear,
    },
  };
}

function extractChartLabels(chart) {
  if (Array.isArray(chart?.labels)) return chart.labels.map(String);
  return [];
}

function extractChartPrimaryValues(chart) {
  if (Array.isArray(chart?.series?.[0]?.values)) {
    return chart.series[0].values.map((v) => (v == null ? null : Number(v)));
  }
  if (Array.isArray(chart?.datasets?.[0]?.data)) {
    return chart.datasets[0].data.map((v) => {
      if (v == null) return null;
      if (typeof v === 'object' && v.y != null) return Number(v.y);
      return Number(v);
    });
  }
  return [];
}

function approxEqual(a, b, rel = 0.01) {
  if (a === b) return true;
  const diff = Math.abs(a - b);
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return diff / scale <= rel || diff < 1e-6;
}

function stripChartBlocks(text) {
  return String(text || '')
    .replace(/```json-chart\s*[\s\S]*?\s*```/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripBrokenCitationPlaceholders(text) {
  return String(text || '')
    .replace(/\[source\]\(\s*\)/gi, '')
    .replace(/p\.\s*\d+\s*\[source\]\([^)]*\)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function mergeCitationVerification(validation, citationVerification) {
  if (!citationVerification || typeof citationVerification !== 'object') return validation;
  const issues = [...(validation.issues || [])];
  const checks = {
    ...validation.checks,
    citationVerification: {
      pass: citationVerification.pass,
      summary: citationVerification.summary || null,
    },
  };

  if (citationVerification.pass === false) {
    const failed = citationVerification.summary?.responseFailed || 0;
    if (failed > 0) {
      issues.push(issue(
        'warning',
        'citation_verification_failed',
        `${failed} citation(s) failed PDF verification.`,
      ));
    }
  }

  return buildResult({
    issues,
    checks,
    shouldReplan: validation.shouldReplan,
    reason: validation.reason,
  });
}
