/**
 * Sanitize ranking / ORDER BY SQL so Postgres matches SQLite-style expectations.
 *
 * Postgres: ORDER BY col DESC sorts NULLs first by default.
 * SQLite:   NULLs sort last under DESC.
 * After migrating to Neon, top-N rankings were returning null-share rows.
 */

import { rewriteAliasedSqlColumns, normalizeMetricQueryText } from './metric-aliases.js';

/** Columns the agent may SELECT / filter / ORDER BY on `reports`. */
export const REPORTS_COLUMNS = new Set([
  'id',
  'company',
  'year',
  'filename',
  'is_custom',
  'scope1_emissions',
  'scope1_unit',
  'scope2_emissions',
  'scope2_unit',
  'scope3_emissions',
  'scope3_unit',
  'energy_consumption',
  'energy_unit',
  'renewable_energy_consumption',
  'renewable_energy_unit',
  'renewable_energy_share',
  'water_consumption',
  'water_consumption_unit',
  'water_withdrawal',
  'water_withdrawal_unit',
  'waste_generated',
  'waste_unit',
  'sector',
  'industry',
  'total_revenue',
  'emissions_intensity',
  'energy_intensity',
  'water_intensity',
  'waste_intensity',
  'female_employee_count',
  'total_employee_count',
  'female_employee_share',
  'male_employee_count',
  'male_employee_share',
  'female_board_count',
  'total_board_count',
  'female_board_share',
  'safety_ltifr',
  'water_discharge_recycled',
  'waste_recovered_recycled',
  'ghg_reduction_projects',
  'waste_management_practices',
  'zero_liquid_discharge_details',
  'data_json',
  'pdf_url',
  'xbrl_url',
  'metric_pages_json',
  'created_at',
]);

export const RANKABLE_METRICS = new Set([
  'scope1_emissions',
  'scope2_emissions',
  'scope3_emissions',
  'energy_consumption',
  'renewable_energy_consumption',
  'renewable_energy_share',
  'water_consumption',
  'water_withdrawal',
  'waste_generated',
  'emissions_intensity',
  'energy_intensity',
  'water_intensity',
  'waste_intensity',
  'female_employee_count',
  'total_employee_count',
  'female_employee_share',
  'male_employee_count',
  'male_employee_share',
  'female_board_count',
  'total_board_count',
  'female_board_share',
  'safety_ltifr',
  'total_revenue',
]);

const SQL_NOISE_TOKENS = new Set([
  'select', 'from', 'where', 'and', 'or', 'not', 'null', 'as', 'on', 'join', 'left', 'right',
  'inner', 'outer', 'cross', 'group', 'by', 'order', 'asc', 'desc', 'limit', 'offset', 'having',
  'distinct', 'case', 'when', 'then', 'else', 'end', 'in', 'is', 'like', 'between', 'exists',
  'union', 'all', 'true', 'false', 'cast', 'coalesce', 'nullif', 'round', 'lower', 'upper',
  'trim', 'length', 'substr', 'substring', 'avg', 'sum', 'min', 'max', 'count', 'abs',
  'greatest', 'least', 'reports', 'nulls', 'first', 'last', 'over', 'partition',
  'row_number', 'rank', 'dense_rank', 'numeric', 'double', 'precision', 'real', 'text', 'integer',
  'interval', 'date', 'timestamp', 'extract',
]);

/**
 * True when the question asks for a slice/metric we do not store as its own column
 * (so metric rewrites must not silently answer a different question).
 */
export function hasUnsupportedMetricQualifier(userMessage = '') {
  const q = String(userMessage || '').toLowerCase();
  // Note: "value chain" is NOT here — Metric Normalization maps it to Scope 3.
  // Supplier-only / social slices remain unsupported when not paired with emissions.
  if (/\bvalue\s*chain\b/.test(q) && /\b(emission|carbon|ghg|scope)\b/.test(q)) {
    return false;
  }
  return /\bdisabled\b|\bdifferently[-\s]?abled\b|\bpwd\b|\bhandicap|\bimpair|\bpermanent\b|\btemporary\b|\bcontract(ual)?\b|\bmigrant\b|\bcaste\b|\btribal\b|\bsc\/?st\b|\bobc\b|\bage\s*group\b|\bsenior\s*citizen\b|\bsupplier\b|\bcsr\b|\btraining\s*hours?\b|\bminimum\s*wage\b|\bparental\s*leave\b|\bsexual\s*harassment\b|\bhuman\s*rights\b|\bscope\s*4\b|\bscope\s*3\.?\d/.test(q);
}

/** Human-readable column list for tool errors / model retries. */
export function listReportsColumns() {
  return [...REPORTS_COLUMNS].sort().join(', ');
}

/**
 * Detect invented snake_case / metric-like column names in SQL before execution.
 * @returns {string[]} unknown identifiers that look like column references
 */
export function findUnknownSqlColumns(query) {
  let sql = String(query || '');
  if (!sql.trim()) return [];
  // Ignore string/number literals so LIKE '%unknown%' does not look like a column.
  sql = sql.replace(/'(?:''|[^'])*'/g, "''");
  sql = sql.replace(/"(?:""|[^"])*"/g, '""');
  sql = sql.replace(/\b\d+(?:\.\d+)?\b/g, '0');
  // SELECT ... AS total_ghg_emissions is an output alias, not a schema column.
  sql = sql.replace(/\bas\s+[a-z_][a-z0-9_]*/gi, 'AS _out_alias');

  const unknown = new Set();
  for (const match of sql.matchAll(/\b([a-z_][a-z0-9_]*)\b/gi)) {
    const token = match[1].toLowerCase();
    if (SQL_NOISE_TOKENS.has(token) || token === '_out_alias') continue;
    if (REPORTS_COLUMNS.has(token)) continue;
    // Prefer metric-style names; plain words are often aliases or LIKE remnants.
    if (!token.includes('_') && !/^scope\d/.test(token)) continue;
    unknown.add(token);
  }
  return [...unknown];
}

const SHARE_METRICS = new Set([
  'female_employee_share',
  'male_employee_share',
  'female_board_share',
  'renewable_energy_share',
]);

const SHARE_DENOMINATOR = {
  female_employee_share: 'total_employee_count',
  male_employee_share: 'total_employee_count',
  female_board_share: 'total_board_count',
};

/**
 * If the user asked for female/workforce *share* but the model ordered by *count*,
 * rewrite the SQL to use female_employee_share.
 */
export function alignRankingQueryWithQuestion(query, userMessage = '') {
  let sql = String(query || '').trim().replace(/;+\s*$/, '');
  const q = String(userMessage || '').toLowerCase();
  if (!sql || !q) return sql;
  // Do not rewrite toward female_employee_share when the user asked for an unavailable slice.
  if (hasUnsupportedMetricQualifier(q)) return sql;

  const mentionsFemaleWorkforce = /\bfemale\b|\bwomen\b|\bgender\b|\bworkforce\b|\bdiversity\b/.test(q);
  const wantsShare = mentionsFemaleWorkforce && /\bshare\b|\bpercentage\b|\bpercent\b|\bproportion\b|\b%/.test(q);
  const explicitlyWantsCount = mentionsFemaleWorkforce
    && /\b(count|headcount|number of female|female employees?\s+count)\b/.test(q)
    && !/\bshare\b/.test(q);

  if (wantsShare && !explicitlyWantsCount) {
    sql = sql.replace(
      /\border\s+by\s+(?:reports\.)?female_employee_count\b/ig,
      'ORDER BY female_employee_share',
    );
    // Ensure share + denominator columns are selected when ranking by share.
    if (/\bfrom\s+reports\b/i.test(sql)) {
      const selectPart = sql.split(/\bfrom\s+reports\b/i)[0];
      const missing = ['female_employee_share', 'female_employee_count', 'total_employee_count']
        .filter((col) => !new RegExp(`\\b${col}\\b`, 'i').test(selectPart));
      if (missing.length) {
        sql = sql.replace(/^select\s+/i, `SELECT ${missing.join(', ')}, `);
      }
    }
  }

  return sql;
}

/**
 * Canonical fallback when a "top female share" question still returns bad rows.
 */
export function buildFemaleShareRankingSql(year, limit = 5) {
  const y = Number(year);
  const lim = Math.max(1, Number(limit) || 5);
  if (!Number.isFinite(y)) return null;
  return `
    SELECT company, year, female_employee_share, female_employee_count, total_employee_count
    FROM reports
    WHERE year = ${y}
      AND female_employee_share IS NOT NULL
      AND female_employee_share > 0
      AND total_employee_count > 0
      AND company IS NOT NULL
      AND lower(company) NOT LIKE '%unknown%'
    ORDER BY female_employee_share DESC NULLS LAST
    LIMIT ${Math.max(lim * 3, lim + 10)}
  `.replace(/\s+/g, ' ').trim();
}

export function detectFemaleShareRankingIntent(userMessage = '') {
  const q = String(userMessage || '').toLowerCase();
  if (hasUnsupportedMetricQualifier(q)) return false;
  const mentionsFemaleWorkforce = /\bfemale\b|\bwomen\b|\bgender\b|\bworkforce\b|\bdiversity\b/.test(q);
  const wantsShare = mentionsFemaleWorkforce && /\bshare\b|\bpercentage\b|\bpercent\b|\bproportion\b|\b%/.test(q);
  const isTopN = /\btop\b|\bhighest\b|\branking\b|\brank\b|\bmost\b/.test(q);
  return wantsShare && isTopN;
}

/**
 * @returns {{ sql: string, orderColumn: string|null, orderDir: 'ASC'|'DESC'|null, limit: number|null }}
 */
export function sanitizeMetricOrderQuery(query, { postgres = false, userMessage = '' } = {}) {
  let sql = rewriteAliasedSqlColumns(query, userMessage);
  sql = alignRankingQueryWithQuestion(sql, userMessage);
  sql = ensurePositiveEmissionsSqlFilter(sql, userMessage);
  if (!sql) return { sql, orderColumn: null, orderDir: null, limit: null };

  const limitMatch = sql.match(/\blimit\s+(\d+)\b/i);
  const limit = limitMatch ? Number(limitMatch[1]) : null;

  const orderMatch = sql.match(
    /\border\s+by\s+(?:reports\.)?([a-z_][a-z0-9_]*)\s*(asc|desc)?(?:\s+nulls\s+(first|last))?/i,
  );
  if (!orderMatch) {
    // Still return limit so callers can slice; emissions filter already applied above.
    return { sql, orderColumn: null, orderDir: null, limit };
  }

  const orderColumn = orderMatch[1].toLowerCase();
  const orderDir = (orderMatch[2] || 'ASC').toUpperCase();
  if (!RANKABLE_METRICS.has(orderColumn)) {
    return { sql, orderColumn, orderDir, limit };
  }

  // Postgres DESC puts NULLs first — force NULLS LAST for rankings.
  if (postgres && orderDir === 'DESC' && !/\bnulls\s+(first|last)\b/i.test(orderMatch[0])) {
    sql = sql.replace(
      new RegExp(`(order\\s+by\\s+(?:reports\\.)?${orderColumn}\\s+desc)`, 'i'),
      '$1 NULLS LAST',
    );
  }
  // Lowest rankings: also keep NULLs out of the result order.
  if (postgres && orderDir === 'ASC' && !/\bnulls\s+(first|last)\b/i.test(orderMatch[0])) {
    sql = sql.replace(
      new RegExp(`(order\\s+by\\s+(?:reports\\.)?${orderColumn}\\s+asc)`, 'i'),
      '$1 NULLS LAST',
    );
  }

  const alreadyFiltersNull = new RegExp(`\\b${orderColumn}\\s+is\\s+not\\s+null\\b`, 'i').test(sql);
  const alreadyPositive = new RegExp(`\\b${orderColumn}\\s*>\\s*0\\b`, 'i').test(sql);

  const filters = [];
  if (!alreadyFiltersNull) filters.push(`${orderColumn} IS NOT NULL`);
  // "Highest" rankings should never surface zeros/null-like placeholders.
  if (orderDir === 'DESC' && !alreadyPositive) {
    filters.push(`${orderColumn} > 0`);
  } else if (SHARE_METRICS.has(orderColumn) && !alreadyPositive) {
    filters.push(`${orderColumn} > 0`);
  }
  const denom = SHARE_DENOMINATOR[orderColumn];
  if (denom && !new RegExp(`\\b${denom}\\s*>\\s*0\\b`, 'i').test(sql)) {
    filters.push(`${denom} > 0`);
  }
  if (!/not\s+like\s+'%unknown%'/i.test(sql)) {
    filters.push(`company IS NOT NULL`);
    filters.push(`lower(company) NOT LIKE '%unknown%'`);
  }

  if (filters.length) {
    sql = injectWhereFilters(sql, filters);
  }

  // Inflate LIMIT so duplicate company-name variants can be deduped later.
  if (limit != null && Number.isFinite(limit) && limit > 0) {
    const fetchLimit = Math.max(limit * 3, limit + 10);
    sql = sql.replace(/\blimit\s+\d+\b/i, `LIMIT ${fetchLimit}`);
  }

  return { sql, orderColumn, orderDir, limit };
}

function injectWhereFilters(sql, filters) {
  const clause = filters.join(' AND ');
  if (/\bwhere\b/i.test(sql)) {
    return sql.replace(/\bwhere\b/i, `WHERE ${clause} AND `);
  }
  if (/\bgroup\s+by\b/i.test(sql)) {
    return sql.replace(/\bgroup\s+by\b/i, `WHERE ${clause} GROUP BY`);
  }
  if (/\border\s+by\b/i.test(sql)) {
    return sql.replace(/\border\s+by\b/i, `WHERE ${clause} ORDER BY`);
  }
  return `${sql} WHERE ${clause}`;
}

function isUnknownCompany(name) {
  const key = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return !key || key === 'unknown' || key.includes('unknown company') || key === 'unknown company';
}

/**
 * Drop invalid ranking rows and keep the best row per normalized company name.
 */
export function filterRankingRows(rows, orderColumn, orderDir = 'DESC') {
  if (!orderColumn || !Array.isArray(rows) || !rows.length) return rows;
  if (!RANKABLE_METRICS.has(orderColumn)) return rows;

  const desc = String(orderDir || 'DESC').toUpperCase() !== 'ASC';
  const requirePositive = desc || SHARE_METRICS.has(orderColumn);
  const denom = SHARE_DENOMINATOR[orderColumn];

  const usable = rows.filter((row) => {
    if (isUnknownCompany(row?.company)) return false;
    const value = Number(row?.[orderColumn]);
    if (!Number.isFinite(value)) return false;
    if (requirePositive && value <= 0) return false;
    if (denom) {
      const d = Number(row?.[denom]);
      if (!Number.isFinite(d) || d <= 0) return false;
    }
    return true;
  });

  const bestByCompany = new Map();
  for (const row of usable) {
    const key = String(row.company || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    if (!key) continue;
    const existing = bestByCompany.get(key);
    if (!existing) {
      bestByCompany.set(key, row);
      continue;
    }
    const a = Number(existing[orderColumn]);
    const b = Number(row[orderColumn]);
    if (!Number.isFinite(a) || (Number.isFinite(b) && (desc ? b > a : b < a))) {
      bestByCompany.set(key, row);
    }
  }

  const deduped = [...bestByCompany.values()];
  deduped.sort((a, b) => {
    const av = Number(a[orderColumn]);
    const bv = Number(b[orderColumn]);
    return desc ? bv - av : av - bv;
  });
  return deduped;
}

export function rankingLooksInvalid(rows, orderColumn, { minRows = 1 } = {}) {
  if (!orderColumn || !Array.isArray(rows)) return true;
  if (rows.length < minRows) return true;
  const positive = rows.filter((r) => Number(r?.[orderColumn]) > 0);
  return positive.length < Math.min(minRows, 3);
}

const SCOPE_EMISSION_COLS = ['scope1_emissions', 'scope2_emissions', 'scope3_emissions'];

/** True when the question is about carbon/GHG/scope emissions (not intensity-only). */
export function detectEmissionsDataIntent(userMessage = '') {
  const q = normalizeMetricQueryText(String(userMessage || '').toLowerCase());
  if (!q.trim()) return false;
  // Intensity-only questions use emissions_intensity, not scope totals.
  const isIntensity =
    /\b(carbon|ghg|greenhouse)\s+emissions?\s+intensity\b/.test(q)
    || /\b(carbon|ghg|greenhouse|emission)s?\s+intensity\b/.test(q)
    || /\bintensity\s+of\s+(carbon|ghg|emission)s?\b/.test(q);
  if (isIntensity && !/\bscope\s*[-]?\s*[123]\b/.test(q)) {
    return false;
  }
  return (
    /\b(carbon|ghg|greenhouse)\b/.test(q)
    || /\bscope\s*[-]?\s*[123]\b/.test(q)
    || /\bscope[123]_emissions\b/.test(q)
    || /\btco2e?\b/.test(q)
  );
}

function rowHasPositiveEmissions(row) {
  if (!row || typeof row !== 'object') return false;
  return SCOPE_EMISSION_COLS.some((col) => {
    const n = Number(row[col]);
    return Number.isFinite(n) && n > 0;
  });
}

/**
 * Drop companies whose Scope 1/2/3 are all null/zero (common junk for carbon overviews).
 */
export function filterZeroEmissionRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const hasScopeCols = rows.some((r) => SCOPE_EMISSION_COLS.some((c) => c in (r || {})));
  if (!hasScopeCols) return rows;
  return rows.filter((row) => {
    if (isUnknownCompany(row?.company)) return false;
    return rowHasPositiveEmissions(row);
  });
}

/**
 * When SQL mentions scope emissions but has no positive-emissions filter, require total GHG > 0.
 */
export function ensurePositiveEmissionsSqlFilter(sql = '', userMessage = '') {
  let out = String(sql || '').trim().replace(/;+\s*$/, '');
  if (!out) return out;
  if (!detectEmissionsDataIntent(userMessage) && !/scope[123]_emissions/i.test(out)) {
    return out;
  }
  if (!/scope[123]_emissions/i.test(out)) return out;

  const totalExpr =
    '(COALESCE(scope1_emissions,0)+COALESCE(scope2_emissions,0)+COALESCE(scope3_emissions,0))';
  if (new RegExp(`${totalExpr.replace(/[()]/g, '\\$&')}\\s*>\\s*0`, 'i').test(out)) {
    return out;
  }
  // Already has an explicit positive filter on at least one scope.
  if (/scope[123]_emissions\s*>\s*0/i.test(out)) return out;

  return injectWhereFilters(out, [`${totalExpr} > 0`]);
}

/**
 * Fallback when a carbon/GHG overview returns only zeros/nulls.
 */
export function buildCarbonEmissionsOverviewSql(year, limit = 10) {
  const y = Number(year);
  const lim = Math.max(1, Number(limit) || 10);
  if (!Number.isFinite(y)) return null;
  const totalExpr =
    '(COALESCE(scope1_emissions,0)+COALESCE(scope2_emissions,0)+COALESCE(scope3_emissions,0))';
  return `
    SELECT company, year, sector, industry,
           scope1_emissions, scope1_unit, scope2_emissions, scope2_unit, scope3_emissions, scope3_unit,
           ${totalExpr} AS total_ghg_emissions
    FROM reports
    WHERE year = ${y}
      AND ${totalExpr} > 0
      AND COALESCE(scope1_emissions,0) < 2000000000
      AND COALESCE(scope2_emissions,0) < 2000000000
      AND COALESCE(scope3_emissions,0) < 2000000000
      AND company IS NOT NULL
      AND lower(company) NOT LIKE '%unknown%'
    ORDER BY total_ghg_emissions DESC NULLS LAST
    LIMIT ${Math.max(lim * 12, 80)}
  `.replace(/\s+/g, ' ').trim();
}
