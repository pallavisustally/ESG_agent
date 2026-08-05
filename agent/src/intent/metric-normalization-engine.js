/**
 * Metric Normalization Engine — meaning-based metric resolution.
 *
 * TextNormalizer → FeatureExtractor → Registry Scorer → QualifierGate → Confidence
 */

import { normalizeMetricText } from './metric-normalize.js';
import { extractMetricFeatures } from './metric-features.js';
import { enrichDerivedDefinition, getMetricDefinition } from './metric-registry.js';
import { SCORE_FOUND, SCORE_MEDIUM, scoreMetricCandidates } from './metric-score.js';
import { applyQualifierGate } from './metric-qualifier-gate.js';
import { getDerivedMetric } from './derived-metrics.js';
import { refersToPriorCompanies } from './conversation-context.js';

export const ENGINE_STATE = Object.freeze({
  FOUND: 'FOUND',
  MEDIUM_CONFIDENCE: 'MEDIUM_CONFIDENCE',
  UNSUPPORTED: 'UNSUPPORTED',
  NO_MATCH: 'NO_MATCH',
});

/**
 * Run the full normalization pipeline.
 * @param {string} userMessage
 * @param {{ metrics?: string[], metric?: string|null }} [hints]
 */
export function runMetricNormalizationEngine(userMessage = '', hints = {}) {
  const { original, normalized, tokens } = normalizeMetricText(userMessage);
  const features = extractMetricFeatures(normalized, tokens, original);

  // Explicit caller hints (e.g. LLM extract) — still run through gate.
  const hintIds = [
    ...(Array.isArray(hints.metrics) ? hints.metrics : []),
    ...(hints.metric ? [hints.metric] : []),
  ].filter(Boolean);

  let candidates = scoreMetricCandidates(features, normalized, original);

  if (hintIds.length) {
    for (const id of hintIds) {
      const def = getMetricDefinition(id) || { id, kind: 'stored', family: null };
      const existing = candidates.find((c) => c.id === id);
      if (existing) {
        existing.score = Math.max(existing.score, 0.92);
      } else {
        candidates.unshift({
          id,
          score: 0.92,
          def,
          matchedFeatures: ['hint'],
          matchedConcepts: [],
          matchedPhrases: [],
        });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
  }

  const gate = applyQualifierGate({
    features,
    normalizedText: normalized,
    originalText: original,
    candidates,
  });

  if (gate.action === 'unsupported') {
    return buildResult({
      engineState: ENGINE_STATE.UNSUPPORTED,
      metric: null,
      confidence: gate.candidate?.score || 0,
      features,
      candidates,
      normalized,
      original,
      reason: gate.reason,
    });
  }

  let winner = gate.action === 'specialize' ? gate.candidate : gate.candidate;
  if (!winner) {
    winner = candidates.find((c) => c.def?.kind !== 'unsupported_topic') || null;
  }

  if (!winner || winner.score < SCORE_MEDIUM) {
    // Near-miss anaphoric metric-like ask with no candidate → unsupported (preserve legacy)
    if (
      !winner
      && features.looksLikeMetric
      && refersToPriorCompanies(original)
      && !/\b(same metric|that metric|the same|this metric|the share|that share|the count|same ones?)\b/i.test(original)
    ) {
      return buildResult({
        engineState: ENGINE_STATE.UNSUPPORTED,
        metric: null,
        confidence: 0,
        features,
        candidates,
        normalized,
        original,
        reason: 'anaphoric_unresolved_metric',
      });
    }

    if (!features.looksLikeMetric || !winner) {
      return buildResult({
        engineState: ENGINE_STATE.NO_MATCH,
        metric: null,
        confidence: winner?.score || 0,
        features,
        candidates,
        normalized,
        original,
        reason: 'no_match',
      });
    }

    return buildResult({
      engineState: ENGINE_STATE.UNSUPPORTED,
      metric: null,
      confidence: winner.score,
      features,
      candidates,
      normalized,
      original,
      reason: 'low_confidence',
    });
  }

  const engineState = winner.score > SCORE_FOUND
    ? ENGINE_STATE.FOUND
    : ENGINE_STATE.MEDIUM_CONFIDENCE;

  return buildResult({
    engineState,
    metric: winner.id,
    confidence: winner.score,
    features,
    candidates,
    normalized,
    original,
    reason: gate.reason,
    matchedFeatures: winner.matchedFeatures,
    winner,
  });
}

/**
 * Compat helper: ordered metric ids for extractMetrics().
 */
export function extractMetricsFromEngine(userMessage = '') {
  const result = runMetricNormalizationEngine(userMessage);
  if (
    result.engineState === ENGINE_STATE.FOUND
    || result.engineState === ENGINE_STATE.MEDIUM_CONFIDENCE
  ) {
    const ids = [result.metric];
    for (const c of result.candidates || []) {
      if (
        c.id !== result.metric
        && c.score >= SCORE_MEDIUM
        && c.def?.kind !== 'unsupported_topic'
        && !ids.includes(c.id)
      ) {
        ids.push(c.id);
      }
    }
    return ids;
  }
  return [];
}

function buildResult({
  engineState,
  metric,
  confidence,
  features,
  candidates,
  normalized,
  original,
  reason = null,
  matchedFeatures = [],
  winner = null,
}) {
  const def = metric ? enrichDerivedDefinition(getMetricDefinition(metric)) : null;
  const derived = metric && def?.kind === 'derived'
    ? (def.derived || getDerivedMetric(metric))
    : null;

  return {
    engineState,
    metric: metric || null,
    metrics: metric ? [metric] : [],
    confidence: Number(confidence) || 0,
    features,
    candidates: (candidates || []).slice(0, 5).map((c) => ({
      id: c.id,
      score: c.score,
      matchedFeatures: c.matchedFeatures,
      matchedConcepts: c.matchedConcepts,
    })),
    matchedFeatures,
    derived,
    kind: def?.kind || null,
    normalized,
    original,
    reason,
    winner,
  };
}
