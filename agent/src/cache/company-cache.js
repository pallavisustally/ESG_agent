/**
 * Company list + identity index caching (Phase 4).
 *
 * Default: enabled (SQL_CACHE_ENABLED !== 'false').
 * Invalidate on report insert/delete + TTL safety net.
 */

import { createTtlLru, stableListKey } from './ttl-lru.js';

function isEnabled() {
  return process.env.SQL_CACHE_ENABLED !== 'false';
}

function ttlMs() {
  const n = Number(process.env.SQL_CACHE_TTL_MS);
  return Number.isFinite(n) && n >= 0 ? n : 300000;
}

const listCache = createTtlLru({ max: 4, ttlMs: ttlMs() });
const identityCache = createTtlLru({ max: 16, ttlMs: ttlMs() });
const sectorCache = createTtlLru({ max: 8, ttlMs: ttlMs() });

export function isSqlCacheEnabled() {
  return isEnabled();
}

/**
 * @param {() => Promise<string[]>} compute
 * @returns {Promise<string[]>}
 */
export async function withCompanyListCache(compute) {
  if (!isEnabled()) return compute();
  listCache.setTtl(ttlMs());
  return listCache.getOrCompute('company_list', compute);
}

/**
 * @template T
 * @param {string[]} companies
 * @param {() => T} compute
 * @returns {T}
 */
export function withIdentityIndexCache(companies, compute) {
  if (!isEnabled()) return compute();
  identityCache.setTtl(ttlMs());
  const key = `identity:${stableListKey(companies || [])}`;
  return identityCache.getOrComputeSync(key, compute);
}

/**
 * @template T
 * @param {string} cacheKey
 * @param {() => Promise<T>} compute
 * @returns {Promise<T>}
 */
export async function withSectorBreakdownCache(cacheKey, compute) {
  if (!isEnabled()) return compute();
  sectorCache.setTtl(ttlMs());
  return sectorCache.getOrCompute(cacheKey || 'sector_breakdown', compute);
}

export function invalidateCompanyCache() {
  listCache.clear();
  identityCache.clear();
  sectorCache.clear();
}

export function getCompanyCacheStats() {
  return {
    enabled: isEnabled(),
    list: listCache.stats(),
    identity: identityCache.stats(),
    sector: sectorCache.stats(),
  };
}
