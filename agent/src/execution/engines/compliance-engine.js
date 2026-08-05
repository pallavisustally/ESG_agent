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
  try {
    const text = buildComplianceAnswer(ctx.userMessage || '');
    return createEngineResponse({
      engine: EXECUTION_ENGINES.COMPLIANCE,
      ok: Boolean(text),
      text: text || '',
      dataText: text || '',
      confidence: 0.9,
    });
  } catch (err) {
    return createEngineResponse({
      engine: EXECUTION_ENGINES.COMPLIANCE,
      ok: false,
      text: 'I could not load that framework explanation right now. Try asking about BRSR, ISSB, GRI, or CSRD.',
      error: String(err?.message || err),
    });
  }
}
