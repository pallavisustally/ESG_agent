/**
 * Execution Orchestrator + engine wrapper tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntent } from '../intent/classify-intent.js';
import {
  planExecution,
  executeExecutionPlan,
  createEngineResponse,
  mergeEngineResponses,
  toolPlanFromExecutionPlan,
  runKnowledgeEngine,
  runComplianceEngine,
  runGuidanceEngine,
  runDocumentEngine,
} from './index.js';

describe('engine response contract', () => {
  it('creates and merges standard responses', () => {
    const a = createEngineResponse({
      engine: 'knowledge',
      ok: true,
      text: '### ESG\n\nDefined.',
      confidence: 0.9,
      citations: ['https://example.com'],
    });
    const b = createEngineResponse({
      engine: 'guidance',
      ok: true,
      text: '### Tips\n\n1. Reduce emissions',
      confidence: 0.8,
    });
    const merged = mergeEngineResponses([a, b]);
    assert.equal(merged.ok, true);
    assert.equal(merged.citations.length, 1);
    assert.ok(merged.confidence > 0);
  });
});

describe('toolPlanFromExecutionPlan', () => {
  it('synthesizes SQL rank plan for TOP_METRIC', () => {
    const classification = classifyIntent('Top 5 companies by Scope 1 emissions');
    const { plan } = planExecution({ userMessage: 'Top 5 companies by Scope 1 emissions', classification });
    const toolPlan = toolPlanFromExecutionPlan(plan, classification);
    assert.equal(toolPlan.primaryTool, 'SQL');
    assert.match(toolPlan.strategy, /sql_/);
  });
});

describe('engine wrappers (no SQL)', () => {
  it('knowledge engine answers ESG', async () => {
    const classification = classifyIntent('What is ESG?');
    const { plan } = planExecution({ userMessage: 'What is ESG?', classification });
    const out = await runKnowledgeEngine({
      executionPlan: plan,
      userMessage: 'What is ESG?',
      classification,
    });
    assert.equal(out.ok, true);
    assert.match(out.text, /ESG|Environmental/i);
  });

  it('knowledge engine answers EID', async () => {
    const out = await runKnowledgeEngine({
      executionPlan: { needsKnowledge: true },
      userMessage: 'What is EID?',
      force: true,
    });
    assert.equal(out.ok, true);
    assert.match(out.text, /Essential Indicators|EID|BRSR/i);
  });

  it('compliance engine answers CDP', async () => {
    const out = await runComplianceEngine({
      executionPlan: { needsCompliance: true },
      userMessage: 'What is CDP?',
      force: true,
    });
    assert.match(out.text, /CDP/i);
  });

  it('compliance engine answers SFDR', async () => {
    const out = await runComplianceEngine({
      executionPlan: { needsCompliance: true },
      userMessage: 'Explain SFDR',
      force: true,
    });
    assert.match(out.text, /SFDR/i);
  });

  it('guidance engine covers circular economy', async () => {
    const out = await runGuidanceEngine({
      executionPlan: { needsGuidance: true },
      userMessage: 'How can I advance circular economy practices?',
      force: true,
    });
    assert.match(out.text, /circular/i);
  });

  it('document engine drafts ESG policy', async () => {
    const classification = classifyIntent('Generate an ESG policy');
    const { plan } = planExecution({ userMessage: 'Generate an ESG policy', classification });
    const out = await runDocumentEngine({
      executionPlan: plan,
      userMessage: 'Generate an ESG policy',
      classification,
    });
    assert.equal(out.ok, true);
    assert.match(out.text, /policy|ESG/i);
  });
});

describe('executeExecutionPlan orchestration', () => {
  it('orchestrates knowledge without SQL', async () => {
    const msg = 'What is Scope 1?';
    const classification = classifyIntent(msg);
    const { plan } = planExecution({ userMessage: msg, classification });
    const result = await executeExecutionPlan({
      executionPlan: plan,
      userMessage: msg,
      classification,
      memory: null,
    });
    assert.equal(result.handled, true);
    assert.match(result.text, /Scope\s*1/i);
    assert.equal(result.forbidLlmFallback, true);
    assert.ok(result.responseValidation?.verdict);
    assert.notEqual(result.responseValidation.verdict, 'ERROR');
    assert.ok(result.engineTrace);
    assert.ok(result.engineTrace.ran.includes('knowledge'));
    assert.ok(result.engineTrace.order.some((r) => r.engine === 'knowledge' && r.durationMs >= 0));
    assert.ok(result.latencyBreakdown);
    assert.equal(result.composition?.path, 'capability_composer');
  });

  it('orchestrates guidance', async () => {
    const msg = 'How can I reduce water consumption?';
    const classification = classifyIntent(msg);
    const { plan } = planExecution({ userMessage: msg, classification });
    const result = await executeExecutionPlan({
      executionPlan: plan,
      userMessage: msg,
      classification,
    });
    assert.equal(result.handled, true);
    assert.match(result.text, /water/i);
  });

  it('orchestrates compliance', async () => {
    const msg = 'Explain GRI 305';
    const classification = classifyIntent(msg);
    const { plan } = planExecution({ userMessage: msg, classification });
    const result = await executeExecutionPlan({
      executionPlan: plan,
      userMessage: msg,
      classification,
    });
    assert.equal(result.handled, true);
    assert.match(result.text, /GRI\s*305|Emissions/i);
  });

  it('returns clarification when needed', async () => {
    const result = await executeExecutionPlan({
      executionPlan: {
        needsClarification: true,
        clarification: 'Which company?',
        requiredEngines: [],
        capabilities: [],
      },
      userMessage: 'their emissions',
      classification: {},
    });
    assert.equal(result.handled, true);
    assert.match(result.text, /company/i);
  });
});
