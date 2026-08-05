#!/usr/bin/env node
/**
 * ESG Copilot evaluation CLI.
 *
 * Usage:
 *   node agent/scripts/evaluate.js --tier smoke --mode plan
 *   node agent/scripts/evaluate.js --tier full --mode pipeline --write
 *   node agent/scripts/evaluate.js --gate smoke|plan-ci|pipeline
 *   node agent/scripts/evaluate.js --category rankings --id rankings-top5-scope1-2024
 */

import { runEvaluation } from '../src/evaluation/run-evaluation.js';
import { writeEvaluationReport } from '../src/evaluation/evaluation-report.js';
import {
  QUALITY_GATES,
  resolveMinPassRate,
  assertPassRate,
} from '../src/evaluation/quality-gates.js';

function parseArgs(argv) {
  const opts = {
    mode: 'plan',
    tier: null,
    category: null,
    id: null,
    write: false,
    json: false,
    minPassRate: null,
    gate: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--mode' && argv[i + 1]) opts.mode = argv[++i];
    else if (a === '--tier' && argv[i + 1]) opts.tier = argv[++i];
    else if (a === '--category' && argv[i + 1]) opts.category = argv[++i];
    else if (a === '--id' && argv[i + 1]) opts.id = argv[++i];
    else if (a === '--write') opts.write = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--min-pass-rate' && argv[i + 1]) opts.minPassRate = Number(argv[++i]);
    else if (a === '--gate' && argv[i + 1]) opts.gate = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function applyGateDefaults(opts) {
  const next = { ...opts };
  if (next.gate === 'smoke') {
    next.mode = 'plan';
    next.tier = next.tier || 'smoke';
    next.minPassRate = resolveMinPassRate('smoke', next.minPassRate);
  } else if (next.gate === 'plan-ci') {
    next.mode = 'plan';
    // all tiers (smoke + full)
    next.tier = next.tier ?? null;
    next.minPassRate = resolveMinPassRate('plan-ci', next.minPassRate);
  } else if (next.gate === 'pipeline') {
    next.mode = 'pipeline';
    next.tier = next.tier || 'full';
    next.minPassRate = resolveMinPassRate('pipeline', next.minPassRate);
  }
  return next;
}

async function main() {
  let opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`Usage: node agent/scripts/evaluate.js [options]

Options:
  --mode plan|pipeline     Evaluation mode (default: plan)
  --tier smoke|full        Filter by tier
  --category <name>        Filter by category
  --id <case-id>           Single case
  --gate smoke|plan-ci|pipeline
                           Apply CI quality-gate defaults (mode/tier/min pass rate)
  --write                  Write JSON + Markdown under data/evaluation_reports/
  --json                   Print full JSON report to stdout
  --min-pass-rate <0-1>    Exit 1 if pass rate below threshold

Env (see quality-gates.js):
  EVAL_SMOKE_MIN_PASS_RATE       default 1.0
  EVAL_PLAN_CI_MIN_PASS_RATE     default 0.95
  EVAL_PIPELINE_GATE             set true to enforce pipeline gate
  EVAL_PIPELINE_MIN_PASS_RATE    default 0.90
  EVAL_FAIL_ON_ERROR             exit 1 on any failed case when no min set
`);
    process.exit(0);
  }

  opts = applyGateDefaults(opts);

  if (opts.gate === 'pipeline' && !QUALITY_GATES.pipelineGateEnabled) {
    console.error(
      'Pipeline gate skipped (set EVAL_PIPELINE_GATE=true to enforce). Running report only…',
    );
  }

  const report = await runEvaluation({
    mode: opts.mode,
    tier: opts.tier,
    category: opts.category,
    id: opts.id,
    softSkipPipeline: true,
  });

  if (opts.write) {
    const paths = await writeEvaluationReport(report);
    console.error(`Wrote ${paths.jsonPath}`);
    console.error(`Wrote ${paths.mdPath}`);
  }

  if (opts.json) {
    const { markdown, ...body } = report;
    console.log(JSON.stringify(body, null, 2));
  } else {
    console.log(report.markdown);
  }

  const min = opts.minPassRate;
  if (min != null && Number.isFinite(min)) {
    if (opts.gate === 'pipeline' && !QUALITY_GATES.pipelineGateEnabled) {
      process.exit(0);
    }
    const check = assertPassRate(report, min);
    if (!check.ok) {
      console.error(check.message);
      process.exit(1);
    }
    console.error(`Quality gate OK: ${check.message}`);
  } else if (report.summary.failed > 0 && process.env.EVAL_FAIL_ON_ERROR === 'true') {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
