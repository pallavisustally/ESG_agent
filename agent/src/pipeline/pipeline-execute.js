/**
 * Routed tool execution for BRSR pipeline (SQL / guidance / hybrid WHY / RAG / handoff).
 * Used by imperative and optional LangGraph paths — no LLM-generated SQL here.
 */

import { INTENTS } from '../intent/classify-intent.js';
import {
  METRIC_RESOLUTION,
  shouldReuseMemoryMetric,
} from '../intent/metric-resolution.js';
import { resumeClassificationFromPending } from '../intent/pending-request.js';
import { runSqlAgent } from '../sql-agent/sql-agent.js';
import { hybridRetrieve, formatRagContext } from '../rag/hybrid-retrieval.js';
import { retrieveCompanyNarrative, formatNarrativeAnswer } from '../rag/brsr-chunks.js';
import { validateRagEvidence } from '../validation/response-validator.js';
import { applyAnswerValidation } from '../validation/answer-validator.js';
import { updateMemory } from '../memory/conversation-memory.js';
import { logAgentEvent, logPipelineStage } from '../observability/agent-logger.js';
import { fluencySystemAddon } from '../answers/templates.js';
import { collectAssumptions, prependAssumptionNotes } from '../answers/assumptions.js';
import { buildInformationalAnswer } from '../answers/informational.js';
import {
  explainSqlFailure,
  shouldBlockLlmFallback,
  isAllowedLlmHandoff,
} from '../answers/sql-failure.js';
import { buildNoDataAnswer } from '../answers/no-data-template.js';
import { planQuery } from '../planner/plan-query.js';
import {
  shouldUseCapabilityExecutor,
  withCapabilityPlan,
} from '../capability/capability-planner.js';
import { executeCapabilities } from '../capability/capability-executor.js';
import { buildKnowledgeAnswer } from '../capability/knowledge-engine.js';
import { buildGuidanceAnswer } from '../capability/guidance-engine.js';
import {
  executeExecutionPlan,
  isExecutionPlannerDispatchEnabled,
  planExecution,
  toolPlanFromExecutionPlan,
} from '../execution/index.js';
import { runHybridWhy, shouldRunHybridWhy } from './hybrid-why.js';
import { saveTurnMemory } from './pipeline-helpers.js';
import {
  runSqlDocumentFallback,
  isCompanyScopedDocumentFallbackEligible,
  resolveFallbackCompanies,
} from './sql-document-fallback.js';
import { mustPreferSql } from '../validation/semantic-plan.js';
import { startTimer } from '../observability/agent-logger.js';
import { summarizeVisualization } from '../observability/execution-trace.js';

/**
 * Attempt company-scoped SQL → document fallback (narrative then PDF).
 * Returns a pipeline result object or null when fallback does not apply.
 */
async function maybeDocumentFallback(state, {
  sqlResult = null,
  returnUnavailable = true,
} = {}) {
  const {
    userMessage,
    key,
    onProgress = null,
    elapsed,
    classification,
    plan,
    route,
    memory,
    systemAddon,
    planValidation,
  } = state;

  const companies = resolveFallbackCompanies(classification, memory, sqlResult?.data, userMessage);
  if (!isCompanyScopedDocumentFallbackEligible({
    classification,
    plan,
    companies,
    userMessage,
  })) {
    return null;
  }

  const fallback = await runSqlDocumentFallback({
    classification,
    plan,
    memory,
    sqlData: sqlResult?.data || null,
    userMessage,
    onProgress,
    returnUnavailable,
  });
  if (!fallback) return null;

  const text = prependAssumptionNotes(
    fallback.text,
    classification?.assumptions,
  );

  const nextMemory = saveTurnMemory(key, {
    classification,
    plan,
    route,
    data: {
      resolvedCompany: fallback.company,
      year: fallback.year,
      ...(fallback.data || {}),
    },
    patch: {
      lastTool: fallback.source === 'pdf' || fallback.source === 'narrative' ? 'RAG' : 'NONE',
      resolvedCompany: fallback.company,
      lastYear: fallback.year ?? null,
      lastCompanies: fallback.company ? [fallback.company] : companies,
    },
    assumptions: classification?.assumptions,
  });

  logPipelineStage('sql_document_fallback', {
    intent: classification?.intent,
    mode: route?.mode,
    source: fallback.source,
    ok: fallback.source !== 'unavailable',
    company: fallback.company,
    year: fallback.year,
    confidence: fallback.confidence,
    attempts: fallback.attempts,
    fallbackStage: 'SQL→Confidence→Narrative→Confidence→PDF',
    responseSource: fallback.source === 'narrative'
      ? 'Narrative'
      : (fallback.source === 'pdf' ? 'PDF' : 'Unavailable'),
    latencyMs: elapsed?.(),
  });
  console.log('[PlannerDebug] Fallback stage: SQL→Confidence→Narrative→Confidence→PDF');
  console.log('[PlannerDebug] Final response source:', fallback.source === 'narrative'
    ? 'Narrative'
    : (fallback.source === 'pdf' ? 'PDF' : 'Unavailable'));

  return {
    handled: true,
    text,
    classification,
    plan,
    route,
    memory: nextMemory,
    systemAddon,
    planValidation,
    plannerScore: state.plannerScore || null,
    forbidLlmFallback: true,
    documentFallback: {
      source: fallback.source,
      company: fallback.company,
      year: fallback.year,
      confidence: fallback.confidence,
      attempts: fallback.attempts,
    },
    responseSource: fallback.source === 'narrative'
      ? 'Narrative'
      : (fallback.source === 'pdf' ? 'PDF' : 'Unavailable'),
    orchestrator: state.orchestrator || 'imperative',
  };
}

/**
 * Execute tools from a prepared pipeline state.
 * @returns {Promise<object>} pipeline result (handled/text/classification/...)
 */
export async function executeRoutedBranches(state) {
  const {
    userMessage,
    key,
    onProgress = null,
    elapsed,
    clarification,
    planValidation,
  } = state;

  let {
    memory,
    classification,
    plan,
    route,
    systemAddon,
  } = state;

  let ragContext = state.ragContext || '';

  // Missing prior company list for anaphoric references — never expand to all companies.
  if (
    plan?.strategy === 'clarify_prior_companies'
    || classification?.filters?.needsPriorCompanies
  ) {
    const text = clarification
      || classification?.clarification
      || 'I do not have a previous company list in this conversation to resolve '
        + '"above/those companies". Which companies should I use?';
    logPipelineStage('clarify_prior_companies', {
      intent: classification.intent,
      companies: [],
      ok: true,
      tool: 'NONE',
    });
    console.log('[PlannerDebug] Selected tool: NONE (missing prior companies)');
    return {
      handled: true,
      text,
      classification: {
        ...classification,
        entities: [],
        wantsAll: false,
      },
      plan,
      route: { mode: 'clarify', skipRag: true, tools: [] },
      memory,
      systemAddon: '',
      planValidation,
      forbidLlmFallback: true,
      orchestrator: state.orchestrator || 'imperative',
    };
  }

  // Unsupported metric: try company-scoped document fallback before hard unavailable.
  if (
    classification?.metricResolution === METRIC_RESOLUTION.UNSUPPORTED
    || classification?.filters?.unsupportedMetric
    || plan?.strategy === 'unsupported_metric'
  ) {
    const docFallback = await maybeDocumentFallback(state, { returnUnavailable: true });
    if (docFallback) {
      console.log('[PlannerDebug] Selected tool: DOCUMENT_FALLBACK (unsupported metric)');
      return docFallback;
    }

    const text = buildNoDataAnswer({
      companies: classification.entities,
      metric: classification.metric,
      year: classification.filters?.years?.[0],
      userMessage: state.userMessage,
    });
    // Preserve prior metric/plan in memory — this turn did not produce a new verified result.
    memory = updateMemory(key, {
      lastIntent: classification.intent,
      entities: classification.entities?.length ? classification.entities : undefined,
    });
    logPipelineStage('unsupported_metric', {
      intent: classification.intent,
      metricResolution: METRIC_RESOLUTION.UNSUPPORTED,
      companies: classification.entities,
      ok: true,
      tool: 'NONE',
    });
    console.log('[PlannerDebug] Selected tool: NONE (unsupported metric)');
    console.log('[PlannerDebug] Generated SQL: (skipped)');
    return {
      handled: true,
      text,
      classification: {
        ...classification,
        metric: null,
        metricResolution: METRIC_RESOLUTION.UNSUPPORTED,
      },
      plan,
      route: { mode: 'clarify', skipRag: true, tools: [] },
      memory,
      systemAddon: '',
      planValidation,
      forbidLlmFallback: true,
      orchestrator: state.orchestrator || 'imperative',
    };
  }

  if (clarification) {
    // Store pending ask when clarifying companies; never persist execution plan.
    const pendingPatch = plan?.strategy === 'clarify_prior_companies'
      || classification?.filters?.needsPriorCompanies
      ? {}
      : { pendingRequest: memory?.pendingRequest ?? null };
    memory = updateMemory(key, {
      lastIntent: classification.intent,
      entities: classification.entities,
      lastYear: classification.filters?.years?.[0] ?? memory?.lastYear ?? null,
      ...pendingPatch,
    });
    return {
      handled: true,
      text: clarification,
      classification,
      plan,
      route,
      memory,
      systemAddon: '',
      planValidation,
      orchestrator: state.orchestrator || 'imperative',
    };
  }

  // ── Execution Planner path (default) ─────────────────────────────────────
  // Single routing contract → orchestrator → engines → response composer.
  // Set USE_EXECUTION_PLANNER=false to force the legacy Tool/Capability/Router path.
  if (isExecutionPlannerDispatchEnabled()) {
    let executionPlan = state.executionPlan || null;
    if (!executionPlan) {
      executionPlan = planExecution({
        userMessage,
        memory,
        classification,
        assumptions: classification?.assumptions || [],
      }).plan;
    }
    onProgress?.({
      status: 'tool_start',
      tool: 'execution_orchestrator',
      message: 'Executing sustainability engines…',
    });
    console.log('[ExecutionPlanner] Orchestrating', JSON.stringify({
      strategy: executionPlan.executionStrategy,
      engines: executionPlan.requiredEngines,
      capabilities: executionPlan.capabilities,
      needsSql: executionPlan.needsSql,
    }));
    try {
      const orchestrated = await executeExecutionPlan({
        executionPlan,
        userMessage,
        classification,
        memory,
        memoryKey: key,
        toolPlan: state.plan || toolPlanFromExecutionPlan(executionPlan, classification),
        onProgress,
        requestId: state.trace?.requestId || null,
        trace: state.trace || null,
      });
      if (orchestrated.handled && orchestrated.text) {
        // Orchestrator is the single writer of conversation memory for this path.
        memory = orchestrated.memory || memory;
        logPipelineStage('execution_orchestrator', {
          intent: classification.intent,
          strategy: executionPlan.executionStrategy,
          engines: executionPlan.requiredEngines,
          ok: orchestrated.ok,
          tool: 'EXECUTION_PLANNER',
          latencyMs: elapsed?.(),
          errorCode: orchestrated.error?.code || null,
          requestId: state.trace?.requestId || null,
          memoryCompanies: memory?.lastCompanies?.length || 0,
        });
        return {
          handled: true,
          text: orchestrated.text,
          classification,
          plan: orchestrated.toolPlan || state.plan,
          route: {
            mode: 'execution_planner',
            tools: executionPlan.requiredEngines,
            skipRag: !executionPlan.needsReport,
            reason: executionPlan.reason,
          },
          memory,
          systemAddon,
          planValidation,
          forbidLlmFallback: orchestrated.forbidLlmFallback !== false,
          responseSource: orchestrated.responseSource || 'Copilot',
          capabilitiesUsed: orchestrated.capabilitiesUsed,
          capabilityPlan: state.capabilityPlan || classification?.capabilityPlan,
          executionPlan,
          engineResults: orchestrated.engineResults,
          engineTrace: orchestrated.engineTrace || null,
          memoryUpdate: orchestrated.memoryUpdate || null,
          validation: orchestrated.validation || orchestrated.responseValidation || null,
          responseValidation: orchestrated.responseValidation || orchestrated.validation || null,
          repairActions: orchestrated.repairActions || [],
          visualizationSummary: orchestrated.visualizationSummary || null,
          composition: orchestrated.composition || null,
          latencyBreakdown: orchestrated.latencyBreakdown || null,
          error: orchestrated.error || null,
          merged: orchestrated.merged || null,
          orchestrator: 'execution_planner',
        };
      }
      console.warn('[ExecutionPlanner] Orchestrator returned no answer — falling back to legacy pipeline.');
    } catch (err) {
      console.warn('[ExecutionPlanner] Orchestrator error — legacy fallback:', err?.message || err);
    }
  }

  // ── Legacy capability path (USE_EXECUTION_PLANNER=false or orchestrator miss) ──
  // ESG Copilot capability path — knowledge / guidance / compliance / documents /
  // recommendations / multi-capability merges. Native-only analytics still use SQL below.
  {
    let capabilityPlan = state.capabilityPlan || classification?.capabilityPlan || null;
    if (!capabilityPlan) {
      const enriched = withCapabilityPlan(classification, userMessage, memory);
      classification = enriched;
      capabilityPlan = enriched.capabilityPlan;
    }
    if (shouldUseCapabilityExecutor(capabilityPlan)) {
      onProgress?.({
        status: 'tool_start',
        tool: 'copilot',
        message: 'Selecting sustainability capabilities…',
      });
      console.log('[PlannerDebug] Selected tool: COPILOT capabilities', capabilityPlan.capabilities);
      const executed = await executeCapabilities({
        userMessage,
        classification,
        plan,
        memory,
        capabilityPlan,
        onProgress,
      });
      const text = prependAssumptionNotes(executed.text, classification.assumptions);
      memory = saveTurnMemory(key, {
        classification,
        plan,
        route: { mode: 'copilot', tools: capabilityPlan.capabilities, skipRag: true },
        assumptions: classification.assumptions,
      });
      logPipelineStage('copilot_capabilities', {
        intent: classification.intent,
        capabilities: capabilityPlan.capabilities,
        multi: capabilityPlan.multi,
        ok: executed.ok,
        tool: 'COPILOT',
        latencyMs: elapsed?.(),
      });
      return {
        handled: true,
        text,
        classification,
        plan,
        route: {
          mode: 'copilot',
          tools: capabilityPlan.capabilities,
          skipRag: true,
          reason: capabilityPlan.reason,
        },
        memory,
        systemAddon,
        planValidation,
        forbidLlmFallback: true,
        responseSource: executed.responseSource || 'Copilot',
        capabilitiesUsed: executed.capabilitiesUsed,
        validation: executed.validation || executed.responseValidation || null,
        responseValidation: executed.responseValidation || executed.validation || null,
        capabilityPlan,
        orchestrator: state.orchestrator || 'imperative',
      };
    }
  }

  // Deterministic SQL path
  if (route.mode === 'deterministic_sql') {
    onProgress?.({ status: 'tool_start', tool: 'sql_agent', message: 'Querying BRSR structured reports…' });
    console.log('[PlannerDebug] Selected tool: SQL');
    const sqlTimer = startTimer();
    const sqlResult = await runSqlAgent({ plan, classification, memory });
    const sqlDurationMs = sqlTimer();
    sqlResult.durationMs = sqlDurationMs;
    sqlResult.path = 'deterministic_sql';
    if (sqlResult?.sql || sqlResult?.data?.sql || sqlResult?.query) {
      console.log('[PlannerDebug] Generated SQL:', sqlResult.sql || sqlResult.data?.sql || sqlResult.query);
    } else {
      console.log('[PlannerDebug] Generated SQL: (templated / agent-internal)');
    }
    onProgress?.({
      status: 'tool_end',
      tool: 'sql_agent',
      message: sqlResult.ok
        ? 'BRSR SQL ready.'
        : (shouldBlockLlmFallback(classification.intent, sqlResult)
          ? 'SQL incomplete — explaining failure (no LLM fabricate).'
          : 'Handing off to analyst loop…'),
    });

    if (sqlResult.ok && sqlResult.text) {
      const applied = await applyAnswerValidation(
        {
          text: sqlResult.text,
          classification,
          executionPlan: null,
          engineResults: [],
          data: sqlResult.data,
          visualization: sqlResult.chartBlock
            ? { chartBlock: sqlResult.chartBlock }
            : null,
          citations: [],
          source: 'sql',
          wantsAll: classification.wantsAll,
          sqlResult,
        },
        { sqlResult },
      );
      let text = applied.text;
      const validation = applied.validation;

      // Clarification continuation: ranking/list supplied companies → resume pending metric ask.
      const pending = classification.filters?.pendingRequest || memory?.pendingRequest || null;
      if (
        classification.filters?.clarificationProvidesCompanies
        && pending
        && (classification.intent === INTENTS.TOP_METRIC
          || classification.intent === INTENTS.BOTTOM_METRIC
          || classification.intent === INTENTS.LIST_ALL_COMPANIES
          || classification.intent === INTENTS.FILTER_BY_SECTOR)
      ) {
        const rankedCompanies = [
          ...(sqlResult.data?.companies || []),
          ...((sqlResult.data?.rows || []).map((r) => r.company).filter(Boolean)),
        ];
        const uniqCompanies = [...new Set(rankedCompanies.map((c) => String(c).trim()).filter(Boolean))];
        if (uniqCompanies.length) {
          console.log('[PlannerDebug] Clarification continuation — resuming pending request');
          console.log('[PlannerDebug] Pending request:', JSON.stringify({
            metric: pending.metric,
            intent: pending.intent,
            companies: uniqCompanies.slice(0, 5),
          }));
          let resumed = resumeClassificationFromPending(classification, pending, {
            companies: uniqCompanies,
          });
          const resumedPlan = planQuery(resumed, {
            ...memory,
            lastCompanies: uniqCompanies,
            pendingRequest: null,
          });
          memory = updateMemory(key, {
            lastCompanies: uniqCompanies,
            lastPageItems: uniqCompanies,
            entities: uniqCompanies,
            pendingRequest: null,
            lastYear: resumed.filters?.years?.[0] ?? pending.year ?? memory.lastYear,
            lastMetric: resumed.metric || memory.lastMetric,
          });

          onProgress?.({
            status: 'tool_start',
            tool: 'sql_agent',
            message: 'Resuming prior request with clarified companies…',
          });
          const resumedSql = await runSqlAgent({
            plan: resumedPlan,
            classification: resumed,
            memory,
          });
          onProgress?.({
            status: 'tool_end',
            tool: 'sql_agent',
            message: resumedSql.ok ? 'Resumed SQL ready.' : 'Resumed SQL incomplete — trying document fallback…',
          });

          if (resumedSql.ok && resumedSql.text) {
            const resumedText = prependAssumptionNotes(
              `${text}\n\n---\n\n### Resumed request\n\n${resumedSql.text}`,
              resumed.assumptions,
            );
            memory = saveTurnMemory(key, {
              classification: resumed,
              plan: resumedPlan,
              route,
              data: resumedSql.data,
              patch: {
                ...(resumedSql.memoryUpdate || {}),
                lastCompanies: uniqCompanies,
                pendingRequest: null,
              },
              assumptions: resumed.assumptions,
            });
            console.log('[PlannerDebug] Final response source: SQL (clarification continuation)');
            return {
              handled: true,
              text: resumedText,
              classification: resumed,
              plan: resumedPlan,
              route,
              memory,
              systemAddon,
              responseSource: 'SQL',
              orchestrator: state.orchestrator || 'imperative',
            };
          }

          const docFallback = await maybeDocumentFallback(
            {
              ...state,
              memory,
              classification: resumed,
              plan: resumedPlan,
              route,
              systemAddon,
            },
            { sqlResult: resumedSql, returnUnavailable: true },
          );
          if (docFallback) {
            const combined = `${text}\n\n---\n\n### Resumed request\n\n${docFallback.text}`;
            return { ...docFallback, text: combined };
          }
        }
      }

      const assumptions = collectAssumptions({
        classification,
        plan,
        data: sqlResult.data,
      }).concat(sqlResult.assumptions || []);
      text = prependAssumptionNotes(text, assumptions);
      memory = saveTurnMemory(key, {
        classification,
        plan,
        route,
        data: sqlResult.data,
        patch: {
          ...(sqlResult.memoryUpdate || {}),
          pendingRequest: classification.filters?.clarificationProvidesCompanies
            ? (memory?.pendingRequest ?? null)
            : null,
        },
        assumptions,
      });

      logPipelineStage('response_validate', {
        intent: classification.intent,
        mode: route.mode,
        tool: 'SQL',
        ok: validation.ok,
        verdict: validation.verdict,
        reason: validation.reason,
        errors: validation.errors,
        warnings: validation.warnings,
        latencyMs: elapsed?.(),
      });

      logPipelineStage('sql', {
        intent: classification.intent,
        mode: route.mode,
        strategy: plan.strategy,
        tool: 'SQL',
        ok: true,
        latencyMs: elapsed?.(),
        total: sqlResult.data?.total,
        page: sqlResult.data?.page,
        companies: memory.lastCompanies,
        metric: memory.lastMetric,
        year: memory.lastYear,
        warnings: validation.warnings,
        responseSource: 'SQL',
      });
      console.log('[PlannerDebug] Final response source: SQL');

      return {
        handled: true,
        text,
        classification: { ...classification, assumptions },
        plan,
        route,
        memory,
        systemAddon,
        validation,
        responseValidation: validation,
        repairActions: applied.repairActions || [],
        sqlResult,
        composition: {
          path: 'sql',
          capabilitiesUsed: [],
          engineCount: 0,
          textLength: String(text || '').length,
          repairActions: applied.repairActions || [],
        },
        visualizationSummary: summarizeVisualization({
          text,
          visualization: sqlResult.chartBlock ? { chartBlock: sqlResult.chartBlock } : null,
          repairActions: applied.repairActions || [],
        }),
        latencyBreakdown: { executeMs: sqlDurationMs },
        responseSource: 'SQL',
        orchestrator: state.orchestrator || 'imperative',
      };
    }

    // SQL miss → company-scoped narrative/PDF fallback (never rankings / aggregates).
    if (
      sqlResult?.error === 'metric_not_in_sql'
      || sqlResult?.error === 'handoff_llm'
      || !sqlResult?.ok
    ) {
      const docFallback = await maybeDocumentFallback(
        { ...state, memory, classification, plan, route, systemAddon },
        { sqlResult, returnUnavailable: sqlResult?.error === 'metric_not_in_sql' },
      );
      if (docFallback) {
        console.log('[PlannerDebug] Selected tool: DOCUMENT_FALLBACK (after SQL miss)');
        return docFallback;
      }
    }

    if (shouldBlockLlmFallback(classification.intent, sqlResult)) {
      const text = sqlResult.error === 'metric_not_in_sql'
        ? buildNoDataAnswer({
          companies: classification.entities,
          metric: classification.metric || classification.filters?.metric || plan.metric,
          year: classification.filters?.years?.[0],
          userMessage: state.userMessage,
        })
        : explainSqlFailure({
          intent: classification.intent,
          error: sqlResult.error,
          metric: classification.metric || classification.filters?.metric || plan.metric,
          companies: classification.entities,
          year: classification.filters?.years?.[0],
          sector: classification.filters?.sector,
          userMessage: state.userMessage,
        });
      logAgentEvent({
        stage: 'sql_failure_explained',
        intent: classification.intent,
        mode: route.mode,
        ok: false,
        forbidLlmFallback: true,
        error: sqlResult.error || 'sql_unavailable',
        latencyMs: elapsed?.(),
      });
      return {
        handled: true,
        text,
        classification,
        plan,
        route,
        memory,
        systemAddon,
        forbidLlmFallback: true,
        sqlError: sqlResult.error || null,
        orchestrator: state.orchestrator || 'imperative',
      };
    }

    if (isAllowedLlmHandoff(classification.intent, sqlResult) && sqlResult.data?.resolvedCompany) {
      memory = updateMemory(key, {
        ...(sqlResult.memoryUpdate || {}),
        resolvedCompany: sqlResult.data.resolvedCompany,
      });
      return {
        handled: false,
        classification,
        plan,
        route,
        memory,
        systemAddon: `${systemAddon}\n- Resolved company: ${sqlResult.data.resolvedCompany}`,
        resolvedCompany: sqlResult.data.resolvedCompany,
        orchestrator: state.orchestrator || 'imperative',
      };
    }

    if (sqlResult.error) {
      const text = explainSqlFailure({
        intent: classification.intent,
        error: sqlResult.error,
        metric: classification.metric || plan.metric,
        companies: classification.entities,
        year: classification.filters?.years?.[0],
        sector: classification.filters?.sector,
        userMessage: state.userMessage,
      });
      logAgentEvent({
        stage: 'sql_failure_explained',
        intent: classification.intent,
        mode: route.mode,
        ok: false,
        error: sqlResult.error,
        latencyMs: elapsed?.(),
      });
      return {
        handled: true,
        text,
        classification,
        plan,
        route,
        memory,
        systemAddon,
        forbidLlmFallback: true,
        orchestrator: state.orchestrator || 'imperative',
      };
    }
  }

  if (
    classification.intent === INTENTS.INFORMATIONAL
    || plan?.strategy === 'informational_definition'
    || classification?.filters?.informational
  ) {
    onProgress?.({ status: 'tool_start', tool: 'informational', message: 'Preparing definition / concept answer…' });
    const text = prependAssumptionNotes(
      buildKnowledgeAnswer(userMessage) || buildInformationalAnswer(userMessage),
      classification.assumptions,
    );
    onProgress?.({ status: 'tool_end', tool: 'informational', message: 'Concept answer ready.' });
    memory = saveTurnMemory(key, { classification, plan, route, assumptions: classification.assumptions });
    logPipelineStage('informational', {
      intent: classification.intent,
      mode: 'informational_definition',
      tool: 'RAG',
      ok: true,
      latencyMs: elapsed?.(),
    });
    console.log('[PlannerDebug] Selected tool: INFORMATIONAL (no SQL)');
    return {
      handled: true,
      text,
      classification,
      plan,
      route: { mode: 'rag', skipRag: false, tools: ['RAG'] },
      memory,
      systemAddon,
      planValidation,
      forbidLlmFallback: true,
      responseSource: 'ESG Knowledge',
      orchestrator: state.orchestrator || 'imperative',
    };
  }

  // How-to guidance even when a company name appears casually ("in my company").
  if (classification.intent === INTENTS.HOW_TO || plan?.strategy === 'guidance_templates') {
    onProgress?.({ status: 'tool_start', tool: 'guidance', message: 'Preparing sustainability guidance…' });
    const text = prependAssumptionNotes(
      await buildGuidanceAnswer(userMessage),
      classification.assumptions,
    );
    onProgress?.({ status: 'tool_end', tool: 'guidance', message: 'Guidance ready.' });
    memory = saveTurnMemory(key, { classification, plan, route, assumptions: classification.assumptions });
    logAgentEvent({
      intent: classification.intent,
      mode: 'esg_guidance',
      ok: true,
      latencyMs: elapsed?.(),
    });
    console.log('[PlannerDebug] Selected tool: HOW_TO guidance (no SQL)');
    return {
      handled: true,
      text,
      classification,
      plan,
      route,
      memory,
      systemAddon,
      forbidLlmFallback: true,
      responseSource: 'ESG Guidance',
      orchestrator: state.orchestrator || 'imperative',
    };
  }

  if (shouldRunHybridWhy(classification, userMessage, memory) || classification.filters?.hybridWhy) {
    const companies = classification.entities?.length
      ? classification.entities
      : (memory.lastCompanies || memory.entities || []);
    const metric = shouldReuseMemoryMetric(classification.metricResolution)
      ? (classification.metric || memory.lastMetric || 'total_emissions')
      : (classification.metric || 'total_emissions');
    const year = classification.filters?.years?.[0] || memory.lastYear || null;
    const metrics = classification.filters?.metrics
      || classification.metrics
      || (metric ? [metric] : ['total_emissions']);

    if (companies.length >= 1) {
      onProgress?.({
        status: 'tool_start',
        tool: 'hybrid_why',
        message: 'Combining verified metrics with BRSR narrative…',
      });
      const hybrid = await runHybridWhy({
        companies: companies.slice(0, 3),
        metric,
        metrics,
        year,
        userMessage,
      });
      onProgress?.({
        status: 'tool_end',
        tool: 'hybrid_why',
        message: hybrid.ok ? 'Hybrid analysis ready.' : 'Hybrid evidence incomplete.',
      });

      if (hybrid.ok && hybrid.text) {
        const assumptions = collectAssumptions({
          classification,
          plan,
          data: {
            year,
            assumedYear: !year && hybrid.data?.rows?.[0]?.year ? hybrid.data.rows[0].year : null,
          },
        });
        const text = prependAssumptionNotes(hybrid.text, assumptions);
        memory = saveTurnMemory(key, {
          classification,
          plan,
          route,
          data: {
            rows: hybrid.data?.rows,
            year: year || hybrid.data?.rows?.[0]?.year,
            metric,
          },
          patch: {
            lastCompanies: companies.slice(0, 3),
            lastMetric: metric,
            lastYear: year || hybrid.data?.rows?.[0]?.year || null,
            lastTool: 'HYBRID',
          },
          assumptions,
        });

        logPipelineStage('hybrid_why', {
          intent: classification.intent,
          mode: 'hybrid',
          tool: 'HYBRID',
          ok: true,
          companies: companies.slice(0, 3),
          metric,
          hasSql: hybrid.data?.hasSql,
          hasRag: hybrid.data?.hasRag,
          ragChunks: (hybrid.data?.narratives || []).reduce((n, x) => n + (x.chunks?.length || 0), 0),
          latencyMs: elapsed?.(),
        });

        return {
          handled: true,
          text,
          classification: { ...classification, assumptions },
          plan,
          route,
          memory,
          systemAddon,
          hybrid: hybrid.data,
          orchestrator: state.orchestrator || 'imperative',
        };
      }
    }
  }

  // Semantic gate: never open Narrative first for measurable metric asks
  // (current-message FOUND/DERIVED metrics). Causal why-follow-ups may still use hybrid.
  const preferSql = mustPreferSql(userMessage, classification, plan)
    && (
      classification?.metricResolution === METRIC_RESOLUTION.FOUND
      || classification?.metricResolution === METRIC_RESOLUTION.DERIVED
      || classification?.filters?.answerType === 'QUANTITATIVE'
      || plan?.filters?.answerType === 'QUANTITATIVE'
    );

  if (
    (
      classification.intent === INTENTS.COMPANY_SUMMARY
      || classification.intent === INTENTS.FOLLOW_UP
      || (classification.intent === INTENTS.GENERAL_ESG_QUESTION && classification.entities?.length)
      || (route.mode === 'hybrid' && classification.entities?.length)
    )
    && !preferSql
  ) {
    onProgress?.({ status: 'tool_start', tool: 'brsr_narrative', message: 'Reading BRSR narrative / data_json…' });
    const narrative = await retrieveCompanyNarrative(userMessage, {
      companyHint: classification.entities?.[0] || classification.filters?.resolvedCompany,
      year: classification.filters?.years?.[0] || null,
      limit: 8,
    });
    onProgress?.({ status: 'tool_end', tool: 'brsr_narrative', message: `Found ${narrative.chunks?.length || 0} snippet(s).` });

    if (narrative.status === 'ambiguous') {
      return {
        handled: true,
        text: narrative.message,
        classification,
        plan,
        route,
        memory,
        systemAddon,
        orchestrator: state.orchestrator || 'imperative',
      };
    }

    if (narrative.chunks?.length) {
      const ragValidation = validateRagEvidence({
        chunks: narrative.chunks,
        company: narrative.company,
        minChunks: 1,
      });
      logPipelineStage('response_validate', {
        intent: classification.intent,
        mode: 'brsr_narrative',
        tool: 'RAG',
        ok: ragValidation.ok,
        errors: ragValidation.errors,
        warnings: ragValidation.warnings,
        retrievedDocuments: narrative.chunks.length,
      });

      if (!ragValidation.ok && ragValidation.errors?.includes('rag_chunks_wrong_company')) {
        const text = prependAssumptionNotes(
          `I found BRSR snippets, but they did not clearly belong to **${narrative.company}**, so I won't treat them as evidence.`,
          classification.assumptions,
        );
        return {
          handled: true,
          text,
          classification,
          plan,
          route,
          memory,
          systemAddon,
          validation: ragValidation,
          orchestrator: state.orchestrator || 'imperative',
        };
      }

      const text = prependAssumptionNotes(formatNarrativeAnswer({
        company: narrative.company,
        year: narrative.year,
        pdf_url: narrative.pdf_url,
        chunks: narrative.chunks,
        query: userMessage,
      }), classification.assumptions);
      memory = saveTurnMemory(key, {
        classification,
        plan,
        route,
        data: { resolvedCompany: narrative.company, year: narrative.year },
        patch: { resolvedCompany: narrative.company, lastTool: 'RAG' },
        assumptions: classification.assumptions,
      });
      logPipelineStage('rag', {
        intent: classification.intent,
        mode: 'brsr_narrative',
        tool: 'RAG',
        ok: true,
        ragChunks: narrative.chunks.length,
        company: narrative.company,
        warnings: ragValidation.warnings,
        latencyMs: elapsed?.(),
      });
      return {
        handled: true,
        text,
        classification,
        plan,
        route,
        memory,
        systemAddon: `${systemAddon}\n${fluencySystemAddon({ intent: classification.intent, hasEvidence: true })}`,
        ragContext: text,
        validation: ragValidation,
        orchestrator: state.orchestrator || 'imperative',
      };
    }
  }

  if (route.mode === 'rag' || route.mode === 'hybrid') {
    onProgress?.({ status: 'tool_start', tool: 'hybrid_retrieve', message: 'Searching BRSR narrative fields…' });
    const retrieval = await hybridRetrieve(userMessage, { limit: 6 });
    ragContext = formatRagContext(retrieval);
    onProgress?.({ status: 'tool_end', tool: 'hybrid_retrieve', message: `Found ${retrieval.chunks.length} BRSR snippet(s).` });

    if (
      classification.intent === INTENTS.GENERAL_ESG_QUESTION
      && !classification.entities?.length
      && retrieval.chunks?.length
    ) {
      const text = [
        '### BRSR concepts',
        '',
        'In SEBI BRSR filings, emissions are typically disclosed as **Scope 1** (direct), **Scope 2** (purchased energy), and **Scope 3** (value chain).',
        'This assistant answers from the indexed `reports` table (metrics + selected narrative fields).',
        '',
        formatRagContext(retrieval),
      ].join('\n');
      const textWithAssumptions = prependAssumptionNotes(text, classification.assumptions);
      memory = saveTurnMemory(key, {
        classification,
        plan,
        route,
        patch: { lastTool: 'RAG' },
        assumptions: classification.assumptions,
      });
      logAgentEvent({
        intent: classification.intent,
        mode: 'rag',
        ok: true,
        handled: true,
        ragChunks: retrieval.chunks.length,
        latencyMs: elapsed?.(),
      });
      return {
        handled: true,
        text: textWithAssumptions,
        classification,
        plan,
        route,
        memory,
        systemAddon,
        ragContext,
        orchestrator: state.orchestrator || 'imperative',
      };
    }

    memory = saveTurnMemory(key, {
      classification,
      plan,
      route,
      patch: { lastTool: route.mode === 'hybrid' ? 'HYBRID' : 'RAG' },
      assumptions: classification.assumptions,
    });

    logAgentEvent({
      intent: classification.intent,
      mode: route.mode,
      strategy: plan.strategy,
      ok: true,
      handled: false,
      ragChunks: retrieval.chunks.length,
      latencyMs: elapsed?.(),
    });

    return {
      handled: false,
      classification,
      plan,
      route,
      memory,
      ragContext,
      systemAddon: `${systemAddon}\n${fluencySystemAddon({ intent: classification.intent, hasEvidence: retrieval.chunks.length > 0 })}\n\n### BRSR retrieved context\n${ragContext}`,
      orchestrator: state.orchestrator || 'imperative',
    };
  }

  memory = saveTurnMemory(key, {
    classification,
    plan,
    route,
    assumptions: classification.assumptions,
  });

  logAgentEvent({
    intent: classification.intent,
    mode: route.mode,
    strategy: plan.strategy,
    ok: true,
    handled: false,
    latencyMs: elapsed?.(),
  });

  return {
    handled: false,
    classification,
    plan,
    route,
    memory,
    systemAddon,
    orchestrator: state.orchestrator || 'imperative',
  };
}
