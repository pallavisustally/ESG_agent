/**
 * Load-test helper unit tests (no network).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  percentile,
  summarizeLatencies,
  loadLoadScenarios,
  sampleMemoryUsage,
} from './load-helpers.js';

describe('load-helpers', () => {
  it('computes percentiles', () => {
    const values = [10, 20, 30, 40, 50];
    assert.equal(percentile(values, 50), 30);
    assert.ok(percentile(values, 95) >= 40);
  });

  it('summarizes latencies', () => {
    const s = summarizeLatencies([100, 200, 300, 400, 500]);
    assert.equal(s.count, 5);
    assert.equal(s.p50, 300);
    assert.equal(s.min, 100);
    assert.equal(s.max, 500);
  });

  it('loads mixed-workload and conversation packs', async () => {
    const mixed = await loadLoadScenarios('mixed-workload');
    assert.ok(mixed.length >= 10);
    assert.ok(mixed.every((c) => c.question && c.scenario));
    const conv = await loadLoadScenarios('long-conversation');
    assert.ok(conv.length >= 5);
    const all = await loadLoadScenarios('all');
    assert.ok(all.length >= mixed.length + conv.length);
  });

  it('samples memory usage', () => {
    const m = sampleMemoryUsage();
    assert.ok(m.rssMb > 0);
    assert.ok(m.heapUsedMb > 0);
  });
});
