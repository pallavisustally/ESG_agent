/**
 * Phase 7 — Response validation engine tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { INTENTS } from '../intent/classify-intent.js';
import {
  validateResponse,
  validateMetricAlignment,
  validateCompanyAlignment,
  validateYearAlignment,
  validateSourceAlignment,
  isMetricAnsweredByNarrative,
  repairFabricatedLlmAnswer,
} from './response-validator.js';

describe('response-validator: metric alignment', () => {
  it('rejects carbon emissions answered as reduction initiatives', () => {
    const text = 'Infosys has several carbon reduction initiatives including renewable PPAs and EV fleets.';
    assert.equal(isMetricAnsweredByNarrative(text, 'total_emissions'), true);
    const check = validateMetricAlignment({
      text,
      metric: 'total_emissions',
      source: 'llm',
    });
    assert.equal(check.ok, false);
    assert.ok(check.errors.some((e) => /narrative_initiatives/i.test(e)));
  });

  it('allows numeric emissions answers', () => {
    const text = 'Infosys Scope 1 emissions were 12,450 tCO2e in FY2024.';
    assert.equal(isMetricAnsweredByNarrative(text, 'scope1_emissions'), false);
  });

  it('detects sql metric mismatch', () => {
    const check = validateMetricAlignment({
      text: 'ok',
      metric: 'scope1_emissions',
      data: { metric: 'female_employee_share', rows: [{ company: 'X', metric_value: 1 }] },
      source: 'sql',
    });
    assert.equal(check.ok, false);
  });
});

describe('response-validator: company / year / source', () => {
  it('flags company mismatch on single-company lookup rows', () => {
    const check = validateCompanyAlignment({
      companies: ['Infosys Limited'],
      data: { rows: [{ company: 'Tata Steel Limited', metric_value: 1, year: 2024 }] },
    });
    assert.equal(check.ok, false);
  });

  it('flags year mismatch', () => {
    const check = validateYearAlignment({
      expectedYear: 2024,
      data: { year: 2020, assumedYear: false },
    });
    assert.equal(check.ok, false);
  });

  it('allows assumed year', () => {
    const check = validateYearAlignment({
      expectedYear: 2024,
      data: { year: 2023, assumedYear: true },
    });
    assert.equal(check.ok, true);
  });

  it('rejects structured intent answered via narrative source', () => {
    const check = validateSourceAlignment({
      source: 'narrative',
      intent: INTENTS.TOP_METRIC,
      text: '1. Infosys leads with strong ESG programs.',
    });
    assert.equal(check.ok, false);
  });
});

describe('validateResponse end-to-end', () => {
  it('sets shouldReplan when metric answered by narrative', () => {
    const v = validateResponse({
      text: 'The company published carbon reduction initiatives across scopes.',
      intent: INTENTS.METRIC_LOOKUP,
      classification: {
        intent: INTENTS.METRIC_LOOKUP,
        metric: 'total_emissions',
        entities: ['Infosys Limited'],
      },
      source: 'llm',
    });
    assert.equal(v.ok, false);
    assert.equal(v.shouldReplan, true);
  });

  it('repairs narrative mismatch with grounded message', () => {
    const validation = {
      ok: false,
      errors: ['metric_answered_by_narrative_initiatives'],
    };
    const text = repairFabricatedLlmAnswer({
      validation,
      intent: INTENTS.METRIC_LOOKUP,
      classification: { metric: 'total_emissions' },
    });
    assert.match(text, /will not substitute carbon-reduction initiatives/i);
  });

  it('accepts grounded SQL ranking text', () => {
    const v = validateResponse({
      text: '1. **Tata Steel** — 1,200,000\n2. **JSW Steel** — 900,000',
      intent: INTENTS.TOP_METRIC,
      classification: {
        intent: INTENTS.TOP_METRIC,
        metric: 'scope1_emissions',
        filters: { years: [2024] },
      },
      data: {
        metric: 'scope1_emissions',
        rows: [
          { company: 'Tata Steel', metric_value: 1200000, year: 2024 },
          { company: 'JSW Steel', metric_value: 900000, year: 2024 },
        ],
      },
      source: 'sql',
      hasToolEvidence: true,
    });
    assert.equal(v.ok, true);
  });
});
