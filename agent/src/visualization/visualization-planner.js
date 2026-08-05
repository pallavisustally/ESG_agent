/**
 * Visualization Planner — backward-compatible façades over the Visualization Engine.
 *
 * Prefer `visualize({ dataset, context })` for new call sites.
 * These wrappers keep existing SQL / media repair imports working.
 */

import { metricLabel } from './chart-spec.js';
import { createVisualizationContext } from './visualization-context.js';
import {
  datasetFromRankingRows,
  datasetFromCompareRows,
  datasetFromTrendRows,
  datasetFromReportTable,
  datasetFromPdfExtract,
  datasetFromSqlRows,
} from './dataset-adapters.js';
import {
  visualize,
  visualizeFromRows,
  visualizeFromLegacyConfig,
} from './visualization-engine.js';

/**
 * Plan a visualization from structured tabular data.
 * @deprecated Prefer visualize({ dataset, context })
 */
export function planVisualization(input = {}) {
  const dataset = datasetFromSqlRows({
    rows: input.rows || [],
    metrics: input.metrics || [],
    labelKey: input.labelKey || 'company',
    year: input.year ?? null,
    company: input.company ?? null,
    aggregation: input.aggregation ?? null,
    grouping: input.grouping || input.labelKey || null,
    source: guessSourceKind(input.source),
    metadata: {
      title: input.title || null,
    },
  });

  const context = createVisualizationContext({
    intent: input.intent,
    preferredIntent: input.preferredIntent,
    metrics: input.metrics || dataset.metrics,
    year: input.year ?? dataset.year,
    company: input.company ?? dataset.company,
    userMessage: input.userMessage || '',
    title: input.title || null,
    subtitle: input.subtitle || null,
    source: input.source || 'BRSR structured reports',
    chartPreference: input.preferredChartType || null,
    order: input.order || 'DESC',
    aggregation: input.aggregation,
    grouping: input.labelKey || input.grouping,
    includeInsights: input.includeInsights !== false,
    dataset,
  });

  return visualize({
    dataset,
    context,
    includeInsights: input.includeInsights,
    summary: input.summary,
  });
}

/**
 * Plan from an already-built legacy chart config (e.g. markdown table repair).
 */
export function planFromLegacyConfig(raw, opts = {}) {
  return visualizeFromLegacyConfig(raw, opts);
}

/**
 * Convenience for ranking SQL results (`metric_value` column).
 */
export function planRankingChart({
  rows,
  metric,
  year = null,
  order = 'DESC',
  userMessage = '',
  includeInsights = true,
}) {
  const dataset = datasetFromRankingRows({ rows, metric, year, source: 'sql' });
  const context = createVisualizationContext({
    intent: order === 'ASC' ? 'BOTTOM_METRIC' : 'TOP_METRIC',
    preferredIntent: 'ranking',
    metrics: metric ? [metric] : [],
    year,
    order,
    userMessage,
    source: 'BRSR structured reports',
    includeInsights,
    ranking: true,
    dataset,
  });
  return visualize({ dataset, context, includeInsights });
}

/**
 * Convenience for multi-company / multi-metric comparison.
 */
export function planCompareChart({
  rows,
  metrics,
  year = null,
  userMessage = '',
  includeInsights = true,
}) {
  const dataset = datasetFromCompareRows({ rows, metrics, year, source: 'sql' });
  const context = createVisualizationContext({
    intent: 'COMPARE_COMPANIES',
    preferredIntent: 'comparison',
    metrics,
    year,
    userMessage,
    source: 'BRSR structured reports',
    includeInsights,
    comparison: true,
    dataset,
  });
  return visualize({ dataset, context, includeInsights });
}

/**
 * Plan a trend chart where labels are years (one company, multi-year rows).
 */
export function planTrendChart({
  rows,
  metrics,
  company = null,
  userMessage = '',
  includeInsights = true,
}) {
  const dataset = datasetFromTrendRows({ rows, metrics, company, source: 'sql' });
  const context = createVisualizationContext({
    intent: 'TREND_ANALYSIS',
    preferredIntent: 'trend',
    metrics,
    company,
    userMessage,
    title: company
      ? `${(metrics || []).map(metricLabel).join(' & ')} — ${company}`
      : null,
    source: 'BRSR structured reports',
    includeInsights,
    trend: true,
    dataset,
  });
  return visualize({ dataset, context, includeInsights });
}

/**
 * Plan a chart from report / PDF-extracted tabular rows (same ChartSpec contract).
 */
export function planReportChart({
  rows,
  metrics,
  labelKey = 'year',
  company = null,
  year = null,
  source = 'BRSR report / PDF extract',
  userMessage = '',
  preferredIntent = null,
  includeInsights = true,
  fromPdf = false,
}) {
  const dataset = fromPdf
    ? datasetFromPdfExtract({ rows, metrics, labelKey, company, year })
    : datasetFromReportTable({ rows, metrics, labelKey, company, year, source: 'report' });

  const context = createVisualizationContext({
    intent: preferredIntent === 'trend' ? 'TREND_ANALYSIS' : 'REPORT_CHART',
    preferredIntent,
    metrics,
    company,
    year,
    userMessage,
    title: company
      ? `${(metrics || []).map(metricLabel).join(' & ')} — ${company}`
      : null,
    source,
    includeInsights,
    dataset,
  });
  return visualize({ dataset, context, includeInsights });
}

/** @deprecated Use visualizeFromRows */
export function planFromRows(input) {
  return visualizeFromRows(input);
}

function guessSourceKind(source) {
  const s = String(source || '').toLowerCase();
  if (s.includes('pdf')) return 'pdf';
  if (s.includes('report')) return 'report';
  if (s.includes('markdown')) return 'markdown';
  return 'sql';
}
