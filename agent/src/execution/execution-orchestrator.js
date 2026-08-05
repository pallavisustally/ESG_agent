/**
 * Execution Orchestrator — follows ExecutionPlan; does not make routing decisions.
 *
 * Supports:
 *  - parallel independent engines
 *  - sequential dependencies (recommendation after analytics/report)
 *  - shared context / priorDataText
 *  - timeout per engine (best-effort)
 *  - result merge → Response Composer
 */

import { EXECUTION_ENGINES } from './execution-plan.js';
import {
  createEngineResponse,
  mergeEngineResponses,
  mergeEngineMemoryUpdates,
} from './engine-response.js';
import { toolPlanFromExecutionPlan } from './tool-plan-from-execution.js';
import {
  runAnalyticsEngine,
  runReportEngine,
  runKnowledgeEngine,
  runGuidanceEngine,
  runComplianceEngine,
  runRecommendationEngine,
  runDocumentEngine,
} from './engines/index.js';
import {
  composeCapabilityResults,
  sanitizeUserFacingText,
} from '../capability/response-composer.js';
import { CAPABILITIES } from '../capability/capabilities.js';
import { prependAssumptionNotes } from '../answers/assumptions.js';
import { appendVisualizationToText } from '../visualization/index.js';
import { applyAnswerValidation } from '../validation/answer-validator.js';
import {
  buildEnginesTracePayload,
  recordEngineRun,
  startTimer,
} from '../observability/engine-timing.js';
import { ERROR_CODES } from '../errors/agent-errors.js';
import { logPipelineStage } from '../observability/agent-logger.js';
import { shouldOmitFromComposition } from '../ops/soft-fail.js';
import { saveTurnMemory } from '../pipeline/pipeline-helpers.js';

const DEFAULT_ENGINE_TIMEOUT_MS = Number(process.env.EXECUTION_ENGINE_TIMEOUT_MS || 45000);

const ENGINE_RUNNERS = {
  [EXECUTION_ENGINES.KNOWLEDGE]: runKnowledgeEngine,
  [EXECUTION_ENGINES.COMPLIANCE]: runComplianceEngine,
  [EXECUTION_ENGINES.ANALYTICS]: runAnalyticsEngine,
  [EXECUTION_ENGINES.REPORT]: runReportEngine,
  [EXECUTION_ENGINES.GUIDANCE]: runGuidanceEngine,
  [EXECUTION_ENGINES.RECOMMENDATION]: runRecommendationEngine,
  [EXECUTION_ENGINES.DOCUMENT]: runDocumentEngine,
};

/** Engines that can run in parallel (no prior-data dependency). */
const PARALLEL_SAFE = new Set([
  EXECUTION_ENGINES.KNOWLEDGE,
  EXECUTION_ENGINES.COMPLIANCE,
  EXECUTION_ENGINES.GUIDANCE,
  EXECUTION_ENGINES.DOCUMENT,
]);

/**
 * Execute an ExecutionPlan via engines and compose the final response.
 *
 * @param {object} ctx
 * @param {import('./execution-plan.js').ExecutionPlan} ctx.executionPlan
 * @param {string} ctx.userMessage
 * @param {object} ctx.classification
 * @param {object|null} [ctx.memory]
 * @param {object|null} [ctx.toolPlan] - optional legacy plan override
 * @param {Function|null} [ctx.onProgress]
 * @param {number} [ctx.timeoutMs]
 * @param {string|null} [ctx.memoryKey] - when set, orchestrator persists merged engine memoryUpdate
 */
export async function executeExecutionPlan(ctx = {}) {
  const executionPlan = ctx.executionPlan;
  if (!executionPlan) {
    return {
      ok: false,
      handled: false,
      text: '',
      error: 'missing_execution_plan',
    };
  }

  if (executionPlan.needsClarification) {
    const text = executionPlan.clarification
      || 'I need a bit more detail to continue — which company should I use?';
    return {
      ok: true,
      handled: true,
      text,
      responseSource: 'Copilot',
      executionPlan,
      engineResults: [],
      engineTrace: buildEnginesTracePayload([], executionPlan.requiredEngines || []),
      composition: {
        path: 'clarify',
        capabilitiesUsed: [],
        engineCount: 0,
        textLength: text.length,
      },
      error: {
        code: ERROR_CODES.CLARIFICATION,
        message: text.slice(0, 200),
        retryable: false,
        stage: 'execution_plan',
      },
      forbidLlmFallback: true,
    };
  }

  const toolPlan = ctx.toolPlan || toolPlanFromExecutionPlan(executionPlan, ctx.classification);
  const timeoutMs = ctx.timeoutMs || DEFAULT_ENGINE_TIMEOUT_MS;
  const engines = [...(executionPlan.requiredEngines || [])]
    .filter((e) => e !== EXECUTION_ENGINES.VISUALIZATION); // viz embedded in analytics/report text

  const engineOrder = [];
  let orderIndex = 0;
  const shared = {
    executionPlan,
    userMessage: ctx.userMessage,
    classification: ctx.classification,
    memory: ctx.memory || null,
    toolPlan,
    onProgress: ctx.onProgress || null,
    priorDataText: null,
    analyticsFailed: false,
    analyticsData: null,
    requestId: ctx.requestId || ctx.trace?.requestId || null,
    engineOrder,
  };

  const results = [];
  const executeStarted = startTimer();

  // Phase A: parallel independent engines
  const parallel = engines.filter((e) => PARALLEL_SAFE.has(e));
  const sequential = engines.filter((e) => !PARALLEL_SAFE.has(e));

  if (parallel.length) {
    const parallelResults = await Promise.all(
      parallel.map((engine) => {
        const idx = orderIndex;
        orderIndex += 1;
        return runEngineWithTimeout(engine, shared, timeoutMs, 'parallel', idx);
      }),
    );
    results.push(...parallelResults);
  }

  // Phase B: analytics then report (report may use analytics failure)
  for (const engine of sequential) {
    if (engine === EXECUTION_ENGINES.RECOMMENDATION) continue; // after data
    const idx = orderIndex;
    orderIndex += 1;
    const result = await runEngineWithTimeout(engine, shared, timeoutMs, 'sequential', idx);
    results.push(result);
    if (engine === EXECUTION_ENGINES.ANALYTICS) {
      if (result.ok && result.dataText) {
        shared.priorDataText = appendData(shared.priorDataText, result.dataText);
        shared.analyticsData = result.data;
      } else {
        shared.analyticsFailed = true;
        // Auto document fallback when SQL miss and companies known
        if (executionPlan.entities?.length && !engines.includes(EXECUTION_ENGINES.REPORT)) {
          const fbIdx = orderIndex;
          orderIndex += 1;
          const reportResult = await runEngineWithTimeout(
            EXECUTION_ENGINES.REPORT,
            { ...shared, forceFallback: true },
            timeoutMs,
            'fallback',
            fbIdx,
          );
          if (reportResult.ok) {
            results.push(reportResult);
            shared.priorDataText = appendData(shared.priorDataText, reportResult.dataText);
          } else {
            results.push(reportResult);
          }
        }
      }
    }
    if (engine === EXECUTION_ENGINES.REPORT && result.ok && result.dataText) {
      shared.priorDataText = appendData(shared.priorDataText, result.dataText);
    }
  }

  // Phase C: recommendation (needs prior data when available)
  if (engines.includes(EXECUTION_ENGINES.RECOMMENDATION)) {
    // Best-effort peer payload from analytics compare/rank rows
    if (
      !shared.peerData
      && Array.isArray(shared.analyticsData?.rows)
      && shared.analyticsData.rows.length >= 2
    ) {
      shared.peerData = shared.analyticsData;
    }

    const idx = orderIndex;
    orderIndex += 1;
    const rec = await runEngineWithTimeout(
      EXECUTION_ENGINES.RECOMMENDATION,
      shared,
      timeoutMs,
      'recommendation',
      idx,
    );
    // Recommendation must never block analytics/report answers.
    if (rec?.ok && String(rec.text || '').trim()) {
      results.push(rec);
    } else if (rec) {
      results.push({
        ...rec,
        ok: false,
        text: '',
        recommendations: '',
        softOmitted: true,
      });
    }
  }

  const executeMs = executeStarted();
  const usable = results.filter((r) => !shouldOmitFromComposition(r));

  // Map engine results → capability-shaped results for existing composer
  const capabilityResults = usable.map((r) => ({
    capability: engineToCapability(r.engine),
    text: r.text,
    ok: r.ok,
    visualization: r.visualization,
    recommendations: r.recommendations,
    sources: (r.citations || []).map((c) => `- ${c}`).join('\n'),
    observations: '',
  }));

  const composeStarted = startTimer();
  // If analytics already embedded chart+insights in text, composer keeps it.
  let composed = composeCapabilityResults(capabilityResults, {
    userMessage: ctx.userMessage,
    multi: capabilityResults.length > 1,
  });

  // Attach viz sections when structured visualization payload exists without fence
  const vizResult = usable.find((r) => r.visualization?.chartBlock && r.text && !/```json-chart/.test(r.text));
  if (vizResult?.visualization?.chartBlock) {
    composed = {
      ...composed,
      text: appendVisualizationToText(composed.text, {
        ok: true,
        chartBlock: vizResult.visualization.chartBlock,
        insightMarkdown: vizResult.insights?.length
          ? ['', '**Chart insights**', ...vizResult.insights.map((i) => `- ${i}`)].join('\n')
          : '',
      }),
    };
  }

  const merged = mergeEngineResponses(usable);
  const assumptions = [
    ...(executionPlan.assumptions || []),
    ...merged.assumptions,
    ...(ctx.classification?.assumptions || []),
  ];
  let text = sanitizeUserFacingText(composed.text || '');
  text = prependAssumptionNotes(text, assumptions);
  const composeMs = composeStarted();

  // Unified answer validation — no engine path bypasses this gate.
  const validateStarted = startTimer();
  const primaryData = shared.analyticsData
    || usable.find((r) => r?.data?.rows || r?.data?.metric)?.data
    || merged.dataset
    || null;
  const applied = await applyAnswerValidation({
    text,
    classification: ctx.classification,
    executionPlan,
    engineResults: usable,
    data: primaryData,
    visualization: merged.visualization,
    citations: merged.citations,
    source: inferOrchestratorSource(executionPlan, usable),
  });
  text = applied.text;
  const validation = applied.validation;
  const validateMs = validateStarted();

  const engineTrace = buildEnginesTracePayload(engineOrder, engines);
  const failedEngine = engineOrder.find((r) => r.errorCode);
  let errorPayload = null;
  if (validation?.verdict === 'ERROR') {
    errorPayload = {
      code: ERROR_CODES.VALIDATION_FAILED,
      message: validation.reason || 'validation_failed',
      retryable: false,
      stage: 'response_validation',
    };
  } else if (failedEngine) {
    errorPayload = {
      code: failedEngine.errorCode || ERROR_CODES.ENGINE_FAILURE,
      message: failedEngine.error || 'engine_failure',
      retryable: failedEngine.errorCode === ERROR_CODES.TIMEOUT,
      stage: `engine:${failedEngine.engine}`,
    };
  }

  const ok = usable.some((r) => r.ok) && Boolean(text.trim()) && validation.verdict !== 'ERROR';
  const visualizationSummary = {
    present: Boolean(merged.visualization?.chartBlock || /```json-chart\b/i.test(text)),
    chartType: null,
    strippedByRepair: (applied.repairActions || []).includes('strip_chart_block'),
  };

  // Structured memory from engines (e.g. SQL ranking lastCompanies) — never from answer text.
  const memoryUpdate = mergeEngineMemoryUpdates(usable);
  let memory = ctx.memory || null;
  if (ctx.memoryKey) {
    if (Object.keys(memoryUpdate).length) {
      memory = saveTurnMemory(ctx.memoryKey, {
        classification: ctx.classification,
        plan: toolPlan,
        route: {
          mode: 'execution_planner',
          tools: executionPlan.requiredEngines,
          skipRag: !executionPlan.needsReport && !executionPlan.needsPdf,
        },
        // Engine patch is authoritative for companies — do not re-derive from data rows.
        data: null,
        patch: {
          ...memoryUpdate,
          pendingRequest: null,
        },
        assumptions,
      });
    } else {
      // No engine memory patch: refresh intent/metric/year without wiping prior companies.
      memory = saveTurnMemory(ctx.memoryKey, {
        classification: ctx.classification,
        plan: toolPlan,
        route: {
          mode: 'execution_planner',
          tools: executionPlan.requiredEngines,
          skipRag: !executionPlan.needsReport && !executionPlan.needsPdf,
        },
        data: null,
        patch: { pendingRequest: null },
        assumptions,
      });
    }
  }

  logPipelineStage('execution_orchestrator', {
    requestId: shared.requestId,
    intent: ctx.classification?.intent,
    strategy: executionPlan.executionStrategy,
    engines: engines,
    ok,
    tool: 'EXECUTION_PLANNER',
    latencyMs: executeMs + composeMs + validateMs,
    errorCode: errorPayload?.code || null,
    memoryCompanies: memory?.lastCompanies?.length || 0,
  });

  return {
    ok,
    handled: Boolean(text.trim()),
    text,
    responseSource: composed.responseSource || 'Copilot',
    capabilitiesUsed: composed.capabilitiesUsed || executionPlan.capabilities,
    executionPlan,
    toolPlan,
    engineResults: results,
    engineTrace,
    merged,
    memoryUpdate,
    memory,
    validation,
    responseValidation: validation,
    repairActions: applied.repairActions || [],
    visualizationSummary,
    composition: {
      path: 'capability_composer',
      capabilitiesUsed: composed.capabilitiesUsed || executionPlan.capabilities || [],
      engineCount: usable.length,
      textLength: String(text || '').length,
      repairActions: applied.repairActions || [],
    },
    latencyBreakdown: {
      executeMs,
      composeMs,
      validateMs,
    },
    error: errorPayload,
    forbidLlmFallback: Boolean(
      executionPlan.needsSql
      || executionPlan.needsKnowledge
      || executionPlan.needsGuidance
      || executionPlan.needsCompliance
      || executionPlan.needsDocumentGeneration
      || executionPlan.needsRecommendation
      || executionPlan.needsReport,
    ),
  };
}

function inferOrchestratorSource(executionPlan, usable) {
  if (executionPlan?.needsSql) return 'sql';
  const engines = (usable || []).map((r) => r?.engine);
  if (engines.includes(EXECUTION_ENGINES.ANALYTICS)) return 'sql';
  if (engines.includes(EXECUTION_ENGINES.REPORT)) return 'report';
  if (engines.includes(EXECUTION_ENGINES.KNOWLEDGE)) return 'knowledge';
  return 'composer';
}

async function runEngineWithTimeout(engine, shared, timeoutMs, phase = 'sequential', orderIndex = 0) {
  const runner = ENGINE_RUNNERS[engine];
  const elapsed = startTimer();
  if (!runner) {
    const result = createEngineResponse({
      engine,
      ok: false,
      text: '',
      error: `unknown_engine:${engine}`,
    });
    recordEngineRun({
      engine,
      phase,
      orderIndex,
      ok: false,
      durationMs: elapsed(),
      error: result.error,
      requestId: shared.requestId,
      intent: shared.classification?.intent,
      records: shared.engineOrder,
    });
    return result;
  }
  shared.onProgress?.({
    status: 'tool_start',
    tool: engine,
    message: `Running ${engine}…`,
  });

  const abortController = new AbortController();
  const onParentAbort = () => abortController.abort();
  if (shared.signal) {
    if (shared.signal.aborted) abortController.abort();
    else shared.signal.addEventListener('abort', onParentAbort, { once: true });
  }
  const engineShared = { ...shared, signal: abortController.signal };

  try {
    const result = await withTimeout(runner(engineShared), timeoutMs, engine, abortController);
    shared.onProgress?.({
      status: 'tool_end',
      tool: engine,
      message: `${engine} ready.`,
    });
    const durationMs = elapsed();
    result.durationMs = durationMs;
    recordEngineRun({
      engine,
      phase,
      orderIndex,
      ok: Boolean(result.ok),
      durationMs,
      error: result.error || null,
      requestId: shared.requestId,
      intent: shared.classification?.intent,
      records: shared.engineOrder,
    });
    return result;
  } catch (err) {
    shared.onProgress?.({
      status: 'tool_end',
      tool: engine,
      message: `${engine} failed.`,
    });
    const durationMs = elapsed();
    const error = String(err?.message || err);
    recordEngineRun({
      engine,
      phase,
      orderIndex,
      ok: false,
      durationMs,
      error,
      requestId: shared.requestId,
      intent: shared.classification?.intent,
      records: shared.engineOrder,
    });
    // Empty text — soft engines are omitted from composition; hard engines
    // can still surface a short safe line via their own catch paths.
    return createEngineResponse({
      engine,
      ok: false,
      text: '',
      error,
    });
  } finally {
    shared.signal?.removeEventListener?.('abort', onParentAbort);
  }
}

function withTimeout(promise, ms, label, abortController = null) {
  if (!ms || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { abortController?.abort(); } catch { /* ignore */ }
      reject(new Error(`${label}_timeout_${ms}ms`));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function appendData(prior, next) {
  if (!next) return prior;
  if (!prior) return next;
  return `${prior}\n\n${next}`;
}

function engineToCapability(engine) {
  switch (engine) {
    case EXECUTION_ENGINES.ANALYTICS:
      return CAPABILITIES.COMPANY_ANALYTICS;
    case EXECUTION_ENGINES.REPORT:
      return CAPABILITIES.COMPANY_REPORTS;
    case EXECUTION_ENGINES.KNOWLEDGE:
      return CAPABILITIES.ESG_KNOWLEDGE;
    case EXECUTION_ENGINES.GUIDANCE:
      return CAPABILITIES.ESG_GUIDANCE;
    case EXECUTION_ENGINES.COMPLIANCE:
      return CAPABILITIES.ESG_COMPLIANCE;
    case EXECUTION_ENGINES.RECOMMENDATION:
      return CAPABILITIES.RECOMMENDATION;
    case EXECUTION_ENGINES.DOCUMENT:
      return CAPABILITIES.DOCUMENT_GENERATION;
    default:
      return CAPABILITIES.ESG_KNOWLEDGE;
  }
}
