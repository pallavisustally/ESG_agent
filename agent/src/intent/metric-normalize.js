/**
 * Text Normalizer — shared preprocessing for metric understanding.
 * Does not mutate user-facing copy; returns matching forms only.
 */

/** Common user typos / near-misses before feature extraction. */
const QUERY_TYPO_FIXES = [
  [/\bcarbom\b/gi, 'carbon'],
  [/\bcarborn\b/gi, 'carbon'],
  [/\bcarbonn\b/gi, 'carbon'],
  [/\bgreenhose\b/gi, 'greenhouse'],
  [/\bgreen\s*house\b/gi, 'greenhouse'],
  [/\bemis+i*o+n+s?\b/gi, 'emissions'],
  [/\bghgs\b/gi, 'ghg'],
  [/\brenewables\b/gi, 'renewable'],
  [/\bwatter\b/gi, 'water'],
  [/\bwastee\b/gi, 'waste'],
  // employee / employees misspellings (employes, emplyees, employe, …)
  [/\bemployes\b/gi, 'employees'],
  [/\bemplyees?\b/gi, 'employees'],
  [/\bemploye\b/gi, 'employee'],
  [/\bemployeees\b/gi, 'employees'],
  [/\bstrenght\b/gi, 'strength'],
];

/** Synonym expansions applied after typo fixes (matching text only). */
const SYNONYM_EXPAND = [
  [/\bwomen\b/gi, 'female'],
  [/\bwoman\b/gi, 'female'],
  [/\bmen\b/gi, 'male'],
  [/\bman\b/gi, 'male'],
  [/\bco[₂2]e?\b/gi, 'carbon'],
  [/\bgreenhouse\s+gases?\b/gi, 'ghg'],
  [/\bgreenhouse\s+gas\b/gi, 'ghg'],
  [/\bheadcounts?\b/gi, 'count'],
  [/\bpersonnel\b/gi, 'employee'],
  [/\bstaff\b/gi, 'employee'],
  [/\bworkers?\b/gi, 'employee'],
];

/**
 * Normalize spelling noise so "carbon emisiions" still resolves.
 */
export function normalizeMetricQueryText(text = '') {
  let out = String(text || '');
  for (const [pattern, replacement] of QUERY_TYPO_FIXES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Full metric-oriented normalization for the Metric Normalization Engine.
 * @returns {{ original: string, normalized: string, tokens: string[] }}
 */
export function normalizeMetricText(raw = '') {
  const original = String(raw || '');
  let normalized = normalizeMetricQueryText(original)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[_/]+/g, ' ')
    .replace(/[?!.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  for (const [pattern, replacement] of SYNONYM_EXPAND) {
    normalized = normalized.replace(pattern, replacement);
  }

  // Light morphology for matching (keep both forms via tokens).
  const morph = normalized
    .replace(/\bemployees\b/g, 'employee')
    .replace(/\bemissions\b/g, 'emission')
    .replace(/\bgases\b/g, 'gas');

  const tokenSource = `${normalized} ${morph}`;
  const tokens = [...new Set(
    tokenSource
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean),
  )];

  return {
    original,
    normalized: morph,
    tokens,
  };
}
