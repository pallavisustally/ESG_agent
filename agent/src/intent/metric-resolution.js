/**
 * Explicit metric resolution for follow-up planning.
 *
 * Three stages (never skip stage 2):
 * 1. Direct schema lookup        → FOUND
 * 2. Derived metric lookup       → DERIVED
 * 3. Unavailable                 → UNSUPPORTED
 *
 * NONE = user did not mention any metric (safe to reuse memory).
 */

import { hasUnsupportedMetricQualifier } from '../sql-sanitize.js';
import { resolveMetricAliases } from '../metric-aliases.js';
import { extractMetrics } from './classify-intent.js';
import { refersToPriorCompanies } from './conversation-context.js';
import { matchDerivedMetric } from './derived-metrics.js';

export const METRIC_RESOLUTION = Object.freeze({
  FOUND: 'FOUND',
  DERIVED: 'DERIVED',
  UNSUPPORTED: 'UNSUPPORTED',
  NONE: 'NONE',
});

export const UNSUPPORTED_METRIC_RESPONSE =
  'The requested metric is not available in the current BRSR reports table.';

/** Company-scoped unavailable copy after SQL + document fallback miss. */
export const COMPANY_METRIC_UNAVAILABLE_RESPONSE =
  'The requested metric is not available in this company\'s BRSR report.';

/** Extra unsupported phrases beyond hasUnsupportedMetricQualifier. */
const UNSUPPORTED_PHRASE_RE =
  /\bplastic\s+(footprint|waste|pollution|use|usage)\b|\bocean\s+pollution\b|\bmicroplastic/i;

/**
 * True when the message looks like a metric/value question (not company discovery).
 */
export function looksLikeMetricQuestion(text = '') {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (/\bhow many companies\b|\bnumber of companies\b|\bcount (of )?companies\b/i.test(t)) {
    return false;
  }
  return (
    /\b(how many|number of|how much|count of)\b/i.test(t)
    || /\b(emissions?|intensity|footprint|headcount|share|percentage|ltifr|consumption)\b/i.test(t)
    || /\b(scope\s*\d)\b/i.test(t)
    || /\b(employee|workers?|workforce|board|male|men|female|women)\b/i.test(t)
  );
}

/**
 * Deterministic unsupported-metric request detector (current message only).
 * Call only after direct + derived lookup have already failed.
 */
export function isUnsupportedMetricRequest(userMessage = '') {
  const text = String(userMessage || '');
  if (!text.trim()) return false;
  if (hasUnsupportedMetricQualifier(text)) return true;
  if (UNSUPPORTED_PHRASE_RE.test(text)) return true;

  // Anaphoric metric ask with no schema/derived match.
  if (refersToPriorCompanies(text) && looksLikeMetricQuestion(text)) {
    if (/\b(same metric|that metric|the same|this metric|the share|that share|the count|same ones?)\b/i.test(text)) {
      return false;
    }
    if (/\b(disabled|pwd|plastic|ocean|employee|worker|emission|footprint|intensity|scope|women|female|male|men|board|waste|water|energy|carbon|ghg)\b/i.test(text)) {
      return true;
    }
  }
  return false;
}

function plannerMetricFromAliases(userMessage) {
  const aliases = resolveMetricAliases(userMessage);
  if (!aliases.columns?.length) return null;
  if (
    aliases.columns.includes('scope1_emissions')
    && aliases.columns.includes('scope2_emissions')
    && aliases.columns.includes('scope3_emissions')
  ) {
    return 'total_emissions';
  }
  return aliases.columns[0];
}

function hasUnavailableQualifier(userMessage = '') {
  return hasUnsupportedMetricQualifier(userMessage) || UNSUPPORTED_PHRASE_RE.test(userMessage);
}

/**
 * Resolve metric state from the current user message.
 * Does not consult conversation memory.
 *
 * Stages:
 * 1. Direct schema lookup
 * 2. Derived metric lookup
 * 3. Unavailable
 *
 * @param {string} userMessage
 * @param {{ metrics?: string[], metric?: string|null }} [hints]
 * @returns {{
 *   state: string,
 *   metric: string|null,
 *   metrics: string[],
 *   derived?: object|null,
 *   stage: 'direct'|'derived'|'unavailable'|'none'
 * }}
 */
export function resolveMetricState(userMessage = '', hints = {}) {
  const fromHints = [
    ...(Array.isArray(hints.metrics) ? hints.metrics : []),
    ...(hints.metric ? [hints.metric] : []),
  ].filter(Boolean);

  const fromText = extractMetrics(userMessage);
  let metrics = fromHints.length ? [...new Set(fromHints)] : fromText;
  let metric = metrics[0] || null;

  // ── Stage 1: direct schema lookup ──────────────────────────────────────
  if (!metric) {
    const aliased = plannerMetricFromAliases(userMessage);
    if (aliased) {
      metric = aliased;
      metrics = [aliased];
    }
  }

  if (metric) {
    // Qualifier slices (disabled/PWD/…) are not the base schema metric.
    if (hasUnavailableQualifier(userMessage)) {
      return {
        state: METRIC_RESOLUTION.UNSUPPORTED,
        metric: null,
        metrics: [],
        derived: null,
        stage: 'unavailable',
      };
    }
    return {
      state: METRIC_RESOLUTION.FOUND,
      metric,
      metrics: metrics.length ? metrics : [metric],
      derived: null,
      stage: 'direct',
    };
  }

  // ── Stage 2: derived metric lookup (must not be skipped) ───────────────
  const derived = matchDerivedMetric(userMessage);
  if (derived) {
    if (hasUnavailableQualifier(userMessage)) {
      // e.g. "disabled male employees" — not a supported derived slice.
      return {
        state: METRIC_RESOLUTION.UNSUPPORTED,
        metric: null,
        metrics: [],
        derived: null,
        stage: 'unavailable',
      };
    }
    return {
      state: METRIC_RESOLUTION.DERIVED,
      metric: derived.id,
      metrics: [derived.id],
      derived,
      stage: 'derived',
    };
  }

  // ── Stage 3: unavailable ───────────────────────────────────────────────
  if (isUnsupportedMetricRequest(userMessage)) {
    return {
      state: METRIC_RESOLUTION.UNSUPPORTED,
      metric: null,
      metrics: [],
      derived: null,
      stage: 'unavailable',
    };
  }

  return {
    state: METRIC_RESOLUTION.NONE,
    metric: null,
    metrics: [],
    derived: null,
    stage: 'none',
  };
}

/** True when the metric can be executed (direct schema or derived). */
export function isExecutableMetricResolution(metricResolution) {
  return metricResolution === METRIC_RESOLUTION.FOUND
    || metricResolution === METRIC_RESOLUTION.DERIVED;
}

/** Memory may supply a metric only when the current message omitted one. */
export function shouldReuseMemoryMetric(metricResolution) {
  return metricResolution === METRIC_RESOLUTION.NONE
    || metricResolution == null
    || metricResolution === undefined;
}
