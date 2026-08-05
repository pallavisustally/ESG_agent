/**
 * BRSR agent pipeline: Intent → Planner → Validate → Router → SQL/RAG → Response Validate.
 *
 * Default path: imperative stages (stable, no LangGraph required).
 * Optional path: USE_LANGGRAPH=true orchestrates the same stages via LangGraph.
 *
 * Falls back to the existing LLM tool loop in agent.js when handled=false.
 */

import {
  stagePreprocess,
  stageIntent,
  stageNormalizeEntities,
  stagePlanValidate,
  stageRouter,
  stagePrepareAnswerContext,
} from './pipeline-stages.js';
import { executeRoutedBranches } from './pipeline-execute.js';
import { buildIntentPromptAddon } from './pipeline-helpers.js';
import { isLangGraphEnabled } from './langgraph-config.js';
import { logPipelineStage } from '../observability/agent-logger.js';
import {
  createExecutionTrace,
  enrichTraceFromPipeline,
  summarizeVisualization,
} from '../observability/execution-trace.js';
import {
  recordFromPipelineResult,
  flushMonitoringSnapshot,
  getMonitoringSnapshot,
} from '../observability/monitoring.js';
import { ERROR_CODES } from '../errors/agent-errors.js';

export { buildIntentPromptAddon };

function finalizePipelineResult(result, {
  trace = null,
  elapsed = null,
  orchestrator = 'imperative',
  latencyBreakdown = null,
} = {}) {
  const latencyMs = elapsed?.() ?? result.latencyMs ?? null;
  let next = { ...result, orchestrator, latencyMs };

  const repairActions = next.repairActions || null;
  const visualization = next.visualizationSummary
    || summarizeVisualization({
      text: next.text,
      visualization: next.merged?.visualization || null,
      repairActions,
    });

  const composition = next.composition || {
    path: inferCompositionPath(next),
    capabilitiesUsed: next.capabilitiesUsed || [],
    engineCount: Array.isArray(next.engineResults) ? next.engineResults.length : 0,
    textLength: String(next.text || '').length,
    repairActions,
  };

  const breakdown = {
    ...(latencyBreakdown || {}),
    ...(next.latencyBreakdown || {}),
    totalMs: latencyMs,
  };

  let error = next.error || null;
  if (!error && next.executionPlan?.needsClarification) {
    error = {
      code: ERROR_CODES.CLARIFICATION,
      message: 'clarification_required',
      retryable: false,
      stage: 'execution_plan',
    };
  }
  if (!error) {
    const validation = next.validation || next.responseValidation;
    if (validation?.verdict === 'ERROR' || validation?.ok === false) {
      error = {
        code: ERROR_CODES.VALIDATION_FAILED,
        message: validation.reason || 'validation_failed',
        retryable: false,
        stage: 'response_validation',
      };
    }
  }

  if (trace) {
    enrichTraceFromPipeline(trace, {
      classification: next.classification,
      memory: next.memory,
      plan: next.plan,
      planValidation: {
        ...(next.planValidation || {}),
        replanCount: next.replanCount,
      },
      route: next.route,
      sql: next.sqlResult
        ? {
          ...next.sqlResult,
          path: next.sqlResult.path || (next.route?.mode === 'deterministic_sql' ? 'deterministic_sql' : 'sql'),
          durationMs: next.sqlResult.durationMs ?? null,
        }
        : null,
      fallback: next.documentFallback
        ? {
          ...next.documentFallback,
          confidence: next.documentFallback.confidence,
          attempts: next.documentFallback.attempts,
          durationMs: next.documentFallback.durationMs ?? null,
        }
        : null,
      responseValidation: next.validation || next.responseValidation || null,
      responseSource: next.responseSource || null,
      responseText: next.text || null,
      plannerScore: next.plannerScore || null,
      executionPlan: next.executionPlan || null,
      engines: next.engineTrace || null,
      visualization,
      composition,
      latencyBreakdown: breakdown,
      error,
      repairActions,
    });
    const flushed = trace.flush({
      ok: next.handled !== false && (!error || error.code === ERROR_CODES.CLARIFICATION),
      orchestrator,
      latencyMs,
      errorCode: error?.code || null,
    });
    next = { ...next, executionTrace: flushed, requestId: trace.requestId, error };
  }

  recordFromPipelineResult(next, { latencyMs, errorCode: error?.code || null });
  const snap = getMonitoringSnapshot();
  if (snap.requests > 0 && snap.requests % 25 === 0) {
    flushMonitoringSnapshot();
  }

  logPipelineStage('response', {
    intent: next.classification?.intent,
    mode: next.route?.mode,
    tool: orchestrator,
    ok: true,
    handled: next.handled,
    responseSource: next.responseSource,
    latencyMs,
    requestId: next.requestId,
    errorCode: error?.code || null,
  });

  return next;
}

function inferCompositionPath(result) {
  if (result.route?.mode === 'clarify' || result.executionPlan?.needsClarification) return 'clarify';
  if (result.responseSource === 'SQL' || result.route?.mode === 'deterministic_sql') return 'sql';
  if (result.responseSource === 'Narrative' || result.responseSource === 'PDF') return 'narrative';
  if (result.repairActions?.includes('safe_failure')) return 'safe_failure';
  if (result.capabilitiesUsed?.length || result.engineResults?.length) return 'capability_composer';
  return 'unknown';
}

/**
 * Imperative pipeline (default). Same stages LangGraph would run, without the graph runtime.
 */
export async function runImperativePipeline({
  userMessage,
  chatHistory = [],
  sessionId = null,
  onProgress = null,
} = {}) {
  const trace = createExecutionTrace({ userMessage, sessionId });
  let state = stagePreprocess({ userMessage, chatHistory, sessionId, onProgress });
  const elapsed = state.elapsed;
  let prevMs = 0;
  const phaseMs = () => {
    const now = elapsed?.() ?? 0;
    const delta = Math.max(0, now - prevMs);
    prevMs = now;
    return delta;
  };

  const latencyBreakdown = { preprocessMs: phaseMs() };
  state = { ...state, trace };

  state = await stageIntent(state);
  latencyBreakdown.intentMs = phaseMs();

  state = await stageNormalizeEntities(state);
  state = stagePlanValidate(state);
  state = stageRouter(state);
  state = stagePrepareAnswerContext(state);
  latencyBreakdown.planMs = phaseMs();

  state = { ...state, orchestrator: 'imperative', trace, latencyBreakdown };

  const result = await executeRoutedBranches(state);
  latencyBreakdown.executeMs = result.latencyBreakdown?.executeMs ?? phaseMs();
  if (result.latencyBreakdown?.composeMs != null) {
    latencyBreakdown.composeMs = result.latencyBreakdown.composeMs;
  }
  if (result.latencyBreakdown?.validateMs != null) {
    latencyBreakdown.validateMs = result.latencyBreakdown.validateMs;
  }

  return finalizePipelineResult(
    {
      ...result,
      plannerScore: result.plannerScore || state.plannerScore,
      latencyBreakdown: {
        ...latencyBreakdown,
        ...(result.latencyBreakdown || {}),
      },
    },
    {
      trace,
      elapsed: state.elapsed,
      orchestrator: 'imperative',
      latencyBreakdown,
    },
  );
}

/**
 * Entry point used by agent.js.
 * Uses LangGraph only when USE_LANGGRAPH=true and the optional package is available.
 */
export async function runBrsrPipeline(args) {
  if (isLangGraphEnabled()) {
    try {
      const { runLangGraphPipeline } = await import('./langgraph-orchestrator.js');
      logPipelineStage('orchestrator', { tool: 'langgraph', ok: true, message: 'Using LangGraph orchestration' });
      const trace = createExecutionTrace({
        userMessage: args?.userMessage,
        sessionId: args?.sessionId,
      });
      const result = await runLangGraphPipeline({ ...args, trace });
      return finalizePipelineResult(result, {
        trace: result.trace || trace,
        elapsed: result.elapsed || null,
        orchestrator: 'langgraph',
      });
    } catch (err) {
      if (err?.code === 'LANGGRAPH_UNAVAILABLE') {
        console.warn('[Pipeline] LangGraph unavailable — falling back to imperative pipeline:', err.message);
      } else {
        console.warn('[Pipeline] LangGraph failed — falling back to imperative pipeline:', err?.message || err);
      }
      return runImperativePipeline(args);
    }
  }
  return runImperativePipeline(args);
}
