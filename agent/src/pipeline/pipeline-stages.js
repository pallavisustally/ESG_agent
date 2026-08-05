/**
 * Shared pipeline stages used by:
 * - imperative runBrsrPipeline (default)
 * - optional LangGraph orchestrator (USE_LANGGRAPH=true)
 *
 * Stages only coordinate existing modules — they do not invent facts.
 */

import { extractIntentAndEntities } from '../intent/extract-intent.js';
import {
  METRIC_RESOLUTION,
  resolveMetricState,
  UNSUPPORTED_METRIC_RESPONSE,
  isExecutableMetricResolution,
} from '../intent/metric-resolution.js';
import {
  validatePriorCompanyReference,
  MISSING_PRIOR_COMPANIES_CLARIFICATION,
} from '../intent/conversation-context.js';
import { buildPendingRequest } from '../intent/pending-request.js';
import { canonicalizeEntities } from '../sql-agent/company-resolve.js';
import { getCompanyList } from '../db.js';
import {
  validateCompanyCandidates,
  applyEntityPrecedenceToClassification,
} from '../intent/entity-precedence.js';
import { planAndValidate } from '../validation/plan-validator.js';
import { routeTools } from '../router/tool-router.js';
import {
  withCapabilityPlan,
  ensureAnalyticsPlan,
} from '../capability/capability-planner.js';
import {
  planExecution,
  compareExecutionPlanToLegacy,
  isExecutionPlanCompareEnabled,
  isExecutionPlannerDispatchEnabled,
} from '../execution/index.js';
import {
  getMemory,
  updateMemory,
  applyMemoryToClassification,
  memoryKeyFromRequest,
} from '../memory/conversation-memory.js';
import { collectAssumptions, assumptionsSystemAddon } from '../answers/assumptions.js';
import { fluencySystemAddon } from '../answers/templates.js';
import { noFabricationSystemAddon } from '../answers/sql-failure.js';
import { getLastDbHealth } from '../db-health.js';
import { logPipelineStage, startTimer } from '../observability/agent-logger.js';
import { buildIntentPromptAddon } from './pipeline-helpers.js';
import { isCompanyScopedDocumentFallbackEligible, resolveFallbackCompanies } from './sql-document-fallback.js';

/**
 * START / preprocessing — session memory key + load structured memory.
 */
export function stagePreprocess({ userMessage, chatHistory = [], sessionId = null, onProgress = null }) {
  const elapsed = startTimer();
  const key = memoryKeyFromRequest({ sessionId, chatHistory, userMessage });
  const memory = getMemory(key);
  return {
    userMessage,
    chatHistory,
    sessionId,
    onProgress,
    key,
    memory,
    elapsed,
    stages: ['preprocess'],
  };
}

function logPlannerDebug({
  userMessage,
  classification,
  memory,
  plan = null,
  route = null,
  sql = null,
  fallbackStage = null,
  responseSource = null,
}) {
  const extracted = {
    companies: classification?.entities || [],
    metric: classification?.metric || null,
    year: classification?.filters?.years || null,
    comparison: classification?.filters?.followUpCompanies
      || classification?.intent === 'COMPARE_COMPANIES'
      || null,
  };
  const merged = {
    companies: classification?.entities || [],
    metric: classification?.metric || null,
    year: classification?.filters?.years || memory?.lastYear || null,
    metricResolution: classification?.metricResolution || null,
    comparisonContext: memory?.comparisonContext || null,
  };
  console.log('[PlannerDebug] Current message:', userMessage);
  console.log('[PlannerDebug] Extracted entities:', JSON.stringify(extracted));
  console.log('[PlannerDebug] Metric resolution state:', classification?.metricResolution || '-');
  console.log('[PlannerDebug] Conversation memory:', JSON.stringify({
    lastIntent: memory?.lastIntent || null,
    lastCompanies: memory?.lastCompanies || memory?.entities || [],
    lastMetric: memory?.lastMetric || memory?.filters?.metric || null,
    lastYear: memory?.lastYear || null,
    comparisonContext: memory?.comparisonContext || null,
  }));
  console.log('[PlannerDebug] Merged context:', JSON.stringify(merged));
  console.log('[PlannerDebug] Pending request:', JSON.stringify(
    memory?.pendingRequest
      ? {
        intent: memory.pendingRequest.intent,
        metric: memory.pendingRequest.metric,
        year: memory.pendingRequest.year,
        metricResolution: memory.pendingRequest.metricResolution,
        userMessage: String(memory.pendingRequest.userMessage || '').slice(0, 160),
      }
      : (classification?.filters?.pendingRequest
        ? {
          intent: classification.filters.pendingRequest.intent,
          metric: classification.filters.pendingRequest.metric,
          attached: true,
        }
        : null),
  ));
  if (plan) {
    console.log('[PlannerDebug] Execution plan:', JSON.stringify({
      intent: plan.intent,
      strategy: plan.strategy,
      primaryTool: plan.primaryTool,
      metric: plan.metric,
      entities: plan.entities,
      reason: plan.reason,
    }));
  }
  if (route) {
    console.log('[PlannerDebug] Selected tool:', route.mode || plan?.primaryTool || '-');
  }
  if (sql) {
    console.log('[PlannerDebug] Generated SQL:', sql);
  }
  if (fallbackStage) {
    console.log('[PlannerDebug] Fallback stage:', fallbackStage);
  }
  if (responseSource) {
    console.log('[PlannerDebug] Final response source:', responseSource);
  }
}

/**
 * Intent + entity extraction (LLM JSON optional; rules fallback).
 *
 * Order: extract from current message → resolve metric state → merge missing memory → log.
 */
export async function stageIntent(state) {
  state.onProgress?.({ status: 'thinking', message: 'Understanding your question…' });

  // 1–2. Extract entities from the current message (rules/LLM).
  let classification = await extractIntentAndEntities(state.userMessage, state.memory);

  // 3. Authoritative metric resolution from the current message only.
  // Stages: direct schema → derived → unavailable.
  const metricState = resolveMetricState(state.userMessage, {
    metrics: classification.metrics,
    metric: isExecutableMetricResolution(classification.metricResolution)
      ? classification.metric
      : null,
  });
  classification = {
    ...classification,
    metricResolution: metricState.state,
    metric: isExecutableMetricResolution(metricState.state)
      ? metricState.metric
      : (metricState.state === METRIC_RESOLUTION.UNSUPPORTED ? null : classification.metric),
    metrics: isExecutableMetricResolution(metricState.state) ? metricState.metrics : (
      metricState.state === METRIC_RESOLUTION.UNSUPPORTED ? [] : (classification.metrics || [])
    ),
    filters: {
      ...(classification.filters || {}),
      metricResolution: metricState.state,
      ...(metricState.state === METRIC_RESOLUTION.UNSUPPORTED
        ? { unsupportedMetric: true }
        : {}),
      ...(metricState.state === METRIC_RESOLUTION.DERIVED
        ? {
          derivedMetric: true,
          derivedFrom: metricState.derived?.requires || [],
        }
        : {}),
    },
  };
  if (metricState.state === METRIC_RESOLUTION.UNSUPPORTED) {
    delete classification.filters.metric;
  } else if (isExecutableMetricResolution(metricState.state) && metricState.metric) {
    classification.filters.metric = metricState.metric;
  }

  // 4. Merge only missing context from conversation memory.
  classification = applyMemoryToClassification(classification, state.memory, state.userMessage);

  // Clear pending when this turn abandons or already resumed with named companies.
  let memory = state.memory;
  if (classification.filters?.clearPendingRequest) {
    memory = updateMemory(state.key, { pendingRequest: null });
    const { clearPendingRequest, ...restFilters } = classification.filters;
    classification = { ...classification, filters: restFilters };
  }

  // 5. Conversation context validation for anaphoric company references.
  const priorCompanyCheck = validatePriorCompanyReference(state.userMessage, memory);
  if (priorCompanyCheck.refersToPrior && !priorCompanyCheck.ok) {
    if (!classification.filters?.clarificationProvidesCompanies && !classification.filters?.resumedFromPending) {
      classification = {
        ...classification,
        entities: [],
        wantsAll: false,
        clarification: priorCompanyCheck.clarification || MISSING_PRIOR_COMPANIES_CLARIFICATION,
        filters: {
          ...(classification.filters || {}),
          needsPriorCompanies: true,
          wantsAll: false,
        },
      };
    }
  }

  logPlannerDebug({
    userMessage: state.userMessage,
    classification,
    memory,
  });

  logPipelineStage('intent_extract', {
    intent: classification.intent,
    confidence: classification.confidence,
    source: classification.source,
    companies: classification.entities,
    metric: classification.metric,
    metricResolution: classification.metricResolution,
    metricStage: metricState.stage,
    year: classification.filters?.years?.[0] || null,
    needsPriorCompanies: Boolean(classification.filters?.needsPriorCompanies),
    pendingRequest: Boolean(memory?.pendingRequest || classification.filters?.pendingRequest),
  });

  return {
    ...state,
    memory,
    classification,
    stages: [...(state.stages || []), 'intent'],
  };
}

/**
 * Company identity normalization + validated entity precedence.
 * Extract → validate → decide (validated message companies > memory on anaphora).
 */
export async function stageNormalizeEntities(state) {
  let classification = state.classification;
  const candidates = [...(classification?.entities || [])];
  try {
    const validated = await validateCompanyCandidates(candidates, getCompanyList);
    classification = applyEntityPrecedenceToClassification(classification, {
      validatedCompanies: validated,
      candidates,
      userMessage: state.userMessage,
      memory: state.memory,
    });
    if (classification?.entities?.length) {
      const canonical = await canonicalizeEntities(classification.entities, getCompanyList);
      const resolved = await validateCompanyCandidates(canonical, getCompanyList);
      if (resolved.length) {
        classification = { ...classification, entities: resolved };
      }
      // If resolve drops everything but precedence supplied memory companies, keep those.
    }
  } catch (err) {
    console.warn('[Pipeline] company canonicalize/validate failed:', err?.message || err);
  }
  logPipelineStage('entity_normalize', {
    intent: classification?.intent,
    companies: classification?.entities,
    ok: true,
  });
  return {
    ...state,
    classification,
    stages: [...(state.stages || []), 'entities'],
  };
}

/**
 * Structured planner + plan validation (max one re-plan).
 * Always builds a NEW plan — never replays memory.lastPlan (except pagination).
 */
export function stagePlanValidate(state) {
  const { classification, memory, userMessage } = state;

  // Early exit: anaphoric company ref with no stored company list.
  if (
    classification?.filters?.needsPriorCompanies
    || classification?.clarification
  ) {
    const clarification = classification.clarification
      || MISSING_PRIOR_COMPANIES_CLARIFICATION;
    // Prefer prior-company clarification over unsupported-metric when both apply.
    if (classification?.filters?.needsPriorCompanies || /previous company list/i.test(clarification)) {
      const plan = {
        intent: classification.intent,
        primaryTool: 'NONE',
        secondaryTools: [],
        strategy: 'clarify_prior_companies',
        filters: {
          ...(classification.filters || {}),
          needsPriorCompanies: true,
          wantsAll: false,
        },
        entities: [],
        metric: classification.metric || null,
        confidence: classification.confidence,
        deterministic: true,
        useRag: false,
        reason: 'Anaphoric company reference with empty conversation memory — ask for companies',
      };
      const pendingRequest = buildPendingRequest({
        userMessage,
        classification,
        plan,
      });
      const nextMemory = updateMemory(state.key, { pendingRequest });
      logPlannerDebug({ userMessage, classification, memory: nextMemory, plan });
      logPipelineStage('plan_validate', {
        intent: classification.intent,
        strategy: plan.strategy,
        tool: 'NONE',
        ok: true,
        needsPriorCompanies: true,
        companies: [],
        metric: classification.metric,
        pendingRequest: true,
      });
      return {
        ...state,
        memory: nextMemory,
        classification: {
          ...classification,
          entities: [],
          wantsAll: false,
        },
        plan,
        planValidation: { ok: true, errors: [], warnings: [], repairs: [] },
        clarification,
        replanCount: 0,
        stages: [...(state.stages || []), 'planner', 'plan_validate'],
      };
    }
  }

  // Early exit plan: unsupported for SQL schema — execute may still try company document fallback.
  // Only after direct + derived lookup have failed.
  if (
    classification?.metricResolution === METRIC_RESOLUTION.UNSUPPORTED
    || classification?.filters?.unsupportedMetric
  ) {
    const plan = {
      intent: classification.intent,
      primaryTool: 'NONE',
      secondaryTools: classification.entities?.length ? ['RAG'] : [],
      strategy: 'unsupported_metric',
      filters: {
        ...(classification.filters || {}),
        unsupportedMetric: true,
        metricResolution: METRIC_RESOLUTION.UNSUPPORTED,
      },
      entities: classification.entities || [],
      metric: null,
      confidence: classification.confidence,
      deterministic: true,
      useRag: false,
      reason: 'Unsupported structured metric — SQL skipped; company document fallback may run when companies are known',
    };
    logPlannerDebug({ userMessage, classification, memory, plan });
    logPipelineStage('plan_validate', {
      intent: classification.intent,
      strategy: plan.strategy,
      tool: plan.primaryTool,
      ok: true,
      metricResolution: METRIC_RESOLUTION.UNSUPPORTED,
      companies: classification.entities,
      metric: null,
    });
    return {
      ...state,
      classification: {
        ...classification,
        metric: null,
        metricResolution: METRIC_RESOLUTION.UNSUPPORTED,
      },
      plan,
      planValidation: { ok: true, errors: [], warnings: [], repairs: [] },
      clarification: UNSUPPORTED_METRIC_RESPONSE,
      replanCount: 0,
      stages: [...(state.stages || []), 'planner', 'plan_validate'],
    };
  }

  const planned = planAndValidate(classification, memory, { userMessage });
  let nextClassification = planned.classification;
  let plan = planned.plan;
  if (nextClassification.entities?.length) {
    plan = { ...plan, entities: nextClassification.entities };
  }
  // ESG Copilot: capability plan sits above tool planning (does not replace it).
  nextClassification = withCapabilityPlan(nextClassification, userMessage, memory);
  const capabilityPlan = nextClassification.capabilityPlan || null;
  if (capabilityPlan) {
    plan = ensureAnalyticsPlan(plan, nextClassification, capabilityPlan);
    plan = {
      ...plan,
      capabilities: capabilityPlan.capabilities,
      primaryCapability: capabilityPlan.primaryCapability,
      capabilityPlan,
    };
  }
  const planValidation = planned.validation;
  const plannerScore = planned.plannerScore || null;

  // Phase 2/3: build ExecutionPlan in parallel (observe-only). Never changes dispatch.
  const executionBuilt = planExecution({
    userMessage,
    memory,
    classification: nextClassification,
    assumptions: nextClassification.assumptions || [],
  });
  const executionPlan = executionBuilt.plan;
  let executionPlanCompare = null;
  if (isExecutionPlanCompareEnabled()) {
    executionPlanCompare = compareExecutionPlanToLegacy(executionPlan, {
      capabilityPlan,
      plan,
      classification: nextClassification,
    });
    if (!executionPlanCompare.match) {
      console.log('[ExecutionPlanCompare] DIFF', JSON.stringify({
        summary: executionPlanCompare.summary,
        differences: executionPlanCompare.differences,
        executionStrategy: executionPlan.executionStrategy,
        legacyStrategy: plan?.strategy,
        capabilities: executionPlan.capabilities,
      }));
    } else {
      console.log('[ExecutionPlanCompare] MATCH', JSON.stringify({
        strategy: executionPlan.executionStrategy,
        capabilities: executionPlan.capabilities,
        needsSql: executionPlan.needsSql,
      }));
    }
  }
  if (isExecutionPlannerDispatchEnabled()) {
    console.log('[ExecutionPlanner] Dispatch enabled — orchestrator will execute engines from ExecutionPlan.');
  }

  logPlannerDebug({
    userMessage,
    classification: nextClassification,
    memory,
    plan,
  });
  if (capabilityPlan?.capabilities?.length) {
    console.log('[PlannerDebug] Capabilities:', JSON.stringify({
      capabilities: capabilityPlan.capabilities,
      primary: capabilityPlan.primaryCapability,
      multi: capabilityPlan.multi,
      reason: capabilityPlan.reason,
    }));
  }

  logPipelineStage('plan_validate', {
    intent: nextClassification.intent,
    strategy: plan.strategy,
    tool: plan.primaryTool,
    ok: planValidation.ok,
    replanCount: planned.replanCount,
    errors: planValidation.errors,
    warnings: planValidation.warnings,
    confidence: nextClassification.confidence,
    plannerScore: plannerScore?.score,
    answerType: planValidation.answerType || planValidation.semantic?.answerType || null,
    companies: nextClassification.entities,
    metric: nextClassification.metric,
    metricResolution: nextClassification.metricResolution,
    capabilities: capabilityPlan?.capabilities || [],
    primaryCapability: capabilityPlan?.primaryCapability || null,
    executionStrategy: executionPlan?.executionStrategy || null,
    executionPlanMatch: executionPlanCompare?.match ?? null,
    latencyMs: state.elapsed?.(),
  });

  return {
    ...state,
    classification: nextClassification,
    plan,
    planValidation,
    plannerScore,
    capabilityPlan,
    executionPlan,
    executionPlanValidation: executionBuilt.validation,
    executionPlanCompare,
    clarification: planned.clarification || null,
    replanCount: planned.replanCount,
    stages: [...(state.stages || []), 'planner', 'plan_validate', 'capability_plan', 'execution_plan'],
  };
}

/**
 * Tool router from structured plan (not keyword-only).
 */
export function stageRouter(state) {
  if (state.plan?.strategy === 'clarify_prior_companies' || (
    state.clarification && state.plan?.strategy !== 'unsupported_metric'
  )) {
    const route = {
      mode: 'clarify',
      skipRag: true,
      tools: [],
      reason: 'Clarification required — waiting for company context',
    };
    logPlannerDebug({
      userMessage: state.userMessage,
      classification: state.classification,
      memory: state.memory,
      plan: state.plan,
      route,
    });
    logPipelineStage('router', {
      intent: state.classification?.intent,
      mode: route.mode,
      tool: 'NONE',
      skipRag: true,
      strategy: state.plan?.strategy,
      ok: true,
    });
    return {
      ...state,
      route,
      stages: [...(state.stages || []), 'router'],
    };
  }

  if (state.plan?.strategy === 'unsupported_metric') {
    const companies = resolveFallbackCompanies(state.classification, state.memory, null);
    const mayFallback = isCompanyScopedDocumentFallbackEligible({
      classification: state.classification,
      plan: state.plan,
      companies,
      userMessage: state.userMessage,
    });
    const route = {
      mode: mayFallback ? 'document_fallback' : 'clarify',
      skipRag: !mayFallback,
      tools: mayFallback ? ['RAG'] : [],
      reason: mayFallback
        ? 'Unsupported structured metric — company document fallback eligible'
        : 'Unsupported metric without company scope — unavailable',
    };
    logPlannerDebug({
      userMessage: state.userMessage,
      classification: state.classification,
      memory: state.memory,
      plan: state.plan,
      route,
      fallbackStage: mayFallback ? 'SQL→Derived→Narrative→PDF' : 'unavailable',
    });
    logPipelineStage('router', {
      intent: state.classification?.intent,
      mode: route.mode,
      tool: mayFallback ? 'DOCUMENT_FALLBACK' : 'NONE',
      skipRag: route.skipRag,
      strategy: state.plan?.strategy,
      ok: true,
    });
    return {
      ...state,
      route,
      stages: [...(state.stages || []), 'router'],
    };
  }

  const route = routeTools(state.plan, {
    userMessage: state.userMessage,
    classification: state.classification,
  });

  // Refresh observe-only compare once route.mode is known (still no dispatch change).
  let executionPlanCompare = state.executionPlanCompare || null;
  if (state.executionPlan && isExecutionPlanCompareEnabled()) {
    executionPlanCompare = compareExecutionPlanToLegacy(state.executionPlan, {
      capabilityPlan: state.capabilityPlan,
      plan: state.plan,
      route,
      classification: state.classification,
    });
  }

  logPlannerDebug({
    userMessage: state.userMessage,
    classification: state.classification,
    memory: state.memory,
    plan: state.plan,
    route,
  });
  logPipelineStage('router', {
    intent: state.classification?.intent,
    mode: route.mode,
    tool: state.plan?.primaryTool,
    skipRag: route.skipRag,
    strategy: state.plan?.strategy,
    ok: true,
    executionPlanMatch: executionPlanCompare?.match ?? null,
  });
  state.onProgress?.({
    status: 'thinking',
    message: state.replanCount
      ? `Adjusted plan: ${(state.classification.canonicalIntent || state.classification.intent).replace(/_/g, ' ').toLowerCase()}…`
      : `Understood intent: ${(state.classification.canonicalIntent || state.classification.intent).replace(/_/g, ' ').toLowerCase()}…`,
  });
  return {
    ...state,
    route,
    executionPlanCompare,
    stages: [...(state.stages || []), 'router'],
  };
}

/**
 * Build system addon / assumptions before tool execution.
 */
export function stagePrepareAnswerContext(state) {
  if (state.plan?.strategy === 'unsupported_metric' || state.clarification) {
    return {
      ...state,
      systemAddon: '',
      ragContext: '',
      stages: [...(state.stages || []), 'prepare_context'],
    };
  }

  const turnAssumptions = collectAssumptions({
    classification: state.classification,
    plan: state.plan,
  });
  const classification = {
    ...state.classification,
    assumptions: turnAssumptions,
  };
  const dbHealth = getLastDbHealth();
  const systemAddon = [
    buildIntentPromptAddon(classification, state.plan, state.route),
    state.planValidation?.warnings?.length
      ? `\n- Plan validation warnings: ${state.planValidation.warnings.join('; ')}`
      : '',
    state.planValidation && !state.planValidation.ok
      ? `\n- Plan validation residual issues: ${(state.planValidation.errors || []).join('; ')}`
      : '',
    assumptionsSystemAddon(turnAssumptions),
    noFabricationSystemAddon(),
    fluencySystemAddon({ intent: classification.intent, hasEvidence: false }),
    dbHealth.fallback ? '\n- Note: using local SQLite fallback (Neon was unavailable).' : '',
  ].join('\n');

  return {
    ...state,
    classification,
    systemAddon,
    ragContext: '',
    stages: [...(state.stages || []), 'prepare_context'],
  };
}

/**
 * Which execute branch the graph should take.
 */
export function selectExecuteBranch(state) {
  if (
    state.clarification
    || state.plan?.strategy === 'unsupported_metric'
    || state.plan?.strategy === 'clarify_prior_companies'
  ) return 'clarify';
  if (state.result?.handled != null) return 'done';
  const mode = state.route?.mode;
  if (mode === 'deterministic_sql') return 'sql';
  if (state.classification?.intent === 'HOW_TO'
    || (state.classification?.intent === 'GENERAL_ESG_QUESTION' && state.classification?.filters?.guidance)) {
    return 'guidance';
  }
  if (state.classification?.filters?.hybridWhy || state.classification?.intent === 'FOLLOW_UP') {
    return 'hybrid';
  }
  if (mode === 'hybrid' || mode === 'rag') return 'rag';
  return 'handoff';
}
