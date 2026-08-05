/**
 * Part 3 — reliability helpers (soft-fail, rate limit, health).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { shouldOmitFromComposition, SOFT_FAIL_ENGINES } from './soft-fail.js';
import {
  consumeRateLimit,
  resetRateLimitBuckets,
  getChatRateLimitRpm,
} from './rate-limit.js';
import { buildLivenessPayload, buildReadinessPayload } from './health.js';
import { runRecommendationEngine } from '../execution/engines/recommendation-engine.js';
import { composeCapabilityResults } from '../capability/response-composer.js';
import { CAPABILITIES } from '../capability/capabilities.js';

describe('soft-fail composition', () => {
  it('omits failed recommendation but keeps analytics', () => {
    assert.equal(SOFT_FAIL_ENGINES.has('recommendation'), true);
    assert.equal(
      shouldOmitFromComposition({
        engine: 'recommendation',
        ok: false,
        text: '',
        error: 'recommendation_timeout_45000ms',
      }),
      true,
    );
    assert.equal(
      shouldOmitFromComposition({
        engine: 'analytics',
        ok: true,
        text: '### Analytics\n\nScope 1 is 100.',
      }),
      false,
    );
  });

  it('composer returns analytics when recommendation empty', () => {
    const composed = composeCapabilityResults([
      {
        capability: CAPABILITIES.COMPANY_ANALYTICS,
        text: '### Analytics\n\nInfosys Scope 1 is **12,000**.',
        ok: true,
      },
      {
        capability: CAPABILITIES.RECOMMENDATION,
        text: '',
        ok: false,
      },
    ], { multi: true });
    assert.match(composed.text, /12,000|Scope 1/i);
    assert.doesNotMatch(composed.text, /timed out/i);
  });
});

describe('recommendation engine soft catch', () => {
  it('returns ok:false empty text instead of throwing', async () => {
    const out = await runRecommendationEngine({
      executionPlan: { needsRecommendation: true, entities: ['Infosys'] },
      userMessage: 'Suggest improvements for Infosys',
      signal: AbortSignal.abort(),
    });
    assert.equal(out.ok, false);
    assert.equal(out.text, '');
    assert.match(out.error, /abort/i);
  });
});

describe('rate-limit', () => {
  beforeEach(() => {
    resetRateLimitBuckets();
  });

  it('defaults to a positive RPM', () => {
    assert.ok(getChatRateLimitRpm() > 0);
  });

  it('blocks after exhausting tokens', () => {
    const key = 'test:burst';
    const rpm = 3;
    assert.equal(consumeRateLimit(key, { rpm, now: 1_000_000 }).ok, true);
    assert.equal(consumeRateLimit(key, { rpm, now: 1_000_000 }).ok, true);
    assert.equal(consumeRateLimit(key, { rpm, now: 1_000_000 }).ok, true);
    const blocked = consumeRateLimit(key, { rpm, now: 1_000_000 });
    assert.equal(blocked.ok, false);
    assert.ok(blocked.retryAfterSec >= 1);
  });

  it('disables when rpm is 0', () => {
    for (let i = 0; i < 20; i += 1) {
      assert.equal(consumeRateLimit('x', { rpm: 0 }).ok, true);
    }
  });
});

describe('health probes', () => {
  it('liveness is always ok', () => {
    const live = buildLivenessPayload();
    assert.equal(live.ok, true);
    assert.equal(live.status, 'alive');
  });

  it('readiness fails on startup error', async () => {
    const ready = await buildReadinessPayload({ startupError: 'boom' });
    assert.equal(ready.ok, false);
    assert.equal(ready.reason, 'startup_failed');
  });

  it('readiness ok when DB health ok', async () => {
    const ready = await buildReadinessPayload({
      getDb: async () => ({}),
      checkDbHealth: async () => ({
        ok: true,
        dialect: 'sqlite',
        latencyMs: 2,
        companyCount: 10,
      }),
    });
    assert.equal(ready.ok, true);
    assert.equal(ready.database.dialect, 'sqlite');
  });
});
