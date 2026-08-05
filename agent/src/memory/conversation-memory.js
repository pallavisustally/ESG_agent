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
  const next = {
    ...prev,
    ...patch,
    filters: { ...(prev.filters || {}), ...(patch.filters || {}) },
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
  STORE.set(key, next);
  prune();
  return next;
}

export function clearMemory(key) {
  if (key) STORE.delete(key);
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
  const fromRows = Array.isArray(data?.rows)
    ? data.rows.map((r) => r.company).filter(Boolean)
    : [];
  const companies = uniq([
    ...(patch.lastCompanies || []),
    ...(patch.entities || []),
    ...(patch.lastPageItems || []),
    ...(data?.companies || []),
    ...fromRows,
    ...(classification?.entities || []),
    data?.resolvedCompany ? [data.resolvedCompany] : [],
  ]).slice(0, 10);

  const metricResolution = classification?.metricResolution
    || classification?.filters?.metricResolution
    || null;

  // Do not store unsupported metrics into memory (would poison NONE reuse).
  const metric = metricResolution === METRIC_RESOLUTION.UNSUPPORTED
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

  return {
    lastIntent: classification?.intent || patch.lastIntent || null,
    canonicalIntent: classification?.canonicalIntent || patch.canonicalIntent || null,
    lastCompanies: companies,
    lastMetric: metric,
    lastYear: year != null ? Number(year) : null,
    lastTool: null,
    lastSector: classification?.filters?.sector || patch.filters?.sector || patch.lastSector || null,
    lastResultSummary: null,
    lastAssumptions: assumptions?.length ? [...assumptions] : (classification?.assumptions || []),
    lastPlan: null,
    entities: companies,
    filters: {
      ...(metric ? { metric } : {}),
      ...(year != null ? { years: [Number(year)] } : {}),
      ...(classification?.filters?.sector ? { sector: classification.filters.sector } : {}),
      ...(classification?.filters?.order ? { order: classification.filters.order } : {}),
      ...(classification?.filters?.limit != null ? { limit: classification.filters.limit } : {}),
    },
    resolvedCompany: data?.resolvedCompany || patch.resolvedCompany || companies[0] || null,
    ...(comparisonContext !== undefined ? { comparisonContext } : {}),
    // Clear pending unless caller explicitly preserves/sets it.
    pendingRequest: patch.pendingRequest !== undefined ? patch.pendingRequest : null,
  };
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

  const priorCompanies = getPriorCompanyList(memory);

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

  return out;
}

function refersToPriorCompaniesLocal(text) {
  return refersToPriorCompanies(text);
}

function isYearOnlyFollowUp(text) {
  const t = String(text || '').trim();
  if (!/\b(20\d{2})\b/.test(t)) return false;
  if (/\b(top|bottom|highest|lowest|list\s+all|show\s+all)\b/i.test(t)) return false;
  return (
    /\b(how about|what about|same for|and for|for)\s+20\d{2}\b/i.test(t)
    || /^(in\s+)?20\d{2}\??$/i.test(t)
  );
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
