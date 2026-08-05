/**
 * Phase 10/3 — Execution trace for every request.
 *
 * Trace shape (stored as JSONL via agent-logger):
 *   User → Intent → Entities → Metric State → Memory → Plan →
 *   Planner Validation → Tool → Execution Plan → Engines →
 *   SQL → Fallback → Visualization → Validation → Composition →
 *   Final Source → Response → Latency Breakdown → Error
 */

import { logAgentEvent } from './agent-logger.js';

const TRACE_STEPS = [
  'user',
  'intent',
  'entities',
  'metric_state',
  'memory',
  'plan',
  'planner_validation',
  'tool',
  'execution_plan',
  'engines',
  'sql',
  'fallback',
  'visualization',
  'response_validation',
  'composition',
  'final_source',
  'response',
  'latency_breakdown',
  'error',
];

/**
 * Create a mutable per-request execution trace.
 */
export function createExecutionTrace({
  requestId = null,
  userMessage = '',
  sessionId = null,
} = {}) {
  const id = requestId || `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  const steps = {};

  return {
    requestId: id,
    sessionId,
    startedAt,
    userMessage: String(userMessage || '').slice(0, 500),

    /** Record or merge a named step. */
    set(step, payload = {}) {
      if (!TRACE_STEPS.includes(step) && step !== 'planner_score' && step !== 'monitoring') {
        // Allow extension steps but keep canonical list primary.
      }
      steps[step] = {
        ...(steps[step] || {}),
        ...payload,
        at: new Date().toISOString(),
      };
      return this;
    },

    get(step) {
      return steps[step] || null;
    },

    /** Snapshot for logging / API. */
    toJSON() {
      const ordered = {};
      for (const name of TRACE_STEPS) {
        if (steps[name]) ordered[name] = steps[name];
      }
      for (const [k, v] of Object.entries(steps)) {
        if (!ordered[k]) ordered[k] = v;
      }
      return {
        requestId: id,
        sessionId,
        userMessage: String(userMessage || '').slice(0, 500),
        startedAt: new Date(startedAt).toISOString(),
        latencyMs: Date.now() - startedAt,
        steps: ordered,
      };
    },

    /** Persist full trace as one JSONL row. */
    flush(extra = {}) {
      const body = this.toJSON();
      logAgentEvent({
        stage: 'execution_trace',
        requestId: id,
        ok: extra.ok ?? true,
        errorCode: body.steps?.error?.code || extra.errorCode || null,
        ...body,
        ...extra,
      });
      return body;
    },
  };
}

/**
 * Attach common pipeline fields onto a trace from state/result.
 */
export function enrichTraceFromPipeline(trace, {
  classification = null,
  memory = null,
  plan = null,
  planValidation = null,
  route = null,
  sql = null,
  fallback = null,
  responseValidation = null,
  responseSource = null,
  responseText = null,
  plannerScore = null,
  executionPlan = null,
  engines = null,
  visualization = null,
  composition = null,
  latencyBreakdown = null,
  error = null,
  repairActions = null,
} = {}) {
  if (!trace) return null;

  trace.set('user', { message: trace.userMessage });

  if (classification) {
    trace.set('intent', {
      intent: classification.intent,
      canonicalIntent: classification.canonicalIntent || null,
      confidence: classification.confidence,
      source: classification.source || null,
    });
    trace.set('entities', {
      companies: classification.entities || [],
      years: classification.filters?.years || [],
      sector: classification.filters?.sector || null,
    });
    trace.set('metric_state', {
      metric: classification.metric || null,
      resolution: classification.metricResolution
        || classification.filters?.metricResolution
        || null,
      unsupported: Boolean(classification.filters?.unsupportedMetric),
      derived: Boolean(classification.filters?.derivedMetric),
    });
  }

  if (memory) {
    trace.set('memory', {
      lastIntent: memory.lastIntent || null,
      lastCompanies: memory.lastCompanies || memory.entities || [],
      lastMetric: memory.lastMetric || memory.filters?.metric || null,
      lastYear: memory.lastYear || null,
      pendingRequest: Boolean(memory.pendingRequest),
      comparisonContext: memory.comparisonContext || null,
    });
  }

  if (plan) {
    trace.set('plan', {
      intent: plan.intent,
      strategy: plan.strategy,
      primaryTool: plan.primaryTool,
      metric: plan.metric || null,
      entities: plan.entities || [],
      reason: plan.reason || null,
      confidence: plan.confidence,
    });
  }

  if (planValidation) {
    trace.set('planner_validation', {
      ok: planValidation.ok,
      errors: planValidation.errors || [],
      warnings: planValidation.warnings || [],
      repairs: (planValidation.repairs || []).map((r) => r.type || r),
      replanCount: planValidation.replanCount ?? null,
    });
  }

  if (plannerScore) {
    trace.set('planner_score', {
      score: plannerScore.score,
      dimensions: plannerScore.dimensions || null,
      reasons: plannerScore.reasons || [],
    });
  }

  if (route) {
    trace.set('tool', {
      mode: route.mode,
      tools: route.tools || [],
      skipRag: route.skipRag,
    });
  }

  if (executionPlan) {
    trace.set('execution_plan', {
      strategy: executionPlan.executionStrategy || null,
      requiredEngines: executionPlan.requiredEngines || [],
      capabilities: executionPlan.capabilities || [],
      needsSql: Boolean(executionPlan.needsSql),
      needsReport: Boolean(executionPlan.needsReport),
      needsPdf: Boolean(executionPlan.needsPdf),
      needsVisualization: Boolean(executionPlan.needsVisualization),
      needsKnowledge: Boolean(executionPlan.needsKnowledge),
      needsGuidance: Boolean(executionPlan.needsGuidance),
      needsCompliance: Boolean(executionPlan.needsCompliance),
      needsRecommendation: Boolean(executionPlan.needsRecommendation),
      needsDocumentGeneration: Boolean(executionPlan.needsDocumentGeneration),
      needsClarification: Boolean(executionPlan.needsClarification),
      confidence: executionPlan.confidence ?? null,
      reason: executionPlan.reason || null,
    });
  }

  if (engines) {
    trace.set('engines', engines);
  }

  if (sql) {
    trace.set('sql', {
      ok: sql.ok ?? null,
      sql: typeof sql.sql === 'string' ? sql.sql.slice(0, 800) : null,
      reason: sql.reason || sql.error || null,
      rowCount: Array.isArray(sql.data?.rows) ? sql.data.rows.length : null,
      durationMs: sql.durationMs ?? null,
      path: sql.path || null,
      attempts: sql.attempts ?? null,
    });
  }

  if (fallback) {
    trace.set('fallback', {
      source: fallback.source || null,
      company: fallback.company || null,
      year: fallback.year ?? null,
      confidence: fallback.confidence ?? null,
      attempts: fallback.attempts || null,
      durationMs: fallback.durationMs ?? null,
      chunkCount: fallback.chunkCount ?? null,
      pdfUrlPresent: fallback.pdfUrlPresent ?? null,
    });
  }

  if (visualization) {
    trace.set('visualization', visualization);
  }

  if (responseValidation) {
    trace.set('response_validation', {
      verdict: responseValidation.verdict || (responseValidation.ok === false ? 'ERROR' : (responseValidation.warnings?.length ? 'WARNING' : 'PASS')),
      ok: responseValidation.ok,
      reason: responseValidation.reason || null,
      errors: responseValidation.errors || [],
      warnings: responseValidation.warnings || [],
      issues: responseValidation.issues || [],
      shouldReplan: Boolean(responseValidation.shouldReplan),
      checks: responseValidation.checks || null,
      repairActions: repairActions || responseValidation.repairActions || null,
    });
  }

  if (composition) {
    trace.set('composition', composition);
  }

  if (responseSource != null) {
    trace.set('final_source', { source: responseSource });
  }

  if (responseText != null) {
    trace.set('response', {
      length: String(responseText).length,
      preview: String(responseText).slice(0, 240),
    });
  }

  if (latencyBreakdown) {
    trace.set('latency_breakdown', latencyBreakdown);
  }

  if (error) {
    trace.set('error', {
      code: error.code || null,
      message: error.message || null,
      retryable: Boolean(error.retryable),
      status: error.status ?? null,
      stage: error.stage || null,
    });
  }

  return trace;
}

/**
 * Summarize visualization for the trace from text / viz payload.
 */
export function summarizeVisualization({ text = '', visualization = null, repairActions = [] } = {}) {
  const block = visualization?.chartBlock || '';
  const body = String(text || '');
  const hasBlock = /```json-chart\b/i.test(body) || Boolean(block);
  if (!hasBlock) {
    return { present: false };
  }
  let chartType = null;
  let labelCount = null;
  let seriesCount = null;
  const raw = block || (body.match(/```json-chart\s*([\s\S]*?)\s*```/i) || [])[1];
  if (raw) {
    try {
      const cfg = JSON.parse(raw);
      chartType = cfg.chartType || cfg.type || null;
      labelCount = Array.isArray(cfg.labels) ? cfg.labels.length : null;
      seriesCount = Array.isArray(cfg.datasets) ? cfg.datasets.length
        : (Array.isArray(cfg.series) ? cfg.series.length : null);
    } catch {
      // ignore parse errors
    }
  }
  return {
    present: true,
    chartType,
    labelCount,
    seriesCount,
    strippedByRepair: Array.isArray(repairActions) && repairActions.includes('strip_chart_block'),
  };
}

export { TRACE_STEPS };
