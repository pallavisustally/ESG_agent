/**
 * Scored company entity resolution for BRSR reports.
 * Prefer exact / token overlap over bare LIKE + shortest-name.
 * Phase 3: resolves to canonical_company / issuer_id via company-identity.
 */

import {
  COMPANY_ALIASES,
  normalizeCompanyName,
  issuerIdFromName,
  buildCompanyIdentityIndex,
  lookupCompanyIdentity,
  pickCanonicalName,
  expandAlias,
} from './company-identity.js';

/** @deprecated use normalizeCompanyName — kept for existing imports/tests */
function normalizeName(name) {
  return normalizeCompanyName(name);
}

function tokens(name) {
  return normalizeCompanyName(name).split(' ').filter((t) => t.length > 1);
}

function expandQuery(query) {
  return expandAlias(query);
}

/**
 * Score how well a candidate company matches the query.
 * Higher is better.
 */
export function scoreCompanyMatch(query, candidate) {
  const qRaw = expandQuery(query);
  const qn = normalizeCompanyName(qRaw);
  const cn = normalizeCompanyName(candidate);
  if (!qn || !cn) return 0;
  if (qn === cn) return 1000;
  if (cn.startsWith(qn) || qn.startsWith(cn)) return 800;
  if (cn.includes(qn)) return 600 + Math.max(0, 50 - (cn.length - qn.length));
  if (qn.includes(cn) && cn.length >= 4) return 500;

  const qt = tokens(qRaw);
  const ct = new Set(tokens(candidate));
  if (!qt.length) return 0;
  let overlap = 0;
  for (const t of qt) {
    if (ct.has(t)) overlap += 1;
  }
  const ratio = overlap / qt.length;
  if (ratio <= 0) return 0;
  return Math.round(ratio * 400 + overlap * 20);
}

/**
 * @param {string} query
 * @param {string[]} companies
 * @param {{ limit?: number, minScore?: number }} opts
 */
export function rankCompanyMatches(query, companies, opts = {}) {
  const limit = opts.limit ?? 5;
  const minScore = opts.minScore ?? 120;
  const index = buildCompanyIdentityIndex(companies);

  // Fast path: identity lookup (handles ACC / Acc Ltd / ACC LIMITED)
  const identity = lookupCompanyIdentity(query, index);
  if (identity) {
    return [{
      company: identity.canonical_company,
      score: 1000,
      issuer_id: identity.issuer_id,
      company_aliases: identity.company_aliases,
    }].slice(0, limit);
  }

  const scored = [];
  const seenIssuer = new Set();
  for (const company of companies) {
    const score = scoreCompanyMatch(query, company);
    if (score < minScore) continue;
    const issuer_id = issuerIdFromName(company);
    if (seenIssuer.has(issuer_id)) continue;
    seenIssuer.add(issuer_id);
    const rec = index.byIssuer.get(issuer_id);
    scored.push({
      company: rec?.canonical_company || company,
      score,
      issuer_id,
      company_aliases: rec?.company_aliases || [],
    });
  }
  scored.sort((a, b) => b.score - a.score || a.company.length - b.company.length);
  return scored.slice(0, limit);
}

/**
 * Resolve a single best company or return ambiguous candidates.
 * Always returns canonical_company when resolved.
 */
export async function resolveCompanyEntity(query, getCompanyListFn) {
  const companies = await getCompanyListFn();
  const index = buildCompanyIdentityIndex(companies);
  const q = String(query || '').trim();

  // Identity / alias hit
  const identity = lookupCompanyIdentity(q, index);
  if (identity) {
    return {
      status: 'resolved',
      query: q,
      company: identity.canonical_company,
      canonical_company: identity.canonical_company,
      issuer_id: identity.issuer_id,
      company_aliases: identity.company_aliases,
      matches: [{ company: identity.canonical_company, score: 1000, issuer_id: identity.issuer_id }],
    };
  }

  // Exact legal name (case-insensitive) → canonical
  const exact = companies.find((c) => c === q)
    || companies.find((c) => c.toLowerCase() === q.toLowerCase());
  if (exact) {
    const id = issuerIdFromName(exact);
    const rec = index.byIssuer.get(id);
    const canonical = rec?.canonical_company || exact;
    return {
      status: 'resolved',
      query: q,
      company: canonical,
      canonical_company: canonical,
      issuer_id: id,
      company_aliases: rec?.company_aliases || [],
      matches: [{ company: canonical, score: 1000, issuer_id: id }],
    };
  }

  const ranked = rankCompanyMatches(query, companies, { limit: 5, minScore: 120 });
  if (!ranked.length) {
    return { status: 'not_found', query: q, matches: [] };
  }
  if (ranked.length === 1 || ranked[0].score >= ranked[1].score + 80) {
    return {
      status: 'resolved',
      query: q,
      company: ranked[0].company,
      canonical_company: ranked[0].company,
      issuer_id: ranked[0].issuer_id,
      company_aliases: ranked[0].company_aliases || [],
      matches: ranked,
    };
  }

  if (ranked[0].score >= 600) {
    const topScore = ranked[0].score;
    const tied = ranked.filter((r) => r.score >= topScore - 10);
    if (tied.length && normalizeCompanyName(tied[0].company) === normalizeCompanyName(expandQuery(q))) {
      return {
        status: 'resolved',
        query: q,
        company: tied[0].company,
        canonical_company: tied[0].company,
        issuer_id: tied[0].issuer_id,
        company_aliases: tied[0].company_aliases || [],
        matches: ranked,
      };
    }
  }

  return {
    status: 'ambiguous',
    query: q,
    company: null,
    matches: ranked,
    message: `Multiple companies match "${q}". Did you mean: ${ranked.map((m) => m.company).join('; ')}?`,
  };
}

/**
 * Normalize a list of entity hints to canonical companies (async, DB-backed).
 */
export async function canonicalizeEntities(entities, getCompanyListFn) {
  if (!entities?.length) return [];
  const { canonicalizeEntityList } = await import('./company-identity.js');
  const companies = await getCompanyListFn();
  const index = buildCompanyIdentityIndex(companies);
  const out = [];
  const seen = new Set();

  for (const entity of entities) {
    const identity = lookupCompanyIdentity(entity, index);
    if (identity) {
      if (seen.has(identity.issuer_id)) continue;
      seen.add(identity.issuer_id);
      out.push(identity.canonical_company);
      continue;
    }
    const ranked = rankCompanyMatches(entity, companies, { limit: 1, minScore: 200 });
    if (ranked[0]) {
      if (seen.has(ranked[0].issuer_id)) continue;
      seen.add(ranked[0].issuer_id);
      out.push(ranked[0].company);
      continue;
    }
    // Keep unresolved hint (planner/validator may clarify) but still issuer-dedupe
    const id = issuerIdFromName(entity) || String(entity).toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(String(entity).trim());
  }

  return out.length ? out : canonicalizeEntityList(entities, index);
}

export {
  COMPANY_ALIASES,
  normalizeName,
  normalizeCompanyName,
  issuerIdFromName,
  buildCompanyIdentityIndex,
  lookupCompanyIdentity,
  pickCanonicalName,
};
