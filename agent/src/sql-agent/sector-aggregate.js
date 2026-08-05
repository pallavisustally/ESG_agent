/**
 * Cross-sector / cross-industry aggregate SQL execution.
 *
 * Supports GROUP BY sector|industry with AVG | SUM | COUNT | MIN | MAX,
 * ranking, and optional charts via the Visualization Engine (Dataset → visualize).
 *
 * Single named-sector summary remains in sql-agent.js (sectorAggregate).
 */

import { getDb, isPostgres } from '../db.js';
import { getDerivedMetric, derivedMetricWhere } from '../intent/derived-metrics.js';
import {
  visualize,
  datasetFromSectorRows,
  createVisualizationContext,
  appendVisualizationToText,
  metricLabel,
} from '../visualization/index.js';

const AGGREGATIONS = new Set(['AVG', 'SUM', 'COUNT', 'MIN', 'MAX']);
const GROUP_KEYS = new Set(['sector', 'industry']);

const RANKABLE = new Set([
  'scope1_emissions',
  'scope2_emissions',
  'scope3_emissions',
  'emissions_intensity',
  'energy_consumption',
  'energy_intensity',
  'renewable_energy_share',
  'water_consumption',
  'water_intensity',
  'waste_generated',
  'waste_intensity',
  'female_employee_count',
  'female_employee_share',
  'female_board_count',
  'female_board_share',
  'total_employee_count',
  'safety_ltifr',
  'total_revenue',
  'total_emissions',
  'male_employee_count',
  'male_employee_share',
  'male_board_count',
  'male_board_share',
]);

function metricSelectExpr(metric) {
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

function normalizeAggregation(raw) {
  const a = String(raw || 'AVG').toUpperCase();
  return AGGREGATIONS.has(a) ? a : 'AVG';
}

function normalizeGroupBy(raw) {
  const g = String(raw || 'sector').toLowerCase();
  return GROUP_KEYS.has(g) ? g : 'sector';
}

function aggregationSql(aggregation, expr) {
  switch (aggregation) {
    case 'SUM':
      return `SUM(${expr})`;
    case 'COUNT':
      return `COUNT(DISTINCT company)`;
    case 'MIN':
      return `MIN(${expr})`;
    case 'MAX':
      return `MAX(${expr})`;
    case 'AVG':
    default:
      return `AVG(${expr})`;
  }
}

function aggregationLabel(aggregation) {
  switch (aggregation) {
    case 'SUM':
      return 'Total';
    case 'COUNT':
      return 'Company count';
    case 'MIN':
      return 'Minimum';
    case 'MAX':
      return 'Maximum';
    case 'AVG':
    default:
      return 'Average';
  }
}

/**
 * Rank sectors (or industries) by an aggregate of a BRSR metric.
 *
 * @returns {{
 *   ok: boolean,
 *   error?: string,
 *   rows?: object[],
 *   year?: number|null,
 *   assumedYear?: number|null,
 *   aggregation?: string,
 *   groupBy?: string,
 *   metric?: string,
 *   order?: string,
 *   sql?: string,
 * }}
 */
export async function rankGroupsByMetric({
  metric,
  aggregation = 'AVG',
  groupBy = 'sector',
  order = 'DESC',
  year = null,
  limit = 50,
} = {}) {
  if (!metric || !RANKABLE.has(metric)) {
    return { ok: false, error: `Unsupported aggregate metric: ${metric || '(none)'}` };
  }

  const agg = normalizeAggregation(aggregation);
  const groupKey = normalizeGroupBy(groupBy);
  const db = await getDb();

  let useYear = year != null ? Number(year) : null;
  if (!useYear) {
    const latest = await db.get('SELECT MAX(year) AS y FROM reports');
    useYear = latest?.y != null ? Number(latest.y) : null;
  }

  const expr = metricSelectExpr(metric);
  const aggExpr = aggregationSql(agg, expr);
  const where = [];
  const params = [];

  if (useYear) {
    where.push('year = ?');
    params.push(useYear);
  }

  // For metric aggregates, keep rows with a usable metric; COUNT can use all companies.
  if (agg !== 'COUNT') {
    where.push(metricWhere(metric));
    // Align with company ranking: ignore non-positive metric cells in AVG/SUM/MIN/MAX.
    if (metric !== 'total_emissions') {
      where.push(`${expr} > 0`);
    }
  }

  where.push(`NULLIF(TRIM(COALESCE(${groupKey}, '')), '') IS NOT NULL`);

  const dir = String(order).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const nulls = isPostgres() ? ' NULLS LAST' : '';
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const having = agg === 'COUNT'
    ? `${aggExpr} > 0`
    : `${aggExpr} IS NOT NULL AND ${aggExpr} > 0`;

  const sql = `
    SELECT
      TRIM(${groupKey}) AS group_label,
      COUNT(DISTINCT company) AS company_count,
      ${aggExpr} AS metric_value
    FROM reports
    ${whereSql}
    GROUP BY TRIM(${groupKey})
    HAVING ${having}
    ORDER BY ${aggExpr} ${dir}${nulls}, TRIM(${groupKey}) ASC
    LIMIT ?
  `.trim();

  params.push(Math.min(100, Math.max(1, Number(limit) || 50)));

  const rawRows = await db.all(sql, params);
  const rows = (rawRows || []).map((r) => ({
    sector: groupKey === 'sector' ? r.group_label : undefined,
    industry: groupKey === 'industry' ? r.group_label : undefined,
    group_label: r.group_label,
    company_count: Number(r.company_count) || 0,
    metric_value: r.metric_value == null ? null : Number(r.metric_value),
    year: useYear,
  })).filter((r) => r.group_label && r.metric_value != null && Number.isFinite(r.metric_value));

  return {
    ok: true,
    metric,
    aggregation: agg,
    groupBy: groupKey,
    order: dir,
    year: useYear,
    assumedYear: year == null && useYear ? useYear : null,
    rows,
    sql,
  };
}

/**
 * Format ranked sector/industry aggregates as markdown (+ optional json-chart).
 */
export function formatSectorRankMarkdown({
  rows,
  metric,
  aggregation = 'AVG',
  groupBy = 'sector',
  year = null,
  order = 'DESC',
  chart = false,
  assumedYear = null,
} = {}) {
  const agg = normalizeAggregation(aggregation);
  const groupKey = normalizeGroupBy(groupBy);
  const groupWord = groupKey === 'industry' ? 'industries' : 'sectors';
  const groupWordSingular = groupKey === 'industry' ? 'Industry' : 'Sector';
  const mLabel = metricLabel(metric);
  const aggWord = aggregationLabel(agg);
  const yearPart = year ? ` (${year})` : '';
  const rankWord = order === 'ASC' ? 'Lowest' : 'Highest';

  if (!rows?.length) {
    return {
      text: `No BRSR ${groupWord} found with ${aggWord.toLowerCase()} **${mLabel}**${yearPart}.`,
      chartBlock: null,
    };
  }

  const assumptions = [];
  if (assumedYear) {
    assumptions.push(`_Using latest available BRSR report year (${assumedYear})._`);
  }

  const summary = [
    `### ${rankWord} ${aggWord.toLowerCase()} ${mLabel} by ${groupWordSingular.toLowerCase()}${yearPart}`,
    '',
    `| # | ${groupWordSingular} | ${aggWord} ${mLabel} | Companies |`,
    `| --- | --- | --- | --- |`,
    ...rows.map((r, i) => {
      const label = r.group_label || r.sector || r.industry;
      const value = Number(r.metric_value).toLocaleString('en-IN', { maximumFractionDigits: 2 });
      return `| ${i + 1} | ${label} | ${value} | ${r.company_count ?? 'n/a'} |`;
    }),
    '',
    `_Values are ${aggWord.toLowerCase()} ${mLabel} from the structured BRSR \`reports\` table, grouped by ${groupKey}._`,
    ...assumptions,
  ].filter((line) => line !== undefined && line !== null).join('\n');

  let text = summary;
  let chartBlock = null;
  if (chart) {
    const dataset = datasetFromSectorRows({
      rows,
      metric,
      year,
      groupBy: groupKey,
      aggregation: agg,
      source: 'sql',
    });
    const context = createVisualizationContext({
      intent: 'SECTOR_SUMMARY',
      preferredIntent: 'ranking',
      metrics: [metric],
      year,
      order,
      title: `${rankWord} ${aggWord.toLowerCase()} ${mLabel} by ${groupKey}${yearPart}`,
      subtitle: `${rows.length} ${groupWord}`,
      source: 'BRSR structured reports (sector aggregate)',
      ranking: true,
      aggregation: agg,
      grouping: groupKey,
      dataset,
    });
    const viz = visualize({ dataset, context, includeInsights: true, summary });
    text = appendVisualizationToText(summary, viz);
    chartBlock = viz.ok ? viz.chartBlock : null;
  }

  return { text, chartBlock };
}

/**
 * End-to-end: aggregate → format → optional chart.
 */
export async function runSectorGroupAggregate({
  metric,
  aggregation = 'AVG',
  groupBy = 'sector',
  order = 'DESC',
  year = null,
  limit = 50,
  wantsChart = false,
} = {}) {
  const result = await rankGroupsByMetric({
    metric,
    aggregation,
    groupBy,
    order,
    year,
    limit,
  });
  if (!result.ok) {
    return { ok: false, error: result.error, data: result };
  }
  if (!result.rows.length) {
    const { text } = formatSectorRankMarkdown({
      rows: [],
      metric,
      aggregation,
      groupBy,
      year: result.year,
      order: result.order,
    });
    return { ok: true, text, data: result };
  }

  const { text, chartBlock } = formatSectorRankMarkdown({
    rows: result.rows,
    metric: result.metric,
    aggregation: result.aggregation,
    groupBy: result.groupBy,
    year: result.year,
    order: result.order,
    chart: wantsChart,
    assumedYear: result.assumedYear,
  });

  return {
    ok: true,
    text,
    chartBlock,
    data: result,
  };
}

export { RANKABLE as SECTOR_AGGREGATE_METRICS, AGGREGATIONS, normalizeAggregation, normalizeGroupBy };
