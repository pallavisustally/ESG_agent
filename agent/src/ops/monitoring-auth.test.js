/**
 * Monitoring auth + ops access tests.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { extractMonitoringToken, requireMonitoringAccess } from './monitoring-auth.js';

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader(k, v) { this.headers[k] = v; },
  };
  return res;
}

describe('monitoring-auth', () => {
  const prevToken = process.env.MONITORING_TOKEN;
  const prevNodeEnv = process.env.NODE_ENV;
  const prevVercel = process.env.VERCEL;

  before(() => {
    delete process.env.VERCEL;
    process.env.NODE_ENV = 'test';
  });

  after(() => {
    if (prevToken === undefined) delete process.env.MONITORING_TOKEN;
    else process.env.MONITORING_TOKEN = prevToken;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = prevVercel;
  });

  it('extracts bearer and header tokens', () => {
    assert.equal(
      extractMonitoringToken({ headers: { authorization: 'Bearer secret' } }),
      'secret',
    );
    assert.equal(
      extractMonitoringToken({ headers: { 'x-monitoring-token': 'abc' } }),
      'abc',
    );
  });

  it('accepts matching MONITORING_TOKEN', async () => {
    process.env.MONITORING_TOKEN = 'ops-secret';
    const res = mockRes();
    let nextCalled = false;
    await requireMonitoringAccess(
      { headers: { 'x-monitoring-token': 'ops-secret' }, query: {} },
      res,
      () => { nextCalled = true; },
    );
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
  });

  it('rejects wrong MONITORING_TOKEN', async () => {
    process.env.MONITORING_TOKEN = 'ops-secret';
    const res = mockRes();
    await requireMonitoringAccess(
      { headers: { 'x-monitoring-token': 'nope' }, query: {} },
      res,
      () => {},
    );
    assert.equal(res.statusCode, 401);
  });

  it('allows open-dev when no token and not production', async () => {
    delete process.env.MONITORING_TOKEN;
    delete process.env.VERCEL;
    process.env.NODE_ENV = 'development';
    const res = mockRes();
    let nextCalled = false;
    await requireMonitoringAccess({ headers: {}, query: {} }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res.headers['X-Monitoring-Auth'], 'open-dev');
  });
});
