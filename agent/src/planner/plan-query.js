/**
 * Query planner — maps classified intent to tools and strategy.
 * Prefer SQL over RAG whenever structured data can answer.
 *
 * @deprecated Prefer `execution/execution-planner.js` + `toolPlanFromExecutionPlan`
 * for routing. This module remains as a library for SQL strategy synthesis and
 * legacy fallback when USE_EXECUTION_PLANNER=false.
 */

import { INTENTS } from '../intent/classify-intent.js';
import {
  METRIC_RESOLUTION,
  shouldReuseMemoryMetric,
  isExecutableMetricResolution,
} from '../intent/metric-resolution.js';
import { chooseEntitiesByPrecedence } from '../intent/entity-precedence.js';
import { RANKABLE_METRICS } from '../sql-sanitize.js';

const SQL_METRICS = new Set([
  ...RANKABLE_METRICS,
  'total_emissions',
  'male_board_count',
  'male_board_share',
]);

export const TOOLS = Object.freeze({
  SQL: 'SQL',
  RAG: 'RAG',
  ANALYTICS: 'ANALYTICS',
  METADATA: 'METADATA',
  CHARTS: 'CHARTS',
  HYBRID: 'HYBRID',
  LLM_TOOLS: 'LLM_TOOLS',
  EXPORT: 'EXPORT',
});

/**
 * @param {{ intent: string, entities: string[], filters: object, wantsAll?: boolean, metric?: string|null, confidence?: number }} classification
 * @param {object|null} memory
 */
export function planQuery(classification, memory = null, opts = {}) {
  const { intent, entities, filters, wantsAll, metric, confidence } = classification;
  const userMessage = opts.userMessage || '';

  // Pagination continues list context from memory fields — never replays a prior SQL string/plan object.
  if (intent === INTENTS.PAGINATE_CONTINUE && (memory?.lastList || memory?.lastIntent === INTENTS.LIST_ALL_COMPANIES || memory?.awaitingMore)) {
    const page = Math.max(1, (memory.page || 1) + (filters.pageDelta || 1));
    return {
      intent: INTENTS.PAGINATE_CONTINUE,
      primaryTool: TOOLS.SQL,
      secondaryTools: [TOOLS.EXPORT],
      strategy: 'sql_list_all_paginated',
      page,
      pageSize: memory.pageSize || 100,
      filters: {
        ...(memory.filters || {}),
        ...filters,
        sector: filters.sector || memory.lastSector || memory.filters?.sector || null,
      },
      entities: [],
      metric: null,
      confidence: confidence || 0.9,
      deterministic: true,
      useRag: false,
      reason: 'Continue previous company list page from memory pagination fields (not prior SQL)',
    };
  }

  switch (intent) {
    case INTENTS.LIST_ALL_COMPANIES:
      return {
        intent,
        primaryTool: TOOLS.SQL,
        secondaryTools: wantsAll ? [TOOLS.EXPORT, TOOLS.METADATA] : [TOOLS.METADATA],
        strategy: wantsAll ? 'sql_list_all_paginated' : 'sql_list_overview',
        page: 1,
        pageSize: wantsAll ? 100 : 25,
        filters,
        entities,
        metric,
        confidence,
        deterministic: true,
        useRag: false,
        reason: wantsAll
          ? 'User asked for all company names — SQL + pagination/export, never sample-only'
          : 'Company discovery — SQL count/sectors + first page of names',
      };

    case INTENTS.COUNT_COMPANIES:
      return {
        intent,
        primaryTool: TOOLS.SQL,
        secondaryTools: [],
        strategy: 'sql_count',
        filters,
        entities,
        metric,
        confidence,
        deterministic: true,
        useRag: false,
        reason: 'Structured count — SQL only',
      };

    case INTENTS.FILTER_BY_SECTOR:
      return {
        intent,
        primaryTool: TOOLS.SQL,
        secondaryTools: [TOOLS.EXPORT],
        strategy: 'sql_filter_sector',
        page: 1,
        pageSize: 100,
        filters,
        entities,
        metric,
        confidence,
        deterministic: true,
        useRag: false,
        reason: 'Sector filter is structured — SQL',
      };

    case INTENTS.TOP_METRIC:
    case INTENTS.BOTTOM_METRIC:
      return {
        intent,
        primaryTool: TOOLS.SQL,
        secondaryTools: intent === INTENTS.CHART_REQUEST ? [TOOLS.CHARTS] : [],
        strategy: 'sql_rank_metric',
        page: 1,
        pageSize: 10,
        filters,
        entities,
        metric: metric || filters.metric,
        confidence,
        deterministic: Boolean(metric || filters.metric),
        useRag: false,
        reason: 'Ranking metrics — SQL aggregation',
      };

    case INTENTS.COMPARE_COMPANIES:
      // Phase 12: causal / "why higher" compares also pull RAG narrative after SQL.
      if (filters?.hybridWhy) {
        return {
          intent,
          primaryTool: TOOLS.HYBRID,
          secondaryTools: [TOOLS.SQL, TOOLS.RAG],
          strategy: 'hybrid_why_compare',
          filters,
          entities,
          metric,
          metrics: filters?.metrics || (metric ? [metric] : []),
          confidence,
          deterministic: entities.length >= 2,
          useRag: true,
          reason: 'Why/compare — SQL metrics + RAG narrative merge',
        };
      }
      return {
        intent,
        primaryTool: TOOLS.SQL,
        secondaryTools: filters?.wantsChart ? [TOOLS.CHARTS] : [],
        strategy: 'sql_compare_companies',
        filters,
        entities,
        metric,
        metrics: filters?.metrics || (metric ? [metric] : []),
        confidence,
        deterministic: entities.length >= 2,
        useRag: false,
        reason: 'Compare companies — templated SQL side-by-side (no RAG)',
      };

    case INTENTS.COMPANY_SUMMARY:
      return {
        intent,
        primaryTool: TOOLS.HYBRID,
        secondaryTools: [TOOLS.SQL, TOOLS.RAG],
        strategy: 'brsr_narrative_summary',
        filters,
        entities,
        metric,
        confidence,
        deterministic: entities.length > 0,
        useRag: true,
        reason: 'Company summary from BRSR narrative columns + data_json chunks',
      };

    case INTENTS.SECTOR_SUMMARY:
      return {
        intent,
        primaryTool: TOOLS.ANALYTICS,
        secondaryTools: [TOOLS.SQL],
        strategy: 'sql_sector_aggregate',
        filters,
        entities,
        metric,
        confidence,
        deterministic: true,
        useRag: false,
        reason: 'Sector aggregates — SQL GROUP BY',
      };

    case INTENTS.CHART_REQUEST:
      return {
        intent,
        primaryTool: TOOLS.CHARTS,
        secondaryTools: [TOOLS.SQL],
        strategy: 'sql_then_chart',
        filters,
        entities,
        metric,
        confidence,
        deterministic: false,
        useRag: false,
        reason: 'Charts need SQL data then json-chart formatting',
      };

    case INTENTS.TREND_ANALYSIS:
      return {
        intent,
        primaryTool: TOOLS.SQL,
        secondaryTools: [TOOLS.CHARTS],
        strategy: 'sql_trend',
        filters,
        entities,
        metric,
        confidence,
        deterministic: false,
        useRag: false,
        reason: 'Trends across years — SQL',
      };

    case INTENTS.HOW_TO:
      return {
        intent,
        primaryTool: TOOLS.RAG,
        secondaryTools: [],
        strategy: 'guidance_templates',
        filters: { ...filters, guidance: true, answerType: 'QUALITATIVE' },
        entities,
        metric,
        confidence,
        deterministic: true,
        useRag: false,
        reason: 'How-to / reduce / control guidance — templates + BRSR examples, never ranking SQL',
      };

    case INTENTS.INFORMATIONAL:
      return {
        intent,
        primaryTool: TOOLS.RAG,
        secondaryTools: [],
        strategy: 'informational_definition',
        filters: { ...filters, informational: true, answerType: 'INFORMATIONAL' },
        entities: [],
        metric: null,
        confidence,
        deterministic: true,
        useRag: false,
        reason: 'Definition / concept explanation — knowledge answer, never SQL',
      };

    case INTENTS.REPORT_LOOKUP:
      return {
        intent,
        primaryTool: TOOLS.RAG,
        secondaryTools: [TOOLS.SQL],
        strategy: 'brsr_narrative_summary',
        filters: { ...filters, answerType: 'QUALITATIVE' },
        entities,
        metric,
        confidence,
        deterministic: entities.length > 0,
        useRag: true,
        reason: 'Qualitative report disclosure — Narrative then PDF (not structured SQL metric)',
      };

    case INTENTS.METRIC_LOOKUP:
      return {
        intent,
        primaryTool: TOOLS.SQL,
        secondaryTools: entities.length ? [TOOLS.RAG] : [],
        strategy: 'sql_company_metric',
        filters,
        entities,
        metric,
        confidence,
        deterministic: entities.length > 0,
        // SQL primary; company-scoped document fallback may run after SQL miss (feature-flagged).
        useRag: false,
        reason: 'Company metric lookup — SQL first, optional company document fallback',
      };

    case INTENTS.FOLLOW_UP: {
      // Always build a NEW plan. Reuse only omitted conversational context (never lastPlan/SQL/tool).
      const metricResolution = classification.metricResolution
        || filters?.metricResolution
        || METRIC_RESOLUTION.NONE;
      const reusedMetric = shouldReuseMemoryMetric(metricResolution)
        ? (metric || memory?.lastMetric || memory?.filters?.metric || null)
        : metric;
      const priorFilters = { ...(memory?.filters || {}) };
      if (!shouldReuseMemoryMetric(metricResolution)) {
        delete priorFilters.metric;
        delete priorFilters.metrics;
      }
      const resolvedEntities = chooseEntitiesByPrecedence({
        validatedCompanies: classification.filters?.validatedCompanies ?? null,
        candidates: entities,
        userMessage,
        memory,
      }).companies;
      const mergedFilters = {
        ...priorFilters,
        ...filters,
        followUp: true,
        metricResolution,
        ...(reusedMetric ? { metric: reusedMetric } : {}),
      };

      // Quantitative metric follow-up ("carbon emissions of the above companies") → SQL, never Narrative.
      // Only when the *current* message named a measurable metric (FOUND/DERIVED).
      // Causal "why are these high?" (metric NONE → reuse prior) stays hybrid.
      const forceSql = Boolean(
        reusedMetric
        && SQL_METRICS.has(reusedMetric)
        && (
          isExecutableMetricResolution(metricResolution)
          || classification?.filters?.answerType === 'QUANTITATIVE'
        )
        && metricResolution !== METRIC_RESOLUTION.UNSUPPORTED
        && !filters?.hybridWhy
        && !filters?.guidance
      );

      if (forceSql && resolvedEntities.length >= 2) {
        return {
          intent: INTENTS.COMPARE_COMPANIES,
          primaryTool: TOOLS.SQL,
          secondaryTools: [],
          strategy: 'sql_compare_companies',
          filters: {
            ...mergedFilters,
            answerType: 'QUANTITATIVE',
            followUpCompanies: true,
          },
          entities: resolvedEntities,
          metric: reusedMetric,
          metrics: filters?.metrics || (reusedMetric ? [reusedMetric] : []),
          confidence,
          deterministic: true,
          useRag: false,
          reason: 'Quantitative follow-up with prior companies — SQL compare (not narrative)',
        };
      }
      if (forceSql && resolvedEntities.length === 1) {
        return {
          intent: INTENTS.METRIC_LOOKUP,
          primaryTool: TOOLS.SQL,
          secondaryTools: [],
          strategy: 'sql_company_metric',
          filters: {
            ...mergedFilters,
            answerType: 'QUANTITATIVE',
            followUpCompanies: true,
          },
          entities: resolvedEntities,
          metric: reusedMetric,
          confidence,
          deterministic: true,
          useRag: false,
          reason: 'Quantitative follow-up — SQL company metric (not narrative)',
        };
      }

      return {
        intent,
        primaryTool: TOOLS.HYBRID,
        secondaryTools: [TOOLS.SQL, TOOLS.RAG],
        strategy: 'follow_up_from_memory',
        filters: mergedFilters,
        entities: resolvedEntities,
        metric: reusedMetric,
        confidence,
        deterministic: false,
        useRag: true,
        reason: 'New follow-up plan from current request + omitted context only (never reuse prior SQL/plan)',
      };
    }

    case INTENTS.GENERAL_ESG_QUESTION:
      return {
        intent,
        primaryTool: TOOLS.RAG,
        secondaryTools: [TOOLS.SQL],
        strategy: 'rag_with_schema_context',
        filters,
        entities,
        metric,
        confidence,
        deterministic: false,
        useRag: true,
        reason: 'Narrative ESG explanation — RAG/schema context; SQL if numbers asked',
      };

    default:
      return {
        intent: INTENTS.UNKNOWN,
        primaryTool: TOOLS.LLM_TOOLS,
        secondaryTools: [],
        strategy: 'llm_tool_loop',
        filters,
        entities,
        metric,
        confidence,
        deterministic: false,
        useRag: false,
        reason: 'Unclear intent — fall back to existing LLM tool loop',
      };
  }
}
