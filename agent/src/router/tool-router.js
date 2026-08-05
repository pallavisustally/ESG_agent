/**
 * Tool router — route from structured plan/intent.
 * Never use RAG for rankings, counts, totals, or numeric comparisons.
 * RAG is for narrative only (strategy, governance, policies).
 *
 * @deprecated Prefer ExecutionPlan via `execution/execution-planner.js`.
 * Kept for legacy fallback when USE_EXECUTION_PLANNER=false.
 */

import { TOOLS } from '../planner/plan-query.js';
import { INTENTS } from '../intent/classify-intent.js';
import { mustPreferSql } from '../validation/semantic-plan.js';

/**
 * @param {object} plan from planQuery
 * @param {{ userMessage?: string, classification?: object }} [ctx]
 * @returns {{ mode: 'deterministic_sql'|'hybrid'|'llm_tools'|'rag', tools: string[], skipRag: boolean }}
 */
export function routeTools(plan, ctx = {}) {
  if (!plan) {
    return { mode: 'llm_tools', tools: [TOOLS.LLM_TOOLS], skipRag: true };
  }

  // Intent-first: informational + how-to never use SQL.
  if (
    plan.intent === INTENTS.INFORMATIONAL
    || plan.strategy === 'informational_definition'
    || plan.filters?.informational
  ) {
    return {
      mode: 'rag',
      tools: [TOOLS.RAG],
      skipRag: false,
      reason: 'informational_definition',
    };
  }
  if (plan.intent === INTENTS.HOW_TO || plan.strategy === 'guidance_templates') {
    return {
      mode: 'rag',
      tools: [TOOLS.RAG],
      skipRag: false,
      reason: 'how_to_guidance',
    };
  }

  const sqlOnlyIntents = new Set([
    INTENTS.LIST_ALL_COMPANIES,
    INTENTS.COUNT_COMPANIES,
    INTENTS.FILTER_BY_SECTOR,
    INTENTS.TOP_METRIC,
    INTENTS.BOTTOM_METRIC,
    INTENTS.SECTOR_SUMMARY,
    INTENTS.PAGINATE_CONTINUE,
    INTENTS.COMPARE_COMPANIES,
  ]);

  // Semantic gate: measurable value asks never start on RAG/hybrid narrative.
  if (
    mustPreferSql(ctx.userMessage || '', ctx.classification || null, plan)
    && plan.entities?.length
    && plan.metric
    && (plan.primaryTool === TOOLS.HYBRID || plan.primaryTool === TOOLS.RAG || plan.useRag)
    && plan.strategy !== 'hybrid_why_compare'
  ) {
    return {
      mode: 'deterministic_sql',
      tools: [TOOLS.SQL],
      skipRag: true,
      reason: 'quantitative_metric_forces_sql',
    };
  }

  if (plan.deterministic && sqlOnlyIntents.has(plan.intent) && !plan.useRag) {
    return {
      mode: 'deterministic_sql',
      tools: [TOOLS.SQL, ...(plan.secondaryTools || [])],
      skipRag: true,
    };
  }

  // Compare with only one resolved entity hint — still prefer SQL path when strategy says so
  if (plan.intent === INTENTS.COMPARE_COMPANIES && plan.strategy === 'sql_compare_companies' && !plan.useRag) {
    return {
      mode: 'deterministic_sql',
      tools: [TOOLS.SQL, ...(plan.secondaryTools || [])],
      skipRag: true,
    };
  }

  // Company metric/report lookup: deterministic SQL first; pipeline may document-fallback on miss.
  if (
    (plan.intent === INTENTS.METRIC_LOOKUP || plan.intent === INTENTS.REPORT_LOOKUP)
    && plan.strategy === 'sql_company_metric'
    && plan.entities?.length
    && plan.deterministic
  ) {
    return {
      mode: 'deterministic_sql',
      tools: [TOOLS.SQL, ...(plan.secondaryTools || [])],
      // skipRag true blocks cross-corpus hybridRetrieve; company PDF fallback is separate.
      skipRag: true,
    };
  }

  // Quantitative follow-up rewritten to SQL strategies.
  if (
    (plan.strategy === 'sql_compare_companies' || plan.strategy === 'sql_company_metric')
    && plan.filters?.answerType === 'QUANTITATIVE'
  ) {
    return {
      mode: 'deterministic_sql',
      tools: [TOOLS.SQL],
      skipRag: true,
    };
  }

  if (plan.intent === INTENTS.COMPANY_SUMMARY && plan.entities?.length) {
    return {
      mode: 'hybrid',
      tools: [TOOLS.SQL, TOOLS.RAG],
      skipRag: false,
    };
  }

  // How-to guidance is handled by templates in the pipeline (not SQL ranking).
  if (plan.intent === INTENTS.HOW_TO || plan.strategy === 'guidance_templates') {
    return {
      mode: 'rag',
      tools: [TOOLS.RAG],
      skipRag: false,
    };
  }

  if (
    plan.intent === INTENTS.FOLLOW_UP
    || plan.strategy === 'follow_up_from_memory'
    || plan.strategy === 'hybrid_why_compare'
    || plan.filters?.hybridWhy
  ) {
    return {
      mode: 'hybrid',
      tools: [TOOLS.SQL, TOOLS.RAG],
      skipRag: false,
    };
  }

  if (plan.primaryTool === TOOLS.RAG && plan.intent === INTENTS.GENERAL_ESG_QUESTION) {
    return {
      mode: 'rag',
      tools: [TOOLS.RAG, TOOLS.SQL],
      skipRag: false,
    };
  }

  if (plan.primaryTool === TOOLS.HYBRID || plan.useRag) {
    return {
      mode: 'hybrid',
      tools: [TOOLS.SQL, TOOLS.RAG, ...(plan.secondaryTools || [])],
      skipRag: false,
    };
  }

  if (plan.primaryTool === TOOLS.CHARTS || plan.strategy === 'sql_then_chart') {
    return {
      mode: 'llm_tools',
      tools: [TOOLS.SQL, TOOLS.CHARTS],
      skipRag: true,
    };
  }

  return {
    mode: 'llm_tools',
    tools: [TOOLS.LLM_TOOLS],
    skipRag: true,
  };
}

/** True when SQL alone is sufficient — router must not invoke RAG. */
export function shouldSkipRag(plan, ctx = {}) {
  return routeTools(plan, ctx).skipRag;
}
