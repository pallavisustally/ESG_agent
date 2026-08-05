/**
 * ExecutionPlan — single routing contract for the ESG Copilot.
 *
 * Phase 2 deliverable: model + validation only.
 * Does not execute SQL, reports, PDFs, charts, or answers.
 *
 * Downstream (later phases):
 *   Execution Planner → ExecutionPlan → Orchestrator → Engines → Response Composer
 */

import { CAPABILITIES, isValidCapability } from '../capability/capabilities.js';

/** @typedef {'analytics'|'knowledge'|'guidance'|'recommendation'|'compliance'|'document'|'report'|'hybrid'|'clarify'|'llm_fallback'|'unsupported'} ExecutionStrategy */

/**
 * @typedef {Object} ExecutionPlan
 * @property {string|null} intent - legacy INTENTS value (transitional signal)
 * @property {string|null} capability - primary CAPABILITIES value
 * @property {string[]} capabilities - ordered multi-capability list
 * @property {string[]} entities - resolved company names
 * @property {string[]} metrics
 * @property {(string|number)[]} years
 * @property {string|null} aggregation - AVG|SUM|COUNT|MIN|MAX
 * @property {string|null} grouping - sector|industry|company|year
 * @property {boolean} comparison
 * @property {boolean} visualization - user/plan wants a chart
 * @property {ExecutionStrategy} executionStrategy
 * @property {string[]} requiredEngines
 * @property {boolean} needsSql
 * @property {boolean} needsReport
 * @property {boolean} needsPdf
 * @property {boolean} needsVisualization
 * @property {boolean} needsRecommendation
 * @property {boolean} needsKnowledge
 * @property {boolean} needsGuidance
 * @property {boolean} needsCompliance
 * @property {boolean} needsDocumentGeneration
 * @property {boolean} needsClarification
 * @property {number} confidence
 * @property {string[]} assumptions
 * @property {string|null} reason - human-readable plan reason
 * @property {string|null} clarification - clarification text when needsClarification
 * @property {Object} filters - passthrough filters for engines
 * @property {Object} metadata - planner provenance (source, flags, …)
 */

export const EXECUTION_STRATEGIES = Object.freeze([
  'analytics',
  'knowledge',
  'guidance',
  'recommendation',
  'compliance',
  'document',
  'report',
  'hybrid',
  'clarify',
  'llm_fallback',
  'unsupported',
]);

export const EXECUTION_ENGINES = Object.freeze({
  ANALYTICS: 'analytics',
  REPORT: 'report',
  KNOWLEDGE: 'knowledge',
  GUIDANCE: 'guidance',
  RECOMMENDATION: 'recommendation',
  COMPLIANCE: 'compliance',
  DOCUMENT: 'document',
  VISUALIZATION: 'visualization',
});

/**
 * Create a normalized ExecutionPlan with safe defaults.
 * @param {Partial<ExecutionPlan>} input
 * @returns {ExecutionPlan}
 */
export function createExecutionPlan(input = {}) {
  const capabilities = uniqueStrings(input.capabilities || (input.capability ? [input.capability] : []));
  const capability = input.capability || capabilities[0] || null;
  const metrics = uniqueStrings(input.metrics || []);
  const entities = uniqueStrings(input.entities || []);
  const years = (input.years || []).map((y) => (typeof y === 'number' ? y : String(y))).filter((y) => y !== '' && y != null);

  const needsKnowledge = Boolean(input.needsKnowledge ?? capabilities.includes(CAPABILITIES.ESG_KNOWLEDGE));
  const needsGuidance = Boolean(input.needsGuidance ?? capabilities.includes(CAPABILITIES.ESG_GUIDANCE));
  const needsCompliance = Boolean(input.needsCompliance ?? capabilities.includes(CAPABILITIES.ESG_COMPLIANCE));
  const needsDocumentGeneration = Boolean(
    input.needsDocumentGeneration ?? capabilities.includes(CAPABILITIES.DOCUMENT_GENERATION),
  );
  const needsRecommendation = Boolean(
    input.needsRecommendation ?? capabilities.includes(CAPABILITIES.RECOMMENDATION),
  );
  const needsSql = Boolean(
    input.needsSql
      ?? (capabilities.includes(CAPABILITIES.COMPANY_ANALYTICS)
        || capabilities.includes(CAPABILITIES.BENCHMARKING)),
  );
  const needsReport = Boolean(
    input.needsReport ?? capabilities.includes(CAPABILITIES.COMPANY_REPORTS),
  );
  const needsPdf = Boolean(input.needsPdf ?? false);
  const visualization = Boolean(input.visualization);
  const needsVisualization = Boolean(input.needsVisualization ?? visualization);
  const needsClarification = Boolean(input.needsClarification);
  const comparison = Boolean(
    input.comparison ?? capabilities.includes(CAPABILITIES.BENCHMARKING),
  );

  const requiredEngines = Array.isArray(input.requiredEngines) && input.requiredEngines.length
    ? uniqueStrings(input.requiredEngines)
    : deriveRequiredEngines({
      needsSql,
      needsReport,
      needsPdf,
      needsKnowledge,
      needsGuidance,
      needsCompliance,
      needsDocumentGeneration,
      needsRecommendation,
      needsVisualization,
      needsClarification,
    });

  const executionStrategy = normalizeStrategy(
    input.executionStrategy,
    {
      needsClarification,
      needsDocumentGeneration,
      needsCompliance,
      needsKnowledge,
      needsGuidance,
      needsRecommendation,
      needsSql,
      needsReport,
      comparison,
      capabilities,
    },
  );

  const confidence = clampConfidence(input.confidence);

  return {
    intent: input.intent ?? null,
    capability,
    capabilities,
    entities,
    metrics,
    years,
    aggregation: input.aggregation ?? null,
    grouping: input.grouping ?? null,
    comparison,
    visualization,
    executionStrategy,
    requiredEngines,
    needsSql,
    needsReport,
    needsPdf,
    needsVisualization,
    needsRecommendation,
    needsKnowledge,
    needsGuidance,
    needsCompliance,
    needsDocumentGeneration,
    needsClarification,
    confidence,
    assumptions: Array.isArray(input.assumptions) ? input.assumptions.filter(Boolean).map(String) : [],
    reason: input.reason ?? null,
    clarification: input.clarification ?? null,
    filters: input.filters && typeof input.filters === 'object' ? { ...input.filters } : {},
    metadata: input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : {},
  };
}

/**
 * Validate an ExecutionPlan.
 * @param {ExecutionPlan|object} plan
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validateExecutionPlan(plan) {
  const errors = [];
  const warnings = [];

  if (!plan || typeof plan !== 'object') {
    return { ok: false, errors: ['ExecutionPlan is missing.'], warnings: [] };
  }

  if (plan.capability && !isValidCapability(plan.capability)) {
    errors.push(`Invalid capability: ${plan.capability}`);
  }
  for (const c of plan.capabilities || []) {
    if (!isValidCapability(c)) errors.push(`Invalid capability in list: ${c}`);
  }

  if (plan.executionStrategy && !EXECUTION_STRATEGIES.includes(plan.executionStrategy)) {
    errors.push(`Invalid executionStrategy: ${plan.executionStrategy}`);
  }

  if (plan.needsClarification && !plan.clarification && !plan.reason) {
    warnings.push('needsClarification is true but no clarification text was provided.');
  }

  if (plan.needsSql && plan.needsKnowledge && !plan.needsRecommendation && (plan.capabilities || []).length === 1) {
    warnings.push('Single-capability plan requests both SQL and knowledge — check routing.');
  }

  if (plan.needsVisualization && !plan.needsSql && !plan.needsReport) {
    warnings.push('needsVisualization without SQL or report data source.');
  }

  if (plan.comparison && plan.entities.length < 2 && !plan.needsClarification) {
    warnings.push('comparison=true with fewer than 2 entities.');
  }

  if (!(typeof plan.confidence === 'number') || Number.isNaN(plan.confidence)) {
    errors.push('confidence must be a number.');
  } else if (plan.confidence < 0 || plan.confidence > 1) {
    errors.push('confidence must be between 0 and 1.');
  }

  if (!Array.isArray(plan.requiredEngines)) {
    errors.push('requiredEngines must be an array.');
  }

  if (plan.needsSql && !plan.requiredEngines?.includes(EXECUTION_ENGINES.ANALYTICS)) {
    warnings.push('needsSql but analytics engine not listed in requiredEngines.');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Derive engine list from boolean needs flags.
 */
export function deriveRequiredEngines(flags = {}) {
  const engines = [];
  if (flags.needsClarification) return engines;
  if (flags.needsKnowledge) engines.push(EXECUTION_ENGINES.KNOWLEDGE);
  if (flags.needsCompliance) engines.push(EXECUTION_ENGINES.COMPLIANCE);
  if (flags.needsSql) engines.push(EXECUTION_ENGINES.ANALYTICS);
  if (flags.needsReport || flags.needsPdf) engines.push(EXECUTION_ENGINES.REPORT);
  if (flags.needsGuidance) engines.push(EXECUTION_ENGINES.GUIDANCE);
  if (flags.needsRecommendation) engines.push(EXECUTION_ENGINES.RECOMMENDATION);
  if (flags.needsDocumentGeneration) engines.push(EXECUTION_ENGINES.DOCUMENT);
  if (flags.needsVisualization) engines.push(EXECUTION_ENGINES.VISUALIZATION);
  return engines;
}

function normalizeStrategy(raw, ctx) {
  if (raw && EXECUTION_STRATEGIES.includes(raw)) return raw;
  if (ctx.needsClarification) return 'clarify';
  if (ctx.needsDocumentGeneration && ctx.capabilities?.length === 1) return 'document';
  if (ctx.needsCompliance && ctx.capabilities?.length === 1) return 'compliance';
  if (ctx.needsKnowledge && ctx.capabilities?.length === 1) return 'knowledge';
  if (ctx.needsGuidance && ctx.capabilities?.length === 1) return 'guidance';
  if (ctx.needsRecommendation) return 'recommendation';
  if (ctx.needsSql && (ctx.needsReport || ctx.comparison)) return 'hybrid';
  if (ctx.needsSql) return 'analytics';
  if (ctx.needsReport) return 'report';
  return 'llm_fallback';
}

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function uniqueStrings(list) {
  const out = [];
  const seen = new Set();
  for (const item of list || []) {
    if (item == null || item === '') continue;
    const key = String(item);
    const norm = key.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(key);
  }
  return out;
}
