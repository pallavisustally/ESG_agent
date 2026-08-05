/**
 * ExecutionPlan model + validation tests (Phase 2).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createExecutionPlan,
  validateExecutionPlan,
  deriveRequiredEngines,
  EXECUTION_ENGINES,
  EXECUTION_STRATEGIES,
} from './execution-plan.js';
import { CAPABILITIES } from '../capability/capabilities.js';

describe('createExecutionPlan', () => {
  it('fills defaults and derives engines from needs flags', () => {
    const plan = createExecutionPlan({
      intent: 'TOP_METRIC',
      capability: CAPABILITIES.COMPANY_ANALYTICS,
      capabilities: [CAPABILITIES.COMPANY_ANALYTICS],
      entities: ['Infosys'],
      metrics: ['scope1_emissions'],
      years: [2024],
      needsSql: true,
      visualization: true,
      needsVisualization: true,
      confidence: 0.9,
    });
    assert.equal(plan.executionStrategy, 'analytics');
    assert.ok(plan.requiredEngines.includes(EXECUTION_ENGINES.ANALYTICS));
    assert.ok(plan.requiredEngines.includes(EXECUTION_ENGINES.VISUALIZATION));
    assert.equal(plan.needsSql, true);
    assert.equal(plan.confidence, 0.9);
  });

  it('supports knowledge-only plans', () => {
    const plan = createExecutionPlan({
      intent: 'INFORMATIONAL',
      capability: CAPABILITIES.ESG_KNOWLEDGE,
      capabilities: [CAPABILITIES.ESG_KNOWLEDGE],
      needsKnowledge: true,
      confidence: 0.95,
    });
    assert.equal(plan.executionStrategy, 'knowledge');
    assert.deepEqual(plan.requiredEngines, [EXECUTION_ENGINES.KNOWLEDGE]);
    assert.equal(plan.needsSql, false);
  });

  it('clamps confidence and dedupes lists', () => {
    const plan = createExecutionPlan({
      entities: ['Infosys', 'infosys', 'TCS'],
      metrics: ['scope1_emissions', 'scope1_emissions'],
      confidence: 1.5,
    });
    assert.deepEqual(plan.entities, ['Infosys', 'TCS']);
    assert.deepEqual(plan.metrics, ['scope1_emissions']);
    assert.equal(plan.confidence, 1);
  });
});

describe('validateExecutionPlan', () => {
  it('accepts a well-formed analytics plan', () => {
    const plan = createExecutionPlan({
      capability: CAPABILITIES.COMPANY_ANALYTICS,
      capabilities: [CAPABILITIES.COMPANY_ANALYTICS],
      needsSql: true,
      confidence: 0.8,
      executionStrategy: 'analytics',
    });
    const v = validateExecutionPlan(plan);
    assert.equal(v.ok, true);
    assert.equal(v.errors.length, 0);
  });

  it('rejects invalid capability and strategy', () => {
    const v = validateExecutionPlan({
      capability: 'NOT_A_CAP',
      capabilities: ['NOT_A_CAP'],
      executionStrategy: 'nope',
      confidence: 0.5,
      requiredEngines: [],
      entities: [],
      metrics: [],
      years: [],
    });
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => /Invalid capability/.test(e)));
    assert.ok(v.errors.some((e) => /Invalid executionStrategy/.test(e)));
  });

  it('warns when visualization has no data source', () => {
    const plan = createExecutionPlan({
      needsVisualization: true,
      needsSql: false,
      needsReport: false,
      confidence: 0.5,
    });
    const v = validateExecutionPlan(plan);
    assert.equal(v.ok, true);
    assert.ok(v.warnings.some((w) => /needsVisualization/.test(w)));
  });
});

describe('deriveRequiredEngines', () => {
  it('orders engines data-first', () => {
    const engines = deriveRequiredEngines({
      needsKnowledge: true,
      needsSql: true,
      needsRecommendation: true,
      needsVisualization: true,
    });
    assert.deepEqual(engines, [
      EXECUTION_ENGINES.KNOWLEDGE,
      EXECUTION_ENGINES.ANALYTICS,
      EXECUTION_ENGINES.RECOMMENDATION,
      EXECUTION_ENGINES.VISUALIZATION,
    ]);
  });

  it('returns empty for clarification', () => {
    assert.deepEqual(deriveRequiredEngines({ needsClarification: true, needsSql: true }), []);
  });
});

describe('EXECUTION_STRATEGIES', () => {
  it('includes expected strategy names', () => {
    for (const s of ['analytics', 'knowledge', 'guidance', 'recommendation', 'compliance', 'document', 'report', 'hybrid', 'clarify']) {
      assert.ok(EXECUTION_STRATEGIES.includes(s), s);
    }
  });
});
