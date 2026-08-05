/**
 * Guidance Engine wrapper — sustainability best practices.
 */

import { buildGuidanceAnswer } from '../../capability/guidance-engine.js';
import { createEngineResponse } from '../engine-response.js';
import { EXECUTION_ENGINES } from '../execution-plan.js';

export async function runGuidanceEngine(ctx = {}) {
  if (!ctx.executionPlan?.needsGuidance && !ctx.force) {
    return createEngineResponse({
      engine: EXECUTION_ENGINES.GUIDANCE,
      ok: false,
      text: '',
      error: 'guidance_not_required',
    });
  }
  const text = await buildGuidanceAnswer(ctx.userMessage || '');
  return createEngineResponse({
    engine: EXECUTION_ENGINES.GUIDANCE,
    ok: Boolean(text),
    text,
    dataText: text,
    confidence: 0.85,
  });
}
