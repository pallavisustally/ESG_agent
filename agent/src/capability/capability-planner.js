/**
 * Capability Planner — classifies every request into one or more Copilot capabilities.
 *
 * @deprecated Prefer `execution/execution-planner.js` as the routing authority.
 * This module remains as:
 *   - a signal library reused by the Execution Planner
 *   - legacy fallback when USE_EXECUTION_PLANNER=false
 *
 * Output is attached to classification as:
 *   capabilities: string[]
 *   primaryCapability: string
 *   capabilityPlan: { capabilities, reason, multi }
 */

import { INTENTS, isGuidanceQuestion, isInformationalQuestion } from '../intent/classify-intent.js';
import { TOOLS } from '../planner/plan-query.js';
import { CAPABILITIES, PIPELINE_NATIVE_CAPABILITIES, COPILOT_ENGINE_CAPABILITIES } from './capabilities.js';

const ANALYTICS_INTENTS = new Set([
  INTENTS.LIST_ALL_COMPANIES,
  INTENTS.COUNT_COMPANIES,
  INTENTS.FILTER_BY_SECTOR,
  INTENTS.TOP_METRIC,
  INTENTS.BOTTOM_METRIC,
  INTENTS.METRIC_LOOKUP,
  INTENTS.SECTOR_SUMMARY,
  INTENTS.TREND_ANALYSIS,
  INTENTS.CHART_REQUEST,
  INTENTS.PAGINATE_CONTINUE,
]);

const REPORT_INTENTS = new Set([
  INTENTS.COMPANY_SUMMARY,
  INTENTS.REPORT_LOOKUP,
]);

/** Framework / principle / standard compliance questions. */
export function isComplianceQuestion(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (/\b(brsr\s+principle|principle\s+[0-9ivx]+)\b/i.test(t)) return true;
  // Named frameworks (keep bare "BRSR" out so "What is BRSR?" stays knowledge)
  if (/\b(issb|csrd|sasb|tcfd|cdp|sfdr|esrs|ngrbc)\b/i.test(t)) return true;
  if (/\bifrs\s*s[12]\b/i.test(t)) return true;
  if (/\bgri\s*\d{1,3}\b/i.test(t)) return true;
  if (/\b(explain|what\s+is|what\s+are|define)\b/i.test(t)
    && /\b(gri|issb|csrd|sasb|tcfd|esrs|ngrbc|ifrs|sebi\s+brsr|disclosure\s+requirement|framework)\b/i.test(t)) {
    return true;
  }
  if (/\b(compliance|disclosure\s+requirement|reporting\s+standard|reporting\s+framework)\b/i.test(t)
    && /\b(esg|brsr|sustainab|climate|gri|issb|csrd|ngrbc)\b/i.test(t)) {
    return true;
  }
  return false;
}

/** Ask to draft / write / generate a sustainability document. */
export function isDocumentGenerationQuestion(text) {
  const t = String(text || '');
  if (!/\b(write|draft|generate|create|prepare|compose|produce)\b/i.test(t)) return false;
  return /\b(esg\s+policy|sustainability\s+(policy|roadmap|strategy|report|plan)|climate\s+action\s+plan|net\s*zero\s+(plan|roadmap)|brsr\s+disclosure|carbon\s+(policy|roadmap)|diversity\s+policy|waste\s+management\s+policy|environmental\s+policy)\b/i.test(t)
    || /\b(write|draft|generate|create)\b.{0,40}\b(policy|roadmap|action\s+plan|disclosure|framework)\b/i.test(t);
}

/**
 * Company-specific improvement advice (needs data + recommendations).
 * Distinct from generic how-to guidance with no company context.
 */
export function isRecommendationQuestion(text, classification = null) {
  const t = String(text || '');
  const entities = classification?.entities || [];
  const hasCompany = entities.length > 0
    || /\b(my|our)\s+(company|emissions?|scope|esg|score|water|waste|diversity)\b/i.test(t)
    || /\b(infosys|tcs|wipro|reliance|hdfc|tata)\b/i.test(t);

  const askImprove = /\b(suggest|recommend|advice|advise|how\s+(can|do|should)\s+(i|we|they|it)|improve|reduce\s+my|help\s+me\s+improve)\b/i.test(t)
    || /\b(what\s+should\s+(i|we|they)|ways?\s+to\s+improve)\b/i.test(t);
  const dataPlusAdvice = /\b(increased|went\s+up|rose|higher|worsened)\b/i.test(t)
    && /\b(emission|scope|esg|water|waste|score|energy)\b/i.test(t)
    && (/\b(suggest|recommend|what\s+(can|should)|how\s+(can|do|should)|improve|reduce)\b/i.test(t) || hasCompany);

  if (dataPlusAdvice) return true;
  if (askImprove && hasCompany) return true;
  // "compare X and Y … and suggest how X can improve"
  if (/\b(suggest|recommend|improve)\b/i.test(t) && /\b(compare|versus|vs\.?|against)\b/i.test(t)) {
    return true;
  }
  return false;
}

/** Qualitative company disclosure asks (initiatives, policies, roadmaps). */
export function isCompanyReportQuestion(text, classification = null) {
  const t = String(text || '');
  const entities = classification?.entities || [];
  if (REPORT_INTENTS.has(classification?.intent)) return true;
  if (!entities.length && !/\b(company|infosys|tcs|wipro|reliance)\b/i.test(t)) return false;
  return /\b(initiative|initiatives|practices?|policy|policies|roadmap|projects?|strategy|strategies|narrative|disclosure|disclosures|net\s*zero\s+roadmap|biodiversity\s+policy|waste\s+management|carbon\s+reduction\s+initiatives)\b/i.test(t)
    && !/\b(how\s+much|what\s+is\s+the\s+(value|figure|number)|top\s+\d+)\b/i.test(t);
}

/**
 * Knowledge capability follows definition QUESTION TYPE from the intent classifier.
 * Does not validate whether the topic exists — that is the Knowledge Engine's job.
 */
export function isKnowledgeQuestion(text, entities = []) {
  if (isComplianceQuestion(text) || isDocumentGenerationQuestion(text)) return false;
  if (isGuidanceQuestion(text)) return false;
  return isInformationalQuestion(text, entities);
}

/**
 * Map a single legacy intent to a default capability (when no special detectors fire).
 */
function capabilityFromIntent(intent) {
  if (intent === INTENTS.COMPARE_COMPANIES) return CAPABILITIES.BENCHMARKING;
  if (intent === INTENTS.INFORMATIONAL || intent === INTENTS.GENERAL_ESG_QUESTION) {
    return CAPABILITIES.ESG_KNOWLEDGE;
  }
  if (intent === INTENTS.HOW_TO) return CAPABILITIES.ESG_GUIDANCE;
  if (REPORT_INTENTS.has(intent)) return CAPABILITIES.COMPANY_REPORTS;
  if (ANALYTICS_INTENTS.has(intent)) return CAPABILITIES.COMPANY_ANALYTICS;
  if (intent === INTENTS.FOLLOW_UP) return CAPABILITIES.COMPANY_ANALYTICS;
  return null;
}

/**
 * Plan capabilities for a user request.
 * @returns {{
 *   capabilities: string[],
 *   primaryCapability: string|null,
 *   multi: boolean,
 *   reason: string,
 *   flags: object,
 * }}
 */
export function planCapabilities(userMessage, classification = null, memory = null) {
  const text = String(userMessage || '');
  const intent = classification?.intent || null;
  const entities = classification?.entities || [];
  const caps = [];
  const reasons = [];
  const flags = {
    compliance: false,
    documentGeneration: false,
    recommendation: false,
    knowledge: false,
    guidance: false,
    reports: false,
    analytics: false,
    benchmarking: false,
  };

  const wantsDoc = isDocumentGenerationQuestion(text);
  const wantsCompliance = isComplianceQuestion(text);
  const wantsRec = isRecommendationQuestion(text, classification);
  const wantsKnowledge = isKnowledgeQuestion(text, entities);
  const wantsGuidance = isGuidanceQuestion(text) && !wantsRec;
  const wantsReports = isCompanyReportQuestion(text, classification);
  const isCompare = intent === INTENTS.COMPARE_COMPANIES
    || /\b(compare|versus|vs\.?|against)\b/i.test(text);

  if (wantsDoc) {
    caps.push(CAPABILITIES.DOCUMENT_GENERATION);
    flags.documentGeneration = true;
    reasons.push('document_generation');
  }

  if (wantsCompliance && !wantsDoc) {
    caps.push(CAPABILITIES.ESG_COMPLIANCE);
    flags.compliance = true;
    reasons.push('framework_compliance');
  }

  if (wantsKnowledge && !wantsCompliance) {
    caps.push(CAPABILITIES.ESG_KNOWLEDGE);
    flags.knowledge = true;
    reasons.push('esg_knowledge');
  }

  if (wantsGuidance) {
    caps.push(CAPABILITIES.ESG_GUIDANCE);
    flags.guidance = true;
    reasons.push('esg_guidance');
  }

  // Analytics / benchmarking before recommendations so data is available to merge.
  if (isCompare || intent === INTENTS.COMPARE_COMPANIES) {
    caps.push(CAPABILITIES.BENCHMARKING);
    flags.benchmarking = true;
    reasons.push('benchmarking');
  } else if (ANALYTICS_INTENTS.has(intent) || (wantsRec && entities.length && !wantsReports)) {
    // Recommendation with a company usually needs analytics first.
    if (ANALYTICS_INTENTS.has(intent) || (wantsRec && !wantsGuidance)) {
      caps.push(CAPABILITIES.COMPANY_ANALYTICS);
      flags.analytics = true;
      reasons.push('company_analytics');
    }
  }

  if (wantsReports && !flags.analytics && !flags.benchmarking) {
    caps.push(CAPABILITIES.COMPANY_REPORTS);
    flags.reports = true;
    reasons.push('company_reports');
  } else if (REPORT_INTENTS.has(intent) && !caps.includes(CAPABILITIES.COMPANY_REPORTS)) {
    caps.push(CAPABILITIES.COMPANY_REPORTS);
    flags.reports = true;
    reasons.push('company_reports_intent');
  }

  if (wantsRec) {
    caps.push(CAPABILITIES.RECOMMENDATION);
    flags.recommendation = true;
    reasons.push('recommendation');
    // Ensure analytics runs when a company is in play and we don't already have data path.
    if (
      entities.length
      && !caps.includes(CAPABILITIES.COMPANY_ANALYTICS)
      && !caps.includes(CAPABILITIES.BENCHMARKING)
      && !caps.includes(CAPABILITIES.COMPANY_REPORTS)
    ) {
      caps.unshift(CAPABILITIES.COMPANY_ANALYTICS);
      flags.analytics = true;
      reasons.push('analytics_for_recommendation');
    }
  }

  // Fallback from intent when nothing matched.
  if (!caps.length) {
    const fromIntent = capabilityFromIntent(intent);
    if (fromIntent) {
      caps.push(fromIntent);
      reasons.push(`intent_${intent}`);
      if (fromIntent === CAPABILITIES.COMPANY_ANALYTICS) flags.analytics = true;
      if (fromIntent === CAPABILITIES.BENCHMARKING) flags.benchmarking = true;
      if (fromIntent === CAPABILITIES.COMPANY_REPORTS) flags.reports = true;
      if (fromIntent === CAPABILITIES.ESG_KNOWLEDGE) flags.knowledge = true;
      if (fromIntent === CAPABILITIES.ESG_GUIDANCE) flags.guidance = true;
    }
  }

  // Deduplicate preserving order.
  const seen = new Set();
  const unique = [];
  for (const c of caps) {
    if (seen.has(c)) continue;
    seen.add(c);
    unique.push(c);
  }

  // Preferred execution order: data first, then advice / generation.
  const ORDER = [
    CAPABILITIES.ESG_KNOWLEDGE,
    CAPABILITIES.ESG_COMPLIANCE,
    CAPABILITIES.COMPANY_ANALYTICS,
    CAPABILITIES.BENCHMARKING,
    CAPABILITIES.COMPANY_REPORTS,
    CAPABILITIES.ESG_GUIDANCE,
    CAPABILITIES.RECOMMENDATION,
    CAPABILITIES.DOCUMENT_GENERATION,
  ];
  unique.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));

  const primaryCapability = unique[0] || null;
  return {
    capabilities: unique,
    primaryCapability,
    multi: unique.length > 1,
    reason: reasons.join('+') || 'none',
    flags,
    memoryHint: memory?.lastCompanies ? 'has_prior_companies' : null,
  };
}

/**
 * Attach capability plan onto a classification object (immutable-ish copy).
 */
export function withCapabilityPlan(classification, userMessage, memory = null) {
  const capabilityPlan = planCapabilities(userMessage, classification, memory);
  return {
    ...classification,
    capabilities: capabilityPlan.capabilities,
    primaryCapability: capabilityPlan.primaryCapability,
    capabilityPlan,
  };
}

/**
 * True when the Copilot capability executor should run instead of (or around)
 * a single native pipeline branch.
 */
export function shouldUseCapabilityExecutor(capabilityPlan) {
  if (!capabilityPlan?.capabilities?.length) return false;
  if (capabilityPlan.multi) return true;
  const only = capabilityPlan.capabilities[0];
  return COPILOT_ENGINE_CAPABILITIES.has(only);
}

/** True when all selected capabilities are already handled by SQL/report pipeline. */
export function isNativeOnlyPlan(capabilityPlan) {
  const caps = capabilityPlan?.capabilities || [];
  if (!caps.length) return true;
  return caps.every((c) => PIPELINE_NATIVE_CAPABILITIES.has(c));
}

const SQL_STRATEGIES = new Set([
  'sql_company_metric',
  'sql_compare_companies',
  'sql_rank_metric',
  'sql_count',
  'sql_list_all_paginated',
  'sql_list_overview',
  'sql_filter_sector',
  'sql_sector_aggregate',
  'sql_trend',
  'hybrid_why_compare',
]);

/**
 * When Copilot needs analytics/benchmarking but the tool plan is still guidance/knowledge,
 * synthesize a SQL-capable plan so the analytics engine can run.
 * Does not replace the existing planner for native-only paths.
 */
export function ensureAnalyticsPlan(plan, classification, capabilityPlan) {
  const caps = capabilityPlan?.capabilities || [];
  const needsSql = caps.includes(CAPABILITIES.COMPANY_ANALYTICS)
    || caps.includes(CAPABILITIES.BENCHMARKING);
  if (!needsSql) return plan;

  if (plan && SQL_STRATEGIES.has(plan.strategy) && plan.primaryTool === TOOLS.SQL) {
    return plan;
  }
  if (plan && plan.strategy === 'sql_compare_companies') return plan;
  if (plan && plan.primaryTool === TOOLS.HYBRID && plan.strategy === 'hybrid_why_compare') {
    return plan;
  }

  const entities = classification?.entities || plan?.entities || [];
  const metric = classification?.metric || plan?.metric || 'total_emissions';
  const filters = { ...(classification?.filters || {}), ...(plan?.filters || {}) };

  if (caps.includes(CAPABILITIES.BENCHMARKING) || entities.length >= 2) {
    return {
      intent: INTENTS.COMPARE_COMPANIES,
      primaryTool: TOOLS.SQL,
      secondaryTools: [],
      strategy: 'sql_compare_companies',
      filters: { ...filters, answerType: 'QUANTITATIVE' },
      entities,
      metric,
      metrics: filters.metrics || (metric ? [metric] : ['total_emissions']),
      confidence: classification?.confidence || 0.8,
      deterministic: entities.length >= 2,
      useRag: false,
      reason: 'Copilot analytics plan for benchmarking / recommendation hybrid',
      capabilities: caps,
      primaryCapability: capabilityPlan?.primaryCapability,
      capabilityPlan,
    };
  }

  if (entities.length >= 1) {
    return {
      intent: INTENTS.METRIC_LOOKUP,
      primaryTool: TOOLS.SQL,
      secondaryTools: [],
      strategy: 'sql_company_metric',
      filters: { ...filters, answerType: 'QUANTITATIVE' },
      entities,
      metric,
      confidence: classification?.confidence || 0.8,
      deterministic: true,
      useRag: false,
      reason: 'Copilot analytics plan for recommendation hybrid',
      capabilities: caps,
      primaryCapability: capabilityPlan?.primaryCapability,
      capabilityPlan,
    };
  }

  return plan;
}
