/**
 * Soft-failure helpers for orchestrator degradation.
 */

/** Engines that must never block a useful partial answer when they fail. */
export const SOFT_FAIL_ENGINES = new Set([
  'recommendation',
  'guidance',
  'document',
  'visualization',
]);

/**
 * True when an engine result should be omitted from composition
 * so healthier engines (e.g. analytics) still reach the user.
 */
export function shouldOmitFromComposition(result) {
  if (!result) return true;
  const engine = result.engine;
  const notRequired = typeof result.error === 'string' && /_not_required$/.test(result.error);
  if (notRequired) return true;

  // Soft engines: drop failures / empty timeouts so analytics/report remain.
  if (SOFT_FAIL_ENGINES.has(engine) && !result.ok) return true;
  if (SOFT_FAIL_ENGINES.has(engine) && !String(result.text || '').trim() && !result.visualization) {
    return true;
  }

  // Timed-out engines that only carry error copy — omit from user text.
  if (
    !result.ok
    && typeof result.error === 'string'
    && /_timeout_/i.test(result.error)
    && (!result.data || (!result.data.rows && result.data.value == null))
  ) {
    // Keep analytics/report timeout messages only if no other usable content —
    // caller decides; here we omit soft engines already handled above.
    if (SOFT_FAIL_ENGINES.has(engine) || engine === 'knowledge' || engine === 'compliance') {
      return true;
    }
  }

  if (!String(result.text || '').trim() && !result.visualization) return true;
  return false;
}

/**
 * Normalize a soft engine failure into an empty non-blocking result.
 */
export function softFailEngineResponse(createEngineResponse, engine, error) {
  return createEngineResponse({
    engine,
    ok: false,
    text: '',
    error: String(error?.message || error || 'soft_fail'),
  });
}
