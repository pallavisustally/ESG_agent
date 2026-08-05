/**
 * Capability Executor — runs selected Copilot capabilities and returns mergeable results.
 *
 * Native analytics/benchmarking/reports reuse existing SQL + narrative modules.
 * Knowledge / guidance / compliance / document / recommendation use dedicated engines.
 */

import { CAPABILITIES } from './capabilities.js';
import { buildKnowledgeAnswer } from './knowledge-engine.js';
import { buildGuidanceAnswer } from './guidance-engine.js';
import { buildComplianceAnswer } from './compliance-engine.js';
import { buildDocumentDraft } from './document-generation.js';
import { buildRecommendationAnswer } from './recommendation-engine.js';
import { composeCapabilityResults, sanitizeUserFacingText } from './response-composer.js';
import { runSqlAgent } from '../sql-agent/sql-agent.js';
import { retrieveCompanyNarrative, formatNarrativeAnswer } from '../rag/brsr-chunks.js';
import { applyAnswerValidation } from '../validation/answer-validator.js';

/**
 * Execute a single capability.
 * @returns {Promise<{ capability: string, text: string, ok: boolean, dataText?: string }>}
 */
async function executeOne(capability, ctx) {
  const {
    userMessage,
    classification,
    plan,
    memory,
  } = ctx;

  switch (capability) {
    case CAPABILITIES.ESG_KNOWLEDGE:
      return {
        capability,
        text: buildKnowledgeAnswer(userMessage),
        ok: true,
      };

    case CAPABILITIES.ESG_GUIDANCE:
      return {
        capability,
        text: await buildGuidanceAnswer(userMessage),
        ok: true,
      };

    case CAPABILITIES.ESG_COMPLIANCE:
      return {
        capability,
        text: buildComplianceAnswer(userMessage),
        ok: true,
      };

    case CAPABILITIES.DOCUMENT_GENERATION:
      return {
        capability,
        text: buildDocumentDraft(userMessage),
        ok: true,
      };

    case CAPABILITIES.COMPANY_ANALYTICS:
    case CAPABILITIES.BENCHMARKING: {
      if (!plan) {
        return {
          capability,
          text: 'I need a bit more detail (company and metric) to run analytics.',
          ok: false,
        };
      }
      try {
        const sqlResult = await runSqlAgent({ plan, classification, memory });
        if (sqlResult?.ok && sqlResult.text) {
          return {
            capability,
            text: sqlResult.text,
            ok: true,
            dataText: sqlResult.text,
            sqlResult,
          };
        }
        return {
          capability,
          text: sqlResult?.text
            || 'I could not retrieve verified company metrics for that request.',
          ok: false,
          sqlResult,
        };
      } catch (err) {
        return {
          capability,
          text: `Analytics lookup failed: ${err?.message || err}`,
          ok: false,
        };
      }
    }

    case CAPABILITIES.COMPANY_REPORTS: {
      const company = classification?.entities?.[0] || null;
      if (!company) {
        return {
          capability,
          text: 'Which company\'s sustainability disclosures should I look up?',
          ok: false,
        };
      }
      try {
        const narrative = await retrieveCompanyNarrative(userMessage, {
          companyHint: company,
          year: classification?.filters?.years?.[0] || null,
          limit: 6,
        });
        const chunks = narrative?.chunks || [];
        if (narrative?.status === 'ambiguous') {
          return {
            capability,
            text: narrative.message || `Multiple companies matched “${company}”. Please clarify.`,
            ok: false,
          };
        }
        if (!chunks.length) {
          return {
            capability,
            text: `I could not find qualitative BRSR narrative for **${company}** on that topic.`,
            ok: false,
          };
        }
        const body = formatNarrativeAnswer({
          company: narrative.company || company,
          year: narrative.year,
          pdf_url: narrative.pdf_url,
          chunks,
          query: userMessage,
        });
        return {
          capability,
          text: body,
          ok: chunks.length > 0,
          dataText: body,
        };
      } catch (err) {
        return {
          capability,
          text: `Report retrieval failed: ${err?.message || err}`,
          ok: false,
        };
      }
    }

    case CAPABILITIES.RECOMMENDATION: {
      const dataText = ctx.priorDataText || null;
      const built = await buildRecommendationAnswer(userMessage, {
        companies: classification?.entities || [],
        dataText,
        metric: classification?.metric || ctx.analyticsData?.metric || null,
        analyticsData: ctx.analyticsData || null,
        peerData: ctx.peerData || null,
        sectorData: ctx.sectorData || null,
        fetchSector: true,
      });
      const text = typeof built === 'string' ? built : built.text;
      return {
        capability,
        text,
        ok: true,
        assumptions: typeof built === 'object' ? (built.assumptions || []) : [],
      };
    }

    default:
      return {
        capability,
        text: '',
        ok: false,
      };
  }
}

/**
 * Run all planned capabilities and compose one response.
 *
 * @param {{
 *   userMessage: string,
 *   classification: object,
 *   plan: object,
 *   memory?: object,
 *   capabilityPlan?: object,
 *   onProgress?: Function|null,
 * }} ctx
 */
export async function executeCapabilities(ctx) {
  const capabilityPlan = ctx.capabilityPlan
    || ctx.classification?.capabilityPlan
    || { capabilities: ctx.classification?.capabilities || [] };
  const capabilities = capabilityPlan.capabilities || [];
  const results = [];
  let priorDataText = null;

  for (const capability of capabilities) {
    ctx.onProgress?.({
      status: 'tool_start',
      tool: 'copilot',
      message: `Running ${capability.replace(/_/g, ' ').toLowerCase()}…`,
    });
    const result = await executeOne(capability, { ...ctx, priorDataText });
    if (result.dataText) {
      priorDataText = priorDataText
        ? `${priorDataText}\n\n${result.dataText}`
        : result.dataText;
    }
    if (result.text) results.push(result);
    ctx.onProgress?.({
      status: 'tool_end',
      tool: 'copilot',
      message: `${capability.replace(/_/g, ' ')} ready.`,
    });
  }

  const composed = composeCapabilityResults(results, {
    userMessage: ctx.userMessage,
    multi: capabilities.length > 1,
  });

  let text = sanitizeUserFacingText(composed.text);
  const primaryData = results.find((r) => r?.data?.rows || r?.data?.metric)?.data || null;
  const applied = await applyAnswerValidation({
    text,
    classification: ctx.classification,
    executionPlan: null,
    engineResults: results.map((r) => ({
      engine: r.capability,
      ok: r.ok,
      text: r.text,
      data: r.data || null,
      dataText: r.dataText || '',
      citations: r.citations || [],
      visualization: r.visualization || null,
    })),
    data: primaryData,
    visualization: results.find((r) => r.visualization)?.visualization || null,
    citations: results.flatMap((r) => r.citations || []),
    source: 'composer',
  });
  text = applied.text;

  return {
    ok: results.some((r) => r.ok) && applied.validation.verdict !== 'ERROR',
    text,
    responseSource: composed.responseSource,
    capabilitiesUsed: composed.capabilitiesUsed || capabilities,
    results,
    capabilityPlan,
    validation: applied.validation,
    responseValidation: applied.validation,
    repairActions: applied.repairActions || [],
  };
}
