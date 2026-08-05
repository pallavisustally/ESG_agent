/**
 * Qualifier Gate — reject unavailable slices; specialize valid NL (e.g. value chain → Scope 3).
 */

import { getMetricDefinition } from './metric-registry.js';
import { scoreMetricCandidates } from './metric-score.js';

const SLICE_UNSUPPORTED_RE =
  /\bdisabled\b|\bdifferently[-\s]?abled\b|\bpwd\b|\bhandicap|\bimpair|\bpermanent\b|\btemporary\b|\bcontract(ual)?\b|\bmigrant\b|\bcaste\b|\btribal\b|\bsc\/?st\b|\bobc\b|\bage\s*group\b|\bsenior\s*citizen\b|\bcsr\b|\btraining\s*hours?\b|\bminimum\s*wage\b|\bparental\s*leave\b|\bsexual\s*harassment\b|\bhuman\s*rights\b|\bscope\s*4\b|\bscope\s*3\.?\d/i;

const TOPIC_UNSUPPORTED_RE =
  /\bplastic\s+(footprint|waste|pollution|use|usage)\b|\bocean\s+pollution\b|\bmicroplastic/i;

/**
 * @param {object} params
 * @param {import('./metric-features.js').MetricFeatures} params.features
 * @param {string} params.normalizedText
 * @param {string} params.originalText
 * @param {Array} params.candidates - scored candidates
 * @returns {{
 *   action: 'pass'|'unsupported'|'specialize',
 *   candidate: object|null,
 *   reason: string|null,
 * }}
 */
export function applyQualifierGate({
  features,
  normalizedText = '',
  originalText = '',
  candidates = [],
} = {}) {
  const text = `${normalizedText} ${originalText}`;

  // Known unavailable topics always win.
  if (TOPIC_UNSUPPORTED_RE.test(text) || (features.unsupportedTopicHints || []).length) {
    const topic = candidates.find((c) => c.def?.kind === 'unsupported_topic' && c.score >= 0.4);
    return {
      action: 'unsupported',
      candidate: topic || null,
      reason: 'unsupported_topic',
    };
  }

  if (/\bscope\s*4\b/i.test(text)) {
    return { action: 'unsupported', candidate: null, reason: 'scope4' };
  }

  // Disabled / employment-type slices — block workforce metrics.
  const sliceHit = SLICE_UNSUPPORTED_RE.test(text)
    || (features.attributes || []).includes('disabled');
  if (sliceHit) {
    const top = candidates.find((c) => c.def?.kind !== 'unsupported_topic') || candidates[0];
    if (top && (top.def?.family === 'workforce' || top.def?.family === 'board')) {
      return { action: 'unsupported', candidate: top, reason: 'unsupported_slice' };
    }
    // Slice language without a workforce match (e.g. supplier-only asks)
    if (!top || top.score < 0.6) {
      return { action: 'unsupported', candidate: null, reason: 'unsupported_slice' };
    }
  }

  // Value chain / upstream / downstream → Scope 3 specialization (never unsupported).
  if (
    features.families?.includes('emissions')
    && (features.scopes || []).includes(3)
    && /\b(value\s*chain|upstream|downstream)\b/i.test(text)
    && !(features.scopes || []).includes(1)
    && !(features.scopes || []).includes(2)
  ) {
    const scope3 = candidates.find((c) => c.id === 'scope3_emissions')
      || {
        id: 'scope3_emissions',
        score: Math.max(0.9, candidates[0]?.score || 0.9),
        def: getMetricDefinition('scope3_emissions'),
        matchedFeatures: ['specialize=value_chain'],
        matchedConcepts: [],
        matchedPhrases: [],
      };
    return {
      action: 'specialize',
      candidate: { ...scope3, score: Math.max(scope3.score, 0.9) },
      reason: 'value_chain_to_scope3',
    };
  }

  // Supplier-only (no emissions) remains unsupported social slice.
  if (/\bsupplier\b/i.test(text) && !features.families?.includes('emissions')) {
    return { action: 'unsupported', candidate: null, reason: 'supplier_slice' };
  }

  const top = candidates.find((c) => c.def?.kind !== 'unsupported_topic') || null;
  if (!top) {
    return { action: 'pass', candidate: null, reason: null };
  }

  // Definition-level unsupported qualifiers
  const blocked = (top.def?.unsupportedQualifiers || []).some((q) => {
    if (q === 'disabled' || q === 'pwd' || q === 'differently_abled') {
      return (features.attributes || []).includes('disabled') || /\bdisabled\b|\bpwd\b/i.test(text);
    }
    return new RegExp(`\\b${q.replace(/_/g, '[\\s-]?')}\\b`, 'i').test(text);
  });
  if (blocked) {
    return { action: 'unsupported', candidate: top, reason: 'metric_unsupported_qualifier' };
  }

  return { action: 'pass', candidate: top, reason: null };
}

/**
 * Re-score helper when gate needs a fresh Scope 3 candidate list.
 * @deprecated internal convenience — prefer passing candidates from engine
 */
export function ensureScope3Candidate(features, normalizedText, candidates) {
  if (candidates.some((c) => c.id === 'scope3_emissions')) return candidates;
  return scoreMetricCandidates(
    { ...features, scopes: [3], families: ['emissions'] },
    normalizedText,
  );
}
