/**
 * Visualization Engine — single entry point for all chart generation.
 *
 * Dataset + VisualizationContext
 *   → recommend → ChartSpec → validate → build → insights → (optional LLM)
 *   → structured response sections
 *
 * SQL / Report / PDF / markdown adapters must call this instead of building Chart.js JSON.
 */

import { createChartSpec, metricLabel, metricUnit } from './chart-spec.js';
import { createDataset, normalizeDataset } from './dataset.js';
import { createVisualizationContext } from './visualization-context.js';
import { recommendChart } from './chart-recommend.js';
import { labelsLookLikeYears } from './chart-select.js';
import { validateChartSpec } from './chart-validate.js';
import { buildChartConfig, toJsonChartBlock } from './chart-builder.js';
import { generateChartInsights, formatInsightMarkdown } from './chart-insights.js';
import { explainInsightsWithLlm } from './insight-explain.js';
import {
  composeChartResponse,
  userFacingOmitMessage,
} from './chart-response.js';
import {
  datasetFromLegacyConfig,
  datasetFromSqlRows,
} from './dataset-adapters.js';
import { chartSpecFromLegacyConfig } from './chart-spec.js';

/**
 * Synchronous Visualization Engine entry point.
 *
 * @param {Object} input
 * @param {object} [input.dataset]
 * @param {object} [input.context]
 * @param {Array<Object>} [input.rows] - legacy convenience (builds Dataset)
 * @param {boolean} [input.includeInsights=true]
 * @param {string} [input.summary] - optional prose summary for response sections
 * @returns {object} engine result
 */
export function visualize(input = {}) {
  const context = createVisualizationContext(input.context || input);
  const dataset = resolveDataset(input, context);

  if (!dataset.rows.length) {
    return failResult({
      reason: 'empty_rows',
      dataset,
      context,
      summary: input.summary,
    });
  }

  if (!dataset.metrics.length) {
    return failResult({
      reason: 'no_metrics',
      dataset,
      context,
      summary: input.summary,
    });
  }

  if (!dataset.labels.length) {
    return failResult({
      reason: 'empty_labels',
      dataset,
      context,
      summary: input.summary,
    });
  }

  const recommendation = recommendChart({ dataset, context });
  if (!recommendation.showChart) {
    return failResult({
      reason: recommendation.reason || 'no_chart',
      dataset,
      context,
      recommendation,
      summary: input.summary,
    });
  }

  const series = buildSeries(dataset, context);
  if (!series.length) {
    return failResult({ reason: 'all_null', dataset, context, recommendation, summary: input.summary });
  }

  const chartType = recommendation.chartType || 'bar';
  const visualizationIntent = recommendation.visualizationIntent || 'comparison';

  const reportingYear = context.year ?? dataset.year ?? null;
  const sourceLabel = humanSource(context.source || dataset.source);

  const autoTitle = context.title || buildTitle({
    visualizationIntent,
    metrics: dataset.metrics,
    year: reportingYear,
    order: context.order,
    labels: dataset.labels,
    company: context.company || dataset.company,
    metricLabels: dataset.metadata?.metricLabels,
  });

  const autoSubtitle = context.subtitle || buildSubtitle({
    visualizationIntent,
    metrics: dataset.metrics,
    seriesCount: series.length,
    labelCount: dataset.labels.length,
    metricLabels: dataset.metadata?.metricLabels,
  });

  const sharedUnit = context.units || sharedSeriesUnit(series);

  const spec = createChartSpec({
    intent: visualizationIntent,
    chartType,
    labels: dataset.labels,
    series,
    meta: {
      title: autoTitle,
      subtitle: autoSubtitle,
      xAxisLabel: labelsLookLikeYears(dataset.labels)
        ? 'Year'
        : (dataset.labelKey === 'company' ? 'Company' : dataset.labelKey),
      yAxisLabel: sharedUnit || (series.length === 1 ? series[0].label : null),
      unit: sharedUnit,
      showLegend: series.length > 1 || chartType === 'pie' || chartType === 'doughnut',
      source: sourceLabel,
      reportingYear,
    },
    context: {
      planIntent: context.intent,
      metrics: dataset.metrics,
      labelKey: dataset.labelKey,
      sourceKind: dataset.source,
      recommendation: recommendation.reason,
    },
  });

  const validation = validateChartSpec(spec);
  if (!validation.ok) {
    return failResult({
      reason: 'validation_failed',
      dataset,
      context,
      recommendation,
      validation,
      spec,
      summary: input.summary,
    });
  }

  const config = buildChartConfig(spec);
  const includeInsights = input.includeInsights !== false && context.includeInsights !== false;
  const insights = includeInsights ? generateChartInsights(spec) : [];
  const insightMarkdown = includeInsights ? formatInsightMarkdown(insights) : '';
  const chartBlock = toJsonChartBlock(config);

  const sections = composeChartResponse({
    summary: input.summary || '',
    ok: true,
    chartBlock,
    insights,
    insightMarkdown,
    sources: sourceLabel && sourceLabel !== 'unknown'
      ? `_Source: ${sourceLabel}_`
      : '',
  });

  return {
    ok: true,
    dataset,
    context,
    recommendation,
    spec,
    config,
    chartBlock,
    insights,
    insightMarkdown,
    observations: '',
    validation,
    sections,
    omitMessage: null,
    reason: null,
  };
}

/**
 * Async entry: visualize + optional grounded LLM observations.
 */
export async function visualizeAsync(input = {}) {
  const result = visualize(input);
  if (!result.ok || !input.chatFn || !(input.includeLlmExplanation || input.context?.includeLlmExplanation)) {
    return result;
  }

  const observations = await explainInsightsWithLlm({
    spec: result.spec,
    insights: result.insights,
    userMessage: result.context?.userMessage || input.userMessage || '',
    chatFn: input.chatFn,
  });

  if (!observations) return result;

  const sections = composeChartResponse({
    summary: input.summary || result.sections?.summary || '',
    ok: true,
    chartBlock: result.chartBlock,
    insights: result.insights,
    insightMarkdown: result.insightMarkdown,
    observations,
    sources: result.sections?.sources || '',
  });

  return {
    ...result,
    observations,
    sections,
  };
}

/**
 * Legacy row-array entry used by older planner wrappers.
 */
export function visualizeFromRows(input = {}) {
  const dataset = datasetFromSqlRows({
    rows: input.rows || [],
    metrics: input.metrics || [],
    labelKey: input.labelKey || 'company',
    year: input.year ?? null,
    company: input.company ?? null,
    aggregation: input.aggregation ?? null,
    grouping: input.grouping ?? input.labelKey ?? null,
    source: mapSourceKind(input.source),
    metadata: input.metadata || {},
  });
  const context = createVisualizationContext({
    ...input,
    dataset,
    source: input.source || 'BRSR structured reports',
  });
  return visualize({
    dataset,
    context,
    includeInsights: input.includeInsights,
    summary: input.summary,
  });
}

/**
 * Legacy Chart.js / table-repair config entry.
 */
export function visualizeFromLegacyConfig(raw, opts = {}) {
  const dataset = datasetFromLegacyConfig(raw);
  const context = createVisualizationContext({
    userMessage: opts.userMessage || '',
    preferredIntent: raw?.intent || null,
    chartPreference: opts.lockChartType
      ? (raw?.chartType || (raw?.type && raw.type !== 'chart' ? raw.type : null))
      : null,
    title: raw?.title || dataset.metadata?.title || null,
    year: raw?.reportingYear ?? null,
    source: raw?.source || 'BRSR structured reports',
    includeInsights: opts.includeInsights !== false,
  });

  // If adapter produced an empty dataset, fall back to ChartSpec lift for compatibility.
  if (!dataset.metrics.length || !dataset.labels.length) {
    const spec = chartSpecFromLegacyConfig(raw);
    if (!spec) return failResult({ reason: 'empty_config', context });
    return visualizeFromSpec(spec, context, opts);
  }

  // Prefer display labels from legacy datasets
  if (dataset.metadata?.metricLabels) {
    for (const [id, label] of Object.entries(dataset.metadata.metricLabels)) {
      dataset.metadata.metricLabels[id] = label;
    }
  }

  return visualize({
    dataset,
    context,
    includeInsights: opts.includeInsights,
  });
}

function visualizeFromSpec(spec, context, opts = {}) {
  const recommendation = recommendChart({
    dataset: {
      labels: spec.labels,
      metrics: spec.series.map((s) => s.id),
      values: Object.fromEntries(spec.series.map((s) => [s.id, s.values])),
      rows: spec.labels.map(() => ({})),
    },
    context,
    labels: spec.labels,
    seriesCount: spec.series.length,
  });

  if (!context.chartPreference && recommendation.chartType) {
    spec.intent = recommendation.visualizationIntent || spec.intent;
    if (!opts.lockChartType) {
      spec.chartType = recommendation.chartType === 'doughnut' ? 'pie' : recommendation.chartType;
    }
  }

  const validation = validateChartSpec(spec);
  if (!validation.ok) {
    return failResult({
      reason: 'validation_failed',
      context,
      recommendation,
      validation,
      spec,
    });
  }

  const config = buildChartConfig(spec);
  const includeInsights = opts.includeInsights !== false;
  const insights = includeInsights ? generateChartInsights(spec) : [];
  return {
    ok: true,
    context,
    recommendation,
    spec,
    config,
    chartBlock: toJsonChartBlock(config),
    insights,
    insightMarkdown: includeInsights ? formatInsightMarkdown(insights) : '',
    observations: '',
    validation,
    sections: composeChartResponse({
      ok: true,
      chartBlock: toJsonChartBlock(config),
      insights,
      insightMarkdown: includeInsights ? formatInsightMarkdown(insights) : '',
    }),
    omitMessage: null,
    reason: null,
  };
}

function resolveDataset(input, context) {
  if (input.dataset) return normalizeDataset(input.dataset);
  if (Array.isArray(input.rows)) {
    return datasetFromSqlRows({
      rows: input.rows,
      metrics: input.metrics || context.metrics || [],
      labelKey: input.labelKey || context.grouping || 'company',
      year: context.year,
      company: context.company,
      aggregation: context.aggregation,
      grouping: context.grouping,
      source: mapSourceKind(context.source),
    });
  }
  return createDataset({ rows: [], metrics: [], source: 'unknown' });
}

function buildSeries(dataset, context) {
  return dataset.metrics.map((metricId) => {
    const display = dataset.metadata?.metricLabels?.[metricId]
      || metricLabel(metricId);
    const values = (dataset.values?.[metricId] || []).map((v) => (
      v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null)
    ));
    // Align to labels length
    while (values.length < dataset.labels.length) values.push(null);
    return {
      id: metricId,
      label: display,
      values: values.slice(0, dataset.labels.length),
      unit: dataset.units?.[metricId] || metricUnit(metricId),
    };
  }).filter((s) => s.values.some((v) => v != null));
}

function failResult({
  reason,
  dataset = null,
  context = null,
  recommendation = null,
  validation = null,
  spec = null,
  summary = '',
}) {
  const omitMessage = userFacingOmitMessage(reason);
  const sections = composeChartResponse({
    summary,
    ok: false,
    omitReason: reason,
    omitMessage,
  });
  return {
    ok: false,
    reason,
    omitMessage,
    dataset,
    context,
    recommendation,
    validation,
    spec,
    chartBlock: null,
    config: null,
    insights: [],
    insightMarkdown: '',
    observations: '',
    sections,
  };
}

function sharedSeriesUnit(series) {
  const units = [...new Set(series.map((s) => s.unit).filter(Boolean))];
  return units.length === 1 ? units[0] : null;
}

function humanSource(source) {
  const s = String(source || '');
  if (!s || s === 'unknown') return 'BRSR structured reports';
  if (s === 'sql') return 'BRSR structured reports';
  if (s === 'report') return 'BRSR report extract';
  if (s === 'pdf') return 'BRSR report / PDF extract';
  if (s === 'markdown') return 'Report table';
  if (s === 'legacy') return 'BRSR structured reports';
  return s;
}

function mapSourceKind(source) {
  const s = String(source || '').toLowerCase();
  if (s.includes('pdf')) return 'pdf';
  if (s.includes('report') && s.includes('extract')) return 'report';
  if (s.includes('markdown')) return 'markdown';
  if (s.includes('sql') || s.includes('structured')) return 'sql';
  return s || 'sql';
}

function buildTitle({
  visualizationIntent,
  metrics,
  year,
  order,
  labels,
  company,
  metricLabels,
}) {
  const metricPart = metrics.map((m) => metricLabels?.[m] || metricLabel(m)).join(' & ');
  const yearPart = year ? ` (${year})` : '';
  if (company && visualizationIntent === 'trend') {
    return `${metricPart} — ${company}`;
  }
  switch (visualizationIntent) {
    case 'ranking':
      return `${order === 'ASC' ? 'Lowest' : 'Highest'} ${metricPart}${yearPart}`;
    case 'trend':
      return `${metricPart} trend${yearPart}`;
    case 'composition':
      return `${metricPart} composition${yearPart}`;
    case 'correlation':
      return `${metricPart} correlation`;
    case 'comparison':
    default:
      if (labelsLookLikeYears(labels)) return `${metricPart} over time`;
      return `${metricPart}${yearPart}`;
  }
}

function buildSubtitle({
  visualizationIntent,
  metrics,
  seriesCount,
  labelCount,
  metricLabels,
}) {
  if (seriesCount >= 2) {
    return `${seriesCount} metrics across ${labelCount} categories`;
  }
  if (visualizationIntent === 'ranking') {
    const m = metricLabels?.[metrics[0]] || metricLabel(metrics[0]);
    return `Top ${labelCount} by ${m}`;
  }
  if (visualizationIntent === 'trend') {
    return `${labelCount} reporting periods`;
  }
  return null;
}
