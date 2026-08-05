/**
 * Pending request — hold an unresolved user ask until clarification supplies companies.
 *
 * Example:
 *   User: male employees in the above companies?  → missing companies → pending
 *   User: use top 5 by female employee share      → resolve companies → resume pending metric
 */

import { INTENTS } from './classify-intent.js';
import {
  METRIC_RESOLUTION,
  isExecutableMetricResolution,
} from './metric-resolution.js';

const COMPANY_PROVIDER_INTENTS = new Set([
  INTENTS.TOP_METRIC,
  INTENTS.BOTTOM_METRIC,
  INTENTS.LIST_ALL_COMPANIES,
  INTENTS.FILTER_BY_SECTOR,
  INTENTS.COMPARE_COMPANIES,
  INTENTS.METRIC_LOOKUP,
  INTENTS.REPORT_LOOKUP,
]);

/**
 * Snapshot of the ask that needs companies before it can run.
 */
export function buildPendingRequest({
  userMessage,
  classification = null,
  plan = null,
} = {}) {
  if (!classification && !userMessage) return null;
  return {
    userMessage: String(userMessage || ''),
    intent: classification?.intent || plan?.intent || INTENTS.METRIC_LOOKUP,
    metric: classification?.metric
      || classification?.filters?.metric
      || plan?.metric
      || null,
    metricResolution: classification?.metricResolution
      || classification?.filters?.metricResolution
      || METRIC_RESOLUTION.NONE,
    year: classification?.filters?.years?.[0] ?? null,
    filters: {
      ...(classification?.filters || {}),
    },
    canonicalIntent: classification?.canonicalIntent || null,
    askedAt: Date.now(),
  };
}

export function isCompanyProviderIntent(intent) {
  return COMPANY_PROVIDER_INTENTS.has(intent);
}

function isAnaphoricCompanyText(text = '') {
  return /\b(above|those|these|them|previous|prior)\b/i.test(String(text || ''));
}

function isFullySpecifiedNewAsk(userMessage = '', classification = null) {
  const hasCompanies = Boolean(classification?.entities?.length);
  const hasMetric = isExecutableMetricResolution(classification?.metricResolution)
    || Boolean(classification?.metric);
  return hasCompanies && hasMetric && !isAnaphoricCompanyText(userMessage);
}

/**
 * True when this turn looks like a clarification that can supply companies
 * for a stored pending request (named entities, ranking, or "use … companies").
 */
export function isClarificationContinuation(userMessage = '', classification = null, pending = null) {
  if (!pending) return false;
  const text = String(userMessage || '');
  if (!text.trim()) return false;
  if (shouldAbandonPendingRequest(userMessage, classification, pending)) return false;

  if (isCompanyProviderIntent(classification?.intent)) return true;
  if (classification?.entities?.length) return true;

  // "Use the top 5…", "take ACC and Infosys", "those from the ranking"
  if (/\b(use|take|consider|pick|choose|with)\b/i.test(text)
    && /\b(compan|top|highest|lowest|from|above)\b/i.test(text)) {
    return true;
  }
  return false;
}

/**
 * True when the current message is a fully-specified new ask that should drop pending.
 */
export function shouldAbandonPendingRequest(userMessage = '', classification = null, pending = null) {
  if (!pending) return false;
  if (isFullySpecifiedNewAsk(userMessage, classification)) return true;
  if (classification?.intent === INTENTS.HOW_TO && !isAnaphoricCompanyText(userMessage)) return true;
  return false;
}

/**
 * Merge pending ask onto a classification that already has companies (or will get them).
 */
export function resumeClassificationFromPending(classification, pending, {
  companies = null,
} = {}) {
  if (!classification || !pending) return classification;

  const entities = (companies?.length ? companies : classification.entities) || [];
  const metricResolution = pending.metricResolution || METRIC_RESOLUTION.NONE;
  const metric = isExecutableMetricResolution(metricResolution)
    ? pending.metric
    : (metricResolution === METRIC_RESOLUTION.UNSUPPORTED ? null : pending.metric);

  const intent = entities.length >= 2 && (
    pending.intent === INTENTS.COMPARE_COMPANIES
    || /compare|above companies|those companies/i.test(pending.userMessage || '')
  )
    ? INTENTS.COMPARE_COMPANIES
    : (pending.intent === INTENTS.TOP_METRIC || pending.intent === INTENTS.BOTTOM_METRIC
      ? INTENTS.COMPARE_COMPANIES
      : (entities.length ? (pending.intent || INTENTS.METRIC_LOOKUP) : classification.intent));

  // Prefer lookup/compare over replaying a ranking intent from the pending ask.
  const resumedIntent = intent === INTENTS.TOP_METRIC || intent === INTENTS.BOTTOM_METRIC
    ? (entities.length >= 2 ? INTENTS.COMPARE_COMPANIES : INTENTS.METRIC_LOOKUP)
    : intent;

  return {
    ...classification,
    intent: resumedIntent,
    canonicalIntent: pending.canonicalIntent
      || (resumedIntent === INTENTS.COMPARE_COMPANIES ? 'COMPARE' : classification.canonicalIntent),
    entities: [...entities],
    metric,
    metrics: metric ? [metric] : [],
    metricResolution,
    clarification: null,
    filters: {
      ...(pending.filters || {}),
      ...(classification.filters || {}),
      needsPriorCompanies: false,
      clarificationProvidesCompanies: false,
      resumedFromPending: true,
      metricResolution,
      ...(metric ? { metric } : {}),
      ...(pending.year != null && !(classification.filters?.years?.length)
        ? { years: [Number(pending.year)] }
        : {}),
      ...(metricResolution === METRIC_RESOLUTION.UNSUPPORTED
        ? { unsupportedMetric: true }
        : {}),
    },
    assumptions: [
      ...(classification.assumptions || []),
      `Resumed prior request after clarification: “${String(pending.userMessage || '').slice(0, 120)}”.`,
    ],
    confidence: Math.max(classification.confidence || 0, 0.9),
  };
}
