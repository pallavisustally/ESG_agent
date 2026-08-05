#!/usr/bin/env node
/**
 * Local / CI entrypoint — unit+regression tests then merge-blocking eval gates.
 *
 * Equivalent to GitHub Actions ci.yml jobs (sequential for local use).
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function run(label, command, args) {
  console.log(`\n=== ${label} ===\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    shell: false,
  });
  if (result.status !== 0) {
    console.error(`\nCI step failed: ${label} (exit ${result.status ?? 1})`);
    process.exit(result.status ?? 1);
  }
}

run('unit + regression + in-test smoke', 'npm', ['test']);
run('evaluate:smoke gate', 'npm', ['run', 'evaluate:smoke']);
run('evaluate:ci gate (plan, all cases)', 'npm', ['run', 'evaluate:ci']);
run('category summary', 'npm', ['run', 'ci:summary']);

if (process.env.EVAL_PIPELINE_GATE === 'true') {
  run('evaluate:pipeline gate (optional)', 'npm', ['run', 'evaluate:pipeline']);
}

console.log('\n=== CI quality gates passed ===\n');
console.log('Deploy gate: configure branch protection / Vercel to require');
console.log('GitHub check "Deploy gate (quality gates passed)".\n');