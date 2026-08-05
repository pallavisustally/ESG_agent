/**
 * Synthesize a legacy tool-plan object for sql-agent / report helpers
 * from an ExecutionPlan. Used only as an adapter — not a routing authority.
 */

import { INTENTS } from '../intent/classify-intent.js';
import { TOOLS } from '../planner/plan-query.js';

/**
 * @param {import('./execution-plan.js').ExecutionPlan} executionPlan
 * @param {object} [classification]
 * @returns {object} tool plan compatible with runSqlAgent
 */
export function toolPlanFromExecutionPlan(executionPlan, classification = null) {
  const intent = executionPlan?.intent || classification?.intent || INTENTS.UNKNOWN;
  const entities = executionPlan?.entities?.length
    ? executionPlan.entities
    : (classification?.entities || []);
  const metrics = executionPlan?.metrics?.length
    ? executionPlan.metrics
    : (classification?.metric ? [classification.metric] : []);
  const metric = metrics[0] || classification?.metric || 'total_emissions';
  const filters = {
    ...(classification?.filters || {}),
    ...(executionPlan?.filters || {}),
    metrics,
    metric,
    years: executionPlan?.years?.length
      ? executionPlan.years
      : (classification?.filters?.years || []),
    aggregation: executionPlan?.aggregation || classification?.filters?.aggregation || null,
    groupBy: executionPlan?.grouping || classification?.filters?.groupBy || null,
    wantsChart: Boolean(executionPlan?.needsVisualization || executionPlan?.visualization),
    answerType: executionPlan?.needsSql ? 'QUANTITATIVE' : (classification?.filters?.answerType || null),
  };

  const strategy = pickStrategy(executionPlan, intent, entities, filters);
  const primaryTool = strategy.startsWith('sql_') || strategy === 'sql_then_chart'
    ? TOOLS.SQL
    : strategy === 'hybrid_why_compare' || strategy === 'brsr_narrative_summary' || strategy === 'follow_up_from_memory'
      ? (strategy === 'brsr_narrative_summary' ? TOOLS.RAG : TOOLS.HYBRID)
      : strategy === 'guidance_templates' || strategy === 'informational_definition'
        ? TOOLS.RAG
        : TOOLS.LLM_TOOLS;

  return {
    intent,
    primaryTool,
    secondaryTools: executionPlan?.needsVisualization ? [TOOLS.CHARTS] : [],
    strategy,
    filters,
    entities,
    metric,
    metrics,
    confidence: executionPlan?.confidence ?? classification?.confidence ?? 0.7,
    deterministic: Boolean(executionPlan?.needsSql || executionPlan?.needsReport),
    useRag: Boolean(executionPlan?.needsReport || executionPlan?.needsPdf),
    reason: executionPlan?.reason || 'Synthesized from ExecutionPlan',
    capabilities: executionPlan?.capabilities || [],
    primaryCapability: executionPlan?.capability || null,
    executionPlan,
  };
}

function pickStrategy(executionPlan, intent, entities, filters) {
  if (executionPlan?.metadata?.legacyStrategyHint) {
    return executionPlan.metadata.legacyStrategyHint;
  }
  if (filters.hybridWhy) return 'hybrid_why_compare';
  if (executionPlan?.comparison || intent === INTENTS.COMPARE_COMPANIES) {
    return 'sql_compare_companies';
  }
  switch (intent) {
    case INTENTS.TOP_METRIC:
    case INTENTS.BOTTOM_METRIC:
      return 'sql_rank_metric';
    case INTENTS.METRIC_LOOKUP:
      return 'sql_company_metric';
    case INTENTS.SECTOR_SUMMARY:
      return 'sql_sector_aggregate';
    case INTENTS.TREND_ANALYSIS:
      return 'sql_trend';
    case INTENTS.CHART_REQUEST:
      return 'sql_then_chart';
    case INTENTS.LIST_ALL_COMPANIES:
      return 'sql_list_overview';
    case INTENTS.COUNT_COMPANIES:
      return 'sql_count';
    case INTENTS.FILTER_BY_SECTOR:
      return 'sql_filter_sector';
    case INTENTS.PAGINATE_CONTINUE:
      return 'sql_list_all_paginated';
    case INTENTS.COMPANY_SUMMARY:
    case INTENTS.REPORT_LOOKUP:
      return 'brsr_narrative_summary';
    case INTENTS.HOW_TO:
      return 'guidance_templates';
    case INTENTS.INFORMATIONAL:
    case INTENTS.GENERAL_ESG_QUESTION:
      return 'informational_definition';
    case INTENTS.FOLLOW_UP:
      return entities.length >= 2 ? 'sql_compare_companies' : 'sql_company_metric';
    default:
      if (executionPlan?.needsSql && entities.length >= 2) return 'sql_compare_companies';
      if (executionPlan?.needsSql && entities.length === 1) return 'sql_company_metric';
      if (executionPlan?.needsSql) return 'sql_rank_metric';
      if (executionPlan?.needsReport) return 'brsr_narrative_summary';
      return 'llm_tool_loop';
  }
}
