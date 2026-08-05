/**
 * Deterministic benchmark scorers — compose into scoreBenchmarkCase.
 */

import { COMPANY_ALIASES, issuerIdFromName } from '../../sql-agent/company-identity.js';
import { validateCitationPresence } from '../../validation/answer-validator.js';

/**
 * @param {object} actual - plan / pipeline observation
 * @param {object} expected - case.expected
 * @param {object} scoreFlags - case.score
 * @returns {{ dimensions: object, passed: boolean, score: number, skipped: string[] }}
 */
export function scoreBenchmarkCase(actual = {}, expected = {}, scoreFlags = {}) {
  const dimensions = {};
  const skipped = [];

  const runners = {
    routing: () => scoreRouting(actual, expected),
    entity: () => scoreEntity(actual, expected),
    metric: () => scoreMetric(actual, expected),
    year: () => scoreYear(actual, expected),
    numeric: () => scoreNumeric(actual, expected),
    chart: () => scoreChart(actual, expected),
    citation: () => scoreCitation(actual, expected),
  };

  for (const [dim, run] of Object.entries(runners)) {
    if (scoreFlags[dim] === false) {
      dimensions[dim] = { ok: true, skipped: true, detail: 'disabled' };
      skipped.push(dim);
      continue;
    }
    dimensions[dim] = run();
    if (dimensions[dim].skipped) skipped.push(dim);
  }

  const scored = Object.entries(dimensions).filter(([, d]) => !d.skipped);
  const passedCount = scored.filter(([, d]) => d.ok).length;
  const passed = scored.every(([, d]) => d.ok);
  const score = scored.length ? passedCount / scored.length : 1;

  return {
    dimensions,
    passed,
    score,
    skipped,
  };
}

export function scoreRouting(actual, expected) {
  const detail = {};
  let ok = true;

  if (expected.executionStrategy) {
    const got = actual.executionStrategy || actual.plan?.executionStrategy || null;
    detail.expectedStrategy = expected.executionStrategy;
    detail.actualStrategy = got;
    if (got !== expected.executionStrategy) ok = false;
  }

  if (expected.executionPath) {
    const got = actual.executionPath || actual.route?.mode || null;
    detail.expectedPath = expected.executionPath;
    detail.actualPath = got;
    // Plan-mode may not have a route yet — accept null when only planning
    if (got != null && got !== expected.executionPath) ok = false;
  }

  const wantEngines = Array.isArray(expected.engines) ? expected.engines : [];
  if (wantEngines.length) {
    const got = actual.requiredEngines
      || actual.plan?.requiredEngines
      || [];
    detail.expectedEngines = wantEngines;
    detail.actualEngines = got;
    const mode = expected.enginesMode || 'superset';
    if (mode === 'exact') {
      if (!sameSet(wantEngines, got)) ok = false;
    } else {
      for (const e of wantEngines) {
        if (!got.includes(e)) {
          ok = false;
          break;
        }
      }
    }
  }

  if (expected.intent) {
    const got = actual.intent || actual.classification?.intent || null;
    detail.expectedIntent = expected.intent;
    detail.actualIntent = got;
    if (got !== expected.intent) ok = false;
  }

  return { ok, detail };
}

export function scoreEntity(actual, expected) {
  const want = Array.isArray(expected.entities) ? expected.entities : [];
  if (!want.length) {
    return { ok: true, skipped: true, detail: 'no expected entities' };
  }

  const got = actual.entities
    || actual.classification?.entities
    || actual.plan?.entities
    || [];

  const wantIds = new Set(want.map((n) => canonicalEntityId(n)).filter(Boolean));
  const gotIds = new Set(got.map((n) => canonicalEntityId(n)).filter(Boolean));

  let matched = 0;
  for (const id of wantIds) {
    if (gotIds.has(id)) matched += 1;
  }

  const ok = matched === wantIds.size;
  return {
    ok,
    detail: {
      expected: [...want],
      actual: [...got],
      expectedIds: [...wantIds],
      actualIds: [...gotIds],
      matched,
      wanted: wantIds.size,
    },
  };
}

/** Resolve aliases (TCS → Tata Consultancy Services) then issuer id. */
function canonicalEntityId(name) {
  const raw = String(name || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const stripped = issuerIdFromName(raw);
  const expanded = COMPANY_ALIASES[lower]
    || COMPANY_ALIASES[stripped]
    || raw;
  return issuerIdFromName(expanded);
}

export function scoreMetric(actual, expected) {
  if (!expected.metric) {
    return { ok: true, skipped: true, detail: 'no expected metric' };
  }
  const got = actual.metric
    || actual.classification?.metric
    || actual.plan?.metrics?.[0]
    || actual.data?.metric
    || null;

  // Allow total_emissions proxy only when explicitly assumed in data
  let ok = got === expected.metric;
  if (!ok && expected.metric === 'total_emissions' && got === 'total_emissions') ok = true;
  if (!ok && actual.data?.assumedMetric && got === actual.data.metric) {
    ok = false; // still fail hard match unless equal
  }

  return {
    ok,
    detail: { expected: expected.metric, actual: got },
  };
}

export function scoreYear(actual, expected) {
  if (expected.year == null) {
    return { ok: true, skipped: true, detail: 'no expected year' };
  }
  const want = Number(expected.year);
  const fromClass = actual.classification?.filters?.years?.[0];
  const fromPlan = actual.plan?.years?.[0];
  const fromData = actual.data?.year;
  const got = actual.year ?? fromClass ?? fromPlan ?? fromData ?? null;
  const ok = got != null && Number(got) === want;
  return {
    ok,
    detail: { expected: want, actual: got },
  };
}

export function scoreNumeric(actual, expected) {
  // Skip when pipeline/data not available
  if (!actual.pipelineRan && actual.data == null && !actual.text) {
    return { ok: true, skipped: true, detail: 'pipeline/data unavailable' };
  }

  if (expected.answerValidation) {
    const verdict = actual.responseValidation?.verdict
      || (actual.responseValidation?.ok === false ? 'ERROR' : null);
    if (expected.answerValidation === 'PASS_OR_WARNING') {
      const ok = verdict !== 'ERROR' && actual.responseValidation?.ok !== false;
      return { ok, detail: { verdict, required: 'PASS_OR_WARNING' } };
    }
    if (expected.answerValidation === 'PASS') {
      return { ok: verdict === 'PASS', detail: { verdict, required: 'PASS' } };
    }
  }

  if (Array.isArray(expected.values) && expected.values.length) {
    const rows = actual.data?.rows || [];
    if (!rows.length) {
      return { ok: false, detail: { reason: 'no_rows_for_value_check' } };
    }
    // Soft check: at least one expected value appears in rows
    const rowVals = new Set(
      rows.map((r) => Number(r.metric_value ?? r.value)).filter((n) => Number.isFinite(n)),
    );
    const hits = expected.values.filter((v) => rowVals.has(Number(v)));
    return {
      ok: hits.length > 0,
      detail: { expectedValues: expected.values, hits },
    };
  }

  // Default full-tier: structured rows present OR non-empty verified text
  const hasRows = Array.isArray(actual.data?.rows) && actual.data.rows.length > 0;
  const hasText = Boolean(String(actual.text || '').trim());
  const validationOk = actual.responseValidation
    ? actual.responseValidation.ok !== false && actual.responseValidation.verdict !== 'ERROR'
    : true;

  return {
    ok: (hasRows || hasText) && validationOk,
    detail: { hasRows, hasText, validationOk },
  };
}

export function scoreChart(actual, expected) {
  const chartExp = expected.chart || {};
  if (!chartExp.required) {
    return { ok: true, skipped: true, detail: 'chart not required' };
  }

  const text = String(actual.text || '');
  const hasBlock = /```json-chart\b/i.test(text)
    || Boolean(actual.visualization?.chartBlock);

  if (!hasBlock) {
    // Plan-mode: check needsVisualization / engines include visualization
    if (!actual.pipelineRan) {
      const engines = actual.requiredEngines || actual.plan?.requiredEngines || [];
      const wantsViz = Boolean(
        actual.plan?.needsVisualization
        || actual.plan?.visualization
        || engines.includes('visualization')
        || actual.classification?.filters?.wantsChart,
      );
      return {
        ok: wantsViz,
        detail: { mode: 'plan', wantsViz, hasBlock: false },
      };
    }
    return { ok: false, detail: { reason: 'missing_json_chart' } };
  }

  if (chartExp.chartType) {
    const parsed = parseChartType(actual);
    if (parsed && parsed !== chartExp.chartType && !compatibleChartType(parsed, chartExp.chartType)) {
      return {
        ok: false,
        detail: { expectedType: chartExp.chartType, actualType: parsed },
      };
    }
  }

  return { ok: true, detail: { hasBlock: true } };
}

export function scoreCitation(actual, expected) {
  const citExp = expected.citations || {};
  if (!citExp.required) {
    return { ok: true, skipped: true, detail: 'citations not required' };
  }

  if (!actual.pipelineRan && !actual.text) {
    // Plan-mode: report/pdf path expected
    const strategy = actual.executionStrategy || actual.plan?.executionStrategy;
    const engines = actual.requiredEngines || actual.plan?.requiredEngines || [];
    const ok = strategy === 'report'
      || engines.includes('report')
      || actual.plan?.needsReport
      || actual.plan?.needsPdf;
    return { ok: Boolean(ok), detail: { mode: 'plan', strategy, engines } };
  }

  const check = validateCitationPresence({
    text: actual.text || '',
    citations: actual.citations || [],
    required: true,
  });
  return {
    ok: check.ok,
    detail: { issues: check.issues },
  };
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}

function parseChartType(actual) {
  const block = actual.visualization?.chartBlock || '';
  const text = String(actual.text || '');
  const raw = block || text;
  const m = raw.match(/```json-chart\s*([\s\S]*?)\s*```/i);
  if (!m) return null;
  try {
    const cfg = JSON.parse(m[1]);
    return cfg.chartType || cfg.type || null;
  } catch {
    return null;
  }
}

function compatibleChartType(actual, expected) {
  // horizontalBar / groupedBar render as bar
  if (expected === 'bar' && ['bar', 'horizontalBar', 'groupedBar'].includes(actual)) return true;
  return actual === expected;
}
