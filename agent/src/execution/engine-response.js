/**
 * Standard engine response — every engine returns this shape.
 * Response Composer is the only module that turns these into final chat text.
 *
 * Optional `memoryUpdate` is a structured conversation-memory patch (same shape
 * as sql-agent memoryUpdate). The Execution Orchestrator merges these patches
 * and persists them via saveTurnMemory — engines never write memory themselves.
 */

/**
 * @typedef {Object} EngineResponse
 * @property {string} engine
 * @property {boolean} ok
 * @property {string} text
 * @property {object|null} [dataset]
 * @property {object|null} [visualization]
 * @property {string[]} [citations]
 * @property {string[]} [insights]
 * @property {string} [recommendations]
 * @property {string[]} [assumptions]
 * @property {number} [confidence]
 * @property {object|null} [data]
 * @property {string} [dataText] - grounding text for downstream engines
 * @property {object|null} [memoryUpdate] - structured conversation memory patch
 * @property {string} [error]
 */

/**
 * @param {Partial<EngineResponse> & { engine: string }} input
 * @returns {EngineResponse}
 */
export function createEngineResponse(input = {}) {
  return {
    engine: String(input.engine || 'unknown'),
    ok: Boolean(input.ok),
    text: String(input.text || ''),
    dataset: input.dataset ?? null,
    visualization: input.visualization ?? null,
    citations: Array.isArray(input.citations) ? input.citations : [],
    insights: Array.isArray(input.insights) ? input.insights : [],
    recommendations: input.recommendations ? String(input.recommendations) : '',
    assumptions: Array.isArray(input.assumptions) ? input.assumptions.map(String) : [],
    confidence: clamp01(input.confidence),
    data: input.data ?? null,
    dataText: input.dataText ? String(input.dataText) : (input.ok ? String(input.text || '') : ''),
    memoryUpdate: normalizeMemoryUpdate(input.memoryUpdate),
    error: input.error ? String(input.error) : null,
  };
}

/**
 * Merge engine responses into one structure for the composer.
 * @param {EngineResponse[]} results
 */
export function mergeEngineResponses(results = []) {
  const usable = (results || []).filter((r) => r && (r.text || r.visualization));
  const citations = [];
  const insights = [];
  const assumptions = [];
  let recommendations = '';
  let visualization = null;
  let dataset = null;
  let confidence = 0;
  let n = 0;

  for (const r of usable) {
    for (const c of r.citations || []) {
      if (c && !citations.includes(c)) citations.push(c);
    }
    for (const i of r.insights || []) {
      if (i && !insights.includes(i)) insights.push(i);
    }
    for (const a of r.assumptions || []) {
      if (a && !assumptions.includes(a)) assumptions.push(a);
    }
    if (r.recommendations && !recommendations) recommendations = r.recommendations;
    if (r.visualization && !visualization) visualization = r.visualization;
    if (r.dataset && !dataset) dataset = r.dataset;
    if (Number.isFinite(r.confidence)) {
      confidence += r.confidence;
      n += 1;
    }
  }

  return {
    results: usable,
    citations,
    insights,
    assumptions,
    recommendations,
    visualization,
    dataset,
    confidence: n ? confidence / n : 0,
    ok: usable.some((r) => r.ok),
    memoryUpdate: mergeEngineMemoryUpdates(usable),
  };
}

/**
 * Merge structured memoryUpdate patches from successful engines.
 * Later engines override scalar fields; non-empty arrays replace earlier ones;
 * `filters` objects are shallow-merged.
 *
 * @param {EngineResponse[]} results
 * @returns {object}
 */
export function mergeEngineMemoryUpdates(results = []) {
  const merged = {};
  for (const r of results || []) {
    if (!r?.ok || !r.memoryUpdate || typeof r.memoryUpdate !== 'object') continue;
    const u = r.memoryUpdate;
    for (const [k, v] of Object.entries(u)) {
      if (v === undefined) continue;
      if (k === 'filters' && v && typeof v === 'object' && !Array.isArray(v)) {
        merged.filters = { ...(merged.filters || {}), ...v };
        continue;
      }
      if (Array.isArray(v)) {
        if (v.length > 0 || merged[k] == null) merged[k] = [...v];
        continue;
      }
      merged[k] = v;
    }
  }
  return merged;
}

/** True when a patch explicitly supplies company-list fields from an engine. */
export function hasExplicitCompanyMemory(patch = null) {
  if (!patch || typeof patch !== 'object') return false;
  return patch.lastCompanies != null
    || patch.entities != null
    || patch.lastPageItems != null
    || patch.resolvedCompany != null;
}

function normalizeMemoryUpdate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return { ...value };
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
