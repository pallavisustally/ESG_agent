/**
 * Recommendation grounding — map verified analytics / peers / sector into facts.
 *
 * Deterministic only. Never invents metric values.
 */

import { getDb } from '../db.js';
import { getDerivedMetric, derivedMetricWhere } from '../intent/derived-metrics.js';
import { issuerIdFromName } from '../sql-agent/company-identity.js';

const METRIC_TOPIC = {
  scope1_emissions: 'carbon',
  scope2_emissions: 'carbon',
  scope3_emissions: 'carbon',
  total_emissions: 'carbon',
  emissions_intensity: 'carbon',
  energy_consumption: 'carbon',
  renewable_energy_share: 'carbon',
  water_consumption: 'water',
  water_intensity: 'water',
  waste_generated: 'waste',
  waste_intensity: 'waste',
  female_employee_share: 'diversity',
  female_board_share: 'diversity',
  female_employee_count: 'diversity',
  female_board_count: 'diversity',
};

/** Metrics where higher is worse for ESG (prefer reducing). */
const LOWER_IS_BETTER = new Set([
  'scope1_emissions',
  'scope2_emissions',
  'scope3_emissions',
  'total_emissions',
  'emissions_intensity',
  'energy_consumption',
  'water_consumption',
  'water_intensity',
  'waste_generated',
  'waste_intensity',
  'safety_ltifr',
]);

export const GENERAL_GUIDANCE_BANNER =
  'No verified BRSR data was available for this company on the requested topic — '
  + 'the advice below is **general sustainability best practice**, not company-specific.';

function metricExpr(metric) {
  if (metric === 'total_emissions') {
    return '(COALESCE(scope1_emissions,0)+COALESCE(scope2_emissions,0)+COALESCE(scope3_emissions,0))';
  }
  const derived = getDerivedMetric(metric);
  if (derived) return derived.sqlExpr;
  return metric;
}

function metricWhere(metric) {
  if (metric === 'total_emissions') {
    return '(COALESCE(scope1_emissions,0)+COALESCE(scope2_emissions,0)+COALESCE(scope3_emissions,0)) > 0';
  }
  const derivedWhere = derivedMetricWhere(metric);
  if (derivedWhere) return derivedWhere;
  return `${metric} IS NOT NULL`;
}

export function topicForMetric(metric) {
  if (!metric) return null;
  return METRIC_TOPIC[metric] || null;
}

export function formatMetricLabel(metric) {
  return String(metric || 'metric').replace(/_/g, ' ');
}

export function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-IN', { maximumFractionDigits: 1 });
  return String(Math.round(n * 100) / 100);
}

function directionForGap(metric, companyValue, benchmarkValue) {
  const c = Number(companyValue);
  const b = Number(benchmarkValue);
  if (!Number.isFinite(c) || !Number.isFinite(b) || b === 0) return 'unknown';
  const rel = (c - b) / Math.abs(b);
  if (Math.abs(rel) < 0.05) return 'on_par';
  const higher = c > b;
  if (LOWER_IS_BETTER.has(metric)) {
    return higher ? 'above' : 'below';
  }
  // Higher is better (shares, renewables)
  return higher ? 'above' : 'below';
}

function gapPct(companyValue, benchmarkValue) {
  const c = Number(companyValue);
  const b = Number(benchmarkValue);
  if (!Number.isFinite(c) || !Number.isFinite(b) || b === 0) return null;
  return Math.round(((c - b) / Math.abs(b)) * 1000) / 10;
}

/**
 * Extract company metric facts from analytics / SQL engine data.
 */
export function factsFromAnalyticsData(analyticsData, {
  companies = [],
  metric = null,
} = {}) {
  const facts = [];
  if (!analyticsData || typeof analyticsData !== 'object') return facts;

  const wantMetric = metric || analyticsData.metric || null;
  const year = analyticsData.year ?? null;
  const rows = Array.isArray(analyticsData.rows) ? analyticsData.rows : [];

  // Single-company lookup shape
  if (analyticsData.value != null && (analyticsData.resolvedCompany || companies[0])) {
    const company = analyticsData.resolvedCompany || companies[0];
    const m = wantMetric || analyticsData.metric;
    if (m) {
      facts.push({
        topic: topicForMetric(m) || 'esg_score',
        metric: m,
        company,
        companyValue: Number(analyticsData.value),
        year: analyticsData.year ?? year,
        benchmarkType: 'self',
        benchmarkValue: null,
        gapPct: null,
        direction: 'unknown',
        source: 'analytics',
      });
    }
  }

  // Ranking / compare rows
  const preferIds = new Set(
    (companies || []).map((c) => issuerIdFromName(c)).filter(Boolean),
  );
  for (const row of rows) {
    if (row?.metric_value == null && row?.value == null) continue;
    const company = row.company;
    if (!company) continue;
    if (preferIds.size) {
      const id = issuerIdFromName(company);
      if (id && !preferIds.has(id)) continue;
    }
    const m = wantMetric || analyticsData.metric || row.metric || null;
    if (!m) continue;
    facts.push({
      topic: topicForMetric(m) || 'esg_score',
      metric: m,
      company,
      companyValue: Number(row.metric_value ?? row.value),
      year: row.year ?? year,
      benchmarkType: 'self',
      benchmarkValue: null,
      gapPct: null,
      direction: 'unknown',
      source: 'analytics',
    });
  }

  return facts.filter((f) => Number.isFinite(f.companyValue));
}

/**
 * Attach peer benchmarks when multiple company rows exist for the same metric.
 */
export function attachPeerBenchmarks(facts = [], peerData = null) {
  const rows = Array.isArray(peerData?.rows) ? peerData.rows
    : (Array.isArray(peerData) ? peerData : []);
  if (!rows.length || facts.length < 1) return facts;

  return facts.map((fact) => {
    const peerVals = rows
      .filter((r) => {
        if (r.metric_value == null && r.value == null) return false;
        const id = issuerIdFromName(r.company);
        const selfId = issuerIdFromName(fact.company);
        return id && selfId && id !== selfId;
      })
      .map((r) => Number(r.metric_value ?? r.value))
      .filter((n) => Number.isFinite(n));
    if (!peerVals.length) return fact;
    const peerAvg = peerVals.reduce((a, b) => a + b, 0) / peerVals.length;
    return {
      ...fact,
      benchmarkType: 'peer',
      benchmarkValue: peerAvg,
      gapPct: gapPct(fact.companyValue, peerAvg),
      direction: directionForGap(fact.metric, fact.companyValue, peerAvg),
      source: fact.source === 'analytics' ? 'peer' : fact.source,
    };
  });
}

/**
 * Attach sector-average benchmarks onto self facts.
 */
export function attachSectorBenchmarks(facts = [], sectorData = null) {
  if (!sectorData || sectorData.avg == null) return facts;
  const avg = Number(sectorData.avg);
  if (!Number.isFinite(avg)) return facts;

  return facts.map((fact) => {
    if (fact.benchmarkType === 'peer' && fact.benchmarkValue != null) return fact;
    return {
      ...fact,
      benchmarkType: 'sector_avg',
      benchmarkValue: avg,
      gapPct: gapPct(fact.companyValue, avg),
      direction: directionForGap(fact.metric, fact.companyValue, avg),
      source: 'sector',
      sector: sectorData.sector || null,
    };
  });
}

/**
 * Build full grounding package.
 */
export function buildRecommendationGrounding({
  analyticsData = null,
  peerData = null,
  sectorData = null,
  companies = [],
  metric = null,
} = {}) {
  let facts = factsFromAnalyticsData(analyticsData, { companies, metric });

  // If analytics rows look like a compare set, use them as peers too
  const compareRows = analyticsData?.rows?.length >= 2 ? analyticsData : peerData;
  facts = attachPeerBenchmarks(facts, compareRows);
  facts = attachSectorBenchmarks(facts, sectorData);

  const groundedTopics = new Set(facts.map((f) => f.topic).filter(Boolean));
  const companySpecific = facts.length > 0;

  return {
    facts,
    groundedTopics,
    companySpecific,
  };
}

/**
 * Fetch sector average for a company's sector + metric (best-effort).
 */
export async function fetchSectorBenchmark({
  company,
  metric,
  year = null,
} = {}) {
  if (!company || !metric) return null;
  try {
    const db = await getDb();
    const companyRow = year
      ? await db.get(
        'SELECT company, sector, year FROM reports WHERE company = ? AND year = ? LIMIT 1',
        [company, year],
      )
      : await db.get(
        'SELECT company, sector, year FROM reports WHERE company = ? ORDER BY year DESC LIMIT 1',
        [company],
      );
    if (!companyRow?.sector) return null;

    const expr = metricExpr(metric);
    const where = metricWhere(metric);
    const params = [companyRow.sector];
    let yearClause = '';
    if (year || companyRow.year) {
      yearClause = ' AND year = ?';
      params.push(year || companyRow.year);
    }
    const sql = `
      SELECT AVG(${expr}) AS avg_value, COUNT(DISTINCT company) AS company_count
      FROM reports
      WHERE COALESCE(NULLIF(TRIM(sector), ''), 'Unknown') = ?
        AND ${where}${yearClause}
    `;
    const agg = await db.get(sql, params);
    if (agg?.avg_value == null) return null;
    return {
      sector: companyRow.sector,
      metric,
      year: year || companyRow.year || null,
      avg: Number(agg.avg_value),
      companyCount: Number(agg.company_count) || 0,
      company: companyRow.company,
    };
  } catch {
    return null;
  }
}

/**
 * Turn a grounded fact into a recommendation lever sentence.
 */
export function groundedLeverFromFact(fact) {
  const label = formatMetricLabel(fact.metric);
  const companyVal = formatNumber(fact.companyValue);
  const yearBit = fact.year ? ` (${fact.year})` : '';
  const company = fact.company || 'the company';

  if (fact.benchmarkType === 'sector_avg' && fact.benchmarkValue != null) {
    const bench = formatNumber(fact.benchmarkValue);
    const gap = fact.gapPct != null ? `${Math.abs(fact.gapPct)}%` : null;
    if (fact.direction === 'above' && LOWER_IS_BETTER.has(fact.metric)) {
      return `${company}'s **${label}** is **${companyVal}**${yearBit}, about ${gap || 'above'} the **${fact.sector || 'sector'} average (${bench})** — prioritize reduction actions and disclose a clear abatement pathway.`;
    }
    if (fact.direction === 'below' && LOWER_IS_BETTER.has(fact.metric)) {
      return `${company}'s **${label}** is **${companyVal}**${yearBit}, below the **${fact.sector || 'sector'} average (${bench})** — maintain controls and keep improving year-on-year disclosure quality.`;
    }
    if (fact.direction === 'below' && !LOWER_IS_BETTER.has(fact.metric)) {
      return `${company}'s **${label}** is **${companyVal}**${yearBit}, below the **${fact.sector || 'sector'} average (${bench})** — close the gap with targeted programs and transparent targets.`;
    }
    if (fact.direction === 'above' && !LOWER_IS_BETTER.has(fact.metric)) {
      return `${company}'s **${label}** is **${companyVal}**${yearBit}, above the **${fact.sector || 'sector'} average (${bench})** — sustain leadership and document what peers can learn from.`;
    }
    return `${company}'s **${label}** is **${companyVal}**${yearBit} vs sector average **${bench}** — benchmark annually and address the largest gaps first.`;
  }

  if (fact.benchmarkType === 'peer' && fact.benchmarkValue != null) {
    const bench = formatNumber(fact.benchmarkValue);
    return `${company}'s **${label}** is **${companyVal}**${yearBit} vs peer average **${bench}** — focus improvement on the largest verified gap versus named peers.`;
  }

  return `${company} reports **${label}** of **${companyVal}**${yearBit} in verified BRSR data — set a reduction/improvement target and track progress against this baseline.`;
}

/**
 * Short structured bullets for the verified-data section.
 */
export function formatFactsSummary(facts = []) {
  if (!facts.length) return null;
  return facts.slice(0, 5).map((f) => {
    const label = formatMetricLabel(f.metric);
    const val = formatNumber(f.companyValue);
    const yearBit = f.year ? ` (${f.year})` : '';
    if (f.benchmarkValue != null) {
      const bench = formatNumber(f.benchmarkValue);
      const kind = f.benchmarkType === 'peer' ? 'peer avg' : 'sector avg';
      return `- **${f.company}** · ${label}: **${val}**${yearBit} vs ${kind} **${bench}**`;
    }
    return `- **${f.company}** · ${label}: **${val}**${yearBit}`;
  }).join('\n');
}
