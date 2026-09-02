/**
 * Metric Normalization Engine — regression matrix.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMetricState, METRIC_RESOLUTION } from './metric-resolution.js';
import { extractMetrics } from './classify-intent.js';
import { runMetricNormalizationEngine, ENGINE_STATE } from './metric-normalization-engine.js';
import { classifyIntent } from './classify-intent.js';
import { planExecution } from '../execution/execution-planner.js';

function expectMetric(phrase, metric, state = METRIC_RESOLUTION.FOUND) {
  const r = resolveMetricState(phrase);
  assert.equal(
    r.state,
    state,
    `"${phrase}" → state ${r.state} (want ${state}); metric=${r.metric}; conf=${r.confidence}`,
  );
  if (metric) {
    assert.equal(
      r.metric,
      metric,
      `"${phrase}" → metric ${r.metric} (want ${metric}); conf=${r.confidence}`,
    );
  }
}

describe('metric normalization engine — workforce', () => {
  const cases = [
    ['male count', 'male_employee_count'],
    ['What are the male count in above companies?', 'male_employee_count'],
    ['male employees', 'male_employee_count'],
    ['male employee count', 'male_employee_count'],
    ['number of male employees', 'male_employee_count'],
    ['how many male employees', 'male_employee_count'],
    ['female count', 'female_employee_count'],
    ['women employees', 'female_employee_count'],
    ['female employees', 'female_employee_count'],
    ['female employee count', 'female_employee_count'],
    ['how many male and female employes are working in infosys company', 'female_employee_count'],
    ['employee strength', 'total_employee_count'],
    ['male workforce', 'male_employee_share'],
    ['female employee share', 'female_employee_share'],
    ['gender diversity', 'female_employee_share'],
  ];

  for (const [phrase, metric] of cases) {
    it(`resolves "${phrase}" → ${metric}`, () => {
      expectMetric(phrase, metric);
      assert.ok(extractMetrics(phrase).includes(metric));
    });
  }
});

describe('metric normalization engine — emissions', () => {
  const cases = [
    ['carbon emissions', 'total_emissions'],
    ['greenhouse gases', 'total_emissions'],
    ['GHG emissions', 'total_emissions'],
    ['carbon footprint', 'total_emissions'],
    ['Scope 1 carbon', 'scope1_emissions'],
    ['Scope 2 electricity emissions', 'scope2_emissions'],
    ['value chain emissions', 'scope3_emissions'],
    ['carbon emissions intensity', 'emissions_intensity'],
    ['carbom emissions', 'total_emissions'],
    ['carbon emisiions', 'total_emissions'],
  ];

  for (const [phrase, metric] of cases) {
    it(`resolves "${phrase}" → ${metric}`, () => {
      expectMetric(phrase, metric);
    });
  }
});

describe('metric normalization engine — energy / water / waste / board / safety', () => {
  const cases = [
    ['renewable electricity', 'renewable_energy_share'],
    ['renewable energy share', 'renewable_energy_share'],
    ['energy consumption', 'energy_consumption'],
    ['water consumption', 'water_consumption'],
    ['water withdrawal', 'water_withdrawal'],
    ['waste generated', 'waste_generated'],
    ['board diversity', 'female_board_share'],
    ['women on board', 'female_board_share'],
    ['male board count', 'male_board_count', METRIC_RESOLUTION.DERIVED],
    ['ltifr', 'safety_ltifr'],
    ['total revenue', 'total_revenue'],
  ];

  for (const [phrase, metric, state] of cases) {
    it(`resolves "${phrase}" → ${metric}`, () => {
      expectMetric(phrase, metric, state || METRIC_RESOLUTION.FOUND);
    });
  }
});

describe('metric normalization engine — unsupported', () => {
  for (const phrase of [
    'disabled female employees',
    'disabled male employees',
    'plastic footprint',
    'plastic footprint for the above companies',
    'Scope 4 emissions',
    'ocean pollution',
  ]) {
    it(`UNSUPPORTED: ${phrase}`, () => {
      expectMetric(phrase, null, METRIC_RESOLUTION.UNSUPPORTED);
    });
  }
});

describe('metric normalization engine — none / non-metric', () => {
  for (const phrase of [
    'list all companies',
    'how many companies are in the database?',
    'show more',
  ]) {
    it(`NONE: ${phrase}`, () => {
      const r = resolveMetricState(phrase);
      assert.equal(r.state, METRIC_RESOLUTION.NONE, phrase);
    });
  }
});

describe('metric normalization engine — confidence + routing', () => {
  it('exposes engine confidence for male count', () => {
    const eng = runMetricNormalizationEngine('male count');
    assert.ok(
      eng.engineState === ENGINE_STATE.FOUND
      || eng.engineState === ENGINE_STATE.MEDIUM_CONFIDENCE,
    );
    assert.equal(eng.metric, 'male_employee_count');
    assert.ok(eng.confidence >= 0.6);
  });

  it('routes male count above companies to analytics-capable plan', () => {
    const msg = 'What are the male count in above companies?';
    const memory = {
      lastCompanies: ['A Co', 'B Co', 'C Co'],
      entities: ['A Co', 'B Co', 'C Co'],
      lastMetric: 'female_employee_share',
      lastYear: 2025,
      lastIntent: 'TOP_METRIC',
    };
    const classification = classifyIntent(msg, memory);
    assert.notEqual(classification.metricResolution, METRIC_RESOLUTION.UNSUPPORTED);
    assert.equal(classification.metric, 'male_employee_count');
    const { plan } = planExecution({ userMessage: msg, memory, classification });
    assert.equal(plan.needsSql, true);
    assert.notEqual(plan.executionStrategy, 'unsupported');
    assert.equal(plan.needsKnowledge, false);
  });

  it('keeps intensity ahead of total emissions', () => {
    expectMetric(
      'Analyze average carbon emissions intensity across all sectors in 2025',
      'emissions_intensity',
    );
  });
});
