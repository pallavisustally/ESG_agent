/**
 * Phase 1+2: Hybrid structured intent + entity extraction.
 *
 * Contract:
 * - LLM may only return structured JSON (never answers the question).
 * - Invalid / low-confidence / offline → deterministic classifyIntent() fallback.
 * - Downstream still receives legacy INTENTS for planner/router compatibility.
 */

import { callOllamaChat, getOllamaConfig } from '../ollama-client.js';
import { logAgentEvent, startTimer } from '../observability/agent-logger.js';
import {
  classifyIntent,
  INTENTS,
  DEFAULT_RANK_METRIC,
  extractMetrics,
  isGuidanceQuestion,
  isInformationalQuestion,
  isFollowUpExplanation,
  isAnaphoricMetricLookup,
  looksLikeCompanyCountAsk,
} from './classify-intent.js';
import {
  CANONICAL_INTENTS,
  mapCanonicalToLegacy,
  mapLegacyToCanonical,
  normalizeCanonicalIntent,
} from './canonical-intents.js';
import {
  METRIC_RESOLUTION,
  resolveMetricState,
  shouldReuseMemoryMetric,
  isExecutableMetricResolution,
} from './metric-resolution.js';
import {
  validatePriorCompanyReference,
} from './conversation-context.js';
import {
  validateCompanyCandidates,
  applyEntityPrecedenceToClassification,
} from './entity-precedence.js';

const CONFIDENCE_THRESHOLD = Number(process.env.INTENT_LLM_MIN_CONFIDENCE || 0.55);
const INTENT_TIMEOUT_MS = Number(process.env.INTENT_LLM_TIMEOUT_MS || 12000);

const METRIC_NAME_MAP = {
  scope1: 'scope1_emissions',
  scope1_emissions: 'scope1_emissions',
  'scope 1': 'scope1_emissions',
  'scope 1 emissions': 'scope1_emissions',
  scope2: 'scope2_emissions',
  scope2_emissions: 'scope2_emissions',
  'scope 2': 'scope2_emissions',
  scope3: 'scope3_emissions',
  scope3_emissions: 'scope3_emissions',
  'scope 3': 'scope3_emissions',
  total_emissions: 'total_emissions',
  carbon: 'total_emissions',
  'carbon emissions': 'total_emissions',
  ghg: 'total_emissions',
  'ghg emissions': 'total_emissions',
  emissions_intensity: 'emissions_intensity',
  'carbon intensity': 'emissions_intensity',
  renewable_energy_share: 'renewable_energy_share',
  renewable: 'renewable_energy_share',
  female_employee_count: 'female_employee_count',
  'female employee count': 'female_employee_count',
  'female employees count': 'female_employee_count',
  female_employee_share: 'female_employee_share',
  'female employee share': 'female_employee_share',
  male_employee_count: 'male_employee_count',
  'male employee count': 'male_employee_count',
  'male employees count': 'male_employee_count',
  'male employees': 'male_employee_count',
  'male workforce': 'male_employee_share',
  male_employee_share: 'male_employee_share',
  'male employee share': 'male_employee_share',
  female_board_share: 'female_board_share',
  female_board_count: 'female_board_count',
  total_employee_count: 'total_employee_count',
  water_consumption: 'water_consumption',
  waste_generated: 'waste_generated',
  energy_consumption: 'energy_consumption',
  safety_ltifr: 'safety_ltifr',
  total_revenue: 'total_revenue',
  revenue: 'total_revenue',
};

function intentLlmEnabled() {
  const flag = process.env.INTENT_LLM_ENABLED;
  if (flag === '0' || /^false$/i.test(flag || '')) return false;
  if (flag === '1' || /^true$/i.test(flag || '')) return true;
  // Default: on when any chat provider key/host is available.
  return Boolean(
    process.env.OPENAI_API_KEY?.trim()
    || process.env.OPENROUTER_API_KEY?.trim()
    || process.env.OLLAMA_HOST?.trim(),
  );
}

function normalizeMetricName(raw) {
  if (raw == null || raw === '') return null;
  const key = String(raw).trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  const compact = key.replace(/\s+/g, '_');
  return METRIC_NAME_MAP[key] || METRIC_NAME_MAP[compact] || (compact.includes('scope1') ? 'scope1_emissions' : null)
    || (compact.includes('scope2') ? 'scope2_emissions' : null)
    || (compact.includes('scope3') ? 'scope3_emissions' : null)
    || null;
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // continue
  }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // continue
    }
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function buildExtractionPrompt(userMessage, memory) {
  const memoryHint = memory?.lastIntent
    ? {
      lastIntent: memory.lastIntent,
      lastCompanies: memory.lastCompanies?.length
        ? memory.lastCompanies
        : (memory.entities || memory.lastPageItems?.slice?.(0, 5) || []),
      lastMetric: memory.lastMetric || memory.filters?.metric || null,
      lastYear: memory.lastYear || memory.filters?.years?.[0] || null,
      lastTool: memory.lastTool || null,
    }
    : null;

  return [
    {
      role: 'system',
      content: [
        'You are an intent and entity extractor for an Indian BRSR/ESG analytics assistant.',
        'Do NOT answer the user question. Do NOT invent facts, rankings, or SQL.',
        'Return ONLY a single JSON object with this exact shape:',
        '{',
        '  "intent": "LIST|COUNT|LOOKUP|RANK|COMPARE|FILTER|TREND|EXPLAIN|INFORMATIONAL|HOW_TO|COMPANY_SUMMARY|COMPANY_STRATEGY|GENERAL_ESG|FOLLOW_UP|UNKNOWN",',
        '  "companies": string[],',
        '  "metric": string|null,',
        '  "sector": string|null,',
        '  "year": number|null,',
        '  "geography": string|null,',
        '  "reportType": string|null,',
        '  "requestedOutput": "list|table|ranking|comparison|explanation|guidance|summary|chart|unknown",',
        '  "order": "ASC|DESC|null",',
        '  "limit": number|null,',
        '  "follow_up": boolean,',
        '  "confidence": number',
        '}',
        'Rules:',
        '- "What is/are carbon emissions? Explain Scope 1. What is ESG?" → INFORMATIONAL or EXPLAIN (never LOOKUP/RANK/SQL).',
        '- "How can I reduce carbon emissions?" / "How to improve ESG?" → HOW_TO (never RANK/LOOKUP).',
        '- "Show top 5 companies" → RANK (not LIST), even if metric is missing.',
        '- "Why are these companies high?" with prior context → FOLLOW_UP.',
        '- LIST is only for discovering/listing company names without ranking language.',
        '- Prefer metric names like Scope1, Scope2, total_emissions, renewable_energy_share.',
        '- confidence is 0..1.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        question: userMessage,
        prior_context: memoryHint,
      }),
    },
  ];
}

/**
 * Call LLM for structured extraction only.
 * @returns {Promise<object|null>}
 */
export async function callIntentLlm(userMessage, memory = null, { signal } = {}) {
  const config = getOllamaConfig();
  const url = config.host ? `${config.host}/api/chat` : null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INTENT_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener?.('abort', onAbort);

  try {
    const message = await callOllamaChat({
      url,
      model: config.model,
      fallbackModels: config.fallbackModels,
      messages: buildExtractionPrompt(userMessage, memory),
      tools: [],
      options: {
        ...config.options,
        temperature: 0,
        num_predict: Math.min(400, config.options?.num_predict || 400),
      },
      keepAlive: config.keepAlive,
      stream: false,
      signal: controller.signal,
    });
    return extractJsonObject(message?.content || '');
  } catch (err) {
    logAgentEvent({
      stage: 'intent_llm',
      ok: false,
      error: err?.name === 'AbortError' ? 'intent_llm_timeout' : (err?.message || String(err)),
    });
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/**
 * Convert LLM JSON → pipeline classification shape.
 */
export function llmExtractionToClassification(raw, userMessage = '', memory = null) {
  if (!raw || typeof raw !== 'object') return null;

  const canonical = normalizeCanonicalIntent(raw.intent);
  if (canonical === CANONICAL_INTENTS.UNKNOWN && !(Number(raw.confidence) >= 0.7)) {
    return null;
  }

  const confidence = Math.max(0, Math.min(1, Number(raw.confidence) || 0));
  if (confidence < CONFIDENCE_THRESHOLD) return null;

  let companies = Array.isArray(raw.companies)
    ? raw.companies.map((c) => String(c || '').trim()).filter(Boolean).slice(0, 5)
    : [];
  const metricsFromText = extractMetrics(userMessage);
  let metric = normalizeMetricName(raw.metric);
  // Explicit metric in the user text always wins over LLM/memory guesses.
  if (metricsFromText[0]) metric = metricsFromText[0];
  if (!metric) metric = null;

  // Authoritative metric resolution from the current message (not memory).
  // Stages: direct schema → derived → unavailable.
  const metricState = resolveMetricState(userMessage, {
    metrics: metricsFromText,
    metric,
  });
  if (isExecutableMetricResolution(metricState.state)) {
    metric = metricState.metric;
  } else if (metricState.state === METRIC_RESOLUTION.UNSUPPORTED) {
    metric = null;
  }

  const year = raw.year != null && Number.isFinite(Number(raw.year)) ? Number(raw.year) : null;
  const sector = raw.sector ? String(raw.sector).trim() : null;
  const orderRaw = String(raw.order || '').toUpperCase();
  const order = orderRaw === 'ASC' || orderRaw === 'DESC' ? orderRaw : null;
  const limit = raw.limit != null && Number.isFinite(Number(raw.limit))
    ? Math.min(50, Math.max(1, Number(raw.limit)))
    : null;
  let followUp = Boolean(raw.follow_up) || canonical === CANONICAL_INTENTS.FOLLOW_UP;

  // Safety overrides — code owns truth for these high-risk confusions.
  let effectiveCanonical = canonical;
  const priorCompanyCheck = validatePriorCompanyReference(userMessage, memory);
  let clarification = null;
  if (priorCompanyCheck.refersToPrior && !priorCompanyCheck.ok) {
    effectiveCanonical = CANONICAL_INTENTS.UNKNOWN;
    followUp = false;
    companies = [];
    clarification = priorCompanyCheck.clarification;
  } else if (metricState.state === METRIC_RESOLUTION.UNSUPPORTED) {
    effectiveCanonical = CANONICAL_INTENTS.LOOKUP;
    followUp = false;
    if (!companies.length && priorCompanyCheck.companies.length) companies = [...priorCompanyCheck.companies];
    if (!companies.length && memory?.lastCompanies?.length) companies = [...memory.lastCompanies];
    if (!companies.length && memory?.entities?.length) companies = [...memory.entities];
    if (!companies.length && memory?.lastPageItems?.length) companies = memory.lastPageItems.slice(0, 5);
  } else if (isExecutableMetricResolution(metricState.state) && priorCompanyCheck.refersToPrior) {
    // Anaphoric metric (direct or derived) on prior companies → compare/lookup, not FOLLOW_UP replay.
    effectiveCanonical = companies.length + priorCompanyCheck.companies.length >= 2
      ? CANONICAL_INTENTS.COMPARE
      : CANONICAL_INTENTS.LOOKUP;
    followUp = false;
    if (!companies.length) companies = [...priorCompanyCheck.companies];
  } else if (isGuidanceQuestion(userMessage)) {
    effectiveCanonical = CANONICAL_INTENTS.HOW_TO;
    followUp = false;
  } else if (isInformationalQuestion(userMessage, companies)) {
    effectiveCanonical = CANONICAL_INTENTS.INFORMATIONAL;
    followUp = false;
    metric = null;
  } else if (isAnaphoricMetricLookup(userMessage, memory) && metric) {
    // "how much female employee count in above companies" — SQL compare, not hybrid WHY.
    effectiveCanonical = CANONICAL_INTENTS.COMPARE;
    followUp = false;
    if (!companies.length && memory?.lastCompanies?.length) companies = [...memory.lastCompanies];
    if (!companies.length && memory?.entities?.length) companies = [...memory.entities];
    if (!companies.length && memory?.lastPageItems?.length) companies = memory.lastPageItems.slice(0, 5);
  } else if (followUp || isFollowUpExplanation(userMessage, memory)) {
    effectiveCanonical = CANONICAL_INTENTS.FOLLOW_UP;
    if (!companies.length && memory?.lastCompanies?.length) companies = [...memory.lastCompanies];
    if (!companies.length && memory?.entities?.length) companies = [...memory.entities];
    if (!companies.length && memory?.lastPageItems?.length) companies = memory.lastPageItems.slice(0, 5);
    // Only inherit prior metric when the current message omitted any metric (NONE).
    if (shouldReuseMemoryMetric(metricState.state)) {
      if (!metric && memory?.lastMetric) metric = memory.lastMetric;
      if (!metric && memory?.filters?.metric) metric = memory.filters.metric;
    }
  } else if (
    effectiveCanonical === CANONICAL_INTENTS.LIST
    && /\b(top|bottom)\s+\d{1,3}\b/i.test(userMessage)
  ) {
    effectiveCanonical = CANONICAL_INTENTS.RANK;
  }

  const assumptions = [];
  if (effectiveCanonical === CANONICAL_INTENTS.RANK && !metric && metricState.state === METRIC_RESOLUTION.NONE) {
    metric = DEFAULT_RANK_METRIC;
    assumptions.push('No metric named — using total_emissions (Scope 1+2+3 proxy).');
  }

  const legacy = mapCanonicalToLegacy(effectiveCanonical, {
    order: order || (/\bbottom|lowest|least\b/i.test(userMessage) ? 'ASC' : 'DESC'),
    reportLookup: /\b(report|filing|pdf)\b/i.test(userMessage),
  });

  const filters = {};
  if (sector) filters.sector = sector;
  if (year) filters.years = [year];
  if (metric) filters.metric = metric;
  if (order) filters.order = order;
  else if (legacy === INTENTS.BOTTOM_METRIC) filters.order = 'ASC';
  else if (legacy === INTENTS.TOP_METRIC) filters.order = 'DESC';
  if (limit) filters.limit = limit;
  else if (legacy === INTENTS.TOP_METRIC || legacy === INTENTS.BOTTOM_METRIC) filters.limit = 5;
  if (effectiveCanonical === CANONICAL_INTENTS.HOW_TO) filters.guidance = true;
  if (followUp || effectiveCanonical === CANONICAL_INTENTS.FOLLOW_UP) {
    filters.followUp = true;
    filters.priorIntent = memory?.lastIntent || null;
  }
  if (metricState.state === METRIC_RESOLUTION.UNSUPPORTED) {
    filters.unsupportedMetric = true;
  }
  if (metricState.state === METRIC_RESOLUTION.DERIVED) {
    filters.derivedMetric = true;
    filters.derivedFrom = metricState.derived?.requires || [];
  }
  if (clarification) {
    filters.needsPriorCompanies = true;
  }
  filters.metricResolution = metricState.state;
  if (raw.geography) filters.geography = String(raw.geography);
  if (raw.reportType) filters.reportType = String(raw.reportType);
  if (raw.requestedOutput) filters.requestedOutput = String(raw.requestedOutput);
  if (assumptions.length) filters.assumedMetric = true;

  // Never expand anaphoric company references to the full company list.
  const wantsAll = effectiveCanonical === CANONICAL_INTENTS.LIST
    && /\b(all|every|entire|complete|full|total)\b/i.test(userMessage)
    && !priorCompanyCheck.refersToPrior;

  return {
    intent: legacy,
    canonicalIntent: effectiveCanonical,
    entities: companies,
    filters,
    confidence,
    wantsAll: clarification ? false : wantsAll,
    metric,
    metrics: metric ? [metric] : [],
    metricResolution: metricState.state,
    assumptions,
    clarification,
    follow_up: followUp || effectiveCanonical === CANONICAL_INTENTS.FOLLOW_UP,
    source: 'llm',
    extraction: {
      geography: raw.geography || null,
      reportType: raw.reportType || null,
      requestedOutput: raw.requestedOutput || null,
      year,
      sector,
    },
  };
}

function annotateRulesClassification(classification) {
  if (!classification) return classification;
  return {
    ...classification,
    canonicalIntent: classification.canonicalIntent || mapLegacyToCanonical(classification.intent),
    assumptions: classification.assumptions || [],
    source: classification.source || 'rules',
  };
}

/**
 * Prefer LLM when it is more confident / resolves UNKNOWN; otherwise keep rules.
 * @param {object} rulesResult
 * @param {object|null} llmResult
 * @param {string} [userMessage]
 */
export function mergeIntentResults(rulesResult, llmResult, userMessage = '') {
  const rules = annotateRulesClassification(rulesResult);
  if (!llmResult) return rules;

  const countAsk = rules.intent === INTENTS.COUNT_COMPANIES
    || looksLikeCompanyCountAsk(userMessage);

  // Code safety wins for guidance / pagination / anaphoric metric lookups / unsupported metrics /
  // missing prior-company context / company-count discovery asks.
  if (
    rules.intent === INTENTS.HOW_TO
    || rules.intent === INTENTS.PAGINATE_CONTINUE
    || countAsk
    || rules.metricResolution === METRIC_RESOLUTION.UNSUPPORTED
    || rules.filters?.unsupportedMetric
    || rules.filters?.needsPriorCompanies
    || rules.clarification
    || rules.metricResolution === METRIC_RESOLUTION.DERIVED
    || (rules.filters?.followUpCompanies && rules.metric && rules.confidence >= 0.9)
  ) {
    if (countAsk) {
      const years = rules.filters?.years?.length
        ? rules.filters.years
        : (llmResult.filters?.years || undefined);
      return {
        ...rules,
        intent: INTENTS.COUNT_COMPANIES,
        canonicalIntent: 'COUNT',
        entities: [],
        metric: null,
        metrics: [],
        clarification: null,
        filters: {
          metricResolution: METRIC_RESOLUTION.NONE,
          ...(years ? { years } : {}),
        },
        extraction: llmResult.extraction,
        source: rules.source || 'rules',
      };
    }
    return {
      ...rules,
      entities: rules.filters?.needsPriorCompanies
        ? []
        : (rules.entities?.length ? rules.entities : (llmResult.entities || [])),
      extraction: llmResult.extraction,
      metricResolution: rules.metricResolution,
      metric: rules.metricResolution === METRIC_RESOLUTION.UNSUPPORTED ? null : rules.metric,
      wantsAll: rules.filters?.needsPriorCompanies ? false : rules.wantsAll,
      clarification: rules.clarification || null,
    };
  }

  if (llmResult.confidence >= Math.max(rules.confidence || 0, CONFIDENCE_THRESHOLD)) {
    // Merge richer entity/year/sector from either side.
    const entities = llmResult.entities?.length ? llmResult.entities : rules.entities;
    const filters = { ...rules.filters, ...llmResult.filters };
    if (rules.filters?.years && !llmResult.filters?.years) filters.years = rules.filters.years;
    return {
      ...llmResult,
      entities,
      filters,
      wantsAll: llmResult.wantsAll || rules.wantsAll,
      assumptions: [...new Set([...(rules.assumptions || []), ...(llmResult.assumptions || [])])],
    };
  }

  // LLM weaker — keep rules but adopt entities/years if rules missed them.
  return {
    ...rules,
    entities: rules.entities?.length ? rules.entities : (llmResult.entities || []),
    filters: {
      ...llmResult.filters,
      ...rules.filters,
      years: rules.filters?.years || llmResult.filters?.years,
      sector: rules.filters?.sector || llmResult.filters?.sector,
    },
    extraction: llmResult.extraction,
  };
}

/**
 * Validate extracted entity strings against the company resolver, then apply
 * precedence (validated message > memory on anaphora > never raw garbage).
 */
async function finalizeEntityPrecedence(classification, userMessage, memory, opts = {}) {
  if (!classification) return classification;
  const candidates = [...(classification.entities || [])];
  let validated = null;
  if (!opts.skipEntityValidation) {
    let getList = opts.getCompanyListFn || null;
    if (!getList) {
      try {
        const db = await import('../db.js');
        getList = db.getCompanyList;
      } catch {
        getList = null;
      }
    }
    if (getList) {
      try {
        validated = await validateCompanyCandidates(candidates, getList);
      } catch (err) {
        console.warn('[Intent] entity validation failed:', err?.message || err);
        validated = null;
      }
    }
  }
  return applyEntityPrecedenceToClassification(classification, {
    validatedCompanies: validated,
    candidates,
    userMessage,
    memory,
  });
}

/**
 * Main entry: hybrid intent + entity extraction for the pipeline.
 * @returns {Promise<object>} classification compatible with planQuery()
 */
export async function extractIntentAndEntities(userMessage, memory = null, opts = {}) {
  const elapsed = startTimer();
  const rules = annotateRulesClassification(classifyIntent(userMessage, memory));

  // High-precision rule hits skip the LLM round-trip (latency). Ambiguous / follow-up / unknown use LLM.
  const rulesConfident = (
    [
      INTENTS.HOW_TO,
      INTENTS.COUNT_COMPANIES,
      INTENTS.LIST_ALL_COMPANIES,
      INTENTS.TOP_METRIC,
      INTENTS.BOTTOM_METRIC,
      INTENTS.COMPARE_COMPANIES,
      INTENTS.METRIC_LOOKUP,
      INTENTS.FILTER_BY_SECTOR,
      INTENTS.PAGINATE_CONTINUE,
    ].includes(rules.intent) && rules.confidence >= 0.85
  ) || Boolean(rules.filters?.followUpCompanies && rules.metric && rules.confidence >= 0.9)
    || rules.metricResolution === METRIC_RESOLUTION.UNSUPPORTED
    || rules.metricResolution === METRIC_RESOLUTION.DERIVED
    || rules.filters?.unsupportedMetric === true
    || rules.filters?.needsPriorCompanies === true
    || Boolean(rules.clarification);

  const skipLlm = opts.forceRules
    || !intentLlmEnabled()
    || rules.intent === INTENTS.PAGINATE_CONTINUE
    || rulesConfident;

  if (skipLlm) {
    const finalized = await finalizeEntityPrecedence(rules, userMessage, memory, opts);
    logAgentEvent({
      stage: 'intent_extract',
      source: 'rules',
      intent: finalized.intent,
      canonicalIntent: finalized.canonicalIntent,
      confidence: finalized.confidence,
      companies: finalized.entities,
      latencyMs: elapsed(),
    });
    return finalized;
  }

  const raw = await callIntentLlm(userMessage, memory, { signal: opts.signal });
  const llm = llmExtractionToClassification(raw, userMessage, memory);
  const merged = mergeIntentResults(rules, llm, userMessage);
  const finalized = await finalizeEntityPrecedence(merged, userMessage, memory, opts);

  logAgentEvent({
    stage: 'intent_extract',
    source: finalized.source,
    intent: finalized.intent,
    canonicalIntent: finalized.canonicalIntent,
    confidence: finalized.confidence,
    companies: finalized.entities,
    metric: finalized.metric,
    llmOk: Boolean(llm),
    latencyMs: elapsed(),
  });

  return finalized;
}

export { intentLlmEnabled, CONFIDENCE_THRESHOLD };
