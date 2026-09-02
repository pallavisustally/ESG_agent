/**
 * Phase 11 — Regression suite (~180 table-driven cases).
 *
 * Categories:
 * - Conversation (above companies, same year, compare again, clarification, pending)
 * - Metrics (supported, derived, unsupported)
 * - Routing (SQL, Narrative, PDF, WHY)
 * - Responses (rankings, charts, comparisons)
 *
 * Every bug-class becomes a permanent assertion here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntent, INTENTS } from '../intent/classify-intent.js';
import { METRIC_RESOLUTION, resolveMetricState } from '../intent/metric-resolution.js';
import {
  buildPendingRequest,
  isClarificationContinuation,
  resumeClassificationFromPending,
  shouldAbandonPendingRequest,
} from '../intent/pending-request.js';
import { validatePriorCompanyReference } from '../intent/conversation-context.js';
import { applyMemoryToClassification } from '../memory/conversation-memory.js';
import { planExecution } from '../execution/execution-planner.js';
import { planQuery, TOOLS } from '../planner/plan-query.js';
import { routeTools, shouldSkipRag } from '../router/tool-router.js';
import { planAndValidate, validatePlan } from '../validation/plan-validator.js';
import {
  validateResponse,
  isMetricAnsweredByNarrative,
} from '../validation/response-validator.js';
import {
  isCompanyScopedDocumentFallbackEligible,
  DOCUMENT_FALLBACK_BLOCKED_INTENTS,
} from '../pipeline/sql-document-fallback.js';
import { isHybridWhyQuestion } from '../pipeline/hybrid-why.js';
import { scorePlan } from '../planner/planner-score.js';
import { createExecutionTrace, enrichTraceFromPipeline, TRACE_STEPS } from '../observability/execution-trace.js';
import {
  recordRequestMetrics,
  getMonitoringSnapshot,
  resetMonitoringCounters,
  recordFromPipelineResult,
} from '../observability/monitoring.js';
import { isPlanningModelEnabled } from '../planner/planning-model.js';

// ─── helpers ───────────────────────────────────────────────────────────────

function memoryBag(overrides = {}) {
  return {
    lastIntent: INTENTS.COMPARE_COMPANIES,
    lastCompanies: ['Infosys Limited', 'Tata Consultancy Services Limited'],
    lastMetric: 'scope1_emissions',
    lastYear: 2024,
    comparisonContext: {
      companies: ['Infosys Limited', 'Tata Consultancy Services Limited'],
      metric: 'scope1_emissions',
      year: 2024,
    },
    ...overrides,
  };
}

function assertSqlRoute(message, memory = null) {
  const classification = classifyIntent(message, memory);
  const { plan } = planAndValidate(classification, memory, { userMessage: message });
  const route = routeTools(plan);
  assert.ok(
    plan.primaryTool === TOOLS.SQL
    || plan.primaryTool === TOOLS.HYBRID
    || plan.strategy === 'unsupported_metric'
    || plan.strategy === 'clarify_prior_companies',
    `expected SQL-ish tool for "${message}", got ${plan.primaryTool}/${plan.strategy}`,
  );
  if (plan.strategy === 'sql_rank_metric' || plan.strategy === 'sql_company_metric' || plan.strategy === 'sql_compare_companies') {
    assert.equal(shouldSkipRag(plan), true, `rankings/lookup must skip RAG: ${message}`);
  }
  return { classification, plan, route };
}

// ─── Conversation ──────────────────────────────────────────────────────────

describe('regression: conversation', () => {
  const aboveCases = [
    'male employees in the above companies',
    'scope 1 for those companies',
    'compare the above on renewable share',
    'same for the companies above',
    'what about them for water consumption',
  ];
  for (const msg of aboveCases) {
    it(`above-companies without memory clarifies: ${msg}`, () => {
      const check = validatePriorCompanyReference(msg, null);
      assert.equal(check.refersToPrior, true);
      assert.equal(check.ok, false);
    });
  }

  for (const msg of aboveCases) {
    it(`above-companies with memory resolves: ${msg}`, () => {
      const check = validatePriorCompanyReference(msg, memoryBag());
      assert.equal(check.ok, true);
      assert.ok(check.companies.length >= 2);
    });
  }

  const sameYearCases = [
    'same year for Infosys Scope 2',
    'Infosys Scope 1 for the same year',
    'compare again for 2024',
  ];
  for (const msg of sameYearCases) {
    it(`same-year / compare-again classifies: ${msg}`, () => {
      const c = classifyIntent(msg, memoryBag());
      assert.ok(c.intent);
      assert.ok(typeof c.confidence === 'number' && c.confidence > 0);
    });
  }

  it('prior-metric + same year → analytics (not llm_fallback)', () => {
    const msg = 'Scope 1 for TCS in the same year';
    const memory = memoryBag({
      lastIntent: 'METRIC_LOOKUP',
      lastCompanies: ['Infosys Limited'],
      lastMetric: 'scope1_emissions',
      lastYear: 2024,
    });
    let classification = classifyIntent(msg, memory);
    classification = applyMemoryToClassification(classification, memory, msg);
    assert.equal(classification.metric, 'scope1_emissions');
    assert.ok(classification.entities?.some((e) => /tcs/i.test(e)));
    assert.equal(classification.filters?.years?.[0], 2024);
    const { plan } = planExecution({ userMessage: msg, memory, classification });
    assert.equal(plan.executionStrategy, 'analytics');
    assert.equal(plan.needsClarification, false);
    assert.ok(plan.requiredEngines.includes('analytics'));
  });

  it('short Scope 2 follow-up reuses prior companies', () => {
    const msg = 'and Scope 2?';
    const memory = memoryBag({
      lastIntent: 'METRIC_LOOKUP',
      lastCompanies: ['Infosys Limited'],
      lastMetric: 'scope1_emissions',
      lastYear: 2024,
    });
    let classification = classifyIntent(msg, memory);
    classification = applyMemoryToClassification(classification, memory, msg);
    assert.ok(classification.entities?.some((e) => /infosys/i.test(e)));
    const { plan } = planExecution({ userMessage: msg, memory, classification });
    assert.notEqual(plan.executionStrategy, 'llm_fallback');
  });

  it('Infosys male/female employees (with typo) is metric lookup, not company count', () => {
    const msg = 'how many male and female employes are working in infosys company';
    const memory = memoryBag({
      lastIntent: 'COUNT_COMPANIES',
      lastList: { total: 1336 },
    });
    let classification = classifyIntent(msg, memory);
    classification = applyMemoryToClassification(classification, memory, msg);
    assert.notEqual(classification.intent, 'COUNT_COMPANIES');
    assert.equal(classification.intent, 'METRIC_LOOKUP');
    assert.ok(classification.entities?.some((e) => /infosys/i.test(e)));
    assert.ok(
      classification.metrics?.includes('male_employee_count')
      || classification.metrics?.includes('female_employee_count')
      || /employee_count/.test(classification.metric || ''),
    );
    const { plan } = planExecution({ userMessage: msg, memory, classification });
    assert.equal(plan.executionStrategy, 'analytics');
    assert.notEqual(plan.executionStrategy, 'clarify');
  });

  it('year-scoped company count keeps year on the plan', () => {
    const msg = 'in the year 2025 how many companies hold brsr reports';
    const classification = classifyIntent(msg);
    assert.equal(classification.intent, 'COUNT_COMPANIES');
    assert.equal(classification.filters?.years?.[0], 2025);
    const { plan } = planExecution({ userMessage: msg, classification });
    assert.equal(plan.executionStrategy, 'analytics');
    assert.equal(plan.years?.[0], 2025);
  });

  it('company-count ask does not reuse prior TCS employee memory', () => {
    const memory = memoryBag({
      lastIntent: 'METRIC_LOOKUP',
      lastCompanies: ['Tata Consultancy Services Limited'],
      lastMetric: 'female_employee_count',
      lastYear: 2025,
      filters: {
        metric: 'female_employee_count',
        metrics: ['female_employee_count', 'male_employee_count'],
        years: [2025],
      },
    });
    for (const msg of [
      'how many comannies hold brsr reports in 2024',
      'how many companies are there in 2025 year',
      'in the year 2025 how many companies hold brsr reports',
    ]) {
      let classification = classifyIntent(msg, memory);
      classification = applyMemoryToClassification(classification, memory, msg);
      assert.equal(classification.intent, 'COUNT_COMPANIES', msg);
      assert.deepEqual(classification.entities || [], [], msg);
      assert.equal(classification.metric, null, msg);
      assert.ok(!(classification.assumptions || []).some((a) => /Tata|prior companies/i.test(a)), msg);
      const { plan } = planExecution({ userMessage: msg, memory, classification });
      assert.equal(plan.executionStrategy, 'analytics', msg);
      assert.deepEqual(plan.entities || [], [], msg);
      assert.deepEqual(plan.metrics || [], [], msg);
      assert.ok(!/Follow-up resolved from prior context/i.test(plan.assumptions?.join(' ') || ''), msg);
    }
  });

  it('standalone ask does not borrow prior company/metric without follow-up cues', () => {
    const memory = memoryBag({
      lastIntent: 'METRIC_LOOKUP',
      lastCompanies: ['Tata Consultancy Services Limited'],
      lastMetric: 'female_employee_count',
      lastYear: 2025,
      filters: { metric: 'female_employee_count', years: [2025] },
    });
    const msg = 'What is Scope 1 emissions for Infosys Limited in 2024?';
    let classification = classifyIntent(msg, memory);
    classification = applyMemoryToClassification(classification, memory, msg);
    assert.ok(classification.entities?.some((e) => /infosys/i.test(e)), 'keeps Infosys');
    assert.ok(!(classification.entities || []).some((e) => /tata|tcs/i.test(e)), 'does not add TCS');
    assert.equal(classification.metric, 'scope1_emissions');
    assert.equal(classification.filters?.years?.[0], 2024);
    assert.ok(
      !(classification.assumptions || []).some((a) => /Follow-up resolved from prior context/i.test(a)),
    );
  });

  it('company-count typos still route to COUNT and ignore prior TCS metric', () => {
    const memory = memoryBag({
      lastIntent: 'METRIC_LOOKUP',
      lastCompanies: ['Tata Consultancy Services Limited'],
      lastMetric: 'female_employee_count',
      lastYear: 2025,
      filters: { metric: 'female_employee_count', years: [2025] },
    });
    for (const msg of [
      'how many comanies hold brsr reports in 2026',
      'how man comanies hold brsr reports in 2024',
      'how many comannies hold brsr reports in 2024',
    ]) {
      let classification = classifyIntent(msg, memory);
      classification = applyMemoryToClassification(classification, memory, msg);
      assert.equal(classification.intent, 'COUNT_COMPANIES', msg);
      assert.deepEqual(classification.entities || [], [], msg);
      assert.equal(classification.metric, null, msg);
      assert.ok(classification.filters?.years?.[0] >= 2024, msg);
    }
  });

  it('year-only after company-count continues COUNT, not prior metric', () => {
    const memory = memoryBag({
      lastIntent: 'COUNT_COMPANIES',
      canonicalIntent: 'COUNT',
      lastCompanies: [],
      lastMetric: null,
      lastYear: 2025,
      filters: { years: [2025] },
      entities: [],
    });
    for (const msg of ['in 2024', 'in 2026']) {
      let classification = classifyIntent(msg, memory);
      classification = applyMemoryToClassification(classification, memory, msg);
      assert.equal(classification.intent, 'COUNT_COMPANIES', msg);
      assert.deepEqual(classification.entities || [], [], msg);
      assert.equal(classification.metric, null, msg);
      assert.equal(classification.filters?.years?.[0], Number(msg.match(/20\d{2}/)[0]), msg);
    }
  });

  it('pending request stores and resumes after clarification', () => {
    const pending = buildPendingRequest({
      userMessage: 'male employee count for the above companies',
      classification: {
        intent: INTENTS.METRIC_LOOKUP,
        metric: 'male_employee_count',
        metricResolution: METRIC_RESOLUTION.FOUND,
        filters: { years: [2024] },
        entities: [],
      },
    });
    assert.equal(pending.metric, 'male_employee_count');

    const clarificationMsg = 'Use Infosys and TCS';
    const clarification = classifyIntent(clarificationMsg, memoryBag({ pendingRequest: pending }));
    assert.ok(
      isClarificationContinuation(clarificationMsg, clarification, pending)
      || clarification.entities.length >= 1,
    );

    const resumed = resumeClassificationFromPending(
      {
        intent: INTENTS.METRIC_LOOKUP,
        entities: ['Infosys Limited', 'TCS'],
        filters: {},
        confidence: 0.9,
      },
      pending,
    );
    assert.equal(resumed.metric, 'male_employee_count');
  });

  it('fully specified new ask abandons pending', () => {
    const pending = buildPendingRequest({
      userMessage: 'male employees above',
      classification: {
        intent: INTENTS.METRIC_LOOKUP,
        metric: 'male_employee_count',
        entities: [],
        filters: {},
      },
    });
    const msg = 'What is Scope 1 for Reliance Industries in 2024?';
    const next = classifyIntent(msg);
    assert.equal(shouldAbandonPendingRequest(msg, next, pending), true);
  });

  const clarifyPhrases = [
    'which companies?',
    'please name the companies',
    'Infosys and Wipro',
    'use the top 5',
  ];
  for (const phrase of clarifyPhrases) {
    it(`clarification phrase is handled: ${phrase}`, () => {
      const c = classifyIntent(phrase, memoryBag({
        pendingRequest: {
          intent: INTENTS.METRIC_LOOKUP,
          metric: 'scope1_emissions',
          userMessage: 'scope 1 for above companies',
        },
      }));
      assert.ok(c.intent);
      assert.ok(c.confidence > 0);
    });
  }
});

// ─── Metrics ───────────────────────────────────────────────────────────────

describe('regression: metrics', () => {
  const supported = [
    ['Scope 1 emissions for Infosys', 'scope1_emissions'],
    ['Scope 2 of TCS', 'scope2_emissions'],
    ['Scope 3 emissions Infosys 2024', 'scope3_emissions'],
    ['carbon emissions Infosys', 'total_emissions'],
    ['GHG emissions for Wipro', 'total_emissions'],
    ['renewable energy share Infosys', 'renewable_energy_share'],
    ['female employee share TCS', 'female_employee_share'],
    ['female employees count Infosys', 'female_employee_count'],
    ['male employee count Infosys', 'male_employee_count'],
    ['water consumption Infosys', 'water_consumption'],
    ['waste generated TCS', 'waste_generated'],
    ['energy consumption Infosys', 'energy_consumption'],
    ['emissions intensity Infosys', 'emissions_intensity'],
    ['LTIFR Infosys', 'safety_ltifr'],
    ['total revenue Infosys', 'total_revenue'],
  ];

  for (const [msg, metric] of supported) {
    it(`supported metric FOUND: ${metric}`, () => {
      const state = resolveMetricState(msg);
      assert.ok(
        state.state === METRIC_RESOLUTION.FOUND || state.state === METRIC_RESOLUTION.DERIVED,
        `${msg} → ${state.state}`,
      );
      assert.equal(state.metric, metric);
    });
  }

  const derived = [
    'male board share Infosys',
    'male board members Infosys',
    'number of male directors Infosys',
  ];
  for (const msg of derived) {
    it(`derived metric: ${msg}`, () => {
      const state = resolveMetricState(msg);
      // May be DERIVED or FOUND depending on alias table — never UNSUPPORTED for male board*.
      assert.notEqual(state.state, METRIC_RESOLUTION.UNSUPPORTED);
    });
  }

  const unsupported = [
    'plastic footprint of Infosys',
    'Scope 4 emissions Infosys',
    'ocean pollution Infosys',
  ];
  for (const msg of unsupported) {
    it(`unsupported metric: ${msg}`, () => {
      const state = resolveMetricState(msg);
      assert.equal(state.state, METRIC_RESOLUTION.UNSUPPORTED);
    });
  }

  const unknownMetricPhrases = [
    'biodiversity score Infosys',
    'AI ethics score TCS',
  ];
  for (const msg of unknownMetricPhrases) {
    it(`unknown metric is not FOUND: ${msg}`, () => {
      const state = resolveMetricState(msg);
      assert.notEqual(state.state, METRIC_RESOLUTION.FOUND);
      assert.notEqual(state.state, METRIC_RESOLUTION.DERIVED);
    });
  }

  const noneCases = [
    'list all companies',
    'how many companies are there',
    'companies in IT sector',
    'next page',
  ];
  for (const msg of noneCases) {
    it(`metric NONE for non-metric ask: ${msg}`, () => {
      const state = resolveMetricState(msg);
      assert.equal(state.state, METRIC_RESOLUTION.NONE);
    });
  }
});

// ─── Routing ───────────────────────────────────────────────────────────────

describe('regression: routing SQL', () => {
  const sqlMessages = [
    'Top 5 companies by Scope 1 emissions',
    'Bottom 10 by renewable energy share',
    'How many companies are in the database?',
    'List all BRSR companies',
    'Compare Infosys and TCS Scope 1',
    'Infosys Scope 1 emissions 2024',
    'TCS Scope 2 in 2023',
    'Highest female employee share',
    'Lowest water consumption companies',
    'Show companies in the IT sector',
    'List steel sector companies',
    'Wipro Scope 1 emissions',
    'Reliance Scope 3',
    'Top companies by waste generated',
    'Compare JSW and Tata Steel on Scope 1',
  ];
  for (const msg of sqlMessages) {
    it(`SQL path: ${msg}`, () => {
      assertSqlRoute(msg);
    });
  }
});

describe('regression: routing Narrative / HOW_TO / WHY', () => {
  const howTo = [
    'How to reduce carbon emissions?',
    'How can companies control Scope 1?',
    'Ways to mitigate GHG emissions',
    'Best practices to reduce carbon emissions',
  ];
  for (const msg of howTo) {
    it(`HOW_TO not SQL ranking: ${msg}`, () => {
      const c = classifyIntent(msg);
      const { plan } = planAndValidate(c, null, { userMessage: msg });
      assert.notEqual(plan.strategy, 'sql_rank_metric');
      assert.ok(
        plan.intent === INTENTS.HOW_TO || plan.strategy === 'guidance_templates',
        `got ${plan.intent}/${plan.strategy}`,
      );
    });
  }

  const whyMsgs = [
    'Why is Infosys higher than TCS on Scope 1?',
    'Why does Tata Steel have higher emissions than JSW?',
  ];
  for (const msg of whyMsgs) {
    it(`WHY hybrid candidate: ${msg}`, () => {
      assert.equal(isHybridWhyQuestion(msg), true);
    });
  }

  it('PDF fallback blocked for rankings', () => {
    for (const intent of DOCUMENT_FALLBACK_BLOCKED_INTENTS) {
      assert.equal(
        isCompanyScopedDocumentFallbackEligible({
          classification: { intent, metric: 'scope1_emissions' },
          companies: ['Infosys Limited'],
          userMessage: 'top companies',
        }),
        false,
      );
    }
  });

  it('PDF fallback skipped for unsupported number ask', () => {
    assert.equal(
      isCompanyScopedDocumentFallbackEligible({
        classification: {
          intent: INTENTS.METRIC_LOOKUP,
          metricResolution: METRIC_RESOLUTION.UNSUPPORTED,
          filters: { unsupportedMetric: true },
        },
        companies: ['Infosys Limited'],
        userMessage: 'plastic footprint Infosys',
      }),
      false,
    );
  });

  it('PDF fallback allowed when user asks for the report', () => {
    assert.equal(
      isCompanyScopedDocumentFallbackEligible({
        classification: {
          intent: INTENTS.METRIC_LOOKUP,
          metricResolution: METRIC_RESOLUTION.UNSUPPORTED,
          filters: { unsupportedMetric: true },
        },
        companies: ['Infosys Limited'],
        userMessage: 'plastic footprint Infosys from the BRSR PDF',
      }),
      true,
    );
  });
});

// ─── Responses ─────────────────────────────────────────────────────────────

describe('regression: responses rankings / compare / narrative reject', () => {
  const rankingRows = [
    { company: 'A Steel', metric_value: 100, year: 2024 },
    { company: 'B Steel', metric_value: 80, year: 2024 },
    { company: 'C Steel', metric_value: 60, year: 2024 },
  ];

  it('accepts sorted ranking response', () => {
    const v = validateResponse({
      text: '1. **A Steel** — 100\n2. **B Steel** — 80\n3. **C Steel** — 60',
      intent: INTENTS.TOP_METRIC,
      classification: { metric: 'scope1_emissions', filters: { years: [2024] } },
      data: { metric: 'scope1_emissions', rows: rankingRows },
      source: 'sql',
    });
    assert.equal(v.ok, true);
  });

  it('accepts compare response with two companies', () => {
    const v = validateResponse({
      text: 'Infosys Scope 1: 10,000. TCS Scope 1: 12,000.',
      intent: INTENTS.COMPARE_COMPANIES,
      classification: {
        metric: 'scope1_emissions',
        entities: ['Infosys Limited', 'Tata Consultancy Services Limited'],
        filters: { years: [2024] },
      },
      data: {
        metric: 'scope1_emissions',
        rows: [
          { company: 'Infosys Limited', metric_value: 10000, year: 2024 },
          { company: 'Tata Consultancy Services Limited', metric_value: 12000, year: 2024 },
        ],
      },
      source: 'sql',
    });
    assert.equal(v.ok, true);
  });

  const narrativeRejects = [
    'Carbon reduction initiatives include solar rooftops.',
    'Their emission reduction programs and net-zero roadmap are strong.',
    'Decarbonisation strategy focuses on renewable energy.',
  ];
  for (const text of narrativeRejects) {
    it(`rejects initiative text for emissions ask: ${text.slice(0, 40)}`, () => {
      assert.equal(isMetricAnsweredByNarrative(text, 'total_emissions'), true);
      const v = validateResponse({
        text,
        intent: INTENTS.METRIC_LOOKUP,
        classification: { metric: 'total_emissions', entities: ['Infosys Limited'] },
        source: 'llm',
      });
      assert.equal(v.ok, false);
      assert.equal(v.shouldReplan, true);
    });
  }

  const chartish = [
    'chart Scope 1 top 5',
    'plot emissions for Infosys vs TCS',
    'visualize renewable share ranking',
  ];
  for (const msg of chartish) {
    it(`chart request keeps confidence: ${msg}`, () => {
      const c = classifyIntent(msg);
      assert.ok(c.confidence > 0);
    });
  }
});

// ─── Planner score + intent confidence ─────────────────────────────────────

describe('regression: planner score + intent confidence', () => {
  const cases = [
    'Infosys Scope 1',
    'Top 5 Scope 2',
    'Compare Infosys and Wipro Scope 1',
    'How many companies?',
    'List companies',
  ];
  for (const msg of cases) {
    it(`intent includes confidence for: ${msg}`, () => {
      const c = classifyIntent(msg);
      assert.ok(typeof c.confidence === 'number');
      assert.ok(c.confidence >= 0.5, `low confidence ${c.confidence} for ${msg}`);
    });
  }

  for (const msg of cases) {
    it(`planner score healthy for: ${msg}`, () => {
      const c = classifyIntent(msg);
      const plan = planQuery(c);
      const scored = scorePlan(plan, c, { validation: { ok: true } });
      assert.ok(scored.score > 0.35, `${msg} score=${scored.score}`);
    });
  }
});

// ─── Execution trace + monitoring ──────────────────────────────────────────

describe('regression: execution trace + monitoring', () => {
  it('trace includes canonical steps', () => {
    const trace = createExecutionTrace({ userMessage: 'Infosys Scope 1', sessionId: 't1' });
    enrichTraceFromPipeline(trace, {
      classification: {
        intent: INTENTS.METRIC_LOOKUP,
        confidence: 0.97,
        entities: ['Infosys Limited'],
        metric: 'scope1_emissions',
        metricResolution: METRIC_RESOLUTION.FOUND,
        filters: { years: [2024] },
      },
      plan: { intent: INTENTS.METRIC_LOOKUP, strategy: 'sql_company_metric', primaryTool: 'SQL' },
      planValidation: { ok: true, errors: [], warnings: [], repairs: [] },
      route: { mode: 'deterministic_sql', skipRag: true, tools: ['SQL'] },
      responseSource: 'SQL',
      responseText: 'Scope 1 = 1000',
    });
    const json = trace.toJSON();
    assert.ok(json.steps.intent);
    assert.ok(json.steps.plan);
    assert.ok(json.steps.final_source);
    assert.ok(TRACE_STEPS.includes('planner_validation'));
  });

  it('monitoring counters track rates', () => {
    resetMonitoringCounters();
    recordRequestMetrics({
      sqlAttempted: true,
      sqlMiss: true,
      pdfFallback: true,
      clarification: false,
      latencyMs: 120,
    });
    recordRequestMetrics({
      sqlAttempted: true,
      clarification: true,
      latencyMs: 80,
    });
    const snap = getMonitoringSnapshot();
    assert.equal(snap.requests, 2);
    assert.equal(snap.pdfFallbacks, 1);
    assert.equal(snap.clarifications, 1);
    assert.ok(snap.averageLatencyMs >= 80);
  });

  it('recordFromPipelineResult accepts clarify result', () => {
    resetMonitoringCounters();
    recordFromPipelineResult({
      classification: { confidence: 0.9 },
      plan: { strategy: 'clarify_prior_companies' },
      route: { mode: 'clarify' },
      planValidation: { ok: true },
      clarification: 'Which companies?',
      handled: true,
    }, { latencyMs: 40 });
    const snap = getMonitoringSnapshot();
    assert.equal(snap.clarifications, 1);
  });

  it('planning model defaults disabled', () => {
    delete process.env.PLANNING_MODEL_ENABLED;
    assert.equal(isPlanningModelEnabled(), false);
  });
});

// ─── Plan validation matrix ────────────────────────────────────────────────

describe('regression: plan validation matrix', () => {
  const matrix = [
    {
      name: 'metric lookup SQL',
      classification: {
        intent: INTENTS.METRIC_LOOKUP,
        entities: ['Infosys Limited'],
        metric: 'scope1_emissions',
        metricResolution: METRIC_RESOLUTION.FOUND,
        confidence: 0.95,
        filters: { metric: 'scope1_emissions', years: [2024] },
        assumptions: [],
      },
      expectTool: TOOLS.SQL,
    },
    {
      name: 'top metric SQL',
      classification: {
        intent: INTENTS.TOP_METRIC,
        entities: [],
        metric: 'scope1_emissions',
        metricResolution: METRIC_RESOLUTION.FOUND,
        confidence: 0.95,
        filters: { metric: 'scope1_emissions' },
        assumptions: [],
      },
      expectTool: TOOLS.SQL,
    },
    {
      name: 'count SQL',
      classification: {
        intent: INTENTS.COUNT_COMPANIES,
        entities: [],
        metric: null,
        metricResolution: METRIC_RESOLUTION.NONE,
        confidence: 0.95,
        filters: {},
        assumptions: [],
      },
      expectTool: TOOLS.SQL,
    },
    {
      name: 'how-to RAG',
      classification: {
        intent: INTENTS.HOW_TO,
        entities: [],
        metric: null,
        metricResolution: METRIC_RESOLUTION.NONE,
        confidence: 0.95,
        filters: { guidance: true },
        assumptions: [],
      },
      expectTool: TOOLS.RAG,
    },
  ];

  for (const row of matrix) {
    it(`plan matrix: ${row.name}`, () => {
      const { plan, validation, plannerScore } = planAndValidate(
        row.classification,
        null,
        { userMessage: row.name },
      );
      assert.equal(plan.primaryTool, row.expectTool);
      assert.equal(validation.ok, true);
      assert.ok(plannerScore.score > 0.4);
    });
  }

  // Expand with many company×metric lookup plans
  const companies = ['Infosys', 'TCS', 'Wipro', 'HCL', 'Reliance'];
  const metrics = ['scope1_emissions', 'scope2_emissions', 'renewable_energy_share', 'female_employee_share'];
  for (const company of companies) {
    for (const metric of metrics) {
      it(`lookup plan ${company} × ${metric}`, () => {
        const classification = {
          intent: INTENTS.METRIC_LOOKUP,
          entities: [`${company} Limited`],
          metric,
          metricResolution: METRIC_RESOLUTION.FOUND,
          confidence: 0.9,
          filters: { metric, years: [2024] },
          assumptions: [],
        };
        const plan = planQuery(classification);
        const v = validatePlan(plan, classification);
        assert.equal(v.ok, true);
        assert.equal(plan.primaryTool, TOOLS.SQL);
        assert.equal(shouldSkipRag(plan), true);
      });
    }
  }
});

// ─── ESG Copilot capabilities ───
describe('regression: ESG Copilot capabilities', async () => {
  const {
    planCapabilities,
    shouldUseCapabilityExecutor,
    isNativeOnlyPlan,
  } = await import('../capability/capability-planner.js');
  const { CAPABILITIES } = await import('../capability/capabilities.js');

  const cases = [
    { msg: 'What is ESG?', expect: CAPABILITIES.ESG_KNOWLEDGE, native: false },
    { msg: 'What is Scope 3?', expect: CAPABILITIES.ESG_KNOWLEDGE, native: false },
    { msg: 'How can I reduce emissions?', expect: CAPABILITIES.ESG_GUIDANCE, native: false },
    { msg: 'How can I reduce water consumption?', expect: CAPABILITIES.ESG_GUIDANCE, native: false },
    { msg: 'Explain BRSR Principle 5.', expect: CAPABILITIES.ESG_COMPLIANCE, native: false },
    { msg: 'What is CSRD?', expect: CAPABILITIES.ESG_COMPLIANCE, native: false },
    { msg: 'Write an ESG policy.', expect: CAPABILITIES.DOCUMENT_GENERATION, native: false },
    { msg: 'Generate a sustainability roadmap.', expect: CAPABILITIES.DOCUMENT_GENERATION, native: false },
    { msg: 'Top 5 companies by Scope 1', expect: CAPABILITIES.COMPANY_ANALYTICS, native: true },
    { msg: 'Compare Infosys and TCS', expect: CAPABILITIES.BENCHMARKING, native: true },
  ];

  for (const row of cases) {
    it(`capability: ${row.msg}`, () => {
      const c = classifyIntent(row.msg);
      const plan = planCapabilities(row.msg, c);
      assert.ok(
        plan.capabilities.includes(row.expect),
        `expected ${row.expect} in ${JSON.stringify(plan.capabilities)}`,
      );
      assert.equal(isNativeOnlyPlan(plan), row.native);
      assert.equal(shouldUseCapabilityExecutor(plan), !row.native);
    });
  }

  it('hybrid compare + recommend selects multiple capabilities', () => {
    const msg = 'Compare Infosys and TCS emissions and suggest how Infosys can improve.';
    const c = classifyIntent(msg);
    const plan = planCapabilities(msg, {
      ...c,
      entities: c.entities?.length ? c.entities : ['Infosys', 'TCS'],
    });
    assert.ok(plan.capabilities.includes(CAPABILITIES.BENCHMARKING)
      || plan.capabilities.includes(CAPABILITIES.COMPANY_ANALYTICS));
    assert.ok(plan.capabilities.includes(CAPABILITIES.RECOMMENDATION));
    assert.equal(plan.multi, true);
    assert.equal(shouldUseCapabilityExecutor(plan), true);
  });
});
