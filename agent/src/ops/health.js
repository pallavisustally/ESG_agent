/**
 * Liveness / readiness helpers for production probes.
 */

/**
 * Process liveness — always OK if the Node process can answer.
 */
export function buildLivenessPayload() {
  return {
    ok: true,
    status: 'alive',
    uptimeSec: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Readiness — requires successful module load + DB ping.
 * @param {{
 *   startupError?: string|null,
 *   loadPromise?: Promise<unknown>,
 *   getDb?: () => Promise<object>,
 *   checkDbHealth?: (db: object) => Promise<object>,
 * }} deps
 */
export async function buildReadinessPayload(deps = {}) {
  if (deps.startupError) {
    return {
      ok: false,
      status: 'not_ready',
      reason: 'startup_failed',
      error: String(deps.startupError),
      timestamp: new Date().toISOString(),
    };
  }

  try {
    if (deps.loadPromise) await deps.loadPromise;
    if (typeof deps.getDb !== 'function' || typeof deps.checkDbHealth !== 'function') {
      return {
        ok: false,
        status: 'not_ready',
        reason: 'deps_missing',
        timestamp: new Date().toISOString(),
      };
    }
    const db = await deps.getDb();
    const health = await deps.checkDbHealth(db);
    if (!health?.ok) {
      return {
        ok: false,
        status: 'not_ready',
        reason: 'db_unavailable',
        database: {
          dialect: health?.dialect || null,
          error: health?.error || 'db_ping_failed',
          latencyMs: health?.latencyMs ?? null,
        },
        timestamp: new Date().toISOString(),
      };
    }
    return {
      ok: true,
      status: 'ready',
      database: {
        dialect: health.dialect,
        fallback: Boolean(health.fallback),
        latencyMs: health.latencyMs,
        companyCount: health.companyCount ?? null,
      },
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    return {
      ok: false,
      status: 'not_ready',
      reason: 'exception',
      error: String(err?.message || err),
      timestamp: new Date().toISOString(),
    };
  }
}
