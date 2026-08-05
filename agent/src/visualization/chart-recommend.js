/**
 * Chart recommendation — choose intent + chart type from VisualizationContext + Dataset shape.
 *
 * User-specified chart types override recommendations.
 */

import { CHART_TYPES } from './chart-spec.js';
import { isSingleValueDataset } from './dataset.js';
import {
  inferVisualizationIntent,
  selectChartType,
  labelsLookLikeYears,
  isSupportedChartType,
} from './chart-select.js';

/**
 * @typedef {Object} ChartRecommendation
 * @property {boolean} showChart
 * @property {'trend'|'ranking'|'comparison'|'composition'|'correlation'|null} visualizationIntent
 * @property {string|null} chartType
 * @property {boolean} horizontal
 * @property {boolean} multiMetricGrouped
 * @property {string|null} reason
 * @property {string[]} candidates
 */

/**
 * Recommend whether to chart and which type.
 * @param {{ dataset: object, context?: object, labels?: string[], seriesCount?: number }} input
 * @returns {ChartRecommendation}
 */
export function recommendChart(input = {}) {
  const dataset = input.dataset || null;
  const context = input.context || {};
  const labels = input.labels
    || dataset?.labels
    || [];
  const seriesCount = input.seriesCount
    ?? dataset?.metrics?.length
    ?? 1;
  const pointCount = labels.length;
  const userMessage = context.userMessage || '';

  if (!dataset || !labels.length || !seriesCount) {
    return noChart('insufficient_data');
  }

  if (isSingleValueDataset(dataset)) {
    return noChart('single_value');
  }

  const visualizationIntent = inferVisualizationIntent({
    userMessage,
    intent: context.intent,
    labels,
    seriesCount,
    preferredIntent: context.preferredIntent || null,
  });

  // Explicit user preference overrides recommendation.
  const preference = normalizePreference(context.chartPreference, userMessage);
  if (preference === 'doughnut' || preference === 'pie') {
    return {
      showChart: true,
      visualizationIntent: preference === 'pie' || preference === 'doughnut'
        ? (visualizationIntent === 'composition' ? visualizationIntent : 'composition')
        : visualizationIntent,
      chartType: preference,
      horizontal: false,
      multiMetricGrouped: false,
      reason: 'user_preference',
      candidates: [preference],
    };
  }
  if (preference && isSupportedChartType(preference)) {
    return {
      showChart: true,
      visualizationIntent,
      chartType: preference,
      horizontal: preference === 'horizontalBar',
      multiMetricGrouped: preference === 'groupedBar' || seriesCount >= 2,
      reason: 'user_preference',
      candidates: [preference],
    };
  }

  const chartType = selectChartType({
    visualizationIntent,
    labels,
    seriesCount,
    userMessage,
    pointCount,
  });

  const candidates = buildCandidates(visualizationIntent, seriesCount, labels);

  return {
    showChart: true,
    visualizationIntent,
    chartType,
    horizontal: chartType === 'horizontalBar',
    multiMetricGrouped: chartType === 'groupedBar' || (visualizationIntent === 'comparison' && seriesCount >= 2),
    reason: 'recommended',
    candidates,
  };
}

function noChart(reason) {
  return {
    showChart: false,
    visualizationIntent: null,
    chartType: null,
    horizontal: false,
    multiMetricGrouped: false,
    reason,
    candidates: [],
  };
}

function normalizePreference(chartPreference, userMessage) {
  if (chartPreference) {
    const p = String(chartPreference);
    if (p === 'doughnut') return 'doughnut';
    if (isSupportedChartType(p) || p === 'doughnut') return p;
  }
  const text = String(userMessage || '').toLowerCase();
  if (/\bdoughnut\b/.test(text)) return 'doughnut';
  if (/\bscatter\b/.test(text)) return 'scatter';
  if (/\bpie\s*chart\b/.test(text)) return 'pie';
  if (/\bline\s*chart\b/.test(text)) return 'line';
  if (/\bhorizontal\s*bar\b/.test(text)) return 'horizontalBar';
  if (/\bgrouped\s*bar\b/.test(text)) return 'groupedBar';
  return null;
}

function buildCandidates(intent, seriesCount, labels) {
  switch (intent) {
    case 'trend':
      return ['line', 'bar'];
    case 'ranking':
      return labels.length >= 6 ? ['horizontalBar', 'bar'] : ['bar', 'horizontalBar'];
    case 'comparison':
      return seriesCount >= 2 ? ['groupedBar', 'bar'] : ['bar', 'groupedBar'];
    case 'composition':
      return ['pie', 'doughnut', 'groupedBar'];
    case 'correlation':
      return ['scatter'];
    default:
      return CHART_TYPES.slice();
  }
}

export { inferVisualizationIntent, selectChartType, labelsLookLikeYears, isSupportedChartType };
