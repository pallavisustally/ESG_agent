/**
 * Phase 10/14/3 — Execution trace + monitoring unit tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createExecutionTrace,
  enrichTraceFromPipeline,
  summarizeVisualization,
  TRACE_STEPS,
} from './execution-trace.js';
import { buildEnginesTracePayload, recordEngineRun } from './engine-timing.js';
import { toErrorCode, ERROR_CODES } from '../errors/agent-errors.js';
import {
  resetMonitoringCounters,
  recordRequestMetrics,
  getMonitoringSnapshot,
  flushMonitoringSnapshot,
  aggregateObservabilityLog,
  recordFromPipelineResult,
} from './monitoring.js';

describe('execution-trace', () => {
  it('creates ordered steps including Phase 3 extensions', () => {
    const trace = createExecutionTrace({ userMessage: 'hello', sessionId: 's1' });
    trace.set('intent', { intent: 'METRIC_LOOKUP', confidence: 0.97 });
    trace.set('plan', { strategy: 'sql_company_metric' });
    const json = trace.toJSON();
    assert.equal(json.sessionId, 's1');
    assert.ok(json.requestId);
    assert.equal(json.steps.intent.confidence, 0.97);
    assert.ok(TRACE_STEPS.includes('execution_plan'));
    assert.ok(TRACE_STEPS.includes('engines'));
    assert.ok(TRACE_STEPS.includes('latency_breakdown'));
    assert.ok(TRACE_STEPS.includes('error'));
  });

  it('enrichTraceFromPipeline fills pipeline + Phase 3 fields', () => {
    const trace = createExecutionTrace({ userMessage: 'Scope 1 Infosys' });
    enrichTraceFromPipeline(trace, {
      classification: {
        intent: 'METRIC_LOOKUP',
        confidence: 0.9,
        entities: ['Infosys'],
        metric: 'scope1_emissions',
        metricResolution: 'FOUND',
        filters: { years: [2024] },
      },
      memory: { lastCompanies: ['Infosys'], lastMetric: 'scope1_emissions' },
      plan: { strategy: 'sql_company_metric', primaryTool: 'SQL', intent: 'METRIC_LOOKUP' },
      planValidation: { ok: true, errors: [], warnings: [], repairs: [] },
      route: { mode: 'execution_planner', tools: ['analytics'], skipRag: true },
      sql: { ok: true, sql: 'SELECT 1', data: { rows: [1] }, durationMs: 12, path: 'analytics' },
      responseValidation: { ok: true, verdict: 'PASS' },
      responseSource: 'Copilot',
      responseText: 'ok',
      plannerScore: { score: 0.88, dimensions: { tool: 1 }, reasons: [] },
      executionPlan: {
        executionStrategy: 'analytics',
        requiredEngines: ['analytics'],
        needsSql: true,
        confidence: 0.9,
      },
      engines: {
        selected: ['analytics'],
        ran: ['analytics'],
        failed: [],
        order: [{ engine: 'analytics', phase: 'sequential', orderIndex: 0, ok: true, durationMs: 10 }],
      },
      visualization: { present: false },
      composition: { path: 'capability_composer', engineCount: 1, textLength: 2 },
      latencyBreakdown: { intentMs: 1, planMs: 2, executeMs: 10, totalMs: 15 },
      repairActions: [],
    });
    const json = trace.toJSON();
    assert.equal(json.steps.final_source.source, 'Copilot');
    assert.equal(json.steps.execution_plan.strategy, 'analytics');
    assert.equal(json.steps.engines.ran[0], 'analytics');
    assert.equal(json.steps.sql.durationMs, 12);
    assert.equal(json.steps.latency_breakdown.executeMs, 10);
    assert.equal(json.steps.response_validation.verdict, 'PASS');
  });

  it('summarizeVisualization detects chart blocks', () => {
    const viz = summarizeVisualization({
      text: '```json-chart\n{"chartType":"bar","labels":["A"],"datasets":[{"data":[1]}]}\n```',
    });
    assert.equal(viz.present, true);
    assert.equal(viz.chartType, 'bar');
    assert.equal(viz.labelCount, 1);
  });
});

describe('engine-timing + error codes', () => {
  it('records engine runs into order array', () => {
    const records = [];
    recordEngineRun({
      engine: 'knowledge',
      phase: 'parallel',
      orderIndex: 0,
      ok: true,
      durationMs: 5,
      records,
    });
    const payload = buildEnginesTracePayload(records, ['knowledge']);
    assert.deepEqual(payload.ran, ['knowledge']);
    assert.equal(payload.failed.length, 0);
  });

  it('toErrorCode maps timeouts and validation', () => {
    assert.equal(toErrorCode(new Error('analytics_timeout_1000ms')), ERROR_CODES.TIMEOUT);
    assert.equal(
      toErrorCode(null, { validation: { verdict: 'ERROR' } }),
      ERROR_CODES.VALIDATION_FAILED,
    );
    assert.equal(toErrorCode(null, { clarification: true }), ERROR_CODES.CLARIFICATION);
  });
});

describe('monitoring', () => {
  it('computes rates from counters including error codes', () => {
    resetMonitoringCounters();
    for (let i = 0; i < 10; i += 1) {
      recordRequestMetrics({
        sqlAttempted: true,
        sqlMiss: i < 3,
        pdfFallback: i < 2,
        clarification: i === 0,
        planValidationFailed: i === 9,
        responseValidationFailed: i === 8,
        wrongTool: i === 7,
        engineFailure: i === 6,
        engineTimeout: i === 5,
        errorCode: i === 5 ? 'TIMEOUT' : (i === 6 ? 'ENGINE_FAILURE' : null),
        latencyMs: 100 + i,
      });
    }
    const snap = getMonitoringSnapshot();
    assert.equal(snap.requests, 10);
    assert.equal(snap.sqlMisses, 3);
    assert.equal(snap.pdfFallbacks, 2);
    assert.equal(snap.clarifications, 1);
    assert.equal(snap.engineFailures, 1);
    assert.equal(snap.engineTimeouts, 1);
    assert.equal(snap.errorsByCode.TIMEOUT, 1);
    assert.ok(snap.sqlMissRate > 0);
    assert.ok(snap.averageLatencyMs >= 100);
  });

  it('recordFromPipelineResult captures engineTrace failures', () => {
    resetMonitoringCounters();
    recordFromPipelineResult({
      classification: { confidence: 0.9 },
      route: { mode: 'execution_planner' },
      executionPlan: { needsSql: true },
      engineTrace: {
        failed: ['analytics'],
        order: [{ engine: 'analytics', ok: false, errorCode: 'TIMEOUT' }],
      },
      error: { code: 'TIMEOUT' },
      responseValidation: { ok: true, verdict: 'PASS' },
    }, { latencyMs: 40, errorCode: 'TIMEOUT' });
    const snap = getMonitoringSnapshot();
    assert.equal(snap.engineTimeouts, 1);
    assert.equal(snap.errorsByCode.TIMEOUT, 1);
  });

  it('tracks recommendation metrics, warnings, and slowest requests', () => {
    resetMonitoringCounters();
    recordFromPipelineResult({
      requestId: 'req-slow',
      classification: { intent: 'METRIC_LOOKUP', confidence: 0.9 },
      route: { mode: 'execution_planner' },
      executionPlan: { needsSql: true, needsRecommendation: true, executionStrategy: 'recommendation' },
      engineTrace: {
        failed: ['recommendation'],
        order: [
          { engine: 'analytics', ok: true, errorCode: null },
          { engine: 'recommendation', ok: false, errorCode: 'TIMEOUT' },
        ],
      },
      responseValidation: { ok: true, verdict: 'WARNING' },
    }, { latencyMs: 9000 });
    const snap = getMonitoringSnapshot();
    assert.equal(snap.recommendationRuns, 1);
    assert.equal(snap.recommendationFailures, 1);
    assert.equal(snap.responseValidationWarnings, 1);
    assert.equal(snap.slowRequestCount, 1);
    assert.ok(snap.slowestRequests.some((r) => r.requestId === 'req-slow' && r.latencyMs === 9000));
    assert.ok(snap.sqlSuccessRate == null || snap.sqlSuccessRate <= 1);
  });

  it('flushMonitoringSnapshot writes metrics object', () => {
    resetMonitoringCounters();
    recordRequestMetrics({ latencyMs: 50 });
    const snap = flushMonitoringSnapshot();
    assert.equal(snap.requests, 1);
    assert.ok(snap.ts);
  });

  it('aggregateObservabilityLog handles missing file', () => {
    const agg = aggregateObservabilityLog({
      logPath: '/tmp/does-not-exist-agent-obs.jsonl',
    });
    assert.equal(agg.ok, false);
  });
});
