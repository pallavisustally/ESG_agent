/**
 * Visualization Engine regression — Dataset → Context → Engine → ChartSpec path.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDataset,
  createVisualizationContext,
  datasetFromRankingRows,
  datasetFromCompareRows,
  datasetFromSectorRows,
  datasetFromTrendRows,
  datasetFromReportTable,
  datasetFromPdfExtract,
  datasetFromMarkdownTable,
  recommendChart,
  visualize,
  visualizeAsync,
  validateChartSpec,
  createChartSpec,
  planRankingChart,
  planCompareChart,
  planTrendChart,
  planReportChart,
  composeChartResponse,
  buildInsightExplanationPrompt,
  formatObservationMarkdown,
  generateChartInsights,
  isSingleValueDataset,
} from './index.js';

describe('Dataset abstraction', () => {
  it('builds ranking datasets without SQL coupling', () => {
    const dataset = datasetFromRankingRows({
      rows: [
        { company: 'A', year: 2024, metric_value: 10 },
        { company: 'B', year: 2024, metric_value: 5 },
      ],
      metric: 'scope1_emissions',
      year: 2024,
    });
    assert.equal(dataset.source, 'sql');
    assert.deepEqual(dataset.labels, ['A', 'B']);
    assert.deepEqual(dataset.metrics, ['scope1_emissions']);
    assert.equal(dataset.values.scope1_emissions[0], 10);
  });

  it('detects single-value datasets', () => {
    const dataset = createDataset({
      rows: [{ company: 'A', scope1_emissions: 1 }],
      metrics: ['scope1_emissions'],
      labelKey: 'company',
    });
    assert.equal(isSingleValueDataset(dataset), true);
  });
});

describe('VisualizationContext', () => {
  it('captures ranking intent and chart preference', () => {
    const ctx = createVisualizationContext({
      intent: 'TOP_METRIC',
      userMessage: 'show a horizontal bar chart of top emitters',
      metrics: ['scope1_emissions'],
      year: 2024,
    });
    assert.equal(ctx.preferredIntent, 'ranking');
    assert.equal(ctx.ranking, true);
    assert.equal(ctx.chartPreference, 'horizontalBar');
  });
});

describe('Chart recommendation', () => {
  it('maps trend → line, ranking → bar/horizontal, comparison → groupedBar', () => {
    const trend = recommendChart({
      dataset: datasetFromTrendRows({
        rows: [
          { year: 2023, scope1_emissions: 1 },
          { year: 2024, scope1_emissions: 2 },
        ],
        metrics: ['scope1_emissions'],
      }),
      context: createVisualizationContext({ preferredIntent: 'trend' }),
    });
    assert.equal(trend.chartType, 'line');

    const compare = recommendChart({
      dataset: datasetFromCompareRows({
        rows: [
          { company: 'A', scope1_emissions: 1, scope2_emissions: 2 },
          { company: 'B', scope1_emissions: 3, scope2_emissions: 4 },
        ],
        metrics: ['scope1_emissions', 'scope2_emissions'],
      }),
      context: createVisualizationContext({ preferredIntent: 'comparison' }),
    });
    assert.equal(compare.chartType, 'groupedBar');

    const single = recommendChart({
      dataset: createDataset({
        rows: [{ company: 'A', scope1_emissions: 9 }],
        metrics: ['scope1_emissions'],
      }),
      context: createVisualizationContext({}),
    });
    assert.equal(single.showChart, false);
    assert.equal(single.reason, 'single_value');
  });

  it('lets user preference override recommendation', () => {
    const rec = recommendChart({
      dataset: datasetFromCompareRows({
        rows: [
          { company: 'A', scope1_emissions: 1 },
          { company: 'B', scope1_emissions: 2 },
        ],
        metrics: ['scope1_emissions'],
      }),
      context: createVisualizationContext({
        preferredIntent: 'comparison',
        userMessage: 'draw a pie chart please',
      }),
    });
    assert.equal(rec.chartType, 'pie');
    assert.equal(rec.reason, 'user_preference');
  });
});

describe('Validation layers', () => {
  it('errors on empty / duplicate / mismatched data', () => {
    assert.equal(validateChartSpec(createChartSpec({ labels: ['A'], series: [] })).ok, false);
    assert.equal(validateChartSpec(createChartSpec({
      labels: ['A', 'A'],
      series: [{ id: 'm', label: 'M', values: [1, 2] }],
    })).ok, false);
    assert.equal(validateChartSpec(createChartSpec({
      labels: ['A', 'B'],
      series: [{ id: 'm', label: 'M', values: [1] }],
    })).ok, false);
    const dup = validateChartSpec(createChartSpec({
      labels: ['A', 'B'],
      series: [
        { id: 'a', label: 'A', values: [1, 2] },
        { id: 'a', label: 'A copy', values: [3, 4] },
      ],
    }));
    assert.equal(dup.ok, false);
    assert.ok(dup.errors.some((e) => e.code === 'DUPLICATE_DATASETS'));
  });

  it('warns on missing years and mixed units; infos on small datasets', () => {
    const missing = validateChartSpec(createChartSpec({
      intent: 'trend',
      chartType: 'line',
      labels: ['2022', '2024'],
      series: [{ id: 'm', label: 'M', values: [1, 2], unit: 'tCO2e' }],
    }));
    assert.equal(missing.ok, true);
    assert.ok(missing.warnings.some((w) => w.code === 'MISSING_YEARS'));

    const mixed = validateChartSpec(createChartSpec({
      intent: 'comparison',
      chartType: 'groupedBar',
      labels: ['A', 'B'],
      series: [
        { id: 'a', label: 'A', values: [1, 2], unit: 'tCO2e' },
        { id: 'b', label: 'B', values: [3, 4], unit: '%' },
      ],
    }));
    assert.ok(mixed.warnings.some((w) => w.code === 'UNIT_MISMATCH'));

    const small = validateChartSpec(createChartSpec({
      labels: ['A', 'B'],
      series: [{ id: 'm', label: 'M', values: [1, 2] }],
    }));
    assert.ok(small.infos?.some((i) => i.code === 'SMALL_DATASET'));
  });
});

describe('Visualization Engine entry point', () => {
  it('produces ChartSpec + json-chart for rankings', () => {
    const viz = planRankingChart({
      rows: [
        { company: 'Infosys', year: 2024, metric_value: 100 },
        { company: 'TCS', year: 2024, metric_value: 80 },
        { company: 'Wipro', year: 2024, metric_value: 60 },
      ],
      metric: 'scope1_emissions',
      year: 2024,
    });
    assert.equal(viz.ok, true);
    assert.equal(viz.spec.type, 'chart');
    assert.match(viz.chartBlock, /```json-chart/);
    assert.ok(viz.insights.length >= 1);
  });

  it('produces comparison and trend charts', () => {
    const compare = planCompareChart({
      rows: [
        { company: 'A', scope1_emissions: 1, scope2_emissions: 2 },
        { company: 'B', scope1_emissions: 3, scope2_emissions: 4 },
      ],
      metrics: ['scope1_emissions', 'scope2_emissions'],
      year: 2024,
    });
    assert.equal(compare.ok, true);
    assert.equal(compare.spec.chartType, 'groupedBar');

    const trend = planTrendChart({
      rows: [
        { year: 2022, scope1_emissions: 10 },
        { year: 2023, scope1_emissions: 12 },
        { year: 2024, scope1_emissions: 9 },
      ],
      metrics: ['scope1_emissions'],
      company: 'Infosys',
    });
    assert.equal(trend.ok, true);
    assert.equal(trend.spec.chartType, 'line');
  });

  it('handles sector / industry datasets', () => {
    const dataset = datasetFromSectorRows({
      rows: [
        { group_label: 'IT', metric_value: 10, company_count: 3 },
        { group_label: 'Energy', metric_value: 40, company_count: 2 },
      ],
      metric: 'scope1_emissions',
      groupBy: 'sector',
      year: 2024,
    });
    const viz = visualize({
      dataset,
      context: createVisualizationContext({
        preferredIntent: 'ranking',
        intent: 'SECTOR_SUMMARY',
        year: 2024,
        dataset,
      }),
    });
    assert.equal(viz.ok, true);
    assert.deepEqual(viz.spec.labels, ['IT', 'Energy']);
  });

  it('never renders invalid / empty datasets', () => {
    const empty = visualize({
      dataset: createDataset({ rows: [], metrics: ['scope1_emissions'] }),
      context: createVisualizationContext({}),
    });
    assert.equal(empty.ok, false);
    assert.ok(empty.omitMessage);

    const bad = visualize({
      dataset: createDataset({
        rows: [
          { company: 'A', scope1_emissions: 1 },
          { company: 'A', scope1_emissions: 2 },
        ],
        metrics: ['scope1_emissions'],
      }),
      context: createVisualizationContext({ preferredIntent: 'ranking' }),
    });
    assert.equal(bad.ok, false);
  });

  it('report and PDF adapters share the engine', () => {
    const rows = [
      { year: 2023, renewable_energy_share: 40 },
      { year: 2024, renewable_energy_share: 55 },
    ];
    const report = planReportChart({
      rows,
      metrics: ['renewable_energy_share'],
      company: 'Infosys',
      preferredIntent: 'trend',
    });
    const pdf = planReportChart({
      rows,
      metrics: ['renewable_energy_share'],
      company: 'Infosys',
      preferredIntent: 'trend',
      fromPdf: true,
    });
    assert.equal(report.ok, true);
    assert.equal(pdf.ok, true);
    assert.equal(report.spec.chartType, 'line');
    assert.equal(pdf.dataset.source, 'pdf');

    const fromTable = datasetFromMarkdownTable({
      headers: ['Year', 'Scope 1'],
      rows: [['2023', '10'], ['2024', '12']],
    });
    assert.equal(fromTable.source, 'markdown');
    assert.ok(fromTable.metrics.length);
  });
});

describe('Insight engine + grounded LLM layer', () => {
  it('emits deterministic statistical insights', () => {
    const viz = planTrendChart({
      rows: [
        { year: 2022, scope1_emissions: 100 },
        { year: 2023, scope1_emissions: 120 },
        { year: 2024, scope1_emissions: 90 },
      ],
      metrics: ['scope1_emissions'],
      company: 'A',
    });
    const insights = generateChartInsights(viz.spec);
    assert.ok(insights.some((i) => /increased|decreased|unchanged|moved/i.test(i)));
  });

  it('builds grounded explanation prompts and rejects ungrounded numbers', () => {
    const prompt = buildInsightExplanationPrompt({
      insights: ['A leads at 10 tCO2e.'],
      userMessage: 'compare',
      spec: { meta: { title: 'Test' }, chartType: 'bar' },
    });
    assert.ok(prompt.system.includes('ONLY the verified'));
    assert.equal(
      formatObservationMarkdown('A leads; inventing 999999 and 888888 and 777777', ['A leads at 10 tCO2e.']),
      '',
    );
  });

  it('visualizeAsync attaches LLM observations when chatFn is provided', async () => {
    const dataset = datasetFromRankingRows({
      rows: [
        { company: 'A', year: 2024, metric_value: 10 },
        { company: 'B', year: 2024, metric_value: 4 },
      ],
      metric: 'scope1_emissions',
      year: 2024,
    });
    const result = await visualizeAsync({
      dataset,
      context: createVisualizationContext({
        preferredIntent: 'ranking',
        includeLlmExplanation: true,
        dataset,
      }),
      includeLlmExplanation: true,
      chatFn: async () => 'A is ahead of B on this metric.',
    });
    assert.equal(result.ok, true);
    assert.match(result.observations, /Observations/i);
  });
});

describe('Response composer structure', () => {
  it('orders Summary → Chart → Insights', () => {
    const viz = planRankingChart({
      rows: [
        { company: 'A', year: 2024, metric_value: 10 },
        { company: 'B', year: 2024, metric_value: 5 },
      ],
      metric: 'scope1_emissions',
      year: 2024,
    });
    const composed = composeChartResponse({
      summary: '### Ranking',
      ok: true,
      chartBlock: viz.chartBlock,
      insights: viz.insights,
      insightMarkdown: viz.insightMarkdown,
      observations: '**Observations**\nA leads.',
      sources: '_Source: BRSR_',
    });
    const idxSummary = composed.markdown.indexOf('### Ranking');
    const idxChart = composed.markdown.indexOf('```json-chart');
    const idxInsights = composed.markdown.indexOf('Chart insights');
    const idxObs = composed.markdown.indexOf('Observations');
    const idxSrc = composed.markdown.indexOf('Source');
    assert.ok(idxSummary < idxChart);
    assert.ok(idxChart < idxInsights);
    assert.ok(idxInsights < idxObs);
    assert.ok(idxObs < idxSrc);
  });
});

describe('Report/PDF dataset helpers', () => {
  it('datasetFromReportTable / datasetFromPdfExtract normalize identically', () => {
    const rows = [{ year: 2024, water_consumption: 100 }];
    const report = datasetFromReportTable({ rows, metrics: ['water_consumption'] });
    const pdf = datasetFromPdfExtract({ rows, metrics: ['water_consumption'] });
    assert.equal(report.source, 'report');
    assert.equal(pdf.source, 'pdf');
    assert.deepEqual(report.metrics, pdf.metrics);
  });
});
