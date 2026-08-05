/**
 * Metric resolution façade — delegates to the Metric Normalization Engine.
 *
 * Legacy states (planner-compatible):
 *   FOUND | DERIVED | UNSUPPORTED | NONE
 *
 * Engine states (rich):
 *   FOUND | MEDIUM_CONFIDENCE | UNSUPPORTED | NO_MATCH
 *
 * MEDIUM_CONFIDENCE maps to FOUND/DERIVED (executable) in Phase 1.
 */

import { hasUnsupportedMetricQualifier } from '../sql-sanitize.js';
import { refersToPriorCompanies } from './conversation-context.js';
import {
  ENGINE_STATE,
  runMetricNormalizationEngine,
} from './metric-normalization-engine.js';

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
    || /\b(emissions?|intensity|footprint|headcount|share|percentage|ltifr|consumption|strength|count)\b/i.test(t)
    || /\b(scope\s*\d)\b/i.test(t)
    || /\b(employee|workers?|workforce|board|male|men|female|women)\b/i.test(t)
  );
}

/**
 * Deterministic unsupported-metric request detector (current message only).
 * Prefer engine result; kept for callers/tests that invoke this directly.
 */
export function isUnsupportedMetricRequest(userMessage = '') {
  const text = String(userMessage || '');
  if (!text.trim()) return false;
  if (hasUnsupportedMetricQualifier(text)) return true;
  if (UNSUPPORTED_PHRASE_RE.test(text)) return true;

  if (refersToPriorCompanies(text) && looksLikeMetricQuestion(text)) {
    if (/\b(same metric|that metric|the same|this metric|the share|that share|the count|same ones?)\b/i.test(text)) {
      return false;
    }
    // If the engine can resolve it, it is not unsupported.
    const engine = runMetricNormalizationEngine(text);
    if (
      engine.engineState === ENGINE_STATE.FOUND
      || engine.engineState === ENGINE_STATE.MEDIUM_CONFIDENCE
    ) {
      return false;
    }
    if (/\b(disabled|pwd|plastic|ocean|employee|worker|emission|footprint|intensity|scope|women|female|male|men|board|waste|water|energy|carbon|ghg)\b/i.test(text)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve metric state from the current user message.
 * Does not consult conversation memory.
 *
 * @param {string} userMessage
 * @param {{ metrics?: string[], metric?: string|null }} [hints]
 * @returns {{
 *   state: string,
 *   metric: string|null,
 *   metrics: string[],
 *   derived?: object|null,
 *   stage: string,
 *   confidence?: number,
 *   engineState?: string,
 *   features?: object,
 * }}
 */
export function resolveMetricState(userMessage = '', hints = {}) {
  const engine = runMetricNormalizationEngine(userMessage, hints);

  if (engine.engineState === ENGINE_STATE.UNSUPPORTED) {
    return {
      state: METRIC_RESOLUTION.UNSUPPORTED,
      metric: null,
      metrics: [],
      derived: null,
      stage: 'unavailable',
      confidence: engine.confidence,
      engineState: engine.engineState,
      features: engine.features,
      candidates: engine.candidates,
    };
  }

  if (
    engine.engineState === ENGINE_STATE.FOUND
    || engine.engineState === ENGINE_STATE.MEDIUM_CONFIDENCE
  ) {
    const isDerived = engine.kind === 'derived' || Boolean(engine.derived);
    return {
      state: isDerived ? METRIC_RESOLUTION.DERIVED : METRIC_RESOLUTION.FOUND,
      metric: engine.metric,
      metrics: engine.metrics?.length ? engine.metrics : [engine.metric],
      derived: engine.derived || null,
      // Keep legacy stage labels for existing tests/callers.
      stage: isDerived ? 'derived' : 'direct',
      confidence: engine.confidence,
      engineState: engine.engineState,
      features: engine.features,
      candidates: engine.candidates,
      metricConfidence: engine.engineState === ENGINE_STATE.MEDIUM_CONFIDENCE
        ? 'medium'
        : 'high',
    };
  }

  return {
    state: METRIC_RESOLUTION.NONE,
    metric: null,
    metrics: [],
    derived: null,
    stage: 'none',
    confidence: engine.confidence || 0,
    engineState: ENGINE_STATE.NO_MATCH,
    features: engine.features,
    candidates: engine.candidates,
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
