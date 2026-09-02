/**
 * Phase 13 — Always expose assumptions (year defaults, metric interpretation, etc.).
 */

/**
 * Normalize assumption strings and drop empties/dupes.
 * @param {string[]} assumptions
 */
export function normalizeAssumptions(assumptions = []) {
  const out = [];
  const seen = new Set();
  for (const raw of assumptions) {
    const text = String(raw || '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

/**
 * Build common assumption notes from classification / SQL result metadata.
 */
export function collectAssumptions({
  classification = null,
  plan = null,
  data = null,
} = {}) {
  const notes = [...(classification?.assumptions || [])];

  if (classification?.filters?.assumedMetric || plan?.filters?.assumedMetric) {
    const metric = classification?.metric || plan?.metric || 'total_emissions';
    const already = notes.some((n) => /total_emissions|scope\s*1\s*\+\s*scope\s*2|interpreted as/i.test(n));
    if (!already) {
      if (metric === 'total_emissions') {
        notes.push('Carbon emissions interpreted as Scope 1 + Scope 2 + Scope 3 (total_emissions).');
      } else {
        notes.push(`Metric interpreted as **${String(metric).replace(/_/g, ' ')}**.`);
      }
    }
  }

  const assumedYear = data?.assumedYear ?? classification?.filters?.assumedYear ?? null;
  if (assumedYear) {
    notes.push(`Using latest available BRSR report (${assumedYear}).`);
  }

  return normalizeAssumptions(notes);
}

function isInternalFollowUpAssumption(text = '') {
  return /using companies from prior context|follow-up resolved from prior context|follow-up metric ask reused|clarification will resolve companies/i.test(
    String(text || ''),
  );
}

/**
 * Prepend italic assumption notes to an answer body.
 * Follow-up routing notes stay internal — they should not pad the user reply.
 */
export function prependAssumptionNotes(text, assumptions = []) {
  const notes = normalizeAssumptions(assumptions).filter((a) => !isInternalFollowUpAssumption(a));
  if (!notes.length) return text || '';
  const block = notes.map((a) => `*${a}*`).join(' ');
  if (!text) return block;
  // Avoid double-prepending if already present
  if (notes.every((a) => text.includes(a))) return text;
  return `${block}\n\n${text}`;
}

/**
 * Compact system-prompt addon so the LLM also discloses assumptions.
 */
export function assumptionsSystemAddon(assumptions = []) {
  const notes = normalizeAssumptions(assumptions);
  if (!notes.length) return '';
  return [
    '',
    '### Assumptions (must disclose to the user)',
    ...notes.map((a) => `- ${a}`),
  ].join('\n');
}
