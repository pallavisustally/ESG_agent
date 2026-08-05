/**
 * Engine execution timing helper for the orchestrator.
 */

import { startTimer, logPipelineStage } from './agent-logger.js';
import { toErrorCode } from '../errors/agent-errors.js';

/**
 * @typedef {Object} EngineRunRecord
 * @property {string} engine
 * @property {'parallel'|'sequential'|'recommendation'|'fallback'} phase
 * @property {number} orderIndex
 * @property {boolean} ok
 * @property {number} durationMs
 * @property {string|null} error
 * @property {string|null} errorCode
 */

/**
 * Build the engines trace payload from run records.
 */
export function buildEnginesTracePayload(records = [], selected = []) {
  const order = Array.isArray(records) ? [...records] : [];
  const ran = order.map((r) => r.engine).filter(Boolean);
  const failed = order
    .filter((r) => !r.ok && r.error && !/_not_required$/i.test(String(r.error)))
    .map((r) => r.engine);
  return {
    selected: [...(selected || [])],
    ran,
    failed,
    order,
  };
}

/**
 * Create a run record and optionally log it.
 */
export function recordEngineRun({
  engine,
  phase = 'sequential',
  orderIndex = 0,
  ok = false,
  durationMs = 0,
  error = null,
  requestId = null,
  intent = null,
  records = null,
} = {}) {
  const softSkip = error && /_not_required$/i.test(String(error));
  const errorCode = (!ok && error && !softSkip) ? toErrorCode(error) : null;
  const record = {
    engine,
    phase,
    orderIndex,
    ok: Boolean(ok),
    durationMs: Number(durationMs) || 0,
    error: error ? String(error) : null,
    errorCode,
  };
  if (Array.isArray(records)) records.push(record);
  logPipelineStage('engine_execution', {
    requestId,
    intent,
    tool: engine,
    phase,
    orderIndex,
    ok: record.ok,
    latencyMs: record.durationMs,
    error: record.error,
    errorCode: record.errorCode,
  });
  return record;
}

export { startTimer };
