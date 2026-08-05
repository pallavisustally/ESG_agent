/**
 * Phase 4 — Observability logging.
 *
 * Default: synchronous appendFileSync (tests / rollback).
 * Opt-in: ASYNC_LOGGING=true buffers and flushes on interval.
 */

import fs from 'fs';
import path from 'path';
import { resolveFromProject } from '../paths.js';

const LOG_PATH = resolveFromProject('data', 'agent_observability.jsonl');

let dirReady = false;
function ensureDir() {
  if (dirReady) return;
  const dir = path.dirname(LOG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  dirReady = true;
}

function isAsyncLoggingEnabled() {
  return process.env.ASYNC_LOGGING === 'true';
}

function flushIntervalMs() {
  const n = Number(process.env.ASYNC_LOG_FLUSH_MS);
  return Number.isFinite(n) && n > 0 ? n : 2000;
}

const asyncBuffer = [];
let flushTimer = null;
let flushing = false;

function scheduleFlush() {
  if (flushTimer || !isAsyncLoggingEnabled()) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushAsyncLogs().catch((err) => {
      console.warn('[AgentObs] async flush failed:', err.message);
    });
  }, flushIntervalMs());
  // Don't keep process alive solely for log flush
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

function writeLineSync(row) {
  ensureDir();
  fs.appendFileSync(LOG_PATH, `${JSON.stringify(row)}\n`, 'utf8');
}

/**
 * Flush buffered async log lines. Safe to call from tests / shutdown.
 */
export async function flushAsyncLogs() {
  if (!asyncBuffer.length) return { flushed: 0 };
  if (flushing) return { flushed: 0, busy: true };
  flushing = true;
  const batch = asyncBuffer.splice(0, asyncBuffer.length);
  try {
    ensureDir();
    const payload = batch.map((row) => `${JSON.stringify(row)}\n`).join('');
    await fs.promises.appendFile(LOG_PATH, payload, 'utf8');
    return { flushed: batch.length };
  } catch (err) {
    // Re-queue on failure so we don't drop observability
    asyncBuffer.unshift(...batch);
    throw err;
  } finally {
    flushing = false;
  }
}

/**
 * @param {object} event
 */
export function logAgentEvent(event) {
  const row = {
    ts: new Date().toISOString(),
    ...event,
  };
  try {
    const stage = row.stage || '-';
    const warn = Array.isArray(row.warnings) && row.warnings.length
      ? ` warn=${row.warnings.length}`
      : '';
    console.log(
      `[AgentObs] stage=${stage} intent=${row.intent || '-'} mode=${row.mode || '-'} `
      + `tool=${row.tool || row.lastTool || '-'} `
      + `ms=${row.latencyMs ?? '-'} ok=${row.ok ?? '-'} `
      + `conf=${row.confidence ?? '-'}${warn} err=${row.error || row.reason || '-'}`,
    );

    if (isAsyncLoggingEnabled()) {
      asyncBuffer.push(row);
      scheduleFlush();
    } else {
      writeLineSync(row);
    }
  } catch (err) {
    console.warn('[AgentObs] failed to write log:', err.message);
  }
}

export function startTimer() {
  const t0 = Date.now();
  return () => Date.now() - t0;
}

/**
 * Convenience helper for consistent stage events.
 */
export function logPipelineStage(stage, payload = {}) {
  logAgentEvent({ stage, ...payload });
}

// Best-effort flush on process exit when async logging is enabled
function registerExitFlush() {
  const flushSync = () => {
    if (!asyncBuffer.length) return;
    try {
      ensureDir();
      const payload = asyncBuffer.splice(0, asyncBuffer.length)
        .map((row) => `${JSON.stringify(row)}\n`)
        .join('');
      fs.appendFileSync(LOG_PATH, payload, 'utf8');
    } catch {
      // ignore exit flush errors
    }
  };
  process.once('beforeExit', () => {
    flushAsyncLogs().catch(() => flushSync());
  });
  process.once('exit', flushSync);
}

registerExitFlush();
