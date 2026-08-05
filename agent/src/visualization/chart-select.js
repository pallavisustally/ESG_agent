/**
 * Automatic chart type selection from data shape + user / query intent.
 */

import { CHART_TYPES } from './chart-spec.js';

const YEAR_RE = /^(19|20)\d{2}$/;

/**
 * Infer visualization intent from query text, plan intent, and data shape.
 * @returns {'trend'|'ranking'|'comparison'|'composition'|'correlation'}
 */
export function inferVisualizationIntent({
  userMessage = '',
  intent = null,
  labels = [],
  seriesCount = 1,
  preferredIntent = null,
} = {}) {
  if (preferredIntent) return preferredIntent;

  const text = String(userMessage || '').toLowerCase();
  const planIntent = String(intent || '').toUpperCase();

  if (/\b(scatter|correlat|vs\.?|versus|against)\b/.test(text) && seriesCount >= 2) {
    return 'correlation';
  }
  if (/\b(share|composition|breakdown|mix|proportion|pie)\b/.test(text)) {
    return 'composition';
  }
  if (/\b(trend|over time|year.?over.?year|yoy|time series|historical)\b/.test(text)
    || planIntent === 'TREND_ANALYSIS'
    || planIntent.includes('TREND')) {
    return 'trend';
  }
  if (/\b(top|bottom|highest|lowest|rank|ranking|leaderboard)\b/.test(text)
    || planIntent === 'TOP_METRIC'
    || planIntent === 'BOTTOM_METRIC'
    || planIntent === 'CHART_REQUEST') {
    // CHART_REQUEST often maps to ranking; refine by labels below
    if (labelsLookLikeYears(labels) && seriesCount >= 1) return 'trend';
    return 'ranking';
  }
  if (/\b(compar|compare|versus|vs\.?)\b/.test(text)
    || planIntent === 'COMPARE_COMPANIES') {
    return 'comparison';
  }

  if (labelsLookLikeYears(labels)) return 'trend';
  if (seriesCount >= 2 && labels.length <= 8) return 'comparison';
  if (labels.length >= 3 && seriesCount === 1) return 'ranking';
  return 'comparison';
}

/**
 * Choose the best Chart.js-facing chart type.
 * @returns {'line'|'bar'|'horizontalBar'|'groupedBar'|'pie'|'scatter'}
 */
export function selectChartType({
  visualizationIntent,
  labels = [],
  seriesCount = 1,
  userMessage = '',
  pointCount = null,
} = {}) {
  const text = String(userMessage || '').toLowerCase();
  const n = pointCount ?? labels.length;

  // Explicit user overrides (still validated later).
  if (/\bscatter\b/.test(text) && seriesCount >= 2) return 'scatter';
  if (/\bpie\s*chart\b|\bdoughnut\b/.test(text)) return 'pie';
  if (/\bline\s*chart\b/.test(text)) return 'line';
  if (/\bhorizontal\s*bar\b/.test(text)) return 'horizontalBar';
  if (/\bgrouped\s*bar\b/.test(text)) return 'groupedBar';

  switch (visualizationIntent) {
    case 'trend':
      return n >= 2 ? 'line' : 'bar';
    case 'ranking':
      // Long category names / many ranks → horizontal bar.
      return n >= 6 || labels.some((l) => String(l).length > 18) ? 'horizontalBar' : 'bar';
    case 'comparison':
      return seriesCount >= 2 ? 'groupedBar' : 'bar';
    case 'composition':
      // Pie only when a single series shares a whole; otherwise grouped bar.
      return seriesCount === 1 && n >= 2 && n <= 8 ? 'pie' : 'groupedBar';
    case 'correlation':
      return seriesCount >= 2 ? 'scatter' : 'bar';
    default:
      return seriesCount >= 2 ? 'groupedBar' : 'bar';
  }
}

export function labelsLookLikeYears(labels) {
  if (!Array.isArray(labels) || labels.length < 2) return false;
  const yearish = labels.filter((l) => YEAR_RE.test(String(l).trim()));
  return yearish.length >= Math.ceil(labels.length * 0.7);
}

export function isSupportedChartType(type) {
  return CHART_TYPES.includes(type);
}
