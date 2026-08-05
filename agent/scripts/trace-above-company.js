/**
 * Runtime stage tracer for the Infosys → "above company" follow-up.
 * Prints PASS/FAIL I/O for each requested function. No fixes.
 */
import 'dotenv/config';
import { pathToFileURL } from 'url';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../src');

function dump(label, value) {
  console.log(`\n===== ${label} =====`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function slimClassification(c) {
  if (!c) return null;
  return {
    intent: c.intent,
    canonicalIntent: c.canonicalIntent,
    entities: c.entities,
    metric: c.metric,
    metrics: c.metrics,
    metricResolution: c.metricResolution,
    confidence: c.confidence,
    source: c.source,
    wantsAll: c.wantsAll,
    clarification: c.clarification || null,
    assumptions: c.assumptions || [],
    filters: {
      followUpCompanies: c.filters?.followUpCompanies || false,
      needsPriorCompanies: c.filters?.needsPriorCompanies || false,
      years: c.filters?.years || null,
      metrics: c.filters?.metrics || null,
      metric: c.filters?.metric || null,
      priorIntent: c.filters?.priorIntent || null,
    },
  };
}

function slimMemory(m) {
  if (!m) return null;
  return {
    lastIntent: m.lastIntent,
    lastCompanies: m.lastCompanies,
    lastMetric: m.lastMetric,
    lastYear: m.lastYear,
    entities: m.entities,
    pendingRequest: m.pendingRequest ? { metric: m.pendingRequest.metric } : null,
    comparisonContext: m.comparisonContext,
  };
}

async function main() {
  const {
    extractIntentAndEntities,
  } = await import(pathToFileURL(path.join(root, 'intent/extract-intent.js')).href);
  const {
    refersToPriorCompanies,
    validatePriorCompanyReference,
    getPriorCompanyList,
  } = await import(pathToFileURL(path.join(root, 'intent/conversation-context.js')).href);
  const {
    applyMemoryToClassification,
    getMemory,
    updateMemory,
    memoryKeyFromRequest,
    createEmptyMemory,
  } = await import(pathToFileURL(path.join(root, 'memory/conversation-memory.js')).href);
  const { resolveMetricState } = await import(pathToFileURL(path.join(root, 'intent/metric-resolution.js')).href);
  const { canonicalizeEntities } = await import(pathToFileURL(path.join(root, 'sql-agent/company-resolve.js')).href);
  const { getCompanyList } = await import(pathToFileURL(path.join(root, 'db.js')).href);
  const { planQuery } = await import(pathToFileURL(path.join(root, 'planner/plan-query.js')).href);
  const { routeTools } = await import(pathToFileURL(path.join(root, 'router/tool-router.js')).href);
  const { runImperativePipeline } = await import(pathToFileURL(path.join(root, 'pipeline/run-pipeline.js')).href);
  const { classifyIntent, isAnaphoricMetricLookup, extractMetrics } = await import(
    pathToFileURL(path.join(root, 'intent/classify-intent.js')).href
  );

  // Monkey-patch extractCompanyCandidates visibility via classifyIntent side effects
  // by also importing and wrapping key calls.

  const sessionId = `trace_${Date.now()}`;
  const turn1 =
    'Analyze the Scope 1 and Scope 2 emissions trend for Infosys Limited from 2025 to 2026.';
  const turn2 =
    'What are the female and male employee counts of the above company?';

  dump('SETUP', { sessionId, turn1, turn2 });

  // ---- TURN 1 ----
  console.log('\n\n########## TURN 1 ##########');
  const r1 = await runImperativePipeline({
    userMessage: turn1,
    chatHistory: [],
    sessionId,
  });
  const key = memoryKeyFromRequest({ sessionId, chatHistory: [], userMessage: turn1 });
  // After turn1, memory key is session-based so get with sessionId
  const keySession = `session:${sessionId}`;
  const memAfter1 = getMemory(keySession);
  dump('TURN1 pipeline summary', {
    handled: r1.handled,
    responseSource: r1.responseSource,
    textPreview: String(r1.text || '').slice(0, 240),
    classification: slimClassification(r1.classification),
    plan: r1.plan && {
      strategy: r1.plan.strategy,
      entities: r1.plan.entities,
      metric: r1.plan.metric,
      primaryTool: r1.plan.primaryTool,
    },
    memoryKey: keySession,
    memoryAfterTurn1: slimMemory(memAfter1),
  });

  // ---- TURN 2 staged ----
  console.log('\n\n########## TURN 2 — STAGE TRACE ##########');
  const chatHistory = [
    { role: 'user', content: turn1 },
    { role: 'assistant', content: r1.text || 'ok' },
  ];
  const memoryBefore = getMemory(keySession);
  dump('memory BEFORE turn2 (input to stages)', slimMemory(memoryBefore));

  // 1. refersToPriorCompanies
  const refers = refersToPriorCompanies(turn2);
  dump('Stage: refersToPriorCompanies', {
    file: 'agent/src/intent/conversation-context.js',
    input: { text: turn2 },
    output: refers,
    verdict: refers ? 'PASS' : 'FAIL',
  });

  // 2. resolveMetricState
  const metricState = resolveMetricState(turn2);
  dump('Stage: resolveMetricState', {
    file: 'agent/src/intent/metric-resolution.js',
    input: { userMessage: turn2 },
    output: metricState,
    verdict: metricState?.metrics?.includes?.('female_employee_count')
      || metricState?.metric === 'female_employee_count'
      || metricState?.metric === 'male_employee_count'
      || (metricState?.metrics || []).some((m) => /employee_count/.test(m))
      ? 'PASS'
      : 'FAIL',
  });
  dump('extractMetrics(turn2)', extractMetrics(turn2));

  // 3. validatePriorCompanyReference / prior list
  const priorCheck = validatePriorCompanyReference(turn2, memoryBefore);
  dump('Stage: validatePriorCompanyReference', {
    file: 'agent/src/intent/conversation-context.js',
    input: { userMessage: turn2, memory: slimMemory(memoryBefore) },
    output: priorCheck,
    verdict: priorCheck.refersToPrior && priorCheck.ok && priorCheck.companies.includes('Infosys Limited')
      ? 'PASS'
      : (priorCheck.refersToPrior ? 'PARTIAL' : 'FAIL'),
  });
  dump('getPriorCompanyList', getPriorCompanyList(memoryBefore));
  dump('isAnaphoricMetricLookup', {
    input: { text: turn2, memoryLastCompanies: memoryBefore.lastCompanies },
    output: isAnaphoricMetricLookup(turn2, memoryBefore),
  });

  // 4. classifyIntent (rules path detail) — shows entity preference bug
  const rulesOnly = classifyIntent(turn2, memoryBefore);
  dump('Stage: classifyIntent (rules, inside extractIntentAndEntities)', {
    file: 'agent/src/intent/classify-intent.js',
    input: {
      userMessage: turn2,
      memory: slimMemory(memoryBefore),
      note: 'resolvedEntities = entities.length ? entities : priorEntities',
    },
    output: slimClassification(rulesOnly),
    verdict: (rulesOnly.entities || []).includes('Infosys Limited') ? 'PASS' : 'FAIL',
  });

  // 5. extractIntentAndEntities
  const extracted = await extractIntentAndEntities(turn2, memoryBefore);
  dump('Stage: extractIntentAndEntities', {
    file: 'agent/src/intent/extract-intent.js',
    input: { userMessage: turn2, memory: slimMemory(memoryBefore) },
    output: slimClassification(extracted),
    verdict: (extracted.entities || []).includes('Infosys Limited') ? 'PASS' : 'FAIL',
  });

  // 6. applyMemoryToClassification
  // Mirror stageIntent: first apply resolveMetricState onto classification
  let classification = {
    ...extracted,
    metricResolution: metricState.state,
    metric: metricState.metric || extracted.metric,
    metrics: metricState.metrics?.length ? metricState.metrics : extracted.metrics,
    filters: {
      ...(extracted.filters || {}),
      metricResolution: metricState.state,
      ...(metricState.metric ? { metric: metricState.metric } : {}),
    },
  };
  const afterMemory = applyMemoryToClassification(classification, memoryBefore, turn2);
  dump('Stage: applyMemoryToClassification', {
    file: 'agent/src/memory/conversation-memory.js',
    input: {
      classification: slimClassification(classification),
      memory: slimMemory(memoryBefore),
      userMessage: turn2,
    },
    output: slimClassification(afterMemory),
    verdict: (afterMemory.entities || []).includes('Infosys Limited') ? 'PASS' : 'FAIL',
  });

  // 7. canonicalizeEntities
  const beforeCanon = [...(afterMemory.entities || [])];
  const afterCanon = beforeCanon.length
    ? await canonicalizeEntities(beforeCanon, getCompanyList)
    : [];
  dump('Stage: canonicalizeEntities', {
    file: 'agent/src/sql-agent/company-resolve.js',
    input: beforeCanon,
    output: afterCanon,
    verdict: afterCanon.includes('Infosys Limited')
      ? 'PASS'
      : (beforeCanon.includes('Infosys Limited') ? 'FAIL_REMOVED' : 'FAIL_ALREADY_MISSING'),
  });

  let plannedClass = { ...afterMemory, entities: afterCanon.length ? afterCanon : afterMemory.entities };

  // 8. planQuery
  const plan = planQuery(plannedClass, memoryBefore, { userMessage: turn2 });
  dump('Stage: planQuery', {
    file: 'agent/src/planner/plan-query.js',
    input: {
      classification: slimClassification(plannedClass),
      memory: slimMemory(memoryBefore),
    },
    output: {
      intent: plan.intent,
      strategy: plan.strategy,
      primaryTool: plan.primaryTool,
      entities: plan.entities,
      metric: plan.metric,
      filters: plan.filters,
      reason: plan.reason,
    },
    verdict: (plan.entities || []).includes('Infosys Limited') ? 'PASS' : 'FAIL',
  });

  // 9. routeTools
  const route = routeTools(plan, plannedClass);
  dump('Stage: routeTools', {
    file: 'agent/src/router/tool-router.js',
    input: { planStrategy: plan.strategy, planEntities: plan.entities },
    output: route,
    verdict: route?.mode ? 'PASS' : 'FAIL',
  });

  // 10. Full pipeline turn2 (includes executeRoutedBranches)
  console.log('\n\n########## TURN 2 — FULL PIPELINE (executeRoutedBranches) ##########');
  const r2 = await runImperativePipeline({
    userMessage: turn2,
    chatHistory,
    sessionId,
  });
  dump('Stage: executeRoutedBranches / full pipeline result', {
    file: 'agent/src/pipeline/pipeline-execute.js',
    input: { userMessage: turn2, sessionId, chatHistoryLength: chatHistory.length },
    output: {
      handled: r2.handled,
      responseSource: r2.responseSource,
      text: r2.text,
      classification: slimClassification(r2.classification),
      plan: r2.plan && {
        strategy: r2.plan.strategy,
        entities: r2.plan.entities,
        metric: r2.plan.metric,
        primaryTool: r2.plan.primaryTool,
      },
      route: r2.route,
      sql: r2.sqlResult && {
        ok: r2.sqlResult.ok,
        sql: r2.sqlResult.sql || r2.sqlResult.data?.sql || r2.sqlResult.query,
        textPreview: String(r2.sqlResult.text || '').slice(0, 300),
        data: r2.sqlResult.data && {
          missing: r2.sqlResult.data.missing,
          resolved: r2.sqlResult.data.resolved,
          ambiguous: r2.sqlResult.data.ambiguous,
        },
      },
      memoryAfter: slimMemory(getMemory(keySession)),
    },
    verdict: /Could not resolve companies/i.test(r2.text || '') ? 'FAIL' : 'PASS',
  });

  // Final answers
  const extractedHadInfosys = (extracted.entities || []).includes('Infosys Limited');
  const memoryHadInfosys = (memoryBefore.lastCompanies || []).includes('Infosys Limited')
    || (memoryBefore.entities || []).includes('Infosys Limited');
  const afterMemoryHadInfosys = (afterMemory.entities || []).includes('Infosys Limited');
  const afterCanonHadInfosys = afterCanon.includes('Infosys Limited');
  const planHadInfosys = (plan.entities || []).includes('Infosys Limited');

  let firstLoss = null;
  if (!memoryHadInfosys) firstLoss = 'memory empty before turn2 (saveTurnMemory / turn1 did not persist Infosys)';
  else if (!extractedHadInfosys) {
    firstLoss = 'classifyIntent/extractIntentAndEntities — prefers extractCompanyCandidates garbage over priorEntities (Infosys never injected into classification.entities)';
  } else if (!afterMemoryHadInfosys) firstLoss = 'applyMemoryToClassification';
  else if (beforeCanon.includes('Infosys Limited') && !afterCanonHadInfosys) firstLoss = 'canonicalizeEntities';
  else if (!planHadInfosys) firstLoss = 'planQuery';
  else firstLoss = 'executeRoutedBranches / later';

  dump('FINAL ANSWERS', {
    q1_above_company_detected: refers,
    q2_memory_contained_Infosys_Limited: memoryHadInfosys,
    q2_memory_value: slimMemory(memoryBefore),
    q3_Infosys_injected_into_classification: extractedHadInfosys || afterMemoryHadInfosys,
    q3_entities_after_extract: extracted.entities,
    q3_entities_after_applyMemory: afterMemory.entities,
    q4_canonicalization_removed_it: beforeCanon.includes('Infosys Limited') && !afterCanonHadInfosys,
    q4_beforeCanon: beforeCanon,
    q4_afterCanon: afterCanon,
    q5_planning_lost_it: afterCanonHadInfosys && !planHadInfosys,
    q5_plan_entities: plan.entities,
    q6_FIRST_place_company_disappears: firstLoss,
  });
}

main().catch((err) => {
  console.error('TRACE FAILED', err);
  process.exit(1);
});
