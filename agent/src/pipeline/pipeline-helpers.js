/**
 * Shared helpers for imperative + LangGraph pipeline paths.
 */

import { INTENTS } from '../intent/classify-intent.js';
import {
  updateMemory,
  buildStructuredMemoryPatch,
} from '../memory/conversation-memory.js';

/**
 * Build system-prompt additives from plan/intent (BRSR-grounded rules).
 */
export function buildIntentPromptAddon(classification, plan, route) {
  const lines = [
    '',
    '### Runtime intent routing (authoritative)',
    `- Intent: ${classification.intent} (confidence ${classification.confidence})`,
    classification.canonicalIntent ? `- Canonical intent: ${classification.canonicalIntent}` : null,
    classification.source ? `- Intent source: ${classification.source}` : null,
    `- Plan: ${plan.strategy} via ${plan.primaryTool}`,
    `- Router mode: ${route.mode}; skipRag=${route.skipRag}`,
    '- Prefer SQL against the BRSR `reports` table whenever structured fields answer the question.',
    '- Never invent company names or metrics. Never silently truncate when the user asked for ALL — paginate and point to /api/companies?format=csv.',
    '- Use RAG/narrative fields only for qualitative BRSR text (GHG projects, waste practices, ZLD), not for rankings or full company lists.',
  ].filter(Boolean);
  if (classification.wantsAll || classification.intent === INTENTS.LIST_ALL_COMPANIES) {
    lines.push('- USER REQUESTED ALL COMPANY NAMES: do not answer with a tiny sample. Use pagination + CSV export.');
  }
  if (classification.entities?.length) {
    lines.push(`- Entity hints: ${classification.entities.join(', ')}`);
  }
  if (classification.filters && Object.keys(classification.filters).length) {
    lines.push(`- Filters: ${JSON.stringify(classification.filters)}`);
  }
  if (classification.assumptions?.length) {
    lines.push(`- Assumptions to disclose: ${classification.assumptions.join(' | ')}`);
  }
  return lines.join('\n');
}

export function saveTurnMemory(key, {
  classification,
  plan,
  route,
  data = null,
  patch = {},
  assumptions = [],
}) {
  const structured = buildStructuredMemoryPatch({
    classification,
    plan,
    route,
    data,
    patch,
    assumptions,
  });
  return updateMemory(key, {
    ...patch,
    ...structured,
    // Never persist execution plan / tool / response for reuse.
    lastPlan: null,
    lastTool: null,
    lastResultSummary: null,
  });
}
