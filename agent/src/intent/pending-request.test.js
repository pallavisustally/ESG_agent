/**
 * Regression: pending request + clarification continuation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { INTENTS } from './classify-intent.js';
import { METRIC_RESOLUTION } from './metric-resolution.js';
import {
  buildPendingRequest,
  isClarificationContinuation,
  shouldAbandonPendingRequest,
  resumeClassificationFromPending,
} from './pending-request.js';
import {
  applyMemoryToClassification,
  createEmptyMemory,
  updateMemory,
  clearMemory,
} from '../memory/conversation-memory.js';
import { classifyIntent } from './classify-intent.js';
import { planQuery } from '../planner/plan-query.js';
import {
  isCompanyScopedDocumentFallbackEligible,
  getDocumentFallbackMaxCompanies,
} from '../pipeline/sql-document-fallback.js';

describe('pending request clarification continuation', () => {
  it('builds pending snapshot from unresolved ask', () => {
    const pending = buildPendingRequest({
      userMessage: 'How many male employees are in the above companies?',
      classification: {
        intent: INTENTS.METRIC_LOOKUP,
        metric: 'male_employee_count',
        metricResolution: METRIC_RESOLUTION.FOUND,
        filters: { years: [2025] },
      },
    });
    assert.equal(pending.metric, 'male_employee_count');
    assert.equal(pending.year, 2025);
    assert.match(pending.userMessage, /male employees/);
  });

  it('detects ranking clarification as continuation', () => {
    const pending = buildPendingRequest({
      userMessage: 'How many male employees are in the above companies?',
      classification: {
        intent: INTENTS.METRIC_LOOKUP,
        metric: 'male_employee_count',
        metricResolution: METRIC_RESOLUTION.FOUND,
      },
    });
    const clarification = classifyIntent(
      'Use the top 5 companies with the highest female employee count.',
    );
    assert.equal(
      isClarificationContinuation(
        'Use the top 5 companies with the highest female employee count.',
        clarification,
        pending,
      ),
      true,
    );
  });

  it('resumes pending metric after companies are supplied', () => {
    const pending = buildPendingRequest({
      userMessage: 'How many male employees are in the above companies?',
      classification: {
        intent: INTENTS.COMPARE_COMPANIES,
        metric: 'male_employee_count',
        metricResolution: METRIC_RESOLUTION.FOUND,
        filters: { years: [2025] },
      },
    });
    const resumed = resumeClassificationFromPending(
      {
        intent: INTENTS.TOP_METRIC,
        metric: 'female_employee_share',
        metricResolution: METRIC_RESOLUTION.FOUND,
        entities: [],
        filters: {},
        assumptions: [],
        confidence: 0.9,
      },
      pending,
      {
        companies: ['A Ltd', 'B Ltd', 'C Ltd', 'D Ltd', 'E Ltd'],
      },
    );
    assert.equal(resumed.metric, 'male_employee_count');
    assert.equal(resumed.metricResolution, METRIC_RESOLUTION.FOUND);
    assert.equal(resumed.entities.length, 5);
    assert.equal(resumed.intent, INTENTS.COMPARE_COMPANIES);
    assert.equal(resumed.filters.resumedFromPending, true);
  });

  it('applyMemory attaches pending when clarification provides ranking', () => {
    const key = 'test:pending:1';
    clearMemory(key);
    const pending = buildPendingRequest({
      userMessage: 'How many male employees are in the above companies?',
      classification: {
        intent: INTENTS.METRIC_LOOKUP,
        metric: 'male_employee_count',
        metricResolution: METRIC_RESOLUTION.FOUND,
        filters: { years: [2025] },
      },
    });
    const memory = updateMemory(key, {
      ...createEmptyMemory(),
      pendingRequest: pending,
      lastCompanies: [],
      entities: [],
      lastPageItems: [],
    });
    const msg = 'Use the top 5 companies with the highest female employee share.';
    const classification = classifyIntent(msg, memory);
    const merged = applyMemoryToClassification(classification, memory, msg);
    assert.equal(merged.filters.clarificationProvidesCompanies, true);
    assert.equal(merged.filters.pendingRequest?.metric, 'male_employee_count');
    clearMemory(key);
  });

  it('abandons pending on fully new company+metric ask', () => {
    const pending = buildPendingRequest({
      userMessage: 'male employees above companies?',
      classification: {
        intent: INTENTS.METRIC_LOOKUP,
        metric: 'male_employee_count',
        metricResolution: METRIC_RESOLUTION.FOUND,
      },
    });
    const classification = {
      intent: INTENTS.METRIC_LOOKUP,
      entities: ['Infosys Limited'],
      metric: 'scope1_emissions',
      metricResolution: METRIC_RESOLUTION.FOUND,
      filters: {},
    };
    assert.equal(
      shouldAbandonPendingRequest(
        'What is Infosys Scope 1 in 2025?',
        classification,
        pending,
      ),
      true,
    );
  });
});

describe('plan always new + pagination without lastPlan', () => {
  it('pagination uses memory page fields not lastPlan SQL', () => {
    const memory = {
      lastIntent: INTENTS.LIST_ALL_COMPANIES,
      lastList: { type: 'companies' },
      awaitingMore: true,
      page: 1,
      pageSize: 100,
      filters: {},
      lastPlan: null,
    };
    const plan = planQuery(
      { intent: INTENTS.PAGINATE_CONTINUE, entities: [], filters: { pageDelta: 1 }, confidence: 0.9 },
      memory,
    );
    assert.equal(plan.strategy, 'sql_list_all_paginated');
    assert.equal(plan.page, 2);
    assert.equal(plan.pageSize, 100);
  });
});

describe('document fallback config aliases', () => {
  const prevA = process.env.SQL_DOCUMENT_FALLBACK_MAX_COMPANIES;
  const prevB = process.env.MAX_DOCUMENT_FALLBACK_COMPANIES;

  it('accepts MAX_DOCUMENT_FALLBACK_COMPANIES alias', () => {
    delete process.env.SQL_DOCUMENT_FALLBACK_MAX_COMPANIES;
    process.env.MAX_DOCUMENT_FALLBACK_COMPANIES = '4';
    assert.equal(getDocumentFallbackMaxCompanies(), 4);
    if (prevA === undefined) delete process.env.SQL_DOCUMENT_FALLBACK_MAX_COMPANIES;
    else process.env.SQL_DOCUMENT_FALLBACK_MAX_COMPANIES = prevA;
    if (prevB === undefined) delete process.env.MAX_DOCUMENT_FALLBACK_COMPANIES;
    else process.env.MAX_DOCUMENT_FALLBACK_COMPANIES = prevB;
  });

  it('allows unsupported COMPARE for company-scoped fallback', () => {
    process.env.SQL_DOCUMENT_FALLBACK = 'true';
    assert.equal(
      isCompanyScopedDocumentFallbackEligible({
        classification: {
          intent: INTENTS.COMPARE_COMPANIES,
          metricResolution: METRIC_RESOLUTION.UNSUPPORTED,
          filters: { unsupportedMetric: true },
        },
        companies: ['A', 'B'],
        userMessage: 'plastic footprint for the above companies',
      }),
      true,
    );
  });

  it('still blocks Top-N from PDF fallback', () => {
    process.env.SQL_DOCUMENT_FALLBACK = 'true';
    assert.equal(
      isCompanyScopedDocumentFallbackEligible({
        classification: {
          intent: INTENTS.TOP_METRIC,
          metric: 'scope1_emissions',
        },
        companies: ['A'],
        userMessage: 'top 5 scope 1',
      }),
      false,
    );
  });
});
