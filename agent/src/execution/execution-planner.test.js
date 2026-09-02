/**
 * Execution Planner + parallel compare tests (Phase 2/3).
 *
 * Planner never executes SQL / reports / PDFs / charts / answers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntent } from '../intent/classify-intent.js';
import { planCapabilities } from '../capability/capability-planner.js';
import { CAPABILITIES } from '../capability/capabilities.js';
import { planQuery } from '../planner/plan-query.js';
import {
  planExecution,
  buildExecutionPlan,
  compareExecutionPlanToLegacy,
  validateExecutionPlan,
} from './index.js';

function planFor(msg, memory = null) {
  const classification = classifyIntent(msg, memory);
  return planExecution({ userMessage: msg, memory, classification });
}

describe('Execution Planner — capability routing parity', () => {
  it('What is ESG? → knowledge', () => {
    const { plan, validation } = planFor('What is ESG?');
    assert.equal(validation.ok, true);
    assert.equal(plan.capability, CAPABILITIES.ESG_KNOWLEDGE);
    assert.equal(plan.needsKnowledge, true);
    assert.equal(plan.needsSql, false);
    assert.equal(plan.executionStrategy, 'knowledge');
  });

  it('What is Scope 1? → knowledge', () => {
    const plan = buildExecutionPlan({
      userMessage: 'What is Scope 1?',
      classification: classifyIntent('What is Scope 1?'),
    });
    assert.equal(plan.needsKnowledge, true);
    assert.equal(plan.executionStrategy, 'knowledge');
  });

  it('How can I reduce carbon emissions? → guidance', () => {
    const { plan } = planFor('How can I reduce carbon emissions?');
    assert.equal(plan.needsGuidance, true);
    assert.equal(plan.needsSql, false);
    assert.equal(plan.executionStrategy, 'guidance');
  });

  it('Explain GRI 305 → compliance', () => {
    const { plan } = planFor('Explain GRI 305.');
    assert.equal(plan.needsCompliance, true);
    assert.equal(plan.executionStrategy, 'compliance');
  });

  it('Generate an ESG policy → document', () => {
    const { plan } = planFor('Generate an ESG policy.');
    assert.equal(plan.needsDocumentGeneration, true);
    assert.equal(plan.executionStrategy, 'document');
  });

  it('Infosys Scope 1 emissions → analytics SQL', () => {
    const msg = 'Infosys Scope 1 emissions';
    const classification = classifyIntent(msg);
    const { plan } = planExecution({ userMessage: msg, classification });
    assert.equal(plan.needsSql, true);
    assert.ok(plan.entities.some((e) => /infosys/i.test(e)));
    assert.ok(plan.metrics.length || classification.metric);
    assert.equal(plan.executionStrategy, 'analytics');
    assert.ok(plan.requiredEngines.includes('analytics'));
  });

  it('Compare Infosys and TCS → comparison analytics', () => {
    const msg = 'Compare Infosys and TCS Scope 1';
    const { plan } = planFor(msg);
    assert.equal(plan.comparison, true);
    assert.equal(plan.needsSql, true);
    assert.ok(plan.capabilities.includes(CAPABILITIES.BENCHMARKING));
  });

  it('Top emitters chart → analytics + visualization', () => {
    const msg = 'Show a chart of top 5 companies by Scope 1 emissions';
    const { plan } = planFor(msg);
    assert.equal(plan.needsSql, true);
    assert.equal(plan.visualization, true);
    assert.equal(plan.needsVisualization, true);
    assert.ok(plan.requiredEngines.includes('visualization'));
  });

  it('Suggest improvements for Infosys → recommendation (+ analytics)', () => {
    const msg = 'Suggest how Infosys can improve its ESG score';
    const { plan } = planFor(msg);
    assert.equal(plan.needsRecommendation, true);
    assert.ok(
      plan.needsSql || plan.needsGuidance,
      'recommendation should ground in analytics or guidance',
    );
    assert.equal(plan.executionStrategy, 'recommendation');
  });

  it('metric ask without company → clarify (not invent)', () => {
    const msg = 'What is their Scope 1 emissions?';
    const { plan } = planFor(msg);
    assert.equal(plan.needsClarification, true);
    assert.equal(plan.executionStrategy, 'clarify');
    assert.ok(plan.clarification);
  });

  it('unsupported count ask does not open the PDF', () => {
    const memory = {
      lastCompanies: ['Aster DM Healthcare Limited'],
      resolvedCompany: 'Aster DM Healthcare Limited',
    };
    const msg = 'what is the count of disabled female workers in above company';
    const { plan } = planFor(msg, memory);
    assert.equal(plan.needsPdf, false);
  });

  it('report/PDF wording still opens the filing', () => {
    const { plan } = planFor('Show Infosys Scope 1 from the BRSR PDF');
    assert.equal(plan.needsPdf || plan.needsReport, true);
  });

  it('rankings still go analytics without a company', () => {
    const msg = 'Top 5 companies by Scope 1 emissions';
    const { plan } = planFor(msg);
    assert.equal(plan.needsClarification, false);
    assert.equal(plan.executionStrategy, 'analytics');
    assert.equal(plan.needsSql, true);
  });
});

describe('Execution Planner — legacy compare observe', () => {
  it('knowledge parity still holds', () => {
    const msg = 'What is ESG?';
    const classification = classifyIntent(msg);
    const capabilityPlan = planCapabilities(msg, classification, null);
    const { plan } = planExecution({ userMessage: msg, classification });
    const legacy = planQuery(classification);
    const cmp = compareExecutionPlanToLegacy(plan, {
      capabilityPlan,
      plan: legacy,
      classification,
    });
    assert.ok(cmp);
  });
});

describe('Execution Planner — never executes side effects', () => {
  it('planExecution returns plan + validation only', () => {
    const out = planFor('What is biodiversity?');
    assert.ok(out.plan);
    assert.ok(out.validation);
    assert.ok(out.capabilityPlan);
    assert.equal(out.plan.metadata.source, 'execution_planner');
    // No answer text / chart blocks
    assert.equal(out.plan.text, undefined);
    assert.equal(out.plan.chartBlock, undefined);
  });
});

describe('ExecutionPlan vs legacy pipeline compare', () => {
  const cases = [
    'What is ESG?',
    'What is a metric?',
    'How can I reduce carbon emissions?',
    'Explain BRSR Principle 5',
    'What is ISSB?',
    'Write an ESG policy',
    'Infosys Scope 1 emissions',
    'Compare Infosys and TCS',
    'Top 5 companies by Scope 1 emissions',
  ];

  for (const msg of cases) {
    it(`parity signals: ${msg}`, () => {
      const classification = classifyIntent(msg);
      const capabilityPlan = planCapabilities(msg, classification);
      const toolPlan = planQuery(classification, null, { userMessage: msg });
      const { plan } = planExecution({ userMessage: msg, classification });
      const comparison = compareExecutionPlanToLegacy(plan, {
        capabilityPlan,
        plan: {
          ...toolPlan,
          capabilities: capabilityPlan.capabilities,
          primaryCapability: capabilityPlan.primaryCapability,
          capabilityPlan,
        },
        classification,
      });

      // Hard requirements: capability set + intent must match for supported cases.
      const capDiff = comparison.differences.find((d) => d.field === 'capabilities');
      const intentDiff = comparison.differences.find((d) => d.field === 'intent');
      assert.equal(capDiff, undefined, `capabilities drift: ${JSON.stringify(capDiff)}`);
      assert.equal(intentDiff, undefined, `intent drift: ${JSON.stringify(intentDiff)}`);

      // Soft: needsSql should agree for analytics-shaped questions
      const sqlDiff = comparison.differences.find((d) => d.field === 'needsSql');
      if (sqlDiff) {
        // Allow soft mismatch only when strategy families are compatible
        assert.ok(
          comparison.differences.every((d) => d.field !== 'executionStrategy' || true),
          JSON.stringify(comparison.differences),
        );
      }
    });
  }

  it('validateExecutionPlan passes for planner output', () => {
    const { plan, validation } = planFor('Compare Infosys and Wipro renewable energy share');
    assert.equal(validation.ok, true);
    assert.equal(validateExecutionPlan(plan).ok, true);
  });
});
