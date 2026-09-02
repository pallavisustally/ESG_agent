/**
 * Maps everyday ESG phrasing → real `reports` columns.
 * Used to (1) hint the LLM and (2) rewrite bad SQL column names.
 *
 * Order matters: more specific patterns first (intensity before generic emissions).
 */

import fs from 'fs';
import path from 'path';
import { resolveFromProject } from './paths.js';
import { normalizeMetricQueryText as normalizeFromEngine } from './intent/metric-normalize.js';

/** @typedef {{ id: string, pattern: RegExp, columns: string[], guidance: string }} MetricAlias */

/**
 * Normalize spelling noise so "carbon emisiions" still resolves.
 * Delegates to the shared Metric Normalization Engine text normalizer.
 */
export function normalizeMetricQueryText(text = '') {
  return normalizeFromEngine(text);
}

/** @type {MetricAlias[]} */
export const METRIC_ALIASES = [
  {
    id: 'emissions_intensity',
    pattern:
      /\b(carbon|ghg|greenhouse)\s+emissions?\s+intensity\b|\b(carbon|ghg|greenhouse|emission)s?\s+intensity\b|\bintensity\s+of\s+(carbon|ghg|emission)s?\b|\bcarbon\s+footprint\s+intensity\b/i,
    columns: ['emissions_intensity'],
    guidance: 'Use column emissions_intensity (not scope1/2/3 totals).',
  },
  {
    id: 'scope1',
    pattern: /\bscope\s*[-]?\s*1\b|\bdirect\s+(ghg\s+|greenhouse\s+)?emission/i,
    columns: ['scope1_emissions'],
    guidance: 'Use scope1_emissions.',
  },
  {
    id: 'scope2',
    pattern: /\bscope\s*[-]?\s*2\b|\bindirect\s+(ghg\s+|greenhouse\s+)?emission|\bpurchased\s+electricity\s+emission/i,
    columns: ['scope2_emissions'],
    guidance: 'Use scope2_emissions.',
  },
  {
    id: 'scope3',
    pattern: /\bscope\s*[-]?\s*3\b|\bvalue\s*chain\s+emission|\bupstream\s+emission|\bdownstream\s+emission/i,
    columns: ['scope3_emissions'],
    guidance: 'Use scope3_emissions.',
  },
  {
    id: 'carbon_ghg_emissions',
    // Generic "carbon/GHG/greenhouse emissions" / footprint (allows emis* typos after normalize).
    pattern:
      /\b(carbon|ghg|greenhouse(\s+gas)?)\s+emis\w*|\bemis\w*\s+(of\s+)?(carbon|ghg|co2|co₂)\b|\bcarbon\s+footprint\b|\bghg\s+footprint\b|\bco2e?\s+footprint\b|\btco2e?\b(?!\s*\/)/i,
    columns: ['scope1_emissions', 'scope2_emissions', 'scope3_emissions'],
    guidance:
      'There is no carbon_emissions column. Map "carbon/GHG emissions" to scope1_emissions, scope2_emissions, and scope3_emissions. '
      + 'For a single ranking metric prefer (COALESCE(scope1_emissions,0)+COALESCE(scope2_emissions,0)+COALESCE(scope3_emissions,0)) AS total_ghg_emissions, '
      + 'or ask which scope if the user needs one scope only. Never reply that carbon emissions are unavailable.',
  },
  {
    id: 'total_ghg',
    pattern:
      /\btotal\s+(carbon|ghg|greenhouse(\s+gas)?)\s*(emis\w*)?\b|\btotal\s+emis\w*\b|\boverall\s+(carbon|ghg|emis\w*)\b|\bghg\s+total\b|\bsum\s+of\s+scope\b/i,
    columns: ['scope1_emissions', 'scope2_emissions', 'scope3_emissions'],
    guidance:
      'Map total/overall GHG to Scope 1+2+3 sum (total_emissions / total_ghg_emissions expression), not a single scope column.',
  },
  {
    id: 'renewable_share',
    pattern:
      /\brenewable\b.*\b(share|percent|percentage|%|mix)\b|\b(share|percent|percentage|%)\b.*\brenewable\b|\bclean\s+energy\s+share\b|\bgreen\s+energy\s+share\b|\brenewable\s+energy\b|\bgreen\s+energy\b|\bclean\s+power\b|\brenewables?\s+mix\b/i,
    columns: ['renewable_energy_share'],
    guidance: 'Use renewable_energy_share (and renewable_energy_consumption / energy_consumption for breakdown).',
  },
  {
    id: 'water_use',
    pattern: /\bwater\s+(use|usage|consumed|consumption|withdraw)\b|\bfresh\s*water\b|\beffluent\b|\bwater\s+stress\b|\bwater\s+footprint\b/i,
    columns: ['water_consumption'],
    guidance: 'Use water_consumption (water_withdrawal if they ask withdrawal).',
  },
  {
    id: 'waste',
    pattern: /\bwaste\s+(generated|generation|produced|disposed)\b|\bsolid\s+waste\b|\bhazardous\s+waste\b|\bwaste\s+footprint\b/i,
    columns: ['waste_generated'],
    guidance: 'Use waste_generated.',
  },
  {
    id: 'energy_use',
    pattern: /\benergy\s+(use|usage|consumed|consumption)\b|\btotal\s+energy\b|\bpower\s+consumption\b|\belectricity\s+consumption\b|\benergy\s+footprint\b/i,
    columns: ['energy_consumption'],
    guidance: 'Use energy_consumption.',
  },
  {
    id: 'female_workforce_share',
    pattern:
      /\b(female|women|gender)\b.*\b(employee|workforce|staff).*\b(share|percent|percentage|%|\bratio)\b|\b(share|percent|percentage|%)\b.*\b(female|women)\b.*\b(employee|workforce)\b|\bwomen\s+in\s+(the\s+)?workforce\b|\bwomen(?:'s)?\s+workforce\s*%?\b|\bfemale\s+workforce\s*%?\b|\bworkforce\s*%\b.*\b(female|women)\b|\bgender\s+diversity\b|\bworkforce\s+diversity\b|\bwomen\s+employees?\b|\bfemale\s+employees?\b(?!\s*count)/i,
    columns: ['female_employee_share'],
    guidance: 'Use female_employee_share (not female_employee_count) when they ask share/percentage/women employees.',
  },
  {
    id: 'female_employee_count',
    pattern:
      /\bhow\s+many\s+(female|women)\s+emplo\w*\b|\b(female|women)\s+emplo\w*\s+count\b|\bnumber\s+of\s+(female|women)\s+emplo\w*\b|\b(female|women)\s+headcount\b/i,
    columns: ['female_employee_count'],
    guidance: 'Use female_employee_count when they ask for a headcount of women/female employees.',
  },
  {
    id: 'male_workforce_share',
    pattern:
      /\b(male|men)\b.*\b(employee|workforce|staff).*\b(share|percent|percentage|%)\b|\b(share|percent|percentage|%)\b.*\b(male|men)\b.*\b(employee|workforce)\b|\bmen\s+in\s+(the\s+)?workforce\b|\bmale\s+workforce\s*%?\b/i,
    columns: ['male_employee_share'],
    guidance: 'Use male_employee_share (stored BRSR column) when they ask male workforce share/percentage.',
  },
  {
    id: 'male_employee_count',
    pattern:
      /\bhow\s+many\s+male\s+emplo\w*\b|\bmale\s+emplo\w*\s+count\b|\bnumber\s+of\s+male\s+emplo\w*\b|\bmale\s+headcount\b|\bmale\s+emplo\w*\b(?!\s*(share|percent|percentage|%))/i,
    columns: ['male_employee_count'],
    guidance: 'Use male_employee_count (stored BRSR column).',
  },
  {
    id: 'female_board_share',
    pattern:
      /\b(female|women)\b.*\bboard\b.*\b(share|percent|percentage|%)\b|\bboard\b.*\b(female|women)\b.*\b(share|percent|percentage|%)\b|\bwomen\s+on\s+(the\s+)?board\b|\bboard\s+diversity\b|\bgender\s+diversity\s+on\s+(the\s+)?board\b|\bfemale\s+directors?\b|\bwomen\s+directors?\b/i,
    columns: ['female_board_share'],
    guidance: 'Use female_board_share.',
  },
  {
    id: 'safety_ltifr',
    pattern: /\bltifr\b|\blost\s+time\s+injur|\bsafety\s+rate\b|\binjury\s+frequency\b|\bsafety\s+incident|\bworkplace\s+safety\b/i,
    columns: ['safety_ltifr'],
    guidance: 'Use safety_ltifr.',
  },
  {
    id: 'revenue',
    pattern: /\b(total\s+)?revenue\b|\bturnover\b|\bsales\b(?!\s+team)/i,
    columns: ['total_revenue'],
    guidance: 'Use total_revenue.',
  },
];

/** Total carbon / GHG slang → SUM(scope1+2+3) expression (not Scope 1 alone). */
export const TOTAL_GHG_SQL =
  '(COALESCE(scope1_emissions,0)+COALESCE(scope2_emissions,0)+COALESCE(scope3_emissions,0))';

const TOTAL_CARBON_COLUMN_ALIASES = new Set([
  'carbon_emissions',
  'carbon_emission',
  'carbon_footprint',
  'ghg_emissions',
  'greenhouse_gas_emissions',
  'co2_emissions',
  'co2e_emissions',
  'total_emissions',
  'total_ghg',
  'total_ghg_emissions',
  'ghg_total',
]);

/** Invented / slang column names → real columns (SQL rewrite). */
export const COLUMN_ALIASES = {
  // Kept for intensity / non-total paths; total-carbon aliases rewritten via TOTAL_GHG_SQL below.
  carbon_emissions: 'scope1_emissions',
  carbon_emission: 'scope1_emissions',
  carbon_footprint: 'scope1_emissions',
  ghg_emissions: 'scope1_emissions',
  greenhouse_gas_emissions: 'scope1_emissions',
  co2_emissions: 'scope1_emissions',
  co2e_emissions: 'scope1_emissions',
  total_emissions: 'scope1_emissions',
  total_ghg: 'scope1_emissions',
  total_ghg_emissions: 'scope1_emissions',
  emissions: 'scope1_emissions',
  carbon_intensity: 'emissions_intensity',
  ghg_intensity: 'emissions_intensity',
  emission_intensity: 'emissions_intensity',
  emissions_intensity_avg: 'emissions_intensity',
  water_usage: 'water_consumption',
  water_use: 'water_consumption',
  fresh_water: 'water_consumption',
  waste: 'waste_generated',
  solid_waste: 'waste_generated',
  energy_use: 'energy_consumption',
  power_consumption: 'energy_consumption',
  renewable_share: 'renewable_energy_share',
  clean_energy_share: 'renewable_energy_share',
  green_energy_share: 'renewable_energy_share',
  women_employee_share: 'female_employee_share',
  female_workforce_share: 'female_employee_share',
  women_workforce_share: 'female_employee_share',
  workforce_percent_female: 'female_employee_share',
  gender_diversity: 'female_employee_share',
  male_employee_count: 'male_employee_count',
  male_employees: 'male_employee_count',
  male_workforce_share: 'male_employee_share',
  men_workforce_share: 'male_employee_share',
  workforce_percent_male: 'male_employee_share',
  women_board_share: 'female_board_share',
  board_diversity: 'female_board_share',
  ltifr: 'safety_ltifr',
  revenue: 'total_revenue',
  turnover: 'total_revenue',
};

const ESG_SIGNAL_RE =
  /\b(carbon|ghg|greenhouse|emission|scope\s*[123]|water|waste|energy|renewable|female|women|male|men|board|ltifr|revenue|turnover|intensity|diversity)\b/i;

/**
 * Match user phrasing to canonical columns.
 * @returns {{ matches: MetricAlias[], columns: string[], systemHint: string, normalizedText: string }}
 */
export function resolveMetricAliases(userMessage = '') {
  const raw = String(userMessage || '');
  if (!raw.trim()) return { matches: [], columns: [], systemHint: '', normalizedText: '' };

  const text = normalizeMetricQueryText(raw);

  const matches = [];
  const seen = new Set();
  for (const alias of METRIC_ALIASES) {
    // Reset lastIndex in case a future pattern uses /g
    alias.pattern.lastIndex = 0;
    if (!alias.pattern.test(text)) continue;
    alias.pattern.lastIndex = 0;
    // Avoid double-matching generic carbon after a specific scope/intensity hit.
    if (alias.id === 'carbon_ghg_emissions') {
      const alreadyScoped = matches.some((m) =>
        ['scope1', 'scope2', 'scope3', 'emissions_intensity'].includes(m.id));
      if (alreadyScoped) continue;
    }
    if (seen.has(alias.id)) continue;
    seen.add(alias.id);
    matches.push(alias);
  }

  const columns = [...new Set(matches.flatMap((m) => m.columns))];
  if (!matches.length) return { matches, columns, systemHint: '', normalizedText: text };

  const lines = matches.map(
    (m) => `- User phrasing matched "${m.id}" → columns: ${m.columns.join(', ')}. ${m.guidance}`,
  );
  const systemHint =
    '\nMetric synonym resolution (AUTHORITATIVE — overrides any "not available" instinct):\n'
    + `${lines.join('\n')}\n`
    + '- These metrics ARE available in the reports table under the columns above.\n'
    + '- NEVER reply that the metric is "not tracked" / "not available" / "Closest available metrics include …" when this mapping exists.\n'
    + '- For explain/what-is/about questions: explain using these columns (e.g. carbon = GHG Scope 1, 2, 3), then optionally query them for data.\n'
    + '- For rankings/comparisons: write SQL against these columns (or SUM of scope1+scope2+scope3 for total carbon/GHG).';

  return { matches, columns, systemHint, normalizedText: text };
}

/** True when the model wrongly used the unavailable template for a mapped metric. */
export function looksLikeFalseUnavailableRefusal(text = '') {
  return /not tracked in the current BRSR|not available in the current BRSR|Closest available metrics include/i.test(
    String(text || ''),
  );
}

/** Deterministic fallback when the model refuses a synonym-mapped carbon/GHG explain question. */
export function carbonEmissionsExplainFallback() {
  return `In BRSR filings, **carbon emissions** means greenhouse gas (GHG) emissions reported in three scopes:

- **Scope 1** (\`scope1_emissions\`): direct emissions from sources the company owns or controls
- **Scope 2** (\`scope2_emissions\`): indirect emissions from purchased electricity, heat, or steam
- **Scope 3** (\`scope3_emissions\`): other value-chain emissions (upstream/downstream)

These are stored in the reports table as \`scope1_emissions\`, \`scope2_emissions\`, and \`scope3_emissions\` (often in tCO2e). Ask for a company and year, or a ranking (e.g. top companies by Scope 1 in 2025), to pull numbers.`;
}

/**
 * If the model wrongly said a synonym-mapped metric was unavailable, replace with a correct answer.
 */
export function repairFalseUnavailableAnswer(text, metricAliases) {
  if (!metricAliases?.columns?.length || !looksLikeFalseUnavailableRefusal(text)) {
    return text;
  }
  if (metricAliases.matches?.some((m) => m.id === 'carbon_ghg_emissions')) {
    return carbonEmissionsExplainFallback();
  }
  const cols = metricAliases.columns.join(', ');
  return (
    `That metric is available in the BRSR reports table as: **${cols}**. `
    + `Ask for a company/year, ranking, or comparison and I will query those columns.`
  );
}

/**
 * Replace invented alias column names in SQL with real schema columns.
 * Generic carbon/GHG totals → Scope1+2+3 SUM (unless user named a single scope or intensity).
 */
export function rewriteAliasedSqlColumns(sql = '', userMessage = '') {
  let out = String(sql || '');
  if (!out) return out;

  const aliases = resolveMetricAliases(userMessage);
  const namedSingleScope = aliases.matches.some((m) => m.id === 'scope1' || m.id === 'scope2' || m.id === 'scope3');
  const namedIntensity = aliases.matches.some((m) => m.id === 'emissions_intensity');
  const sqlHasTotalAlias = [...TOTAL_CARBON_COLUMN_ALIASES].some((a) => new RegExp(`\\b${a}\\b`, 'i').test(out));
  const useTotalGhgSum = !namedSingleScope && !namedIntensity && (
    aliases.matches.some((m) => m.id === 'carbon_ghg_emissions') || sqlHasTotalAlias
  );

  if (useTotalGhgSum) {
    for (const alias of TOTAL_CARBON_COLUMN_ALIASES) {
      const re = new RegExp(`\\b${alias}\\b`, 'gi');
      out = out.replace(re, TOTAL_GHG_SQL);
    }
  }

  for (const [alias, real] of Object.entries(COLUMN_ALIASES)) {
    if (alias === real) continue;
    if (TOTAL_CARBON_COLUMN_ALIASES.has(alias) && useTotalGhgSum) {
      continue; // already rewritten to SUM
    }
    const re = new RegExp(`\\b${alias}\\b`, 'gi');
    out = out.replace(re, real);
  }
  return out;
}

/** Suggest real columns when the model invents an unknown name. */
export function suggestColumnsForUnknown(unknownCols = [], userMessage = '') {
  const fromQuestion = resolveMetricAliases(userMessage);
  const suggestions = new Map();
  for (const col of unknownCols) {
    const key = String(col || '').toLowerCase();
    if (/carbon|ghg|greenhouse|co2/.test(key) || fromQuestion.matches.some((m) => m.id === 'carbon_ghg_emissions')) {
      if (COLUMN_ALIASES[key] || /carbon|ghg|greenhouse|co2/.test(key)) {
        suggestions.set(key, ['scope1_emissions', 'scope2_emissions', 'scope3_emissions']);
        continue;
      }
    }
    if (COLUMN_ALIASES[key]) {
      suggestions.set(key, [COLUMN_ALIASES[key]]);
      continue;
    }
  }

  if (fromQuestion.columns.length && unknownCols.length) {
    for (const col of unknownCols) {
      const key = String(col || '').toLowerCase();
      if (!suggestions.has(key)) suggestions.set(key, fromQuestion.columns);
    }
  }

  if (!suggestions.size) return '';
  return [...suggestions.entries()]
    .map(([bad, cols]) => `"${bad}" → ${cols.join(', ')}`)
    .join('; ');
}

/**
 * Append a miss/repair event for later alias expansion (local only; skipped on Vercel).
 * @param {{ type: string, userMessage?: string, detail?: object }} event
 */
export function logMetricAliasEvent(event) {
  if (process.env.VERCEL || process.env.METRIC_ALIAS_LOG === 'false') return;
  try {
    const dir = resolveFromProject('data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'metric_alias_events.jsonl');
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      type: event?.type || 'unknown',
      userMessage: String(event?.userMessage || '').slice(0, 500),
      detail: event?.detail || null,
    });
    fs.appendFileSync(file, `${line}\n`, 'utf8');
  } catch (err) {
    console.warn('[MetricAliases] Failed to log event:', err.message);
  }
}

/**
 * Log when an ESG-looking question did not match any alias (candidate for glossary growth).
 */
export function maybeLogUnresolvedEsgPhrase(userMessage, metricAliases) {
  if (metricAliases?.columns?.length) return;
  const text = String(userMessage || '');
  if (!ESG_SIGNAL_RE.test(text)) return;
  logMetricAliasEvent({
    type: 'unresolved_esg_phrase',
    userMessage: text,
    detail: { normalized: normalizeMetricQueryText(text) },
  });
  // Also surface in agent observability JSONL for weekly review.
  try {
    // Lazy import avoids circular deps with observability at module load.
    import('./observability/agent-logger.js')
      .then(({ logPipelineStage }) => {
        logPipelineStage('metric_alias_unresolved', {
          ok: false,
          message: String(text).slice(0, 200),
          normalized: normalizeMetricQueryText(text),
        });
      })
      .catch(() => {});
  } catch {
    /* ignore */
  }
}

/** Compact glossary for the system prompt. */
export function metricAliasGlossaryText() {
  return `Metric synonyms (everyday language → SQL columns):
- "carbon emissions" / "GHG emissions" / "carbon footprint" (no scope named) → SUM of scope1+scope2+scope3 (total GHG). Never invent carbon_emissions. Never map total carbon to Scope 1 alone. Never say unavailable.
- "carbon intensity" / "emissions intensity" → emissions_intensity
- "direct emissions" → scope1_emissions; "indirect emissions" → scope2_emissions; "value chain emissions" → scope3_emissions
- "water use/usage" → water_consumption; "waste" → waste_generated; "energy use" → energy_consumption
- "renewable share / clean energy % / green energy share" → renewable_energy_share
- "women in workforce %" / "female workforce %" → female_employee_share; "male workforce %" / "male employees" → male_employee_share / male_employee_count; "women on board %" → female_board_share
- "LTIFR" / "injury frequency" → safety_ltifr; "revenue/turnover" → total_revenue`;
}
