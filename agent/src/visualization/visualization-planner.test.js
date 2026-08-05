/**
 * Visualization Planner — ChartSpec, selection, validation, multi-metric, insights.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  planVisualization,
  planRankingChart,
  planCompareChart,
  planTrendChart,
  planFromLegacyConfig,
  selectChartType,
  inferVisualizationIntent,
  validateChartSpec,
  createChartSpec,
  normalizeChartJson,
  buildChartConfig,
} from './index.js';

describe('chart type selection', () => {
  it('picks line for trends over years', () => {
    assert.equal(
      selectChartType({
        visualizationIntent: 'trend',
        labels: ['2023', '2024', '2025'],
        seriesCount: 1,
      }),
      'line',
    );
  });

  it('picks horizontalBar for long rankings', () => {
    assert.equal(
      selectChartType({
        visualizationIntent: 'ranking',
        labels: Array.from({ length: 8 }, (_, i) => `Company ${i}`),
        seriesCount: 1,
      }),
      'horizontalBar',
    );
  });

  it('picks groupedBar for multi-metric comparison', () => {
    assert.equal(
      selectChartType({
        visualizationIntent: 'comparison',
        labels: ['A', 'B'],
        seriesCount: 2,
      }),
      'groupedBar',
    );
  });

  it('picks pie for composition', () => {
    assert.equal(
      selectChartType({
        visualizationIntent: 'composition',
        labels: ['Scope 1', 'Scope 2', 'Scope 3'],
        seriesCount: 1,
      }),
      'pie',
    );
  });

  it('picks scatter for correlation', () => {
    assert.equal(
      selectChartType({
        visualizationIntent: 'correlation',
        labels: ['A', 'B', 'C'],
        seriesCount: 2,
      }),
      'scatter',
    );
  });
});

describe('intent inference', () => {
  it('detects ranking from TOP_METRIC', () => {
    assert.equal(
      inferVisualizationIntent({ intent: 'TOP_METRIC', labels: ['A', 'B'] }),
      'ranking',
    );
  });

  it('detects trend from year labels', () => {
    assert.equal(
      inferVisualizationIntent({ labels: ['2023', '2024', '2025'], seriesCount: 1 }),
      'trend',
    );
  });
});

describe('validation', () => {
  it('rejects empty datasets', () => {
    const result = validateChartSpec(createChartSpec({
      labels: ['A'],
      series: [],
    }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === 'EMPTY_DATASETS'));
  });

  it('rejects duplicate labels', () => {
    const result = validateChartSpec(createChartSpec({
      labels: ['Infosys', 'Infosys'],
      series: [{ label: 'Scope 1', values: [1, 2], unit: 'tCO2e' }],
    }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === 'DUPLICATE_LABELS'));
  });

  it('rejects all-null series', () => {
    const result = validateChartSpec(createChartSpec({
      labels: ['A', 'B'],
      series: [{ label: 'Scope 1', values: [null, null] }],
    }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === 'ALL_NULL'));
  });

  it('warns on missing years', () => {
    const result = validateChartSpec(createChartSpec({
      intent: 'trend',
      chartType: 'line',
      labels: ['2023', '2025'],
      series: [{ label: 'Scope 1', values: [10, 12], unit: 'tCO2e' }],
    }));
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((w) => w.code === 'MISSING_YEARS'));
  });

  it('rejects unit mismatch for pie/composition', () => {
    const result = validateChartSpec(createChartSpec({
      intent: 'composition',
      chartType: 'pie',
      labels: ['A', 'B'],
      series: [
        { label: 'Energy', values: [1, 2], unit: 'GJ' },
      ],
    }));
    // single series pie with positives — units ok; test multi-unit via two series pie
    const multi = validateChartSpec(createChartSpec({
      intent: 'composition',
      chartType: 'pie',
      labels: ['A', 'B'],
      series: [
        { label: 'Energy', values: [1, 2], unit: 'GJ' },
        { label: 'Water', values: [3, 4], unit: 'KL' },
      ],
    }));
    assert.equal(multi.ok, false);
    assert.ok(multi.errors.some((e) => e.code === 'UNIT_MISMATCH' || e.code === 'PIE_MULTI_SERIES'));
    assert.equal(result.ok, true);
  });
});

describe('planVisualization', () => {
  it('plans a ranking bar chart', () => {
    const planned = planRankingChart({
      rows: [
        { company: 'A Ltd', year: 2025, metric_value: 100 },
        { company: 'B Ltd', year: 2025, metric_value: 80 },
      ],
      metric: 'scope1_emissions',
      year: 2025,
      order: 'DESC',
    });
    assert.equal(planned.ok, true);
    assert.equal(planned.spec.intent, 'ranking');
    assert.ok(['bar', 'horizontalBar'].includes(planned.spec.chartType));
    assert.match(planned.chartBlock, /```json-chart/);
    assert.equal(planned.config.datasets[0].data[0], 100);
    assert.ok(planned.insights.length >= 1);
  });

  it('plans multi-metric grouped comparison (Scope 1 + Scope 2)', () => {
    const planned = planCompareChart({
      rows: [
        { company: 'Infosys', year: 2025, scope1_emissions: 100, scope2_emissions: 200 },
        { company: 'TCS', year: 2025, scope1_emissions: 90, scope2_emissions: 210 },
      ],
      metrics: ['scope1_emissions', 'scope2_emissions'],
      year: 2025,
    });
    assert.equal(planned.ok, true);
    assert.equal(planned.spec.series.length, 2);
    assert.equal(planned.spec.chartType, 'groupedBar');
    assert.equal(planned.config.chartType, 'bar');
    assert.equal(planned.config.datasets.length, 2);
    assert.match(planned.config.title, /Scope 1/i);
  });

  it('plans Female + Male multi-metric chart', () => {
    const planned = planVisualization({
      rows: [
        { company: 'A', female_employee_share: 32, male_employee_share: 68 },
        { company: 'B', female_employee_share: 40, male_employee_share: 60 },
      ],
      metrics: ['female_employee_share', 'male_employee_share'],
      preferredIntent: 'comparison',
      year: 2025,
    });
    assert.equal(planned.ok, true);
    assert.equal(planned.spec.series.length, 2);
    assert.equal(planned.spec.meta.unit, '%');
  });

  it('plans Energy + Water with unit mismatch warning but still renders grouped bar', () => {
    const planned = planVisualization({
      rows: [
        { company: 'A', energy_consumption: 1000, water_consumption: 500 },
        { company: 'B', energy_consumption: 800, water_consumption: 600 },
      ],
      metrics: ['energy_consumption', 'water_consumption'],
      preferredIntent: 'comparison',
    });
    assert.equal(planned.ok, true);
    assert.ok(planned.validation.warnings.some((w) => w.code === 'UNIT_MISMATCH'));
  });

  it('plans a year trend as line', () => {
    const planned = planTrendChart({
      rows: [
        { year: 2023, scope1_emissions: 10 },
        { year: 2024, scope1_emissions: 12 },
        { year: 2025, scope1_emissions: 11 },
      ],
      metrics: ['scope1_emissions'],
      company: 'Infosys Limited',
    });
    assert.equal(planned.ok, true);
    assert.equal(planned.spec.chartType, 'line');
    assert.equal(planned.config.chartType, 'line');
    assert.ok(planned.insights.some((i) => /increased|decreased|unchanged|moved/i.test(i)));
  });

  it('rejects empty rows', () => {
    const planned = planVisualization({ rows: [], metrics: ['scope1_emissions'] });
    assert.equal(planned.ok, false);
    assert.equal(planned.reason, 'empty_rows');
  });
});

describe('chart builder + normalize', () => {
  it('maps horizontalBar to bar + indexAxis y', () => {
    const config = buildChartConfig(createChartSpec({
      chartType: 'horizontalBar',
      labels: ['A', 'B'],
      series: [{ label: 'Scope 1', values: [1, 2], unit: 'tCO2e' }],
      meta: { title: 'Test' },
    }));
    assert.equal(config.chartType, 'bar');
    assert.equal(config.indexAxis, 'y');
  });

  it('normalizeChartJson strips invalid charts', () => {
    const text = [
      'Hello',
      '```json-chart',
      JSON.stringify({
        chartType: 'bar',
        title: 'Bad',
        labels: ['A', 'A'],
        datasets: [{ label: 'X', data: [1, 2] }],
      }),
      '```',
      'Done',
    ].join('\n');
    const out = normalizeChartJson(text);
    assert.doesNotMatch(out, /```json-chart/);
    assert.match(out, /Hello/);
    assert.match(out, /Done/);
  });

  it('normalizeChartJson keeps valid nested SQL-agent shape', () => {
    const text = [
      '```json-chart',
      JSON.stringify({
        type: 'bar',
        title: 'Highest Scope 1 (2025)',
        data: {
          labels: ['A', 'B'],
          datasets: [{ label: 'Scope 1', data: [10, 8] }],
        },
      }),
      '```',
    ].join('\n');
    const out = normalizeChartJson(text);
    assert.match(out, /"chartType": "bar"/);
    assert.match(out, /"labels"/);
    assert.doesNotMatch(out, /"data": \{/);
  });

  it('planFromLegacyConfig upgrades table repair configs', () => {
    const planned = planFromLegacyConfig({
      chartType: 'line',
      title: 'Emissions Trend Chart',
      labels: ['2025', '2026'],
      datasets: [
        { label: 'Scope 1 Emissions', data: [8745, 9100] },
        { label: 'Scope 2 Emissions', data: [38586, 39200] },
      ],
    }, { userMessage: 'show line chart of emissions trend' });
    assert.equal(planned.ok, true);
    assert.equal(planned.config.datasets.length, 2);
  });
});
