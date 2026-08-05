/**
 * Deterministic SQL agent for BRSR structured questions.
 * Prefer templated SQL over LLM-generated SQL for list/count/rank/filter.
 */

import { getDb, getCompanyList, isPostgres } from '../db.js';
import { withSectorBreakdownCache } from '../cache/company-cache.js';
import { INTENTS } from '../intent/classify-intent.js';
import { paginateArray, formatCompanyPageMarkdown, DEFAULT_PAGE_SIZE } from '../pagination/pagination.js';
import { resolveCompanyEntity } from './company-resolve.js';
import {
  buildCompanyIdentityIndex,
  dedupeCompanyNames,
  dedupeRankingRows,
} from './company-identity.js';
import { runCompanyCompare } from './compare-companies.js';
import {
  isEmissionRankMetric,
  filterNormalizeEmissionRankingRows,
} from './emission-normalize.js';
import {
  getDerivedMetric,
  derivedMetricWhere,
} from '../intent/derived-metrics.js';
import {
  visualize,
  datasetFromRankingRows,
  createVisualizationContext,
  appendVisualizationToText,
} from '../visualization/index.js';
import { runSectorGroupAggregate } from './sector-aggregate.js';


const RANK_METRICS = new Set([
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

function escapeLike(value) {
  return String(value).replace(/'/g, "''");
}

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
  return `${metric} IS NOT NULL AND ${metric} > 0`;
}

async function companiesBySector(sector) {
  const db = await getDb();
  const rows = await db.all(
    `SELECT DISTINCT company FROM reports
     WHERE lower(COALESCE(sector,'')) = lower(?)
     ORDER BY company`,
    [sector],
  );
  // Phase 3: collapse ACC LIMITED / ACC Limited etc. to one canonical name.
  return dedupeCompanyNames(rows.map((r) => r.company)).sort((a, b) => a.localeCompare(b));
}

async function uniqueCompanyList() {
  const companies = await getCompanyList();
  return dedupeCompanyNames(companies).sort((a, b) => a.localeCompare(b));
}

async function sectorBreakdown() {
  return withSectorBreakdownCache('sector_breakdown', async () => {
    const db = await getDb();
    return db.all(
      `SELECT COALESCE(NULLIF(TRIM(sector), ''), 'Unknown') AS sector,
              COUNT(DISTINCT company) AS company_count
       FROM reports
       GROUP BY 1
       ORDER BY company_count DESC, sector ASC`,
    );
  });
}

/**
 * Single-company structured metric lookup (SQL primary before document fallback).
 */
async function lookupCompanyMetricRow({ company, metric, year = null }) {
  const db = await getDb();
  const expr = metricSelectExpr(metric);
  const cols = `company, year, sector, ${expr} AS metric_value`;
  if (year) {
    const sql = `SELECT ${cols} FROM reports WHERE company = ? AND year = ? LIMIT 1`;
    const row = await db.get(sql, [company, year]);
    if (row) {
      return { row, value: row.metric_value, sql };
    }
  }
  const sql = `SELECT ${cols} FROM reports WHERE company = ? ORDER BY year DESC LIMIT 1`;
  const row = await db.get(sql, [company]);
  return { row: row || null, value: row?.metric_value ?? null, sql };
}

async function rankMetric({ metric, order = 'DESC', year = null, sector = null, limit = 10 }) {
  if (!RANK_METRICS.has(metric)) {
    return { error: `Unsupported ranking metric: ${metric}` };
  }
  const db = await getDb();
  let useYear = year;
  // Without a year, rank within the latest reporting year so we don't mix FY rows.
  if (!useYear) {
    const latest = await db.get('SELECT MAX(year) AS y FROM reports');
    useYear = latest?.y != null ? Number(latest.y) : null;
  }
  const expr = metricSelectExpr(metric);
  const where = [metricWhere(metric)];
  const params = [];
  if (useYear) {
    where.push('year = ?');
    params.push(useYear);
  }
  if (sector) {
    where.push('lower(COALESCE(sector,\'\')) = lower(?)');
    params.push(sector);
  }
  where.push(`lower(company) NOT LIKE '%unknown%'`);
  // Drop obvious parse garbage in SQL (SIS-scale billions) before JS unit normalization.
  if (isEmissionRankMetric(metric)) {
    where.push('COALESCE(scope1_emissions,0) < 2000000000');
    where.push('COALESCE(scope2_emissions,0) < 2000000000');
    where.push('COALESCE(scope3_emissions,0) < 2000000000');
  }
  const dir = String(order).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const nulls = isPostgres() ? ' NULLS LAST' : '';
  const emissionCols = isEmissionRankMetric(metric)
    ? `, scope1_emissions, scope1_unit, scope2_emissions, scope2_unit, scope3_emissions, scope3_unit, industry`
    : '';
  const sql = `
    SELECT company, year, sector${emissionCols}, ${expr} AS metric_value
    FROM reports
    WHERE ${where.join(' AND ')}
    ORDER BY metric_value ${dir}${nulls}
    LIMIT ?
  `;
  // Larger buffer: issuer dedupe + emission unit/outlier drops still need to fill `limit`.
  const fetchLimit = isEmissionRankMetric(metric)
    ? Math.min(400, Math.max(limit * 12, 80))
    : Math.min(200, Math.max(limit * 3, limit + 20));
  params.push(fetchLimit);
  const rows = await db.all(sql, params);
  const { rows: normalizedRows, dropped } = filterNormalizeEmissionRankingRows(rows, metric, { order: dir });
  const index = buildCompanyIdentityIndex(normalizedRows.map((r) => r.company).filter(Boolean));
  const deduped = dedupeRankingRows(normalizedRows, { order: dir, index }).slice(0, limit);
  return {
    metric,
    order: dir,
    year: useYear,
    assumedYear: !year && useYear ? useYear : null,
    rows: deduped,
    droppedOutliers: dropped,
    sql: sql.trim(),
  };
}

async function sectorAggregate(sector, year = null) {
  const db = await getDb();
  const where = [`lower(COALESCE(sector,'')) = lower(?)`];
  const params = [sector];
  if (year) {
    where.push('year = ?');
    params.push(year);
  }
  const row = await db.get(
    `SELECT
       COUNT(DISTINCT company) AS company_count,
       AVG(scope1_emissions) AS avg_scope1,
       AVG(scope2_emissions) AS avg_scope2,
       AVG(renewable_energy_share) AS avg_renewable_share,
       AVG(female_employee_share) AS avg_female_employee_share
     FROM reports
     WHERE ${where.join(' AND ')}`,
    params,
  );
  return row;
}

/**
 * Execute a deterministic plan against the BRSR reports table.
 * @returns {{ ok: boolean, text?: string, data?: object, error?: string, memoryUpdate?: object }}
 */
export async function runSqlAgent({ plan, classification, memory = null }) {
  const intent = plan?.intent || classification?.intent;
  const filters = { ...(memory?.filters || {}), ...(plan?.filters || {}), ...(classification?.filters || {}) };
  const wantsAll = Boolean(classification?.wantsAll || plan?.strategy === 'sql_list_all_paginated');
  const page = plan?.page || memory?.page || 1;
  const pageSize = plan?.pageSize || (wantsAll ? DEFAULT_PAGE_SIZE : 25);
  const sector = filters.sector || null;
  const year = filters.years?.[0] || null;
  const metric = plan?.metric || filters.metric || classification?.metric || null;

  try {
    if (intent === INTENTS.COUNT_COMPANIES) {
      const companies = sector ? await companiesBySector(sector) : await uniqueCompanyList();
      const scope = sector ? ` in **${sector}**` : '';
      const text = `There are **${companies.length}** companies${scope} with indexed BRSR reports.`;
      return {
        ok: true,
        text,
        data: { total: companies.length, sector },
        memoryUpdate: { lastIntent: intent, filters, awaitingMore: false },
      };
    }

    if (
      intent === INTENTS.LIST_ALL_COMPANIES
      || intent === INTENTS.FILTER_BY_SECTOR
      || intent === INTENTS.PAGINATE_CONTINUE
    ) {
      const listSector = sector;
      const companies = listSector ? await companiesBySector(listSector) : await uniqueCompanyList();
      const bySector = listSector ? null : await sectorBreakdown();
      const paged = paginateArray(companies, { page, pageSize });
      const exportQs = new URLSearchParams({ format: 'csv' });
      if (listSector) exportQs.set('sector', listSector);
      const exportPath = `/api/companies?${exportQs.toString()}`;

      let text = formatCompanyPageMarkdown({
        ...paged,
        items: paged.items,
        sector: listSector,
        exportPath,
        wantsAll: wantsAll || intent === INTENTS.LIST_ALL_COMPANIES || intent === INTENTS.PAGINATE_CONTINUE,
      });

      if (bySector?.length && page === 1 && intent !== INTENTS.PAGINATE_CONTINUE) {
        const breakdown = bySector
          .slice(0, 12)
          .map((r) => `- ${r.sector}: ${r.company_count}`)
          .join('\n');
        text = `${text}\n\n### Sector breakdown\n${breakdown}`;
      }

      return {
        ok: true,
        text,
        data: {
          total: paged.total,
          page: paged.page,
          pageSize: paged.pageSize,
          companies: paged.items,
          truncated: paged.hasNext,
          exportPath,
          by_sector: bySector,
        },
        memoryUpdate: {
          lastIntent: INTENTS.LIST_ALL_COMPANIES,
          filters: { ...filters, sector: listSector },
          page: paged.page,
          pageSize: paged.pageSize,
          total: paged.total,
          lastList: { type: 'companies', sector: listSector, items: paged.items },
          lastPageItems: paged.items,
          lastCompanies: paged.items,
          lastTool: 'SQL',
          lastSector: listSector || null,
          awaitingMore: paged.hasNext,
          wantsAll: true,
          lastPlan: { ...plan, page: paged.page, pageSize: paged.pageSize, intent: INTENTS.LIST_ALL_COMPANIES },
        },
      };
    }

    if (intent === INTENTS.TOP_METRIC || intent === INTENTS.BOTTOM_METRIC) {
      if (!metric || !RANK_METRICS.has(metric)) {
        return { ok: false, error: 'No supported BRSR metric identified for ranking.' };
      }
      const order = intent === INTENTS.BOTTOM_METRIC ? 'ASC' : (filters.order || 'DESC');
      const limit = Math.min(50, Math.max(1, parseInt(filters.limit || plan?.pageSize || 5, 10) || 5));
      const result = await rankMetric({
        metric,
        order,
        year,
        sector,
        limit,
      });
      if (result.error) return { ok: false, error: result.error };
      if (!result.rows.length) {
        return {
          ok: true,
          text: `No BRSR rows found for **${metric}**${year ? ` in ${year}` : ''}${sector ? ` (${sector})` : ''}.`,
          data: result,
        };
      }
      const metricLabel = metric === 'total_emissions'
        ? 'total GHG emissions (Scope 1+2+3)'
        : metric;
      const rankYear = result.year || year;
      const lines = result.rows.map(
        (r, i) => `${i + 1}. **${r.company}** (${r.year}): ${Number(r.metric_value).toLocaleString('en-IN')}${r.sector ? ` — ${r.sector}` : ''}`,
      );
      const unitNote = isEmissionRankMetric(metric)
        ? '_Values are normalized to tCO2e from BRSR Scope fields (kg/Mt labels corrected; implausible light-sector / parse outliers excluded)._'
        : '_Values are from the structured BRSR `reports` table (Scope 1+2+3 sum when ranking carbon/GHG)._';
      const summary = [
        `### Top ${result.rows.length} by ${metricLabel}${rankYear ? ` (${rankYear})` : ''}`,
        '',
        ...lines,
        '',
        unitNote,
      ].filter(Boolean).join('\n');

      let text = summary;
      let chartBlock = null;
      if (filters.wantsChart) {
        const dataset = datasetFromRankingRows({
          rows: result.rows,
          metric,
          year: rankYear,
          source: 'sql',
        });
        const context = createVisualizationContext({
          intent: order === 'ASC' ? 'BOTTOM_METRIC' : 'TOP_METRIC',
          preferredIntent: 'ranking',
          metrics: [metric],
          year: rankYear,
          order,
          userMessage: plan?.userMessage || '',
          source: 'BRSR structured reports',
          ranking: true,
          dataset,
        });
        const viz = visualize({ dataset, context, includeInsights: true, summary });
        text = appendVisualizationToText(summary, viz);
        chartBlock = viz.ok ? viz.chartBlock : null;
      }
      return {
        ok: true,
        text,
        data: result,
        assumptions: [
          ...(result.assumedYear
            ? [`Using latest available BRSR report (${result.assumedYear}).`]
            : []),
          ...(isEmissionRankMetric(metric)
            ? ['Emission rankings use tCO2e after unit normalization; extreme parse outliers are excluded.']
            : []),
        ],
        memoryUpdate: {
          lastIntent: intent,
          filters: { ...filters, metric, limit, ...(rankYear ? { years: [rankYear] } : {}) },
          lastMetric: metric,
          lastYear: rankYear || null,
          lastCompanies: result.rows.map((r) => r.company).filter(Boolean),
          lastPageItems: result.rows.map((r) => r.company).filter(Boolean),
          lastTool: 'SQL',
          awaitingMore: false,
        },
      };
    }

    if (intent === INTENTS.COMPARE_COMPANIES) {
      const entities = classification?.entities || plan?.entities || [];
      const metrics = filters.metrics
        || plan?.metrics
        || (metric ? [metric] : []);
      const compare = await runCompanyCompare({
        entities,
        metrics,
        year,
        wantsChart: Boolean(filters.wantsChart),
      });
      if (compare.ok && compare.text) {
        const compared = (compare.data?.resolved || []).map((r) => r.company).filter(Boolean);
        return {
          ok: true,
          text: compare.text,
          data: compare.data,
          memoryUpdate: {
            lastIntent: intent,
            filters: { ...filters, metrics, ...(year ? { years: [year] } : {}) },
            entities: compared.length ? compared : entities,
            lastCompanies: compared.length ? compared : entities,
            lastMetric: metrics[0] || metric || null,
            lastYear: year || compare.data?.rows?.[0]?.year || null,
            lastTool: 'SQL',
            awaitingMore: false,
            lastPlan: plan,
          },
        };
      }
      if (compare.error === 'need_two_companies') {
        return {
          ok: true,
          text: 'Please name at least two companies to compare (e.g. “Compare Infosys and Asian Paints Scope 1 in 2026”).',
          data: compare,
        };
      }
      // Phase 11: do not soft-handoff compares to the LLM — pipeline will explain failure.
      return {
        ok: false,
        error: compare.error || 'compare_sql_failed',
        data: compare.data,
      };
    }

    // Cross-sector / cross-industry aggregate (GROUP BY + AVG/SUM/… + optional chart).
    // Planner already sets acrossAllSectors / groupBy / aggregation for these asks.
    if (intent === INTENTS.SECTOR_SUMMARY) {
      const wantsGroupAggregate = Boolean(
        filters.acrossAllSectors
        || filters.groupBy === 'sector'
        || filters.groupBy === 'industry'
        || (metric && !sector),
      );

      if (wantsGroupAggregate && metric) {
        const grouped = await runSectorGroupAggregate({
          metric,
          aggregation: filters.aggregation || 'AVG',
          groupBy: filters.groupBy || 'sector',
          order: filters.order || 'DESC',
          year,
          limit: Math.min(50, Math.max(1, parseInt(filters.limit || 50, 10) || 50)),
          wantsChart: Boolean(filters.wantsChart),
        });
        if (!grouped.ok) {
          return {
            ok: false,
            error: grouped.error || 'sector_aggregate_failed',
            data: grouped.data,
          };
        }
        return {
          ok: true,
          text: grouped.text,
          data: grouped.data,
          memoryUpdate: {
            lastIntent: intent,
            filters: {
              ...filters,
              metric,
              aggregation: filters.aggregation || 'AVG',
              groupBy: filters.groupBy || 'sector',
              ...(year ? { years: [year] } : {}),
            },
            lastMetric: metric,
            lastYear: grouped.data?.year || year || null,
            lastTool: 'SQL',
            awaitingMore: false,
            lastPlan: plan,
          },
        };
      }

      // Legacy path: named single-sector overview (no metric group-by ranking).
      if (sector) {
        const agg = await sectorAggregate(sector, year);
        const text = [
          `### Sector summary — ${sector}${year ? ` (${year})` : ''}`,
          '',
          `- Companies with BRSR rows: **${agg?.company_count ?? 0}**`,
          `- Avg Scope 1: **${agg?.avg_scope1 != null ? Number(agg.avg_scope1).toFixed(2) : 'n/a'}**`,
          `- Avg Scope 2: **${agg?.avg_scope2 != null ? Number(agg.avg_scope2).toFixed(2) : 'n/a'}**`,
          `- Avg renewable energy share: **${agg?.avg_renewable_share != null ? Number(agg.avg_renewable_share).toFixed(2) : 'n/a'}**`,
          `- Avg female employee share: **${agg?.avg_female_employee_share != null ? Number(agg.avg_female_employee_share).toFixed(2) : 'n/a'}**`,
        ].join('\n');
        return { ok: true, text, data: agg, memoryUpdate: { lastIntent: intent, filters, awaitingMore: false } };
      }
    }

    if (
      (intent === INTENTS.METRIC_LOOKUP || intent === INTENTS.REPORT_LOOKUP || intent === INTENTS.COMPANY_SUMMARY)
      && classification?.entities?.length
    ) {
      const resolved = await resolveCompanyEntity(classification.entities[0], getCompanyList);
      if (resolved.status === 'not_found') {
        return { ok: true, text: `No BRSR company matched **${classification.entities[0]}**.`, data: resolved };
      }
      if (resolved.status === 'ambiguous') {
        return { ok: true, text: resolved.message, data: resolved };
      }

      // Company metric lookup: structured SQL first (derived already resolved upstream).
      if (
        (intent === INTENTS.METRIC_LOOKUP || intent === INTENTS.REPORT_LOOKUP)
        && metric
        && (RANK_METRICS.has(metric) || getDerivedMetric(metric) || metric === 'total_emissions')
      ) {
        const lookup = await lookupCompanyMetricRow({
          company: resolved.company,
          metric,
          year,
        });
        if (lookup.row && lookup.value != null && !Number.isNaN(Number(lookup.value))) {
          const label = metric === 'total_emissions'
            ? 'total GHG emissions (Scope 1+2+3)'
            : (getDerivedMetric(metric)?.label || metric.replace(/_/g, ' '));
          const text = [
            `### ${resolved.company} — ${label}${lookup.row.year ? ` (${lookup.row.year})` : ''}`,
            '',
            `**${Number(lookup.value).toLocaleString('en-IN', { maximumFractionDigits: 4 })}**`,
            '',
            '_Value from the structured BRSR `reports` table._',
          ].join('\n');
          return {
            ok: true,
            text,
            data: {
              resolvedCompany: resolved.company,
              year: lookup.row.year,
              metric,
              value: Number(lookup.value),
              row: lookup.row,
              sql: lookup.sql,
            },
            memoryUpdate: {
              lastIntent: intent,
              filters,
              resolvedCompany: resolved.company,
              lastMetric: metric,
              lastYear: lookup.row.year || year || null,
              lastCompanies: [resolved.company],
              lastTool: 'SQL',
            },
          };
        }
        // SQL miss → pipeline may run company-scoped document fallback.
        return {
          ok: false,
          error: 'metric_not_in_sql',
          data: {
            resolvedCompany: resolved.company,
            year: lookup.row?.year || year || null,
            metric,
            matches: resolved.matches,
          },
          memoryUpdate: {
            lastIntent: intent,
            filters,
            resolvedCompany: resolved.company,
            lastMetric: metric,
            lastYear: lookup.row?.year || year || null,
          },
        };
      }

      // Fall through to LLM tools with resolved name hint — return soft handoff
      return {
        ok: false,
        error: 'handoff_llm',
        data: {
          resolvedCompany: resolved.company,
          year: year || null,
          matches: resolved.matches,
        },
        memoryUpdate: { lastIntent: intent, filters, resolvedCompany: resolved.company },
      };
    }

    return { ok: false, error: 'handoff_llm' };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

export { RANK_METRICS, escapeLike };
