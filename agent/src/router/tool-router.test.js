/**
 * Phase 6/8 — Tool router regression.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { INTENTS } from '../intent/classify-intent.js';
import { planQuery, TOOLS } from '../planner/plan-query.js';
import { routeTools, shouldSkipRag } from './tool-router.js';

describe('tool-router', () => {
  const skipRagCases = [
    {
      name: 'top metric',
      classification: {
        intent: INTENTS.TOP_METRIC,
        entities: [],
        filters: { metric: 'scope1_emissions' },
        metric: 'scope1_emissions',
        confidence: 0.9,
      },
    },
    {
      name: 'count',
      classification: {
        intent: INTENTS.COUNT_COMPANIES,
        entities: [],
        filters: {},
        confidence: 0.9,
      },
    },
    {
      name: 'compare',
      classification: {
        intent: INTENTS.COMPARE_COMPANIES,
        entities: ['Infosys Limited', 'TCS'],
        filters: { metric: 'scope1_emissions' },
        metric: 'scope1_emissions',
        confidence: 0.9,
      },
    },
    {
      name: 'metric lookup',
      classification: {
        intent: INTENTS.METRIC_LOOKUP,
        entities: ['Infosys Limited'],
        filters: { metric: 'scope1_emissions' },
        metric: 'scope1_emissions',
        confidence: 0.9,
      },
    },
  ];

  for (const c of skipRagCases) {
    it(`skips RAG for ${c.name}`, () => {
      const plan = planQuery(c.classification);
      const route = routeTools(plan);
      assert.equal(route.skipRag, true);
      assert.equal(shouldSkipRag(plan), true);
      assert.ok(route.tools.includes(TOOLS.SQL));
    });
  }

  it('HOW_TO uses rag mode', () => {
    const plan = planQuery({
      intent: INTENTS.HOW_TO,
      entities: [],
      filters: { guidance: true },
      confidence: 0.9,
    });
    const route = routeTools(plan);
    assert.equal(route.mode, 'rag');
  });

  it('hybrid why compare does not skip RAG', () => {
    const plan = planQuery({
      intent: INTENTS.COMPARE_COMPANIES,
      entities: ['Infosys Limited', 'TCS'],
      filters: { metric: 'scope1_emissions', hybridWhy: true },
      metric: 'scope1_emissions',
      confidence: 0.9,
    });
    const route = routeTools(plan);
    assert.equal(route.mode, 'hybrid');
    assert.equal(route.skipRag, false);
  });
});
