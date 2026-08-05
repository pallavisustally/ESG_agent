/**
 * Recommendation Engine wrapper — company-specific improvement suggestions.
 * Grounded in verified analytics / peers / sector when available.
 * Failures are soft: never throw — orchestrator continues with analytics.
 */

import { buildRecommendationAnswer } from '../../capability/recommendation-engine.js';
import { createEngineResponse } from '../engine-response.js';
import { EXECUTION_ENGINES } from '../execution-plan.js';

export async function runRecommendationEngine(ctx = {}) {
  if (!ctx.executionPlan?.needsRecommendation && !ctx.force) {
    return createEngineResponse({
      engine: EXECUTION_ENGINES.RECOMMENDATION,
      ok: false,
      text: '',
      error: 'recommendation_not_required',
    });
  }

  try {
    if (ctx.signal?.aborted) {
      return createEngineResponse({
        engine: EXECUTION_ENGINES.RECOMMENDATION,
        ok: false,
        text: '',
        error: 'recommendation_aborted',
      });
    }

    const companies = ctx.executionPlan?.entities
      || ctx.classification?.entities
      || [];
    const metric = ctx.executionPlan?.metrics?.[0]
      || ctx.classification?.metric
      || ctx.analyticsData?.metric
      || null;

    const built = await buildRecommendationAnswer(ctx.userMessage || '', {
      companies,
      dataText: ctx.priorDataText || null,
      metric,
      analyticsData: ctx.analyticsData || null,
      peerData: ctx.peerData || null,
      sectorData: ctx.sectorData || null,
      fetchSector: true,
      signal: ctx.signal || null,
    });

    const text = typeof built === 'string' ? built : built.text;
    const grounding = typeof built === 'object' ? built.grounding : null;
    const assumptions = typeof built === 'object' ? (built.assumptions || []) : [];
    const companySpecific = Boolean(grounding?.companySpecific);

    return createEngineResponse({
      engine: EXECUTION_ENGINES.RECOMMENDATION,
      ok: Boolean(text),
      text: text || '',
      recommendations: text || '',
      dataText: text || '',
      assumptions,
      dataset: grounding?.facts?.length
        ? { facts: grounding.facts, companySpecific }
        : null,
      confidence: companySpecific ? 0.85 : (ctx.priorDataText ? 0.6 : 0.5),
    });
  } catch (err) {
    return createEngineResponse({
      engine: EXECUTION_ENGINES.RECOMMENDATION,
      ok: false,
      text: '',
      error: String(err?.message || err || 'recommendation_failed'),
    });
  }
}
