/**
 * Capability planner + knowledge/guidance/compliance/document engines.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntent, INTENTS } from '../intent/classify-intent.js';
import {
  planCapabilities,
  isComplianceQuestion,
  isDocumentGenerationQuestion,
  isRecommendationQuestion,
  isKnowledgeQuestion,
  shouldUseCapabilityExecutor,
  isNativeOnlyPlan,
} from './capability-planner.js';
import { CAPABILITIES } from './capabilities.js';
import {
  buildKnowledgeAnswer,
  lookupKnowledge,
  buildUnknownConceptAnswer,
} from './knowledge-engine.js';
import { buildComplianceAnswer } from './compliance-engine.js';
import { buildDocumentDraft } from './document-generation.js';
import { composeCapabilityResults } from './response-composer.js';
import { buildGuidanceAnswer } from './guidance-engine.js';

describe('capability planner — taxonomy routing', () => {
  it('What is ESG? → ESG_KNOWLEDGE', () => {
    const msg = 'What is ESG?';
    const c = classifyIntent(msg);
    const plan = planCapabilities(msg, c);
    assert.ok(plan.capabilities.includes(CAPABILITIES.ESG_KNOWLEDGE));
    assert.equal(plan.multi, false);
    assert.equal(shouldUseCapabilityExecutor(plan), true);
  });

  it('What is Scope 1? → ESG_KNOWLEDGE', () => {
    const msg = 'What is Scope 1?';
    const plan = planCapabilities(msg, classifyIntent(msg));
    assert.deepEqual(plan.capabilities, [CAPABILITIES.ESG_KNOWLEDGE]);
  });

  it('What is biodiversity? → ESG_KNOWLEDGE', () => {
    const msg = 'What is biodiversity?';
    assert.equal(isKnowledgeQuestion(msg, []), true);
    const plan = planCapabilities(msg, classifyIntent(msg));
    assert.ok(plan.capabilities.includes(CAPABILITIES.ESG_KNOWLEDGE));
  });

  it('What is a metric? → INFORMATIONAL + ESG_KNOWLEDGE (no keyword allowlist)', () => {
    const msg = 'What is a metric?';
    assert.equal(isKnowledgeQuestion(msg, []), true);
    const c = classifyIntent(msg);
    assert.equal(c.intent, INTENTS.INFORMATIONAL);
    const plan = planCapabilities(msg, c);
    assert.deepEqual(plan.capabilities, [CAPABILITIES.ESG_KNOWLEDGE]);
    assert.equal(shouldUseCapabilityExecutor(plan), true);
  });

  it('How can I reduce carbon emissions? → ESG_GUIDANCE', () => {
    const msg = 'How can I reduce carbon emissions?';
    const c = classifyIntent(msg);
    assert.equal(c.intent, INTENTS.HOW_TO);
    const plan = planCapabilities(msg, c);
    assert.ok(plan.capabilities.includes(CAPABILITIES.ESG_GUIDANCE));
    assert.equal(shouldUseCapabilityExecutor(plan), true);
  });

  it('How do I improve diversity? → ESG_GUIDANCE', () => {
    const msg = 'How do I improve diversity?';
    const plan = planCapabilities(msg, classifyIntent(msg));
    assert.ok(plan.capabilities.includes(CAPABILITIES.ESG_GUIDANCE));
  });

  it('Infosys Scope 1 emissions → COMPANY_ANALYTICS (native)', () => {
    const msg = 'What are Infosys Scope 1 emissions?';
    const c = classifyIntent(msg);
    const plan = planCapabilities(msg, c);
    assert.ok(plan.capabilities.includes(CAPABILITIES.COMPANY_ANALYTICS));
    assert.equal(isNativeOnlyPlan(plan), true);
    assert.equal(shouldUseCapabilityExecutor(plan), false);
  });

  it('Compare Infosys and TCS → BENCHMARKING (native)', () => {
    const msg = 'Compare Infosys and TCS emissions';
    const c = classifyIntent(msg);
    const plan = planCapabilities(msg, c);
    assert.ok(plan.capabilities.includes(CAPABILITIES.BENCHMARKING));
    assert.equal(shouldUseCapabilityExecutor(plan), false);
  });

  it('Explain BRSR Principle 5 → ESG_COMPLIANCE', () => {
    const msg = 'Explain BRSR Principle 5.';
    assert.equal(isComplianceQuestion(msg), true);
    const plan = planCapabilities(msg, classifyIntent(msg));
    assert.ok(plan.capabilities.includes(CAPABILITIES.ESG_COMPLIANCE));
    assert.equal(shouldUseCapabilityExecutor(plan), true);
  });

  it('What is ISSB? → ESG_COMPLIANCE', () => {
    const msg = 'What is ISSB?';
    assert.equal(isComplianceQuestion(msg), true);
    const plan = planCapabilities(msg, { intent: INTENTS.INFORMATIONAL, entities: [] });
    assert.ok(plan.capabilities.includes(CAPABILITIES.ESG_COMPLIANCE));
  });

  it('What is GRI 305? → ESG_COMPLIANCE', () => {
    const msg = 'What is GRI 305?';
    const plan = planCapabilities(msg, { intent: INTENTS.INFORMATIONAL, entities: [] });
    assert.ok(plan.capabilities.includes(CAPABILITIES.ESG_COMPLIANCE));
  });

  it('Write an ESG policy → DOCUMENT_GENERATION', () => {
    const msg = 'Write an ESG policy.';
    assert.equal(isDocumentGenerationQuestion(msg), true);
    const plan = planCapabilities(msg, { intent: INTENTS.UNKNOWN, entities: [] });
    assert.ok(plan.capabilities.includes(CAPABILITIES.DOCUMENT_GENERATION));
  });

  it('Generate a climate action plan → DOCUMENT_GENERATION', () => {
    const msg = 'Generate a climate action plan.';
    const plan = planCapabilities(msg, { intent: INTENTS.UNKNOWN, entities: [] });
    assert.deepEqual(plan.capabilities, [CAPABILITIES.DOCUMENT_GENERATION]);
  });

  it('Suggest how Infosys can improve ESG score → analytics + recommendation', () => {
    const msg = 'Suggest how Infosys can improve its ESG score.';
    const c = { intent: INTENTS.HOW_TO, entities: ['Infosys'], metric: null, filters: {} };
    assert.equal(isRecommendationQuestion(msg, c), true);
    const plan = planCapabilities(msg, c);
    assert.ok(plan.capabilities.includes(CAPABILITIES.RECOMMENDATION));
    assert.ok(
      plan.capabilities.includes(CAPABILITIES.COMPANY_ANALYTICS)
      || plan.capabilities.includes(CAPABILITIES.ESG_GUIDANCE),
    );
    assert.equal(plan.multi, true);
    assert.equal(shouldUseCapabilityExecutor(plan), true);
  });

  it('Compare + suggest improve → BENCHMARKING + RECOMMENDATION', () => {
    const msg = 'Compare Infosys and TCS emissions and suggest how Infosys can improve.';
    const c = {
      intent: INTENTS.COMPARE_COMPANIES,
      entities: ['Infosys', 'TCS'],
      metric: 'total_emissions',
      filters: {},
    };
    const plan = planCapabilities(msg, c);
    assert.ok(plan.capabilities.includes(CAPABILITIES.BENCHMARKING));
    assert.ok(plan.capabilities.includes(CAPABILITIES.RECOMMENDATION));
    assert.equal(plan.multi, true);
  });
});

describe('knowledge / compliance / document engines', () => {
  it('knowledge answer for Scope 2', () => {
    const text = buildKnowledgeAnswer('What is Scope 2?');
    assert.match(text, /Scope 2/i);
    assert.doesNotMatch(text, /\bSELECT\b/);
  });

  it('knowledge answer for metric', () => {
    const resolved = lookupKnowledge('What is a metric?');
    assert.equal(resolved.known, true);
    const text = buildKnowledgeAnswer('What is a metric?');
    assert.match(text, /metric/i);
    assert.match(text, /measurable indicator/i);
  });

  it('unknown concept returns clarification (not company redirect)', () => {
    const msg = 'What is flibbertigibbet?';
    assert.equal(classifyIntent(msg).intent, INTENTS.INFORMATIONAL);
    const resolved = lookupKnowledge(msg);
    assert.equal(resolved.known, false);
    const text = buildUnknownConceptAnswer(msg);
    assert.match(text, /don.t have a built-in definition/i);
    assert.doesNotMatch(text, /Try rephrasing with a company name/i);
  });

  it('knowledge answer for materiality', () => {
    const text = buildKnowledgeAnswer('What is materiality?');
    assert.match(text, /materiality/i);
  });

  it('compliance answer for BRSR Principle 5', () => {
    const text = buildComplianceAnswer('Explain BRSR Principle 5.');
    assert.match(text, /Principle 5/i);
    assert.match(text, /human rights/i);
  });

  it('compliance answer for CSRD', () => {
    const text = buildComplianceAnswer('What is CSRD?');
    assert.match(text, /CSRD/i);
  });

  it('document draft for ESG policy', () => {
    const text = buildDocumentDraft('Write an ESG policy.');
    assert.match(text, /ESG Policy/i);
    assert.match(text, /Purpose/i);
  });

  it('guidance answer for water', async () => {
    const text = await buildGuidanceAnswer('How can I reduce water consumption?');
    assert.match(text, /water/i);
  });
});

describe('response composer', () => {
  it('returns single result unchanged', () => {
    const out = composeCapabilityResults([
      { capability: CAPABILITIES.ESG_KNOWLEDGE, text: '### ESG\n\nEnvironmental, Social, Governance.' },
    ]);
    assert.match(out.text, /Environmental/);
    assert.equal(out.multi, undefined);
  });

  it('merges analytics + recommendation', () => {
    const out = composeCapabilityResults([
      { capability: CAPABILITIES.COMPANY_ANALYTICS, text: '### Infosys\n\nScope 1: 1000 tCO2e' },
      { capability: CAPABILITIES.RECOMMENDATION, text: '### Recommendations\n\n1. Increase renewables' },
    ]);
    assert.match(out.text, /combined view/i);
    assert.match(out.text, /Scope 1/);
    assert.match(out.text, /Increase renewables/);
    assert.equal(out.multi, true);
  });
});
