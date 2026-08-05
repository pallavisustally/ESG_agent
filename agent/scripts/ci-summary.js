#!/usr/bin/env node
/**
 * Print evaluation category pass rates for CI summaries.
 * Exits 1 if pass rate is below the gate for the chosen profile.
 *
 * Usage:
 *   node agent/scripts/ci-summary.js --gate smoke
 *   node agent/scripts/ci-summary.js --gate plan-ci --write
 */

import { runEvaluation } from '../src/evaluation/run-evaluation.js';
import { writeEvaluationReport } from '../src/evaluation/evaluation-report.js';
import {
  resolveMinPassRate,
  assertPassRate,
} from '../src/evaluation/quality-gates.js';

function parseArgs(argv) {
  const opts = { gate: 'plan-ci', write: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--gate' && argv[i + 1]) opts.gate = argv[++i];
    else if (argv[i] === '--write') opts.write = true;
  }
  return opts;
}

function applyGate(gate) {
  if (gate === 'smoke') {
    return { mode: 'plan', tier: 'smoke', min: resolveMinPassRate('smoke') };
  }
  return { mode: 'plan', tier: null, min: resolveMinPassRate('plan-ci') };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cfg = applyGate(opts.gate);
  const report = await runEvaluation({
    mode: cfg.mode,
    tier: cfg.tier,
    softSkipPipeline: true,
  });

  if (opts.write) {
    const paths = await writeEvaluationReport(report);
    console.log(`Wrote ${paths.jsonPath}`);
  }

  console.log(`\n## Evaluation summary (${opts.gate})\n`);
  console.log(`- Pass rate: **${(report.summary.passRate * 100).toFixed(1)}%** (${report.summary.passed}/${report.summary.total})`);
  console.log('\n### By category\n');
  const byCat = report.summary.byCategory || {};
  for (const [cat, stats] of Object.entries(byCat).sort(([a], [b]) => a.localeCompare(b))) {
    const rate = stats.total ? ((stats.passed / stats.total) * 100).toFixed(0) : 'n/a';
    const mark = stats.passed === stats.total ? '✅' : '❌';
    console.log(`- ${mark} **${cat}**: ${stats.passed}/${stats.total} (${rate}%)`);
  }

  // Highlight production-critical categories
  const critical = [
    'recommendation',
    'charts',
    'conversation-memory',
    'analytics',
    'rankings',
    'knowledge',
  ];
  console.log('\n### Critical categories\n');
  for (const cat of critical) {
    const stats = byCat[cat];
    if (!stats) {
      console.log(`- ⚠️ **${cat}**: no cases`);
      continue;
    }
    const ok = stats.passed === stats.total;
    console.log(`- ${ok ? '✅' : '❌'} **${cat}**: ${stats.passed}/${stats.total}`);
  }

  const check = assertPassRate(report, cfg.min);
  console.log(`\n${check.ok ? '✅' : '❌'} Gate: ${check.message}\n`);
  if (!check.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
