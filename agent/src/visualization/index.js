/**
 * Visualization Engine public API.
 *
 * Canonical flow:
 *   Dataset adapter → VisualizationContext → visualize() → ChartSpec → Builder → Insights
 *
 * Legacy planner wrappers remain for backward compatibility.
 */

export {
  createChartSpec,
  chartSpecFromLegacyConfig,
  METRIC_DISPLAY,
  metricLabel,
  metricUnit,
  VISUALIZATION_INTENTS,
  CHART_TYPES,
} from './chart-spec.js';

export {
  createDataset,
  normalizeDataset,
  isSingleValueDataset,
  countNumericPoints,
} from './dataset.js';

export {
  datasetFromRankingRows,
  datasetFromCompareRows,
  datasetFromSectorRows,
  datasetFromTrendRows,
  datasetFromSqlRows,
  datasetFromReportTable,
  datasetFromPdfExtract,
  datasetFromMarkdownTable,
  datasetFromLegacyConfig,
} from './dataset-adapters.js';

export { createVisualizationContext } from './visualization-context.js';

export {
  recommendChart,
  inferVisualizationIntent,
  selectChartType,
  labelsLookLikeYears,
  isSupportedChartType,
} from './chart-recommend.js';

export { validateChartSpec } from './chart-validate.js';

export {
  buildChartConfig,
  toJsonChartBlock,
  mapChartTypeForRenderer,
} from './chart-builder.js';

export {
  generateChartInsights,
  formatInsightMarkdown,
  computeSeriesStatistics,
} from './chart-insights.js';

export {
  buildInsightExplanationPrompt,
  formatObservationMarkdown,
  explainInsightsWithLlm,
} from './insight-explain.js';

export {
  composeChartResponse,
  appendVisualizationToText,
  dedupeChartBlocks,
  userFacingOmitMessage,
} from './chart-response.js';

export {
  visualize,
  visualizeAsync,
  visualizeFromRows,
  visualizeFromLegacyConfig,
} from './visualization-engine.js';

export {
  planVisualization,
  planFromLegacyConfig,
  planRankingChart,
  planCompareChart,
  planTrendChart,
  planReportChart,
  planFromRows,
} from './visualization-planner.js';

export { normalizeChartJson, liftLegacyShape } from './chart-normalize.js';
