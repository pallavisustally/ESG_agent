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
  const text = buildKnowledgeAnswer(ctx.userMessage || '');
  return createEngineResponse({
    engine: EXECUTION_ENGINES.KNOWLEDGE,
    ok: Boolean(text),
    text,
    dataText: text,
    confidence: 0.9,
  });
}
