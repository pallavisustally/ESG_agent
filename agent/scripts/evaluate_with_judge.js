/**
 * 25-question ESG agent evaluation with LLM-as-judge.
 *
 * Phase 1: Subject model answers each question via the agent.
 * Phase 2: Judge model scores each response against the rubric.
 * Phase 3: Aggregate results → JSON + Markdown report.
 *
 * Usage:
 *   node agent/scripts/evaluate_with_judge.js
 *   node agent/scripts/evaluate_with_judge.js --start 9 --end 17
 *   node agent/scripts/evaluate_with_judge.js --judge-only   # re-score existing responses
 *
 * Env:
 *   OLLAMA_MODEL / OPENROUTER_MODEL  — subject (agent) model
 *   JUDGE_MODEL                      — evaluator model (defaults to subject model)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { runAgent } from '../src/agent.js';
import { callOllamaChat, getOllamaConfig } from '../src/ollama-client.js';
import { EVALUATION_QUESTIONS, DIFFICULTY_ORDER } from './evaluation_questions.js';

dotenv.config();

const RESULTS_JSON = path.resolve('data/model_evaluation_results.json');
const REPORT_MD = path.resolve('data/model_evaluation_report.md');
const RESPONSES_JSON = path.resolve('data/model_evaluation_responses.json');

const JUDGE_SYSTEM_PROMPT = `You are an expert evaluator for an ESG/BRSR data analyst AI agent.
You judge whether the agent's answer correctly addresses the user's question using database-backed data.

Score each dimension from 1 (poor) to 5 (excellent):
- accuracy: factual correctness and correct use of ESG metrics
- completeness: all requested fields, filters, and rankings included
- data_usage: evidence the answer used real queried data (not hallucinated)
- chart_quality: chart present and appropriate when required; use 5 if no chart needed
- clarity: clear, well-structured explanation

A response PASSES if overall_score >= 3.5 AND no critical factual errors.

Respond with ONLY valid JSON (no markdown fences):
{
  "scores": {
    "accuracy": <1-5>,
    "completeness": <1-5>,
    "data_usage": <1-5>,
    "chart_quality": <1-5>,
    "clarity": <1-5>
  },
  "overall_score": <1-5>,
  "passed": <true|false>,
  "strengths": ["..."],
  "weaknesses": ["..."],
  "reasoning": "2-4 sentence justification"
}`;

// ── CLI args ────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { start: 1, end: 25, judgeOnly: false, skipJudge: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--start' && args[i + 1]) opts.start = parseInt(args[++i], 10);
    else if (args[i] === '--end' && args[i + 1]) opts.end = parseInt(args[++i], 10);
    else if (args[i] === '--judge-only') opts.judgeOnly = true;
    else if (args[i] === '--skip-judge') opts.skipJudge = true;
  }
  return opts;
}

// ── Chart validation (reused from evaluate_agent.js) ──────────────────────────

function extractChartJson(text) {
  const match = text?.match(/```json-chart\s*([\s\S]*?)\s*```/);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim());
  } catch (e) {
    return { error: `Invalid JSON: ${e.message}` };
  }
}

function validateChart(chartJson, requiresChart) {
  if (!requiresChart) {
    return { valid: true, message: 'Chart not required.' };
  }
  if (!chartJson) {
    return { valid: false, message: 'No ```json-chart block found.' };
  }
  if (chartJson.error) {
    return { valid: false, message: chartJson.error };
  }
  const required = ['type', 'chartType', 'title', 'labels', 'datasets'];
  for (const key of required) {
    if (!(key in chartJson)) {
      return { valid: false, message: `Missing key: "${key}"` };
    }
  }
  if (chartJson.type !== 'chart') {
    return { valid: false, message: `Expected type "chart", got "${chartJson.type}"` };
  }
  if (!Array.isArray(chartJson.labels) || chartJson.labels.length === 0) {
    return { valid: false, message: 'labels must be a non-empty array' };
  }
  if (!Array.isArray(chartJson.datasets) || chartJson.datasets.length === 0) {
    return { valid: false, message: 'datasets must be a non-empty array' };
  }
  const n = chartJson.labels.length;
  for (let i = 0; i < chartJson.datasets.length; i++) {
    const ds = chartJson.datasets[i];
    if (!ds?.label || !Array.isArray(ds.data) || ds.data.length !== n) {
      return { valid: false, message: `dataset[${i}] label/data mismatch` };
    }
  }
  return { valid: true, message: 'Chart structure valid' };
}

// ── Judge model ─────────────────────────────────────────────────────────────

function resolveJudgeModel() {
  return (
    process.env.JUDGE_MODEL?.trim() ||
    process.env.OPENROUTER_MODEL?.trim() ||
    process.env.OLLAMA_MODEL?.trim() ||
    'qwen2.5:7b-instruct'
  );
}

function parseJudgeJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1].trim() : text.trim();
  try {
    return JSON.parse(raw);
  } catch {
    const brace = raw.match(/\{[\s\S]*\}/);
    if (brace) {
      try {
        return JSON.parse(brace[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function judgeResponse({ question, rubric, responseText, chartValidation, error }) {
  const judgeModel = resolveJudgeModel();
  const config = getOllamaConfig({ modelName: judgeModel });
  const url = config.host ? `${config.host}/api/chat` : null;

  const userPrompt = `## Question
${question.question}

## Evaluation Rubric
${rubric}

## Chart Required
${question.requiresChart ? 'Yes' : 'No'}

## Programmatic Chart Check
${chartValidation.valid ? 'PASS' : `FAIL — ${chartValidation.message}`}

## Agent Error
${error || 'None'}

## Agent Response
${responseText || '(no response)'}

Evaluate the agent response. Return JSON only.`;

  const message = await callOllamaChat({
    url,
    model: config.model,
    fallbackModels: config.fallbackModels,
    messages: [
      { role: 'system', content: JUDGE_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    options: { ...config.options, temperature: 0.1, num_predict: 1024 },
    keepAlive: config.keepAlive,
    stream: false,
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  const parsed = parseJudgeJson(message.content);
  if (!parsed) {
    return {
      judgeModel,
      parseError: true,
      rawJudgeOutput: message.content,
      scores: null,
      overall_score: 0,
      passed: false,
      strengths: [],
      weaknesses: ['Judge model returned unparseable JSON'],
      reasoning: 'Failed to parse judge response',
    };
  }

  return { judgeModel, parseError: false, rawJudgeOutput: message.content, ...parsed };
}

// ── Agent run ───────────────────────────────────────────────────────────────

async function runSubjectAgent(question, subjectModel) {
  const toolCalls = [];
  let sqlExecuted = null;
  let thinkingSteps = 0;
  const startTime = Date.now();

  const onProgress = (p) => {
    if (p.status === 'thinking') thinkingSteps = p.loop;
    else if (p.status === 'tool_start') {
      toolCalls.push({ tool: p.tool, message: p.message, start: Date.now() });
      if (p.tool === 'execute_sql_query') {
        const m = p.message.match(/SQL:\s*"([\s\S]*?)"/i);
        if (m) sqlExecuted = m[1];
      }
    } else if (p.status === 'tool_end') {
      const last = toolCalls[toolCalls.length - 1];
      if (last?.tool === p.tool) {
        last.durationMs = Date.now() - last.start;
        last.responseSummary = p.message;
      }
    }
  };

  let error = null;
  let agentResponse = null;

  try {
    agentResponse = await runAgent({
      userMessage: question.question,
      onProgress,
      modelName: subjectModel,
      ollamaHost: process.env.OLLAMA_HOST || 'http://localhost:11434',
    });
  } catch (err) {
    error = err.message;
  }

  const responseText = agentResponse?.text ?? null;
  const chartJson = extractChartJson(responseText);
  const chartValidation = validateChart(chartJson, question.requiresChart);

  return {
    durationMs: Date.now() - startTime,
    thinkingLoops: thinkingSteps,
    toolCalls,
    sqlExecuted,
    responseText,
    chartJson,
    chartValidation,
    error,
  };
}

// ── Report generation ───────────────────────────────────────────────────────

function avg(nums) {
  const v = nums.filter((n) => typeof n === 'number' && !Number.isNaN(n));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

function generateReport(results, subjectModel, judgeModel) {
  const total = results.length;
  const passed = results.filter((r) => r.finalPassed).length;
  const passRate = total ? ((passed / total) * 100).toFixed(1) : '0.0';

  const byDifficulty = {};
  for (const d of DIFFICULTY_ORDER) {
    const subset = results.filter((r) => r.difficulty === d);
    const subPassed = subset.filter((r) => r.finalPassed).length;
    const scores = subset.map((r) => r.judge?.overall_score).filter((s) => typeof s === 'number');
    byDifficulty[d] = {
      total: subset.length,
      passed: subPassed,
      passRate: subset.length ? ((subPassed / subset.length) * 100).toFixed(1) : '0.0',
      avgScore: avg(scores).toFixed(2),
    };
  }

  let md = `# Model Evaluation Report (25 Questions)\n\n`;
  md += `Generated: ${new Date().toLocaleString()}\n`;
  md += `Subject model: \`${subjectModel}\`\n`;
  md += `Judge model: \`${judgeModel}\`\n\n`;

  md += `## Summary\n\n`;
  md += `| Metric | Value |\n|--------|-------|\n`;
  md += `| Overall pass rate | **${passRate}%** (${passed}/${total}) |\n`;
  md += `| Avg judge score | ${avg(results.map((r) => r.judge?.overall_score)).toFixed(2)} / 5 |\n`;
  md += `| Avg duration | ${(avg(results.map((r) => r.durationMs)) / 1000).toFixed(1)}s |\n`;
  md += `| Avg thinking loops | ${avg(results.map((r) => r.thinkingLoops)).toFixed(1)} |\n\n`;

  md += `## Pass Rate by Difficulty\n\n`;
  md += `| Difficulty | Passed | Total | Pass Rate | Avg Score |\n`;
  md += `|------------|--------|-------|-----------|----------|\n`;
  for (const d of DIFFICULTY_ORDER) {
    const s = byDifficulty[d];
    md += `| ${d} | ${s.passed} | ${s.total} | ${s.passRate}% | ${s.avgScore} |\n`;
  }

  md += `\n## Score Dimensions (averages)\n\n`;
  const dims = ['accuracy', 'completeness', 'data_usage', 'chart_quality', 'clarity'];
  for (const dim of dims) {
    const val = avg(results.map((r) => r.judge?.scores?.[dim])).toFixed(2);
    md += `- **${dim}**: ${val} / 5\n`;
  }

  md += `\n## Detailed Results\n\n`;
  md += `| ID | Difficulty | Name | Judge Score | Chart | SQL | Status |\n`;
  md += `|----|------------|------|-------------|-------|-----|--------|\n`;
  for (const r of results) {
    const score = r.judge?.overall_score?.toFixed(1) ?? '—';
    const chart = r.chartValidation.valid ? '✅' : '❌';
    const sql = r.sqlExecuted ? '✅' : '❌';
    const status = r.finalPassed ? '✅ PASS' : '❌ FAIL';
    md += `| ${r.id} | ${r.difficulty} | ${r.name} | ${score} | ${chart} | ${sql} | ${status} |\n`;
  }

  const failures = results.filter((r) => !r.finalPassed);
  if (failures.length) {
    md += `\n## Failure Analysis\n\n`;
    for (const f of failures) {
      md += `### Q${f.id}: ${f.name} (${f.difficulty})\n`;
      md += `- **Judge score**: ${f.judge?.overall_score ?? 'N/A'}\n`;
      md += `- **Weaknesses**: ${(f.judge?.weaknesses || []).join('; ') || '—'}\n`;
      md += `- **Chart**: ${f.chartValidation.message}\n`;
      if (f.error) md += `- **Agent error**: ${f.error}\n`;
      md += `- **Reasoning**: ${f.judge?.reasoning || '—'}\n\n`;
    }
  } else {
    md += `\n## Failure Analysis\n\nAll questions passed.\n`;
  }

  return { md, summary: { total, passed, passRate, byDifficulty } };
}

// ── Main ────────────────────────────────────────────────────────────────────

function slugifyModel(model) {
  return model.replace(/[/:]/g, '_');
}

async function evaluateModel({
  subjectModel,
  judgeModel: judgeOverride,
  start = 1,
  end = 25,
  questions: questionsOverride = null,
  suiteName = 'default',
  opts = {},
  onQuestionDone,
}) {
  const judgeModel = judgeOverride || resolveJudgeModel();
  const pool = questionsOverride ?? EVALUATION_QUESTIONS;
  const questions = questionsOverride
    ? pool
    : pool.filter((q) => q.id >= start && q.id <= end);
  const responsesPath = path.resolve(
    `data/model_evaluation_responses_${suiteName}_${slugifyModel(subjectModel)}.json`
  );

  let savedResponses = {};
  if (opts.judgeOnly && fs.existsSync(responsesPath)) {
    savedResponses = JSON.parse(fs.readFileSync(responsesPath, 'utf8'));
  }

  const results = [];

  for (const q of questions) {
    onQuestionDone?.({ phase: 'start', question: q, subjectModel });

    let run;
    if (opts.judgeOnly && savedResponses[q.id]) {
      run = savedResponses[q.id];
    } else if (!opts.judgeOnly) {
      run = await runSubjectAgent(q, subjectModel);
      savedResponses[q.id] = run;
      fs.mkdirSync(path.dirname(responsesPath), { recursive: true });
      fs.writeFileSync(responsesPath, JSON.stringify(savedResponses, null, 2));
    } else {
      run = {
        durationMs: 0,
        thinkingLoops: 0,
        toolCalls: [],
        sqlExecuted: null,
        responseText: null,
        chartJson: null,
        chartValidation: { valid: false, message: 'No response' },
        error: 'No cached response for --judge-only',
      };
    }

    let judge = null;
    if (!opts.skipJudge && !opts.programmatic) {
      const prevJudge = process.env.JUDGE_MODEL;
      process.env.JUDGE_MODEL = judgeModel;
      judge = await judgeResponse({
        question: q,
        rubric: q.rubric,
        responseText: run.responseText,
        chartValidation: run.chartValidation,
        error: run.error,
      });
      if (prevJudge) process.env.JUDGE_MODEL = prevJudge;
      else delete process.env.JUDGE_MODEL;
    }

    const finalPassed = opts.programmatic
      ? !run.error && run.chartValidation.valid && (run.sqlExecuted || run.toolCalls?.length > 0)
      : !run.error &&
        run.chartValidation.valid &&
        (opts.skipJudge ? true : judge?.passed === true && (judge?.overall_score ?? 0) >= 3.5);

    const record = {
      id: q.id,
      difficulty: q.difficulty,
      category: q.category,
      name: q.name,
      question: q.question,
      requiresChart: q.requiresChart,
      rubric: q.rubric,
      ...run,
      judge,
      finalPassed,
    };
    results.push(record);
    onQuestionDone?.({ phase: 'done', question: q, subjectModel, record });
  }

  const { md, summary } = generateReport(results, subjectModel, judgeModel);
  return {
    subjectModel,
    judgeModel,
    suiteName,
    questionRange: questionsOverride ? { start: 1, end: questions.length } : { start, end },
    summary,
    results,
    reportMd: md,
  };
}

export {
  evaluateModel,
  runSubjectAgent,
  judgeResponse,
  generateReport,
  extractChartJson,
  validateChart,
  resolveJudgeModel,
  parseArgs,
  RESULTS_JSON,
  REPORT_MD,
};

async function runEvaluateCli() {
  const opts = parseArgs();
  const subjectModel =
    process.env.OLLAMA_MODEL?.trim() ||
    process.env.OPENROUTER_MODEL?.trim() ||
    'qwen2.5:7b-instruct';
  const judgeModel = resolveJudgeModel();

  console.log('═'.repeat(72));
  console.log('     ESG AGENT — 25-QUESTION EVALUATION WITH LLM JUDGE');
  console.log('═'.repeat(72));
  console.log(`Started: ${new Date().toISOString()}`);
  console.log(`Subject model: ${subjectModel}`);
  console.log(`Judge model:   ${judgeModel}`);
  console.log(`Questions:     ${opts.start}–${opts.end}`);
  console.log('═'.repeat(72));

  fs.mkdirSync(path.dirname(RESULTS_JSON), { recursive: true });

  const output = await evaluateModel({
    subjectModel,
    judgeModel,
    start: opts.start,
    end: opts.end,
    opts,
    onQuestionDone: ({ phase, question, record }) => {
      if (phase === 'start') {
        console.log(`\n[Q${question.id}] ${question.name} [${question.difficulty}]`);
      } else if (record) {
        console.log(
          `  done: ${(record.durationMs / 1000).toFixed(1)}s | score=${record.judge?.overall_score ?? '?'} | ${record.finalPassed ? 'PASS' : 'FAIL'}`
        );
      }
    },
  });

  fs.writeFileSync(
    RESULTS_JSON,
    JSON.stringify({ generatedAt: new Date().toISOString(), ...output }, null, 2)
  );
  fs.writeFileSync(REPORT_MD, output.reportMd);

  console.log('\n' + '═'.repeat(72));
  console.log('                         EVALUATION COMPLETE');
  console.log('═'.repeat(72));
  console.log(`Passed: ${output.summary.passed}/${output.summary.total} (${output.summary.passRate}%)`);
  for (const d of DIFFICULTY_ORDER) {
    const s = output.summary.byDifficulty[d];
    if (s?.total) console.log(`  ${d}: ${s.passed}/${s.total} (${s.passRate}%) — avg score ${s.avgScore}`);
  }
  console.log(`JSON:  ${RESULTS_JSON}`);
  console.log(`Report: ${REPORT_MD}`);
  console.log('═'.repeat(72));
}

const __evalMain = fileURLToPath(import.meta.url);
if (process.argv[1] === __evalMain) {
  runEvaluateCli().catch((err) => {
    console.error('Evaluation failed:', err);
    process.exit(1);
  });
}
