/**
 * Dataset adapters — convert source-specific payloads into the shared Dataset model.
 */

import { createDataset } from './dataset.js';

/**
 * Ranking / top-N SQL rows (`company`, `metric_value`, `year`, `sector`).
 */
export function datasetFromRankingRows({
  rows = [],
  metric,
  year = null,
  source = 'sql',
} = {}) {
  if (!metric) {
    return createDataset({ rows: [], metrics: [], source, year });
  }
  const shaped = (rows || []).map((r) => ({
    company: r.company,
    year: r.year,
    sector: r.sector,
    industry: r.industry,
    [metric]: r.metric_value ?? r[metric],
  }));
  return createDataset({
    rows: shaped,
    metrics: [metric],
    labelKey: 'company',
    grouping: 'company',
    year,
    source,
    metadata: { kind: 'ranking', metric },
  });
}

/**
 * Multi-company / multi-metric comparison rows.
 */
export function datasetFromCompareRows({
  rows = [],
  metrics = [],
  year = null,
  source = 'sql',
} = {}) {
  return createDataset({
    rows,
    metrics,
    labelKey: 'company',
    grouping: 'company',
    year,
    source,
    metadata: { kind: 'comparison', metrics },
  });
}

/**
 * Sector / industry aggregate ranking rows.
 */
export function datasetFromSectorRows({
  rows = [],
  metric,
  year = null,
  groupBy = 'sector',
  aggregation = null,
  source = 'sql',
} = {}) {
  const groupKey = groupBy === 'industry' ? 'industry' : 'sector';
  const shaped = (rows || []).map((r) => ({
    [groupKey]: r.group_label || r.sector || r.industry,
    year: r.year ?? year,
    [metric]: r.metric_value ?? r[metric],
  }));
  return createDataset({
    rows: shaped,
    metrics: metric ? [metric] : [],
    labelKey: groupKey,
    grouping: groupKey,
    year,
    aggregation,
    source,
    metadata: { kind: 'sector_aggregate', metric, groupBy: groupKey, aggregation },
  });
}

/**
 * Trend rows keyed by year (one company, multi-year).
 */
export function datasetFromTrendRows({
  rows = [],
  metrics = [],
  company = null,
  source = 'sql',
} = {}) {
  return createDataset({
    rows,
    metrics,
    labelKey: 'year',
    grouping: 'year',
    company,
    source,
    metadata: { kind: 'trend', metrics, company },
  });
}

/**
 * Generic SQL-ish row array → Dataset.
 */
export function datasetFromSqlRows({
  rows = [],
  metrics = [],
  labelKey = 'company',
  year = null,
  company = null,
  aggregation = null,
  grouping = null,
  source = 'sql',
  metadata = {},
} = {}) {
  return createDataset({
    rows,
    metrics,
    labelKey,
    year,
    company,
    aggregation,
    grouping: grouping || labelKey,
    source,
    metadata: { kind: 'sql', ...metadata },
  });
}

/**
 * Report-extracted numeric table rows.
 */
export function datasetFromReportTable({
  rows = [],
  metrics = [],
  labelKey = 'year',
  company = null,
  year = null,
  source = 'report',
} = {}) {
  return createDataset({
    rows,
    metrics,
    labelKey,
    company,
    year,
    grouping: labelKey,
    source,
    metadata: { kind: 'report', company },
  });
}

/**
 * PDF-extracted numeric table rows (same shape as report).
 */
export function datasetFromPdfExtract({
  rows = [],
  metrics = [],
  labelKey = 'year',
  company = null,
  year = null,
  source = 'pdf',
} = {}) {
  return createDataset({
    rows,
    metrics,
    labelKey,
    company,
    year,
    grouping: labelKey,
    source,
    metadata: { kind: 'pdf', company },
  });
}

/**
 * Markdown table → Dataset (year/company × metrics).
 * @param {{ headers: string[], rows: string[][] }} table
 */
export function datasetFromMarkdownTable(table, {
  title = null,
  source = 'markdown',
} = {}) {
  if (!table?.headers?.length || !table?.rows?.length) {
    return createDataset({ rows: [], metrics: [], source });
  }

  const headers = table.headers;
  const yearIdx = headers.findIndex((h) => /\byear\b/i.test(h));
  const labelIdx = yearIdx >= 0 ? yearIdx : 0;

  const metricIndexes = [];
  for (let i = 0; i < headers.length; i += 1) {
    if (i === labelIdx) continue;
    const nums = table.rows.map((r) => parseNumberCell(r[i])).filter((n) => n != null);
    if (nums.length) metricIndexes.push(i);
  }
  if (!metricIndexes.length) {
    return createDataset({ rows: [], metrics: [], source });
  }

  const metrics = metricIndexes.map((idx) => slugMetric(headers[idx]));
  const rows = table.rows.map((r) => {
    const obj = {
      [yearIdx >= 0 ? 'year' : 'label']: String(r[labelIdx] || '').trim(),
    };
    if (yearIdx < 0) obj.label = String(r[labelIdx] || '').trim();
    metricIndexes.forEach((idx, i) => {
      obj[metrics[i]] = parseNumberCell(r[idx]);
    });
    return obj;
  }).filter((r) => String(r.year || r.label || '').trim());

  const labelKey = yearIdx >= 0 ? 'year' : 'label';
  return createDataset({
    rows,
    metrics,
    labelKey,
    grouping: labelKey,
    source,
    metadata: {
      kind: 'markdown_table',
      title,
      headerLabels: Object.fromEntries(metricIndexes.map((idx, i) => [metrics[i], headers[idx]])),
    },
  });
}

/**
 * Legacy / nested Chart.js-ish config → Dataset (for repair path).
 */
export function datasetFromLegacyConfig(raw) {
  if (!raw || typeof raw !== 'object') {
    return createDataset({ rows: [], metrics: [], source: 'legacy' });
  }
  const nested = raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : null;
  const labels = Array.isArray(raw.labels)
    ? raw.labels
    : (Array.isArray(nested?.labels) ? nested.labels : []);
  let datasets = Array.isArray(raw.datasets)
    ? raw.datasets
    : (Array.isArray(nested?.datasets) ? nested.datasets : null);
  if (!datasets && Array.isArray(raw.series)) datasets = raw.series;
  if (!datasets && Array.isArray(raw.values)) {
    datasets = [{ label: raw.title || 'Value', data: raw.values }];
  }
  if (!Array.isArray(datasets) || !datasets.length || !labels.length) {
    return createDataset({ rows: [], metrics: [], source: 'legacy' });
  }

  const metrics = datasets.map((d, i) => slugMetric(d.id || d.label || `series_${i}`));
  const rows = labels.map((label, i) => {
    const row = { label: String(label ?? '').trim() };
    datasets.forEach((d, di) => {
      const data = Array.isArray(d.data) ? d.data : (Array.isArray(d.values) ? d.values : []);
      row[metrics[di]] = data[i] == null ? null : Number(data[i]);
    });
    return row;
  });

  const units = {};
  datasets.forEach((d, i) => {
    if (d.unit) units[metrics[i]] = d.unit;
  });

  return createDataset({
    rows,
    metrics,
    labels: labels.map((l) => String(l ?? '').trim()),
    labelKey: 'label',
    grouping: 'label',
    units,
    year: raw.reportingYear ?? raw.meta?.reportingYear ?? null,
    source: 'legacy',
    metadata: {
      kind: 'legacy_config',
      title: raw.title || raw.meta?.title || null,
      chartType: raw.chartType || null,
      intent: raw.intent || null,
      metricLabels: Object.fromEntries(datasets.map((d, i) => [metrics[i], d.label || metrics[i]])),
    },
  });
}

function parseNumberCell(value) {
  const cleaned = String(value || '')
    .replace(/,/g, '')
    .replace(/[^\d.-]/g, '')
    .trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function slugMetric(label) {
  return String(label || 'value')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    || 'value';
}
