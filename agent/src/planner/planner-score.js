/**
 * Phase 12 — Planner intelligence scoring.
 *
 * Instead of routing only by intent → tool, score a candidate plan on:
 * Intent, Metric, Companies, Conversation, Tool, Confidence, Expected Output, Validation.
 *
 * Higher score → prefer that plan. Used before execution; does not invent facts.
 */

import { INTENTS } from '../intent/classify-intent.js';
import { METRIC_RESOLUTION } from '../intent/metric-resolution.js';
import { TOOLS } from './plan-query.js';
import { RANKABLE_METRICS } from '../sql-sanitize.js';

/** Metrics the SQL agent can rank/compare, including computed / derived metrics. */
const PLAN_METRICS = new Set([
  ...RANKABLE_METRICS,
  'total_emissions',
  'male_board_count',
  'male_board_share',
]);

/** Weights for plan scoring dimensions (sum ≈ 1). */
export const PLAN_SCORE_WEIGHTS = Object.freeze({
  intent: 0.18,
  metric: 0.16,
  companies: 0.14,
  conversation: 0.1,
  tool: 0.16,
  confidence: 0.1,
  expectedOutput: 0.08,
  validation: 0.08,
});

const SQL_INTENTS = new Set([
  INTENTS.LIST_ALL_COMPANIES,
  INTENTS.COUNT_COMPANIES,
  INTENTS.FILTER_BY_SECTOR,
  INTENTS.TOP_METRIC,
  INTENTS.BOTTOM_METRIC,
  INTENTS.COMPARE_COMPANIES,
  INTENTS.METRIC_LOOKUP,
  INTENTS.REPORT_LOOKUP,
  INTENTS.SECTOR_SUMMARY,
  INTENTS.TREND_ANALYSIS,
  INTENTS.PAGINATE_CONTINUE,
]);

const NARRATIVE_INTENTS = new Set([
  INTENTS.HOW_TO,
  INTENTS.GENERAL_ESG_QUESTION,
  INTENTS.COMPANY_SUMMARY,
]);

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function scoreIntent(plan, classification) {
  const intent = classification?.intent || plan?.intent;
  if (!intent || intent === INTENTS.UNKNOWN) return 0.25;
  if (plan?.intent && plan.intent !== intent) return 0.2;
  if (plan?.strategy === 'llm_tool_loop') return 0.35;
  return 0.95;
}

function scoreMetric(plan, classification) {
  const resolution = classification?.metricResolution
    || classification?.filters?.metricResolution
    || METRIC_RESOLUTION.NONE;
  const metric = plan?.metric || classification?.metric || null;
  const needsMetric = classification?.intent === INTENTS.TOP_METRIC
    || classification?.intent === INTENTS.BOTTOM_METRIC
    || classification?.intent === INTENTS.METRIC_LOOKUP
    || classification?.intent === INTENTS.COMPARE_COMPANIES;

  if (resolution === METRIC_RESOLUTION.UNSUPPORTED) {
    // OK if plan skipped SQL metric path
    return plan?.strategy === 'unsupported_metric' || plan?.primaryTool !== TOOLS.SQL
      ? 0.85
      : 0.2;
  }
  if (resolution === METRIC_RESOLUTION.DERIVED && metric) return 0.95;
  if (resolution === METRIC_RESOLUTION.FOUND && metric && PLAN_METRICS.has(metric)) return 1;
  if (resolution === METRIC_RESOLUTION.NONE && !needsMetric) return 0.8;
  if (needsMetric && metric && PLAN_METRICS.has(metric)) return 0.9;
  if (needsMetric && !metric) return 0.15;
  if (metric && !PLAN_METRICS.has(metric)) return 0.1;
  return 0.7;
}

function scoreCompanies(plan, classification) {
  const intent = classification?.intent || plan?.intent;
  const companies = plan?.entities?.length
    ? plan.entities
    : (classification?.entities || []);
  const n = Array.isArray(companies) ? companies.length : 0;

  if (intent === INTENTS.COMPARE_COMPANIES) {
    if (n >= 2) return 1;
    if (n === 1) return 0.35;
    return 0.1;
  }
  if (intent === INTENTS.METRIC_LOOKUP || intent === INTENTS.REPORT_LOOKUP || intent === INTENTS.COMPANY_SUMMARY) {
    return n >= 1 ? 0.95 : 0.2;
  }
  if (classification?.filters?.needsPriorCompanies) return 0.15;
  return 0.85;
}

function scoreConversation(plan, classification, memory) {
  const intent = classification?.intent || plan?.intent;
  if (intent === INTENTS.FOLLOW_UP) {
    const hasPrior = Boolean(
      memory?.lastIntent
      || memory?.lastCompanies?.length
      || memory?.lastMetric
      || memory?.lastYear
      || memory?.comparisonContext,
    );
    return hasPrior ? 0.9 : 0.25;
  }
  if (intent === INTENTS.PAGINATE_CONTINUE) {
    return memory?.lastList || memory?.awaitingMore ? 0.95 : 0.2;
  }
  if (classification?.filters?.resumedFromPending || classification?.filters?.clarificationProvidesCompanies) {
    return 0.9;
  }
  return 0.8;
}

function scoreTool(plan, classification) {
  const intent = classification?.intent || plan?.intent;
  const tool = plan?.primaryTool;
  const strategy = plan?.strategy;

  if (!tool) return 0.2;

  // Carbon / metric lookup must not be primary Narrative/RAG.
  if (
    (intent === INTENTS.METRIC_LOOKUP || intent === INTENTS.TOP_METRIC || intent === INTENTS.BOTTOM_METRIC)
    && (tool === TOOLS.RAG || strategy === 'guidance_templates' || strategy === 'rag_with_schema_context')
  ) {
    return 0.05;
  }

  // HOW_TO must not be SQL ranking.
  if (intent === INTENTS.HOW_TO && (tool === TOOLS.SQL || strategy === 'sql_rank_metric')) {
    return 0.05;
  }

  if (SQL_INTENTS.has(intent) && tool === TOOLS.SQL) return 1;
  if (SQL_INTENTS.has(intent) && tool === TOOLS.HYBRID && strategy === 'hybrid_why_compare') return 0.9;
  if (NARRATIVE_INTENTS.has(intent) && (tool === TOOLS.RAG || tool === TOOLS.HYBRID)) return 0.95;
  if (intent === INTENTS.FOLLOW_UP && (tool === TOOLS.HYBRID || tool === TOOLS.SQL || tool === TOOLS.RAG)) {
    return 0.85;
  }
  return 0.55;
}

function scoreConfidence(classification, plan) {
  const c = Number(classification?.confidence ?? plan?.confidence ?? 0);
  if (!Number.isFinite(c) || c <= 0) return 0.5;
  return clamp01(c);
}

function scoreExpectedOutput(plan, classification) {
  const intent = classification?.intent || plan?.intent;
  const strategy = plan?.strategy || '';

  const expected = {
    [INTENTS.TOP_METRIC]: 'sql_rank_metric',
    [INTENTS.BOTTOM_METRIC]: 'sql_rank_metric',
    [INTENTS.COMPARE_COMPANIES]: classification?.filters?.hybridWhy
      ? 'hybrid_why_compare'
      : 'sql_compare_companies',
    [INTENTS.METRIC_LOOKUP]: 'sql_company_metric',
    [INTENTS.REPORT_LOOKUP]: 'sql_company_metric',
    [INTENTS.HOW_TO]: 'guidance_templates',
    [INTENTS.COUNT_COMPANIES]: 'sql_count',
    [INTENTS.LIST_ALL_COMPANIES]: null, // paginated or overview
  };

  const want = expected[intent];
  if (want == null && intent === INTENTS.LIST_ALL_COMPANIES) {
    return strategy === 'sql_list_all_paginated' || strategy === 'sql_list_overview' ? 0.95 : 0.4;
  }
  if (want == null) return 0.7;
  return strategy === want ? 1 : 0.25;
}

function scoreValidation(validation) {
  if (!validation) return 0.6;
  if (validation.ok) return validation.warnings?.length ? 0.85 : 1;
  return Math.max(0, 0.4 - 0.1 * (validation.errors?.length || 0));
}

/**
 * Score a single plan candidate.
 * @returns {{ score: number, dimensions: object, reasons: string[] }}
 */
export function scorePlan(plan, classification, {
  memory = null,
  validation = null,
} = {}) {
  const dimensions = {
    intent: scoreIntent(plan, classification),
    metric: scoreMetric(plan, classification),
    companies: scoreCompanies(plan, classification),
    conversation: scoreConversation(plan, classification, memory),
    tool: scoreTool(plan, classification),
    confidence: scoreConfidence(classification, plan),
    expectedOutput: scoreExpectedOutput(plan, classification),
    validation: scoreValidation(validation),
  };

  let score = 0;
  const reasons = [];
  for (const [key, weight] of Object.entries(PLAN_SCORE_WEIGHTS)) {
    const dim = dimensions[key] ?? 0;
    score += weight * dim;
    if (dim < 0.4) reasons.push(`low_${key}:${dim.toFixed(2)}`);
  }

  return {
    score: Math.round(score * 1000) / 1000,
    dimensions,
    reasons,
  };
}

/**
 * Choose the best plan among candidates (or score the only plan).
 */
export function selectBestPlan(candidates = [], {
  memory = null,
  minScore = Number(process.env.PLAN_MIN_SCORE || 0.4),
} = {}) {
  const list = (Array.isArray(candidates) ? candidates : [])
    .filter((c) => c?.plan && c?.classification)
    .map((c) => {
      const scored = scorePlan(c.plan, c.classification, {
        memory,
        validation: c.validation || null,
      });
      return { ...c, ...scored };
    })
    .sort((a, b) => b.score - a.score);

  if (!list.length) {
    return { ok: false, plan: null, classification: null, score: 0, reason: 'no_candidates' };
  }

  const best = list[0];
  return {
    ok: best.score >= minScore,
    plan: best.plan,
    classification: best.classification,
    validation: best.validation || null,
    score: best.score,
    dimensions: best.dimensions,
    reasons: best.reasons,
    candidates: list.map((c) => ({
      strategy: c.plan?.strategy,
      tool: c.plan?.primaryTool,
      score: c.score,
    })),
  };
}

/**
 * True when scored plan looks like wrong path (metric→narrative, how-to→SQL, etc.).
 */
export function isWeakPlanScore(scored, { minScore = Number(process.env.PLAN_MIN_SCORE || 0.4) } = {}) {
  if (!scored) return true;
  if (scored.score < minScore) return true;
  if ((scored.dimensions?.tool ?? 1) < 0.2) return true;
  if ((scored.dimensions?.metric ?? 1) < 0.2) return true;
  return false;
}
