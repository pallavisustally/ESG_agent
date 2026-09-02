/**
 * Honest no-data answers — one or two sentences, no invented BRSR numbers.
 */

function metricLabel(metric) {
  if (!metric) return null;
  if (metric === 'total_emissions') return 'total GHG emissions (Scope 1+2+3)';
  return String(metric).replace(/_/g, ' ');
}

function uniqNames(list = []) {
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const v = String(raw || '').trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/**
 * Nearby structured column when the asked metric is not in the BRSR table.
 */
export function suggestClosestMetric(userMessage = '', metric = null) {
  if (metric && metric !== 'the requested metric') {
    const known = String(metric);
    if (/female_employee|male_employee|scope|renewable|water|waste|energy/i.test(known)) {
      return null;
    }
  }
  const t = String(userMessage || '');
  const female = /\b(female|women|woman)\b/i.test(t);
  const disabled = /\b(disabled|differently\s*abled|pwd|handicap|divyang)\b/i.test(t);
  if (disabled && female) return 'female_employee_count';
  if (disabled) return 'total_employee_count';
  if (female) return 'female_employee_count';
  if (/\b(male|men|man)\b/i.test(t)) return 'male_employee_count';
  return null;
}

/**
 * Build a short “couldn’t find it” reply.
 *
 * @param {{
 *   company?: string|null,
 *   companies?: string[],
 *   metric?: string|null,
 *   year?: number|string|null,
 *   closestYear?: number|string|null,
 *   closestMetric?: string|null,
 *   suggestion?: string|null,
 *   userMessage?: string|null,
 * }} opts
 */
export function buildNoDataAnswer(opts = {}) {
  const companies = uniqNames([
    ...(opts.company ? [opts.company] : []),
    ...(Array.isArray(opts.companies) ? opts.companies : []),
  ]).slice(0, 3);
  const metricBit = metricLabel(opts.metric) || 'that figure';
  const yearBit = opts.year != null ? ` (${opts.year})` : '';
  const closest = opts.closestMetric || suggestClosestMetric(opts.userMessage, opts.metric);
  const closestBit = closest
    ? ` Closest I can look up: **${metricLabel(closest)}**.`
    : (opts.suggestion ? ` ${opts.suggestion}` : '');

  if (companies.length) {
    return `**${metricBit}** is not in the BRSR tables for ${companies.join(', ')}${yearBit}.${closestBit}`.trim();
  }
  return `I don’t have **${metricBit}** in the structured BRSR data.${closestBit}`.trim();
}

/**
 * True when the user explicitly wants report/PDF evidence (not a pure number ask).
 */
export function wantsDocumentEvidence(userMessage = '', executionPlan = null) {
  if (executionPlan?.needsPdf || executionPlan?.needsReport) return true;
  return /\b(report|pdf|filing|document|evidence|excerpt|page|narrative|disclosure)\b/i.test(
    String(userMessage || ''),
  );
}
