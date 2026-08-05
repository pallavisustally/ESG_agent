/**
 * Phase 7 — Quality gate unit tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUALITY_GATES,
  resolveMinPassRate,
  assertPassRate,
} from './quality-gates.js';

describe('quality-gates', () => {
  it('defaults smoke to 100% and plan-ci to 95%', () => {
    assert.equal(QUALITY_GATES.smokePlanMinPassRate, 1);
    assert.equal(QUALITY_GATES.planCiMinPassRate, 0.95);
    assert.equal(QUALITY_GATES.pipelineGateEnabled, false);
  });

  it('resolveMinPassRate respects override', () => {
    assert.equal(resolveMinPassRate('smoke', 0.9), 0.9);
    assert.equal(resolveMinPassRate('smoke', null), 1);
    assert.equal(resolveMinPassRate('plan-ci', null), 0.95);
  });

  it('assertPassRate passes and fails correctly', () => {
    const ok = assertPassRate({ summary: { passRate: 1 }, failures: [] }, 0.95);
    assert.equal(ok.ok, true);
    const bad = assertPassRate(
      { summary: { passRate: 0.5 }, failures: [{ id: 'x' }] },
      0.95,
    );
    assert.equal(bad.ok, false);
    assert.match(bad.message, /below minimum/);
    assert.match(bad.message, /x/);
  });
});
