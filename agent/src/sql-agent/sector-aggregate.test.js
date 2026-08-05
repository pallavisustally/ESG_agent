/**
 * Sector / industry GROUP BY aggregate execution.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatSectorRankMarkdown,
  normalizeAggregation,
  normalizeGroupBy,
  runSectorGroupAggregate,
} from './sector-aggregate.js';
import { classifyIntent, INTENTS } from '../intent/classify-intent.js';
import { planAndValidate } from '../validation/plan-validator.js';
import { runSqlAgent } from './sql-agent.js';

describe('sector aggregate helpers', () => {
  it('normalizes aggregation and groupBy', () => {
    assert.equal(normalizeAggregation('avg'), 'AVG');
    assert.equal(normalizeAggregation('weird'), 'AVG');
    assert.equal(normalizeGroupBy('industry'), 'industry');
    assert.equal(normalizeGroupBy('company'), 'sector');
  });

  it('formats ranked sectors with optional chart', () => {
    const { text, chartBlock } = formatSectorRankMarkdown({
      rows: [
        { group_label: 'Materials', company_count: 10, metric_value: 12.5, year: 2025 },
        { group_label: 'Technology', company_count: 8, metric_value: 3.2, year: 2025 },
      ],
      metric: 'emissions_intensity',
      aggregation: 'AVG',
      groupBy: 'sector',
      year: 2025,
      order: 'DESC',
      chart: true,
    });
    assert.match(text, /Materials/);
    assert.match(text, /Technology/);
    assert.match(text, /Average Emissions intensity/);
    assert.match(text, /```json-chart/);
    assert.ok(chartBlock);
  });
});

describe('sector aggregate end-to-end (SQLite fallback ok)', () => {
  it('executes AVG emissions_intensity across sectors with chart', async () => {
    const q = 'Analyze average carbon emissions intensity across all sectors in 2025. Rank sectors and show a bar chart.';
    const classification = classifyIntent(q);
    assert.equal(classification.intent, INTENTS.SECTOR_SUMMARY);
    const planned = planAndValidate(classification, null, { userMessage: q });
    assert.equal(planned.plan.strategy, 'sql_sector_aggregate');
    assert.equal(planned.clarification, null);

    const result = await runSqlAgent({
      plan: planned.plan,
      classification: planned.classification,
      memory: null,
    });

    assert.equal(result.ok, true, result.error || 'expected ok');
    assert.match(result.text, /by sector/i);
    assert.match(result.text, /Emissions intensity/i);
    assert.match(result.text, /```json-chart/);
    assert.ok((result.data?.rows?.length || 0) >= 1);
  });

  it('runSectorGroupAggregate supports SUM and COUNT', async () => {
    const sum = await runSectorGroupAggregate({
      metric: 'scope1_emissions',
      aggregation: 'SUM',
      groupBy: 'sector',
      year: 2025,
      wantsChart: false,
      limit: 5,
    });
    assert.equal(sum.ok, true, sum.error);
    assert.equal(sum.data.aggregation, 'SUM');

    const count = await runSectorGroupAggregate({
      metric: 'scope1_emissions',
      aggregation: 'COUNT',
      groupBy: 'sector',
      year: 2025,
      wantsChart: false,
      limit: 5,
    });
    assert.equal(count.ok, true, count.error);
    assert.equal(count.data.aggregation, 'COUNT');
  });
});
