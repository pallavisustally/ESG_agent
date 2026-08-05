/**
 * Knowledge Engine wrapper — glossary / definitions.
 */

import { buildKnowledgeAnswer } from '../../capability/knowledge-engine.js';
import { createEngineResponse } from '../engine-response.js';
import { EXECUTION_ENGINES } from '../execution-plan.js';

export async function runKnowledgeEngine(ctx = {}) {
  if (!ctx.executionPlan?.needsKnowledge && !ctx.force) {
    return createEngineResponse({
      engine: EXECUTION_ENGINES.KNOWLEDGE,
      ok: false,
      text: '',
      error: 'knowledge_not_required',
    });
  }
  try {
    const text = buildKnowledgeAnswer(ctx.userMessage || '');
    return createEngineResponse({
      engine: EXECUTION_ENGINES.KNOWLEDGE,
      ok: Boolean(text),
      text: text || '',
      dataText: text || '',
      confidence: 0.9,
    });
  } catch (err) {
    return createEngineResponse({
      engine: EXECUTION_ENGINES.KNOWLEDGE,
      ok: false,
      text: 'I could not load that ESG definition right now. Try a common term like Scope 1, ESG, or BRSR.',
      error: String(err?.message || err),
    });
  }
}
