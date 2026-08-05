#!/usr/bin/env node
/**
 * ESG Copilot load / stress harness (Production Readiness Part 4).
 *
 * Modes:
 *   plan  — concurrent Execution Planner observations (no HTTP, safe default)
 *   http  — concurrent POST /api/chat against LOAD_TEST_BASE_URL
 *           requires LOAD_TEST_CONFIRM=yes
 *
 * Usage:
 *   npm run load-test
 *   npm run load-test -- --mode plan --concurrency 10 --requests 40
 *   npm run load-test -- --mode http --base-url http://localhost:3000 --concurrency 5
 *   npm run load-test -- --pack long-conversation --concurrency 4 --requests 24
 *
 * Not part of PR CI.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadLoadScenarios,
  summarizeLatencies,
  sampleMemoryUsage,
} from '../src/evaluation/load-helpers.js';
import { observePlan } from '../src/evaluation/run-evaluation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
const REPORT_DIR = join(ROOT, 'data', 'evaluation_reports');

function parseArgs(argv) {
  const opts = {
    mode: 'plan',
    pack: 'mixed-workload',
    concurrency: 8,
    requests: 32,
    baseUrl: process.env.LOAD_TEST_BASE_URL || 'http://127.0.0.1:3000',
    timeoutMs: Number(process.env.LOAD_TEST_TIMEOUT_MS || 120000),
    write: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--mode' && argv[i + 1]) opts.mode = argv[++i];
    else if (a === '--pack' && argv[i + 1]) opts.pack = argv[++i];
    else if (a === '--concurrency' && argv[i + 1]) opts.concurrency = Number(argv[++i]);
    else if (a === '--requests' && argv[i + 1]) opts.requests = Number(argv[++i]);
    else if (a === '--base-url' && argv[i + 1]) opts.baseUrl = argv[++i];
    else if (a === '--timeout-ms' && argv[i + 1]) opts.timeoutMs = Number(argv[++i]);
    else if (a === '--no-write') opts.write = false;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function expandCases(scenarios, requests) {
  const out = [];
  for (let i = 0; i < requests; i += 1) {
    const base = scenarios[i % scenarios.length];
    out.push({
      ...base,
      runId: `${base.id || 'case'}-${i + 1}`,
      index: i,
    });
  }
  return out;
}

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function next() {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      results[i] = await worker(items[i], i);
    }
  }
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => next());
  await Promise.all(runners);
  return results;
}

async function runPlanCase(caseItem) {
  const started = Date.now();
  const memBefore = sampleMemoryUsage();
  try {
    const actual = observePlan({
      question: caseItem.question,
      memory: caseItem.memory || null,
      chatHistory: caseItem.chatHistory || [],
    });
    const latencyMs = Date.now() - started;
    return {
      ok: true,
      runId: caseItem.runId,
      scenario: caseItem.scenario,
      pack: caseItem.pack,
      question: caseItem.question,
      latencyMs,
      strategy: actual.executionStrategy,
      engines: actual.requiredEngines,
      timeout: false,
      error: null,
      memBefore,
      memAfter: sampleMemoryUsage(),
    };
  } catch (err) {
    return {
      ok: false,
      runId: caseItem.runId,
      scenario: caseItem.scenario,
      pack: caseItem.pack,
      question: caseItem.question,
      latencyMs: Date.now() - started,
      strategy: null,
      engines: [],
      timeout: /timeout/i.test(String(err?.message || err)),
      error: String(err?.message || err),
      memBefore,
      memAfter: sampleMemoryUsage(),
    };
  }
}

async function readSseDone(res, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const reader = res.body?.getReader?.();
    if (!reader) {
      const text = await res.text();
      return { text, events: [], raw: text };
    }
    const decoder = new TextDecoder();
    let buf = '';
    let finalText = '';
    const events = [];
    while (true) {
      if (ac.signal.aborted) throw new Error(`http_timeout_${timeoutMs}ms`);
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const chunks = buf.split('\n\n');
      buf = chunks.pop() || '';
      for (const chunk of chunks) {
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        try {
          const payload = JSON.parse(line.slice(6));
          events.push(payload);
          if (payload.status === 'done') {
            finalText = payload.text || '';
            return { text: finalText, events, raw: null };
          }
          if (payload.status === 'error') {
            throw new Error(payload.error || 'sse_error');
          }
        } catch (err) {
          if (String(err?.message || '').includes('sse_error') || String(err?.message || '').includes('http_timeout')) {
            throw err;
          }
        }
      }
    }
    return { text: finalText, events, raw: buf };
  } finally {
    clearTimeout(timer);
  }
}

async function runHttpCase(caseItem, { baseUrl, timeoutMs }) {
  const started = Date.now();
  const memBefore = sampleMemoryUsage();
  const url = `${baseUrl.replace(/\/$/, '')}/api/chat`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        message: caseItem.question,
        chatHistory: caseItem.chatHistory || [],
        sessionId: `load-${caseItem.runId}`,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 429) {
      return {
        ok: false,
        runId: caseItem.runId,
        scenario: caseItem.scenario,
        pack: caseItem.pack,
        question: caseItem.question,
        latencyMs: Date.now() - started,
        strategy: null,
        engines: [],
        timeout: false,
        error: 'rate_limited_429',
        status: 429,
        memBefore,
        memAfter: sampleMemoryUsage(),
      };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`http_${res.status}:${body.slice(0, 200)}`);
    }
    const sse = await readSseDone(res, timeoutMs);
    return {
      ok: Boolean(sse.text || sse.events.some((e) => e.status === 'done')),
      runId: caseItem.runId,
      scenario: caseItem.scenario,
      pack: caseItem.pack,
      question: caseItem.question,
      latencyMs: Date.now() - started,
      strategy: sse.events.find((e) => e.pipeline)?.pipeline?.executionStrategy || null,
      engines: [],
      timeout: false,
      error: null,
      status: res.status,
      textLength: String(sse.text || '').length,
      memBefore,
      memAfter: sampleMemoryUsage(),
    };
  } catch (err) {
    const msg = String(err?.message || err);
    return {
      ok: false,
      runId: caseItem.runId,
      scenario: caseItem.scenario,
      pack: caseItem.pack,
      question: caseItem.question,
      latencyMs: Date.now() - started,
      strategy: null,
      engines: [],
      timeout: /timeout|aborted/i.test(msg),
      error: msg,
      memBefore,
      memAfter: sampleMemoryUsage(),
    };
  }
}

function buildReport(opts, results, wallMs, memStart, memEnd) {
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const timeouts = results.filter((r) => r.timeout);
  const latencies = results.map((r) => r.latencyMs);
  const byScenario = {};
  for (const r of results) {
    const key = r.scenario || 'unknown';
    if (!byScenario[key]) byScenario[key] = { total: 0, ok: 0, latencyMs: [] };
    byScenario[key].total += 1;
    if (r.ok) byScenario[key].ok += 1;
    byScenario[key].latencyMs.push(r.latencyMs);
  }
  for (const key of Object.keys(byScenario)) {
    byScenario[key].latency = summarizeLatencies(byScenario[key].latencyMs);
    delete byScenario[key].latencyMs;
  }

  const throughputRps = wallMs > 0 ? Math.round((results.length / (wallMs / 1000)) * 100) / 100 : 0;

  return {
    generatedAt: new Date().toISOString(),
    mode: opts.mode,
    pack: opts.pack,
    concurrency: opts.concurrency,
    requests: opts.requests,
    baseUrl: opts.mode === 'http' ? opts.baseUrl : null,
    wallMs,
    throughputRps,
    successCount: ok.length,
    failureCount: failed.length,
    timeoutCount: timeouts.length,
    successRate: results.length ? ok.length / results.length : 0,
    latency: summarizeLatencies(latencies),
    byScenario,
    memory: {
      start: memStart,
      end: memEnd,
      deltaHeapUsedMb: Math.round((memEnd.heapUsedMb - memStart.heapUsedMb) * 10) / 10,
    },
    errors: failed.slice(0, 30).map((r) => ({
      runId: r.runId,
      error: r.error,
      latencyMs: r.latencyMs,
      timeout: r.timeout,
    })),
    results,
  };
}

function formatMarkdown(report) {
  const lines = [
    '# Load Test Report',
    '',
    `- Generated: ${report.generatedAt}`,
    `- Mode: **${report.mode}**`,
    `- Pack: ${report.pack}`,
    `- Concurrency: ${report.concurrency}`,
    `- Requests: ${report.requests}`,
    `- Wall time: ${report.wallMs} ms`,
    `- Throughput: **${report.throughputRps} req/s**`,
    `- Success rate: **${(report.successRate * 100).toFixed(1)}%** (${report.successCount}/${report.requests})`,
    `- Timeouts: ${report.timeoutCount}`,
    '',
    '## Latency (ms)',
    '',
    `- p50: ${report.latency.p50}`,
    `- p95: ${report.latency.p95}`,
    `- p99: ${report.latency.p99}`,
    `- mean: ${report.latency.mean}`,
    `- min/max: ${report.latency.min} / ${report.latency.max}`,
    '',
    '## Memory',
    '',
    `- Start heap: ${report.memory.start.heapUsedMb} MB (rss ${report.memory.start.rssMb} MB)`,
    `- End heap: ${report.memory.end.heapUsedMb} MB (rss ${report.memory.end.rssMb} MB)`,
    `- Δ heap: ${report.memory.deltaHeapUsedMb} MB`,
    '',
    '## By scenario',
    '',
  ];
  for (const [name, s] of Object.entries(report.byScenario).sort()) {
    lines.push(`- **${name}**: ${s.ok}/${s.total} ok · p95 ${s.latency.p95} ms`);
  }
  if (report.errors.length) {
    lines.push('', '## Sample errors', '');
    for (const e of report.errors.slice(0, 10)) {
      lines.push(`- \`${e.runId}\`: ${e.error}${e.timeout ? ' (timeout)' : ''}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`Usage: node agent/scripts/load-test.js [options]

Options:
  --mode plan|http       Default: plan (no server)
  --pack <name>|all      Scenario pack (default: mixed-workload)
  --concurrency <n>      Parallel workers (default: 8)
  --requests <n>         Total requests (default: 32)
  --base-url <url>       For http mode (default: LOAD_TEST_BASE_URL or localhost:3000)
  --timeout-ms <n>       Per-request timeout (default: 120000)
  --no-write             Skip writing report files

HTTP mode requires LOAD_TEST_CONFIRM=yes to avoid accidental prod hits.
`);
    process.exit(0);
  }

  if (opts.mode === 'http' && process.env.LOAD_TEST_CONFIRM !== 'yes') {
    console.error('HTTP load tests require LOAD_TEST_CONFIRM=yes');
    console.error(`Target would be: ${opts.baseUrl}`);
    process.exit(2);
  }

  const scenarios = await loadLoadScenarios(opts.pack);
  if (!scenarios.length) {
    console.error(`No scenarios in pack ${opts.pack}`);
    process.exit(1);
  }

  const cases = expandCases(scenarios, opts.requests);
  const memStart = sampleMemoryUsage();
  const wallStart = Date.now();

  console.error(`Load test: mode=${opts.mode} pack=${opts.pack} concurrency=${opts.concurrency} requests=${opts.requests}`);

  const results = await mapPool(
    cases,
    Math.max(1, opts.concurrency),
    (caseItem) => (opts.mode === 'http'
      ? runHttpCase(caseItem, opts)
      : runPlanCase(caseItem)),
  );

  const wallMs = Date.now() - wallStart;
  const memEnd = sampleMemoryUsage();
  const report = buildReport(opts, results, wallMs, memStart, memEnd);
  const markdown = formatMarkdown(report);
  report.markdown = markdown;

  console.log(markdown);

  if (opts.write) {
    await mkdir(REPORT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = `load-${opts.mode}-${opts.pack}-${stamp}`;
    const jsonPath = join(REPORT_DIR, `${base}.json`);
    const mdPath = join(REPORT_DIR, `${base}.md`);
    const { markdown: _md, results: compactResults, ...summary } = report;
    await writeFile(jsonPath, JSON.stringify({ ...summary, results: compactResults }, null, 2));
    await writeFile(mdPath, markdown);
    console.error(`Wrote ${jsonPath}`);
    console.error(`Wrote ${mdPath}`);
  }

  if (report.successRate < 0.95 && opts.mode === 'plan') {
    console.error('Plan-mode load test success rate below 95%');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
