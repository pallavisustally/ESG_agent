/**
 * Chart Builder — ChartSpec → renderable json-chart config for the existing Chart.js UI.
 *
 * Output shape matches what app.js normalizeChartConfig / drawChart already accept:
 * { type, chartType, title, labels, datasets, ...metadata }
 */

/**
 * Build a renderer-compatible chart config from a validated ChartSpec.
 * @param {import('./chart-spec.js').ChartSpec} spec
 * @returns {object}
 */
export function buildChartConfig(spec) {
  const chartType = mapChartTypeForRenderer(spec.chartType);
  const datasets = (spec.series || []).map((s) => ({
    label: s.label,
    data: (s.values || []).map((v) => (v == null ? null : Number(v))),
    unit: s.unit || undefined,
  }));

  const config = {
    type: 'chart',
    chartType,
    title: spec.meta?.title || 'Chart',
    labels: [...(spec.labels || [])],
    datasets,
    // Metadata for UI / future consumers (renderer may ignore unknown fields)
    subtitle: spec.meta?.subtitle || undefined,
    xAxisLabel: spec.meta?.xAxisLabel || undefined,
    yAxisLabel: resolveYAxisLabel(spec),
    unit: spec.meta?.unit || undefined,
    source: spec.meta?.source || undefined,
    reportingYear: spec.meta?.reportingYear ?? undefined,
    showLegend: spec.meta?.showLegend,
    intent: spec.intent,
    indexAxis: spec.chartType === 'horizontalBar' ? 'y' : undefined,
  };

  // Scatter: first two series → {x,y} points
  if (spec.chartType === 'scatter' && datasets.length >= 2) {
    const xs = datasets[0].data;
    const ys = datasets[1].data;
    const points = [];
    const n = Math.min(xs.length, ys.length);
    for (let i = 0; i < n; i += 1) {
      if (xs[i] == null || ys[i] == null) continue;
      points.push({ x: Number(xs[i]), y: Number(ys[i]) });
    }
    config.labels = [];
    config.datasets = [{
      label: `${datasets[0].label} vs ${datasets[1].label}`,
      data: points,
    }];
    config.xAxisLabel = config.xAxisLabel || datasets[0].label;
    config.yAxisLabel = config.yAxisLabel || datasets[1].label;
  }

  // Drop undefined keys for cleaner markdown JSON
  return stripUndefined(config);
}

/**
 * Map planner chart types onto Chart.js types.
 * groupedBar → bar (multi-dataset); horizontalBar → bar + indexAxis.
 */
export function mapChartTypeForRenderer(chartType) {
  if (chartType === 'groupedBar' || chartType === 'horizontalBar') return 'bar';
  if (chartType === 'scatter') return 'scatter';
  if (chartType === 'pie') return 'pie';
  if (chartType === 'doughnut') return 'doughnut';
  if (chartType === 'line') return 'line';
  return 'bar';
}

export function toJsonChartBlock(config) {
  return ['```json-chart', JSON.stringify(config, null, 2), '```'].join('\n');
}

function resolveYAxisLabel(spec) {
  if (spec.meta?.yAxisLabel) return spec.meta.yAxisLabel;
  if (spec.meta?.unit) return spec.meta.unit;
  const units = [...new Set((spec.series || []).map((s) => s.unit).filter(Boolean))];
  if (units.length === 1) return units[0];
  return null;
}

function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
