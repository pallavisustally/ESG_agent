/**
 * Semantic planner validation — quantitative vs qualitative.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { INTENTS } from '../intent/classify-intent.js';
import { METRIC_RESOLUTION } from '../intent/metric-resolution.js';
import { classifyIntent } from '../intent/classify-intent.js';
import { applyMemoryToClassification } from '../memory/conversation-memory.js';
import { planQuery, TOOLS } from '../planner/plan-query.js';
import { planAndValidate, validatePlan } from './plan-validator.js';
import { routeTools } from '../router/tool-router.js';
import {
  detectAnswerType,
  validateSemanticPlan,
  isNarrativeFirstPlan,
  mustPreferSql,
  ANSWER_TYPES,
} from './semantic-plan.js';

function rankingMemory() {
  return {
    lastIntent: INTENTS.TOP_METRIC,
    lastCompanies: [
      'Tata Steel Limited',
      'JSW Steel Limited',
      'Infosys Limited',
      'TCS',
      'Wipro Limited',
    ],
    lastMetric: 'male_employee_count',
    lastYear: 2024,
    lastPageItems: [
      'Tata Steel Limited',
      'JSW Steel Limited',
      'Infosys Limited',
      'TCS',
      'Wipro Limited',
    ],
    entities: [
      'Tata Steel Limited',
      'JSW Steel Limited',
      'Infosys Limited',
      'TCS',
      'Wipro Limited',
    ],
  };
}

describe('detectAnswerType', () => {
  it('marks carbon emissions as QUANTITATIVE', () => {
    const d = detectAnswerType('What are the carbon emissions of the above companies?', {
      classification: {
        metric: 'total_emissions',
        metricResolution: METRIC_RESOLUTION.FOUND,
      },
    });
    assert.equal(d.answerType, ANSWER_TYPES.QUANTITATIVE);
  });

  it('marks initiatives / strategy as QUALITATIVE', () => {
    const d = detectAnswerType('What carbon reduction initiatives did Infosys disclose?');
    assert.equal(d.answerType, ANSWER_TYPES.QUALITATIVE);
  });

  it('marks how-to as QUALITATIVE', () => {
    const d = detectAnswerType('How can companies control Scope 1 emissions?');
    assert.equal(d.answerType, ANSWER_TYPES.QUALITATIVE);
  });

  const quantitativePhrases = [
    'employee count for Infosys',
    'water consumption TCS',
    'waste generated',
    'renewable energy share',
    'emissions intensity',
    'female employee percentage',
    'total revenue',
    'how many male employees',
  ];
  for (const msg of quantitativePhrases) {
    it(`quantitative phrase: ${msg}`, () => {
      const d = detectAnswerType(msg);
      assert.equal(d.answerType, ANSWER_TYPES.QUANTITATIVE);
    });
  }
});

describe('validateSemanticPlan rejects narrative-first for metrics', () => {
  it('rejects RAG/hybrid narrative for carbon emissions', () => {
    const classification = {
      intent: INTENTS.FOLLOW_UP,
      entities: ['Infosys Limited', 'TCS'],
      metric: 'total_emissions',
      metricResolution: METRIC_RESOLUTION.FOUND,
      confidence: 0.9,
      filters: { metric: 'total_emissions', years: [2024] },
    };
    const badPlan = {
      intent: INTENTS.FOLLOW_UP,
      primaryTool: TOOLS.HYBRID,
      strategy: 'follow_up_from_memory',
      entities: classification.entities,
      metric: 'total_emissions',
      useRag: true,
      filters: classification.filters,
    };
    assert.equal(isNarrativeFirstPlan(badPlan), true);
    const v = validateSemanticPlan(badPlan, classification, {
      userMessage: 'What are the carbon emissions of the above companies?',
      memory: rankingMemory(),
    });
    assert.equal(v.ok, false);
    assert.equal(v.answerType, ANSWER_TYPES.QUANTITATIVE);
    assert.ok(v.repairs.some((r) => r.type === 'force_sql_quantitative'));
  });

  it('mustPreferSql for emissions follow-up', () => {
    assert.equal(
      mustPreferSql('What are the carbon emissions of the above companies?', {
        metric: 'total_emissions',
        metricResolution: METRIC_RESOLUTION.FOUND,
      }),
      true,
    );
  });
});

describe('carbon emissions of above companies → SQL not narrative', () => {
  const msg = 'What are the carbon emissions of the above companies?';

  it('classifies as quantitative SQL compare/lookup', () => {
    const memory = rankingMemory();
    let classification = classifyIntent(msg, memory);
    classification = applyMemoryToClassification(classification, memory, msg);
    const planned = planAndValidate(classification, memory, { userMessage: msg });

    assert.equal(planned.plan.primaryTool, TOOLS.SQL);
    assert.notEqual(planned.plan.strategy, 'follow_up_from_memory');
    assert.notEqual(planned.plan.strategy, 'brsr_narrative_summary');
    assert.notEqual(planned.plan.strategy, 'guidance_templates');
    assert.ok(
      planned.plan.strategy === 'sql_compare_companies'
      || planned.plan.strategy === 'sql_company_metric',
      `got ${planned.plan.strategy}`,
    );
    assert.equal(planned.plan.metric, 'total_emissions');
    assert.ok(planned.plan.entities.length >= 2);
    assert.equal(planned.plan.useRag, false);
    // Prior male_employee_count must not stick
    assert.notEqual(planned.plan.metric, 'male_employee_count');
    // Year preserved from memory when omitted
    assert.ok(
      planned.classification.filters?.years?.[0] === 2024
      || planned.plan.filters?.years?.[0] === 2024,
    );
    assert.equal(planned.validation.ok, true);
    assert.equal(planned.validation.answerType, ANSWER_TYPES.QUANTITATIVE);
  });

  it('router skips RAG for the SQL plan', () => {
    const memory = rankingMemory();
    let classification = classifyIntent(msg, memory);
    classification = applyMemoryToClassification(classification, memory, msg);
    const planned = planAndValidate(classification, memory, { userMessage: msg });
    const route = routeTools(planned.plan, { userMessage: msg, classification: planned.classification });
    assert.equal(route.mode, 'deterministic_sql');
    assert.equal(route.skipRag, true);
  });

  it('reject→replan when narrative plan is forced', () => {
    const memory = rankingMemory();
    const classification = {
      intent: INTENTS.COMPANY_SUMMARY,
      entities: memory.lastCompanies,
      metric: 'total_emissions',
      metricResolution: METRIC_RESOLUTION.FOUND,
      confidence: 0.9,
      filters: {
        metric: 'total_emissions',
        years: [2024],
        metricResolution: METRIC_RESOLUTION.FOUND,
      },
      assumptions: [],
    };
    const narrativePlan = {
      intent: INTENTS.COMPANY_SUMMARY,
      primaryTool: TOOLS.HYBRID,
      strategy: 'brsr_narrative_summary',
      entities: memory.lastCompanies,
      metric: 'total_emissions',
      useRag: true,
      filters: classification.filters,
    };
    const v = validatePlan(narrativePlan, classification, { memory, userMessage: msg });
    assert.equal(v.ok, false);
    const planned = planAndValidate(classification, memory, { userMessage: msg });
    assert.equal(planned.plan.primaryTool, TOOLS.SQL);
    assert.ok(
      planned.plan.strategy === 'sql_compare_companies'
      || planned.plan.strategy === 'sql_company_metric',
    );
  });
});

describe('qualitative still allows narrative', () => {
  it('initiatives stay qualitative', () => {
    const classification = {
      intent: INTENTS.COMPANY_SUMMARY,
      entities: ['Infosys Limited'],
      metric: null,
      metricResolution: METRIC_RESOLUTION.NONE,
      confidence: 0.9,
      filters: {},
    };
    const plan = planQuery(classification);
    const v = validateSemanticPlan(plan, classification, {
      userMessage: 'What climate strategy and initiatives does Infosys describe?',
    });
    assert.equal(v.answerType, ANSWER_TYPES.QUALITATIVE);
    // Not forced to SQL for pure qualitative
    assert.ok(!v.repairs.some((r) => r.type === 'force_sql_quantitative'));
  });
});
