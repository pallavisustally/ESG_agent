/**
 * Phase 13 — Optional small planning model (JSON-only).
 *
 * Responsibilities: intent, entity extraction, follow-up, clarification, tool selection.
 * Does NOT answer the user question. Response model still explains verified results.
 *
 * Enable: PLANNING_MODEL_ENABLED=true
 * Falls back to rules classifyIntent + planQuery when disabled / failed / low confidence.
 */

import { callOllamaChat, getOllamaConfig } from '../ollama-client.js';
import { logAgentEvent, startTimer } from '../observability/agent-logger.js';
import { classifyIntent, INTENTS } from '../intent/classify-intent.js';
import {
  CANONICAL_INTENTS,
  mapCanonicalToLegacy,
  normalizeCanonicalIntent,
} from '../intent/canonical-intents.js';
import { planQuery, TOOLS } from './plan-query.js';

const PLANNING_MIN_CONFIDENCE = Number(process.env.PLANNING_MODEL_MIN_CONFIDENCE || 0.6);
const PLANNING_TIMEOUT_MS = Number(process.env.PLANNING_MODEL_TIMEOUT_MS || 10000);

export function isPlanningModelEnabled() {
  const flag = process.env.PLANNING_MODEL_ENABLED;
  if (flag == null || flag === '') return false;
  return flag === '1' || /^true$/i.test(flag);
}

const SYSTEM = `You are a BRSR query planner. Output ONLY valid JSON (no markdown).
Do not answer the user's question. Only extract planning fields.

Schema:
{
  "intent": one of ${Object.keys(CANONICAL_INTENTS).join('|')},
  "metric": string|null (snake_case schema metric e.g. scope1_emissions),
  "companies": string[],
  "years": number[],
  "tool": "SQL"|"RAG"|"HYBRID"|"NONE",
  "followUp": boolean,
  "needsClarification": boolean,
  "clarification": string|null,
  "confidence": number 0-1
}

Rules:
- Carbon / Scope emissions / rankings / counts / compares → tool SQL
- How to reduce / control / mitigate → intent HOW_TO, tool RAG (never SQL ranking)
- Follow-ups that omit companies/metric may set followUp true
- If ambiguous, needsClarification true and lower confidence`;

function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeTool(raw) {
  const t = String(raw || '').toUpperCase();
  if (t === 'SQL') return TOOLS.SQL;
  if (t === 'RAG') return TOOLS.RAG;
  if (t === 'HYBRID') return TOOLS.HYBRID;
  if (t === 'NONE') return 'NONE';
  return null;
}

/**
 * Call optional planning model. Returns null when disabled or unusable.
 */
export async function callPlanningModel(userMessage, memory = null) {
  if (!isPlanningModelEnabled()) return null;

  const elapsed = startTimer();
  const historyHint = memory?.lastIntent
    ? `Prior turn: intent=${memory.lastIntent}, companies=${JSON.stringify(memory.lastCompanies || [])}, metric=${memory.lastMetric || 'null'}, year=${memory.lastYear || 'null'}`
    : 'No prior turn context.';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLANNING_TIMEOUT_MS);

  try {
    const cfg = getOllamaConfig();
    // Prefer a smaller/faster model when configured; else reuse chat model.
    const model = process.env.PLANNING_MODEL
      || process.env.INTENT_LLM_MODEL
      || cfg.model;
    const url = cfg.host ? `${cfg.host}/api/chat` : null;

    const message = await callOllamaChat({
      url,
      model,
      fallbackModels: cfg.fallbackModels,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `${historyHint}\n\nUser: ${userMessage}` },
      ],
      tools: [],
      options: {
        ...cfg.options,
        temperature: 0,
        num_predict: Math.min(256, cfg.options?.num_predict || 256),
      },
      keepAlive: cfg.keepAlive,
      stream: false,
      signal: controller.signal,
    });

    const parsed = extractJson(message?.content || '');
    if (!parsed || typeof parsed !== 'object') {
      logAgentEvent({
        stage: 'planning_model',
        ok: false,
        reason: 'invalid_json',
        latencyMs: elapsed(),
      });
      return null;
    }

    const confidence = Number(parsed.confidence);
    if (!Number.isFinite(confidence) || confidence < PLANNING_MIN_CONFIDENCE) {
      logAgentEvent({
        stage: 'planning_model',
        ok: false,
        reason: 'low_confidence',
        confidence,
        latencyMs: elapsed(),
      });
      return null;
    }

    const canonical = normalizeCanonicalIntent(parsed.intent);
    const legacy = mapCanonicalToLegacy(canonical) || INTENTS.UNKNOWN;
    const tool = normalizeTool(parsed.tool);

    const planJson = {
      intent: legacy,
      canonicalIntent: canonical,
      metric: parsed.metric || null,
      companies: Array.isArray(parsed.companies) ? parsed.companies.filter(Boolean) : [],
      years: Array.isArray(parsed.years) ? parsed.years.map(Number).filter(Number.isFinite) : [],
      tool,
      followUp: Boolean(parsed.followUp),
      needsClarification: Boolean(parsed.needsClarification),
      clarification: parsed.clarification || null,
      confidence,
      source: 'planning_model',
    };

    logAgentEvent({
      stage: 'planning_model',
      ok: true,
      intent: planJson.intent,
      tool: planJson.tool,
      confidence,
      latencyMs: elapsed(),
    });

    return planJson;
  } catch (err) {
    logAgentEvent({
      stage: 'planning_model',
      ok: false,
      reason: err?.name === 'AbortError' ? 'planning_model_timeout' : (err?.message || 'planning_model_error'),
      latencyMs: elapsed(),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Merge planning-model JSON into a classification + optional plan hint.
 * Always safe to ignore — rules path remains authoritative when merge fails.
 */
export function mergePlanningModelIntoClassification(rulesClassification, planJson) {
  if (!planJson || !rulesClassification) return rulesClassification;

  const next = {
    ...rulesClassification,
    filters: { ...(rulesClassification.filters || {}) },
    entities: [...(rulesClassification.entities || [])],
  };

  // Prefer planning model only when confidence is high and rules didn't hard-lock guidance/unsupported.
  if (planJson.confidence >= PLANNING_MIN_CONFIDENCE) {
    if (planJson.intent && planJson.intent !== INTENTS.UNKNOWN) {
      // Never override HOW_TO / guidance with ranking from the model.
      if (rulesClassification.intent !== INTENTS.HOW_TO) {
        next.intent = planJson.intent;
        next.canonicalIntent = planJson.canonicalIntent || next.canonicalIntent;
      }
    }
    if (planJson.companies?.length && !next.entities.length) {
      next.entities = planJson.companies;
    }
    if (planJson.metric && !next.metric) {
      next.metric = planJson.metric;
      next.filters.metric = planJson.metric;
    }
    if (planJson.years?.length && !next.filters.years?.length) {
      next.filters.years = planJson.years;
    }
    if (planJson.needsClarification && planJson.clarification) {
      next.clarification = planJson.clarification;
      next.filters.needsClarification = true;
    }
    next.confidence = Math.max(next.confidence || 0, planJson.confidence);
    next.planningModel = {
      tool: planJson.tool,
      confidence: planJson.confidence,
      source: 'planning_model',
    };
  }

  return next;
}

/**
 * Optional entry: try planning model, else rules classification + planQuery.
 */
export async function planWithOptionalModel(userMessage, memory = null) {
  const rules = classifyIntent(userMessage, memory);
  const planJson = await callPlanningModel(userMessage, memory);
  const classification = planJson
    ? mergePlanningModelIntoClassification(rules, planJson)
    : rules;
  const plan = planQuery(classification, memory);
  return { classification, plan, planningModel: planJson };
}

export { PLANNING_MIN_CONFIDENCE };
