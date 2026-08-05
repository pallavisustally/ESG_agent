/**
 * Report Engine — narrative retrieval + SQL→document→PDF fallback.
 */

import { retrieveCompanyNarrative, formatNarrativeAnswer } from '../../rag/brsr-chunks.js';
import { runSqlDocumentFallback } from '../../pipeline/sql-document-fallback.js';
import { attachReportPdfVisualization } from '../../answers/response-media.js';
import { createEngineResponse } from '../engine-response.js';
import { EXECUTION_ENGINES } from '../execution-plan.js';

/**
 * @param {object} ctx
 */
export async function runReportEngine(ctx = {}) {
  const executionPlan = ctx.executionPlan;
  if (!executionPlan?.needsReport && !executionPlan?.needsPdf && !ctx.forceFallback) {
    return createEngineResponse({
      engine: EXECUTION_ENGINES.REPORT,
      ok: false,
      text: '',
      error: 'report_not_required',
    });
  }

  const company = executionPlan.entities?.[0] || ctx.classification?.entities?.[0] || null;
  const year = executionPlan.years?.[0]
    ?? ctx.classification?.filters?.years?.[0]
    ?? null;
  const userMessage = ctx.userMessage || '';

  ctx.onProgress?.({
    status: 'tool_start',
    tool: 'report_engine',
    message: company
      ? `Searching ${company} BRSR disclosures…`
      : 'Searching company disclosures…',
  });

  // Prefer document fallback ladder when analytics missed or PDF explicitly needed.
  if (ctx.forceFallback || (executionPlan.needsPdf && ctx.analyticsFailed)) {
    try {
      const fallback = await runSqlDocumentFallback({
        classification: ctx.classification,
        plan: ctx.toolPlan,
        memory: ctx.memory,
        sqlData: ctx.analyticsData || null,
        userMessage,
        onProgress: ctx.onProgress,
        returnUnavailable: true,
      });
      ctx.onProgress?.({
        status: 'tool_end',
        tool: 'report_engine',
        message: fallback?.ok ? 'Report / PDF ready.' : 'No report match.',
      });
      if (fallback?.ok && fallback.text) {
        return createEngineResponse({
          engine: EXECUTION_ENGINES.REPORT,
          ok: true,
          text: fallback.text,
          dataText: fallback.text,
          data: fallback.data || fallback,
          confidence: fallback.confidence ?? 0.6,
          citations: fallback.data?.pdf_url ? [fallback.data.pdf_url] : [],
        });
      }
    } catch (err) {
      // fall through to narrative
    }
  }

  if (!company) {
    return createEngineResponse({
      engine: EXECUTION_ENGINES.REPORT,
      ok: false,
      text: 'Which company\'s sustainability disclosures should I look up?',
      error: 'missing_company',
    });
  }

  try {
    const narrative = await retrieveCompanyNarrative(userMessage, {
      companyHint: company,
      year,
      limit: 6,
    });
    const chunks = narrative?.chunks || [];
    if (narrative?.status === 'ambiguous') {
      return createEngineResponse({
        engine: EXECUTION_ENGINES.REPORT,
        ok: false,
        text: narrative.message || `Multiple companies matched “${company}”. Please clarify.`,
        error: 'ambiguous_company',
      });
    }
    if (!chunks.length) {
      // Try PDF ladder when narrative empty
      if (executionPlan.needsPdf !== false) {
        const fallback = await runSqlDocumentFallback({
          classification: ctx.classification,
          plan: ctx.toolPlan,
          memory: ctx.memory,
          userMessage,
          onProgress: ctx.onProgress,
          returnUnavailable: false,
        });
        if (fallback?.ok && fallback.text) {
          return createEngineResponse({
            engine: EXECUTION_ENGINES.REPORT,
            ok: true,
            text: fallback.text,
            dataText: fallback.text,
            confidence: fallback.confidence ?? 0.55,
          });
        }
      }
      return createEngineResponse({
        engine: EXECUTION_ENGINES.REPORT,
        ok: false,
        text: `I could not find qualitative BRSR narrative for **${company}** on that topic.`,
        error: 'no_chunks',
      });
    }

    let body = formatNarrativeAnswer({
      company: narrative.company || company,
      year: narrative.year ?? year,
      pdf_url: narrative.pdf_url,
      chunks,
      query: userMessage,
    });
    body = attachReportPdfVisualization(body, {
      company: narrative.company || company,
      year: narrative.year ?? year,
      userMessage,
      fromPdf: false,
    });

    ctx.onProgress?.({
      status: 'tool_end',
      tool: 'report_engine',
      message: 'Company report narrative ready.',
    });

    return createEngineResponse({
      engine: EXECUTION_ENGINES.REPORT,
      ok: true,
      text: body,
      dataText: body,
      citations: narrative.pdf_url ? [narrative.pdf_url] : [],
      confidence: 0.7,
      data: { chunks, pdf_url: narrative.pdf_url },
    });
  } catch (err) {
    return createEngineResponse({
      engine: EXECUTION_ENGINES.REPORT,
      ok: false,
      text: `Report retrieval failed: ${err?.message || err}`,
      error: String(err?.message || err),
    });
  }
}
