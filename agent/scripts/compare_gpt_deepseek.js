/**
 * Head-to-head: GPT vs DeepSeek on 15 complex BRSR/ESG questions.
 *
 * Usage:
 *   node agent/scripts/compare_gpt_deepseek.js
 *   node agent/scripts/compare_gpt_deepseek.js --fast --no-resume
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { evaluateModel } from './evaluate_with_judge.js';
import { COMPLEX_EVALUATION_QUESTIONS, COMPLEX_SUITE_NAME } from './complex_evaluation_questions.js';

dotenv.config();

const OUT_DIR = path.resolve('data/model_comparisons/gpt_vs_deepseek');
const RESULTS_JSON = path.join(OUT_DIR, 'final_verdict.json');
const REPORT_MD = path.join(OUT_DIR, 'final_verdict.md');

const JUDGE_MODEL = process.env.JUDGE_MODEL?.trim() || 'openai/gpt-5.5';

/** Top 3 contenders — fast subset. */
const CONTESTANTS = [
  { label: 'GPT-5.5', slug: 'openai/gpt-5.5', family: 'gpt' },
  { label: 'DeepSeek V4 Flash', slug: 'deepseek/deepseek-v4-flash', family: 'deepseek' },
  { label: 'DeepSeek V4 Pro', slug: 'deepseek/deepseek-v4-pro', family: 'deepseek' },
];

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    resume: !args.includes('--no-resume'),
    fast: args.includes('--fast'),
    programmatic: args.includes('--fast') || args.includes('--programmatic'),
    local: args.includes('--local'),
  };
}

function applyFastMode() {
  process.env.AGENT_MAX_ITERATIONS = '2';
  process.env.AGENT_MAX_HISTORY = '2';
  process.env.OLLAMA_NUM_PREDICT = '512';
  process.env.OLLAMA_TIMEOUT_MS = '90000';
}

function slugFile(slug) {
  return slug.replace(/[/:]/g, '_');
}

function avg(nums) {
  const v = nums.filter((n) => typeof n === 'number' && !Number.isNaN(n));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

function summarizeDimensions(results) {
  const dims = ['accuracy', 'completeness', 'data_usage', 'chart_quality', 'clarity'];
  const out = {};
  for (const dim of dims) {
    out[dim] = avg(results.map((r) => r.judge?.scores?.[dim])).toFixed(2);
  }
  return out;
}

function pickWinner(ranked) {
  if (!ranked.length) return null;
  const top = ranked[0];
  const second = ranked[1];
  const margin = second
    ? parseFloat(top.passRate) - parseFloat(second.passRate)
    : parseFloat(top.passRate);
  return {
    model: top.label,
    slug: top.slug,
    family: top.family,
    passRate: top.passRate,
    avgScore: top.avgScore,
    margin: margin.toFixed(1),
    reason: buildReason(top, second),
  };
}

function buildReason(first, second) {
  const parts = [];
  parts.push(`${first.passRate}% pass rate on 15 complex BRSR queries`);
  parts.push(`average judge score ${first.avgScore}/5`);
  if (second) {
    parts.push(
      `beats ${second.label} by ${(parseFloat(first.passRate) - parseFloat(second.passRate)).toFixed(1)}% pass rate`
    );
  }
  if (parseFloat(first.dimensions?.data_usage) >= 4) {
    parts.push('strong grounding in database results');
  }
  if (parseFloat(first.avgTimeSec) < 20) {
    parts.push('good response speed');
  }
  return parts.join('; ') + '.';
}

function buildFamilySummary(ranked) {
  const families = {};
  for (const m of ranked) {
    if (!families[m.family]) families[m.family] = [];
    families[m.family].push(m);
  }
  const out = {};
  for (const [family, models] of Object.entries(families)) {
    out[family] = {
      avgPassRate: (
        models.reduce((a, m) => a + parseFloat(m.passRate), 0) / models.length
      ).toFixed(1),
      avgScore: (models.reduce((a, m) => a + parseFloat(m.avgScore), 0) / models.length).toFixed(2),
      best: models[0]?.label,
    };
  }
  return out;
}

function buildVerdictReport(ranked, winner, familySummary, questions) {
  let md = `# GPT vs DeepSeek — Complex BRSR Benchmark Verdict\n\n`;
  md += `Generated: ${new Date().toLocaleString()}\n`;
  md += `Suite: **15 complicated project-specific questions**\n`;
  md += `Judge: \`${JUDGE_MODEL}\`\n\n`;

  md += `## Final Winner\n\n`;
  md += `### ${winner.model}\n`;
  md += `- **Slug:** \`${winner.slug}\`\n`;
  md += `- **Pass rate:** ${winner.passRate}%\n`;
  md += `- **Avg score:** ${winner.avgScore}/5\n`;
  md += `- **Why:** ${winner.reason}\n\n`;

  md += `## Recommended .env setting\n\n`;
  md += `\`\`\`env\nOPENROUTER_MODEL=${winner.slug}\n\`\`\`\n\n`;

  md += `## Full Leaderboard\n\n`;
  md += `| Rank | Model | Family | Pass Rate | Avg Score | Avg Time | Accuracy | Data Usage |\n`;
  md += `|------|-------|--------|-----------|-----------|----------|----------|------------|\n`;
  ranked.forEach((m, i) => {
    md += `| ${i + 1} | **${m.label}** | ${m.family} | ${m.passRate}% (${m.passed}/${m.total}) | ${m.avgScore} | ${m.avgTimeSec}s | ${m.dimensions.accuracy} | ${m.dimensions.data_usage} |\n`;
  });

  md += `\n## Family Summary\n\n`;
  md += `| Family | Avg Pass Rate | Avg Score | Best Model |\n`;
  md += `|--------|---------------|-----------|------------|\n`;
  for (const [family, s] of Object.entries(familySummary)) {
    md += `| ${family.toUpperCase()} | ${s.avgPassRate}% | ${s.avgScore}/5 | ${s.best} |\n`;
  }

  const gpt = familySummary.gpt;
  const ds = familySummary.deepseek;
  if (gpt && ds) {
    const gptWins = parseFloat(gpt.avgPassRate) > parseFloat(ds.avgPassRate);
    md += `\n## GPT vs DeepSeek Conclusion\n\n`;
    md += gptWins
      ? `**GPT family wins overall** (${gpt.avgPassRate}% vs ${ds.avgPassRate}% average pass rate). Best GPT model: ${gpt.best}.\n`
      : `**DeepSeek family wins overall** (${ds.avgPassRate}% vs ${gpt.avgPassRate}% average pass rate). Best DeepSeek model: ${ds.best}.\n`;
  }

  md += `\n## Question Suite (${questions.length} complex queries)\n\n`;
  questions.forEach((q) => {
    md += `${q.id}. **${q.name}** — ${q.category}\n`;
  });

  return md;
}

async function main() {
  const opts = parseArgs();
  if (opts.fast) applyFastMode();

  let contestants = CONTESTANTS;
  if (opts.local) {
    delete process.env.OPENROUTER_API_KEY;
    contestants = [
      { label: 'Qwen 2.5 (local)', slug: 'qwen2.5:7b-instruct', family: 'local' },
      { label: 'Llama 3.1 (local)', slug: 'llama3.1:8b', family: 'local' },
    ];
  } else if (!process.env.OPENROUTER_API_KEY?.trim()) {
    console.error('OPENROUTER_API_KEY required (or pass --local for Ollama).');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('═'.repeat(72));
  console.log('   GPT vs DEEPSEEK — 15 COMPLEX BRSR QUESTION BENCHMARK');
  console.log('═'.repeat(72));
  console.log(`Judge:     ${opts.programmatic ? 'programmatic (fast)' : JUDGE_MODEL}`);
  console.log(`Questions: ${COMPLEX_EVALUATION_QUESTIONS.length} (complex suite)`);
  console.log(`Models:    ${contestants.map((m) => m.label).join(', ')}`);
  console.log('═'.repeat(72));

  const modelResults = [];

  for (let i = 0; i < contestants.length; i++) {
    const { label, slug, family } = contestants[i];
    const cachePath = path.join(OUT_DIR, `${slugFile(slug)}.json`);

    if (opts.resume && fs.existsSync(cachePath)) {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (cached.results?.length === COMPLEX_EVALUATION_QUESTIONS.length) {
        console.log(`\n[${i + 1}/${contestants.length}] ${label} — cached`);
        modelResults.push(cached);
        continue;
      }
    }

    console.log(`\n[${i + 1}/${contestants.length}] Evaluating: ${label}`);

    try {
      const result = await evaluateModel({
        subjectModel: slug,
        judgeModel: JUDGE_MODEL,
        questions: COMPLEX_EVALUATION_QUESTIONS,
        suiteName: COMPLEX_SUITE_NAME,
        opts: { programmatic: opts.programmatic },
        onQuestionDone: ({ phase, question, record }) => {
          if (phase === 'start') process.stdout.write(`  Q${question.id}… `);
          else if (record) process.stdout.write(record.finalPassed ? '✓ ' : '✗ ');
        },
      });

      const scores = opts.programmatic
        ? result.results.map((r) => (r.finalPassed ? 4 : 1))
        : result.results.map((r) => r.judge?.overall_score).filter((s) => typeof s === 'number');
      const entry = {
        label,
        slug,
        family,
        judgeModel: JUDGE_MODEL,
        suite: COMPLEX_SUITE_NAME,
        summary: result.summary,
        passed: result.summary.passed,
        total: result.summary.total,
        passRate: result.summary.passRate,
        avgScore: avg(scores).toFixed(2),
        avgTimeSec: (avg(result.results.map((r) => r.durationMs)) / 1000).toFixed(1),
        dimensions: summarizeDimensions(result.results),
        results: result.results,
      };

      fs.writeFileSync(cachePath, JSON.stringify(entry, null, 2));
      modelResults.push(entry);
      console.log(`\n  → ${entry.passRate}% pass | ${entry.avgScore}/5 | ${entry.avgTimeSec}s avg`);
    } catch (err) {
      console.error(`\n  FAILED: ${err.message}`);
      modelResults.push({
        label,
        slug,
        family,
        error: err.message,
        passRate: '0.0',
        avgScore: '0.00',
        avgTimeSec: '0.0',
        passed: 0,
        total: COMPLEX_EVALUATION_QUESTIONS.length,
        dimensions: {},
        results: [],
      });
    }
  }

  const ranked = [...modelResults].filter((m) => m.results?.length);

  if (!ranked.length) {
    console.error('\nNo models completed. Check OpenRouter credits and re-run.');
    process.exit(1);
  }

  ranked.sort(
    (a, b) =>
      parseFloat(b.passRate) - parseFloat(a.passRate) ||
      parseFloat(b.avgScore) - parseFloat(a.avgScore)
  );

  const winner = pickWinner(ranked);
  const familySummary = buildFamilySummary(ranked);
  const reportMd = buildVerdictReport(ranked, winner, familySummary, COMPLEX_EVALUATION_QUESTIONS);

  const output = {
    generatedAt: new Date().toISOString(),
    suite: COMPLEX_SUITE_NAME,
    questionCount: COMPLEX_EVALUATION_QUESTIONS.length,
    judgeModel: JUDGE_MODEL,
    winner,
    familySummary,
    ranked: ranked.map((m) => ({
      label: m.label,
      slug: m.slug,
      family: m.family,
      passRate: m.passRate,
      avgScore: m.avgScore,
      passed: m.passed,
      total: m.total,
    })),
    models: modelResults,
  };

  fs.writeFileSync(RESULTS_JSON, JSON.stringify(output, null, 2));
  fs.writeFileSync(REPORT_MD, reportMd);

  console.log('\n' + '═'.repeat(72));
  console.log('                         FINAL VERDICT');
  console.log('═'.repeat(72));
  console.log(`\n  WINNER: ${winner.model}`);
  console.log(`  Pass:   ${winner.passRate}%  |  Score: ${winner.avgScore}/5`);
  console.log(`  Set:    OPENROUTER_MODEL=${winner.slug}\n`);
  ranked.forEach((m, i) => {
    console.log(
      `  ${i + 1}. ${m.label.padEnd(22)} ${m.passRate}% pass  ${m.avgScore}/5  (${m.family})`
    );
  });
  console.log(`\nReport: ${REPORT_MD}`);
  console.log('═'.repeat(72));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
