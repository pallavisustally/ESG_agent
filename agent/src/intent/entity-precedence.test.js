/**
 * Entity precedence regressions:
 * validated companies beat raw extraction; garbage never overrides memory.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntent, INTENTS } from './classify-intent.js';
import { refersToPriorCompanies } from './conversation-context.js';
import {
  chooseEntitiesByPrecedence,
  validateCompanyCandidatesSync,
  applyEntityPrecedenceToClassification,
} from './entity-precedence.js';
import { applyMemoryToClassification } from '../memory/conversation-memory.js';
import { planAndValidate } from '../validation/plan-validator.js';
import { routeTools } from '../router/tool-router.js';
import { TOOLS } from '../planner/plan-query.js';

const COMPANY_LIST = [
  'Infosys Limited',
  'Tata Consultancy Services Limited',
  'Asian Paints Limited',
  'Wipro Limited',
  'THE KCP LIMITED',
  'THE ANDHRA SUGARS LIMITED',
];

function trendMemory(overrides = {}) {
  return {
    lastIntent: INTENTS.TREND_ANALYSIS,
    lastCompanies: ['Infosys Limited'],
    lastMetric: 'scope1_emissions',
    lastYear: 2025,
    entities: ['Infosys Limited'],
    ...overrides,
  };
}

function multiMemory() {
  return {
    lastIntent: INTENTS.COMPARE_COMPANIES,
    lastCompanies: ['Infosys Limited', 'Tata Consultancy Services Limited'],
    lastMetric: 'scope1_emissions',
    lastYear: 2024,
    entities: ['Infosys Limited', 'Tata Consultancy Services Limited'],
  };
}

describe('entity precedence: chooseEntitiesByPrecedence', () => {
  it('uses validated message companies over memory', () => {
    const decided = chooseEntitiesByPrecedence({
      validatedCompanies: ['Asian Paints Limited'],
      candidates: ['What are the', 'male employee counts of the above company'],
      userMessage: 'What are Asian Paints female employee counts of the above company?',
      memory: trendMemory(),
    });
    assert.deepEqual(decided.companies, ['Asian Paints Limited']);
    assert.equal(decided.source, 'validated_message');
  });

  it('falls back to memory when validation is empty and message is anaphoric', () => {
    const decided = chooseEntitiesByPrecedence({
      validatedCompanies: [],
      candidates: ['What are the', 'male employee counts of the above company'],
      userMessage: 'What are the female and male employee counts of the above company?',
      memory: trendMemory(),
    });
    assert.deepEqual(decided.companies, ['Infosys Limited']);
    assert.equal(decided.source, 'memory');
  });

  it('clarifies when anaphoric and memory empty', () => {
    const decided = chooseEntitiesByPrecedence({
      validatedCompanies: [],
      candidates: ['What are the'],
      userMessage: 'employee count of the above company',
      memory: { lastCompanies: [] },
    });
    assert.deepEqual(decided.companies, []);
    assert.equal(decided.needsClarification, true);
  });

  it('never keeps unvalidated garbage on anaphoric turns (validatedCompanies=null)', () => {
    const decided = chooseEntitiesByPrecedence({
      validatedCompanies: null,
      candidates: ['What are the', 'male employee counts of the above company'],
      userMessage: 'What are the female and male employee counts of the above company?',
      memory: trendMemory(),
    });
    assert.deepEqual(decided.companies, ['Infosys Limited']);
    assert.equal(decided.source, 'memory');
  });
});

describe('entity precedence: validateCompanyCandidatesSync', () => {
  it('rejects invalid extracted phrases', () => {
    const valid = validateCompanyCandidatesSync(
      ['What are the', 'male employee counts of the above company', 'female and male'],
      COMPANY_LIST,
    );
    assert.deepEqual(valid, []);
  });

  it('accepts real company names', () => {
    const valid = validateCompanyCandidatesSync(
      ['Infosys Limited', 'What are the'],
      COMPANY_LIST,
    );
    assert.deepEqual(valid, ['Infosys Limited']);
  });
});

describe('entity precedence: anaphora detection', () => {
  const cases = [
    'above company',
    'those companies',
    'same company',
    'their emissions',
    'the above company',
    'previous company',
  ];
  for (const phrase of cases) {
    it(`detects "${phrase}"`, () => {
      assert.equal(refersToPriorCompanies(`What about ${phrase}?`), true);
    });
  }
});

describe('entity precedence: classifyIntent after trend analysis', () => {
  const followUps = [
    'What are the female and male employee counts of the above company?',
    'male employees in those companies',
    'scope 1 for the same company',
    'what are their emissions',
    'female employee count of above company',
  ];

  for (const msg of followUps) {
    it(`resolves Infosys from memory for: ${msg}`, () => {
      const memory = msg.includes('those companies') ? multiMemory() : trendMemory();
      const c = classifyIntent(msg, memory);
      assert.ok(
        c.entities.includes('Infosys Limited'),
        `expected Infosys in ${JSON.stringify(c.entities)} for "${msg}"`,
      );
      assert.ok(
        !c.entities.some((e) => /what are|employee counts of|male employee/i.test(e)),
        `garbage entities leaked: ${JSON.stringify(c.entities)}`,
      );
      assert.notEqual(c.filters?.needsPriorCompanies, true);
    });
  }

  it('does not let garbage extraction override memory even when candidates are non-empty', () => {
    const msg = 'What are the female and male employee counts of the above company?';
    const c = classifyIntent(msg, trendMemory());
    assert.deepEqual(c.entities, ['Infosys Limited']);
    assert.equal(c.intent, INTENTS.METRIC_LOOKUP);
    assert.equal(c.filters?.followUpCompanies, true);
  });

  it('with validatedCompanies empty array still uses memory on anaphora', () => {
    const msg = 'employee counts of the above company';
    const c = classifyIntent(msg, trendMemory(), { validatedCompanies: [] });
    assert.deepEqual(c.entities, ['Infosys Limited']);
  });

  it('with validatedCompanies from message prefers those over memory', () => {
    const msg = 'Asian Paints Limited female employee count vs the above company';
    const c = classifyIntent(msg, trendMemory(), {
      validatedCompanies: ['Asian Paints Limited'],
    });
    assert.deepEqual(c.entities, ['Asian Paints Limited']);
  });
});

describe('entity precedence: applyMemory + plan route', () => {
  it('applyMemoryToClassification replaces garbage with Infosys on above-company follow-up', () => {
    const msg = 'What are the female and male employee counts of the above company?';
    let classification = classifyIntent(msg, trendMemory());
    // Simulate a bad upstream that still had garbage (should not happen after classify fix).
    classification = {
      ...classification,
      entities: ['What are the', 'male employee counts of the above company'],
      filters: { ...classification.filters, followUpCompanies: true },
    };
    const merged = applyMemoryToClassification(classification, trendMemory(), msg);
    assert.deepEqual(merged.entities, ['Infosys Limited']);
  });

  it('plans SQL metric lookup for Infosys after trend follow-up', () => {
    const msg = 'What are the female and male employee counts of the above company?';
    const memory = trendMemory();
    const classification = classifyIntent(msg, memory);
    const { plan } = planAndValidate(classification, memory, { userMessage: msg });
    const route = routeTools(plan);
    assert.ok(
      plan.entities.includes('Infosys Limited'),
      `plan entities: ${JSON.stringify(plan.entities)}`,
    );
    assert.ok(
      plan.primaryTool === TOOLS.SQL || plan.strategy === 'sql_company_metric' || plan.strategy === 'sql_compare_companies',
      `unexpected plan ${plan.primaryTool}/${plan.strategy}`,
    );
    assert.equal(route.mode, 'deterministic_sql');
  });
});

describe('entity precedence: applyEntityPrecedenceToClassification', () => {
  it('rewrites COMPARE with single memory company to METRIC_LOOKUP', () => {
    const out = applyEntityPrecedenceToClassification(
      {
        intent: INTENTS.COMPARE_COMPANIES,
        canonicalIntent: 'COMPARE',
        entities: ['What are the', 'male employee counts of the above company'],
        assumptions: [],
        filters: {},
      },
      {
        validatedCompanies: [],
        candidates: ['What are the', 'male employee counts of the above company'],
        userMessage: 'counts of the above company',
        memory: trendMemory(),
      },
    );
    assert.deepEqual(out.entities, ['Infosys Limited']);
    assert.equal(out.intent, INTENTS.METRIC_LOOKUP);
  });
});
