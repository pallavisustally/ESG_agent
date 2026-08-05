/**
 * Benchmark case schema for the evaluation framework.
 *
 * Cases are JSON objects scored deterministically (no LLM judge).
 */

export const BENCHMARK_CATEGORIES = Object.freeze([
  'analytics',
  'rankings',
  'comparisons',
  'trends',
  'sector-analysis',
  'report-lookup',
  'pdf-lookup',
  'knowledge',
  'guidance',
  'compliance',
  'recommendation',
  'conversation-memory',
  'follow-up',
  'charts',
]);

export const BENCHMARK_TIERS = Object.freeze(['smoke', 'full']);

export const SCORE_DIMENSIONS = Object.freeze([
  'routing',
  'entity',
  'metric',
  'year',
  'numeric',
  'chart',
  'citation',
]);

const DEFAULT_SCORE = Object.freeze({
  routing: true,
  entity: true,
  metric: true,
  year: true,
  numeric: false,
  chart: false,
  citation: false,
});

/**
 * Normalize and validate a benchmark case. Throws on fatal shape errors.
 * @param {object} raw
 * @param {string} [sourceFile]
 * @returns {object}
 */
export function normalizeBenchmarkCase(raw, sourceFile = '') {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid benchmark case in ${sourceFile}: not an object`);
  }
  if (!raw.id || typeof raw.id !== 'string') {
    throw new Error(`Benchmark case missing id in ${sourceFile}`);
  }
  if (!raw.question || typeof raw.question !== 'string') {
    throw new Error(`Benchmark case ${raw.id} missing question`);
  }

  const category = String(raw.category || '').trim();
  if (!BENCHMARK_CATEGORIES.includes(category)) {
    throw new Error(`Benchmark case ${raw.id}: unknown category "${category}"`);
  }

  const tier = raw.tier === 'full' ? 'full' : 'smoke';
  const expected = raw.expected && typeof raw.expected === 'object' ? raw.expected : {};
  const scoreFlags = {
    ...DEFAULT_SCORE,
    ...(raw.score && typeof raw.score === 'object' ? raw.score : {}),
  };

  return {
    id: raw.id,
    category,
    tier,
    question: String(raw.question).trim(),
    chatHistory: Array.isArray(raw.chatHistory) ? raw.chatHistory : [],
    memory: raw.memory && typeof raw.memory === 'object' ? raw.memory : null,
    expected: {
      intent: expected.intent ?? null,
      entities: Array.isArray(expected.entities) ? expected.entities : [],
      metric: expected.metric ?? null,
      year: expected.year ?? null,
      executionPath: expected.executionPath ?? null,
      executionStrategy: expected.executionStrategy ?? null,
      engines: Array.isArray(expected.engines) ? expected.engines : [],
      enginesMode: expected.enginesMode === 'exact' ? 'exact' : 'superset',
      chart: expected.chart && typeof expected.chart === 'object'
        ? {
          required: Boolean(expected.chart.required),
          chartType: expected.chart.chartType || null,
        }
        : { required: false, chartType: null },
      citations: expected.citations && typeof expected.citations === 'object'
        ? { required: Boolean(expected.citations.required) }
        : { required: false },
      answerValidation: expected.answerValidation || null,
      values: Array.isArray(expected.values) ? expected.values : null,
    },
    score: scoreFlags,
    sourceFile,
  };
}

/**
 * Validate an array of cases; returns { ok, errors, cases }.
 */
export function validateBenchmarkFile(cases, sourceFile = '') {
  const errors = [];
  const normalized = [];
  const ids = new Set();
  if (!Array.isArray(cases)) {
    return { ok: false, errors: [`${sourceFile}: root must be an array`], cases: [] };
  }
  for (const raw of cases) {
    try {
      const c = normalizeBenchmarkCase(raw, sourceFile);
      if (ids.has(c.id)) {
        errors.push(`${sourceFile}: duplicate id ${c.id}`);
      }
      ids.add(c.id);
      normalized.push(c);
    } catch (err) {
      errors.push(err.message);
    }
  }
  return { ok: errors.length === 0, errors, cases: normalized };
}
