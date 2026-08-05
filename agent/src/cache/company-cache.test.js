/**
 * Phase 4 — TTL LRU + company cache tests.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTtlLru, stableListKey } from './ttl-lru.js';
import {
  withCompanyListCache,
  withIdentityIndexCache,
  invalidateCompanyCache,
  getCompanyCacheStats,
  isSqlCacheEnabled,
} from './company-cache.js';

describe('ttl-lru', () => {
  it('caches getOrCompute and reports hits', async () => {
    const cache = createTtlLru({ max: 8, ttlMs: 60000 });
    let calls = 0;
    const a = await cache.getOrCompute('k', async () => {
      calls += 1;
      return 42;
    });
    const b = await cache.getOrCompute('k', async () => {
      calls += 1;
      return 99;
    });
    assert.equal(a, 42);
    assert.equal(b, 42);
    assert.equal(calls, 1);
    assert.ok(cache.stats().hits >= 1);
  });

  it('evicts oldest when over max', () => {
    const cache = createTtlLru({ max: 2, ttlMs: 60000 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    assert.equal(cache.size(), 2);
    assert.equal(cache.has('a'), false);
  });

  it('stableListKey differs by content', () => {
    assert.notEqual(stableListKey(['A']), stableListKey(['B']));
    assert.equal(stableListKey(['A', 'B']), stableListKey(['A', 'B']));
  });
});

describe('company-cache', () => {
  beforeEach(() => {
    invalidateCompanyCache();
  });

  it('is enabled by default', () => {
    assert.equal(isSqlCacheEnabled(), process.env.SQL_CACHE_ENABLED !== 'false');
  });

  it('caches company list compute', async () => {
    let calls = 0;
    const first = await withCompanyListCache(async () => {
      calls += 1;
      return ['Infosys Limited', 'Wipro Limited'];
    });
    const second = await withCompanyListCache(async () => {
      calls += 1;
      return ['SHOULD_NOT_RUN'];
    });
    assert.deepEqual(first, second);
    assert.equal(calls, 1);
  });

  it('caches identity index by company list', () => {
    let calls = 0;
    const companies = ['Infosys Limited', 'TCS'];
    const a = withIdentityIndexCache(companies, () => {
      calls += 1;
      return { ok: true, n: companies.length };
    });
    const b = withIdentityIndexCache(companies, () => {
      calls += 1;
      return { ok: false };
    });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(calls, 1);
  });

  it('invalidate clears caches', async () => {
    let calls = 0;
    await withCompanyListCache(async () => {
      calls += 1;
      return ['A'];
    });
    invalidateCompanyCache();
    await withCompanyListCache(async () => {
      calls += 1;
      return ['B'];
    });
    assert.equal(calls, 2);
    assert.ok(getCompanyCacheStats().list);
  });

  it('respects SQL_CACHE_ENABLED=false', async () => {
    const prev = process.env.SQL_CACHE_ENABLED;
    process.env.SQL_CACHE_ENABLED = 'false';
    invalidateCompanyCache();
    try {
      let calls = 0;
      await withCompanyListCache(async () => {
        calls += 1;
        return ['X'];
      });
      await withCompanyListCache(async () => {
        calls += 1;
        return ['Y'];
      });
      assert.equal(calls, 2);
    } finally {
      if (prev === undefined) delete process.env.SQL_CACHE_ENABLED;
      else process.env.SQL_CACHE_ENABLED = prev;
      invalidateCompanyCache();
    }
  });
});
