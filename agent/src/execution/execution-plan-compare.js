/**
 * Parallel comparison: ExecutionPlan vs legacy Tool Plan + Capability Plan.
 *
 * Phase 3 — observe only. Never changes production routing.
 */

/**
 * Compare a new ExecutionPlan against legacy pipeline artifacts.
 *
 * @param {object} executionPlan
 * @param {object} legacy
 * @param {object} [legacy.capabilityPlan]
 * @param {object} [legacy.plan] - tool plan from planQuery
 * @param {object} [legacy.route] - from routeTools (optional)
 * @param {object} [legacy.classification]
 * @returns {{ match: boolean, differences: object[], summary: string }}
 */
export function compareExecutionPlanToLegacy(executionPlan, legacy = {}) {
  const differences = [];
  const capabilityPlan = legacy.capabilityPlan || legacy.plan?.capabilityPlan || null;
  const toolPlan = legacy.plan || null;
  const route = legacy.route || null;
  const classification = legacy.classification || null;

  // Capability set
  const legacyCaps = [...(capabilityPlan?.capabilities || [])].sort();
  const newCaps = [...(executionPlan?.capabilities || [])].sort();
  if (JSON.stringify(legacyCaps) !== JSON.stringify(newCaps)) {
    differences.push({
      field: 'capabilities',
      legacy: legacyCaps,
      execution: newCaps,
    });
  }

  const legacyPrimary = capabilityPlan?.primaryCapability || null;
  if ((executionPlan?.capability || null) !== legacyPrimary) {
    differences.push({
      field: 'primaryCapability',
      legacy: legacyPrimary,
      execution: executionPlan?.capability || null,
    });
  }

  // Intent
  const legacyIntent = toolPlan?.intent || classification?.intent || null;
  if ((executionPlan?.intent || null) !== legacyIntent) {
    differences.push({
      field: 'intent',
      legacy: legacyIntent,
      execution: executionPlan?.intent || null,
    });
  }

  // Entities
  const legacyEntities = normalizeList(toolPlan?.entities || classification?.entities || []);
  const newEntities = normalizeList(executionPlan?.entities || []);
  if (JSON.stringify(legacyEntities) !== JSON.stringify(newEntities)) {
    differences.push({
      field: 'entities',
      legacy: legacyEntities,
      execution: newEntities,
    });
  }

  // Metrics
  const legacyMetrics = normalizeList(
    toolPlan?.metrics
      || (toolPlan?.metric ? [toolPlan.metric] : null)
      || classification?.metrics
      || (classification?.metric ? [classification.metric] : []),
  );
  const newMetrics = normalizeList(executionPlan?.metrics || []);
  if (JSON.stringify(legacyMetrics) !== JSON.stringify(newMetrics)) {
    differences.push({
      field: 'metrics',
      legacy: legacyMetrics,
      execution: newMetrics,
    });
  }

  // needsSql vs legacy tool
  const legacyNeedsSql = Boolean(
    toolPlan?.primaryTool === 'SQL'
      || toolPlan?.strategy?.startsWith?.('sql_')
      || toolPlan?.strategy === 'hybrid_why_compare'
      || legacyCaps.includes('COMPANY_ANALYTICS')
      || legacyCaps.includes('BENCHMARKING'),
  );
  if (Boolean(executionPlan?.needsSql) !== legacyNeedsSql) {
    differences.push({
      field: 'needsSql',
      legacy: legacyNeedsSql,
      execution: Boolean(executionPlan?.needsSql),
    });
  }

  // needsReport
  const legacyNeedsReport = Boolean(
    legacyCaps.includes('COMPANY_REPORTS')
      || toolPlan?.strategy === 'brsr_narrative_summary'
      || toolPlan?.primaryTool === 'RAG' && (
        toolPlan?.intent === 'COMPANY_SUMMARY' || toolPlan?.intent === 'REPORT_LOOKUP'
      ),
  );
  if (Boolean(executionPlan?.needsReport) !== legacyNeedsReport) {
    differences.push({
      field: 'needsReport',
      legacy: legacyNeedsReport,
      execution: Boolean(executionPlan?.needsReport),
    });
  }

  // Visualization
  const legacyViz = Boolean(
    toolPlan?.filters?.wantsChart
      || classification?.filters?.wantsChart
      || toolPlan?.strategy === 'sql_then_chart'
      || toolPlan?.intent === 'CHART_REQUEST',
  );
  if (Boolean(executionPlan?.needsVisualization) !== legacyViz
    && Boolean(executionPlan?.visualization) !== legacyViz) {
    // Only flag when both viz flags disagree with legacy
    if (Boolean(executionPlan?.visualization) !== legacyViz) {
      differences.push({
        field: 'visualization',
        legacy: legacyViz,
        execution: Boolean(executionPlan?.visualization),
      });
    }
  }

  // Strategy family (coarse)
  const legacyFamily = legacyStrategyFamily(toolPlan, capabilityPlan, route);
  const newFamily = executionPlan?.executionStrategy || null;
  if (legacyFamily && newFamily && !strategiesCompatible(legacyFamily, newFamily)) {
    differences.push({
      field: 'executionStrategy',
      legacy: legacyFamily,
      execution: newFamily,
      legacyStrategy: toolPlan?.strategy || null,
      legacyRouteMode: route?.mode || null,
    });
  }

  // Clarification
  const legacyClarify = Boolean(
    classification?.clarification
      || classification?.filters?.needsPriorCompanies
      || route?.mode === 'clarify',
  );
  if (Boolean(executionPlan?.needsClarification) !== legacyClarify) {
    differences.push({
      field: 'needsClarification',
      legacy: legacyClarify,
      execution: Boolean(executionPlan?.needsClarification),
    });
  }

  const match = differences.length === 0;
  return {
    match,
    differences,
    summary: match
      ? 'ExecutionPlan matches legacy routing signals.'
      : `ExecutionPlan differs on ${differences.map((d) => d.field).join(', ')}.`,
  };
}

/**
 * Whether parallel Execution Planner comparison logging is enabled.
 * Default: enabled (observe-only). Set EXECUTION_PLAN_COMPARE=false to silence.
 */
export function isExecutionPlanCompareEnabled() {
  const flag = process.env.EXECUTION_PLAN_COMPARE;
  if (flag == null || flag === '') return true;
  return flag === '1' || /^true$/i.test(flag);
}

/**
 * True when Execution Planner + Orchestrator own dispatch.
 * Default: enabled. Set USE_EXECUTION_PLANNER=false to force legacy routing.
 */
export function isExecutionPlannerDispatchEnabled() {
  const flag = process.env.USE_EXECUTION_PLANNER;
  if (flag == null || flag === '') return true;
  return flag === '1' || /^true$/i.test(String(flag));
}

function legacyStrategyFamily(toolPlan, capabilityPlan, route) {
  if (route?.mode === 'clarify') return 'clarify';
  if (shouldLegacyCapabilityExecutor(capabilityPlan)) {
    const caps = capabilityPlan.capabilities || [];
    if (caps.includes('RECOMMENDATION')) return 'recommendation';
    if (caps.includes('DOCUMENT_GENERATION') && caps.length === 1) return 'document';
    if (caps.includes('ESG_COMPLIANCE') && caps.length === 1) return 'compliance';
    if (caps.includes('ESG_KNOWLEDGE') && caps.length === 1) return 'knowledge';
    if (caps.includes('ESG_GUIDANCE') && caps.length === 1) return 'guidance';
    if (caps.length > 1) return 'hybrid';
  }
  const strategy = toolPlan?.strategy || '';
  if (strategy.startsWith('sql_') || strategy === 'sql_then_chart') return 'analytics';
  if (strategy === 'hybrid_why_compare' || strategy === 'follow_up_from_memory') return 'hybrid';
  if (strategy === 'brsr_narrative_summary') return 'report';
  if (strategy === 'informational_definition') return 'knowledge';
  if (strategy === 'guidance_templates') return 'guidance';
  if (strategy === 'llm_tool_loop' || route?.mode === 'llm_tools') return 'llm_fallback';
  if (strategy === 'unsupported_metric') return 'unsupported';
  return route?.mode === 'deterministic_sql' ? 'analytics'
    : route?.mode === 'rag' ? 'knowledge'
      : route?.mode === 'hybrid' ? 'hybrid'
        : null;
}

function shouldLegacyCapabilityExecutor(capabilityPlan) {
  if (!capabilityPlan?.capabilities?.length) return false;
  if (capabilityPlan.multi) return true;
  const copilot = new Set([
    'ESG_KNOWLEDGE',
    'ESG_GUIDANCE',
    'ESG_COMPLIANCE',
    'DOCUMENT_GENERATION',
    'RECOMMENDATION',
  ]);
  return copilot.has(capabilityPlan.capabilities[0]);
}

function strategiesCompatible(legacyFamily, newFamily) {
  if (legacyFamily === newFamily) return true;
  // Soft equivalences during transition
  const soft = {
    analytics: ['hybrid'],
    hybrid: ['analytics', 'recommendation', 'report'],
    recommendation: ['hybrid', 'analytics'],
    report: ['hybrid', 'analytics'],
    knowledge: ['llm_fallback'],
    guidance: ['llm_fallback'],
    llm_fallback: ['knowledge', 'guidance', 'unsupported'],
    unsupported: ['report', 'llm_fallback', 'hybrid'],
  };
  return (soft[legacyFamily] || []).includes(newFamily);
}

function normalizeList(list) {
  return [...(list || [])].map(String).filter(Boolean).sort((a, b) => a.localeCompare(b));
}
