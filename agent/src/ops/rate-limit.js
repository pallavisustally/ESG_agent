/**
 * Lightweight in-memory rate limiter for chat (token bucket per key).
 *
 * Disabled when CHAT_RATE_LIMIT_RPM is 0 / false / unset empty with default ON at 60.
 * Set CHAT_RATE_LIMIT_RPM=0 to disable.
 */

const buckets = new Map();

export function getChatRateLimitRpm() {
  if (process.env.CHAT_RATE_LIMIT_RPM === '0' || process.env.CHAT_RATE_LIMIT_RPM === 'false') {
    return 0;
  }
  const n = Number(process.env.CHAT_RATE_LIMIT_RPM);
  if (Number.isFinite(n) && n >= 0) return n;
  return 60; // default enabled for production safety
}

function pruneBuckets(now) {
  if (buckets.size < 5000) return;
  for (const [key, b] of buckets) {
    if (now - b.updatedAt > 120_000) buckets.delete(key);
  }
}

/**
 * @param {string} key
 * @param {{ rpm?: number, now?: number }} [opts]
 * @returns {{ ok: boolean, remaining: number, retryAfterSec: number, limit: number }}
 */
export function consumeRateLimit(key, opts = {}) {
  const rpm = opts.rpm != null ? opts.rpm : getChatRateLimitRpm();
  if (!rpm || rpm <= 0) {
    return { ok: true, remaining: Infinity, retryAfterSec: 0, limit: 0 };
  }

  const now = opts.now ?? Date.now();
  pruneBuckets(now);
  const capacity = rpm;
  const refillPerMs = rpm / 60_000;

  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: capacity, updatedAt: now };
    buckets.set(key, bucket);
  } else {
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
    bucket.updatedAt = now;
  }

  if (bucket.tokens < 1) {
    const need = 1 - bucket.tokens;
    const retryAfterSec = Math.max(1, Math.ceil(need / refillPerMs / 1000));
    return {
      ok: false,
      remaining: 0,
      retryAfterSec,
      limit: rpm,
    };
  }

  bucket.tokens -= 1;
  return {
    ok: true,
    remaining: Math.floor(bucket.tokens),
    retryAfterSec: 0,
    limit: rpm,
  };
}

/** Resolve a stable client key from Express request. */
export function rateLimitKeyFromRequest(req) {
  const session = req.body?.sessionId || req.headers['x-session-id'];
  if (session) return `session:${String(session).slice(0, 128)}`;
  const xf = req.headers['x-forwarded-for'];
  const ip = (typeof xf === 'string' ? xf.split(',')[0].trim() : null)
    || req.ip
    || req.socket?.remoteAddress
    || 'unknown';
  return `ip:${ip}`;
}

/** Test helper — clear buckets. */
export function resetRateLimitBuckets() {
  buckets.clear();
}
