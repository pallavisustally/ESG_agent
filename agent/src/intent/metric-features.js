/**
 * Feature Extractor — semantic facets for metric scoring (not full-phrase match).
 */

import { refersToPriorCompanies } from './conversation-context.js';

/**
 * @typedef {Object} MetricFeatures
 * @property {string[]} families
 * @property {string[]} attributes
 * @property {string|null} measure
 * @property {number[]} scopes
 * @property {string[]} modifiers
 * @property {boolean} quantityAsk
 * @property {boolean} totalHint
 * @property {boolean} anaphoricCompanies
 * @property {string[]} unsupportedTopicHints
 * @property {boolean} looksLikeMetric
 */

/**
 * @param {string} normalizedText
 * @param {string[]} tokens
 * @param {string} [originalText]
 * @returns {MetricFeatures}
 */
export function extractMetricFeatures(normalizedText = '', tokens = [], originalText = '') {
  const t = String(normalizedText || '');
  const original = String(originalText || normalizedText || '');
  const tokenSet = new Set(tokens.map((x) => String(x).toLowerCase()));
  const has = (...words) => words.some((w) => tokenSet.has(w) || new RegExp(`\\b${w}\\b`, 'i').test(t));

  const families = [];
  const attributes = [];
  const modifiers = [];
  const scopes = [];
  const unsupportedTopicHints = [];

  // Families
  if (
    has('employee', 'workforce', 'headcount', 'strength', 'personnel', 'staff')
    || /\b(male|female)\s+count\b/i.test(t)
    || /\bemployee\s+strength\b/i.test(t)
  ) {
    families.push('workforce');
  }
  if (
    has('emission', 'carbon', 'ghg', 'footprint', 'co2', 'scope')
    || /\bscope\s*[123]\b/i.test(t)
  ) {
    families.push('emissions');
  }
  if (has('energy', 'electricity', 'power', 'renewable', 'mwh', 'gj')) {
    families.push('energy');
  }
  if (has('water', 'effluent', 'withdrawal')) families.push('water');
  if (has('waste')) families.push('waste');
  if (has('board', 'director', 'governance')) {
    families.push('board');
    families.push('governance');
  }
  if (has('diversity', 'inclusion') && !families.includes('board')) {
    families.push('diversity');
    if (!families.includes('workforce')) families.push('workforce');
  }
  if (has('ltifr', 'injury', 'safety')) families.push('safety');
  if (has('revenue', 'turnover', 'sales')) families.push('finance');

  // Attributes
  if (has('male')) attributes.push('male');
  if (has('female')) attributes.push('female');
  if (has('disabled', 'pwd', 'handicap') || /\bdifferently\s*abled\b/i.test(t)) {
    attributes.push('disabled');
    modifiers.push('disabled');
  }
  if (has('renewable', 'clean', 'green') && (families.includes('energy') || has('electricity', 'energy'))) {
    attributes.push('renewable');
    modifiers.push('renewable');
  }
  if (has('non-renewable', 'nonrenewable') || /\bnon[-\s]?renewable\b/i.test(t)) {
    attributes.push('non_renewable');
  }
  if (has('direct') || /\bscope\s*1\b/i.test(t)) attributes.push('direct');
  if (has('indirect') || /\bscope\s*2\b/i.test(t)) attributes.push('indirect');
  if (has('hazardous')) {
    attributes.push('hazardous');
    modifiers.push('hazardous');
  }
  if (has('recycled')) modifiers.push('recycled');

  // Scopes
  if (/\bscope\s*1\b/i.test(t)) scopes.push(1);
  if (/\bscope\s*2\b/i.test(t)) scopes.push(2);
  if (/\bscope\s*3\b/i.test(t) || /\bvalue\s*chain\b/i.test(t) || /\bupstream\b|\bdownstream\b/i.test(t)) {
    scopes.push(3);
  }

  // Measure
  let measure = null;
  if (/\bintensity\b/i.test(t)) measure = 'intensity';
  else if (/\b(share|percent|percentage|%)\b/i.test(t) || /\bdiversity\b/i.test(t)) {
    measure = /\bdiversity\b/i.test(t) && !/\b(count|number|how many)\b/i.test(t)
      ? 'share'
      : (/\b(share|percent|percentage|%)\b/i.test(t) ? 'share' : measure);
  }
  if (!measure && /\b(average|avg|mean)\b/i.test(t)) measure = 'average';
  if (
    !measure
    && (
      /\b(count|number of|how many|headcount|strength)\b/i.test(t)
      || /\b(male|female)\s+count\b/i.test(t)
      || /\b(male|female)\s+employee\b/i.test(t)
      || /\bemployee\s+strength\b/i.test(t)
    )
  ) {
    measure = 'count';
  }
  // Bare "male/female workforce" without count/% → share (policy)
  if (
    !measure
    && /\b(male|female)\s+workforce\b/i.test(t)
    && !/\b(count|number|how many|employee)\b/i.test(t)
  ) {
    measure = 'share';
  }
  if (!measure && (/\btotal\b/i.test(t) || /\boverall\b/i.test(t)) && families.includes('emissions')) {
    measure = 'total';
  }
  if (!measure && families.includes('emissions') && !scopes.length) {
    measure = 'total';
  }
  // Board mentions without count/% → share (board diversity / women on board)
  if (!measure && (families.includes('board') || families.includes('governance'))) {
    measure = 'share';
  }
  // Renewable energy without consumption → share (policy)
  if (!measure && attributes.includes('renewable') && families.includes('energy')) {
    measure = 'share';
  }
  // Waste / water / energy / finance absolute asks default to total when no intensity/share
  if (
    !measure
    && (families.includes('waste') || families.includes('water') || families.includes('energy') || families.includes('finance'))
  ) {
    measure = 'total';
  }
  if (!measure && /\bpercentage\b/i.test(t)) measure = 'percentage';

  // Align percentage with share for scoring
  if (measure === 'percentage') measure = 'share';

  const quantityAsk = /\b(how many|number of|count of|how much)\b/i.test(t);
  const totalHint = /\b(total|overall|aggregate)\b/i.test(t)
    || (families.includes('emissions') && !scopes.length && measure !== 'intensity');

  if (/\bplastic\b/i.test(t)) unsupportedTopicHints.push('plastic');
  if (/\bocean\b/i.test(t) && /\bpollution\b/i.test(t)) unsupportedTopicHints.push('ocean');
  if (/\bmicroplastic/i.test(t)) unsupportedTopicHints.push('microplastic');
  if (/\bscope\s*4\b/i.test(t)) unsupportedTopicHints.push('scope4');

  const looksLikeMetric = looksLikeMetricFromFeatures({
    families,
    measure,
    quantityAsk,
    scopes,
    attributes,
    t,
  });

  // Company-count questions are not BRSR metrics
  if (/\bhow many companies\b|\bnumber of companies\b|\bcount (of )?companies\b/i.test(t)) {
    return emptyFeatures(original);
  }

  return {
    families: [...new Set(families)],
    attributes: [...new Set(attributes)],
    measure,
    scopes: [...new Set(scopes)],
    modifiers: [...new Set(modifiers)],
    quantityAsk,
    totalHint,
    anaphoricCompanies: refersToPriorCompanies(original),
    unsupportedTopicHints: [...new Set(unsupportedTopicHints)],
    looksLikeMetric,
  };
}

function looksLikeMetricFromFeatures({
  families, measure, quantityAsk, scopes, attributes, t,
}) {
  if (families.length) return true;
  if (measure) return true;
  if (scopes.length) return true;
  if (quantityAsk && (attributes.length || /\b(male|female|employee|emission|carbon)\b/i.test(t))) {
    return true;
  }
  return /\b(emission|intensity|footprint|headcount|share|ltifr|consumption|carbon|ghg|employee|workforce|board)\b/i.test(t);
}

function emptyFeatures() {
  return {
    families: [],
    attributes: [],
    measure: null,
    scopes: [],
    modifiers: [],
    quantityAsk: false,
    totalHint: false,
    anaphoricCompanies: false,
    unsupportedTopicHints: [],
    looksLikeMetric: false,
  };
}
