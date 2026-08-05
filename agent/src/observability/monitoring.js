/**
 * Phase 14 / Production Readiness Part 2 — Production monitoring metrics.
 *
 * Aggregates from agent_observability.jsonl + in-process counters:
 * - Wrong tool selection, planner failures
 * - SQL miss / PDF / narrative fallback rates
 * - Clarification rate, validation warnings/failures
 * - Engine failures/timeouts, recommendation usage
 * - Average latency + slowest recent requests
 */

import fs from 'fs';
import path from 'path';
import { resolveFromProject } from '../paths.js';
import { logAgentEvent } from './agent-logger.js';

const LOG_PATH = resolveFromProject('data', 'agent_observability.jsonl');
const METRICS_PATH = resolveFromProject('data', 'agent_monitoring_metrics.json');

const SLOW_REQUEST_MS = Number(process.env.SLOW_REQUEST_MS || 5000);
const RECENT_REQUEST_RING = Math.max(10, Number(process.env.MONITORING_RECENT_RING || 50));
const SLOWEST_LIMIT = Math.max(5, Number(process.env.MONITORING_SLOWEST_LIMIT || 10));

/** In-process counters (reset on process restart; also mirrored into JSONL). */
const counters = {
  requests: 0,
  wrongToolSelection: 0,
  plannerFailures: 0,
  plannerReplans: 0,
  sqlAttempts: 0,
  sqlMisses: 0,
  pdfFallbacks: 0,
  narrativeFallbacks: 0,
  clarifications: 0,
  planValidationFailures: 0,
  responseValidationFailures: 0,
  responseValidationWarnings: 0,
  lowIntentConfidence: 0,
  engineFailures: 0,
  engineTimeouts: 0,
  recommendationRuns: 0,
  recommendationFailures: 0,
  errorsByCode: {},
  latencySumMs: 0,
  latencyCount: 0,
};

/** @type {{ requestId: string|null, latencyMs: number, ts: string, intent: string|null, strategy: string|null, slow: boolean }[]} */
const recentRequests = [];

export function resetMonitoringCounters() {
  for (const key of Object.keys(counters)) {
    if (key === 'errorsByCode') counters[key] = {};
    else counters[key] = 0;
  }
  recentRequests.length = 0;
}

function pushRecentRequest(entry) {
  recentRequests.push(entry);
  while (recentRequests.length > RECENT_REQUEST_RING) recentRequests.shift();
}

function getSlowestRequests(limit = SLOWEST_LIMIT) {
  return [...recentRequests]
    .sort((a, b) => b.latencyMs - a.latencyMs)
    .slice(0, limit);
}

/**
 * Record a completed request outcome for monitoring.
 */
export function recordRequestMetrics({
  wrongTool = false,
  plannerFailed = false,
  replanCount = 0,
  sqlAttempted = false,
  sqlMiss = false,
  pdfFallback = false,
  narrativeFallback = false,
  clarification = false,
  planValidationFailed = false,
  responseValidationFailed = false,
  responseValidationWarning = false,
  lowIntentConfidence = false,
  engineFailure = false,
  engineTimeout = false,
  recommendationRun = false,
  recommendationFailure = false,
  errorCode = null,
  latencyMs = null,
  requestId = null,
  intent = null,
  strategy = null,
} = {}) {
  counters.requests += 1;
  if (wrongTool) counters.wrongToolSelection += 1;
  if (plannerFailed) counters.plannerFailures += 1;
  if (replanCount > 0) counters.plannerReplans += replanCount;
  if (sqlAttempted) counters.sqlAttempts += 1;
  if (sqlMiss) counters.sqlMisses += 1;
  if (pdfFallback) counters.pdfFallbacks += 1;
  if (narrativeFallback) counters.narrativeFallbacks += 1;
  if (clarification) counters.clarifications += 1;
  if (planValidationFailed) counters.planValidationFailures += 1;
  if (responseValidationFailed) counters.responseValidationFailures += 1;
  if (responseValidationWarning) counters.responseValidationWarnings += 1;
  if (lowIntentConfidence) counters.lowIntentConfidence += 1;
  if (engineFailure) counters.engineFailures += 1;
  if (engineTimeout) counters.engineTimeouts += 1;
  if (recommendationRun) counters.recommendationRuns += 1;
  if (recommendationFailure) counters.recommendationFailures += 1;
  if (errorCode) {
    counters.errorsByCode[errorCode] = (counters.errorsByCode[errorCode] || 0) + 1;
  }
  if (latencyMs != null && Number.isFinite(Number(latencyMs))) {
    const ms = Number(latencyMs);
    counters.latencySumMs += ms;
    counters.latencyCount += 1;
    pushRecentRequest({
      requestId: requestId || null,
      latencyMs: ms,
      ts: new Date().toISOString(),
      intent: intent || null,
      strategy: strategy || null,
      slow: ms >= SLOW_REQUEST_MS,
    });
  }
}

function rate(num, den) {
  if (!den) return 0;
  return Math.round((num / den) * 1000) / 1000;
}

/**
 * Snapshot current in-memory counters as rates.
 */
export function getMonitoringSnapshot() {
  const avgLatencyMs = counters.latencyCount
    ? Math.round(counters.latencySumMs / counters.latencyCount)
    : null;

  const sqlSuccessRate = counters.sqlAttempts
    ? rate(counters.sqlAttempts - counters.sqlMisses, counters.sqlAttempts)
    : null;

  return {
    ts: new Date().toISOString(),
    requests: counters.requests,
    wrongToolSelection: counters.wrongToolSelection,
    wrongToolRate: rate(counters.wrongToolSelection, counters.requests),
    plannerFailures: counters.plannerFailures,
    plannerFailureRate: rate(counters.plannerFailures, counters.requests),
    plannerReplans: counters.plannerReplans,
    sqlMissRate: rate(counters.sqlMisses, counters.sqlAttempts || counters.requests),
    sqlSuccessRate,
    sqlAttempts: counters.sqlAttempts,
    sqlMisses: counters.sqlMisses,
    pdfFallbackRate: rate(counters.pdfFallbacks, counters.requests),
    pdfFallbacks: counters.pdfFallbacks,
    narrativeFallbacks: counters.narrativeFallbacks,
    reportLookupRate: rate(counters.narrativeFallbacks + counters.pdfFallbacks, counters.requests),
    clarificationRate: rate(counters.clarifications, counters.requests),
    clarifications: counters.clarifications,
    planValidationFailures: counters.planValidationFailures,
    planValidationFailureRate: rate(counters.planValidationFailures, counters.requests),
    responseValidationFailures: counters.responseValidationFailures,
    responseValidationFailureRate: rate(counters.responseValidationFailures, counters.requests),
    responseValidationWarnings: counters.responseValidationWarnings,
    responseValidationWarningRate: rate(counters.responseValidationWarnings, counters.requests),
    lowIntentConfidence: counters.lowIntentConfidence,
    lowIntentConfidenceRate: rate(counters.lowIntentConfidence, counters.requests),
    engineFailures: counters.engineFailures,
    engineFailureRate: rate(counters.engineFailures, counters.requests),
    engineTimeouts: counters.engineTimeouts,
    engineTimeoutRate: rate(counters.engineTimeouts, counters.requests),
    recommendationRuns: counters.recommendationRuns,
    recommendationFailures: counters.recommendationFailures,
    recommendationUsageRate: rate(counters.recommendationRuns, counters.requests),
    recommendationFailureRate: rate(
      counters.recommendationFailures,
      counters.recommendationRuns || counters.requests,
    ),
    errorsByCode: { ...counters.errorsByCode },
    averageLatencyMs: avgLatencyMs,
    slowRequestThresholdMs: SLOW_REQUEST_MS,
    slowRequestCount: recentRequests.filter((r) => r.slow).length,
    slowestRequests: getSlowestRequests(),
  };
}

/**
 * Persist snapshot to disk + JSONL event.
 */
export function flushMonitoringSnapshot() {
  const snapshot = getMonitoringSnapshot();
  try {
    const dir = path.dirname(METRICS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(METRICS_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  } catch (err) {
    console.warn('[Monitoring] failed to write metrics file:', err.message);
  }
  logAgentEvent({ stage: 'monitoring_snapshot', ...snapshot, slowestRequests: undefined });
  return snapshot;
}

/**
 * Infer metrics from a finished pipeline result / trace.
 */
export function recordFromPipelineResult(result = {}, { latencyMs = null, errorCode = null } = {}) {
  const classification = result.classification || {};
  const plan = result.plan || {};
  const route = result.route || {};
  const planValidation = result.planValidation || {};
  const responseValidation = result.responseValidation || result.validation || null;
  const documentFallback = result.documentFallback || null;
  const responseSource = result.responseSource || null;
  const resolvedErrorCode = errorCode
    || result.error?.code
    || null;

  const clarification = route.mode === 'clarify'
    || plan.strategy === 'clarify_prior_companies'
    || resolvedErrorCode === 'CLARIFICATION'
    || Boolean(result.clarification && result.handled && route.mode === 'clarify');

  const sqlAttempted = Boolean(
    result.sqlResult
    || responseSource === 'SQL'
    || route.mode === 'deterministic_sql'
    || result.executionPlan?.needsSql,
  );
  const sqlMiss = Boolean(
    result.sqlResult && result.sqlResult.ok === false,
  ) || responseSource === 'Narrative'
    || responseSource === 'PDF'
    || responseSource === 'Unavailable';

  const pdfFallback = documentFallback?.source === 'pdf' || responseSource === 'PDF';
  const narrativeFallback = documentFallback?.source === 'narrative' || responseSource === 'Narrative';

  const plannerScore = result.plannerScore;
  const wrongTool = Boolean(
    plannerScore?.dimensions?.tool != null && plannerScore.dimensions.tool < 0.2,
  ) || (planValidation.errors || []).some((e) => /tool|strategy/i.test(e));

  const engineOrder = result.engineTrace?.order || [];
  const engineFailed = Boolean(
    result.engineTrace?.failed?.length
    || resolvedErrorCode === 'ENGINE_FAILURE'
    || resolvedErrorCode === 'TIMEOUT',
  );
  const engineTimeout = resolvedErrorCode === 'TIMEOUT'
    || engineOrder.some((r) => r.errorCode === 'TIMEOUT');

  const recRuns = engineOrder.filter((r) => r.engine === 'recommendation' && !/_not_required$/i.test(String(r.error || '')));
  const recommendationRun = recRuns.length > 0
    || Boolean(result.executionPlan?.needsRecommendation);
  const recommendationFailure = recRuns.some((r) => !r.ok)
    || (result.engineTrace?.failed || []).includes('recommendation');

  recordRequestMetrics({
    wrongTool,
    plannerFailed: planValidation.ok === false,
    replanCount: result.replanCount || 0,
    sqlAttempted,
    sqlMiss: sqlAttempted && (sqlMiss || pdfFallback || narrativeFallback),
    pdfFallback,
    narrativeFallback,
    clarification,
    planValidationFailed: planValidation.ok === false,
    responseValidationFailed: responseValidation?.ok === false
      || responseValidation?.verdict === 'ERROR',
    responseValidationWarning: responseValidation?.verdict === 'WARNING',
    lowIntentConfidence: Number(classification.confidence) > 0
      && Number(classification.confidence) < Number(process.env.PLAN_MIN_CONFIDENCE || 0.45),
    engineFailure: engineFailed,
    engineTimeout,
    recommendationRun,
    recommendationFailure,
    errorCode: resolvedErrorCode,
    latencyMs: latencyMs ?? result.latencyMs ?? null,
    requestId: result.requestId || result.trace?.requestId || null,
    intent: classification.intent || result.executionPlan?.intent || null,
    strategy: result.executionPlan?.executionStrategy || route.mode || null,
  });

  return getMonitoringSnapshot();
}

/**
 * Aggregate historical JSONL (best-effort). Useful for dashboards / ops scripts.
 * @param {{ maxLines?: number, logPath?: string }} [opts]
 */
export function aggregateObservabilityLog({
  maxLines = 5000,
  logPath = LOG_PATH,
} = {}) {
  const summary = {
    events: 0,
    byStage: {},
    planValidationFailures: 0,
    responseValidationFailures: 0,
    responseValidationWarnings: 0,
    clarifications: 0,
    sqlDocumentFallbacks: 0,
    pdfSources: 0,
    narrativeSources: 0,
    recommendationRuns: 0,
    recommendationFailures: 0,
    latencies: [],
  };

  if (!fs.existsSync(logPath)) {
    return { ...summary, averageLatencyMs: null, ok: false, reason: 'missing_log' };
  }

  let lines;
  try {
    const raw = fs.readFileSync(logPath, 'utf8');
    lines = raw.split('\n').filter(Boolean);
    if (lines.length > maxLines) lines = lines.slice(-maxLines);
  } catch (err) {
    return { ...summary, averageLatencyMs: null, ok: false, reason: err.message };
  }

  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    summary.events += 1;
    const stage = row.stage || 'unknown';
    summary.byStage[stage] = (summary.byStage[stage] || 0) + 1;

    if (stage === 'plan_validate' && row.ok === false) summary.planValidationFailures += 1;
    if (stage === 'response_validate' && row.ok === false) summary.responseValidationFailures += 1;
    if (stage === 'response_validate' && row.verdict === 'WARNING') summary.responseValidationWarnings += 1;
    if (stage === 'clarify_prior_companies' || row.mode === 'clarify') summary.clarifications += 1;
    if (stage === 'sql_document_fallback') {
      summary.sqlDocumentFallbacks += 1;
      if (row.source === 'pdf' || row.responseSource === 'PDF') summary.pdfSources += 1;
      if (row.source === 'narrative' || row.responseSource === 'Narrative') summary.narrativeSources += 1;
    }
    if (stage === 'engine_execution' && row.tool === 'recommendation') {
      summary.recommendationRuns += 1;
      if (row.ok === false) summary.recommendationFailures += 1;
    }
    if (row.latencyMs != null && Number.isFinite(Number(row.latencyMs))) {
      summary.latencies.push(Number(row.latencyMs));
    }
  }

  const averageLatencyMs = summary.latencies.length
    ? Math.round(summary.latencies.reduce((a, b) => a + b, 0) / summary.latencies.length)
    : null;

  return {
    ...summary,
    latencies: undefined,
    averageLatencyMs,
    wrongToolHint: summary.planValidationFailures,
    sqlMissHint: summary.sqlDocumentFallbacks,
    pdfFallbackRate: summary.events
      ? Math.round((summary.pdfSources / summary.events) * 1000) / 1000
      : 0,
    clarificationRate: summary.events
      ? Math.round((summary.clarifications / summary.events) * 1000) / 1000
      : 0,
    ok: true,
  };
}

export { counters as _monitoringCounters, LOG_PATH, METRICS_PATH, recentRequests as _recentRequests };
