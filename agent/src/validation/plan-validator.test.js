/**
 * Phase 6 — Planner validation engine tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { INTENTS } from '../intent/classify-intent.js';
import { METRIC_RESOLUTION } from '../intent/metric-resolution.js';
import { TOOLS, planQuery } from '../planner/plan-query.js';
import {
  validatePlan,
  repairClassification,
  planAndValidate,
  PLAN_METRICS,
} from './plan-validator.js';

function cls(overrides = {}) {
  return {
    intent: INTENTS.METRIC_LOOKUP,
    entities: ['Infosys Limited'],
    filters: { years: [2024], metric: 'scope1_emissions' },
    metric: 'scope1_emissions',
    metricResolution: METRIC_RESOLUTION.FOUND,
    confidence: 0.95,
    assumptions: [],
    ...overrides,
  };
}

describe('plan-validator: metric / tool / SQL vs Narrative', () => {
  it('accepts SQL plan for carbon/scope metric lookup', () => {
    const classification = cls();
    const plan = planQuery(classification);
    const v = validatePlan(plan, classification);
    assert.equal(v.ok, true);
    assert.equal(plan.primaryTool, TOOLS.SQL);
  });

  it('rejects Narrative/RAG primary for structured metric', () => {
    const classification = cls();
    const plan = {
      ...planQuery(classification),
      primaryTool: TOOLS.RAG,
      strategy: 'guidance_templates',
    };
    const v = validatePlan(plan, classification, { userMessage: 'Infosys carbon emissions' });
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => /Narrative\/RAG instead of SQL/i.test(e)));
    assert.ok(v.repairs.some((r) => r.type === 'force_sql_metric'));
  });

  it('force_sql_metric repair re-plans to SQL lookup', () => {
    const classification = cls({ intent: INTENTS.HOW_TO }); // will be repaired
    const badPlan = {
      intent: INTENTS.METRIC_LOOKUP,
      primaryTool: TOOLS.RAG,
      strategy: 'guidance_templates',
      entities: ['Infosys Limited'],
      metric: 'total_emissions',
      filters: {},
    };
    const v = validatePlan(badPlan, cls({ metric: 'total_emissions' }), {
      userMessage: 'Infosys total emissions',
    });
    const repair = repairClassification(cls({ metric: 'total_emissions' }), badPlan, v, {
      userMessage: 'Infosys total emissions',
    });
    assert.equal(repair.repaired, true);
    const replanned = planQuery(repair.classification);
    assert.equal(replanned.primaryTool, TOOLS.SQL);
  });

  it('rejects unknown metrics', () => {
    const classification = cls({
      metric: 'plastic_footprint',
      filters: { metric: 'plastic_footprint' },
      metricResolution: METRIC_RESOLUTION.UNSUPPORTED,
    });
    const plan = {
      ...planQuery(cls()),
      metric: 'plastic_footprint',
    };
    const v = validatePlan(plan, classification);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => /unsupported metric/i.test(e)));
  });

  it('PLAN_METRICS includes scope and derived metrics', () => {
    assert.ok(PLAN_METRICS.has('scope1_emissions'));
    assert.ok(PLAN_METRICS.has('total_emissions'));
    assert.ok(PLAN_METRICS.has('male_board_share'));
  });
});

describe('plan-validator: companies / year / follow-up', () => {
  it('compare requires two companies', () => {
    const classification = cls({
      intent: INTENTS.COMPARE_COMPANIES,
      entities: ['Infosys Limited'],
      filters: { metric: 'scope1_emissions' },
    });
    const plan = planQuery(classification);
    const v = validatePlan(plan, classification);
    assert.equal(v.ok, false);
    assert.ok(v.repairs.some((r) => r.type === 'compare_to_lookup' || r.type === 'clarify_companies'));
  });

  it('rejects out-of-range years', () => {
    const classification = cls({ filters: { years: [1999], metric: 'scope1_emissions' } });
    const plan = planQuery(classification);
    const v = validatePlan(plan, classification);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => /Year 1999/i.test(e)));
  });

  it('FOLLOW_UP without prior context fails validation', () => {
    const classification = cls({
      intent: INTENTS.FOLLOW_UP,
      entities: [],
      metric: null,
      filters: {},
      metricResolution: METRIC_RESOLUTION.NONE,
    });
    const plan = planQuery(classification, null);
    const v = validatePlan(plan, classification, { memory: null });
    assert.equal(v.ok, false);
  });

  it('FOLLOW_UP with memory companies is ok', () => {
    const classification = cls({
      intent: INTENTS.FOLLOW_UP,
      entities: [],
      metric: null,
      filters: { metricResolution: METRIC_RESOLUTION.NONE },
      metricResolution: METRIC_RESOLUTION.NONE,
    });
    const memory = {
      lastIntent: INTENTS.COMPARE_COMPANIES,
      lastCompanies: ['Infosys Limited', 'TCS'],
      lastMetric: 'scope1_emissions',
      lastYear: 2024,
    };
    const plan = planQuery(classification, memory);
    const v = validatePlan(plan, classification, { memory });
    assert.equal(v.ok, true);
  });

  it('HOW_TO cannot use sql_rank_metric', () => {
    const classification = cls({
      intent: INTENTS.HOW_TO,
      entities: [],
      metric: null,
      filters: { guidance: true },
    });
    const plan = {
      intent: INTENTS.HOW_TO,
      primaryTool: TOOLS.SQL,
      strategy: 'sql_rank_metric',
      entities: [],
      metric: 'total_emissions',
      filters: {},
    };
    const v = validatePlan(plan, classification, { userMessage: 'How to reduce carbon emissions?' });
    assert.equal(v.ok, false);
  });
});

describe('planAndValidate: reject → replan', () => {
  it('replans narrative metric path to SQL', () => {
    const result = planAndValidate(
      cls({ confidence: 0.97 }),
      null,
      { userMessage: 'Scope 1 emissions for Infosys' },
    );
    assert.equal(result.plan.primaryTool, TOOLS.SQL);
    assert.ok(result.plannerScore);
    assert.ok(result.plannerScore.score > 0.4);
  });

  it('clarifies when compare has zero companies', () => {
    const result = planAndValidate(
      cls({
        intent: INTENTS.COMPARE_COMPANIES,
        entities: [],
        filters: { metric: 'scope1_emissions' },
      }),
      null,
      { userMessage: 'Compare Scope 1' },
    );
    assert.ok(result.clarification);
  });

  const rankingCases = [
    { intent: INTENTS.TOP_METRIC, msg: 'Top 5 by Scope 1' },
    { intent: INTENTS.BOTTOM_METRIC, msg: 'Lowest Scope 2' },
  ];
  for (const c of rankingCases) {
    it(`ranks with SQL for ${c.intent}`, () => {
      const result = planAndValidate(
        cls({
          intent: c.intent,
          entities: [],
          metric: 'scope1_emissions',
          filters: { metric: 'scope1_emissions', order: c.intent === INTENTS.BOTTOM_METRIC ? 'ASC' : 'DESC' },
        }),
        null,
        { userMessage: c.msg },
      );
      assert.equal(result.plan.strategy, 'sql_rank_metric');
      assert.equal(result.plan.primaryTool, TOOLS.SQL);
    });
  }
});
