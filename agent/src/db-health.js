/**
 * Database health checks, retries, and dialect status for Neon/SQLite.
 */

import { logAgentEvent } from './observability/agent-logger.js';

let lastHealth = {
  ok: false,
  dialect: null,
  fallback: false,
  checkedAt: null,
  error: null,
  latencyMs: null,
};

export function getLastDbHealth() {
  return { ...lastHealth };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a DB operation on transient network / Neon failures.
 */
export async function withDbRetry(fn, {
  retries = parseInt(process.env.DB_RETRY_COUNT, 10) || 3,
  baseDelayMs = parseInt(process.env.DB_RETRY_DELAY_MS, 10) || 250,
  label = 'db',
} = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      const retryable = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timeout|503|502|connection|Neon|Too many connections/i.test(msg);
      if (!retryable || attempt === retries) break;
      const delay = baseDelayMs * attempt;
      console.warn(`[DB] ${label} attempt ${attempt} failed (${msg}); retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Ping the active DB and update lastHealth.
 * @param {object} db
 */
export async function checkDbHealth(db) {
  const t0 = Date.now();
  try {
    await withDbRetry(async () => db.get('SELECT 1 AS ok'), { label: 'health', retries: 2 });
    const countRow = await db.get('SELECT COUNT(DISTINCT company) AS n FROM reports').catch(() => null);
    lastHealth = {
      ok: true,
      dialect: db.dialect || (process.env.DATABASE_URL ? 'postgres' : 'sqlite'),
      fallback: Boolean(db._fallbackFromPostgres),
      checkedAt: new Date().toISOString(),
      error: null,
      latencyMs: Date.now() - t0,
      companyCount: countRow?.n != null ? Number(countRow.n) : null,
    };
  } catch (err) {
    lastHealth = {
      ok: false,
      dialect: db?.dialect || null,
      fallback: Boolean(db?._fallbackFromPostgres),
      checkedAt: new Date().toISOString(),
      error: String(err?.message || err),
      latencyMs: Date.now() - t0,
      companyCount: null,
    };
    logAgentEvent({ intent: 'DB_HEALTH', mode: 'infra', ok: false, error: lastHealth.error, latencyMs: lastHealth.latencyMs });
  }
  return getLastDbHealth();
}

export function allowSqliteFallback() {
  if (process.env.ALLOW_SQLITE_FALLBACK === 'false') return false;
  if (process.env.VERCEL && process.env.ALLOW_SQLITE_FALLBACK !== 'true') return false;
  return true;
}
