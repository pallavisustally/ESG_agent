/**
 * Evaluation smoke tests — plan-mode benchmarks (no DB required).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadSmokeBenchmarks, loadBenchmarks } from './load-benchmarks.js';
import { BENCHMARK_CATEGORIES, validateBenchmarkFile, normalizeBenchmarkCase } from './benchmark-schema.js';
import { scoreBenchmarkCase } from './scorers/index.js';
import { runEvaluation, observePlan } from './run-evaluation.js';
import { QUALITY_GATES } from './quality-gates.js';

describe('evaluation: benchmark datasets', () => {
  it('loads all benchmark categories without schema errors', async () => {
    const all = await loadBenchmarks();
    assert.ok(all.length >= 35, `expected >=35 cases, got ${all.length}`);
    const cats = new Set(all.map((c) => c.category));
    for (const cat of BENCHMARK_CATEGORIES) {
      assert.ok(cats.has(cat), `missing category ${cat}`);
    }
    assert.ok(cats.has('recommendation'), 'missing recommendation category');
  });

  it('smoke subset is non-empty', async () => {
    const smoke = await loadSmokeBenchmarks();
    assert.ok(smoke.length >= 20, `expected >=20 smoke cases, got ${smoke.length}`);
  });

  it('rejects invalid category in normalize', () => {
    assert.throws(() => normalizeBenchmarkCase({
      id: 'x',
      category: 'nope',
      question: 'hi',
    }));
  });

  it('validateBenchmarkFile catches duplicates', () => {
    const { ok, errors } = validateBenchmarkFile([
      { id: 'a', category: 'knowledge', question: 'What is ESG?' },
      { id: 'a', category: 'knowledge', question: 'What is ESG again?' },
    ], 'dup.json');
    assert.equal(ok, false);
    assert.ok(errors.some((e) => /duplicate/i.test(e)));
  });
});

describe('evaluation: scorers', () => {
  it('scores routing strategy match', () => {
    const scored = scoreBenchmarkCase(
      { executionStrategy: 'knowledge', requiredEngines: ['knowledge'], intent: 'INFORMATIONAL' },
      { executionStrategy: 'knowledge', engines: ['knowledge'], intent: 'INFORMATIONAL' },
      { routing: true, entity: false, metric: false, year: false, numeric: false, chart: false, citation: false },
    );
    assert.equal(scored.passed, true);
  });

  it('fails metric mismatch', () => {
    const scored = scoreBenchmarkCase(
      { metric: 'scope2_emissions' },
      { metric: 'scope1_emissions' },
      { routing: false, entity: false, metric: true, year: false, numeric: false, chart: false, citation: false },
    );
    assert.equal(scored.passed, false);
    assert.equal(scored.dimensions.metric.ok, false);
  });

  it('matches entities via issuer id', () => {
    const scored = scoreBenchmarkCase(
      { entities: ['Infosys Limited'] },
      { entities: ['Infosys'] },
      { routing: false, entity: true, metric: false, year: false, numeric: false, chart: false, citation: false },
    );
    assert.equal(scored.passed, true);
  });
});

describe('evaluation: smoke run (plan mode)', () => {
  it('observePlan returns strategy for knowledge', () => {
    const actual = observePlan({
      question: 'What is ESG?',
      memory: null,
    });
    assert.equal(actual.executionStrategy, 'knowledge');
    assert.ok(actual.requiredEngines.includes('knowledge'));
  });

  it('smoke suite pass rate meets threshold', async () => {
    const report = await runEvaluation({ mode: 'plan', tier: 'smoke' });
    assert.ok(report.summary.total >= 20);
    const min = QUALITY_GATES.testSmokeMinPassRate;
    assert.ok(
      report.summary.passRate + 1e-9 >= min,
      `smoke pass rate ${(report.summary.passRate * 100).toFixed(1)}% < ${(min * 100).toFixed(0)}%\n`
        + report.failures.map((f) => {
          const dims = (f.failedDimensions || []).map((d) => d.name).join(',');
          return `  ${f.id}: ${dims} actual=${JSON.stringify(f.actual)}`;
        }).join('\n'),
    );
  });
});
