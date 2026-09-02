/**
 * Canonical Metric Registry — single source of truth for metric identity.
 * Example phrases boost confidence; features alone must be enough to match.
 */

import { getDerivedMetric } from './derived-metrics.js';

/** @typedef {'stored'|'computed'|'derived'|'unsupported_topic'} MetricKind */

/**
 * @typedef {Object} MetricDefinition
 * @property {string} id
 * @property {MetricKind} kind
 * @property {string} family
 * @property {string|null} measure
 * @property {string[]} [attributes]
 * @property {string[]} [concepts]
 * @property {number[]} [scopes]
 * @property {string[]} [examplePhrases]
 * @property {string[]} [unsupportedQualifiers]
 * @property {object} [sql]
 * @property {object} [capabilities]
 * @property {string} [displayLabel]
 */

/** @type {MetricDefinition[]} */
export const METRIC_REGISTRY = [
  // ── Workforce ──────────────────────────────────────────────────────────
  {
    id: 'male_employee_count',
    kind: 'stored',
    family: 'workforce',
    measure: 'count',
    attributes: ['male'],
    concepts: ['employee', 'workforce', 'staff', 'personnel', 'count'],
    examplePhrases: [
      'male count',
      'male employee count',
      'male employees',
      'number of male employees',
      'how many male employees',
      'male headcount',
    ],
    unsupportedQualifiers: ['disabled', 'pwd', 'differently_abled'],
    sql: { column: 'male_employee_count' },
    capabilities: { rankable: true, citable: true, planable: true },
    displayLabel: 'Male employee count',
  },
  {
    id: 'female_employee_count',
    kind: 'stored',
    family: 'workforce',
    measure: 'count',
    attributes: ['female'],
    concepts: ['employee', 'workforce', 'staff', 'personnel', 'count'],
    examplePhrases: [
      'female count',
      'female employee count',
      'female employees',
      'women employees',
      'number of female employees',
      'how many female employees',
      'how many male and female employees',
      'male and female employees',
    ],
    unsupportedQualifiers: ['disabled', 'pwd', 'differently_abled'],
    sql: { column: 'female_employee_count' },
    capabilities: { rankable: true, citable: true, planable: true },
    displayLabel: 'Female employee count',
  },
  {
    id: 'total_employee_count',
    kind: 'stored',
    family: 'workforce',
    measure: 'count',
    attributes: [],
    concepts: ['employee', 'workforce', 'strength', 'headcount', 'count'],
    examplePhrases: [
      'employee strength',
      'total employees',
      'employee count',
      'total employee count',
      'workforce strength',
    ],
    unsupportedQualifiers: ['disabled', 'pwd'],
    sql: { column: 'total_employee_count' },
    capabilities: { rankable: true, citable: false, planable: true },
    displayLabel: 'Total employee count',
  },
  {
    id: 'male_employee_share',
    kind: 'stored',
    family: 'workforce',
    measure: 'share',
    attributes: ['male'],
    concepts: ['employee', 'workforce', 'share', 'percent'],
    examplePhrases: [
      'male employee share',
      'male workforce',
      'male workforce percent',
      'percentage of male employees',
    ],
    sql: { column: 'male_employee_share' },
    capabilities: { rankable: true, citable: true, planable: true },
    displayLabel: 'Male employee share',
  },
  {
    id: 'female_employee_share',
    kind: 'stored',
    family: 'workforce',
    measure: 'share',
    attributes: ['female'],
    concepts: ['employee', 'workforce', 'share', 'percent', 'diversity'],
    examplePhrases: [
      'female employee share',
      'female workforce',
      'women in workforce',
      'gender diversity',
      'workforce diversity',
    ],
    sql: { column: 'female_employee_share' },
    capabilities: { rankable: true, citable: true, planable: true },
    displayLabel: 'Female employee share',
  },

  // ── Emissions ──────────────────────────────────────────────────────────
  {
    id: 'scope1_emissions',
    kind: 'stored',
    family: 'emissions',
    measure: 'total',
    attributes: ['direct'],
    scopes: [1],
    concepts: ['emission', 'carbon', 'ghg', 'scope'],
    examplePhrases: ['scope 1', 'scope1', 'direct emissions', 'scope 1 carbon'],
    sql: { column: 'scope1_emissions' },
    capabilities: { rankable: true, citable: true, planable: true },
    displayLabel: 'Scope 1 emissions',
  },
  {
    id: 'scope2_emissions',
    kind: 'stored',
    family: 'emissions',
    measure: 'total',
    attributes: ['indirect'],
    scopes: [2],
    concepts: ['emission', 'carbon', 'ghg', 'scope', 'electricity'],
    examplePhrases: [
      'scope 2',
      'scope2',
      'scope 2 electricity emissions',
      'purchased electricity emissions',
    ],
    sql: { column: 'scope2_emissions' },
    capabilities: { rankable: true, citable: true, planable: true },
    displayLabel: 'Scope 2 emissions',
  },
  {
    id: 'scope3_emissions',
    kind: 'stored',
    family: 'emissions',
    measure: 'total',
    attributes: [],
    scopes: [3],
    concepts: ['emission', 'carbon', 'ghg', 'scope', 'value chain'],
    examplePhrases: [
      'scope 3',
      'scope3',
      'value chain emissions',
      'upstream emissions',
      'downstream emissions',
    ],
    sql: { column: 'scope3_emissions' },
    capabilities: { rankable: true, citable: true, planable: true },
    displayLabel: 'Scope 3 emissions',
  },
  {
    id: 'total_emissions',
    kind: 'computed',
    family: 'emissions',
    measure: 'total',
    attributes: [],
    scopes: [],
    concepts: ['emission', 'carbon', 'ghg', 'footprint'],
    examplePhrases: [
      'carbon emissions',
      'ghg emissions',
      'greenhouse gas emissions',
      'carbon footprint',
      'total emissions',
      'total ghg',
    ],
    sql: {
      expr: '(COALESCE(scope1_emissions,0)+COALESCE(scope2_emissions,0)+COALESCE(scope3_emissions,0))',
    },
    capabilities: { rankable: true, citable: false, planable: true },
    displayLabel: 'Total GHG emissions',
  },
  {
    id: 'emissions_intensity',
    kind: 'stored',
    family: 'emissions',
    measure: 'intensity',
    attributes: [],
    concepts: ['emission', 'carbon', 'ghg', 'intensity'],
    examplePhrases: [
      'carbon emissions intensity',
      'emissions intensity',
      'ghg intensity',
      'carbon intensity',
    ],
    sql: { column: 'emissions_intensity' },
    capabilities: { rankable: true, citable: true, planable: true },
    displayLabel: 'Emissions intensity',
  },

  // ── Energy ─────────────────────────────────────────────────────────────
  {
    id: 'renewable_energy_share',
    kind: 'stored',
    family: 'energy',
    measure: 'share',
    attributes: ['renewable'],
    concepts: ['energy', 'electricity', 'renewable', 'share'],
    examplePhrases: [
      'renewable energy share',
      'renewable electricity',
      'renewable energy',
      'clean energy share',
    ],
    sql: { column: 'renewable_energy_share' },
    capabilities: { rankable: true, citable: true, planable: true },
    displayLabel: 'Renewable energy share',
  },
  {
    id: 'renewable_energy_consumption',
    kind: 'stored',
    family: 'energy',
    measure: 'total',
    attributes: ['renewable'],
    concepts: ['energy', 'renewable', 'consumption'],
    examplePhrases: [
      'renewable energy consumption',
      'renewable electricity consumption',
      'renewable energy use',
    ],
    sql: { column: 'renewable_energy_consumption' },
    capabilities: { rankable: true, citable: false, planable: true },
    displayLabel: 'Renewable energy consumption',
  },
  {
    id: 'energy_consumption',
    kind: 'stored',
    family: 'energy',
    measure: 'total',
    attributes: [],
    concepts: ['energy', 'electricity', 'power', 'consumption'],
    examplePhrases: ['energy consumption', 'total energy', 'power consumption'],
    sql: { column: 'energy_consumption' },
    capabilities: { rankable: true, citable: true, planable: true },
    displayLabel: 'Energy consumption',
  },
  {
    id: 'energy_intensity',
    kind: 'stored',
    family: 'energy',
    measure: 'intensity',
    attributes: [],
    concepts: ['energy', 'intensity'],
    examplePhrases: ['energy intensity'],
    sql: { column: 'energy_intensity' },
    capabilities: { rankable: true, citable: true, planable: true },
    displayLabel: 'Energy intensity',
  },

  // ── Water / waste ──────────────────────────────────────────────────────
  {
    id: 'water_consumption',
    kind: 'stored',
    family: 'water',
    measure: 'total',
    attributes: [],
    concepts: ['water', 'consumption', 'use'],
    examplePhrases: ['water consumption', 'water use', 'water usage'],
    sql: { column: 'water_consumption' },
    capabilities: { rankable: true, citable: true, planable: true },
    displayLabel: 'Water consumption',
  },
  {
    id: 'water_withdrawal',
    kind: 'stored',
    family: 'water',
    measure: 'total',
    attributes: [],
    concepts: ['water', 'withdrawal'],
    examplePhrases: ['water withdrawal'],
    sql: { column: 'water_withdrawal' },
    capabilities: { rankable: true, citable: true, planable: true },
    displayLabel: 'Water withdrawal',
  },
  {
    id: 'water_intensity',
    kind: 'stored',
    family: 'water',
    measure: 'intensity',
    attributes: [],
    concepts: ['water', 'intensity'],
    examplePhrases: ['water intensity'],
    sql: { column: 'water_intensity' },
    capabilities: { rankable: true, citable: true, planable: true },
    displayLabel: 'Water intensity',
  },
  {
    id: 'waste_generated',
    kind: 'stored',
    family: 'waste',
    measure: 'total',
    attributes: [],
    concepts: ['waste'],
    examplePhrases: ['waste generated', 'waste generation', 'solid waste'],
    sql: { column: 'waste_generated' },
    capabilities: { rankable: true, citable: true, planable: true },
    displayLabel: 'Waste generated',
  },
  {
    id: 'waste_intensity',
    kind: 'stored',
    family: 'waste',
    measure: 'intensity',
    attributes: [],
    concepts: ['waste', 'intensity'],
    examplePhrases: ['waste intensity'],
    sql: { column: 'waste_intensity' },
    capabilities: { rankable: true, citable: true, planable: true },
    displayLabel: 'Waste intensity',
  },

  // ── Board / governance ─────────────────────────────────────────────────
  {
    id: 'female_board_share',
    kind: 'stored',
    family: 'board',
    measure: 'share',
    attributes: ['female'],
    concepts: ['board', 'diversity', 'director', 'share'],
    examplePhrases: [
      'board diversity',
      'women on board',
      'female on board',
      'female board share',
      'gender diversity on the board',
    ],
    sql: { column: 'female_board_share' },
    capabilities: { rankable: true, citable: true, planable: true },
    displayLabel: 'Female board share',
  },
  {
    id: 'female_board_count',
    kind: 'stored',
    family: 'board',
    measure: 'count',
    attributes: ['female'],
    concepts: ['board', 'director', 'count'],
    examplePhrases: ['female board count', 'number of women on board'],
    sql: { column: 'female_board_count' },
    capabilities: { rankable: true, citable: false, planable: true },
    displayLabel: 'Female board count',
  },
  {
    id: 'total_board_count',
    kind: 'stored',
    family: 'board',
    measure: 'count',
    attributes: [],
    concepts: ['board', 'director', 'count'],
    examplePhrases: ['board size', 'total board count'],
    sql: { column: 'total_board_count' },
    capabilities: { rankable: true, citable: false, planable: true },
    displayLabel: 'Total board count',
  },
  {
    id: 'male_board_share',
    kind: 'derived',
    family: 'board',
    measure: 'share',
    attributes: ['male'],
    concepts: ['board', 'share'],
    examplePhrases: ['male board share', 'men on the board'],
    capabilities: { rankable: true, citable: false, planable: true },
    displayLabel: 'Male board share',
  },
  {
    id: 'male_board_count',
    kind: 'derived',
    family: 'board',
    measure: 'count',
    attributes: ['male'],
    concepts: ['board', 'count'],
    examplePhrases: ['male board count', 'number of male board'],
    capabilities: { rankable: true, citable: false, planable: true },
    displayLabel: 'Male board count',
  },

  // ── Safety / finance ───────────────────────────────────────────────────
  {
    id: 'safety_ltifr',
    kind: 'stored',
    family: 'safety',
    measure: null,
    attributes: [],
    concepts: ['ltifr', 'safety', 'injury'],
    examplePhrases: ['ltifr', 'lost time injury', 'safety rate'],
    sql: { column: 'safety_ltifr' },
    capabilities: { rankable: true, citable: true, planable: true },
    displayLabel: 'LTIFR',
  },
  {
    id: 'total_revenue',
    kind: 'stored',
    family: 'finance',
    measure: 'total',
    attributes: [],
    concepts: ['revenue', 'turnover'],
    examplePhrases: ['revenue', 'total revenue', 'turnover'],
    sql: { column: 'total_revenue' },
    capabilities: { rankable: true, citable: true, planable: true },
    displayLabel: 'Total revenue',
  },

  // ── Explicit unsupported topics ────────────────────────────────────────
  {
    id: 'plastic_footprint',
    kind: 'unsupported_topic',
    family: 'waste',
    measure: null,
    attributes: [],
    concepts: ['plastic'],
    examplePhrases: ['plastic footprint', 'plastic waste', 'plastic pollution'],
    capabilities: { rankable: false, citable: false, planable: false },
    displayLabel: 'Plastic footprint (unsupported)',
  },
];

const BY_ID = new Map(METRIC_REGISTRY.map((m) => [m.id, m]));

export function getMetricDefinition(id) {
  if (!id) return null;
  return BY_ID.get(String(id)) || null;
}

export function listMetricDefinitions({ includeUnsupported = false } = {}) {
  return METRIC_REGISTRY.filter(
    (m) => includeUnsupported || m.kind !== 'unsupported_topic',
  );
}

export function getExecutableMetricDefinitions() {
  return METRIC_REGISTRY.filter((m) => m.kind === 'stored' || m.kind === 'computed' || m.kind === 'derived');
}

/** Attach derived SQL metadata when needed. */
export function enrichDerivedDefinition(def) {
  if (!def || def.kind !== 'derived') return def;
  const d = getDerivedMetric(def.id);
  if (!d) return def;
  return {
    ...def,
    sql: { expr: d.sqlExpr, whereSql: d.whereSql, requires: d.requires },
    derived: d,
  };
}
