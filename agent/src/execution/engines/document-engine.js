/**
 * Document Engine wrapper — policy / roadmap drafts.
 */

import { buildDocumentDraft } from '../../capability/document-generation.js';
import { createEngineResponse } from '../engine-response.js';
import { EXECUTION_ENGINES } from '../execution-plan.js';

export async function runDocumentEngine(ctx = {}) {
  if (!ctx.executionPlan?.needsDocumentGeneration && !ctx.force) {
    return createEngineResponse({
      engine: EXECUTION_ENGINES.DOCUMENT,
      ok: false,
      text: '',
      error: 'document_not_required',
    });
  }
  try {
    const text = buildDocumentDraft(ctx.userMessage || '');
    return createEngineResponse({
      engine: EXECUTION_ENGINES.DOCUMENT,
      ok: Boolean(text),
      text: text || '',
      dataText: text || '',
      confidence: 0.75,
      assumptions: ['Draft template — customize before use; not the company\'s official policy.'],
    });
  } catch (err) {
    return createEngineResponse({
      engine: EXECUTION_ENGINES.DOCUMENT,
      ok: false,
      text: '',
      error: String(err?.message || err),
    });
  }
}
