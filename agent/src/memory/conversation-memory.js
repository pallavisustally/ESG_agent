/**
 * Phase 9 — Structured conversation memory for BRSR follow-ups.
 *
 * Context bag (fill missing slots only — never reuse SQL/tool/plan/response):
 * {
 *   lastCompanies: ["ACC Limited", "UltraTech Cement Limited"],
 *   lastMetric: "scope1_emissions",   // for NONE → reuse only
 *   lastYear: 2025,
 *   comparisonContext: { companies, metric, year } | null,
 *   pendingRequest: { userMessage, metric, ... } | null
 * }
 */

import {
  METRIC_RESOLUTION,
  resolveMetricState,
  shouldReuseMemoryMetric,
  isExecutableMetricResolution,
} from '../intent/metric-resolution.js';
import {
  validatePriorCompanyReference,
  getPriorCompanyList,
  limitPriorCompaniesForMessage,
  refersToPriorCompanies,
} from '../intent/conversation-context.js';
import {
  chooseEntitiesByPrecedence,
} from '../intent/entity-precedence.js';
import {
  isClarificationContinuation,
  shouldAbandonPendingRequest,
  resumeClassificationFromPending,
} from '../intent/pending-request.js';
import { looksLikeCompanyCountAsk, INTENTS, classifyIntent } from '../intent/classify-intent.js';

const STORE = new Map();
const MAX_ENTRIES = 500;

function prune() {
  if (STORE.size <= MAX_ENTRIES) return;
  const keys = [...STORE.keys()];
  for (const key of keys.slice(0, STORE.size - MAX_ENTRIES)) {
    STORE.delete(key);
  }
}

function uniq(list = []) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const v = String(item || '').trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

export function createEmptyMemory() {
  return {
    lastIntent: null,
    canonicalIntent: null,
    lastCompanies: [],
    lastMetric: null,
    lastYear: null,
    /** @deprecated Not used for planning — kept null for backward-compatible reads. */
    lastTool: null,
    lastSector: null,
    /** @deprecated Not used for planning. */
    lastResultSummary: null,
    lastAssumptions: [],
    filters: {},
    page: 1,
    pageSize: 100,
    total: null,
    lastList: null,
    lastPageItems: [],
    /** @deprecated Never reuse for execution — pagination may still read page fields. */
    lastPlan: null,
    awaitingMore: false,
    wantsAll: false,
    entities: [],
    resolvedCompany: null,
    /** Companies + metric + year from the last successful comparison. */
    comparisonContext: null,
    /** Unresolved ask waiting for company clarification. */
    pendingRequest: null,
    updatedAt: Date.now(),
  };
}

/**
 * Resolve a session key from optional client id or fallback hash of recent history.
 */
export function memoryKeyFromRequest({ sessionId = null, chatHistory = [], userMessage = '' } = {}) {
  if (sessionId) return `session:${sessionId}`;
  const lastUser = [...chatHistory].reverse().find((m) => m.role === 'user');
  const seed = `${lastUser?.content || lastUser?.text || ''}|${userMessage}`.slice(0, 120);
  return `anon:${seed.length}:${seed}`;
}

export function getMemory(key) {
  if (!key) return createEmptyMemory();
  const existing = STORE.get(key);
  if (!existing) return createEmptyMemory();
  // Backfill newer structured fields for older sessions.
  return { ...createEmptyMemory(), ...existing };
}

export function updateMemory(key, patch = {}) {
  if (!key) return createEmptyMemory();
  const prev = getMemory(key);
  const mergedFilters = patch.replaceFilters
    ? { ...(patch.filters || {}) }
    : { ...(prev.filters || {}), ...(patch.filters || {}) };
  if (patch.lastMetric === null) {
    delete mergedFilters.metric;
    delete mergedFilters.metrics;
  }
  const next = {
    ...prev,
    ...patch,
    filters: mergedFilters,
    lastCompanies: patch.lastCompanies != null ? uniq(patch.lastCompanies) : prev.lastCompanies,
    lastPageItems: patch.lastPageItems != null ? [...patch.lastPageItems] : prev.lastPageItems,
    entities: patch.entities != null ? uniq(patch.entities) : prev.entities,
    lastAssumptions: patch.lastAssumptions != null ? [...patch.lastAssumptions] : prev.lastAssumptions,
    comparisonContext: patch.comparisonContext !== undefined
      ? patch.comparisonContext
      : prev.comparisonContext,
    pendingRequest: patch.pendingRequest !== undefined
      ? patch.pendingRequest
      : prev.pendingRequest,
    // Never persist execution artifacts as planning authority.
    lastPlan: null,
    lastTool: null,
    lastResultSummary: null,
    updatedAt: Date.now(),
  };
  // replaceFilters is a write directive, not session state.
  delete next.replaceFilters;
  STORE.set(key, next);
  prune();
  return next;
}

export function clearMemory(key) {
  if (key) STORE.delete(key);
}

const MEMORY_PERSIST_KEYS = [
  'lastIntent',
  'canonicalIntent',
  'lastCompanies',
  'lastMetric',
  'lastYear',
  'lastSector',
  'lastAssumptions',
  'filters',
  'page',
  'pageSize',
  'total',
  'lastPageItems',
  'awaitingMore',
  'wantsAll',
  'entities',
  'resolvedCompany',
  'comparisonContext',
  'pendingRequest',
  'updatedAt',
];

export function sessionIdFromMemoryKey(key) {
  const raw = String(key || '');
  if (raw.startsWith('session:')) return raw.slice('session:'.length) || null;
  return null;
}

export function memoryHasFollowUpSlots(memory = null) {
  if (!memory) return false;
  return Boolean(
    (memory.lastCompanies || []).length
    || memory.lastMetric
    || memory.lastYear
    || memory.pendingRequest
    || memory.comparisonContext
    || (memory.entities || []).length,
  );
}

export function serializeMemoryForStorage(memory = null) {
  const src = memory && typeof memory === 'object' ? memory : createEmptyMemory();
  const out = {};
  for (const key of MEMORY_PERSIST_KEYS) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  out.lastCompanies = uniq(out.lastCompanies || []).slice(0, 10);
  out.entities = uniq(out.entities || out.lastCompanies || []).slice(0, 10);
  out.lastPageItems = Array.isArray(out.lastPageItems) ? out.lastPageItems.slice(0, 10) : [];
  out.lastAssumptions = Array.isArray(out.lastAssumptions) ? out.lastAssumptions.slice(0, 8) : [];
  out.lastPlan = null;
  out.lastTool = null;
  out.lastResultSummary = null;
  return out;
}

export function memoryFromStorage(raw = null) {
  if (!raw) return createEmptyMemory();
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return createEmptyMemory();
    }
  }
  if (!parsed || typeof parsed !== 'object') return createEmptyMemory();
  return {
    ...createEmptyMemory(),
    ...parsed,
    lastCompanies: uniq(parsed.lastCompanies || parsed.entities || []),
    lastPlan: null,
    lastTool: null,
    lastResultSummary: null,
  };
}

function applyHydrationPatch(prev, patch = {}) {
  const mergedFilters = patch.replaceFilters
    ? { ...(patch.filters || {}) }
    : { ...(prev.filters || {}), ...(patch.filters || {}) };
  if (patch.lastMetric === null) {
    delete mergedFilters.metric;
    delete mergedFilters.metrics;
  }
  return {
    ...prev,
    ...patch,
    filters: mergedFilters,
    lastCompanies: patch.lastCompanies != null ? uniq(patch.lastCompanies) : prev.lastCompanies,
    lastPageItems: patch.lastPageItems != null ? [...patch.lastPageItems] : prev.lastPageItems,
    entities: patch.entities != null ? uniq(patch.entities) : prev.entities,
    lastAssumptions: patch.lastAssumptions != null ? [...patch.lastAssumptions] : prev.lastAssumptions,
    comparisonContext: patch.comparisonContext !== undefined
      ? patch.comparisonContext
      : prev.comparisonContext,
    pendingRequest: patch.pendingRequest !== undefined
      ? patch.pendingRequest
      : prev.pendingRequest,
    lastPlan: null,
    lastTool: null,
    lastResultSummary: null,
    updatedAt: Date.now(),
  };
}

/**
 * Rebuild follow-up slots from prior user turns when the in-process Map is empty
 * (serverless cold start, new isolate, or a session loaded from history only).
 */
export function hydrateMemoryFromChatHistory(chatHistory = [], seed = null) {
  let memory = seed
    ? { ...createEmptyMemory(), ...seed }
    : createEmptyMemory();
  const turns = Array.isArray(chatHistory) ? chatHistory : [];
  for (const msg of turns) {
    if (msg?.role !== 'user') continue;
    const text = String(msg.content || msg.text || '').trim();
    if (!text) continue;
    const classification = classifyIntent(text, memory);
    const merged = applyMemoryToClassification(classification, memory, text);
    const patch = buildStructuredMemoryPatch({ classification: merged });
    memory = applyHydrationPatch(memory, patch);
  }
  return memory;
}

function pickNewerMemory(a, b) {
  if (a && !b) return a;
  if (b && !a) return b;
  if (!a && !b) return null;
  return (Number(a.updatedAt) || 0) >= (Number(b.updatedAt) || 0) ? a : b;
}

/**
 * Combine DB snapshot, in-process Map, and the visible transcript.
 * Seed slots win when present; transcript fills anything still missing.
 */
export function mergeMemoryLayers({ stored = null, live = null, chatHistory = [] } = {}) {
  const storedMem = stored && memoryHasFollowUpSlots(stored) ? memoryFromStorage(stored) : null;
  const liveMem = live && memoryHasFollowUpSlots(live) ? { ...createEmptyMemory(), ...live } : null;
  const seed = pickNewerMemory(liveMem, storedMem);
  const fromHistory = hydrateMemoryFromChatHistory(chatHistory, createEmptyMemory());
  if (!seed) return fromHistory;
  return {
    ...fromHistory,
    ...seed,
    lastCompanies: (seed.lastCompanies || []).length ? seed.lastCompanies : fromHistory.lastCompanies,
    entities: (seed.entities || seed.lastCompanies || []).length
      ? (seed.entities || seed.lastCompanies)
      : fromHistory.entities,
    lastMetric: seed.lastMetric || fromHistory.lastMetric,
    lastYear: seed.lastYear ?? fromHistory.lastYear,
    lastSector: seed.lastSector || fromHistory.lastSector,
    comparisonContext: seed.comparisonContext || fromHistory.comparisonContext,
    pendingRequest: seed.pendingRequest || fromHistory.pendingRequest,
    filters: {
      ...(fromHistory.filters || {}),
      ...(seed.filters || {}),
    },
    lastPlan: null,
    lastTool: null,
    lastResultSummary: null,
    updatedAt: Date.now(),
  };
}

export function replaceMemory(key, next = {}) {
  if (!key) return createEmptyMemory();
  const value = {
    ...createEmptyMemory(),
    ...next,
    lastPlan: null,
    lastTool: null,
    lastResultSummary: null,
    updatedAt: Date.now(),
  };
  delete value.replaceFilters;
  STORE.set(key, value);
  prune();
  return getMemory(key);
}

/**
 * Build a structured memory patch from the latest turn.
 * Persists context only: companies, year, metric (for NONE reuse), comparison — never SQL/tool/plan.
 */
export function buildStructuredMemoryPatch({
  classification = null,
  plan = null,
  route = null,
  data = null,
  patch = {},
  assumptions = [],
} = {}) {
  // When an engine supplies an explicit company memory patch, that list is
  // authoritative — do not pad/replace from classification.entities or rows.
  const engineCompanies = patch.lastCompanies != null
    || patch.entities != null
    || patch.lastPageItems != null
    || patch.resolvedCompany != null;

  const fromRows = (!engineCompanies && Array.isArray(data?.rows))
    ? data.rows.map((r) => r.company).filter(Boolean)
    : [];
  const companies = uniq([
    ...(patch.lastCompanies || []),
    ...(patch.entities || []),
    ...(patch.lastPageItems || []),
    ...(engineCompanies ? [] : (data?.companies || [])),
    ...fromRows,
    ...(engineCompanies ? [] : (classification?.entities || [])),
    ...(!engineCompanies && data?.resolvedCompany ? [data.resolvedCompany] : []),
    ...(engineCompanies && patch.resolvedCompany ? [patch.resolvedCompany] : []),
  ]).slice(0, 10);

  const metricResolution = classification?.metricResolution
    || classification?.filters?.metricResolution
    || null;

  const isCount = classification?.intent === 'COUNT_COMPANIES'
    || plan?.intent === 'COUNT_COMPANIES'
    || classification?.canonicalIntent === 'COUNT';

  // Do not store unsupported metrics into memory (would poison NONE reuse).
  // Company-count turns must not keep a prior workforce/emissions metric.
  const metric = (isCount || metricResolution === METRIC_RESOLUTION.UNSUPPORTED)
    ? null
    : (patch.filters?.metric
      || patch.lastMetric
      || classification?.metric
      || classification?.filters?.metric
      || plan?.metric
      || data?.metric
      || null);

  const year = patch.lastYear
    ?? patch.filters?.years?.[0]
    ?? classification?.filters?.years?.[0]
    ?? data?.year
    ?? data?.assumedYear
    ?? null;

  const isCompare = classification?.intent === 'COMPARE_COMPANIES'
    || plan?.intent === 'COMPARE_COMPANIES'
    || Boolean(classification?.filters?.followUpCompanies);

  const comparisonContext = isCompare && companies.length >= 2
    ? {
      companies: companies.slice(0, 10),
      metric: metric || null,
      year: year != null ? Number(year) : null,
    }
    : (patch.comparisonContext !== undefined ? patch.comparisonContext : undefined);

  const out = {
    lastIntent: classification?.intent || patch.lastIntent || null,
    canonicalIntent: classification?.canonicalIntent || patch.canonicalIntent || null,
    lastMetric: metric,
    lastYear: year != null ? Number(year) : null,
    lastTool: null,
    lastSector: classification?.filters?.sector || patch.filters?.sector || patch.lastSector || null,
    lastResultSummary: null,
    lastAssumptions: assumptions?.length ? [...assumptions] : (classification?.assumptions || []),
    lastPlan: null,
    filters: {
      ...(metric ? { metric } : {}),
      ...(year != null ? { years: [Number(year)] } : {}),
      ...(classification?.filters?.sector ? { sector: classification.filters.sector } : {}),
      ...(classification?.filters?.order ? { order: classification.filters.order } : {}),
      ...(classification?.filters?.limit != null ? { limit: classification.filters.limit } : {}),
      ...(patch.filters || {}),
    },
    resolvedCompany: engineCompanies
      ? (patch.resolvedCompany || companies[0] || null)
      : (data?.resolvedCompany || patch.resolvedCompany || companies[0] || null),
    ...(comparisonContext !== undefined ? { comparisonContext } : {}),
    // Clear pending unless caller explicitly preserves/sets it.
    pendingRequest: patch.pendingRequest !== undefined ? patch.pendingRequest : null,
    ...(isCount ? {
      lastCompanies: [],
      entities: [],
      lastPageItems: [],
      comparisonContext: null,
      replaceFilters: true,
    } : {}),
  };

  // Only write company lists when an engine (or non-empty derived list) supplies them.
  // Omitting empty lists preserves prior lastCompanies across knowledge/guidance turns.
  if (!isCount && (engineCompanies || companies.length)) {
    out.lastCompanies = companies;
    out.entities = companies;
    if (patch.lastPageItems != null) out.lastPageItems = [...patch.lastPageItems];
  }

  return out;
}

/**
 * Apply follow-up shorthand onto classification using structured memory.
 * @param {object} classification
 * @param {object} memory
 * @param {string} [userMessage]
 */
export function applyMemoryToClassification(classification, memory, userMessage = '') {
  if (!classification || !memory) return classification;

  // Current message is authoritative for metric resolution — never let memory override FOUND/DERIVED/UNSUPPORTED.
  const metricState = resolveMetricState(userMessage, {
    metrics: classification.metrics,
    metric: isExecutableMetricResolution(classification.metricResolution)
      ? classification.metric
      : null,
  });
  const metricResolution = classification.metricResolution || metricState.state;

  let out = {
    ...classification,
    filters: { ...classification.filters, metricResolution },
    entities: [...(classification.entities || [])],
    assumptions: [...(classification.assumptions || [])],
    metricResolution,
  };

  // Hard isolation: company-count / BRSR filing-count asks never reuse prior
  // company or workforce metric context (prevents TCS employee answers on
  // “how many companies in 2024?”).
  if (looksLikeCompanyCountAsk(userMessage)) {
    const years = yearsFromMessageOrFilters(userMessage, out.filters);
    out.intent = INTENTS.COUNT_COMPANIES;
    out.canonicalIntent = 'COUNT';
    out.entities = [];
    out.metric = null;
    out.metrics = [];
    out.wantsAll = false;
    out.confidence = Math.max(Number(out.confidence) || 0, 0.95);
    out.clarification = null;
    out.filters = {
      metricResolution: METRIC_RESOLUTION.NONE,
      ...(years.length ? { years } : {}),
    };
    out.assumptions = [
      ...out.assumptions.filter((a) => !/prior context|prior companies|Follow-up/i.test(String(a))),
      'Company-count ask — prior company/metric follow-up context was not reused.',
    ];
    return out;
  }

  // After a company-count answer, bare year asks ("in 2024") continue COUNT — not metric lookup.
  if (isYearOnlyFollowUp(userMessage) && isPriorCompanyCountMemory(memory)) {
    const years = yearsFromMessageOrFilters(userMessage, out.filters);
    out.intent = INTENTS.COUNT_COMPANIES;
    out.canonicalIntent = 'COUNT';
    out.entities = [];
    out.metric = null;
    out.metrics = [];
    out.wantsAll = false;
    out.confidence = Math.max(Number(out.confidence) || 0, 0.95);
    out.clarification = null;
    out.filters = {
      metricResolution: METRIC_RESOLUTION.NONE,
      ...(years.length ? { years } : {}),
    };
    out.assumptions = [
      ...out.assumptions.filter((a) => !/prior context|prior companies|Follow-up/i.test(String(a))),
      'Year-only follow-up continued prior company-count ask.',
    ];
    return out;
  }

  // Pending clarification continuation: merge prior unresolved ask once companies can be supplied.
  const pending = memory.pendingRequest || null;
  if (pending && shouldAbandonPendingRequest(userMessage, out, pending)) {
    out.filters.clearPendingRequest = true;
  } else if (pending && isClarificationContinuation(userMessage, out, pending)) {
    if (out.entities?.length) {
      out = resumeClassificationFromPending(out, pending, { companies: out.entities });
      out.filters.clearPendingRequest = true;
    } else {
      out.filters.clarificationProvidesCompanies = true;
      out.filters.pendingRequest = pending;
      out.assumptions = [
        ...out.assumptions,
        'Clarification will resolve companies, then resume the prior pending metric request.',
      ];
    }
  }

  // Anaphoric company refs with no stored list → keep clarification, never invent all companies.
  const priorCompanyCheck = validatePriorCompanyReference(userMessage, memory);
  if (priorCompanyCheck.refersToPrior && !priorCompanyCheck.ok) {
    if (!out.filters?.clarificationProvidesCompanies && !out.filters?.resumedFromPending) {
      out.entities = [];
      out.wantsAll = false;
      out.filters.needsPriorCompanies = true;
      out.filters.wantsAll = false;
      out.clarification = priorCompanyCheck.clarification
        || classification.clarification
        || out.clarification;
      if (metricResolution === METRIC_RESOLUTION.UNSUPPORTED) {
        out.metric = null;
        delete out.filters.metric;
      }
      return out;
    }
  }

  if (metricResolution === METRIC_RESOLUTION.UNSUPPORTED) {
    out.metric = null;
    delete out.filters.metric;
    out.filters.unsupportedMetric = true;
  } else if (isExecutableMetricResolution(metricResolution) && metricState.metric) {
    out.metric = metricState.metric;
    out.filters.metric = metricState.metric;
    if (metricResolution === METRIC_RESOLUTION.DERIVED) {
      out.filters.derivedMetric = true;
      out.filters.derivedFrom = metricState.derived?.requires || [];
    }
  }

  // Strict gate: borrow prior company/metric/year only when the message has
  // clear follow-up cues (or pagination / pending clarification). Fresh asks
  // always answer from this turn's SQL intent alone.
  if (!shouldReuseConversationMemory(userMessage, out)) {
    out.assumptions = out.assumptions.filter(
      (a) => !/prior context|Follow-up resolved|reused prior|Using prior year/i.test(String(a)),
    );
    return out;
  }

  const priorCompanies = limitPriorCompaniesForMessage(
    userMessage,
    getPriorCompanyList(memory),
    memory,
  );

  const canReuseMetric = shouldReuseMemoryMetric(metricResolution);

  if (classification.intent === 'PAGINATE_CONTINUE') {
    out.filters = { ...memory.filters, ...out.filters, metricResolution };
    out.entities = priorCompanies.length ? [...priorCompanies] : out.entities;
    out.wantsAll = memory.wantsAll ?? out.wantsAll;
    if (canReuseMetric) {
      out.metric = out.metric || memory.lastMetric || memory.filters?.metric || null;
      if (out.metric) out.filters.metric = out.metric;
    }
    if (memory.lastYear && !out.filters.years?.length) out.filters.years = [memory.lastYear];
  }

  // Compare/lookup that only borrowed prior company names — keep THIS turn's metric.
  // Never let unvalidated raw entities block memory when the message is anaphoric.
  if (classification.filters?.followUpCompanies || metricResolution === METRIC_RESOLUTION.UNSUPPORTED) {
    const decided = chooseEntitiesByPrecedence({
      validatedCompanies: classification.filters?.validatedCompanies ?? null,
      candidates: out.entities,
      userMessage,
      memory,
    });
    if (decided.companies.length) {
      out.entities = [...decided.companies];
    } else if (!out.entities?.length && priorCompanies.length) {
      out.entities = [...priorCompanies].slice(0, 5);
    }
    if (memory.lastYear && !out.filters.years?.length) {
      out.filters.years = [memory.lastYear];
    }
    if (metricResolution === METRIC_RESOLUTION.UNSUPPORTED) {
      out.metric = null;
      delete out.filters.metric;
      out.filters.unsupportedMetric = true;
    } else if (out.metric) {
      out.filters.metric = out.metric;
    }
  }

  if (classification.intent === 'FOLLOW_UP') {
    // Merge contextual filters, but never bring back a prior metric on FOUND/UNSUPPORTED turns.
    const priorFilters = { ...(memory.filters || {}) };
    if (!canReuseMetric) {
      delete priorFilters.metric;
      delete priorFilters.metrics;
    }
    out.filters = {
      ...priorFilters,
      ...out.filters,
      followUp: true,
      priorIntent: memory.lastIntent || null,
      metricResolution,
    };
    if (!out.entities?.length && priorCompanies.length) {
      out.entities = [...priorCompanies].slice(0, 5);
    }
    if (canReuseMetric) {
      out.metric = out.metric || memory.lastMetric || memory.filters?.metric || null;
      if (out.metric) out.filters.metric = out.metric;
    } else if (metricResolution === METRIC_RESOLUTION.UNSUPPORTED) {
      out.metric = null;
      delete out.filters.metric;
    }
    if (memory.lastYear && !out.filters.years?.length) {
      out.filters.years = [memory.lastYear];
    }
    if (memory.lastSector && !out.filters.sector) {
      out.filters.sector = memory.lastSector;
    }
    // Disclose that follow-up reused prior context (never claim a reused metric on UNSUPPORTED).
    if (out.entities?.length || (out.metric && canReuseMetric) || memory.lastYear) {
      const bits = [];
      if (out.entities?.length) bits.push(`companies: ${out.entities.slice(0, 3).join(', ')}`);
      if (out.metric && canReuseMetric) bits.push(`metric: ${out.metric}`);
      if (memory.lastYear) bits.push(`year: ${memory.lastYear}`);
      out.assumptions = [
        ...out.assumptions,
        `Follow-up resolved from prior context (${bits.join('; ')}).`,
      ];
    }
  }

  // "only healthcare" style follow-up while listing
  if (
    memory.lastList
    && classification.filters?.sector
    && /FILTER_BY_SECTOR|LIST_ALL_COMPANIES/.test(classification.intent)
  ) {
    out.filters.sector = classification.filters.sector;
  }

  const items = memory.lastPageItems?.length ? memory.lastPageItems : (memory.lastCompanies || []);
  const text = String(userMessage || '');
  if (/compare\s+(the\s+)?first\s+two/i.test(text) && items.length >= 2) {
    out.intent = 'COMPARE_COMPANIES';
    out.canonicalIntent = 'COMPARE';
    out.entities = items.slice(0, 2);
    if (canReuseMetric) {
      out.metric = out.metric || memory.lastMetric || memory.filters?.metric || null;
    }
    out.confidence = 0.92;
  } else if (/compare\s+(the\s+)?first\s+three/i.test(text) && items.length >= 3) {
    out.intent = 'COMPARE_COMPANIES';
    out.canonicalIntent = 'COMPARE';
    out.entities = items.slice(0, 3);
    if (canReuseMetric) {
      out.metric = out.metric || memory.lastMetric || memory.filters?.metric || null;
    }
    out.confidence = 0.92;
  }

  // Generic follow-up shorthand ("compare the above companies").
  // Precedence: only keep current entities when they are already memory/prior list
  // or when validation marked them; never keep garbage over lastCompanies.
  if (out.filters?.followUpCompanies || refersToPriorCompaniesLocal(text)) {
    const decided = chooseEntitiesByPrecedence({
      validatedCompanies: out.filters?.validatedCompanies ?? null,
      candidates: out.entities,
      userMessage: text,
      memory,
    });
    out.entities = decided.companies.length
      ? [...decided.companies]
      : (priorCompanies.length ? [...priorCompanies].slice(0, 5) : []);
    if (canReuseMetric && !out.metric && (memory.lastMetric || memory.filters?.metric)) {
      out.metric = memory.lastMetric || memory.filters.metric;
      out.filters.metric = out.metric;
    }
    if (memory.lastYear && !out.filters.years?.length) {
      out.filters.years = [memory.lastYear];
    }
    if (decided.source === 'memory') {
      out.filters.followUpCompanies = true;
    }
  }

  // Chart-only follow-up: reuse prior verified metric/companies; regenerate visualization later.
  if (
    canReuseMetric
    && (classification.intent === 'CHART_REQUEST' || classification.filters?.wantsChart)
  ) {
    if (!out.metric && (memory.lastMetric || memory.filters?.metric)) {
      out.metric = memory.lastMetric || memory.filters.metric;
      out.filters.metric = out.metric;
    }
    if (!out.entities?.length && priorCompanies.length) {
      out.entities = [...priorCompanies].slice(0, 5);
    }
  }

  // Year-only follow-up ("how about 2024"): reuse companies + metric; replace year.
  if (
    canReuseMetric
    && isYearOnlyFollowUp(text)
    && (memory.lastMetric || memory.lastCompanies?.length || priorCompanies.length)
  ) {
    if (!out.metric && (memory.lastMetric || memory.filters?.metric)) {
      out.metric = memory.lastMetric || memory.filters.metric;
      out.filters.metric = out.metric;
    }
    if (!out.entities?.length && priorCompanies.length) {
      out.entities = [...priorCompanies].slice(0, 5);
    }
    if (memory.lastYear && !out.filters.years?.length) {
      out.filters.years = [memory.lastYear];
    }
  }

  // "same year" / "that year" — keep companies/metric from this turn; borrow year from memory.
  if (refersToPriorYear(text) && memory.lastYear && !out.filters.years?.length) {
    out.filters.years = [memory.lastYear];
    out.assumptions = [
      ...out.assumptions,
      `Using prior year ${memory.lastYear} from conversation.`,
    ];
  }

  // Short metric follow-up ("and Scope 2?", "Scope 1 too") — reuse prior companies when none named.
  if (
    isShortMetricFollowUp(text, out)
    && priorCompanies.length
    && (
      !out.entities?.length
      || out.intent === 'UNKNOWN'
      || out.intent === 'FOLLOW_UP'
      || out.intent === 'METRIC_LOOKUP'
      || out.intent === 'TREND_ANALYSIS'
      || out.intent === 'CHART_REQUEST'
    )
  ) {
    if (!out.entities?.length) {
      out.entities = [...priorCompanies].slice(0, 5);
    }
    out.filters.followUpCompanies = true;
    if (
      out.intent === 'UNKNOWN'
      || out.intent === 'FOLLOW_UP'
      || !out.intent
    ) {
      out.intent = 'METRIC_LOOKUP';
      out.canonicalIntent = 'LOOKUP';
      out.confidence = Math.max(Number(out.confidence) || 0, 0.86);
    }
    if (memory.lastYear && !out.filters.years?.length) {
      out.filters.years = [memory.lastYear];
    }
    if (out.metric) out.filters.metric = out.metric;
    out.assumptions = [
      ...out.assumptions,
      `Follow-up metric ask reused prior companies: ${out.entities.slice(0, 3).join(', ')}.`,
    ];
  }

  return out;
}

function refersToPriorCompaniesLocal(text) {
  return refersToPriorCompanies(text);
}

function refersToPriorYear(text) {
  return /\b(same\s+year|that\s+year|previous\s+year|prior\s+year|last\s+year)\b/i.test(
    String(text || ''),
  );
}

function yearsFromMessageOrFilters(userMessage = '', filters = null) {
  if (Array.isArray(filters?.years) && filters.years.length) {
    return filters.years.map(Number).filter(Number.isFinite);
  }
  return [...new Set([...String(userMessage || '').matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1])))];
}

function isPriorCompanyCountMemory(memory = null) {
  if (!memory) return false;
  return memory.lastIntent === INTENTS.COUNT_COMPANIES
    || memory.canonicalIntent === 'COUNT'
    || (
      !memory.lastMetric
      && !memory.filters?.metric
      && !(memory.lastCompanies || []).length
      && memory.lastYear != null
    );
}

function isShortMetricFollowUp(text, classification) {
  const t = String(text || '').trim();
  if (!t || t.length > 96) return false;
  if (looksLikeCompanyCountAsk(t)) return false;
  if (/\b(top|bottom|highest|lowest|list\s+all|compare)\b/i.test(t)) return false;
  const hasMetric = Boolean(
    classification?.metric
    || isExecutableMetricResolution(classification?.metricResolution),
  );
  if (!hasMetric) return false;
  // "and Scope 2?", "Scope 2 as well", "what about Scope 1"
  return (
    /^(and\s+)?(what\s+about\s+|how\s+about\s+)?(scope\s*[123]|renewable|water|waste|energy|ltifr|female|male)\b/i.test(t)
    || /\b(as\s+well|too|also)\s*\??$/i.test(t)
    || /^(and\s+)?scope\s*[123]\b/i.test(t)
  );
}

function isYearOnlyFollowUp(text) {
  const t = String(text || '').trim();
  if (looksLikeCompanyCountAsk(t)) return false;
  if (!/\b(20\d{2})\b/.test(t)) return false;
  if (/\b(top|bottom|highest|lowest|list\s+all|show\s+all)\b/i.test(t)) return false;
  return (
    /\b(how about|what about|same for|and for|for)\s+20\d{2}\b/i.test(t)
    || /^(in\s+)?20\d{2}\??$/i.test(t)
  );
}

/**
 * Explicit cues that the user is continuing prior chat (not a fresh standalone ask).
 */
export function hasExplicitFollowUpCue(text = '', classification = null) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (refersToPriorCompanies(t)) return true;
  if (refersToPriorYear(t)) return true;
  if (isYearOnlyFollowUp(t)) return true;
  if (isShortMetricFollowUp(t, classification)) return true;
  if (/^(next|more|continue|show more|next page)\b/i.test(t)) return true;
  if (/\b(same\s+(for|metric|company|year)|previous\s+year|that\s+year|last\s+year|as\s+above)\b/i.test(t)) {
    return true;
  }
  if (/\b(how about|what about)\b/i.test(t) && t.length < 100) return true;
  if (/^(and\s+)?(also\s+)?(scope\s*[123]|renewable|employees?)\b/i.test(t) && t.length < 80) {
    return true;
  }
  if (/\b(show|plot|graph|chart)\s+(that|it|this|the\s+same|those|them)\b/i.test(t)) return true;
  if (/^(show\s+(me\s+)?(a\s+)?(chart|graph|plot)|chart\s+it|graph\s+it)\b/i.test(t)) return true;
  if (/\bcompare\s+(the\s+)?(first\s+(two|three)|above|those|them)\b/i.test(t)) return true;
  return false;
}

/**
 * Gate for borrowing conversation memory into the current turn.
 * Pagination and pending-clarification resume always reuse; company-count asks never do.
 */
export function shouldReuseConversationMemory(userMessage = '', classification = null) {
  if (looksLikeCompanyCountAsk(userMessage)) return false;
  if (classification?.intent === 'PAGINATE_CONTINUE') return true;
  if (
    classification?.filters?.resumedFromPending
    || classification?.filters?.clarificationProvidesCompanies
  ) {
    return true;
  }
  return hasExplicitFollowUpCue(userMessage, classification);
}

/** Snapshot used by LLM intent extractor / logging. */
export function memoryContextHint(memory) {
  if (!memory) return null;
  if (!memory.lastIntent && !memory.lastCompanies?.length && !memory.pendingRequest) return null;
  return {
    lastIntent: memory.lastIntent || null,
    lastCompanies: memory.lastCompanies || memory.entities || [],
    lastMetric: memory.lastMetric || memory.filters?.metric || null,
    lastYear: memory.lastYear || memory.filters?.years?.[0] || null,
    lastSector: memory.lastSector || memory.filters?.sector || null,
    comparisonContext: memory.comparisonContext || null,
    pendingRequest: memory.pendingRequest
      ? {
        metric: memory.pendingRequest.metric,
        intent: memory.pendingRequest.intent,
        year: memory.pendingRequest.year,
        userMessage: String(memory.pendingRequest.userMessage || '').slice(0, 160),
      }
      : null,
  };
}
