/**
 * Load-test helpers — percentiles, scenario loading (no network).
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const LOAD_SCENARIOS_DIR = join(__dirname, 'load');

/**
 * @param {number[]} values
 * @param {number} p - 0..100
 */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (Math.max(0, Math.min(100, p)) / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const w = rank - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

export function summarizeLatencies(latenciesMs = []) {
  const values = latenciesMs.filter((n) => Number.isFinite(n));
  if (!values.length) {
    return {
      count: 0,
      min: null,
      max: null,
      mean: null,
      p50: null,
      p95: null,
      p99: null,
    };
  }
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    mean: Math.round(sum / values.length),
    p50: Math.round(percentile(values, 50)),
    p95: Math.round(percentile(values, 95)),
    p99: Math.round(percentile(values, 99)),
  };
}

/**
 * @param {string} [name] - file basename without .json, or 'all'
 */
export async function loadLoadScenarios(name = 'mixed-workload') {
  if (name === 'all') {
    const files = (await readdir(LOAD_SCENARIOS_DIR)).filter((f) => f.endsWith('.json'));
    const all = [];
    for (const file of files.sort()) {
      const rows = JSON.parse(await readFile(join(LOAD_SCENARIOS_DIR, file), 'utf8'));
      all.push(...rows.map((r) => ({ ...r, pack: file.replace(/\.json$/, '') })));
    }
    return all;
  }
  const path = join(LOAD_SCENARIOS_DIR, `${name}.json`);
  const rows = JSON.parse(await readFile(path, 'utf8'));
  return rows.map((r) => ({ ...r, pack: name }));
}

export function sampleMemoryUsage() {
  const m = process.memoryUsage();
  return {
    rssMb: Math.round((m.rss / 1024 / 1024) * 10) / 10,
    heapUsedMb: Math.round((m.heapUsed / 1024 / 1024) * 10) / 10,
    heapTotalMb: Math.round((m.heapTotal / 1024 / 1024) * 10) / 10,
    externalMb: Math.round((m.external / 1024 / 1024) * 10) / 10,
  };
}
