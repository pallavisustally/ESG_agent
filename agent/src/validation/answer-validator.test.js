/**
 * Unified answer validation — PASS / WARNING / ERROR + chart↔data + citations.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { INTENTS } from '../intent/classify-intent.js';
import {
  VERDICTS,
  validateAnswer,
  applyAnswerValidation,
  validateChartAgainstData,
  validateCitationPresence,
  shouldRequireCitations,
  repairAnswer,
  safeFailureMessage,
} from './answer-validator.js';

describe('answer-validator: verdict mapping', () => {
  it('PASS for aligned SQL ranking answer', () => {
    const v = validateAnswer({
      text: '1. **Infosys Limited** — 12,000 tCO2e\n2. **TCS** — 11,000 tCO2e',
      classification: {
        intent: INTENTS.TOP_METRIC,
        metric: 'scope1_emissions',
        entities: [],
        filters: { years: [2024] },
      },
      data: {
        metric: 'scope1_emissions',
        year: 2024,
        rows: [
          { company: 'Infosys Limited', metric_value: 12000, year: 2024 },
          { company: 'Tata Consultancy Services Limited', metric_value: 11000, year: 2024 },
        ],
        order: 'DESC',
      },
      source: 'sql',
    });
    assert.equal(v.verdict, VERDICTS.PASS);
    assert.equal(v.ok, true);
  });

  it('ERROR on metric mismatch', () => {
    const v = validateAnswer({
      text: 'Female employee share is 40%.',
      classification: {
        intent: INTENTS.METRIC_LOOKUP,
        metric: 'scope1_emissions',
        entities: ['Infosys Limited'],
        filters: { years: [2024] },
      },
      data: {
        metric: 'female_employee_share',
        year: 2024,
        rows: [{ company: 'Infosys Limited', metric_value: 40, year: 2024 }],
      },
      source: 'sql',
    });
    assert.equal(v.verdict, VERDICTS.ERROR);
    assert.ok(v.errors.some((e) => /metric_mismatch/i.test(e)));
  });

  it('ERROR on company mismatch for single-company lookup', () => {
    const v = validateAnswer({
      text: 'Tata Steel Scope 1 was 1 Mt.',
      classification: {
        intent: INTENTS.METRIC_LOOKUP,
        metric: 'scope1_emissions',
        entities: ['Infosys Limited'],
        filters: { years: [2024] },
      },
      data: {
        metric: 'scope1_emissions',
        year: 2024,
        rows: [{ company: 'Tata Steel Limited', metric_value: 1000000, year: 2024 }],
      },
      source: 'sql',
    });
    assert.equal(v.verdict, VERDICTS.ERROR);
    assert.ok(v.errors.some((e) => /company_mismatch/i.test(e)));
  });

  it('ERROR on year mismatch', () => {
    const v = validateAnswer({
      text: 'Infosys Scope 1 in 2020 was 9,000.',
      classification: {
        intent: INTENTS.METRIC_LOOKUP,
        metric: 'scope1_emissions',
        entities: ['Infosys Limited'],
        filters: { years: [2024] },
      },
      data: {
        metric: 'scope1_emissions',
        year: 2020,
        assumedYear: false,
        rows: [{ company: 'Infosys Limited', metric_value: 9000, year: 2020 }],
      },
      source: 'sql',
    });
    assert.equal(v.verdict, VERDICTS.ERROR);
    assert.ok(v.errors.some((e) => /year_mismatch/i.test(e)));
  });

  it('WARNING on assumed year', () => {
    const v = validateAnswer({
      text: 'Infosys Scope 1 (latest available year 2023) was 9,000 tCO2e.',
      classification: {
        intent: INTENTS.METRIC_LOOKUP,
        metric: 'scope1_emissions',
        entities: ['Infosys Limited'],
        filters: { years: [2024] },
      },
      data: {
        metric: 'scope1_emissions',
        year: 2023,
        assumedYear: true,
        rows: [{ company: 'Infosys Limited', metric_value: 9000, year: 2023 }],
      },
      source: 'sql',
    });
    assert.notEqual(v.verdict, VERDICTS.ERROR);
    assert.equal(v.ok, true);
  });

  it('skips hard checks for clarification', () => {
    const v = validateAnswer({
      text: 'Which company should I use?',
      classification: { intent: INTENTS.UNKNOWN, needsClarification: true },
      executionPlan: { needsClarification: true },
      source: 'composer',
    });
    assert.equal(v.verdict, VERDICTS.PASS);
  });
});

describe('answer-validator: chart ↔ data', () => {
  it('PASS when chart labels match companies and values', () => {
    const cross = validateChartAgainstData({
      chart: {
        labels: ['Infosys Limited', 'Tata Steel Limited'],
        datasets: [{ label: 'Scope 1', data: [100, 200] }],
      },
      data: {
        rows: [
          { company: 'Infosys Limited', metric_value: 100, year: 2024 },
          { company: 'Tata Steel Limited', metric_value: 200, year: 2024 },
        ],
      },
      classification: { metric: 'scope1_emissions' },
    });
    assert.equal(cross.ok, true);
    assert.ok(!cross.issues.some((i) => i.severity === 'error'));
  });

  it('ERROR when chart companies do not match rows', () => {
    const cross = validateChartAgainstData({
      chart: {
        labels: ['Acme Corp', 'Globex Inc'],
        datasets: [{ data: [1, 2] }],
      },
      data: {
        rows: [
          { company: 'Infosys Limited', metric_value: 1 },
          { company: 'Tata Steel Limited', metric_value: 2 },
        ],
      },
    });
    assert.equal(cross.ok, false);
    assert.ok(cross.issues.some((i) => i.code === 'chart_company_mismatch'));
  });

  it('ERROR when chart values disagree with rows', () => {
    const cross = validateChartAgainstData({
      chart: {
        labels: ['Infosys Limited', 'Tata Steel Limited'],
        datasets: [{ data: [999, 888] }],
      },
      data: {
        rows: [
          { company: 'Infosys Limited', metric_value: 100 },
          { company: 'Tata Steel Limited', metric_value: 200 },
        ],
      },
    });
    assert.equal(cross.ok, false);
    assert.ok(cross.issues.some((i) => i.code === 'chart_value_mismatch'));
  });

  it('validateAnswer includes chart cross-check errors', () => {
    const chartBlock = [
      '```json-chart',
      JSON.stringify({
        type: 'chart',
        chartType: 'bar',
        labels: ['Wrong Co A', 'Wrong Co B'],
        datasets: [{ label: 'Scope 1', data: [1, 2] }],
      }),
      '```',
    ].join('\n');
    const v = validateAnswer({
      text: `Ranking:\n${chartBlock}`,
      classification: {
        intent: INTENTS.TOP_METRIC,
        metric: 'scope1_emissions',
        filters: { years: [2024] },
      },
      data: {
        metric: 'scope1_emissions',
        year: 2024,
        rows: [
          { company: 'Infosys Limited', metric_value: 1, year: 2024 },
          { company: 'Tata Steel Limited', metric_value: 2, year: 2024 },
        ],
        order: 'DESC',
      },
      visualization: { chartBlock },
      source: 'sql',
    });
    assert.equal(v.verdict, VERDICTS.ERROR);
    assert.ok(v.errors.some((e) => /chart_company_mismatch/i.test(e)));
  });
});

describe('answer-validator: citations', () => {
  it('requires citations for REPORT_LOOKUP', () => {
    assert.equal(
      shouldRequireCitations({
        classification: { intent: INTENTS.REPORT_LOOKUP },
        source: 'report',
      }),
      true,
    );
  });

  it('does not require citations for rankings', () => {
    assert.equal(
      shouldRequireCitations({
        classification: { intent: INTENTS.TOP_METRIC },
        executionPlan: { needsSql: true },
        source: 'sql',
      }),
      false,
    );
  });

  it('ERROR when citations required but missing', () => {
    const check = validateCitationPresence({
      text: 'Here is the BRSR narrative for Infosys.',
      citations: [],
      required: true,
    });
    assert.equal(check.ok, false);
    assert.ok(check.issues.some((i) => i.code === 'citations_required_missing'));
  });

  it('PASS when inline source link present', () => {
    const check = validateCitationPresence({
      text: 'See p. 12 [source](/local-pdf/infosys.pdf#page=12)',
      citations: [],
      required: true,
    });
    assert.equal(check.ok, true);
  });
});

describe('answer-validator: repair + apply', () => {
  it('strips mismatched chart on repair', () => {
    const text = [
      'Infosys leads with 100 tCO2e.',
      '```json-chart',
      JSON.stringify({
        labels: ['Wrong'],
        datasets: [{ data: [1] }],
      }),
      '```',
    ].join('\n');
    const validation = {
      ok: false,
      verdict: VERDICTS.ERROR,
      errors: ['chart_company_mismatch'],
      warnings: [],
      issues: [],
    };
    const repaired = repairAnswer({ text }, validation);
    assert.ok(repaired.repairActions.includes('strip_chart_block'));
    assert.ok(!/json-chart/i.test(repaired.text));
  });

  it('applyAnswerValidation returns safe failure when unrepairable', async () => {
    const applied = await applyAnswerValidation({
      text: 'Tata Steel emissions were high.',
      classification: {
        intent: INTENTS.METRIC_LOOKUP,
        metric: 'scope1_emissions',
        entities: ['Infosys Limited'],
        filters: { years: [2024] },
      },
      data: {
        metric: 'scope1_emissions',
        year: 2024,
        rows: [{ company: 'Tata Steel Limited', metric_value: 1, year: 2024 }],
      },
      source: 'sql',
    });
    assert.equal(applied.repaired, true);
    assert.ok(applied.repairActions.includes('safe_failure') || applied.validation.ok);
    if (applied.repairActions.includes('safe_failure')) {
      assert.match(applied.text, /couldn.?t|won.?t invent|verify/i);
    }
  });

  it('safeFailureMessage is non-empty', () => {
    const msg = safeFailureMessage({
      classification: { intent: INTENTS.TOP_METRIC, metric: 'scope1_emissions' },
    });
    assert.ok(msg.length > 20);
  });

  it('respects UNIFIED_ANSWER_VALIDATION=false', async () => {
    const prev = process.env.UNIFIED_ANSWER_VALIDATION;
    process.env.UNIFIED_ANSWER_VALIDATION = 'false';
    try {
      const applied = await applyAnswerValidation({
        text: 'anything',
        classification: { intent: INTENTS.TOP_METRIC, metric: 'scope1_emissions' },
        data: { metric: 'female_employee_share', rows: [{ company: 'X', metric_value: 1 }] },
        source: 'sql',
      });
      assert.equal(applied.text, 'anything');
      assert.ok(applied.validation.checks?.disabled);
    } finally {
      if (prev === undefined) delete process.env.UNIFIED_ANSWER_VALIDATION;
      else process.env.UNIFIED_ANSWER_VALIDATION = prev;
    }
  });
});
