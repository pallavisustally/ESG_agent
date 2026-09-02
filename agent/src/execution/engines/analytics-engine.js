/**
 * Analytics Engine — thin wrapper over SQL Agent (+ rankings/compare/trend/sector/viz).
 * Does not invent routing; follows ExecutionPlan + synthesized tool plan.
 */

import { runSqlAgent } from '../../sql-agent/sql-agent.js';
import { runHybridWhy, shouldRunHybridWhy } from '../../pipeline/hybrid-why.js';
import { createEngineResponse } from '../engine-response.js';
import { toolPlanFromExecutionPlan } from '../tool-plan-from-execution.js';
import { EXECUTION_ENGINES } from '../execution-plan.js';
import {
  buildNoDataAnswer,
} from '../../answers/no-data-template.js';

/**
 * @param {object} ctx
 * @param {import('../execution-plan.js').ExecutionPlan} ctx.executionPlan
 * @param {object} ctx.classification
 * @param {object|null} ctx.memory
 * @param {object|null} [ctx.toolPlan]
 * @param {Function|null} [ctx.onProgress]
 */
export async function runAnalyticsEngine(ctx = {}) {
  const executionPlan = ctx.executionPlan;
  if (!executionPlan?.needsSql) {
    return createEngineResponse({
      engine: EXECUTION_ENGINES.ANALYTICS,
      ok: false,
      text: '',
      error: 'analytics_not_required',
    });
  }

  const plan = ctx.toolPlan || toolPlanFromExecutionPlan(executionPlan, ctx.classification);
  ctx.onProgress?.({
    status: 'tool_start',
    tool: 'analytics_engine',
    message: 'Querying BRSR structured reports…',
  });

  try {
    // Causal compare ("why is X higher…") — reuse hybrid-why (SQL + narrative).
    if (
      plan?.strategy === 'hybrid_why_compare'
      || ctx.classification?.filters?.hybridWhy
      || shouldRunHybridWhy(ctx.classification, ctx.userMessage || '', ctx.memory)
    ) {
      try {
        const hybrid = await runHybridWhy({
          companies: plan.entities || executionPlan.entities || ctx.classification?.entities || [],
          metric: plan.metric || executionPlan.metrics?.[0] || ctx.classification?.metric,
          metrics: plan.metrics || executionPlan.metrics || null,
          year: plan.filters?.years?.[0] || executionPlan.years?.[0] || null,
          userMessage: ctx.userMessage || '',
        });
        if (hybrid?.ok && hybrid.text) {
          return createEngineResponse({
            engine: EXECUTION_ENGINES.ANALYTICS,
            ok: true,
            text: hybrid.text,
            dataText: hybrid.text,
            data: hybrid.data || hybrid,
            confidence: 0.8,
          });
        }
      } catch {
        // fall through to structured SQL
      }
    }

    const sqlResult = await runSqlAgent({
      plan,
      classification: ctx.classification,
      memory: ctx.memory,
    });
    ctx.onProgress?.({
      status: 'tool_end',
      tool: 'analytics_engine',
      message: sqlResult?.ok ? 'Analytics ready.' : 'Analytics incomplete.',
    });

    if (sqlResult?.ok && sqlResult.text) {
      return createEngineResponse({
        engine: EXECUTION_ENGINES.ANALYTICS,
        ok: true,
        text: sqlResult.text,
        dataText: sqlResult.text,
        data: sqlResult.data || sqlResult,
        assumptions: sqlResult.assumptions || [],
        confidence: executionPlan.confidence || 0.85,
        // Forward SQL memory patch unchanged — orchestrator persists it.
        memoryUpdate: sqlResult.memoryUpdate || null,
        // Visualization is already embedded in sqlResult.text via Visualization Engine
        visualization: sqlResult.chartBlock
          ? { chartBlock: sqlResult.chartBlock }
          : null,
      });
    }

    // Pure metric miss → honest no-data stub; orchestrator may add PDF excerpts.
    if (sqlResult?.error === 'metric_not_in_sql') {
      const noData = buildNoDataAnswer({
        company: sqlResult.data?.resolvedCompany,
        companies: executionPlan.entities,
        metric: sqlResult.data?.metric || executionPlan.metrics?.[0] || ctx.classification?.metric,
        year: sqlResult.data?.year || executionPlan.years?.[0],
        userMessage: ctx.userMessage,
      });
      return createEngineResponse({
        engine: EXECUTION_ENGINES.ANALYTICS,
        ok: true,
        text: noData,
        dataText: noData,
        data: { ...(sqlResult.data || {}), noData: true },
        confidence: 0.55,
        memoryUpdate: sqlResult.memoryUpdate || null,
        error: 'metric_not_in_sql',
      });
    }

    return createEngineResponse({
      engine: EXECUTION_ENGINES.ANALYTICS,
      ok: false,
      text: sqlResult?.text
        || buildNoDataAnswer({
          companies: executionPlan.entities,
          metric: executionPlan.metrics?.[0] || ctx.classification?.metric,
          year: executionPlan.years?.[0],
          userMessage: ctx.userMessage,
        }),
      data: sqlResult || null,
      error: sqlResult?.error || 'analytics_failed',
      confidence: 0.2,
    });
  } catch (err) {
    ctx.onProgress?.({
      status: 'tool_end',
      tool: 'analytics_engine',
      message: 'Analytics failed.',
    });
    return createEngineResponse({
      engine: EXECUTION_ENGINES.ANALYTICS,
      ok: false,
      text: `Analytics lookup failed: ${err?.message || err}`,
      error: String(err?.message || err),
    });
  }
}
