/**
 * Score registry metrics from extracted features + light phrase evidence.
 */

import { getExecutableMetricDefinitions, listMetricDefinitions } from './metric-registry.js';

export const SCORE_FOUND = 0.85;
export const SCORE_MEDIUM = 0.60;

/**
 * @param {import('./metric-features.js').MetricFeatures} features
 * @param {string} normalizedText
 * @param {string} [originalText]
 * @returns {Array<{ id: string, score: number, def: object, matchedFeatures: string[], matchedConcepts: string[], matchedPhrases: string[] }>}
 */
export function scoreMetricCandidates(features, normalizedText = '', originalText = '') {
  const text = String(normalizedText || '');
  const original = String(originalText || normalizedText || '').toLowerCase();
  const defs = [
    ...getExecutableMetricDefinitions(),
    ...listMetricDefinitions({ includeUnsupported: true }).filter((d) => d.kind === 'unsupported_topic'),
  ];

  const scored = [];
  for (const def of defs) {
    const result = scoreOne(def, features, text, original);
    if (result.score > 0) scored.push(result);
  }

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored;
}

function scoreOne(def, features, text, original = '') {
  const matchedFeatures = [];
  const matchedConcepts = [];
  const matchedPhrases = [];
  let score = 0;

  const familyHit = features.families?.includes(def.family)
    || (def.family === 'board' && features.families?.includes('governance'))
    || (def.family === 'workforce' && features.families?.includes('diversity') && def.measure === 'share');

  if (!familyHit && def.kind !== 'unsupported_topic') {
    // Phrase-only rescue for strong example hits
    const phraseBoost = phraseEvidence(def, text, original, matchedPhrases);
    if (phraseBoost < 0.2) {
      return { id: def.id, score: 0, def, matchedFeatures, matchedConcepts, matchedPhrases };
    }
    score += phraseBoost;
  } else if (familyHit) {
    score += 0.38;
    matchedFeatures.push(`family=${def.family}`);
  } else if (def.kind === 'unsupported_topic') {
    const topicHit = (features.unsupportedTopicHints || []).some((h) =>
      (def.concepts || []).some((c) => h.includes(c) || c.includes(h)))
      || phraseEvidence(def, text, original, matchedPhrases) >= 0.15;
    if (!topicHit) {
      return { id: def.id, score: 0, def, matchedFeatures, matchedConcepts, matchedPhrases };
    }
    score += 0.5;
    matchedFeatures.push('unsupported_topic');
  }

  // Measure
  if (def.measure && features.measure) {
    if (def.measure === features.measure
      || (def.measure === 'share' && features.measure === 'percentage')
      || (def.measure === 'total' && features.measure === 'average' && def.family !== 'workforce')) {
      score += 0.25;
      matchedFeatures.push(`measure=${def.measure}`);
    } else if (def.measure === 'total' && !features.measure && def.family === 'emissions') {
      score += 0.15;
      matchedFeatures.push('measure=total_default');
    } else if (
      (def.measure === 'count' && features.measure === 'share')
      || (def.measure === 'share' && features.measure === 'count')
      || (def.measure === 'intensity' && features.measure && features.measure !== 'intensity')
      || (def.measure !== 'intensity' && features.measure === 'intensity')
    ) {
      score -= 0.35;
      matchedFeatures.push('measure_conflict');
    }
  } else if (def.measure === 'count' && features.quantityAsk && familyHit) {
    score += 0.2;
    matchedFeatures.push('measure=count_via_quantityAsk');
  } else if (!def.measure && !features.measure) {
    score += 0.05;
  }

  // Attributes (gender, renewable, …)
  const defAttrs = def.attributes || [];
  const featAttrs = features.attributes || [];
  if (defAttrs.length) {
    const overlap = defAttrs.filter((a) => featAttrs.includes(a));
    if (overlap.length) {
      score += 0.2;
      matchedFeatures.push(...overlap.map((a) => `attr=${a}`));
    } else if (defAttrs.includes('male') || defAttrs.includes('female')) {
      // Gendered metric without gender cue — weak / exclude for workforce counts
      if (def.family === 'workforce' && def.measure === 'count') {
        score -= 0.4;
        matchedFeatures.push('missing_gender');
      } else if (def.family === 'board' && !featAttrs.includes('male') && !featAttrs.includes('female')) {
        // board diversity → female_board_share without explicit female is OK
        if (def.id === 'female_board_share' && /\b(diversity|board)\b/i.test(text)) {
          score += 0.18;
          matchedFeatures.push('attr=diversity_default_female_board');
        } else {
          score -= 0.15;
        }
      } else if (
        def.id === 'female_employee_share'
        && /\bdiversity\b/i.test(text)
        && !featAttrs.includes('male')
      ) {
        score += 0.18;
        matchedFeatures.push('attr=diversity_default_female_workforce');
      } else {
        score -= 0.12;
      }
    }
  } else if (featAttrs.includes('male') || featAttrs.includes('female')) {
    // Ungendered total employee count should lose to gendered metrics when gender present
    if (def.id === 'total_employee_count') {
      score -= 0.25;
      matchedFeatures.push('prefer_gendered');
    }
  }

  // Scopes
  const defScopes = def.scopes || [];
  const featScopes = features.scopes || [];
  if (defScopes.length) {
    if (featScopes.some((s) => defScopes.includes(s))) {
      score += 0.22;
      matchedFeatures.push(`scope=${defScopes.join(',')}`);
    } else if (featScopes.length) {
      score -= 0.4;
      matchedFeatures.push('scope_conflict');
    } else {
      score -= 0.15;
    }
  } else if (def.id === 'total_emissions') {
    if (featScopes.length) {
      score -= 0.35;
      matchedFeatures.push('prefer_scoped');
    } else if (features.families?.includes('emissions')) {
      score += 0.12;
      matchedFeatures.push('total_emissions_default');
    }
  }

  // Board vs workforce
  if (def.family === 'workforce' && features.families?.includes('board')) {
    score -= 0.45;
    matchedFeatures.push('board_vs_workforce');
  }
  if (def.family === 'board' && !features.families?.includes('board') && !features.families?.includes('governance')) {
    if (!/\bboard\b/i.test(text)) score -= 0.3;
  }

  // Renewable energy: consumption vs share
  if (def.id === 'renewable_energy_consumption') {
    if (!/\b(consumption|consumed|use|usage)\b/i.test(text)) {
      score -= 0.2;
    } else {
      score += 0.1;
    }
  }
  if (def.id === 'renewable_energy_share' && /\brenewable\b/i.test(text) && !/\b(consumption|consumed)\b/i.test(text)) {
    score += 0.08;
  }

  // Water withdrawal vs consumption
  if (def.id === 'water_withdrawal' && !/\bwithdrawal\b/i.test(text)) score -= 0.25;
  if (def.id === 'water_consumption' && /\bwithdrawal\b/i.test(text)) score -= 0.25;

  // Concepts
  for (const c of def.concepts || []) {
    if (new RegExp(`\\b${escapeRe(c)}\\b`, 'i').test(text) || new RegExp(`\\b${escapeRe(c)}\\b`, 'i').test(original)) {
      score += 0.05;
      matchedConcepts.push(c);
    }
  }
  score += Math.min(0.15, matchedConcepts.length * 0.05);

  // Example phrases (boost only) — check normalized + original (pre-synonym)
  const phraseBoost = phraseEvidence(def, text, original, matchedPhrases);
  score += Math.min(0.2, phraseBoost);
  if (phraseBoost >= 0.1 && familyHit) {
    score += 0.12;
    matchedFeatures.push('phrase_family_bonus');
  }

  // Safety / finance short tokens
  if (def.family === 'safety' && /\bltifr\b/i.test(text)) score += 0.25;
  if (def.id === 'total_revenue' && /\b(revenue|turnover)\b/i.test(text)) score += 0.2;

  // Intensity hard preference
  if (features.measure === 'intensity' && def.measure !== 'intensity') {
    score -= 0.5;
  }
  if (def.measure === 'intensity' && features.measure === 'intensity') {
    score += 0.1;
  }

  score = Math.max(0, Math.min(1, score));
  return {
    id: def.id,
    score,
    def,
    matchedFeatures,
    matchedConcepts,
    matchedPhrases,
  };
}

function phraseEvidence(def, text, original, matchedPhrases) {
  let boost = 0;
  const haystacks = [text, original].filter(Boolean);
  for (const phrase of def.examplePhrases || []) {
    const p = String(phrase).toLowerCase();
    if (!p) continue;
    if (haystacks.some((h) => h.includes(p))) {
      matchedPhrases.push(phrase);
      boost += 0.1 + Math.min(0.08, p.split(/\s+/).length * 0.015);
    }
  }
  return boost;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
