/**
 * Regression tests: SQL → Narrative → PDF document fallback path.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { INTENTS } from '../intent/classify-intent.js';
import { METRIC_RESOLUTION } from '../intent/metric-resolution.js';
import { rankPdfPageTexts } from '../page-index.js';
import {
  isSqlDocumentFallbackEnabled,
  isCompanyScopedDocumentFallbackEligible,
  getDocumentFallbackMaxCompanies,
  DOCUMENT_FALLBACK_BLOCKED_INTENTS,
  companyMetricUnavailableResponse,
  resolveFallbackCompanies,
  tryCompanyDocumentFallback,
  runSqlDocumentFallback,
} from './sql-document-fallback.js';

describe('sql-document-fallback config', () => {
  const prevFlag = process.env.SQL_DOCUMENT_FALLBACK;
  const prevMax = process.env.SQL_DOCUMENT_FALLBACK_MAX_COMPANIES;

  afterEach(() => {
    if (prevFlag === undefined) delete process.env.SQL_DOCUMENT_FALLBACK;
    else process.env.SQL_DOCUMENT_FALLBACK = prevFlag;
    if (prevMax === undefined) delete process.env.SQL_DOCUMENT_FALLBACK_MAX_COMPANIES;
    else process.env.SQL_DOCUMENT_FALLBACK_MAX_COMPANIES = prevMax;
  });

  it('feature flag defaults to enabled', () => {
    delete process.env.SQL_DOCUMENT_FALLBACK;
    assert.equal(isSqlDocumentFallbackEnabled(), true);
  });

  it('feature flag can be disabled', () => {
    process.env.SQL_DOCUMENT_FALLBACK = 'false';
    assert.equal(isSqlDocumentFallbackEnabled(), false);
    assert.equal(
      isCompanyScopedDocumentFallbackEligible({
        classification: {
          intent: INTENTS.METRIC_LOOKUP,
          metric: 'scope1_emissions',
          metricResolution: METRIC_RESOLUTION.FOUND,
        },
        companies: ['Infosys Limited'],
        userMessage: 'Scope 1 for Infosys',
      }),
      false,
    );
  });

  it('max companies defaults to 3 and is configurable', () => {
    delete process.env.SQL_DOCUMENT_FALLBACK_MAX_COMPANIES;
    assert.equal(getDocumentFallbackMaxCompanies(), 3);

    process.env.SQL_DOCUMENT_FALLBACK_MAX_COMPANIES = '5';
    assert.equal(getDocumentFallbackMaxCompanies(), 5);

    process.env.SQL_DOCUMENT_FALLBACK_MAX_COMPANIES = '99';
    assert.equal(getDocumentFallbackMaxCompanies(), 20);

    process.env.SQL_DOCUMENT_FALLBACK_MAX_COMPANIES = '0';
    assert.equal(getDocumentFallbackMaxCompanies(), 3);
  });

  it('resolveFallbackCompanies respects configured max', () => {
    process.env.SQL_DOCUMENT_FALLBACK_MAX_COMPANIES = '2';
    const companies = resolveFallbackCompanies({
      entities: ['A Ltd', 'B Ltd', 'C Ltd'],
    });
    assert.deepEqual(companies, ['A Ltd', 'B Ltd']);
  });

  it('allows company metric lookup', () => {
    process.env.SQL_DOCUMENT_FALLBACK = 'true';
    assert.equal(
      isCompanyScopedDocumentFallbackEligible({
        classification: {
          intent: INTENTS.METRIC_LOOKUP,
          metric: 'plastic_footprint',
          metricResolution: METRIC_RESOLUTION.UNSUPPORTED,
        },
        companies: ['Infosys Limited'],
        userMessage: 'plastic footprint of Infosys',
      }),
      true,
    );
  });

  it('blocks rankings and aggregates', () => {
    process.env.SQL_DOCUMENT_FALLBACK = 'true';
    for (const intent of DOCUMENT_FALLBACK_BLOCKED_INTENTS) {
      assert.equal(
        isCompanyScopedDocumentFallbackEligible({
          classification: { intent, metric: 'scope1_emissions' },
          companies: ['Infosys Limited'],
          userMessage: 'top companies',
        }),
        false,
        `should block ${intent}`,
      );
    }
  });

  it('blocks when company count exceeds configured max', () => {
    process.env.SQL_DOCUMENT_FALLBACK = 'true';
    process.env.SQL_DOCUMENT_FALLBACK_MAX_COMPANIES = '3';
    assert.equal(
      isCompanyScopedDocumentFallbackEligible({
        classification: {
          intent: INTENTS.METRIC_LOOKUP,
          metric: 'scope1_emissions',
        },
        companies: ['A', 'B', 'C', 'D'],
        userMessage: 'scope 1',
      }),
      false,
    );
  });

  it('unavailable message is company-scoped', () => {
    assert.match(
      companyMetricUnavailableResponse('Infosys Limited', 2025),
      /Infosys Limited/,
    );
  });
});

describe('searchPdfPagesForQuery full-PDF scan', () => {
  it('rankPdfPageTexts scans every extracted page, not metric_pages_json', () => {
    const pages = [
      'Cover page registered office scrip code', // early-page penalty
      'Unrelated governance text about policies',
      'Essential indicators Scope 1 emissions and GHG inventory for the year',
      'Appendix footnotes only',
      'Plastic waste and circular economy initiatives disclosed in BRSR',
    ];

    const result = rankPdfPageTexts(pages, {
      query: 'plastic footprint waste',
      metric: null,
      limit: 5,
      minScore: 4,
    });

    assert.equal(result.scannedAllPages, true);
    assert.equal(result.totalPages, pages.length, 'must consider full extracted page array');
    assert.ok(result.hits.length >= 1);
    // Hit should prefer the plastic page (page 5), proving late pages are searched.
    assert.equal(result.hits[0].page, 5);
    assert.match(result.hits[0].snippet, /Plastic waste/i);
  });

  it('ranks scope metric context on any page index', () => {
    const pages = Array.from({ length: 12 }, (_, i) => `filler page ${i + 1}`);
    pages[10] = 'Scope 1 direct GHG emission totals for manufacturing sites';

    const result = rankPdfPageTexts(pages, {
      query: 'Scope 1 emissions',
      metric: 'scope1_emissions',
      limit: 2,
      minScore: 8,
    });

    assert.equal(result.totalPages, 12);
    assert.equal(result.scannedAllPages, true);
    assert.equal(result.hits[0].page, 11);
  });
});

describe('SQL → Narrative → PDF fallback regression', () => {
  const prevFlag = process.env.SQL_DOCUMENT_FALLBACK;

  afterEach(() => {
    if (prevFlag === undefined) delete process.env.SQL_DOCUMENT_FALLBACK;
    else process.env.SQL_DOCUMENT_FALLBACK = prevFlag;
  });

  function baseDeps(overrides = {}) {
    return {
      resolveCompany: async (hint) => ({ status: 'resolved', company: 'Infosys Limited', query: hint }),
      listCompanies: async () => ['Infosys Limited'],
      retrieveNarrative: async () => ({ status: 'ok', company: 'Infosys Limited', year: 2025, chunks: [], pdf_url: null }),
      getSourceRow: async () => ({
        company: 'Infosys Limited',
        year: 2025,
        filename: 'INFY.pdf',
        pdf_url: 'https://nsearchives.nseindia.com/corporate/example.pdf',
      }),
      resolvePdfUrl: () => 'https://nsearchives.nseindia.com/corporate/example.pdf',
      searchPdf: async () => ({ hits: [], unavailable: false, totalPages: 0, scannedAllPages: true }),
      validateEvidence: () => ({ ok: true, errors: [], warnings: [] }),
      formatNarrative: ({ company, chunks }) => `narrative:${company}:${chunks.length}`,
      ...overrides,
    };
  }

  it('returns narrative answer when SQL miss has company-scoped chunks (stops before PDF)', async () => {
    const calls = { narrative: 0, pdf: 0 };
    const result = await tryCompanyDocumentFallback({
      companyHint: 'Infosys',
      year: 2025,
      query: 'plastic footprint',
      metric: null,
      deps: baseDeps({
        retrieveNarrative: async () => {
          calls.narrative += 1;
          return {
            status: 'ok',
            company: 'Infosys Limited',
            year: 2025,
            pdf_url: 'https://example.com/infy.pdf',
            chunks: [{
              company: 'Infosys Limited',
              year: 2025,
              section: 'waste',
              text: 'Plastic reduction and circular packaging initiatives across campuses.',
              source: 'data_json',
            }],
          };
        },
        searchPdf: async () => {
          calls.pdf += 1;
          return { hits: [{ page: 9, snippet: 'should not run' }], scannedAllPages: true };
        },
      }),
    });

    assert.equal(result.ok, true);
    assert.equal(result.source, 'narrative');
    assert.equal(calls.narrative, 1);
    assert.equal(calls.pdf, 0, 'PDF must not run when narrative evidence exists');
    assert.match(result.text, /narrative:Infosys Limited:1/);
  });

  it('falls through to full-PDF search when narrative is empty', async () => {
    const calls = { pdf: 0 };
    const result = await tryCompanyDocumentFallback({
      companyHint: 'Infosys',
      year: 2025,
      query: 'plastic footprint of Infosys',
      metric: null,
      deps: baseDeps({
        retrieveNarrative: async () => ({
          status: 'ok',
          company: 'Infosys Limited',
          year: 2025,
          chunks: [],
          pdf_url: null,
        }),
        searchPdf: async (url, opts) => {
          calls.pdf += 1;
          assert.match(url, /\.pdf$/i);
          assert.ok(opts.query);
          return {
            hits: [{ page: 42, score: 20, snippet: 'Plastic footprint disclosure in BRSR core.' }],
            unavailable: false,
            totalPages: 120,
            scannedAllPages: true,
          };
        },
      }),
    });

    assert.equal(result.ok, true);
    assert.equal(result.source, 'pdf');
    assert.equal(calls.pdf, 1);
    assert.equal(result.data.scannedAllPages, true);
    assert.match(result.text, /Page 42/);
    assert.match(result.text, /Plastic footprint disclosure/);
    assert.match(result.text, /#page=42/);
  });

  it('returns company-scoped unavailable when narrative and PDF both miss', async () => {
    const result = await tryCompanyDocumentFallback({
      companyHint: 'Infosys',
      year: 2025,
      query: 'ocean pollution',
      deps: baseDeps({
        searchPdf: async () => ({
          hits: [],
          unavailable: false,
          totalPages: 80,
          scannedAllPages: true,
        }),
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_found');
    assert.match(result.text, /not available in this company's BRSR report/);
    assert.match(result.text, /Infosys Limited/);
  });

  it('runSqlDocumentFallback wires SQL miss → narrative → PDF for METRIC_LOOKUP', async () => {
    process.env.SQL_DOCUMENT_FALLBACK = 'true';
    const order = [];
    const result = await runSqlDocumentFallback({
      classification: {
        intent: INTENTS.METRIC_LOOKUP,
        entities: ['Infosys Limited'],
        metricResolution: METRIC_RESOLUTION.UNSUPPORTED,
        filters: { years: [2025], unsupportedMetric: true },
      },
      plan: { intent: INTENTS.METRIC_LOOKUP, strategy: 'unsupported_metric', metric: null },
      sqlData: { resolvedCompany: 'Infosys Limited', year: 2025 },
      userMessage: 'What is the plastic footprint of Infosys in 2025?',
      returnUnavailable: true,
      deps: baseDeps({
        retrieveNarrative: async () => {
          order.push('narrative');
          return {
            status: 'ok',
            company: 'Infosys Limited',
            year: 2025,
            chunks: [],
            pdf_url: null,
          };
        },
        searchPdf: async () => {
          order.push('pdf');
          return {
            hits: [{ page: 7, score: 12, snippet: 'Plastic packaging reduction targets.' }],
            unavailable: false,
            totalPages: 50,
            scannedAllPages: true,
          };
        },
      }),
    });

    assert.ok(result);
    assert.equal(result.handled, true);
    assert.equal(result.source, 'pdf');
    assert.deepEqual(order, ['narrative', 'pdf']);
    assert.match(result.text, /Page 7/);
  });

  it('runSqlDocumentFallback prefers narrative over PDF when both could match', async () => {
    process.env.SQL_DOCUMENT_FALLBACK = 'true';
    const order = [];
    const result = await runSqlDocumentFallback({
      classification: {
        intent: INTENTS.METRIC_LOOKUP,
        entities: ['Infosys Limited'],
        metric: null,
        metricResolution: METRIC_RESOLUTION.UNSUPPORTED,
        filters: { unsupportedMetric: true, years: [2025] },
      },
      plan: { strategy: 'unsupported_metric' },
      userMessage: 'plastic footprint Infosys',
      deps: baseDeps({
        retrieveNarrative: async () => {
          order.push('narrative');
          return {
            status: 'ok',
            company: 'Infosys Limited',
            year: 2025,
            chunks: [{
              company: 'Infosys Limited',
              section: 'waste',
              text: 'Indexed plastic narrative from data_json.',
              source: 'data_json',
            }],
            pdf_url: 'https://example.com/a.pdf',
          };
        },
        searchPdf: async () => {
          order.push('pdf');
          return { hits: [{ page: 1, snippet: 'nope' }], scannedAllPages: true };
        },
      }),
    });

    assert.equal(result.source, 'narrative');
    assert.deepEqual(order, ['narrative']);
  });

  it('runSqlDocumentFallback returns null for Top-N rankings (no PDF fallback)', async () => {
    process.env.SQL_DOCUMENT_FALLBACK = 'true';
    const result = await runSqlDocumentFallback({
      classification: {
        intent: INTENTS.TOP_METRIC,
        entities: ['Infosys Limited'],
        metric: 'scope1_emissions',
      },
      plan: { intent: INTENTS.TOP_METRIC, strategy: 'sql_rank_metric', metric: 'scope1_emissions' },
      userMessage: 'Top 5 companies by Scope 1',
      returnUnavailable: true,
    });
    assert.equal(result, null);
  });
});
