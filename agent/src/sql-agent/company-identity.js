/**
 * Phase 3 — Company identity normalization.
 *
 * ACC LIMITED / ACC Limited / Acc Ltd → same issuer_id → one canonical_company.
 * Rankings and lists must never show duplicate issuers.
 */

import { withIdentityIndexCache } from '../cache/company-cache.js';

/** Short / common aliases → search phrase (matched against DB names). */
export const COMPANY_ALIASES = Object.freeze({
  tcs: 'Tata Consultancy Services',
  infosys: 'Infosys',
  wipro: 'Wipro',
  'asian paints': 'Asian Paints',
  hdfc: 'HDFC Bank',
  'hdfc bank': 'HDFC Bank',
  reliance: 'Reliance Industries',
  'tata power': 'Tata Power',
  tatapower: 'Tata Power',
  'adani green': 'Adani Green',
  'apollo hospitals': 'Apollo Hospitals',
  acc: 'ACC',
  'acc ltd': 'ACC',
  'acc limited': 'ACC',
  ultratech: 'UltraTech',
  'ultratech cement': 'UltraTech Cement',
  'jsw steel': 'JSW Steel',
  'tata steel': 'Tata Steel',
  itc: 'ITC',
});

const LEGAL_SUFFIX_RE = /\b(limited|ltd|private|pvt|inc|corp|corporation|company|co)\b/gi;

/**
 * Normalize a company string for identity matching (issuer key).
 * "ACC LIMITED" / "ACC Limited" / "Acc Ltd" → "acc"
 */
export function normalizeCompanyName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[.,'"`]/g, ' ')
    .replace(LEGAL_SUFFIX_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Stable issuer id from any surface form. */
export function issuerIdFromName(name) {
  return normalizeCompanyName(name);
}

function expandAlias(query) {
  const q = String(query || '').trim();
  if (!q) return q;
  const lower = q.toLowerCase();
  if (COMPANY_ALIASES[lower]) return COMPANY_ALIASES[lower];
  const stripped = normalizeCompanyName(q);
  if (COMPANY_ALIASES[stripped]) return COMPANY_ALIASES[stripped];
  return q;
}

/**
 * Prefer human Title Case over ALL CAPS duplicates.
 * e.g. "ACC Limited" beats "ACC LIMITED".
 */
export function pickCanonicalName(variants = []) {
  const list = [...new Set(variants.map((v) => String(v || '').trim()).filter(Boolean))];
  if (!list.length) return null;
  if (list.length === 1) return list[0];

  const scored = list.map((name) => {
    let score = 0;
    const upper = name.toUpperCase();
    const lower = name.toLowerCase();
    if (name !== upper) score += 100; // not ALL CAPS
    if (name !== lower) score += 40; // has capitals
    if (/\bLimited\b/.test(name)) score += 25;
    if (/\bLIMITED\b/.test(name)) score -= 15;
    if (/\bLtd\.?\b/.test(name) && !/\bLimited\b/.test(name)) score -= 5;
    // Slight preference for shorter display names among equals
    score -= name.length * 0.01;
    return { name, score };
  });
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored[0].name;
}

/**
 * Build an identity index from DB company names.
 * @param {string[]} companies
 * @returns {{
 *   byIssuer: Map<string, { issuer_id: string, canonical_company: string, company_aliases: string[] }>,
 *   bySurface: Map<string, string>,
 *   canonicalList: string[],
 * }}
 */
export function buildCompanyIdentityIndex(companies = []) {
  return withIdentityIndexCache(companies, () => buildCompanyIdentityIndexUncached(companies));
}

function buildCompanyIdentityIndexUncached(companies = []) {
  const groups = new Map();
  for (const company of companies) {
    const id = issuerIdFromName(company);
    if (!id) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(company);
  }

  const byIssuer = new Map();
  const bySurface = new Map();

  for (const [issuer_id, variants] of groups) {
    const uniq = [...new Set(variants)];
    const canonical_company = pickCanonicalName(uniq);
    const company_aliases = uniq.filter((v) => v !== canonical_company);
    const record = { issuer_id, canonical_company, company_aliases, variants: uniq };
    byIssuer.set(issuer_id, record);
    for (const v of uniq) {
      bySurface.set(v.toLowerCase(), issuer_id);
      bySurface.set(normalizeCompanyName(v), issuer_id);
    }
  }

  // Register short aliases → issuer when a matching company exists
  for (const [alias, target] of Object.entries(COMPANY_ALIASES)) {
    const id = issuerIdFromName(target);
    if (byIssuer.has(id)) {
      bySurface.set(alias, id);
      bySurface.set(normalizeCompanyName(alias), id);
    } else {
      // Partial: find issuer whose normalized name starts with / equals alias target
      const targetNorm = normalizeCompanyName(target);
      for (const [issuer_id, rec] of byIssuer) {
        if (issuer_id === targetNorm || issuer_id.startsWith(`${targetNorm} `) || issuer_id.includes(targetNorm)) {
          // Prefer exact-ish: "acc" → acc, not accelya
          if (alias === 'acc' && issuer_id !== 'acc') continue;
          if (alias.length <= 3 && issuer_id !== targetNorm && !issuer_id.startsWith(`${targetNorm} `)) continue;
          bySurface.set(alias, issuer_id);
          bySurface.set(normalizeCompanyName(alias), issuer_id);
          break;
        }
      }
    }
  }

  const canonicalList = [...byIssuer.values()]
    .map((r) => r.canonical_company)
    .sort((a, b) => a.localeCompare(b));

  return { byIssuer, bySurface, canonicalList };
}

/**
 * Look up identity record for a query or surface name.
 */
export function lookupCompanyIdentity(query, index) {
  if (!index || !query) return null;
  const raw = String(query).trim();
  if (!raw) return null;

  const expanded = expandAlias(raw);
  const keys = [
    raw.toLowerCase(),
    normalizeCompanyName(raw),
    expanded.toLowerCase(),
    normalizeCompanyName(expanded),
  ];

  for (const key of keys) {
    const issuer_id = index.bySurface.get(key);
    if (issuer_id && index.byIssuer.has(issuer_id)) {
      return index.byIssuer.get(issuer_id);
    }
  }

  // Prefix / containment fallback on issuer ids (careful with short keys)
  const needle = normalizeCompanyName(expanded);
  if (needle.length >= 3) {
    let best = null;
    for (const [issuer_id, rec] of index.byIssuer) {
      if (issuer_id === needle) return rec;
      if (issuer_id.startsWith(`${needle} `) || needle.startsWith(`${issuer_id} `)) {
        if (!best || issuer_id.length < best.issuer_id.length) best = rec;
      }
    }
    if (best) return best;
  }

  return null;
}

/** Unique canonical company names (deduped by issuer_id). */
export function dedupeCompanyNames(companies = [], index = null) {
  const idx = index || buildCompanyIdentityIndex(companies);
  const seen = new Set();
  const out = [];
  for (const company of companies) {
    const id = issuerIdFromName(company);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const rec = idx.byIssuer.get(id);
    out.push(rec?.canonical_company || company);
  }
  return out;
}

/**
 * Dedupe ranking rows by issuer_id; keep best metric_value for the sort order.
 * Rewrites company to canonical_company.
 */
export function dedupeRankingRows(rows = [], { order = 'DESC', index = null } = {}) {
  if (!rows.length) return [];
  const idx = index || buildCompanyIdentityIndex(rows.map((r) => r.company).filter(Boolean));
  const desc = String(order).toUpperCase() !== 'ASC';
  const best = new Map();

  for (const row of rows) {
    if (!row?.company) continue;
    const id = issuerIdFromName(row.company);
    if (!id) continue;
    const rec = idx.byIssuer.get(id);
    const canonical = rec?.canonical_company || row.company;
    const value = row.metric_value != null ? Number(row.metric_value) : null;
    const prev = best.get(id);
    if (!prev) {
      best.set(id, { ...row, company: canonical, issuer_id: id });
      continue;
    }
    const prevVal = prev.metric_value != null ? Number(prev.metric_value) : null;
    let take = false;
    if (value != null && prevVal != null) {
      take = desc ? value > prevVal : value < prevVal;
    } else if (value != null && prevVal == null) {
      take = true;
    }
    if (take) best.set(id, { ...row, company: canonical, issuer_id: id });
  }

  const out = [...best.values()];
  out.sort((a, b) => {
    const av = a.metric_value != null ? Number(a.metric_value) : (desc ? -Infinity : Infinity);
    const bv = b.metric_value != null ? Number(b.metric_value) : (desc ? -Infinity : Infinity);
    return desc ? bv - av : av - bv;
  });
  return out;
}

/**
 * Resolve user entity strings → canonical companies (deduped).
 */
export function canonicalizeEntityList(entities = [], index) {
  if (!index || !entities?.length) return [];
  const out = [];
  const seen = new Set();
  for (const entity of entities) {
    const rec = lookupCompanyIdentity(entity, index);
    const name = rec?.canonical_company || String(entity || '').trim();
    if (!name) continue;
    const id = rec?.issuer_id || issuerIdFromName(name);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(name);
  }
  return out;
}

export { expandAlias };
