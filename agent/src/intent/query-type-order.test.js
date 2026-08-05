/**
 * Parsing-order regressions:
 * - Compare parser must not run on non-comparison queries
 * - Longest metric match wins (carbon emissions intensity)
 * - Sector aggregates never require a company
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyIntent,
  INTENTS,
  extractMetrics,
  extractCompanyCandidates,
  looksLikeCompanyComparison,
  looksLikeSectorAggregate,
} from './classify-intent.js';
import { resolveMetricState, METRIC_RESOLUTION } from './metric-resolution.js';
import { planAndValidate } from '../validation/plan-validator.js';
import { applyEntityPrecedenceToClassification } from './entity-precedence.js';

const SECTOR_QUERY =
  'Analyze average carbon emissions intensity across all sectors in 2025. Rank sectors and show a bar chart.';

describe('compare parser gating', () => {
  it('does not treat bare "and" as a company comparison', () => {
    assert.equal(looksLikeCompanyComparison(SECTOR_QUERY), false);
    assert.equal(looksLikeCompanyComparison('Average emissions across sectors and show a chart'), false);
    assert.equal(looksLikeCompanyComparison('Compare Infosys and TCS'), true);
    assert.equal(looksLikeCompanyComparison('Infosys vs TCS Scope 1'), true);
  });

  it('does not extract fake companies from sector+chart wording', () => {
    const entities = extractCompanyCandidates(SECTOR_QUERY, { allowCompareParse: false });
    assert.ok(!entities.some((e) => /analyze|average|chart|sector/i.test(e)));
  });

  it('still extracts companies for explicit compare', () => {
    const entities = extractCompanyCandidates('Compare Infosys and TCS Scope 1', {
      allowCompareParse: true,
    });
    assert.ok(entities.some((e) => /infosys/i.test(e)));
    assert.ok(entities.some((e) => /tcs/i.test(e)));
  });
});

describe('longest metric match', () => {
  it('prefers emissions_intensity over total_emissions for carbon emissions intensity', () => {
    const metrics = extractMetrics('average carbon emissions intensity across sectors');
    assert.equal(metrics[0], 'emissions_intensity');
    const state = resolveMetricState('Analyze average carbon emissions intensity across all sectors in 2025');
    assert.equal(state.state, METRIC_RESOLUTION.FOUND);
    assert.equal(state.metric, 'emissions_intensity');
  });

  it('still maps bare carbon emissions to total_emissions', () => {
    assert.equal(extractMetrics('Infosys carbon emissions in 2025')[0], 'total_emissions');
  });
});

describe('sector aggregate query type', () => {
  it('detects sector aggregate shape', () => {
    assert.equal(looksLikeSectorAggregate(SECTOR_QUERY), true);
    assert.equal(looksLikeSectorAggregate('Top industries by renewable energy share'), true);
    assert.equal(looksLikeSectorAggregate('Infosys Scope 1 emissions'), false);
  });

  it('classifies sector average+rank as SECTOR_SUMMARY without companies', () => {
    const c = classifyIntent(SECTOR_QUERY);
    assert.equal(c.intent, INTENTS.SECTOR_SUMMARY);
    assert.equal(c.metric, 'emissions_intensity');
    assert.deepEqual(c.entities, []);
    assert.equal(c.filters.aggregation, 'AVG');
    assert.equal(c.filters.groupBy, 'sector');
    assert.equal(c.filters.years?.[0], 2025);
    assert.equal(c.filters.wantsChart, true);
    assert.equal(c.filters.order, 'DESC');
  });

  it('planAndValidate does not ask for a company', () => {
    const c = classifyIntent(SECTOR_QUERY);
    const after = applyEntityPrecedenceToClassification(c, {
      validatedCompanies: [],
      candidates: c.entities,
      userMessage: SECTOR_QUERY,
      memory: null,
    });
    const planned = planAndValidate(after, null, { userMessage: SECTOR_QUERY });
    assert.equal(planned.clarification, null);
    assert.equal(planned.plan.strategy, 'sql_sector_aggregate');
    assert.ok(planned.validation.ok || !/requires at least/i.test((planned.validation.errors || []).join(' ')));
  });
});
