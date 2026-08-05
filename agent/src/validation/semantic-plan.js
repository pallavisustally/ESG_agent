/**
 * Semantic planner validation — quantitative vs qualitative answer type.
 *
 * Before SQL / Narrative / PDF selection, decide whether the user wants a
 * measurable value or a qualitative disclosure. Quantitative asks must never
 * take Narrative as the first execution path.
 *
 * Does not change the system prompt — planner validation only.
 */

import { INTENTS } from '../intent/classify-intent.js';
import { isGuidanceQuestion, isInformationalQuestion } from '../intent/classify-intent.js';
import { METRIC_RESOLUTION } from '../intent/metric-resolution.js';
import { TOOLS } from '../planner/plan-query.js';
import { RANKABLE_METRICS } from '../sql-sanitize.js';

const PLAN_METRICS = new Set([
  ...RANKABLE_METRICS,
  'total_emissions',
  'male_board_count',
  'male_board_share',
]);

export const ANSWER_TYPES = Object.freeze({
  QUANTITATIVE: 'QUANTITATIVE',
  QUALITATIVE: 'QUALITATIVE',
  INFORMATIONAL: 'INFORMATIONAL',
  UNKNOWN: 'UNKNOWN',
});

/** Measurable / numeric asks → SQL first (then derived → document fallback). */
const QUANTITATIVE_PATTERNS = [
  /\bemissions?\b/i,
  /\bcarbon\b/i,
  /\bghg\b/i,
  /\bscope\s*[123]\b/i,
  /\bemployee\s+counts?\b/i,
  /\bworkforce\b/i,
  /\brevenue\b/i,
  /\bwater\s+consumption\b/i,
  /\bwaste\s+generated\b/i,
  /\brenewable\s+energy\b/i,
  /\bintensity\b/i,
  /\bpercent(?:age)?\b/i,
  /\bshare\b/i,
  /\bamount\b/i,
  /\btotal\b/i,
  /\baverage\b/i,
  /\bmaximum\b|\bminimum\b/i,
  /\bhighest\b|\blowest\b/i,
  /\bhow\s+many\b/i,
  /\bhow\s+much\b/i,
  /\b(ltifr|tco2|mtco2)\b/i,
];

/** Qualitative / narrative asks → Narrative → PDF. */
const QUALITATIVE_PATTERNS = [
  /\bstrateg(?:y|ies)\b/i,
  /\binitiatives?\b/i,
  /\bprojects?\b/i,
  /\broadmaps?\b/i,
  /\bpolic(?:y|ies)\b/i,
  /\bgovernance\b/i,
  /\bpractices?\b/i,
  /\bcommitments?\b/i,
  /\bwhy\b/i,
  /\bexplain\b/i,
  /\bhow\s+(?:to|can|do|should|could)\b/i,
  /\bdescribe\b/i,
  /\bnarrative\b/i,
  /\bdisclos(?:e|ure)\b/i,
];

/** Tools / strategies that are narrative-first (forbidden for quantitative value asks). */
export const NARRATIVE_FIRST_TOOLS = new Set([TOOLS.RAG, TOOLS.HYBRID]);
export const NARRATIVE_FIRST_STRATEGIES = new Set([
  'guidance_templates',
  'rag_with_schema_context',
  'brsr_narrative_summary',
  'follow_up_from_memory', // hybrid narrative follow-up — wrong for measurable metrics
]);

function hasExecutableMetric(classification = null, plan = null) {
  const resolution = classification?.metricResolution
    || classification?.filters?.metricResolution
    || plan?.filters?.metricResolution
    || null;
  const metric = plan?.metric || classification?.metric || classification?.filters?.metric || null;
  if (resolution === METRIC_RESOLUTION.FOUND || resolution === METRIC_RESOLUTION.DERIVED) {
    return Boolean(metric);
  }
  if (metric && PLAN_METRICS.has(metric)) return true;
  return false;
}

/**
 * Detect whether the user is asking for a measurable value vs qualitative info.
 * Current message dominates; schema metric presence forces QUANTITATIVE.
 *
 * @returns {{ answerType: string, confidence: number, reasons: string[] }}
 */
export function detectAnswerType(userMessage = '', {
  classification = null,
  plan = null,
} = {}) {
  const text = String(userMessage || '');
  const reasons = [];
  let quantitativeHits = 0;
  let qualitativeHits = 0;

  for (const re of QUANTITATIVE_PATTERNS) {
    if (re.test(text)) {
      quantitativeHits += 1;
      reasons.push(`quant:${re.source.slice(0, 24)}`);
    }
  }
  for (const re of QUALITATIVE_PATTERNS) {
    if (re.test(text)) {
      qualitativeHits += 1;
      reasons.push(`qual:${re.source.slice(0, 24)}`);
    }
  }

  // Intent-first: informational / how-to never count as quantitative SQL asks.
  const intentEarly = classification?.intent || plan?.intent;
  if (
    intentEarly === INTENTS.INFORMATIONAL
    || intentEarly === INTENTS.HOW_TO
    || classification?.filters?.informational
    || classification?.filters?.guidance
    || isInformationalQuestion(text, classification?.entities || plan?.entities || [])
    || isGuidanceQuestion(text)
  ) {
    const type = (intentEarly === INTENTS.HOW_TO || isGuidanceQuestion(text) || classification?.filters?.guidance)
      ? ANSWER_TYPES.QUALITATIVE
      : ANSWER_TYPES.INFORMATIONAL;
    return {
      answerType: type,
      confidence: 0.96,
      reasons: [...reasons, `intent_first:${intentEarly || type}`],
    };
  }

  // How-to / control / why explanations are qualitative even when they mention Scope/emissions.
  const guidanceOrWhy = /\b(why|how\s+come|explain\s+why)\b/i.test(text)
    || /\bhow\s+(to|can|should|could)\b/i.test(text)
    || /\b(best\s+practices?|ways?\s+to)\b/i.test(text);
  const valueAsk = /\bhow\s+many\b|\bhow\s+much\b|\bwhat\s+(is|are|was|were)\s+the\b|\bhighest\b|\blowest\b/i.test(text);
  if (guidanceOrWhy && !valueAsk) {
    return {
      answerType: ANSWER_TYPES.QUALITATIVE,
      confidence: 0.92,
      reasons: [...reasons, 'how_to_or_why'],
    };
  }

  const resolution = classification?.metricResolution
    || classification?.filters?.metricResolution
    || plan?.filters?.metricResolution
    || null;

  // Schema / resolved metric from the *current* message → quantitative value ask.
  // Do not treat a FOLLOW_UP that only reused prior metric (NONE) as quantitative
  // unless the user message itself looks quantitative.
  if (hasExecutableMetric(classification, plan)) {
    reasons.push('executable_metric');
    if (
      resolution === METRIC_RESOLUTION.NONE
      && !quantitativeHits
      && (classification?.intent === INTENTS.FOLLOW_UP || plan?.intent === INTENTS.FOLLOW_UP)
    ) {
      return {
        answerType: ANSWER_TYPES.UNKNOWN,
        confidence: 0.5,
        reasons: [...reasons, 'follow_up_reused_metric_only'],
      };
    }
    return {
      answerType: ANSWER_TYPES.QUANTITATIVE,
      confidence: 0.97,
      reasons,
    };
  }

  // Ranking / count intents are quantitative even without an extracted metric token.
  const intent = classification?.intent || plan?.intent;
  if (
    intent === INTENTS.TOP_METRIC
    || intent === INTENTS.BOTTOM_METRIC
    || intent === INTENTS.COUNT_COMPANIES
    || intent === INTENTS.METRIC_LOOKUP
    || intent === INTENTS.COMPARE_COMPANIES
  ) {
    if (qualitativeHits && !quantitativeHits && intent === INTENTS.COMPARE_COMPANIES) {
      // "why is A higher than B" may still be COMPARE with hybridWhy
    } else if (intent !== INTENTS.COMPARE_COMPANIES || quantitativeHits || hasExecutableMetric(classification, plan)) {
      reasons.push(`intent:${intent}`);
      return {
        answerType: ANSWER_TYPES.QUANTITATIVE,
        confidence: 0.9,
        reasons,
      };
    }
  }

  if (intent === INTENTS.HOW_TO || intent === INTENTS.COMPANY_SUMMARY) {
    return {
      answerType: ANSWER_TYPES.QUALITATIVE,
      confidence: 0.9,
      reasons: [...reasons, `intent:${intent}`],
    };
  }
  if (intent === INTENTS.INFORMATIONAL || intent === INTENTS.GENERAL_ESG_QUESTION) {
    return {
      answerType: ANSWER_TYPES.INFORMATIONAL,
      confidence: 0.9,
      reasons: [...reasons, `intent:${intent}`],
    };
  }

  if (quantitativeHits && qualitativeHits) {
    // Company value asks win; bare definitions do not.
    if (
      /\bwhat\s+(is|are|was|were)\s+the\b/i.test(text)
      && (classification?.entities?.length || plan?.entities?.length)
      && quantitativeHits >= qualitativeHits
    ) {
      return { answerType: ANSWER_TYPES.QUANTITATIVE, confidence: 0.88, reasons };
    }
    if (/\b(initiatives?|strategy|roadmap|policies)\b/i.test(text) && qualitativeHits > quantitativeHits) {
      return { answerType: ANSWER_TYPES.QUALITATIVE, confidence: 0.86, reasons };
    }
  }

  if (quantitativeHits > qualitativeHits) {
    return { answerType: ANSWER_TYPES.QUANTITATIVE, confidence: 0.85, reasons };
  }
  if (qualitativeHits > quantitativeHits) {
    return { answerType: ANSWER_TYPES.QUALITATIVE, confidence: 0.85, reasons };
  }
  if (quantitativeHits) {
    return { answerType: ANSWER_TYPES.QUANTITATIVE, confidence: 0.7, reasons };
  }
  if (qualitativeHits) {
    return { answerType: ANSWER_TYPES.QUALITATIVE, confidence: 0.7, reasons };
  }
  return { answerType: ANSWER_TYPES.UNKNOWN, confidence: 0.4, reasons };
}

/**
 * True when plan starts with Narrative/RAG/hybrid-narrative instead of SQL.
 */
export function isNarrativeFirstPlan(plan = null) {
  if (!plan) return false;
  if (plan.strategy && NARRATIVE_FIRST_STRATEGIES.has(plan.strategy)) return true;
  if (plan.primaryTool === TOOLS.RAG) return true;
  if (plan.primaryTool === TOOLS.HYBRID && plan.useRag && plan.strategy !== 'hybrid_why_compare') {
    return true;
  }
  if (plan.strategy === 'brsr_narrative_summary') return true;
  return false;
}

/**
 * Validate that selected tool matches answer type / metric / expected output.
 *
 * @returns {{ ok: boolean, errors: string[], warnings: string[], repairs: object[], answerType: string }}
 */
export function validateSemanticPlan(plan, classification, {
  userMessage = '',
  memory = null,
} = {}) {
  const errors = [];
  const warnings = [];
  const repairs = [];

  const detected = detectAnswerType(userMessage, { classification, plan });
  const answerType = detected.answerType;
  const metric = plan?.metric || classification?.metric || classification?.filters?.metric || null;
  const priorMetric = memory?.lastMetric || memory?.filters?.metric || null;

  // Current message metric must override previous metric (never answer male_employee_count for carbon ask).
  if (
    metric
    && priorMetric
    && metric !== priorMetric
    && classification?.metricResolution !== METRIC_RESOLUTION.NONE
    && (plan?.filters?.metric === priorMetric && plan?.metric === priorMetric)
  ) {
    errors.push(`stale_metric:plan_kept_${priorMetric}_but_request_is_${metric}`);
    repairs.push({ type: 'force_current_metric' });
  }

  if (answerType === ANSWER_TYPES.QUANTITATIVE) {
    if (isNarrativeFirstPlan(plan)) {
      errors.push(
        `quantitative_request_planned_as_narrative:tool=${plan.primaryTool}:strategy=${plan.strategy}`,
      );
      repairs.push({ type: 'force_sql_quantitative' });
    }
    if (plan?.primaryTool === TOOLS.RAG || plan?.strategy === 'guidance_templates') {
      errors.push('metric_value_ask_cannot_use_rag_primary');
      repairs.push({ type: 'force_sql_quantitative' });
    }
    // Expected output: numeric values / SQL strategies.
    const sqlStrategies = new Set([
      'sql_company_metric',
      'sql_compare_companies',
      'sql_rank_metric',
      'sql_count',
      'sql_list_all_paginated',
      'sql_list_overview',
      'sql_filter_sector',
      'sql_trend',
      'sql_sector_aggregate',
      'unsupported_metric',
      'hybrid_why_compare',
    ]);
    if (plan?.strategy && !sqlStrategies.has(plan.strategy) && isNarrativeFirstPlan(plan)) {
      warnings.push(`unexpected_strategy_for_quantitative:${plan.strategy}`);
    }
  } else if (
    answerType === ANSWER_TYPES.INFORMATIONAL
    || answerType === ANSWER_TYPES.QUALITATIVE
  ) {
    // Informational / how-to must never execute SQL as primary.
    if (
      plan?.primaryTool === TOOLS.SQL
      || plan?.strategy === 'sql_rank_metric'
      || plan?.strategy === 'sql_company_metric'
      || plan?.strategy === 'sql_compare_companies'
    ) {
      const intent = classification?.intent || plan?.intent;
      if (intent === INTENTS.HOW_TO || answerType === ANSWER_TYPES.QUALITATIVE && isGuidanceQuestion(userMessage)) {
        errors.push('how_to_planned_as_sql');
        repairs.push({ type: 'force_how_to' });
      } else {
        errors.push('informational_planned_as_sql');
        repairs.push({ type: 'force_informational' });
      }
    }
  } else if (
    // Narrative-first FOLLOW_UP with only a reused prior metric is allowed (why / explain).
    answerType === ANSWER_TYPES.UNKNOWN
    && plan?.strategy === 'follow_up_from_memory'
  ) {
    warnings.push('follow_up_hybrid_without_new_metric');
  }

  if (answerType === ANSWER_TYPES.QUALITATIVE) {
    if (
      plan?.strategy === 'sql_rank_metric'
      && /\bhow\s+(to|can|should)\b/i.test(userMessage)
    ) {
      errors.push('qualitative_how_to_planned_as_ranking');
      repairs.push({ type: 'force_how_to' });
    }
  }

  // Metric ↔ tool coherence for known measurable metrics — skip for informational/how-to.
  if (
    metric
    && PLAN_METRICS.has(metric)
    && answerType === ANSWER_TYPES.QUANTITATIVE
    && classification?.intent !== INTENTS.INFORMATIONAL
    && classification?.intent !== INTENTS.HOW_TO
  ) {
    if (plan?.primaryTool !== TOOLS.SQL && plan?.strategy !== 'hybrid_why_compare' && plan?.strategy !== 'unsupported_metric') {
      if (plan?.primaryTool === TOOLS.HYBRID || plan?.primaryTool === TOOLS.RAG || plan?.primaryTool === 'NONE') {
        if (plan?.primaryTool !== 'NONE') {
          errors.push(`metric_${metric}_requires_sql_primary_got_${plan.primaryTool}`);
          repairs.push({ type: 'force_sql_quantitative' });
        }
      }
    }
  }

  // Deduplicate repairs
  const seen = new Set();
  const uniqueRepairs = [];
  for (const r of repairs) {
    if (seen.has(r.type)) continue;
    seen.add(r.type);
    uniqueRepairs.push(r);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    repairs: uniqueRepairs,
    answerType,
    confidence: detected.confidence,
    reasons: detected.reasons,
  };
}

/**
 * Suggested SQL intent for a quantitative follow-up with companies from memory.
 */
export function quantitativeIntentForCompanies(companies = [], classification = null) {
  const list = Array.isArray(companies) ? companies.filter(Boolean) : [];
  if (list.length >= 2) return INTENTS.COMPARE_COMPANIES;
  if (list.length === 1) return INTENTS.METRIC_LOOKUP;
  if ((classification?.entities || []).length >= 2) return INTENTS.COMPARE_COMPANIES;
  return INTENTS.METRIC_LOOKUP;
}

/**
 * True when execution must prefer SQL over narrative for this turn.
 */
export function mustPreferSql(userMessage, classification = null, plan = null) {
  const { answerType } = detectAnswerType(userMessage, { classification, plan });
  return answerType === ANSWER_TYPES.QUANTITATIVE;
}
