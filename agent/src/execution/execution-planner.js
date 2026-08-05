/**
 * Execution Planner — sole intended routing authority (Phase 2).
 *
 * Builds an ExecutionPlan from user message + memory (+ optional precomputed classification).
 *
 * NEVER:
 *   - executes SQL
 *   - searches reports / PDFs
 *   - generates charts
 *   - generates user-facing answers
 *
 * Until USE_EXECUTION_PLANNER is enabled for dispatch, this runs in parallel with
 * the legacy Tool Planner + Capability Planner for parity comparison only.
 */

import { classifyIntent, INTENTS } from '../intent/classify-intent.js';
import { METRIC_RESOLUTION } from '../intent/metric-resolution.js';
import {
  planCapabilities,
  shouldUseCapabilityExecutor,
} from '../capability/capability-planner.js';
import { CAPABILITIES } from '../capability/capabilities.js';
import {
  createExecutionPlan,
  validateExecutionPlan,
  EXECUTION_ENGINES,
} from './execution-plan.js';

/**
 * Build an ExecutionPlan for a user request.
 *
 * @param {Object} input
 * @param {string} input.userMessage
 * @param {object|null} [input.memory]
 * @param {object|null} [input.classification] - prefer pipeline classification when comparing
 * @param {string[]} [input.assumptions]
 * @returns {{ plan: import('./execution-plan.js').ExecutionPlan, validation: object, capabilityPlan: object }}
 */
export function planExecution(input = {}) {
  const userMessage = String(input.userMessage || '');
  const memory = input.memory || null;

  // Prefer caller-supplied classification (post entity-normalize) for parity.
  // Otherwise use deterministic rules classifier only — never calls LLM / SQL / RAG.
  const classification = input.classification || classifyIntent(userMessage, memory);

  const capabilityPlan = planCapabilities(userMessage, classification, memory);
  const filters = classification.filters || {};
  const intent = classification.intent || null;

  const metrics = resolveMetrics(classification, filters);
  const years = resolveYears(filters, memory);
  const entities = Array.isArray(classification.entities) ? [...classification.entities] : [];

  const needsClarification = Boolean(
    classification.clarification
      || filters.needsPriorCompanies
      || (intent === INTENTS.UNKNOWN && Number(classification.confidence) < 0.4),
  );

  const caps = capabilityPlan.capabilities || [];
  const needsKnowledge = caps.includes(CAPABILITIES.ESG_KNOWLEDGE);
  const needsGuidance = caps.includes(CAPABILITIES.ESG_GUIDANCE);
  const needsCompliance = caps.includes(CAPABILITIES.ESG_COMPLIANCE);
  const needsDocumentGeneration = caps.includes(CAPABILITIES.DOCUMENT_GENERATION);
  const needsRecommendation = caps.includes(CAPABILITIES.RECOMMENDATION);
  const needsSql = caps.includes(CAPABILITIES.COMPANY_ANALYTICS)
    || caps.includes(CAPABILITIES.BENCHMARKING)
    || isSqlIntent(intent);
  const needsReport = caps.includes(CAPABILITIES.COMPANY_REPORTS)
    || isReportIntent(intent);
  // PDF is a Report Engine strategy — signal when report path / metric miss may need pages.
  const needsPdf = needsReport
    || (needsSql && entities.length > 0 && (
      classification.metricResolution === METRIC_RESOLUTION.UNSUPPORTED
      || isReportIntent(intent)
    ));

  const visualization = Boolean(
    filters.wantsChart
      || intent === INTENTS.CHART_REQUEST
      || /\b(chart|plot|graph|visuali[sz]e)\b/i.test(userMessage),
  );
  // Charts only when there will be structured/report data to plot.
  const needsVisualization = visualization && (needsSql || needsReport);

  const comparison = Boolean(
    caps.includes(CAPABILITIES.BENCHMARKING)
      || intent === INTENTS.COMPARE_COMPANIES
      || filters.hybridWhy,
  );

  const aggregation = filters.aggregation || null;
  const grouping = filters.groupBy || filters.grouping || null;

  const executionStrategy = selectExecutionStrategy({
    needsClarification,
    classification,
    capabilityPlan,
    needsDocumentGeneration,
    needsCompliance,
    needsKnowledge,
    needsGuidance,
    needsRecommendation,
    needsSql,
    needsReport,
    comparison,
    intent,
    filters,
  });

  const requiredEngines = [];
  if (!needsClarification) {
    if (needsKnowledge) requiredEngines.push(EXECUTION_ENGINES.KNOWLEDGE);
    if (needsCompliance) requiredEngines.push(EXECUTION_ENGINES.COMPLIANCE);
    if (needsSql) requiredEngines.push(EXECUTION_ENGINES.ANALYTICS);
    if (needsReport || needsPdf) requiredEngines.push(EXECUTION_ENGINES.REPORT);
    if (needsGuidance) requiredEngines.push(EXECUTION_ENGINES.GUIDANCE);
    if (needsRecommendation) requiredEngines.push(EXECUTION_ENGINES.RECOMMENDATION);
    if (needsDocumentGeneration) requiredEngines.push(EXECUTION_ENGINES.DOCUMENT);
    if (needsVisualization) requiredEngines.push(EXECUTION_ENGINES.VISUALIZATION);
  }

  const plan = createExecutionPlan({
    intent,
    capability: capabilityPlan.primaryCapability,
    capabilities: caps,
    entities,
    metrics,
    years,
    aggregation,
    grouping,
    comparison,
    visualization,
    executionStrategy,
    requiredEngines,
    needsSql: needsClarification ? false : needsSql,
    needsReport: needsClarification ? false : needsReport,
    needsPdf: needsClarification ? false : needsPdf,
    needsVisualization: needsClarification ? false : needsVisualization,
    needsRecommendation: needsClarification ? false : needsRecommendation,
    needsKnowledge: needsClarification ? false : needsKnowledge,
    needsGuidance: needsClarification ? false : needsGuidance,
    needsCompliance: needsClarification ? false : needsCompliance,
    needsDocumentGeneration: needsClarification ? false : needsDocumentGeneration,
    needsClarification,
    confidence: Number(classification.confidence) || 0,
    assumptions: input.assumptions || classification.assumptions || [],
    reason: capabilityPlan.reason || classification.source || null,
    clarification: classification.clarification
      || (filters.needsPriorCompanies ? 'Which company should I use for this follow-up?' : null),
    filters: {
      ...filters,
      metric: classification.metric || filters.metric || null,
      metrics,
      hybridWhy: Boolean(filters.hybridWhy),
      wantsChart: visualization,
      metricResolution: classification.metricResolution || filters.metricResolution || null,
    },
    metadata: {
      source: 'execution_planner',
      classificationSource: classification.source || 'rules',
      capabilityFlags: capabilityPlan.flags || {},
      multi: capabilityPlan.multi,
      useCapabilityExecutor: shouldUseCapabilityExecutor(capabilityPlan),
      legacyStrategyHint: legacyStrategyHint(intent, filters, comparison),
    },
  });

  const validation = validateExecutionPlan(plan);
  return { plan, validation, capabilityPlan, classification };
}

/**
 * Convenience: return only the ExecutionPlan object.
 */
export function buildExecutionPlan(input = {}) {
  return planExecution(input).plan;
}

function resolveMetrics(classification, filters) {
  if (Array.isArray(classification.metrics) && classification.metrics.length) {
    return classification.metrics.map(String);
  }
  if (Array.isArray(filters.metrics) && filters.metrics.length) {
    return filters.metrics.map(String);
  }
  if (classification.metric) return [String(classification.metric)];
  if (filters.metric) return [String(filters.metric)];
  return [];
}

function resolveYears(filters, memory) {
  if (Array.isArray(filters.years) && filters.years.length) return filters.years;
  if (filters.year != null) return [filters.year];
  if (memory?.lastYear != null) return [memory.lastYear];
  return [];
}

function isSqlIntent(intent) {
  return [
    INTENTS.LIST_ALL_COMPANIES,
    INTENTS.COUNT_COMPANIES,
    INTENTS.FILTER_BY_SECTOR,
    INTENTS.TOP_METRIC,
    INTENTS.BOTTOM_METRIC,
    INTENTS.METRIC_LOOKUP,
    INTENTS.SECTOR_SUMMARY,
    INTENTS.TREND_ANALYSIS,
    INTENTS.CHART_REQUEST,
    INTENTS.PAGINATE_CONTINUE,
    INTENTS.COMPARE_COMPANIES,
  ].includes(intent);
}

function isReportIntent(intent) {
  return intent === INTENTS.COMPANY_SUMMARY || intent === INTENTS.REPORT_LOOKUP;
}

function selectExecutionStrategy({
  needsClarification,
  classification,
  capabilityPlan,
  needsDocumentGeneration,
  needsCompliance,
  needsKnowledge,
  needsGuidance,
  needsRecommendation,
  needsSql,
  needsReport,
  comparison,
  intent,
  filters,
}) {
  if (needsClarification) return 'clarify';
  if (classification.metricResolution === METRIC_RESOLUTION.UNSUPPORTED && !needsReport) {
    return 'unsupported';
  }
  if (capabilityPlan.multi || needsRecommendation) {
    if (needsRecommendation) return 'recommendation';
    return 'hybrid';
  }
  if (needsDocumentGeneration) return 'document';
  if (needsCompliance) return 'compliance';
  if (needsKnowledge) return 'knowledge';
  if (needsGuidance) return 'guidance';
  if (filters.hybridWhy || (comparison && filters.hybridWhy)) return 'hybrid';
  if (needsSql && needsReport) return 'hybrid';
  if (needsSql) return 'analytics';
  if (needsReport) return 'report';
  if (intent === INTENTS.UNKNOWN) return 'llm_fallback';
  return 'llm_fallback';
}

/**
 * Transitional hint mirroring legacy plan-query strategies for compare logs.
 * Not used for execution.
 */
function legacyStrategyHint(intent, filters, comparison) {
  if (filters.hybridWhy) return 'hybrid_why_compare';
  switch (intent) {
    case INTENTS.TOP_METRIC:
    case INTENTS.BOTTOM_METRIC:
      return 'sql_rank_metric';
    case INTENTS.COMPARE_COMPANIES:
      return comparison ? 'sql_compare_companies' : 'sql_compare_companies';
    case INTENTS.METRIC_LOOKUP:
      return 'sql_company_metric';
    case INTENTS.SECTOR_SUMMARY:
      return 'sql_sector_aggregate';
    case INTENTS.TREND_ANALYSIS:
      return 'sql_trend';
    case INTENTS.CHART_REQUEST:
      return 'sql_then_chart';
    case INTENTS.HOW_TO:
      return 'guidance_templates';
    case INTENTS.INFORMATIONAL:
    case INTENTS.GENERAL_ESG_QUESTION:
      return 'informational_definition';
    case INTENTS.COMPANY_SUMMARY:
    case INTENTS.REPORT_LOOKUP:
      return 'brsr_narrative_summary';
    case INTENTS.LIST_ALL_COMPANIES:
      return 'sql_list_overview';
    case INTENTS.COUNT_COMPANIES:
      return 'sql_count';
    case INTENTS.FILTER_BY_SECTOR:
      return 'sql_filter_sector';
    case INTENTS.PAGINATE_CONTINUE:
      return 'sql_list_all_paginated';
    default:
      return null;
  }
}
