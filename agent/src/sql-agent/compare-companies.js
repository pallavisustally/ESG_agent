/**
 * Deterministic multi-company BRSR comparison (templated SQL + table formatting).
 */

import { getDb, getCompanyList } from '../db.js';
import { getDerivedMetric, derivedMetricSelectExpr } from '../intent/derived-metrics.js';
import { resolveCompanyEntity } from './company-resolve.js';
import {
  buildCompanyIdentityIndex,
  issuerIdFromName,
} from './company-identity.js';
import {
  visualize,
  datasetFromCompareRows,
  createVisualizationContext,
  appendVisualizationToText,
} from '../visualization/index.js';

export const COMPARE_METRICS = [
  'scope1_emissions',
  'scope2_emissions',
  'scope3_emissions',
  'total_emissions',
  'emissions_intensity',
  'renewable_energy_share',
  'energy_consumption',
  'water_consumption',
  'waste_generated',
  'female_employee_count',
  'female_employee_share',
  'female_board_count',
  'female_board_share',
  'total_employee_count',
  'total_revenue',
  'safety_ltifr',
  'male_employee_count',
  'male_employee_share',
  'male_board_count',
  'male_board_share',
];

const METRIC_LABELS = {
  scope1_emissions: 'Scope 1 emissions (tCO2e)',
  scope2_emissions: 'Scope 2 emissions (tCO2e)',
  scope3_emissions: 'Scope 3 emissions (tCO2e)',
  total_emissions: 'Total GHG Scope 1+2+3 (tCO2e)',
  emissions_intensity: 'Emissions intensity',
  renewable_energy_share: 'Renewable energy share (%)',
  energy_consumption: 'Energy consumption',
  water_consumption: 'Water consumption',
  waste_generated: 'Waste generated',
  female_employee_count: 'Female employee count',
  female_employee_share: 'Female employee share (%)',
  female_board_count: 'Female board count',
  female_board_share: 'Female board share (%)',
  total_employee_count: 'Total employee count',
  total_revenue: 'Total revenue',
  safety_ltifr: 'Safety LTIFR',
  male_employee_count: 'Male employee count',
  male_employee_share: 'Male employee share (%)',
  male_board_count: 'Male board count',
  male_board_share: 'Male board share (%)',
};

function selectExpr(metric) {
  if (metric === 'total_emissions') {
    return '(COALESCE(scope1_emissions,0)+COALESCE(scope2_emissions,0)+COALESCE(scope3_emissions,0)) AS total_emissions';
  }
  const derivedSelect = derivedMetricSelectExpr(metric);
  if (derivedSelect) return derivedSelect;
  const derived = getDerivedMetric(metric);
  if (derived) return `${derived.sqlExpr} AS ${derived.id}`;
  return metric;
}

function formatValue(metric, value) {
  if (value == null || Number.isNaN(Number(value))) return 'n/a';
  const n = Number(value);
  if (/share|intensity/i.test(metric)) return n.toFixed(2);
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  return String(n);
}

/**
 * Resolve 2–3 company query strings to canonical BRSR names.
 */
export async function resolveCompareCompanies(entityQueries) {
  const listFn = getCompanyList;
  const resolved = [];
  const ambiguous = [];
  const missing = [];

  for (const q of entityQueries.slice(0, 3)) {
    const result = await resolveCompanyEntity(q, listFn);
    if (result.status === 'resolved') {
      const company = result.canonical_company || result.company;
      const issuer_id = result.issuer_id || issuerIdFromName(company);
      // Phase 3: never compare the same issuer twice (ACC vs ACC Limited).
      if (!resolved.some((r) => r.issuer_id === issuer_id || r.company === company)) {
        resolved.push({ query: q, company, canonical_company: company, issuer_id });
      }
    } else if (result.status === 'ambiguous') {
      ambiguous.push(result);
    } else {
      missing.push(q);
    }
  }

  return { resolved, ambiguous, missing };
}

/**
 * Expand canonical names to all DB surface variants (ACC Limited + ACC LIMITED).
 */
async function expandCompanySurfaces(companies) {
  const all = await getCompanyList();
  const index = buildCompanyIdentityIndex(all);
  const surfaces = new Set();
  const canonicalByIssuer = new Map();

  for (const company of companies) {
    const id = issuerIdFromName(company);
    const rec = index.byIssuer.get(id);
    if (rec) {
      canonicalByIssuer.set(id, rec.canonical_company);
      for (const v of rec.variants) surfaces.add(v);
    } else {
      surfaces.add(company);
      canonicalByIssuer.set(id || company.toLowerCase(), company);
    }
  }

  return { surfaces: [...surfaces], canonicalByIssuer, index };
}

function collapseRowsToCanonical(rows, canonicalByIssuer) {
  const best = new Map();
  for (const row of rows) {
    const id = issuerIdFromName(row.company);
    const canonical = canonicalByIssuer.get(id) || row.company;
    const key = `${id}|${row.year}`;
    const prev = best.get(key);
    const next = { ...row, company: canonical, issuer_id: id };
    if (!prev) {
      best.set(key, next);
      continue;
    }
    // Prefer the row that has more non-null metric fields when duplicates share year.
    const prevFilled = Object.values(prev).filter((v) => v != null && v !== '').length;
    const nextFilled = Object.values(next).filter((v) => v != null && v !== '').length;
    if (nextFilled > prevFilled) best.set(key, next);
  }
  return [...best.values()];
}

/**
 * @param {{ companies: string[], metrics: string[], year?: number|null }} opts
 */
export async function fetchCompareRows({ companies, metrics, year = null }) {
  const db = await getDb();
  const cols = ['company', 'year', 'sector'];
  for (const m of metrics) {
    if (!COMPARE_METRICS.includes(m)) continue;
    cols.push(selectExpr(m));
  }

  const { surfaces, canonicalByIssuer } = await expandCompanySurfaces(companies);
  const placeholders = surfaces.map(() => '?').join(', ');
  const where = [`company IN (${placeholders})`];
  const params = [...surfaces];
  if (year) {
    where.push('year = ?');
    params.push(year);
  }

  let sql = `
    SELECT ${cols.join(', ')}
    FROM reports
    WHERE ${where.join(' AND ')}
    ORDER BY company, year DESC
  `;
  let rows = await db.all(sql, params);
  rows = collapseRowsToCanonical(rows, canonicalByIssuer);

  // If year requested but some issuers missing, fall back to latest year per issuer.
  if (year) {
    const foundIssuers = new Set(rows.map((r) => r.issuer_id || issuerIdFromName(r.company)));
    for (const company of companies) {
      const id = issuerIdFromName(company);
      if (foundIssuers.has(id)) continue;
      const variants = surfaces.filter((s) => issuerIdFromName(s) === id);
      for (const surface of variants.length ? variants : [company]) {
        const latest = await db.get(
          `SELECT ${cols.join(', ')} FROM reports WHERE company = ? ORDER BY year DESC LIMIT 1`,
          [surface],
        );
        if (latest) {
          rows.push({
            ...latest,
            company: canonicalByIssuer.get(id) || company,
            issuer_id: id,
          });
          foundIssuers.add(id);
          break;
        }
      }
    }
  }

  // Without year: keep latest row per issuer
  if (!year) {
    const best = new Map();
    for (const row of rows) {
      const id = row.issuer_id || issuerIdFromName(row.company);
      const prev = best.get(id);
      if (!prev || Number(row.year) > Number(prev.year)) best.set(id, row);
    }
    rows = [...best.values()];
  }

  return { rows, sql: sql.trim() };
}

export function formatCompareMarkdown({ rows, metrics, year, resolved, chart = false }) {
  if (!rows.length) {
    return {
      text: `No BRSR rows found for the compared companies${year ? ` in ${year}` : ''}.`,
      chartBlock: null,
    };
  }

  const header = ['Company', 'Year', ...metrics.map((m) => METRIC_LABELS[m] || m)];
  const tableLines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
  ];
  for (const row of rows) {
    const cells = [
      row.company,
      String(row.year ?? ''),
      ...metrics.map((m) => formatValue(m, row[m])),
    ];
    tableLines.push(`| ${cells.join(' | ')} |`);
  }

  const notes = [];
  if (year) {
    const offYear = rows.filter((r) => Number(r.year) !== Number(year));
    if (offYear.length) {
      notes.push(
        `_Note: ${offYear.map((r) => `${r.company} used ${r.year}`).join('; ')} (requested ${year} not available)._`,
      );
    }
  }
  for (const r of resolved || []) {
    if (r.query && r.company && r.query.toLowerCase() !== r.company.toLowerCase()) {
      notes.push(`_Resolved **${r.query}** → **${r.company}**._`);
    }
  }

  const summary = [
    `### Company comparison${year ? ` (${year})` : ''}`,
    '',
    ...tableLines,
    '',
    ...notes,
    '',
    '_Values from the structured BRSR `reports` table._',
  ].filter(Boolean).join('\n');

  let text = summary;
  let chartBlock = null;
  if (chart && metrics.length && rows.length) {
    const dataset = datasetFromCompareRows({
      rows,
      metrics,
      year,
      source: 'sql',
    });
    const context = createVisualizationContext({
      intent: 'COMPARE_COMPANIES',
      preferredIntent: 'comparison',
      metrics,
      year,
      comparison: true,
      source: 'BRSR structured reports',
      dataset,
    });
    const viz = visualize({ dataset, context, includeInsights: true, summary });
    text = appendVisualizationToText(summary, viz);
    chartBlock = viz.ok ? viz.chartBlock : null;
  }

  return { text, chartBlock };
}

/**
 * End-to-end compare for SQL agent.
 */
export async function runCompanyCompare({
  entities = [],
  metrics = [],
  year = null,
  wantsChart = false,
}) {
  if (!entities.length || entities.length < 2) {
    return { ok: false, error: 'need_two_companies' };
  }

  const { resolved, ambiguous, missing } = await resolveCompareCompanies(entities);
  if (ambiguous.length) {
    return {
      ok: true,
      text: ambiguous.map((a) => a.message).join('\n\n'),
      data: { ambiguous, missing, resolved },
    };
  }
  if (missing.length && resolved.length < 2) {
    return {
      ok: true,
      text: `Could not resolve companies: ${missing.join(', ')}. Try fuller BRSR legal names.`,
      data: { missing, resolved },
    };
  }
  if (resolved.length < 2) {
    return { ok: false, error: 'need_two_companies' };
  }

  let useMetrics = metrics.filter((m) => COMPARE_METRICS.includes(m));
  if (!useMetrics.length) {
    useMetrics = ['scope1_emissions', 'renewable_energy_share'];
  } else if (useMetrics.length > 2 && !wantsChart) {
    // Keep tables readable by default (year + units still shown per column).
    useMetrics = useMetrics.slice(0, 2);
  }

  const companies = resolved.map((r) => r.company);
  const { rows, sql } = await fetchCompareRows({ companies, metrics: useMetrics, year });
  // Issuer collapse already applied in fetchCompareRows (latest year per issuer when year unset).
  const { text } = formatCompareMarkdown({
    rows,
    metrics: useMetrics,
    year,
    resolved,
    chart: wantsChart,
  });

  return {
    ok: true,
    text,
    data: { rows, metrics: useMetrics, companies, year, sql, resolved, missing },
  };
}
