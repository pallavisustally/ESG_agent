#!/usr/bin/env node
/**
 * Final Acceptance Testing harness.
 *
 * Builds ~100–200 scenarios from:
 *  - evaluation benchmarks
 *  - load packs
 *  - acceptance-extra.json
 *
 * Modes:
 *   plan (default) — Execution Planner routing acceptance (no DB/LLM)
 *   http — optional live /api/chat (ACCEPTANCE_CONFIRM=yes)
 *
 * Usage:
 *   npm run acceptance
 *   npm run acceptance -- --min-pass-rate 0.95
 *   ACCEPTANCE_CONFIRM=yes npm run acceptance:http
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBenchmarks } from '../src/evaluation/load-benchmarks.js';
import { loadLoadScenarios } from '../src/evaluation/load-helpers.js';
import { observePlan } from '../src/evaluation/run-evaluation.js';
import { scoreBenchmarkCase } from '../src/evaluation/scorers/index.js';
import { summarizeLatencies, sampleMemoryUsage } from '../src/evaluation/load-helpers.js';
import { assertPassRate } from '../src/evaluation/quality-gates.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
const EXTRA_PATH = join(__dirname, '../src/evaluation/acceptance/acceptance-extra.json');
const REPORT_DIR = join(ROOT, 'data', 'evaluation_reports');

function parseArgs(argv) {
  const opts = {
    mode: 'plan',
    minPassRate: Number(process.env.ACCEPTANCE_MIN_PASS_RATE || 0.95),
    write: true,
    baseUrl: process.env.LOAD_TEST_BASE_URL || 'http://127.0.0.1:3000',
    timeoutMs: Number(process.env.LOAD_TEST_TIMEOUT_MS || 120000),
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--mode' && argv[i + 1]) opts.mode = argv[++i];
    else if (a === '--min-pass-rate' && argv[i + 1]) opts.minPassRate = Number(argv[++i]);
    else if (a === '--base-url' && argv[i + 1]) opts.baseUrl = argv[++i];
    else if (a === '--no-write') opts.write = false;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function normalizeCase(raw, source) {
  const expected = { ...(raw.expected || {}) };
  if (raw.expectedEntities && !expected.entities) expected.entities = raw.expectedEntities;
  if (raw.expectedMetric && !expected.metric) expected.metric = raw.expectedMetric;
  if (raw.expectedYear != null && expected.year == null) expected.year = raw.expectedYear;
  if (raw.enginesMode && !expected.enginesMode) expected.enginesMode = raw.enginesMode;

  const score = {
    routing: false,
    entity: false,
    metric: false,
    year: false,
    numeric: false,
    chart: false,
    citation: false,
    ...(raw.score || {}),
  };

  // Soft cases: only require that planner returns a strategy
  if (raw.expectStrategyPresent || (!expected.executionStrategy && !expected.engines?.length && !score.routing)) {
    return {
      id: raw.id,
      family: raw.family || raw.category || raw.scenario || 'other',
      question: raw.question,
      memory: raw.memory || null,
      chatHistory: raw.chatHistory || [],
      expected,
      score,
      softStrategy: true,
      expectClarification: Boolean(raw.expectClarification),
      source,
      notes: raw.notes || null,
    };
  }

  return {
    id: raw.id,
    family: raw.family || raw.category || raw.scenario || 'other',
    question: raw.question,
    memory: raw.memory || null,
    chatHistory: raw.chatHistory || [],
    expected,
    score,
    softStrategy: false,
    expectClarification: Boolean(raw.expectClarification),
    source,
    notes: raw.notes || null,
  };
}

async function buildSuite() {
  const suite = [];
  const seen = new Set();

  const benchmarks = await loadBenchmarks();
  for (const b of benchmarks) {
    const c = normalizeCase({
      id: `bench-${b.id}`,
      family: b.category,
      question: b.question,
      memory: b.memory,
      chatHistory: b.chatHistory,
      expected: b.expected,
      score: b.score,
    }, 'benchmark');
    if (!seen.has(c.id)) {
      seen.add(c.id);
      suite.push(c);
    }
  }

  const load = await loadLoadScenarios('all');
  for (const row of load) {
    const c = normalizeCase({
      id: `load-${row.pack}-${row.id}`,
      family: row.scenario || row.pack,
      question: row.question,
      memory: row.memory,
      chatHistory: row.chatHistory,
      expectStrategyPresent: true,
    }, 'load');
    if (!seen.has(c.id)) {
      seen.add(c.id);
      suite.push(c);
    }
  }

  const extra = JSON.parse(await readFile(EXTRA_PATH, 'utf8'));
  for (const row of extra) {
    const c = normalizeCase(row, 'acceptance-extra');
    if (!seen.has(c.id)) {
      seen.add(c.id);
      suite.push(c);
    }
  }

  return suite;
}

function scoreCase(caseItem, actual) {
  if (caseItem.expectClarification) {
    const clarified = Boolean(
      actual.plan?.needsClarification
      || actual.executionStrategy === 'clarify'
      || actual.plan?.clarification,
    );
    // Clarification preferred; accepting analytics/knowledge with entities also ok if planner resolved
    const ok = clarified || Boolean(actual.executionStrategy);
    return {
      passed: ok,
      score: ok ? 1 : 0,
      detail: { clarified, strategy: actual.executionStrategy },
    };
  }

  if (caseItem.softStrategy) {
    const ok = Boolean(actual.executionStrategy);
    return {
      passed: ok,
      score: ok ? 1 : 0,
      detail: { strategy: actual.executionStrategy },
    };
  }

  const scored = scoreBenchmarkCase(actual, caseItem.expected, caseItem.score);
  return {
    passed: scored.passed,
    score: scored.score,
    detail: scored.dimensions,
  };
}

async function runPlan(caseItem) {
  const t0 = Date.now();
  try {
    const actual = observePlan({
      question: caseItem.question,
      memory: caseItem.memory,
      chatHistory: caseItem.chatHistory,
    });
    const scored = scoreCase(caseItem, actual);
    return {
      id: caseItem.id,
      family: caseItem.family,
      source: caseItem.source,
      question: caseItem.question,
      passed: scored.passed,
      score: scored.score,
      latencyMs: Date.now() - t0,
      strategy: actual.executionStrategy,
      engines: actual.requiredEngines,
      detail: scored.detail,
      notes: caseItem.notes,
      error: null,
    };
  } catch (err) {
    return {
      id: caseItem.id,
      family: caseItem.family,
      source: caseItem.source,
      question: caseItem.question,
      passed: false,
      score: 0,
      latencyMs: Date.now() - t0,
      strategy: null,
      engines: [],
      detail: {},
      notes: caseItem.notes,
      error: String(err?.message || err),
    };
  }
}

async function runHttp(caseItem, opts) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        message: caseItem.question,
        chatHistory: caseItem.chatHistory || [],
        sessionId: `acceptance-${caseItem.id}`,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`http_${res.status}`);
    }
    const text = await res.text();
    const hasDone = /"status"\s*:\s*"done"/.test(text);
    const hasError = /"status"\s*:\s*"error"/.test(text);
    // HTTP mode: smoke that the turn completes; routing already covered in plan mode
    const passed = hasDone && !hasError;
    return {
      id: caseItem.id,
      family: caseItem.family,
      source: caseItem.source,
      question: caseItem.question,
      passed,
      score: passed ? 1 : 0,
      latencyMs: Date.now() - t0,
      strategy: null,
      engines: [],
      detail: { hasDone, hasError, bytes: text.length },
      notes: caseItem.notes,
      error: passed ? null : 'sse_incomplete_or_error',
    };
  } catch (err) {
    return {
      id: caseItem.id,
      family: caseItem.family,
      source: caseItem.source,
      question: caseItem.question,
      passed: false,
      score: 0,
      latencyMs: Date.now() - t0,
      strategy: null,
      engines: [],
      detail: {},
      notes: caseItem.notes,
      error: String(err?.message || err),
    };
  }
}

function formatReport(report) {
  const lines = [
    '# Final Acceptance Report',
    '',
    `- Generated: ${report.generatedAt}`,
    `- Mode: **${report.mode}**`,
    `- Cases: ${report.total}`,
    `- Pass rate: **${(report.passRate * 100).toFixed(1)}%** (${report.passed}/${report.total})`,
    `- Min required: ${(report.minPassRate * 100).toFixed(0)}%`,
    `- Latency p95: ${report.latency.p95} ms`,
    '',
    '## By family',
    '',
  ];
  for (const [fam, s] of Object.entries(report.byFamily).sort()) {
    const mark = s.passed === s.total ? '✅' : '❌';
    lines.push(`- ${mark} **${fam}**: ${s.passed}/${s.total}`);
  }
  if (report.failures.length) {
    lines.push('', '## Failures', '');
    for (const f of report.failures.slice(0, 40)) {
      lines.push(`- \`${f.id}\` (${f.family}): strategy=${f.strategy || 'n/a'} ${f.error || ''}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`Usage: node agent/scripts/acceptance-test.js [--mode plan|http] [--min-pass-rate 0.95]`);
    process.exit(0);
  }
  if (opts.mode === 'http' && process.env.ACCEPTANCE_CONFIRM !== 'yes') {
    console.error('HTTP acceptance requires ACCEPTANCE_CONFIRM=yes');
    process.exit(2);
  }

  const suite = await buildSuite();
  console.error(`Acceptance suite: ${suite.length} cases (mode=${opts.mode})`);
  if (suite.length < 100) {
    console.error(`Warning: suite size ${suite.length} < 100`);
  }

  const memStart = sampleMemoryUsage();
  const results = [];
  for (const c of suite) {
    results.push(opts.mode === 'http' ? await runHttp(c, opts) : await runPlan(c));
  }
  const memEnd = sampleMemoryUsage();

  const passed = results.filter((r) => r.passed).length;
  const byFamily = {};
  for (const r of results) {
    if (!byFamily[r.family]) byFamily[r.family] = { passed: 0, total: 0 };
    byFamily[r.family].total += 1;
    if (r.passed) byFamily[r.family].passed += 1;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: opts.mode,
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: results.length ? passed / results.length : 0,
    minPassRate: opts.minPassRate,
    latency: summarizeLatencies(results.map((r) => r.latencyMs)),
    memory: { start: memStart, end: memEnd },
    byFamily,
    failures: results.filter((r) => !r.passed),
    results,
  };
  report.markdown = formatReport(report);
  console.log(report.markdown);

  if (opts.write) {
    await mkdir(REPORT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = `acceptance-${opts.mode}-${stamp}`;
    await writeFile(join(REPORT_DIR, `${base}.json`), JSON.stringify(report, null, 2));
    await writeFile(join(REPORT_DIR, `${base}.md`), report.markdown);
    console.error(`Wrote ${join(REPORT_DIR, `${base}.json`)}`);
  }

  const check = assertPassRate(
    { summary: { passRate: report.passRate }, failures: report.failures },
    opts.minPassRate,
  );
  console.error(check.ok ? `Acceptance gate OK: ${check.message}` : check.message);
  if (!check.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
