/**
 * Conversation context validation for anaphoric company references.
 *
 * "above companies" / "those companies" / "them" must resolve to a stored
 * company list — never to the full database company set.
 */

export const MISSING_PRIOR_COMPANIES_CLARIFICATION =
  'I do not have a previous company list in this conversation to resolve '
  + '"above/those companies". Which companies should I use?';

/** True when the user refers to companies from prior turns. */
export function refersToPriorCompanies(text) {
  const t = String(text || '');
  return /\b(above|these|those|the\s+same|prior|previous)\s+companies\b/i.test(t)
    || (/\b(the\s+)?(above|previous|same)\s+compan/i.test(t))
    || /\b(for|in|of|about)\s+(them|those|these)\b/i.test(t)
    // Possessive company anaphora: "their emissions", "their employee count"
    || /\btheir\s+(emissions?|scope\s*[123]|employees?|workforce|energy|water|waste|revenue|counts?|share)\b/i.test(t)
    // "compare the above", "same for the above", "the above on Scope 1"
    || /\bthe\s+above\b/i.test(t)
    || /\bsame\s+for\b/i.test(t)
    || /\bcompare\s+(again|the\s+above)\b/i.test(t);
}

/**
 * Prefer structured lastCompanies, then entities, then last page items.
 * Never invent or expand to "all companies".
 */
export function getPriorCompanyList(memory = null) {
  if (!memory) return [];
  if (Array.isArray(memory.lastCompanies) && memory.lastCompanies.length) {
    return [...memory.lastCompanies];
  }
  if (Array.isArray(memory.entities) && memory.entities.length) {
    return [...memory.entities];
  }
  if (Array.isArray(memory.lastPageItems) && memory.lastPageItems.length) {
    return [...memory.lastPageItems];
  }
  return [];
}

/** True when the user points at one prior company, not the whole list. */
export function refersToSingularPriorCompany(text = '') {
  const t = String(text || '');
  if (/\bcompanies\b/i.test(t)) return false;
  return /\b(the\s+)?(above|previous|same|this)\s+company\b/i.test(t);
}

/**
 * "Above company" (singular) → one name. "Above companies" → the stored list.
 */
export function limitPriorCompaniesForMessage(userMessage = '', companies = [], memory = null) {
  const list = (Array.isArray(companies) ? companies : []).map((c) => String(c || '').trim()).filter(Boolean);
  if (list.length <= 1) return list;
  if (!refersToSingularPriorCompany(userMessage)) return list;
  const resolved = String(memory?.resolvedCompany || '').trim();
  if (resolved) {
    const hit = list.find((c) => c.toLowerCase() === resolved.toLowerCase());
    if (hit) return [hit];
    return [resolved];
  }
  return [list[0]];
}

export function hasPriorCompanyList(memory = null) {
  return getPriorCompanyList(memory).length > 0;
}

/**
 * Validate anaphoric company references against conversation memory.
 * @returns {{ ok: boolean, companies: string[], clarification: string|null, refersToPrior: boolean }}
 */
export function validatePriorCompanyReference(userMessage = '', memory = null) {
  const refersToPrior = refersToPriorCompanies(userMessage);
  if (!refersToPrior) {
    return {
      ok: true,
      companies: [],
      clarification: null,
      refersToPrior: false,
    };
  }

  const companies = limitPriorCompaniesForMessage(
    userMessage,
    getPriorCompanyList(memory),
    memory,
  );
  if (companies.length) {
    return {
      ok: true,
      companies,
      clarification: null,
      refersToPrior: true,
    };
  }

  return {
    ok: false,
    companies: [],
    clarification: MISSING_PRIOR_COMPANIES_CLARIFICATION,
    refersToPrior: true,
  };
}
