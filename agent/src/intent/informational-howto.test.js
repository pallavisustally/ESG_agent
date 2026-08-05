/**
 * INFORMATIONAL + HOW_TO intent routing — never SQL.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyIntent,
  isGuidanceQuestion,
  isInformationalQuestion,
  INTENTS,
} from '../intent/classify-intent.js';
import { planAndValidate } from '../validation/plan-validator.js';
import { routeTools } from '../router/tool-router.js';
import { detectAnswerType, ANSWER_TYPES } from '../validation/semantic-plan.js';
import { TOOLS } from '../planner/plan-query.js';
import { buildInformationalAnswer } from '../answers/informational.js';

describe('informational vs how-to vs metric lookup', () => {
  const informational = [
    'What are carbon emissions?',
    'What is carbon emission?',
    'Explain Scope 1.',
    'What is ESG?',
    'What is BRSR?',
    'Define Scope 2 emissions',
    'What is a metric?',
    'What is metric?',
    'Meaning of intensity',
  ];

  for (const msg of informational) {
    it(`INFORMATIONAL (no SQL): ${msg}`, () => {
      assert.equal(isInformationalQuestion(msg, []), true);
      const c = classifyIntent(msg);
      assert.equal(c.intent, INTENTS.INFORMATIONAL);
      const planned = planAndValidate(c, null, { userMessage: msg });
      assert.equal(planned.plan.primaryTool, TOOLS.RAG);
      assert.equal(planned.plan.strategy, 'informational_definition');
      assert.notEqual(planned.plan.strategy, 'sql_company_metric');
      assert.notEqual(planned.plan.primaryTool, TOOLS.SQL);
      const route = routeTools(planned.plan, { userMessage: msg, classification: planned.classification });
      assert.equal(route.mode, 'rag');
      assert.equal(detectAnswerType(msg, { classification: c }).answerType, ANSWER_TYPES.INFORMATIONAL);
    });
  }

  const howTo = [
    'How can I reduce carbon emissions in my company?',
    'How can I reduce emissions?',
    'How to improve ESG score?',
    'How to reduce water consumption?',
    'How can companies control Scope 1?',
  ];

  for (const msg of howTo) {
    it(`HOW_TO (no SQL): ${msg}`, () => {
      assert.equal(isGuidanceQuestion(msg), true);
      const c = classifyIntent(msg);
      assert.equal(c.intent, INTENTS.HOW_TO);
      const planned = planAndValidate(c, null, { userMessage: msg });
      assert.equal(planned.plan.strategy, 'guidance_templates');
      assert.notEqual(planned.plan.primaryTool, TOOLS.SQL);
      assert.notEqual(planned.plan.strategy, 'sql_rank_metric');
    });
  }

  it('company metric lookup still uses SQL', () => {
    const msg = 'What are the carbon emissions of Infosys?';
    assert.equal(isInformationalQuestion(msg, ['Infosys']), false);
    const c = classifyIntent(msg);
    assert.equal(c.intent, INTENTS.METRIC_LOOKUP);
    const planned = planAndValidate(c, null, { userMessage: msg });
    assert.equal(planned.plan.primaryTool, TOOLS.SQL);
    assert.equal(planned.plan.strategy, 'sql_company_metric');
  });

  it('ranking still uses SQL', () => {
    const msg = 'Top 5 companies by Scope 1';
    const c = classifyIntent(msg);
    assert.equal(c.intent, INTENTS.TOP_METRIC);
    const planned = planAndValidate(c, null, { userMessage: msg });
    assert.equal(planned.plan.strategy, 'sql_rank_metric');
  });

  it('informational answer defines carbon emissions', () => {
    const text = buildInformationalAnswer('What are carbon emissions?');
    assert.match(text, /Scope 1/i);
    assert.match(text, /Informational answer/i);
    assert.doesNotMatch(text, /SELECT /i);
  });
});
