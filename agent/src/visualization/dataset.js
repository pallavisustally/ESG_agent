/**
 * Generic Dataset model — source-agnostic tabular input for the Visualization Engine.
 *
 * SQL / Report / PDF / future APIs must convert into Dataset before visualization.
 * Visualization never depends on raw SQL row shapes.
 */

import { metricLabel, metricUnit } from './chart-spec.js';

/**
 * @typedef {Object} Dataset
 * @property {Array<Object>} rows
 * @property {string[]} labels
 * @property {string[]} metrics
 * @property {Record<string, (number|null)[]>} values - metric id → aligned value arrays
 * @property {Record<string, string|null>} units - metric id → unit
 * @property {string[]} dimensions - categorical / axis fields (e.g. company, year, sector)
 * @property {string|null} aggregation
 * @property {Object} metadata
 * @property {string} source - sql | report | pdf | markdown | api | unknown
 * @property {string|number|null} year
 * @property {string|null} company
 * @property {string|null} grouping - e.g. sector | industry | company | year
 * @property {string} labelKey
 */

const META_KEYS = new Set([
  'company', 'year', 'sector', 'industry', 'issuer_id', 'group_label',
  'metric_value', 'label', 'name',
]);

/**
 * Create a normalized Dataset from structured inputs.
 * @param {Partial<Dataset> & { rows?: Array<Object>, metrics?: string[], labelKey?: string }} input
 * @returns {Dataset}
 */
export function createDataset(input = {}) {
  const labelKey = input.labelKey || inferLabelKey(input) || 'company';
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const metrics = normalizeMetrics(input.metrics, rows, labelKey);

  const cleaned = [];
  for (const row of rows) {
    const label = String(
      row?.[labelKey] ?? row?.company ?? row?.year ?? row?.label ?? row?.group_label ?? '',
    ).trim();
    if (!label) continue;
    cleaned.push({ row, label });
  }

  const labels = Array.isArray(input.labels) && input.labels.length
    ? input.labels.map((l) => String(l ?? '').trim()).filter(Boolean)
    : cleaned.map((c) => c.label);

  const values = {};
  const units = { ...(input.units || {}) };
  for (const metricId of metrics) {
    if (Array.isArray(input.values?.[metricId])) {
      values[metricId] = input.values[metricId].map(toNullableNumber);
    } else {
      values[metricId] = cleaned.map(({ row }) => {
        const v = row[metricId] ?? row.metric_value;
        return toNullableNumber(v);
      });
    }
    if (units[metricId] == null) units[metricId] = metricUnit(metricId);
  }

  const year = input.year ?? firstCommonYear(cleaned.map((c) => c.row?.year)) ?? null;
  const company = input.company
    ?? (cleaned.length === 1 ? (cleaned[0].row?.company || null) : null);

  return {
    rows: cleaned.map((c) => c.row),
    labels,
    metrics,
    values,
    units,
    dimensions: Array.isArray(input.dimensions) && input.dimensions.length
      ? input.dimensions
      : [labelKey, ...(year != null ? ['year'] : [])].filter(Boolean),
    aggregation: input.aggregation ?? null,
    metadata: {
      ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
      metricLabels: Object.fromEntries(metrics.map((m) => [m, metricLabel(m)])),
    },
    source: input.source || 'unknown',
    year,
    company,
    grouping: input.grouping ?? labelKey,
    labelKey,
  };
}

/**
 * Normalize / repair a Dataset-like object.
 * @param {Partial<Dataset>} dataset
 * @returns {Dataset}
 */
export function normalizeDataset(dataset = {}) {
  return createDataset(dataset);
}

/**
 * True when the dataset has at most one usable numeric point (no chart).
 * @param {Dataset} dataset
 */
export function isSingleValueDataset(dataset) {
  if (!dataset?.metrics?.length) return true;
  let numericCount = 0;
  for (const metricId of dataset.metrics) {
    const vals = dataset.values?.[metricId] || [];
    for (const v of vals) {
      if (v != null && Number.isFinite(Number(v))) numericCount += 1;
      if (numericCount > 1) return false;
    }
  }
  return numericCount <= 1;
}

/**
 * Count usable (non-null finite) points across all metrics.
 * @param {Dataset} dataset
 */
export function countNumericPoints(dataset) {
  let n = 0;
  for (const metricId of dataset?.metrics || []) {
    for (const v of dataset.values?.[metricId] || []) {
      if (v != null && Number.isFinite(Number(v))) n += 1;
    }
  }
  return n;
}

function normalizeMetrics(metrics, rows, labelKey) {
  if (Array.isArray(metrics) && metrics.length) {
    return metrics.filter((m) => m && m !== labelKey && !['year', 'sector', 'industry', 'issuer_id', 'company'].includes(m));
  }
  const sample = rows[0] || {};
  const keys = Object.keys(sample).filter((k) => {
    if (k === labelKey || (META_KEYS.has(k) && k !== 'metric_value')) return false;
    if (k === 'metric_value') return true;
    return rows.some((r) => r[k] != null && Number.isFinite(Number(r[k])));
  });
  return keys.filter((m, i, arr) => arr.indexOf(m) === i);
}

function inferLabelKey(input) {
  if (input.grouping) return input.grouping;
  if (input.labelKey) return input.labelKey;
  const rows = input.rows || [];
  if (!rows.length) return null;
  const sample = rows[0];
  if (sample.company != null) return 'company';
  if (sample.year != null && sample.company == null) return 'year';
  if (sample.sector != null) return 'sector';
  if (sample.industry != null) return 'industry';
  if (sample.group_label != null) return 'group_label';
  return null;
}

function firstCommonYear(years) {
  const nums = years.map(Number).filter((y) => Number.isFinite(y));
  if (!nums.length) return null;
  const uniq = [...new Set(nums)];
  return uniq.length === 1 ? uniq[0] : null;
}

function toNullableNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
