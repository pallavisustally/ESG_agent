/**
 * Chart validation — reject misleading charts before they reach the renderer.
 *
 * ERROR → never render
 * WARNING → render with caution metadata
 * INFO → informational notes (small datasets, partial trends)
 */

import { labelsLookLikeYears } from './chart-select.js';

/**
 * @typedef {Object} ValidationIssue
 * @property {'error'|'warning'|'info'} severity
 * @property {string} code
 * @property {string} message
 */

/**
 * Validate a ChartSpec (or legacy-normalized shape).
 * @returns {{ ok: boolean, errors: ValidationIssue[], warnings: ValidationIssue[], infos: ValidationIssue[], omitMessage?: string }}
 */
export function validateChartSpec(spec) {
  const errors = [];
  const warnings = [];
  const infos = [];

  if (!spec || typeof spec !== 'object') {
    return fail('EMPTY_SPEC', 'ChartSpec is missing.');
  }

  const labels = Array.isArray(spec.labels) ? spec.labels : [];
  const series = Array.isArray(spec.series) ? spec.series : [];
  const isPie = spec.chartType === 'pie' || spec.chartType === 'doughnut';

  if (!series.length) {
    errors.push(issue('error', 'EMPTY_DATASETS', 'No series/datasets provided.'));
  }

  if (!labels.length && spec.chartType !== 'scatter') {
    errors.push(issue('error', 'EMPTY_LABELS', 'No labels provided.'));
  }

  // Empty / all-null values
  for (const s of series) {
    const values = Array.isArray(s.values) ? s.values : [];
    if (!values.length) {
      errors.push(issue('error', 'EMPTY_SERIES', `Series "${s.label || s.id}" has no values.`));
      continue;
    }
    const numeric = values.filter((v) => v != null && Number.isFinite(Number(v)));
    if (!numeric.length) {
      errors.push(issue('error', 'ALL_NULL', `Series "${s.label || s.id}" has no numeric values.`));
    }
    const nullCount = values.filter((v) => v == null || !Number.isFinite(Number(v))).length;
    if (nullCount > 0 && nullCount < values.length) {
      warnings.push(issue('warning', 'NULL_VALUES', `Series "${s.label || s.id}" has ${nullCount} null/non-numeric value(s).`));
    }
    const sparseRatio = values.length ? nullCount / values.length : 0;
    if (sparseRatio >= 0.4 && sparseRatio < 1) {
      warnings.push(issue('warning', 'SPARSE_DATA', `Series "${s.label || s.id}" is sparse (${Math.round(sparseRatio * 100)}% missing).`));
    }
    for (const v of values) {
      if (v != null && !Number.isFinite(Number(v))) {
        errors.push(issue('error', 'NON_NUMERIC', `Series "${s.label || s.id}" contains a non-numeric value.`));
        break;
      }
    }
  }

  // Duplicate labels (misleading categories)
  if (labels.length) {
    const seen = new Map();
    for (const raw of labels) {
      const key = String(raw ?? '').trim().toLowerCase();
      if (!key) continue;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    const dupes = [...seen.entries()].filter(([, c]) => c > 1).map(([k]) => k);
    if (dupes.length) {
      errors.push(issue('error', 'DUPLICATE_LABELS', `Duplicate labels: ${dupes.slice(0, 5).join(', ')}.`));
    }
  }

  // Duplicate datasets (same id or identical value arrays)
  if (series.length >= 2) {
    const idSeen = new Set();
    for (const s of series) {
      const id = String(s.id || s.label || '').trim().toLowerCase();
      if (!id) continue;
      if (idSeen.has(id)) {
        errors.push(issue('error', 'DUPLICATE_DATASETS', `Duplicate dataset id/label: ${id}.`));
      }
      idSeen.add(id);
    }
    for (let i = 0; i < series.length; i += 1) {
      for (let j = i + 1; j < series.length; j += 1) {
        const a = (series[i].values || []).map(Number).join('|');
        const b = (series[j].values || []).map(Number).join('|');
        if (a && a === b) {
          errors.push(issue(
            'error',
            'DUPLICATE_DATASETS',
            `Datasets "${series[i].label || series[i].id}" and "${series[j].label || series[j].id}" contain identical values.`,
          ));
        }
      }
    }
  }

  // Length alignment
  for (const s of series) {
    const values = Array.isArray(s.values) ? s.values : [];
    if (labels.length && values.length && values.length !== labels.length && spec.chartType !== 'scatter') {
      errors.push(issue(
        'error',
        'LENGTH_MISMATCH',
        `Series "${s.label || s.id}" length (${values.length}) does not match labels (${labels.length}).`,
      ));
    }
  }

  // Missing years in an otherwise yearly sequence
  if (labelsLookLikeYears(labels) || spec.intent === 'trend') {
    const years = labels
      .map((l) => Number(String(l).trim()))
      .filter((y) => Number.isFinite(y) && y >= 1900 && y <= 2100)
      .sort((a, b) => a - b);
    if (years.length >= 2) {
      const missing = [];
      for (let y = years[0]; y <= years[years.length - 1]; y += 1) {
        if (!years.includes(y)) missing.push(y);
      }
      if (missing.length) {
        warnings.push(issue(
          'warning',
          'MISSING_YEARS',
          `Missing year(s) in series: ${missing.slice(0, 8).join(', ')}.`,
        ));
      }
      if (missing.length && years.length < 4) {
        infos.push(issue('info', 'PARTIAL_TREND', 'Trend covers a partial year sequence.'));
      }
    }
  }

  // Unit consistency across series
  const units = [...new Set(series.map((s) => s.unit).filter(Boolean))];
  if (units.length > 1 && spec.chartType !== 'scatter') {
    if (spec.intent === 'composition' || isPie) {
      errors.push(issue('error', 'UNIT_MISMATCH', `Incompatible units for composition chart: ${units.join(', ')}.`));
    } else {
      warnings.push(issue('warning', 'UNIT_MISMATCH', `Series use different units: ${units.join(', ')}.`));
    }
  }

  // Pie / doughnut-specific: need positive totals
  if (isPie) {
    if (series.length !== 1) {
      errors.push(issue('error', 'PIE_MULTI_SERIES', 'Pie charts require exactly one series.'));
    } else {
      const vals = (series[0].values || []).map(Number).filter((n) => Number.isFinite(n));
      const positives = vals.filter((n) => n > 0);
      if (positives.length < 2) {
        errors.push(issue('error', 'PIE_INSUFFICIENT', 'Pie charts need at least two positive values.'));
      }
      if (vals.some((n) => n < 0)) {
        errors.push(issue('error', 'PIE_NEGATIVE', 'Pie charts cannot include negative values.'));
      }
    }
  }

  // Scatter needs two series
  if (spec.chartType === 'scatter' && series.length < 2) {
    errors.push(issue('error', 'SCATTER_NEEDS_TWO', 'Scatter charts require at least two series (x and y).'));
  }

  // Too few points for a trend line
  if (spec.intent === 'trend' && labels.length < 2) {
    warnings.push(issue('warning', 'TREND_SHORT', 'Trend charts are more meaningful with 2+ periods.'));
  }

  if (labels.length > 0 && labels.length <= 2 && spec.intent !== 'trend') {
    infos.push(issue('info', 'SMALL_DATASET', `Small dataset (${labels.length} categories).`));
  }

  const ok = errors.length === 0;
  return {
    ok,
    errors,
    warnings,
    infos,
    omitMessage: ok ? undefined : (errors[0]?.message || 'Chart validation failed.'),
  };
}

function issue(severity, code, message) {
  return { severity, code, message };
}

function fail(code, message) {
  return {
    ok: false,
    errors: [issue('error', code, message)],
    warnings: [],
    infos: [],
    omitMessage: message,
  };
}
