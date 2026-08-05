/**
 * Evaluation runner — plan mode (smoke) and pipeline mode (full).
 */

import { classifyIntent } from '../intent/classify-intent.js';
import { applyMemoryToClassification } from '../memory/conversation-memory.js';
import { planExecution } from '../execution/execution-planner.js';
import { loadBenchmarks } from './load-benchmarks.js';
import { scoreBenchmarkCase } from './scorers/index.js';
import { buildEvaluationReport } from './evaluation-report.js';

/**
 * Observe plan-only outputs for a benchmark case (no DB / LLM).
 * Mirrors pipeline: classify → apply memory → planExecution.
 */
export function observePlan(caseItem) {
  let classification = classifyIntent(caseItem.question, caseItem.memory);
  if (caseItem.memory) {
    classification = applyMemoryToClassification(
      classification,
      caseItem.memory,
      caseItem.question,
    );
  }
  const { plan } = planExecution({
    userMessage: caseItem.question,
    memory: caseItem.memory,
    classification,
  });

  return {
    pipelineRan: false,
    intent: classification.intent,
    entities: classification.entities || [],
    metric: classification.metric || plan.metrics?.[0] || null,
    year: classification.filters?.years?.[0] ?? plan.years?.[0] ?? null,
    classification,
    plan,
    executionStrategy: plan.executionStrategy,
    requiredEngines: plan.requiredEngines || [],
    executionPath: null,
    text: '',
    data: null,
    visualization: null,
    citations: [],
    responseValidation: null,
    route: null,
  };
}

/**
 * Observe full pipeline outputs (requires DB for analytics cases).
 */
export async function observePipeline(caseItem) {
  const { runBrsrPipeline } = await import('../pipeline/run-pipeline.js');
  const result = await runBrsrPipeline({
    userMessage: caseItem.question,
    chatHistory: caseItem.chatHistory || [],
    sessionId: `eval-${caseItem.id}`,
  });

  const classification = result.classification || classifyIntent(caseItem.question, caseItem.memory);
  const plan = result.executionPlan
    || planExecution({
      userMessage: caseItem.question,
      memory: caseItem.memory || result.memory,
      classification,
    }).plan;

  return {
    pipelineRan: true,
    intent: classification?.intent || null,
    entities: classification?.entities || plan?.entities || [],
    metric: classification?.metric || plan?.metrics?.[0] || result.sqlResult?.data?.metric || null,
    year: classification?.filters?.years?.[0]
      ?? plan?.years?.[0]
      ?? result.sqlResult?.data?.year
      ?? null,
    classification,
    plan,
    executionStrategy: plan?.executionStrategy || null,
    requiredEngines: plan?.requiredEngines || result.executionPlan?.requiredEngines || [],
    executionPath: result.route?.mode || result.orchestrator || null,
    text: result.text || '',
    data: result.sqlResult?.data
      || result.engineResults?.find((r) => r?.data)?.data
      || null,
    visualization: result.engineResults?.find((r) => r?.visualization)?.visualization || null,
    citations: collectCitations(result),
    responseValidation: result.responseValidation || result.validation || null,
    route: result.route || null,
    handled: result.handled,
  };
}

/**
 * Run evaluation over loaded (or provided) cases.
 *
 * @param {object} opts
 * @param {'plan'|'pipeline'} [opts.mode]
 * @param {'smoke'|'full'|null} [opts.tier]
 * @param {string|null} [opts.category]
 * @param {string|null} [opts.id]
 * @param {object[]|null} [opts.cases]
 * @param {boolean} [opts.softSkipPipeline] - on pipeline failure, fall back to plan score
 */
export async function runEvaluation(opts = {}) {
  const mode = opts.mode === 'pipeline' ? 'pipeline' : 'plan';
  const cases = opts.cases || await loadBenchmarks({
    category: opts.category || null,
    tier: opts.tier || null,
    id: opts.id || null,
  });

  const results = [];
  for (const caseItem of cases) {
    const started = Date.now();
    let actual;
    let observeError = null;

    try {
      if (mode === 'pipeline' && caseItem.tier === 'full') {
        try {
          actual = await observePipeline(caseItem);
        } catch (err) {
          observeError = String(err?.message || err);
          if (opts.softSkipPipeline !== false) {
            actual = observePlan(caseItem);
            actual.pipelineError = observeError;
            actual.pipelineRan = false;
          } else {
            throw err;
          }
        }
      } else if (mode === 'pipeline') {
        // smoke cases in pipeline mode: still plan-score for speed unless forced
        actual = opts.forcePipelineSmoke
          ? await observePipeline(caseItem).catch((err) => {
            observeError = String(err?.message || err);
            const fallback = observePlan(caseItem);
            fallback.pipelineError = observeError;
            return fallback;
          })
          : observePlan(caseItem);
      } else {
        actual = observePlan(caseItem);
      }
    } catch (err) {
      results.push({
        id: caseItem.id,
        category: caseItem.category,
        tier: caseItem.tier,
        question: caseItem.question,
        passed: false,
        score: 0,
        error: String(err?.message || err),
        dimensions: {},
        skipped: [],
        latencyMs: Date.now() - started,
      });
      continue;
    }

    // When pipeline soft-failed, disable numeric scoring for this case
    const scoreFlags = { ...caseItem.score };
    if (actual.pipelineError || (!actual.pipelineRan && scoreFlags.numeric)) {
      scoreFlags.numeric = false;
    }

    const scored = scoreBenchmarkCase(actual, caseItem.expected, scoreFlags);
    results.push({
      id: caseItem.id,
      category: caseItem.category,
      tier: caseItem.tier,
      question: caseItem.question,
      passed: scored.passed,
      score: scored.score,
      dimensions: scored.dimensions,
      skipped: scored.skipped,
      latencyMs: Date.now() - started,
      actual: summarizeActual(actual),
      pipelineError: actual.pipelineError || observeError || null,
    });
  }

  return buildEvaluationReport({
    mode,
    tier: opts.tier || 'all',
    category: opts.category || 'all',
    results,
  });
}

function collectCitations(result) {
  const out = [];
  for (const r of result.engineResults || []) {
    for (const c of r.citations || []) {
      if (c && !out.includes(c)) out.push(c);
    }
  }
  return out;
}

function summarizeActual(actual) {
  return {
    intent: actual.intent,
    entities: actual.entities,
    metric: actual.metric,
    year: actual.year,
    executionStrategy: actual.executionStrategy,
    requiredEngines: actual.requiredEngines,
    executionPath: actual.executionPath,
    pipelineRan: actual.pipelineRan,
    verdict: actual.responseValidation?.verdict || null,
    textLength: String(actual.text || '').length,
  };
}
