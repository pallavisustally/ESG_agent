/**
 * Entity precedence: validated companies beat raw extraction; memory fills anaphora.
 *
 * Flow: Extract → Canonicalize/Validate → Decision
 * Decision depends on validatedCompanies.length — never raw entities.length.
 */

import {
  refersToPriorCompanies,
  getPriorCompanyList,
  MISSING_PRIOR_COMPANIES_CLARIFICATION,
} from './conversation-context.js';
import {
  resolveCompanyEntity,
  rankCompanyMatches,
  buildCompanyIdentityIndex,
  lookupCompanyIdentity,
} from '../sql-agent/company-resolve.js';

/**
 * Keep only candidates that resolve unambiguously to a BRSR company.
 * Ambiguous / not_found / garbage phrases are dropped.
 *
 * @param {string[]} candidates
 * @param {() => Promise<string[]>} getCompanyListFn
 * @returns {Promise<string[]>} canonical company names
 */
export async function validateCompanyCandidates(candidates = [], getCompanyListFn) {
  if (!candidates?.length || typeof getCompanyListFn !== 'function') return [];
  const out = [];
  const seen = new Set();

  for (const raw of candidates) {
    const q = String(raw || '').trim();
    if (!q || q.length < 2) continue;
    const result = await resolveCompanyEntity(q, getCompanyListFn);
    if (result.status !== 'resolved') continue;
    const company = result.canonical_company || result.company;
    if (!company) continue;
    const key = company.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(company);
  }
  return out;
}

/**
 * Sync validation against an in-memory company list (tests / offline).
 * Same rule: identity hit or clear unique rank only — never ambiguous.
 *
 * @param {string[]} candidates
 * @param {string[]} companyList
 * @returns {string[]}
 */
export function validateCompanyCandidatesSync(candidates = [], companyList = []) {
  if (!candidates?.length || !companyList?.length) return [];
  const index = buildCompanyIdentityIndex(companyList);
  const out = [];
  const seen = new Set();

  for (const raw of candidates) {
    const q = String(raw || '').trim();
    if (!q || q.length < 2) continue;

    const identity = lookupCompanyIdentity(q, index);
    if (identity?.canonical_company) {
      const key = identity.canonical_company.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(identity.canonical_company);
      }
      continue;
    }

    const ranked = rankCompanyMatches(q, companyList, { limit: 2, minScore: 500 });
    if (!ranked.length) continue;
    // Require a clear winner — reject weak / tied matches (garbage like "What are the").
    if (ranked.length > 1 && ranked[0].score < ranked[1].score + 80) continue;
    if (ranked[0].score < 600) continue;
    const company = ranked[0].company;
    const key = company.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(company);
  }
  return out;
}

/**
 * Decide which companies to use for this turn.
 *
 * Precedence:
 * 1. One or more VALIDATED companies from the current message → use them
 * 2. Else if conversation reference ("above company", …) → lastCompanies from memory
 * 3. Else clarify (empty + needsClarification when anaphoric) or keep nothing
 *
 * When validation has not run (`validatedCompanies == null`) and the message is
 * NOT anaphoric, fall back to raw candidates for sync classifyIntent callers.
 * Anaphoric turns never trust unvalidated raw extraction.
 *
 * @returns {{
 *   companies: string[],
 *   source: 'validated_message'|'memory'|'candidates_unvalidated'|'none',
 *   needsClarification: boolean,
 *   clarification: string|null,
 * }}
 */
export function chooseEntitiesByPrecedence({
  validatedCompanies = null,
  candidates = [],
  userMessage = '',
  memory = null,
} = {}) {
  const prior = getPriorCompanyList(memory);
  const refersToPrior = refersToPriorCompanies(userMessage);
  const validated = Array.isArray(validatedCompanies) ? validatedCompanies.filter(Boolean) : null;

  if (validated?.length) {
    return {
      companies: [...validated],
      source: 'validated_message',
      needsClarification: false,
      clarification: null,
    };
  }

  if (refersToPrior) {
    if (prior.length) {
      return {
        companies: [...prior],
        source: 'memory',
        needsClarification: false,
        clarification: null,
      };
    }
    return {
      companies: [],
      source: 'none',
      needsClarification: true,
      clarification: MISSING_PRIOR_COMPANIES_CLARIFICATION,
    };
  }

  // Validation ran and found nothing — do not fall back to garbage strings.
  if (validated != null) {
    return {
      companies: [],
      source: 'none',
      needsClarification: false,
      clarification: null,
    };
  }

  // Sync path without a company resolver: keep raw candidates for non-anaphoric asks.
  const raw = (candidates || []).map((c) => String(c || '').trim()).filter(Boolean);
  return {
    companies: raw,
    source: raw.length ? 'candidates_unvalidated' : 'none',
    needsClarification: false,
    clarification: null,
  };
}

/**
 * Apply precedence onto a classification object (mutates a shallow copy).
 */
export function applyEntityPrecedenceToClassification(classification, {
  validatedCompanies = null,
  candidates = null,
  userMessage = '',
  memory = null,
} = {}) {
  if (!classification) return classification;
  const decided = chooseEntitiesByPrecedence({
    validatedCompanies,
    candidates: candidates ?? classification.entities ?? [],
    userMessage,
    memory,
  });

  const out = {
    ...classification,
    entities: decided.companies,
    filters: { ...(classification.filters || {}) },
  };

  if (decided.source === 'memory') {
    out.filters.followUpCompanies = true;
    out.assumptions = [
      ...new Set([
        ...(out.assumptions || []),
        `Using companies from prior context: ${decided.companies.slice(0, 3).join(', ')}.`,
      ]),
    ];
    // Single prior company → lookup; multi → compare when already compare-shaped.
    if (decided.companies.length === 1 && out.intent === 'COMPARE_COMPANIES') {
      out.intent = 'METRIC_LOOKUP';
      out.canonicalIntent = out.canonicalIntent === 'COMPARE' ? 'LOOKUP' : out.canonicalIntent;
    } else if (decided.companies.length >= 2 && out.intent === 'METRIC_LOOKUP') {
      out.intent = 'COMPARE_COMPANIES';
      out.canonicalIntent = 'COMPARE';
    }
  }

  if (decided.needsClarification) {
    out.entities = [];
    out.wantsAll = false;
    out.clarification = decided.clarification;
    out.filters.needsPriorCompanies = true;
    out.filters.wantsAll = false;
    out.filters.followUpCompanies = false;
  } else if (decided.source === 'validated_message' || decided.source === 'memory') {
    delete out.filters.needsPriorCompanies;
    if (out.clarification && /previous company list/i.test(out.clarification)) {
      out.clarification = null;
    }
  }

  return out;
}
