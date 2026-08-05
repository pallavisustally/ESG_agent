/**
 * Normalize BRSR Scope 1/2/3 figures to tCO2e and drop unit/parse garbage
 * before emissions rankings / charts.
 *
 * Common XBRL issues in this corpus:
 * - Unit label MtCO2e with values already in tCO2e (UltraTech ~8e7)
 * - True Mt values stored as small numbers (NTPC 2023: 335.72 Mt)
 * - kg CO2e stored without conversion
 * - Absurd billions (SIS Scope 2 ~2e10)
 * - Light sectors (banks / healthcare) with multi‑Mt totals from bad parses
 */

/** Hard ceiling for a single scope after normalization (~500 Mt). */
export const MAX_SCOPE_TCO2E = 5e8;
/** Hard ceiling for Scope 1+2+3 after normalization (~800 Mt). */
export const MAX_TOTAL_TCO2E = 8e8;
/**
 * Above this with an Mt* unit, treat the number as already tCO2e (mislabeled Mt).
 * True Mt disclosures for Indian majors are almost always well below 10,000 Mt.
 */
export const MT_AS_TONNES_THRESHOLD = 10_000;
/** Soft cap for banks / healthcare / IT after normalization (5 Mt). */
export const LIGHT_SECTOR_MAX_TCO2E = 5e6;

const LIGHT_SECTOR_RE =
  /\b(financial|technology|healthcare|consumer\s+staples|communication|information\s+technology)\b/i;
const LIGHT_INDUSTRY_RE =
  /\b(bank|finance|insurance|software|it\s+services|pharma|diagnostic|hospital|health\s*care|fmcg|fintech|asset\s+management)\b/i;
const LIGHT_NAME_RE =
  /\b(bank|pharma|pharmaceutical|health\s*care|hospital|insurance|software|fintech|payments?\s+bank|infosys|wipro|hcl\s+tech|tcs)\b/i;

/**
 * @param {unknown} unit
 * @returns {'t'|'kt'|'mt'|'kg'|'unknown'}
 */
export function classifyEmissionUnit(unit) {
  const u = String(unit || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!u || u === '-' || u === '—' || u === 'pure') return 'unknown';
  if (/\bkg\b|kilogram/.test(u)) return 'kg';
  // Match ktCO2e / kt before Mt — "ktco2e" has no \b between kt and co.
  if (/(^|[^a-z])kt(\b|co)|kilotonn|kilo\s*tonn/.test(u)) return 'kt';
  if (
    /\bmmt\b|\bmt\s*co|\bmtco|\bmillion\s+metric|\bmillion\s+tonn|\bmegatonn|(^|[^a-z])mt(\b|co)/.test(u)
  ) {
    return 'mt';
  }
  if (/\btco2|\btonnes?\b|\btons?\b|\bmetric\s+tonn/.test(u)) return 't';
  return 'unknown';
}

export function isLightEmissionProfile({ company, sector, industry } = {}) {
  return (
    LIGHT_SECTOR_RE.test(String(sector || ''))
    || LIGHT_INDUSTRY_RE.test(String(industry || ''))
    || LIGHT_NAME_RE.test(String(company || ''))
  );
}

/**
 * Convert one scope reading to tCO2e.
 * @returns {{ value: number|null, rejected: boolean, reason: string|null, assumedUnit: string }}
 */
export function normalizeScopeToTco2e(rawValue, unit, { lightProfile = false } = {}) {
  const n = Number(rawValue);
  if (rawValue == null || rawValue === '' || !Number.isFinite(n) || n < 0) {
    return { value: null, rejected: false, reason: null, assumedUnit: 'none' };
  }
  if (n === 0) {
    return { value: 0, rejected: false, reason: null, assumedUnit: 'zero' };
  }

  let kind = classifyEmissionUnit(unit);
  let value = n;
  let assumedUnit = kind;

  if (kind === 'kg') {
    value = n / 1000;
    assumedUnit = 'kg→t';
  } else if (kind === 'kt') {
    value = n * 1000;
    assumedUnit = 'kt→t';
  } else if (kind === 'mt') {
    if (n <= MT_AS_TONNES_THRESHOLD) {
      value = n * 1e6;
      assumedUnit = 'mt→t';
    } else {
      // Mislabeled Mt: corpus stores tonnes under MtCO2e for many rows.
      value = n;
      assumedUnit = 'mt-as-t';
    }
  } else {
    assumedUnit = kind === 't' ? 't' : 'raw';
  }

  // Light sectors with multi‑Mt totals: often kg figures mis-tagged as t/Mt.
  if (lightProfile && value > LIGHT_SECTOR_MAX_TCO2E) {
    const asKg = n / 1000;
    if (asKg > 0 && asKg <= LIGHT_SECTOR_MAX_TCO2E) {
      value = asKg;
      assumedUnit = `${assumedUnit}|light-kg→t`;
    } else if (value > LIGHT_SECTOR_MAX_TCO2E) {
      return {
        value: null,
        rejected: true,
        reason: 'light_sector_implausible',
        assumedUnit,
      };
    }
  }

  if (value > MAX_SCOPE_TCO2E) {
    return {
      value: null,
      rejected: true,
      reason: 'scope_exceeds_max',
      assumedUnit,
    };
  }

  return { value, rejected: false, reason: null, assumedUnit };
}

/**
 * Normalize a reports row's Scope 1/2/3 to tCO2e.
 * @returns {{
 *   ok: boolean,
 *   reason: string|null,
 *   scope1: number|null,
 *   scope2: number|null,
 *   scope3: number|null,
 *   total: number,
 *   assumptions: string[],
 * }}
 */
export function normalizeEmissionRow(row = {}) {
  const lightProfile = isLightEmissionProfile(row);
  const assumptions = [];
  const scopes = [
    ['scope1', row.scope1_emissions, row.scope1_unit],
    ['scope2', row.scope2_emissions, row.scope2_unit],
    ['scope3', row.scope3_emissions, row.scope3_unit],
  ];

  const out = { scope1: null, scope2: null, scope3: null };
  for (const [key, raw, unit] of scopes) {
    const n = normalizeScopeToTco2e(raw, unit, { lightProfile });
    if (n.rejected) {
      return {
        ok: false,
        reason: n.reason,
        scope1: null,
        scope2: null,
        scope3: null,
        total: 0,
        assumptions,
      };
    }
    out[key] = n.value;
    if (n.assumedUnit && n.assumedUnit !== 't' && n.assumedUnit !== 'none' && n.assumedUnit !== 'zero' && n.assumedUnit !== 'raw') {
      assumptions.push(`${key}:${n.assumedUnit}`);
    }
  }

  const total = [out.scope1, out.scope2, out.scope3]
    .map((v) => (v != null && Number.isFinite(v) ? v : 0))
    .reduce((a, b) => a + b, 0);

  if (total > MAX_TOTAL_TCO2E) {
    return {
      ok: false,
      reason: 'total_exceeds_max',
      ...out,
      total,
      assumptions,
    };
  }

  if (lightProfile && total > LIGHT_SECTOR_MAX_TCO2E) {
    return {
      ok: false,
      reason: 'light_sector_implausible_total',
      ...out,
      total,
      assumptions,
    };
  }

  return {
    ok: true,
    reason: null,
    ...out,
    total,
    assumptions,
  };
}

/**
 * Metric value for ranking after normalization.
 * @param {object} row
 * @param {string} metric scope1_emissions|scope2_emissions|scope3_emissions|total_emissions
 */
export function normalizedMetricValue(row, metric) {
  const norm = normalizeEmissionRow(row);
  if (!norm.ok) return { ok: false, value: null, reason: norm.reason, norm };
  if (metric === 'scope1_emissions') return { ok: true, value: norm.scope1, reason: null, norm };
  if (metric === 'scope2_emissions') return { ok: true, value: norm.scope2, reason: null, norm };
  if (metric === 'scope3_emissions') return { ok: true, value: norm.scope3, reason: null, norm };
  if (metric === 'total_emissions') return { ok: true, value: norm.total, reason: null, norm };
  return { ok: false, value: null, reason: 'unsupported_metric', norm };
}

export function isEmissionRankMetric(metric) {
  return (
    metric === 'total_emissions'
    || metric === 'scope1_emissions'
    || metric === 'scope2_emissions'
    || metric === 'scope3_emissions'
  );
}

/**
 * Filter + re-score ranking rows for emission metrics.
 * Keeps non-emission metrics unchanged.
 */
export function filterNormalizeEmissionRankingRows(rows = [], metric, { order = 'DESC' } = {}) {
  if (!isEmissionRankMetric(metric) || !Array.isArray(rows)) return { rows, dropped: 0 };
  const desc = String(order).toUpperCase() !== 'ASC';
  const kept = [];
  let dropped = 0;

  for (const row of rows) {
    const scored = normalizedMetricValue(row, metric);
    if (!scored.ok || scored.value == null || !(scored.value > 0)) {
      dropped += 1;
      continue;
    }
    kept.push({
      ...row,
      metric_value: scored.value,
      scope1_emissions: scored.norm.scope1,
      scope2_emissions: scored.norm.scope2,
      scope3_emissions: scored.norm.scope3,
      _emissionNorm: {
        total: scored.norm.total,
        assumptions: scored.norm.assumptions,
      },
    });
  }

  kept.sort((a, b) => (desc
    ? Number(b.metric_value) - Number(a.metric_value)
    : Number(a.metric_value) - Number(b.metric_value)));

  return { rows: kept, dropped };
}
