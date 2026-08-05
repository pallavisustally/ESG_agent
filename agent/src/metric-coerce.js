/**
 * Coerce XBRL/BRSR metric values so Postgres REAL columns never receive unit labels
 * like "tCO2e", "Metric tonnes of CO2 equivalent", or "-".
 */

const NULLISH = /^(?:-|—|–|na|n\/a|nil|null|none|not\s*available|not\s*applicable|\.)$/i;

/**
 * Extract a finite number from mixed XBRL text, or null if none.
 * @param {unknown} raw
 * @returns {number|null}
 */
export function coerceMetricNumber(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'bigint') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  let s = String(raw).trim();
  if (!s || NULLISH.test(s)) return null;
  // Collapse whitespace / newlines from XBRL unit blobs
  s = s.replace(/\s+/g, ' ');
  if (!/\d/.test(s)) return null;

  // Unit labels often include "CO2" — do not treat that digit as a metric value
  // unless the string starts with a numeric quantity (e.g. "1234.5 tCO2e").
  const startsWithNumber = /^[+-]?\d/.test(s);
  if (!startsWithNumber) {
    const looksLikeUnitLabel =
      /\bco\s*2\b|\btco\s*2|\btco2|\beq\s*co|\bmetric\s+tonn|\btonnes?\s+of\s+co|\btons?\s+of\s+co|\bmt\s*co/i.test(s)
      || /^(?:metric\s+)?(?:tonnes?|tons?|kg|gj|mwh|kwh|litres?|liters?|kl|m3|cu\.?\s*m)\b/i.test(s);
    if (looksLikeUnitLabel) return null;
  }

  const cleaned = s.replace(/,/g, '');
  const match = cleaned.match(/[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Prefer an explicit unit attribute; otherwise salvage unit text from a non-numeric value.
 * @param {unknown} rawValue
 * @param {unknown} existingUnit
 * @returns {string|null}
 */
export function coerceMetricUnit(rawValue, existingUnit = '') {
  const fromAttr = String(existingUnit ?? '').replace(/\s+/g, ' ').trim();
  if (fromAttr) return fromAttr.slice(0, 120);

  if (rawValue == null || typeof rawValue === 'number') return null;
  const s = String(rawValue).replace(/\s+/g, ' ').trim();
  if (!s || NULLISH.test(s)) return null;

  const num = coerceMetricNumber(s);
  if (num == null) {
    // Pure unit / label text
    return /[a-zA-Z]/.test(s) ? s.slice(0, 120) : null;
  }

  const residual = s
    .replace(/,/g, '')
    .replace(/[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, '')
    .trim()
    .replace(/^[(:\s]+|[):\s]+$/g, '')
    .trim();
  return residual ? residual.slice(0, 120) : null;
}

/**
 * Normalize a { value, unit } metric object for DB insert.
 * @param {{ value?: unknown, unit?: unknown }|number|string|null|undefined} metric
 * @returns {{ value: number|null, unit: string|null }|null}
 */
export function normalizeMetricObject(metric) {
  if (metric == null || metric === '') return null;
  if (typeof metric === 'number' || typeof metric === 'string') {
    return {
      value: coerceMetricNumber(metric),
      unit: coerceMetricUnit(metric, ''),
    };
  }
  if (typeof metric !== 'object') return null;
  const rawValue = metric.value;
  const rawUnit = metric.unit;
  const value = coerceMetricNumber(rawValue);
  let unit = coerceMetricUnit(rawValue, rawUnit);
  // If value was non-numeric unit text, keep it as unit and null the value.
  if (value == null && rawValue != null && coerceMetricNumber(rawValue) == null) {
    unit = coerceMetricUnit(rawValue, rawUnit) || unit;
  }
  return { value, unit: unit || null };
}

/** Coerce any raw field that must be REAL/double in Postgres. */
export function coerceDbNumber(raw) {
  return coerceMetricNumber(raw);
}
