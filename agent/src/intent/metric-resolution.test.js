/**
 * Regression tests for follow-up metric resolution + memory merge.
 * Run: node --test agent/src/intent/metric-resolution.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  METRIC_RESOLUTION,
  resolveMetricState,
  UNSUPPORTED_METRIC_RESPONSE,
} from './metric-resolution.js';
import {
  validatePriorCompanyReference,
  MISSING_PRIOR_COMPANIES_CLARIFICATION,
} from './conversation-context.js';
import { matchDerivedMetric } from './derived-metrics.js';
import { classifyIntent } from './classify-intent.js';
import { applyMemoryToClassification } from '../memory/conversation-memory.js';
import { planQuery } from '../planner/plan-query.js';
import { llmExtractionToClassification } from './extract-intent.js';

const PRIOR_COMPANIES = [
  'Company A',
  'Company B',
  'Company C',
  'Company D',
  'Company E',
];

function priorMemory(overrides = {}) {
  return {
    lastIntent: 'TOP_METRIC',
    lastCompanies: [...PRIOR_COMPANIES],
    lastMetric: 'female_employee_share',
    lastYear: 2025,
    lastTool: 'SQL',
    filters: {
      metric: 'female_employee_share',
      years: [2025],
      order: 'DESC',
      limit: 5,
    },
    lastPageItems: [...PRIOR_COMPANIES],
    entities: [...PRIOR_COMPANIES],
    lastPlan: {
      intent: 'TOP_METRIC',
      primaryTool: 'SQL',
      strategy: 'sql_rank_metric',
      metric: 'female_employee_share',
    },
    ...overrides,
  };
}

function mergeTurn(userMessage, memory = priorMemory()) {
  const classification = classifyIntent(userMessage, memory);
  const merged = applyMemoryToClassification(classification, memory, userMessage);
  const plan = planQuery(merged, memory);
  return { classification, merged, plan };
}

describe('metric resolution states', () => {
  it('FOUND for supported female employee share', () => {
    const r = resolveMetricState(
      'Analyze the top 5 companies with the highest female employee share in 2025.',
    );
    assert.equal(r.state, METRIC_RESOLUTION.FOUND);
    assert.equal(r.metric, 'female_employee_share');
  });

  it('NONE when metric omitted', () => {
    const r = resolveMetricState('Compare the above companies.');
    assert.equal(r.state, METRIC_RESOLUTION.NONE);
    assert.equal(r.metric, null);
  });

  it('UNSUPPORTED for disabled female employees', () => {
    const r = resolveMetricState(
      'How many disabled female employees are in the above companies?',
    );
    assert.equal(r.state, METRIC_RESOLUTION.UNSUPPORTED);
    assert.equal(r.metric, null);
  });

  it('UNSUPPORTED for Scope 4 emissions', () => {
    const r = resolveMetricState('What about Scope 4 emissions for the above companies?');
    assert.equal(r.state, METRIC_RESOLUTION.UNSUPPORTED);
  });

  it('UNSUPPORTED for plastic footprint', () => {
    const r = resolveMetricState('What is the plastic footprint of the above companies?');
    assert.equal(r.state, METRIC_RESOLUTION.UNSUPPORTED);
  });
});

describe('follow-up memory merge', () => {
  it('Metric omitted → previous metric reused', () => {
    const { merged, plan } = mergeTurn('Compare the above companies.');
    assert.equal(merged.metricResolution, METRIC_RESOLUTION.NONE);
    assert.equal(merged.metric, 'female_employee_share');
    assert.deepEqual(merged.entities.slice(0, 3), PRIOR_COMPANIES.slice(0, 3));
    assert.notEqual(plan.strategy, 'unsupported_metric');
    // New plan — must not be a shallow replay of lastPlan identity fields alone.
    assert.equal(plan.metric, 'female_employee_share');
  });

  it('Year changed → previous metric reused, year replaced', () => {
    const { merged } = mergeTurn('How about 2024?');
    assert.equal(merged.metricResolution, METRIC_RESOLUTION.NONE);
    assert.equal(merged.metric, 'female_employee_share');
    assert.deepEqual(merged.filters.years, [2024]);
    assert.ok(merged.entities.length >= 2);
  });

  it('Comparison changed → comparison target replaced, metric reused when omitted', () => {
    const { merged } = mergeTurn('Compare the above companies with Wipro');
    assert.equal(merged.metricResolution, METRIC_RESOLUTION.NONE);
    assert.equal(merged.metric, 'female_employee_share');
    assert.equal(merged.intent, 'COMPARE_COMPANIES');
  });

  it('Chart request → reuse verified metric/companies for visualization', () => {
    const { merged, plan } = mergeTurn('Show it as a chart');
    assert.equal(merged.metricResolution, METRIC_RESOLUTION.NONE);
    assert.equal(merged.metric, 'female_employee_share');
    assert.ok(merged.entities.length >= 2);
    assert.ok(
      plan.strategy === 'sql_then_chart'
      || merged.filters?.wantsChart
      || merged.intent === 'CHART_REQUEST',
    );
  });

  it('Unsupported metric → do NOT reuse previous metric', () => {
    const { classification, merged, plan } = mergeTurn(
      'How many disabled female employees are in the above companies?',
    );
    assert.equal(classification.metricResolution, METRIC_RESOLUTION.UNSUPPORTED);
    assert.equal(merged.metricResolution, METRIC_RESOLUTION.UNSUPPORTED);
    assert.equal(merged.metric, null);
    assert.notEqual(merged.metric, 'female_employee_share');
    assert.ok(merged.entities.length >= 1, 'companies reused');
    assert.equal(merged.filters.years?.[0], 2025);
  });

  it('Scope 4 → unavailable path (no prior metric inherit)', () => {
    const { merged } = mergeTurn('Show Scope 4 emissions for the above companies');
    assert.equal(merged.metricResolution, METRIC_RESOLUTION.UNSUPPORTED);
    assert.equal(merged.metric, null);
  });

  it('Plastic footprint → unavailable path', () => {
    const { merged } = mergeTurn('Plastic footprint for the above companies?');
    assert.equal(merged.metricResolution, METRIC_RESOLUTION.UNSUPPORTED);
    assert.equal(merged.metric, null);
  });

  it('LLM follow-up path must not inherit prior metric when unsupported', () => {
    const memory = priorMemory();
    const msg = 'How many disabled female employees are in the above companies?';
    const llm = llmExtractionToClassification(
      {
        intent: 'FOLLOW_UP',
        companies: [],
        metric: null,
        follow_up: true,
        confidence: 0.92,
      },
      msg,
      memory,
    );
    assert.ok(llm);
    assert.equal(llm.metricResolution, METRIC_RESOLUTION.UNSUPPORTED);
    assert.equal(llm.metric, null);

    const merged = applyMemoryToClassification(llm, memory, msg);
    assert.equal(merged.metric, null);
    assert.equal(merged.metricResolution, METRIC_RESOLUTION.UNSUPPORTED);
    const assumptionText = Array.isArray(merged.assumptions)
      ? merged.assumptions.join(' ')
      : String(merged.assumptions || '');
    assert.ok(!assumptionText.includes('metric: female_employee_share'));
  });
});

describe('unsupported early-plan contract', () => {
  it('exposes deterministic unavailable response constant', () => {
    assert.match(UNSUPPORTED_METRIC_RESPONSE, /not available/i);
  });

  it('planQuery FOLLOW_UP does not reuse lastPlan SQL strategy fields', () => {
    const memory = priorMemory();
    const { merged, plan } = mergeTurn('Why are these companies high?', memory);
    assert.equal(merged.metric, 'female_employee_share');
    assert.equal(plan.strategy, 'follow_up_from_memory');
    // Must not copy page/pageSize from last ranking plan as a SQL replay signal.
    assert.equal(plan.page, undefined);
    assert.equal(plan.pageSize, undefined);
  });
});

describe('conversation context validation', () => {
  it('asks for clarification when "above companies" has no stored list', () => {
    const empty = priorMemory({
      lastCompanies: [],
      entities: [],
      lastPageItems: [],
    });
    const msg = 'How many female employees are in the above companies?';
    const check = validatePriorCompanyReference(msg, empty);
    assert.equal(check.ok, false);
    assert.equal(check.companies.length, 0);
    assert.match(check.clarification, /previous company list/i);

    const { classification, merged } = mergeTurn(msg, empty);
    assert.equal(classification.filters?.needsPriorCompanies, true);
    assert.equal(merged.wantsAll, false);
    assert.deepEqual(merged.entities, []);
    assert.ok(merged.clarification || classification.clarification);
    assert.match(
      merged.clarification || classification.clarification,
      /previous company list/i,
    );
  });

  it('never expands "those companies" to all companies', () => {
    const empty = priorMemory({
      lastCompanies: [],
      entities: [],
      lastPageItems: [],
      lastList: { total: 1336 },
    });
    const { merged } = mergeTurn('Compare those companies on Scope 1', empty);
    assert.equal(merged.wantsAll, false);
    assert.equal(merged.filters?.needsPriorCompanies, true);
    assert.deepEqual(merged.entities, []);
    assert.notEqual(merged.intent, 'LIST_ALL_COMPANIES');
  });

  it('reuses stored companies when memory has a list', () => {
    const check = validatePriorCompanyReference(
      'What about female employee share for them?',
      priorMemory(),
    );
    assert.equal(check.ok, true);
    assert.deepEqual(check.companies.slice(0, 3), PRIOR_COMPANIES.slice(0, 3));
    assert.equal(check.clarification, null);
  });
});

describe('first-class male employee metrics', () => {
  it('male_employee_count is FOUND via direct schema lookup', () => {
    const r = resolveMetricState(
      'How many male employees are in the above companies?',
    );
    assert.equal(r.state, METRIC_RESOLUTION.FOUND);
    assert.equal(r.stage, 'direct');
    assert.equal(r.metric, 'male_employee_count');
  });

  it('male_employee_share is FOUND via direct schema lookup', () => {
    const r = resolveMetricState('What is the male employee share for the above companies?');
    assert.equal(r.state, METRIC_RESOLUTION.FOUND);
    assert.equal(r.metric, 'male_employee_share');
  });

  it('male workforce phrasing maps to male_employee_share', () => {
    const r = resolveMetricState('male workforce percentage for Infosys');
    assert.equal(r.state, METRIC_RESOLUTION.FOUND);
    assert.equal(r.metric, 'male_employee_share');
  });

  it('male metrics reuse prior companies and do not inherit prior metric', () => {
    const { classification, merged } = mergeTurn(
      'How many male employees are in the above companies?',
    );
    assert.equal(classification.metricResolution, METRIC_RESOLUTION.FOUND);
    assert.equal(merged.metric, 'male_employee_count');
    assert.notEqual(merged.metric, 'female_employee_share');
    assert.deepEqual(merged.entities.slice(0, 3), PRIOR_COMPANIES.slice(0, 3));
  });

  it('disabled male employees stays unsupported', () => {
    const r = resolveMetricState(
      'How many disabled male employees are in the above companies?',
    );
    assert.equal(r.state, METRIC_RESOLUTION.UNSUPPORTED);
    assert.equal(r.stage, 'unavailable');
  });

  it('stage order: direct male before derived board', () => {
    const direct = resolveMetricState('female employee share in 2025');
    assert.equal(direct.stage, 'direct');
    assert.equal(direct.state, METRIC_RESOLUTION.FOUND);

    // Employee male is schema; board male remains derived.
    assert.equal(matchDerivedMetric('male employee count'), null);
    assert.equal(matchDerivedMetric('male board share')?.id, 'male_board_share');
  });

  it('clarification constant is exported for missing prior companies', () => {
    assert.match(MISSING_PRIOR_COMPANIES_CLARIFICATION, /previous company list/i);
  });
});
