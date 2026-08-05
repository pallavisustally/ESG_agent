/**
 * Load benchmark JSON datasets from agent/src/evaluation/benchmarks/.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BENCHMARK_CATEGORIES,
  validateBenchmarkFile,
} from './benchmark-schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const BENCHMARKS_DIR = join(__dirname, 'benchmarks');

/**
 * @param {object} [opts]
 * @param {string|string[]|null} [opts.category]
 * @param {'smoke'|'full'|null} [opts.tier]
 * @param {string|null} [opts.id]
 * @returns {Promise<object[]>}
 */
export async function loadBenchmarks(opts = {}) {
  const categoryFilter = normalizeFilter(opts.category);
  const tierFilter = opts.tier || null;
  const idFilter = opts.id || null;

  const files = await readdir(BENCHMARKS_DIR);
  const jsonFiles = files.filter((f) => f.endsWith('.json')).sort();
  const all = [];
  const errors = [];

  for (const file of jsonFiles) {
    const category = file.replace(/\.json$/, '');
    if (categoryFilter && !categoryFilter.has(category)) continue;
    if (!BENCHMARK_CATEGORIES.includes(category)) {
      errors.push(`Unknown benchmark file category: ${file}`);
      continue;
    }
    const path = join(BENCHMARKS_DIR, file);
    const raw = JSON.parse(await readFile(path, 'utf8'));
    const { ok, errors: fileErrors, cases } = validateBenchmarkFile(raw, file);
    if (!ok) errors.push(...fileErrors);
    for (const c of cases) {
      if (tierFilter && c.tier !== tierFilter) continue;
      if (idFilter && c.id !== idFilter) continue;
      all.push(c);
    }
  }

  if (errors.length) {
    const err = new Error(`Benchmark load errors:\n${errors.join('\n')}`);
    err.errors = errors;
    throw err;
  }

  return all;
}

/**
 * Smoke subset — plan-mode cases for npm test / evaluate:smoke.
 */
export async function loadSmokeBenchmarks() {
  return loadBenchmarks({ tier: 'smoke' });
}

function normalizeFilter(category) {
  if (!category) return null;
  const list = Array.isArray(category) ? category : [category];
  return new Set(list.map(String));
}
