/**
 * Small TTL + max-size LRU cache (Map delete/reinsert for recency).
 * Mirrors page-index pageTextCache style — no external deps.
 */

/**
 * @param {{ max?: number, ttlMs?: number }} [opts]
 */
export function createTtlLru(opts = {}) {
  const max = Math.max(1, Number(opts.max) || 64);
  let ttlMs = Math.max(0, Number(opts.ttlMs) || 300000);
  const store = new Map(); // key -> { value, expiresAt }
  const stats = { hits: 0, misses: 0, sets: 0, invalidations: 0 };

  function now() {
    return Date.now();
  }

  function isFresh(entry) {
    if (!entry) return false;
    if (!ttlMs) return true;
    return entry.expiresAt > now();
  }

  function touch(key, entry) {
    store.delete(key);
    store.set(key, entry);
  }

  function evict() {
    while (store.size > max) {
      const oldest = store.keys().next().value;
      store.delete(oldest);
    }
  }

  return {
    get(key) {
      const entry = store.get(key);
      if (!isFresh(entry)) {
        if (entry) store.delete(key);
        stats.misses += 1;
        return undefined;
      }
      touch(key, entry);
      stats.hits += 1;
      return entry.value;
    },

    set(key, value) {
      const entry = {
        value,
        expiresAt: ttlMs ? now() + ttlMs : Number.POSITIVE_INFINITY,
      };
      touch(key, entry);
      stats.sets += 1;
      evict();
      return value;
    },

    has(key) {
      const entry = store.get(key);
      if (!isFresh(entry)) {
        if (entry) store.delete(key);
        return false;
      }
      return true;
    },

    async getOrCompute(key, computeFn) {
      if (this.has(key)) return this.get(key);
      stats.misses += 1;
      const value = await computeFn();
      this.set(key, value);
      return value;
    },

    getOrComputeSync(key, computeFn) {
      const entry = store.get(key);
      if (isFresh(entry)) {
        touch(key, entry);
        stats.hits += 1;
        return entry.value;
      }
      if (entry) store.delete(key);
      stats.misses += 1;
      const value = computeFn();
      this.set(key, value);
      return value;
    },

    delete(key) {
      const ok = store.delete(key);
      if (ok) stats.invalidations += 1;
      return ok;
    },

    clear() {
      const n = store.size;
      store.clear();
      stats.invalidations += n;
    },

    setTtl(ms) {
      ttlMs = Math.max(0, Number(ms) || 0);
    },

    size() {
      return store.size;
    },

    stats() {
      return { ...stats, size: store.size, max, ttlMs };
    },

    resetStats() {
      stats.hits = 0;
      stats.misses = 0;
      stats.sets = 0;
      stats.invalidations = 0;
    },
  };
}

export function stableListKey(list = []) {
  return String(list.length) + ':' + String(list).length + ':' + hashString(list.join('\u0001'));
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
