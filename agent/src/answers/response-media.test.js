/**
 * Response media repair — charts from tables, strip Citations footers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  repairResponseMedia,
  chartConfigFromMarkdownTable,
  stripCitationFooters,
} from './response-media.js';

describe('response media repair', () => {
  const sample = [
    '### Scope 1 and Scope 2 Emissions Trend for Infosys Limited (2025-2026)',
    '',
    'In 2025, Infosys reported 8,745 p. 164 [source](/local-pdf/2025/INFY/a.pdf#page=164) tons.',
    '',
    'A line chart illustrating the emissions for 2025 is provided below.',
    '',
    '| Year | Scope 1 Emissions | Scope 2 Emissions |',
    '|------|-------------------|-------------------|',
    '| 2025 | 8,745             | 38,586            |',
    '',
    '![Emissions Trend Chart](Emissions%20Trend%20Chart)',
    '',
    '**Citations:**',
    '- Scope 1 Emissions: p. 164 [source](#)',
    '- Scope 2 Emissions: p. 164 source',
  ].join('\n');

  it('strips Citations footer', () => {
    const out = stripCitationFooters(sample);
    assert.doesNotMatch(out, /\*\*Citations:\*\*/i);
    assert.doesNotMatch(out, /Scope 2 Emissions: p\. 164 source/i);
    assert.match(out, /\/local-pdf\/2025\/INFY/i);
  });

  it('builds chart config from markdown table', () => {
    const cfg = chartConfigFromMarkdownTable({
      headers: ['Year', 'Scope 1 Emissions', 'Scope 2 Emissions'],
      rows: [['2025', '8,745', '38,586']],
    }, { chartType: 'line', title: 'Emissions Trend Chart' });
    assert.equal(cfg.chartType, 'line');
    assert.deepEqual(cfg.labels, ['2025']);
    assert.equal(cfg.datasets.length, 2);
    assert.deepEqual(cfg.datasets[0].data, [8745]);
    assert.deepEqual(cfg.datasets[1].data, [38586]);
  });

  it('replaces fake chart image with json-chart and drops Citations footer', () => {
    const out = repairResponseMedia(sample);
    assert.match(out, /```json-chart/);
    assert.match(out, /"chartType": "line"/);
    assert.match(out, /8745/);
    assert.doesNotMatch(out, /!\[Emissions Trend Chart\]/);
    assert.doesNotMatch(out, /\*\*Citations:\*\*/i);
  });
});
