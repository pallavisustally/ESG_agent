/**
 * Derived metrics — computed from existing BRSR schema columns.
 * Used as planner stage 2 (after direct schema lookup, before unavailable).
 *
 * Note: male_employee_count / male_employee_share are first-class stored columns
 * (extracted from XBRL D_Male_* contexts, with total−female backfill). They are
 * resolved in stage 1 via METRIC_HINTS / REPORTS_COLUMNS — not here.
 */

/** @typedef {{ id: string, patterns: RegExp[], sqlExpr: string, requires: string[], label: string, whereSql?: string }} DerivedMetric */

/** @type {DerivedMetric[]} */
export const DERIVED_METRICS = [
  {
    id: 'male_board_share',
    patterns: [
      /\bmale\s+board\s+share\b/i,
      /\bmale\s+board\s+(percent|percentage|%)\b/i,
      /\bmen\s+on\s+(the\s+)?board\b(?!\s*count)/i,
    ],
    sqlExpr: '(100 - COALESCE(female_board_share,0))',
    requires: ['female_board_share'],
    whereSql:
      'female_board_share IS NOT NULL '
      + 'AND (100 - COALESCE(female_board_share,0)) > 0',
    label: 'Male board share',
  },
  {
    id: 'male_board_count',
    patterns: [
      /\bmale\s+board\s+count\b/i,
      /\bnumber\s+of\s+male\s+board\b/i,
      /\bhow\s+many\s+male\s+board\b/i,
      /\bmen\s+on\s+(the\s+)?board\s+count\b/i,
    ],
    sqlExpr: '(COALESCE(total_board_count,0) - COALESCE(female_board_count,0))',
    requires: ['total_board_count', 'female_board_count'],
    whereSql:
      'total_board_count IS NOT NULL AND female_board_count IS NOT NULL '
      + 'AND (COALESCE(total_board_count,0) - COALESCE(female_board_count,0)) > 0',
    label: 'Male board count',
  },
];

const BY_ID = new Map(DERIVED_METRICS.map((d) => [d.id, d]));

export function getDerivedMetric(id) {
  if (!id) return null;
  return BY_ID.get(String(id)) || null;
}

export function isDerivedMetric(id) {
  return BY_ID.has(String(id || ''));
}

/**
 * Stage 2: match a derived metric from the current user message.
 * @returns {DerivedMetric|null}
 */
export function matchDerivedMetric(userMessage = '') {
  const text = String(userMessage || '');
  if (!text.trim()) return null;
  for (const derived of DERIVED_METRICS) {
    for (const pattern of derived.patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) {
        pattern.lastIndex = 0;
        return derived;
      }
    }
  }
  return null;
}

/** SQL SELECT expression (with alias) for ranking/compare. */
export function derivedMetricSelectExpr(metricId) {
  const d = getDerivedMetric(metricId);
  if (!d) return null;
  return `${d.sqlExpr} AS ${d.id}`;
}

/** SQL WHERE fragment for usable derived values. */
export function derivedMetricWhere(metricId) {
  const d = getDerivedMetric(metricId);
  return d?.whereSql || null;
}
