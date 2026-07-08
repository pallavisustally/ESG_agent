/**
 * Compare multiple LLM models on the ESG agent benchmark.
 *
 * Usage:
 *   node agent/scripts/compare_models.js
 *   node agent/scripts/compare_models.js --start 1 --end 8
 *   node agent/scripts/compare_models.js --models deepseek/deepseek-v4-flash,google/gemini-3.5-flash
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { evaluateModel } from './evaluate_with_judge.js';
import { DIFFICULTY_ORDER } from './evaluation_questions.js';

dotenv.config();

const COMPARISON_DIR = path.resolve('data/model_comparisons');
const COMPARISON_JSON = path.join(COMPARISON_DIR, 'comparison_results.json');
const COMPARISON_MD = path.join(COMPARISON_DIR, 'comparison_report.md');

/** Models requested by user (+ Cursor proxy — no public API). */
const DEFAULT_MODELS = [
  { label: 'DeepSeek V4 Pro', slug: 'deepseek/deepseek-v4-pro' },
  { label: 'DeepSeek V4 Flash', slug: 'deepseek/deepseek-v4-flash' },
  { label: 'Gemini 3.5 Flash', slug: 'google/gemini-3.5-flash' },
  { label: 'Claude Sonnet 5', slug: 'anthropic/claude-sonnet-5' },
  { label: 'Grok 4.1 Fast', slug: 'x-ai/grok-4.1-fast' },
  { label: 'Kimi K2.5', slug: 'moonshotai/kimi-k2.5' },
  { label: 'Mistral Large 3', slug: 'mistralai/mistral-large-2512' },
  { label: 'GPT-5.5', slug: 'openai/gpt-5.5' },
  { label: 'GPT-5.4 Mini', slug: 'openai/gpt-5.4-mini' },
  {
    label: 'Cursor Composer (proxy)',
    slug: 'openai/o4-mini',
    note: 'Cursor has no public API; openai/o4-mini used as agentic proxy',
  },
];

const JUDGE_MODEL = process.env.JUDGE_MODEL?.trim() || 'openai/gpt-5.5';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { start: 1, end: 25, models: null, resume: true };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--start' && args[i + 1]) opts.start = parseInt(args[++i], 10);
    else if (args[i] === '--end' && args[i + 1]) opts.end = parseInt(args[++i], 10);
    else if (args[i] === '--models' && args[i + 1]) {
      opts.models = args[++i].split(',').map((s) => ({ label: s.trim(), slug: s.trim() }));
    } else if (args[i] === '--no-resume') opts.resume = false;
  }
  return opts;
}

function avg(nums) {
  const v = nums.filter((n) => typeof n === 'number' && !Number.isNaN(n));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

function slugFile(slug) {
  return slug.replace(/[/:]/g, '_');
}

function cacheMatchesRange(cached, start, end) {
  const r = cached?.questionRange;
  return r && r.start === start && r.end === end && cached.results?.length > 0;
}

function loadAllCachedResults(start, end) {
  if (!fs.existsSync(COMPARISON_DIR)) return [];
  return fs
    .readdirSync(COMPARISON_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'comparison_results.json')
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(COMPARISON_DIR, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter((m) => m?.slug && cacheMatchesRange(m, start, end));
}

function buildComparisonTable(modelResults) {
  const sorted = [...modelResults].sort(
    (a, b) => parseFloat(b.summary.passRate) - parseFloat(a.summary.passRate)
      || parseFloat(b.avgScore) - parseFloat(a.avgScore)
  );

  let md = `# Multi-Model Comparison Report\n\n`;
  md += `Generated: ${new Date().toLocaleString()}\n`;
  md += `Judge model: \`${JUDGE_MODEL}\` (fixed for all subjects)\n`;
  md += `Questions: ${modelResults[0]?.questionRange?.start ?? '?'}–${modelResults[0]?.questionRange?.end ?? '?'}\n\n`;

  md += `## Leaderboard\n\n`;
  md += `| Rank | Model | Pass Rate | Avg Score | Easy | Medium | Hard | Avg Time |\n`;
  md += `|------|-------|-----------|-----------|------|--------|------|----------|\n`;

  sorted.forEach((m, i) => {
    const easy = m.summary.byDifficulty.easy;
    const medium = m.summary.byDifficulty.medium;
    const hard = m.summary.byDifficulty.hard;
    md += `| ${i + 1} | **${m.label}** | ${m.summary.passRate}% (${m.summary.passed}/${m.summary.total}) | ${m.avgScore} | ${easy.passed}/${easy.total} | ${medium.passed}/${medium.total} | ${hard.passed}/${hard.total} | ${m.avgTimeSec}s |\n`;
  });

  md += `\n## Score Dimensions (average / 5)\n\n`;
  md += `| Model | Accuracy | Completeness | Data Usage | Chart | Clarity |\n`;
  md += `|-------|----------|--------------|------------|-------|--------|\n`;
  for (const m of sorted) {
    const d = m.dimensionAvgs;
    md += `| ${m.label} | ${d.accuracy} | ${d.completeness} | ${d.data_usage} | ${d.chart_quality} | ${d.clarity} |\n`;
  }

  md += `\n## Model Slugs\n\n`;
  for (const m of modelResults) {
    md += `- **${m.label}**: \`${m.slug}\`${m.note ? ` — ${m.note}` : ''}\n`;
  }

  md += `\n## Winner\n\n`;
  if (sorted[0]) {
    md += `**${sorted[0].label}** leads with ${sorted[0].summary.passRate}% pass rate and ${sorted[0].avgScore}/5 average judge score.\n`;
  }

  return { md, ranked: sorted };
}

function summarizeDimensions(results) {
  const dims = ['accuracy', 'completeness', 'data_usage', 'chart_quality', 'clarity'];
  const out = {};
  for (const dim of dims) {
    out[dim] = avg(results.map((r) => r.judge?.scores?.[dim])).toFixed(2);
  }
  return out;
}

async function main() {
  const opts = parseArgs();
  const models = opts.models || DEFAULT_MODELS;

  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    console.error('OPENROUTER_API_KEY is required for cloud model comparison.');
    process.exit(1);
  }

  fs.mkdirSync(COMPARISON_DIR, { recursive: true });

  console.log('═'.repeat(72));
  console.log('           MULTI-MODEL ESG AGENT COMPARISON');
  console.log('═'.repeat(72));
  console.log(`Judge:     ${JUDGE_MODEL}`);
  console.log(`Questions: ${opts.start}–${opts.end}`);
  console.log(`Models:    ${models.length}`);
  console.log('═'.repeat(72));

  const modelResults = [];
  let modelIndex = 0;

  for (const { label, slug, note } of models) {
    modelIndex += 1;
    const outPath = path.join(COMPARISON_DIR, `${slugFile(slug)}.json`);

    if (opts.resume && fs.existsSync(outPath)) {
      const cached = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      if (cacheMatchesRange(cached, opts.start, opts.end)) {
        console.log(`\n[${modelIndex}/${models.length}] ${label} — loading cached results`);
        modelResults.push(cached);
        continue;
      }
    }

    console.log(`\n[${modelIndex}/${models.length}] Evaluating: ${label} (${slug})`);

    try {
      const result = await evaluateModel({
        subjectModel: slug,
        judgeModel: JUDGE_MODEL,
        start: opts.start,
        end: opts.end,
        onQuestionDone: ({ phase, question, record }) => {
          if (phase === 'start') {
            process.stdout.write(`  Q${question.id}… `);
          } else if (record) {
            process.stdout.write(`${record.finalPassed ? '✓' : '✗'} `);
          }
        },
      });

      const scores = result.results.map((r) => r.judge?.overall_score).filter((s) => typeof s === 'number');
      const entry = {
        label,
        slug,
        note,
        judgeModel: JUDGE_MODEL,
        questionRange: result.questionRange,
        summary: result.summary,
        avgScore: avg(scores).toFixed(2),
        avgTimeSec: (avg(result.results.map((r) => r.durationMs)) / 1000).toFixed(1),
        dimensionAvgs: summarizeDimensions(result.results),
        results: result.results,
      };

      fs.writeFileSync(outPath, JSON.stringify(entry, null, 2));
      modelResults.push(entry);
      console.log(`\n  → ${entry.summary.passRate}% pass | avg ${entry.avgScore}/5`);
    } catch (err) {
      console.error(`\n  FAILED: ${err.message}`);
      modelResults.push({
        label,
        slug,
        note,
        error: err.message,
        summary: { total: 0, passed: 0, passRate: '0.0', byDifficulty: {} },
        avgScore: '0.00',
        avgTimeSec: '0.0',
        dimensionAvgs: {},
        results: [],
      });
    }
  }

  const { md, ranked } = buildComparisonTable(
    loadAllCachedResults(opts.start, opts.end).length
      ? loadAllCachedResults(opts.start, opts.end)
      : modelResults.filter((m) => !m.error || m.results?.length)
  );

  const output = {
    generatedAt: new Date().toISOString(),
    judgeModel: JUDGE_MODEL,
    questionRange: { start: opts.start, end: opts.end },
    models: modelResults,
    ranked: ranked.map((m) => ({
      label: m.label,
      slug: m.slug,
      passRate: m.summary.passRate,
      avgScore: m.avgScore,
      passed: m.summary.passed,
      total: m.summary.total,
    })),
  };

  fs.writeFileSync(COMPARISON_JSON, JSON.stringify(output, null, 2));
  fs.writeFileSync(COMPARISON_MD, md);

  console.log('\n' + '═'.repeat(72));
  console.log('                      COMPARISON COMPLETE');
  console.log('═'.repeat(72));
  console.log('\nLEADERBOARD:\n');
  ranked.forEach((m, i) => {
    console.log(
      `  ${i + 1}. ${m.label.padEnd(28)} ${m.summary.passRate}% pass  score ${m.avgScore}/5  (${m.avgTimeSec}s avg)`
    );
  });
  console.log(`\nReport: ${COMPARISON_MD}`);
  console.log(`JSON:   ${COMPARISON_JSON}`);
  console.log('═'.repeat(72));
}

main().catch((err) => {
  console.error('Comparison failed:', err);
  process.exit(1);
});
