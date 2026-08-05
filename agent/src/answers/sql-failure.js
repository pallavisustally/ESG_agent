/**
 * Phase 11 — SQL / structured-query failure explanations.
 *
 * When verified BRSR SQL cannot answer, explain the failure.
 * Never hand these cases to the LLM to invent rankings or metric values.
 */

import { INTENTS } from '../intent/classify-intent.js';

/** Intents whose facts must come from SQL — LLM must not fabricate substitutes. */
export const STRUCTURED_SQL_INTENTS = new Set([
  INTENTS.LIST_ALL_COMPANIES,
  INTENTS.COUNT_COMPANIES,
  INTENTS.FILTER_BY_SECTOR,
  INTENTS.TOP_METRIC,
  INTENTS.BOTTOM_METRIC,
  INTENTS.COMPARE_COMPANIES,
  INTENTS.SECTOR_SUMMARY,
  INTENTS.PAGINATE_CONTINUE,
]);

/**
 * Soft LLM handoff is allowed only for company-resolved lookups (tools still ground facts).
 */
export function isAllowedLlmHandoff(intent, sqlResult = null) {
  if (!sqlResult || sqlResult.error !== 'handoff_llm') return false;
  const lookup = intent === INTENTS.METRIC_LOOKUP
    || intent === INTENTS.REPORT_LOOKUP
    || intent === INTENTS.COMPANY_SUMMARY;
  return lookup && Boolean(sqlResult.data?.resolvedCompany);
}

export function shouldBlockLlmFallback(intent, sqlResult = null) {
  if (!STRUCTURED_SQL_INTENTS.has(intent)) return false;
  if (isAllowedLlmHandoff(intent, sqlResult)) return false;
  return true;
}

function metricLabel(metric) {
  if (!metric) return 'the requested ESG metric';
  if (metric === 'total_emissions') return 'total GHG emissions (Scope 1+2+3)';
  return String(metric).replace(/_/g, ' ');
}

/**
 * Build a clear, non-fabricated failure explanation.
 */
export function explainSqlFailure({
  intent,
  error = null,
  metric = null,
  companies = [],
  year = null,
  sector = null,
} = {}) {
  const err = String(error || '');
  const dbFailure = /ENOTFOUND|ECONNREFUSED|timeout|database|postgres|SQLITE|could not be queried/i.test(err);
  const scope = [
    metric ? metricLabel(metric) : null,
    year ? `for ${year}` : null,
    sector ? `in ${sector}` : null,
    companies?.length ? `for ${companies.slice(0, 3).join(' / ')}` : null,
  ].filter(Boolean).join(' ');

  if (dbFailure) {
    return [
      'I couldn\'t query the verified BRSR database right now, so I can\'t return reliable structured results.',
      '',
      'Please retry in a moment — I won\'t invent rankings or ESG values without database evidence.',
      err ? `\n_(${err})_` : '',
    ].filter(Boolean).join('\n');
  }

  if (intent === INTENTS.TOP_METRIC || intent === INTENTS.BOTTOM_METRIC) {
    return [
      `I couldn't retrieve verified emissions/ESG data${scope ? ` (${scope})` : ''} for this query, so I can't produce a reliable ranking.`,
      '',
      'Rankings are only shown from the structured BRSR `reports` table — I never invent company lists or metric values.',
      err && err !== 'handoff_llm' ? `\n_(${err})_` : '',
    ].filter(Boolean).join('\n');
  }

  if (intent === INTENTS.COMPARE_COMPANIES) {
    return [
      `I couldn't retrieve verified BRSR metrics${scope ? ` (${scope})` : ''} for a side-by-side comparison.`,
      '',
      'Please check the company names and metric (for example Scope 1 emissions). I won\'t fabricate comparison values.',
      err && err !== 'handoff_llm' ? `\n_(${err})_` : '',
    ].filter(Boolean).join('\n');
  }

  if (intent === INTENTS.COUNT_COMPANIES || intent === INTENTS.LIST_ALL_COMPANIES || intent === INTENTS.PAGINATE_CONTINUE) {
    return [
      'I couldn\'t retrieve the verified company list from the BRSR database for this request.',
      '',
      'I won\'t invent company names. Please retry, or try `/api/companies?format=csv` for a full export when the database is available.',
      err && err !== 'handoff_llm' ? `\n_(${err})_` : '',
    ].filter(Boolean).join('\n');
  }

  if (intent === INTENTS.FILTER_BY_SECTOR || intent === INTENTS.SECTOR_SUMMARY) {
    return [
      `I couldn't retrieve verified BRSR records${sector ? ` for sector **${sector}**` : ''}.`,
      '',
      'I won\'t invent sector membership or aggregate ESG statistics without database evidence.',
      err && err !== 'handoff_llm' ? `\n_(${err})_` : '',
    ].filter(Boolean).join('\n');
  }

  return [
    'I couldn\'t retrieve verified BRSR data for this structured query, so I can\'t answer it reliably.',
    '',
    'I won\'t invent ESG metrics, rankings, or company names without database evidence.',
    err && err !== 'handoff_llm' ? `\n_(${err})_` : '',
  ].filter(Boolean).join('\n');
}

/** Extra system rules when the LLM tool loop is still allowed. */
export function noFabricationSystemAddon() {
  return [
    '',
    '### Phase 11 — no fabrication (authoritative)',
    '- Never invent company names, ESG metric numbers, rankings, or comparisons.',
    '- Only state values that appear in tool results or retrieved BRSR snippets.',
    '- If tools return empty/error results for a ranking, count, or compare: explain that verified data was unavailable. Do not guess.',
    '- Prefer saying "I couldn\'t retrieve verified data" over producing a plausible-looking table.',
  ].join('\n');
}
