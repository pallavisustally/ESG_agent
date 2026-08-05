/**
 * Compliance Engine wrapper — frameworks / principles.
 */

import { buildComplianceAnswer } from '../../capability/compliance-engine.js';
import { createEngineResponse } from '../engine-response.js';
import { EXECUTION_ENGINES } from '../execution-plan.js';

export async function runComplianceEngine(ctx = {}) {
  if (!ctx.executionPlan?.needsCompliance && !ctx.force) {
    return createEngineResponse({
      engine: EXECUTION_ENGINES.COMPLIANCE,
      ok: false,
      text: '',
      error: 'compliance_not_required',
    });
  }
  const text = buildComplianceAnswer(ctx.userMessage || '');
  return createEngineResponse({
    engine: EXECUTION_ENGINES.COMPLIANCE,
    ok: Boolean(text),
    text,
    dataText: text,
    confidence: 0.9,
  });
}
