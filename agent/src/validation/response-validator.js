/**
 * Phase 7/10 — Response validation after SQL / RAG / LLM.
 *
 * Pipeline: Execution → Response → Response Validation → Return
 *
 * Checks:
 * ✓ Requested metric == Returned metric
 * ✓ Requested companies == Returned companies
 * ✓ Requested year == Returned year
 * ✓ Selected source == Correct source
 *
 * Example: User asks "Carbon emissions" but response is "Carbon reduction initiatives"
 * → Reject (shouldReplan) → replan / grounded failure
 */

import { INTENTS } from '../intent/classify-intent.js';
import { issuerIdFromName } from '../sql-agent/company-identity.js';
import { RANKABLE_METRICS } from '../sql-sanitize.js';

const KNOWN_METRICS = new Set([...RANKABLE_METRICS, 'total_emissions', 'male_board_count', 'male_board_share']);

/** Narrative / initiative language that must not answer a numeric emissions metric ask. */
const INITIATIVE_PATTERNS = [
  /carbon\s+reduction\s+initiatives?/i,
  /emission\s+reduction\s+(?:initiatives?|programs?|projects?|strategies)/i,
  /how\s+(?:we|they|the\s+company)\s+(?:reduce|control|mitigate)/i,
  /decarbonisation\s+(?:roadmap|strategy|initiatives?)/i,
  /net[\s-]?zero\s+(?:commitment|pledge|target|roadmap)/i,
];

const METRIC_LABEL_PATTERNS = {
  scope1_emissions: [/scope\s*1/i, /direct\s+ghg/i],
  scope2_emissions: [/scope\s*2/i, /indirect\s+ghg/i],
  scope3_emissions: [/scope\s*3/i],
  total_emissions: [/total\s+(?:ghg\s+)?emissions?/i, /scope\s*1\s*\+?\s*2/i, /carbon\s+emissions?/i],
  renewable_energy_share: [/renewable/i],
  female_employee_share: [/female\s+employee/i, /women\s+in\s+(?:the\s+)?workforce/i],
  female_employee_count: [/female\s+employee/i],
  male_employee_count: [/male\s+employee/i],
  male_employee_share: [/male\s+employee/i],
  water_consumption: [/water\s+consum/i],
  waste_generated: [/waste/i],
  energy_consumption: [/energy\s+consum/i],
  emissions_intensity: [/emissions?\s+intensity/i, /carbon\s+intensity/i],
};

function countBulletNames(text) {
  const lines = String(text || '').split('\n');
  let n = 0;
  for (const line of lines) {
    if (/^\s*[-*•]\s+\S/.test(line)) n += 1;
    else if (/^\s*\d+\.\s+\S/.test(line)) n += 1;
  }
  return n;
}

function mentionsTotal(text) {
  return /\b\d{2,5}\b/.test(text) && /\b(companies|total|records)\b/i.test(text);
}

function mentionsExportOrPagination(text) {
  return /\/api\/companies|download|page\s+\*\*\d+|say \*\*next\*\*|csv/i.test(text);
}

function explainEmpty(text) {
  return /no .*found|not available|n\/a|couldn't retrieve|could not retrieve|no matching|no brsr/i.test(text);
}

/**
 * Detect when a numeric metric ask was answered with initiatives / narrative instead.
 */
export function isMetricAnsweredByNarrative(text, metric = null) {
  const body = String(text || '');
  if (!body.trim()) return false;
  const looksLikeInitiative = INITIATIVE_PATTERNS.some((re) => re.test(body));
  if (!looksLikeInitiative) return false;

  // If body also has clear numeric emissions figures, allow mixed answers.
  const hasNumericMetric = /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/.test(body)
    || /\b\d+(?:\.\d+)?\s*(?:tco2|mtco2|tonnes?|tons?)\b/i.test(body);
  if (hasNumericMetric) return false;

  if (!metric) return true;
  return KNOWN_METRICS.has(metric)
    || /emission|carbon|ghg|scope/i.test(String(metric));
}

/**
 * Requested metric present in structured data and/or answer text.
 */
export function validateMetricAlignment({
  text = '',
  metric = null,
  data = null,
  source = 'sql',
} = {}) {
  const errors = [];
  const warnings = [];
  if (!metric) return { ok: true, errors, warnings };

  if (data?.metric && data.metric !== metric && data.metric !== 'total_emissions') {
    // Allow total_emissions proxy only when explicitly assumed.
    if (!data.assumedMetric) {
      errors.push(`metric_mismatch:requested_${metric}:returned_${data.metric}`);
    } else {
      warnings.push(`assumed_metric:${data.metric}`);
    }
  }

  if (source === 'sql' && data?.rows?.length && data.metric && data.metric !== metric && !data.assumedMetric) {
    errors.push(`sql_metric_mismatch:${data.metric}`);
  }

  if (isMetricAnsweredByNarrative(text, metric)) {
    errors.push('metric_answered_by_narrative_initiatives');
  }

  // Soft check: answer mentions something related to the metric label.
  const patterns = METRIC_LABEL_PATTERNS[metric];
  if (patterns && text && source !== 'sql') {
    const hit = patterns.some((re) => re.test(text));
    if (!hit && !explainEmpty(text)) {
      warnings.push(`metric_label_not_mentioned:${metric}`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Requested companies appear in data / answer.
 */
export function validateCompanyAlignment({
  text = '',
  companies = [],
  data = null,
} = {}) {
  const errors = [];
  const warnings = [];
  const want = (Array.isArray(companies) ? companies : []).filter(Boolean);
  if (!want.length) return { ok: true, errors, warnings };

  const rows = Array.isArray(data?.rows) ? data.rows : [];
  if (rows.length) {
    const returnedIds = new Set(
      rows.map((r) => issuerIdFromName(r.company)).filter(Boolean),
    );
    for (const name of want) {
      const id = issuerIdFromName(name);
      if (id && returnedIds.size && !returnedIds.has(id)) {
        // Compare/rank may return other companies — only hard-fail lookups with single company.
        if (want.length === 1) {
          errors.push(`company_mismatch:requested_${name}`);
        } else {
          warnings.push(`company_not_in_rows:${name}`);
        }
      }
    }
  } else if (text && want.length <= 3) {
    const lower = text.toLowerCase();
    for (const name of want) {
      const token = String(name).toLowerCase().slice(0, 8);
      if (token && !lower.includes(token) && !explainEmpty(text)) {
        warnings.push(`company_not_mentioned:${name}`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Requested year matches returned year.
 */
export function validateYearAlignment({
  expectedYear = null,
  data = null,
  text = '',
} = {}) {
  const errors = [];
  const warnings = [];
  if (expectedYear == null) return { ok: true, errors, warnings };

  const year = Number(expectedYear);
  if (!Number.isFinite(year)) return { ok: true, errors, warnings };

  if (data?.year != null && Number(data.year) !== year && !data?.assumedYear) {
    errors.push(`year_mismatch:expected_${year}:got_${data.year}`);
  }

  const rows = Array.isArray(data?.rows) ? data.rows : [];
  if (rows.length) {
    const mismatches = rows.filter((r) => r.year != null && Number(r.year) !== year);
    if (mismatches.length === rows.length && !data?.assumedYear) {
      errors.push(`year_mismatch:expected_${year}`);
    } else if (mismatches.length && !data?.assumedYear) {
      warnings.push(`partial_year_mismatch:${mismatches.length}`);
    }
  }

  if (text && !rows.length && data?.year == null) {
    const mentioned = text.match(/\b(20\d{2})\b/);
    if (mentioned && Number(mentioned[1]) !== year && !data?.assumedYear) {
      warnings.push(`text_year_differs:${mentioned[1]}`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Source must match the execution path (SQL for structured metrics, etc.).
 */
export function validateSourceAlignment({
  source = 'sql',
  intent = null,
  metric = null,
  text = '',
} = {}) {
  const errors = [];
  const warnings = [];
  const structured = intent === INTENTS.TOP_METRIC
    || intent === INTENTS.BOTTOM_METRIC
    || intent === INTENTS.COMPARE_COMPANIES
    || intent === INTENTS.COUNT_COMPANIES
    || intent === INTENTS.LIST_ALL_COMPANIES;

  if (structured && (source === 'rag' || source === 'narrative') && !explainEmpty(text)) {
    errors.push(`wrong_source_for_structured:${source}`);
  }

  if (
    (intent === INTENTS.METRIC_LOOKUP || intent === INTENTS.REPORT_LOOKUP)
    && metric
    && KNOWN_METRICS.has(metric)
    && (source === 'rag' || source === 'llm')
    && isMetricAnsweredByNarrative(text, metric)
  ) {
    errors.push('wrong_source_metric_narrative');
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Validate ranking row payload from SQL agent.
 */
export function validateSqlRankingData(data, {
  intent = null,
  expectedYear = null,
  metric = null,
} = {}) {
  const warnings = [];
  const errors = [];
  const rows = Array.isArray(data?.rows) ? data.rows : null;

  if (metric && !KNOWN_METRICS.has(metric) && metric !== data?.metric) {
    warnings.push(`metric_unrecognized:${metric}`);
  }

  if (!rows) {
    return { ok: true, errors, warnings };
  }

  if (!rows.length) {
    errors.push('empty_dataset');
    return { ok: false, errors, warnings };
  }

  const seen = new Set();
  for (const row of rows) {
    const id = issuerIdFromName(row.company);
    if (!id) continue;
    if (seen.has(id)) errors.push(`duplicate_company:${row.company}`);
    seen.add(id);
  }

  if (expectedYear != null) {
    const mismatches = rows.filter((r) => r.year != null && Number(r.year) !== Number(expectedYear));
    // Allow assumed/fallback years when data.assumedYear is set or only some rows differ.
    if (mismatches.length === rows.length && !data?.assumedYear) {
      errors.push(`year_mismatch:expected_${expectedYear}`);
    } else if (mismatches.length && !data?.assumedYear) {
      warnings.push(`partial_year_mismatch:${mismatches.length}`);
    }
  }

  // Sort check for rankings
  if (intent === INTENTS.TOP_METRIC || intent === INTENTS.BOTTOM_METRIC || data?.order) {
    const values = rows.map((r) => (r.metric_value != null ? Number(r.metric_value) : null));
    if (values.every((v) => v != null && !Number.isNaN(v))) {
      const desc = intent === INTENTS.BOTTOM_METRIC || String(data?.order).toUpperCase() === 'ASC'
        ? false
        : true;
      let sorted = true;
      for (let i = 1; i < values.length; i += 1) {
        if (desc ? values[i] > values[i - 1] : values[i] < values[i - 1]) {
          sorted = false;
          break;
        }
      }
      if (!sorted) errors.push('ranking_not_sorted');
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Validate RAG / narrative retrieval evidence.
 */
export function validateRagEvidence({
  chunks = [],
  company = null,
  minChunks = 1,
} = {}) {
  const warnings = [];
  const errors = [];
  const list = Array.isArray(chunks) ? chunks : [];

  if (list.length < minChunks) {
    errors.push('insufficient_rag_evidence');
  }

  if (company) {
    const want = issuerIdFromName(company);
    const foreign = list.filter((c) => {
      const name = c.company || c.company_name || '';
      if (!name) return false;
      const id = issuerIdFromName(name);
      return id && want && id !== want
        && !String(name).toLowerCase().includes(String(company).toLowerCase().slice(0, 8));
    });
    if (foreign.length && foreign.length === list.length) {
      errors.push('rag_chunks_wrong_company');
    } else if (foreign.length) {
      warnings.push(`rag_mixed_companies:${foreign.length}`);
    }
  }

  return { ok: errors.length === 0, errors, warnings, chunkCount: list.length };
}

/**
 * Heuristic LLM final-answer checks when structured evidence is absent.
 * Does not attempt full fact-checking — blocks obvious invention patterns.
 */
export function validateLlmAnswer({
  text,
  intent = null,
  hasToolEvidence = false,
  classification = null,
} = {}) {
  const warnings = [];
  const errors = [];
  const body = String(text || '');

  if (!body.trim()) {
    return { ok: false, errors: ['empty_response'], warnings };
  }

  const structured = intent === INTENTS.TOP_METRIC
    || intent === INTENTS.BOTTOM_METRIC
    || intent === INTENTS.COMPARE_COMPANIES
    || intent === INTENTS.COUNT_COMPANIES
    || intent === INTENTS.LIST_ALL_COMPANIES
    || classification?.canonicalIntent === 'RANK'
    || classification?.canonicalIntent === 'COMPARE';

  if (structured && !hasToolEvidence) {
    // Numbered ranking / table-looking fabrication without tool grounding
    const looksLikeRanking = /(?:^|\n)\s*\d+\.\s+\*\*[^*]+\*\*.*\d/.test(body)
      || /\|\s*company\s*\|/i.test(body);
    if (looksLikeRanking) {
      errors.push('llm_possible_fabricated_ranking');
    }
    const manyExactNumbers = (body.match(/\b\d{3,}(?:\.\d+)?\b/g) || []).length;
    if (manyExactNumbers >= 5 && /tco2|emission|scope\s*[123]/i.test(body)) {
      warnings.push('llm_ungrounded_metric_numbers');
    }
  }

  if (/as an ai language model|i made up|invented these figures/i.test(body)) {
    errors.push('llm_admits_fabrication');
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * @returns {{ ok: boolean, reason?: string, errors?: string[], warnings?: string[], repairedText?: string, shouldReplan?: boolean }}
 */
export function validateResponse({
  text,
  intent,
  wantsAll = false,
  data = null,
  classification = null,
  ragChunks = null,
  company = null,
  hasToolEvidence = null,
  source = 'sql',
} = {}) {
  const body = String(text || '').trim();
  const warnings = [];
  const errors = [];

  if (!body) {
    return {
      ok: false,
      reason: 'empty_response',
      errors: ['empty_response'],
      warnings,
      shouldReplan: true,
    };
  }

  const metric = classification?.metric || data?.metric || null;
  const companies = classification?.entities?.length
    ? classification.entities
    : (company ? [company] : []);
  const expectedYear = classification?.filters?.years?.[0] ?? data?.year ?? null;

  // Phase 7 — metric / company / year / source alignment
  const metricCheck = validateMetricAlignment({ text: body, metric, data, source });
  const companyCheck = validateCompanyAlignment({ text: body, companies, data });
  const yearCheck = validateYearAlignment({ expectedYear, data, text: body });
  const sourceCheck = validateSourceAlignment({ source, intent, metric, text: body });
  warnings.push(...metricCheck.warnings, ...companyCheck.warnings, ...yearCheck.warnings, ...sourceCheck.warnings);
  errors.push(...metricCheck.errors, ...companyCheck.errors, ...yearCheck.errors, ...sourceCheck.errors);

  const allIntent = intent === INTENTS.LIST_ALL_COMPANIES
    || wantsAll
    || classification?.wantsAll;

  if (allIntent) {
    const named = countBulletNames(body);
    const total = data?.total ?? null;

    if (named > 0 && named <= 8 && !mentionsExportOrPagination(body)) {
      if (total && total > named) {
        return {
          ok: false,
          reason: 'sample_instead_of_all',
          errors: ['sample_instead_of_all'],
          warnings,
          repairedText: null,
          shouldReplan: false,
        };
      }
      if (!total && named <= 8 && !mentionsTotal(body)) {
        return {
          ok: false,
          reason: 'sample_instead_of_all',
          errors: ['sample_instead_of_all'],
          warnings,
          shouldReplan: false,
        };
      }
    }

    if (total != null && named > 0 && named < total && !mentionsExportOrPagination(body) && !/page\s+\*\*\d+/i.test(body)) {
      return {
        ok: false,
        reason: 'incomplete_list_without_pagination',
        errors: ['incomplete_list_without_pagination'],
        warnings,
        shouldReplan: false,
      };
    }
  }

  if (intent === INTENTS.COUNT_COMPANIES && !/\b\d+\b/.test(body)) {
    return {
      ok: false,
      reason: 'count_missing_number',
      errors: ['count_missing_number'],
      warnings,
      shouldReplan: false,
    };
  }

  // SQL ranking / compare payload checks
  if (
    source === 'sql'
    && data?.rows
    && (intent === INTENTS.TOP_METRIC || intent === INTENTS.BOTTOM_METRIC || intent === INTENTS.COMPARE_COMPANIES || intent === INTENTS.FOLLOW_UP)
  ) {
    const sqlCheck = validateSqlRankingData(data, {
      intent,
      expectedYear: classification?.filters?.years?.[0] ?? null,
      metric: classification?.metric || data?.metric || null,
    });
    warnings.push(...sqlCheck.warnings);
    if (!sqlCheck.ok) {
      if (sqlCheck.errors.includes('empty_dataset')) {
        if (!explainEmpty(body)) {
          return {
            ok: false,
            reason: 'ranking_empty_unexplained',
            errors: sqlCheck.errors,
            warnings,
            shouldReplan: false,
          };
        }
      } else {
        errors.push(...sqlCheck.errors);
      }
    }
  }

  if ((intent === INTENTS.TOP_METRIC || intent === INTENTS.BOTTOM_METRIC) && data?.rows && !data.rows.length) {
    if (!explainEmpty(body)) {
      return {
        ok: false,
        reason: 'ranking_empty_unexplained',
        errors: ['ranking_empty_unexplained'],
        warnings,
        shouldReplan: false,
      };
    }
  }

  // RAG evidence
  if (source === 'rag' && ragChunks) {
    const ragCheck = validateRagEvidence({
      chunks: ragChunks,
      company: company || classification?.entities?.[0] || null,
      minChunks: 1,
    });
    warnings.push(...ragCheck.warnings);
    if (!ragCheck.ok && !explainEmpty(body)) {
      return {
        ok: false,
        reason: ragCheck.errors[0] || 'rag_validation_failed',
        errors: ragCheck.errors,
        warnings,
        shouldReplan: true,
      };
    }
  }

  // LLM synthesis guards
  if (source === 'llm') {
    const llmCheck = validateLlmAnswer({
      text: body,
      intent,
      hasToolEvidence: Boolean(hasToolEvidence),
      classification,
    });
    warnings.push(...llmCheck.warnings);
    if (!llmCheck.ok) {
      return {
        ok: false,
        reason: llmCheck.errors[0] || 'llm_validation_failed',
        errors: llmCheck.errors,
        warnings,
        shouldReplan: true,
      };
    }
  }

  if (errors.length) {
    const shouldReplan = errors.some((e) => /metric_answered_by_narrative|wrong_source|metric_mismatch|company_mismatch/i.test(e));
    return {
      ok: false,
      reason: errors[0],
      errors,
      warnings,
      shouldReplan,
    };
  }

  return { ok: true, errors: [], warnings, shouldReplan: false };
}

/**
 * If deterministic SQL agent data exists, prefer regenerating list text over LLM sample.
 */
export function repairListResponse({ validation, sqlResult }) {
  if (validation?.ok) return sqlResult?.text || null;
  if (sqlResult?.ok && sqlResult.text) return sqlResult.text;
  return null;
}

/**
 * Replace a fabricated LLM ranking/compare with a grounded failure explanation.
 * Also handles Phase 7 metric-answered-by-narrative rejects.
 */
export function repairFabricatedLlmAnswer({ validation, intent, classification = null }) {
  if (validation?.ok) return null;
  const errs = validation?.errors || [];
  const narrativeMismatch = errs.some((e) => /metric_answered_by_narrative|wrong_source_metric/i.test(e));
  if (narrativeMismatch) {
    const metric = classification?.metric || 'the requested metric';
    const label = String(metric).replace(/_/g, ' ');
    return [
      `I could not verify a numeric BRSR value for **${label}** in the structured database answer path.`,
      '',
      'I will not substitute carbon-reduction initiatives or narrative programs when you asked for emissions (or another metric) figures.',
      'Please name the company and year if you want a company-scoped document search next.',
    ].join('\n');
  }
  if (!errs.some((e) => /fabricat|ungrounded/i.test(e))) return null;
  const metric = classification?.metric || 'the requested metric';
  if (intent === INTENTS.TOP_METRIC || intent === INTENTS.BOTTOM_METRIC || classification?.canonicalIntent === 'RANK') {
    return [
      `I couldn't retrieve verified BRSR data for **${String(metric).replace(/_/g, ' ')}**, so I can't produce a reliable ranking.`,
      '',
      'I won\'t invent company names or ESG values without database evidence.',
    ].join('\n');
  }
  return [
    'I couldn\'t retrieve verified BRSR data for this structured question, so I can\'t answer it reliably.',
    '',
    'I won\'t invent ESG metrics, rankings, or company names without database evidence.',
  ].join('\n');
}
