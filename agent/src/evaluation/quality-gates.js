/**
 * Phase 7 — Quality gate thresholds for CI / merge blocking.
 *
 * Deterministic only (plan-mode eval + unit/regression via npm test).
 * Pipeline full eval is optional and not merge-blocking by default.
 */

export const QUALITY_GATES = {
  /** Plan-mode smoke tier — must stay perfect on seeded cases. */
  smokePlanMinPassRate: Number(process.env.EVAL_SMOKE_MIN_PASS_RATE || 1),

  /** Plan-mode all cases (smoke + full) — merge gate. */
  planCiMinPassRate: Number(process.env.EVAL_PLAN_CI_MIN_PASS_RATE || 0.95),

  /** In-test smoke assertion (evaluation-smoke.test.js). */
  testSmokeMinPassRate: Number(process.env.EVAL_TEST_SMOKE_MIN_PASS_RATE || 0.95),

  /**
   * Pipeline-mode full eval — only enforced when EVAL_PIPELINE_GATE=true
   * (requires DB). Default off so PRs don't need Neon.
   */
  pipelineGateEnabled: process.env.EVAL_PIPELINE_GATE === 'true',
  pipelineMinPassRate: Number(process.env.EVAL_PIPELINE_MIN_PASS_RATE || 0.90),
};

/**
 * Resolve the minimum pass rate for a given CLI profile.
 * @param {'smoke'|'plan-ci'|'pipeline'|string|null} profile
 * @param {number|null} override
 */
export function resolveMinPassRate(profile, override = null) {
  if (override != null && Number.isFinite(override)) return override;
  if (profile === 'smoke') return QUALITY_GATES.smokePlanMinPassRate;
  if (profile === 'plan-ci') return QUALITY_GATES.planCiMinPassRate;
  if (profile === 'pipeline') return QUALITY_GATES.pipelineMinPassRate;
  return null;
}

/**
 * Assert a report meets a minimum pass rate.
 * @returns {{ ok: boolean, passRate: number, minPassRate: number, message: string }}
 */
export function assertPassRate(report, minPassRate) {
  const passRate = Number(report?.summary?.passRate ?? 0);
  const min = Number(minPassRate);
  if (!Number.isFinite(min)) {
    return {
      ok: true,
      passRate,
      minPassRate: min,
      message: 'no minimum configured',
    };
  }
  const ok = passRate + 1e-9 >= min;
  return {
    ok,
    passRate,
    minPassRate: min,
    message: ok
      ? `pass rate ${(passRate * 100).toFixed(1)}% ≥ ${(min * 100).toFixed(1)}%`
      : `pass rate ${(passRate * 100).toFixed(1)}% below minimum ${(min * 100).toFixed(1)}%`
        + (report?.failures?.length
          ? `\nFailures:\n${report.failures.slice(0, 20).map((f) => `  - ${f.id}`).join('\n')}`
          : ''),
  };
}
