/**
 * Shared ChartSpec model — single visualization contract for SQL, reports, PDFs, APIs.
 *
 * Downstream Chart Builder converts ChartSpec → renderable json-chart config
 * consumed by the existing Chart.js renderer (unchanged contract).
 */

/** @typedef {'trend'|'ranking'|'comparison'|'composition'|'correlation'} VisualizationIntent */
/** @typedef {'line'|'bar'|'horizontalBar'|'groupedBar'|'pie'|'doughnut'|'scatter'} ChartType */

/**
 * @typedef {Object} ChartSeries
 * @property {string} id
 * @property {string} label
 * @property {(number|null)[]} values
 * @property {string} [unit]
 */

/**
 * @typedef {Object} ChartMetadata
 * @property {string} title
 * @property {string} [subtitle]
 * @property {string} [xAxisLabel]
 * @property {string} [yAxisLabel]
 * @property {string} [unit]
 * @property {boolean} [showLegend]
 * @property {string} [source]
 * @property {string|number|null} [reportingYear]
 */

/**
 * @typedef {Object} ChartSpec
 * @property {'chart'} type
 * @property {VisualizationIntent} intent
 * @property {ChartType} chartType
 * @property {string[]} labels
 * @property {ChartSeries[]} series
 * @property {ChartMetadata} meta
 * @property {Object} [context]
 */

export const VISUALIZATION_INTENTS = Object.freeze([
  'trend',
  'ranking',
  'comparison',
  'composition',
  'correlation',
]);

export const CHART_TYPES = Object.freeze([
  'line',
  'bar',
  'horizontalBar',
  'groupedBar',
  'pie',
  'doughnut',
  'scatter',
]);

/** Metric id → display label / default unit hints used by planners. */
export const METRIC_DISPLAY = Object.freeze({
  scope1_emissions: { label: 'Scope 1 emissions', unit: 'tCO2e' },
  scope2_emissions: { label: 'Scope 2 emissions', unit: 'tCO2e' },
  scope3_emissions: { label: 'Scope 3 emissions', unit: 'tCO2e' },
  total_emissions: { label: 'Total GHG (Scope 1+2+3)', unit: 'tCO2e' },
  emissions_intensity: { label: 'Emissions intensity', unit: 'tCO2e / unit' },
  renewable_energy_share: { label: 'Renewable energy share', unit: '%' },
  energy_consumption: { label: 'Energy consumption', unit: 'GJ' },
  energy_intensity: { label: 'Energy intensity', unit: 'GJ / unit' },
  water_consumption: { label: 'Water consumption', unit: 'KL' },
  water_intensity: { label: 'Water intensity', unit: 'KL / unit' },
  waste_generated: { label: 'Waste generated', unit: 'tonnes' },
  waste_intensity: { label: 'Waste intensity', unit: 'tonnes / unit' },
  female_employee_count: { label: 'Female employee count', unit: 'count' },
  female_employee_share: { label: 'Female employee share', unit: '%' },
  female_board_count: { label: 'Female board count', unit: 'count' },
  female_board_share: { label: 'Female board share', unit: '%' },
  male_employee_count: { label: 'Male employee count', unit: 'count' },
  male_employee_share: { label: 'Male employee share', unit: '%' },
  male_board_count: { label: 'Male board count', unit: 'count' },
  male_board_share: { label: 'Male board share', unit: '%' },
  total_employee_count: { label: 'Total employee count', unit: 'count' },
  total_revenue: { label: 'Total revenue', unit: 'INR' },
  safety_ltifr: { label: 'Safety LTIFR', unit: 'LTIFR' },
});

export function metricLabel(metricId) {
  return METRIC_DISPLAY[metricId]?.label || String(metricId || 'Value').replace(/_/g, ' ');
}

export function metricUnit(metricId) {
  return METRIC_DISPLAY[metricId]?.unit || null;
}

/**
 * Create a ChartSpec from structured inputs.
 * @param {Partial<ChartSpec> & { labels: string[], series: ChartSeries[] }} input
 * @returns {ChartSpec}
 */
export function createChartSpec(input = {}) {
  const series = Array.isArray(input.series)
    ? input.series.map((s, i) => ({
      id: s.id || `series_${i}`,
      label: s.label || `Series ${i + 1}`,
      values: Array.isArray(s.values) ? s.values.map(toNullableNumber) : [],
      unit: s.unit || null,
    }))
    : [];

  const meta = {
    title: input.meta?.title || input.title || 'Chart',
    subtitle: input.meta?.subtitle || null,
    xAxisLabel: input.meta?.xAxisLabel || null,
    yAxisLabel: input.meta?.yAxisLabel || null,
    unit: input.meta?.unit || inferSharedUnit(series),
    showLegend: input.meta?.showLegend ?? series.length > 1,
    source: input.meta?.source || 'BRSR structured reports',
    reportingYear: input.meta?.reportingYear ?? null,
  };

  return {
    type: 'chart',
    intent: VISUALIZATION_INTENTS.includes(input.intent) ? input.intent : 'comparison',
    chartType: CHART_TYPES.includes(input.chartType) ? input.chartType : 'bar',
    labels: Array.isArray(input.labels) ? input.labels.map((l) => String(l ?? '')) : [],
    series,
    meta,
    context: input.context && typeof input.context === 'object' ? { ...input.context } : {},
  };
}

function toNullableNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function inferSharedUnit(series) {
  const units = [...new Set(series.map((s) => s.unit).filter(Boolean))];
  return units.length === 1 ? units[0] : null;
}

/**
 * Convert a legacy / nested chart JSON object into ChartSpec (best-effort).
 */
export function chartSpecFromLegacyConfig(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const nested = raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : null;
  const labels = Array.isArray(raw.labels)
    ? raw.labels
    : (Array.isArray(nested?.labels) ? nested.labels : []);
  let datasets = Array.isArray(raw.datasets)
    ? raw.datasets
    : (Array.isArray(nested?.datasets) ? nested.datasets : null);
  if (!datasets && Array.isArray(raw.series)) datasets = raw.series;
  if (!datasets && Array.isArray(nested?.series)) datasets = nested.series;
  if (!datasets && Array.isArray(raw.values)) {
    datasets = [{ label: raw.title || 'Value', data: raw.values }];
  }
  if (!datasets && Array.isArray(raw.data)) {
    datasets = [{ label: raw.title || 'Value', data: raw.data }];
  }
  if (!Array.isArray(datasets) || !datasets.length) return null;

  const chartTypeRaw = raw.chartType
    || (raw.type && raw.type !== 'chart' ? raw.type : null)
    || 'bar';

  return createChartSpec({
    intent: raw.intent || 'comparison',
    chartType: chartTypeRaw,
    labels,
    series: datasets.map((d, i) => ({
      id: d.id || `series_${i}`,
      label: d.label || d.name || `Series ${i + 1}`,
      values: Array.isArray(d.data) ? d.data : [],
      unit: d.unit || raw.unit || null,
    })),
    meta: {
      title: raw.title || raw.meta?.title || 'Chart',
      subtitle: raw.subtitle || raw.meta?.subtitle || null,
      xAxisLabel: raw.xAxisLabel || raw.meta?.xAxisLabel || null,
      yAxisLabel: raw.yAxisLabel || raw.meta?.yAxisLabel || null,
      unit: raw.unit || raw.meta?.unit || null,
      showLegend: raw.showLegend ?? raw.meta?.showLegend,
      source: raw.source || raw.meta?.source || null,
      reportingYear: raw.reportingYear ?? raw.meta?.reportingYear ?? null,
    },
    context: raw.context || {},
  });
}
