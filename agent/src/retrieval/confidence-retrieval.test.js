/**
 * Phase 8/12 — Confidence retrieval + planner score tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreSqlConfidence,
  scoreNarrativeConfidence,
  scorePdfConfidence,
  shouldAcceptRetrieval,
  pickBestRetrieval,
  runConfidenceRetrieval,
} from '../retrieval/confidence-retrieval.js';
import { scorePlan, selectBestPlan, isWeakPlanScore } from '../planner/planner-score.js';
import { INTENTS } from '../intent/classify-intent.js';
import { METRIC_RESOLUTION } from '../intent/metric-resolution.js';
import { TOOLS, planQuery } from '../planner/plan-query.js';

describe('confidence-retrieval', () => {
  it('scores empty SQL as 0', () => {
    assert.equal(scoreSqlConfidence({ ok: false }).confidence, 0);
    assert.equal(scoreSqlConfidence({ ok: true, data: { rows: [] } }).confidence, 0);
  });

  it('scores SQL rows highly', () => {
    const s = scoreSqlConfidence({
      ok: true,
      data: { rows: [{ company: 'A', metric_value: 10 }], metric: 'scope1_emissions' },
    });
    assert.ok(s.confidence >= 0.9);
  });

  it('low explicit narrative score is rejected by threshold', () => {
    const s = scoreNarrativeConfidence({
      chunks: [{ company: 'Infosys Limited', text: 'unrelated', score: 2 }],
      company: 'Infosys Limited',
      query: 'scope 1 emissions',
    });
    assert.ok(s.confidence < 0.45);
    assert.equal(shouldAcceptRetrieval(s.confidence), false);
  });

  it('strong PDF beats weak narrative in pickBest', () => {
    const best = pickBestRetrieval([
      { source: 'sql', confidence: 0 },
      { source: 'narrative', confidence: 0.42 },
      { source: 'pdf', confidence: 0.93 },
    ]);
    assert.equal(best.source, 'pdf');
    assert.equal(best.accepted, true);
  });

  it('runConfidenceRetrieval stops at first accepted stage', async () => {
    const result = await runConfidenceRetrieval({
      runSql: async () => ({ ok: false }),
      runNarrative: async () => ({
        company: 'Infosys Limited',
        query: 'plastic',
        chunks: [{
          company: 'Infosys Limited',
          text: 'Plastic packaging waste reduction targets disclosed.',
          score: 18,
        }],
      }),
      runPdf: async () => {
        throw new Error('PDF should not run');
      },
      minAccept: 0.45,
    });
    assert.equal(result.stoppedAt, 'narrative');
    assert.equal(result.source, 'narrative');
  });

  it('continues to PDF when narrative confidence is low', async () => {
    const result = await runConfidenceRetrieval({
      runSql: async () => ({ ok: false }),
      runNarrative: async () => ({
        company: 'Infosys Limited',
        query: 'scope 1 emissions tonnes',
        chunks: [{ company: 'Infosys Limited', text: 'governance overview', score: 1 }],
      }),
      runPdf: async () => ({
        hits: [{ page: 10, score: 28, snippet: 'Scope 1 emissions 12000 tCO2e' }],
      }),
      minAccept: 0.45,
    });
    assert.equal(result.source, 'pdf');
    assert.ok(result.attempts.length >= 2);
  });

  it('scorePdfConfidence accepts solid hits', () => {
    const s = scorePdfConfidence({
      hits: [{ page: 3, score: 22, snippet: 'Scope 1' }],
    });
    assert.ok(s.confidence >= 0.55);
  });
});

describe('planner-score', () => {
  it('scores SQL metric lookup highly', () => {
    const classification = {
      intent: INTENTS.METRIC_LOOKUP,
      entities: ['Infosys Limited'],
      metric: 'scope1_emissions',
      metricResolution: METRIC_RESOLUTION.FOUND,
      confidence: 0.97,
      filters: { metric: 'scope1_emissions', years: [2024] },
    };
    const plan = planQuery(classification);
    const scored = scorePlan(plan, classification, {
      validation: { ok: true, warnings: [], errors: [] },
    });
    assert.ok(scored.score >= 0.7);
    assert.ok(scored.dimensions.tool >= 0.9);
  });

  it('penalizes RAG tool for metric lookup', () => {
    const classification = {
      intent: INTENTS.METRIC_LOOKUP,
      entities: ['Infosys Limited'],
      metric: 'scope1_emissions',
      metricResolution: METRIC_RESOLUTION.FOUND,
      confidence: 0.9,
      filters: {},
    };
    const plan = {
      intent: INTENTS.METRIC_LOOKUP,
      primaryTool: TOOLS.RAG,
      strategy: 'guidance_templates',
      entities: ['Infosys Limited'],
      metric: 'scope1_emissions',
      filters: {},
    };
    const scored = scorePlan(plan, classification);
    assert.ok(scored.dimensions.tool < 0.2);
    assert.equal(isWeakPlanScore(scored), true);
  });

  it('selectBestPlan chooses higher score', () => {
    const classification = {
      intent: INTENTS.METRIC_LOOKUP,
      entities: ['Infosys Limited'],
      metric: 'scope1_emissions',
      metricResolution: METRIC_RESOLUTION.FOUND,
      confidence: 0.9,
      filters: {},
    };
    const good = planQuery(classification);
    const bad = { ...good, primaryTool: TOOLS.RAG, strategy: 'rag_with_schema_context' };
    const selected = selectBestPlan([
      { plan: bad, classification },
      { plan: good, classification, validation: { ok: true } },
    ]);
    assert.equal(selected.plan.primaryTool, TOOLS.SQL);
  });
});
