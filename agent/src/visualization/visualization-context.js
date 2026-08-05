/**
 * VisualizationContext — shared intent/shape object for all downstream viz stages.
 */

/**
 * @typedef {Object} VisualizationContext
 * @property {string|null} intent - plan/SQL intent (TOP_METRIC, COMPARE_COMPANIES, …)
 * @property {'trend'|'ranking'|'comparison'|'composition'|'correlation'|null} preferredIntent
 * @property {string[]} metrics
 * @property {string[]} companies
 * @property {(string|number)[]} years
 * @property {string|null} aggregation
 * @property {string|null} grouping
 * @property {boolean} comparison
 * @property {boolean} ranking
 * @property {boolean} trend
 * @property {string} source
 * @property {string|null} chartPreference - explicit user chart type override
 * @property {string|null} units
 * @property {string} userMessage
 * @property {string|null} title
 * @property {string|null} subtitle
 * @property {string|number|null} year
 * @property {string|null} company
 * @property {'ASC'|'DESC'|null} order
 * @property {boolean} includeInsights
 * @property {boolean} includeLlmExplanation
 * @property {Object} metadata
 */

/**
 * Build a VisualizationContext from planner / classification / dataset hints.
 * @param {Partial<VisualizationContext> & { dataset?: object, classification?: object, plan?: object }} input
 * @returns {VisualizationContext}
 */
export function createVisualizationContext(input = {}) {
  const dataset = input.dataset || null;
  const classification = input.classification || {};
  const plan = input.plan || {};
  const filters = classification.filters || plan.filters || {};

  const metrics = uniqueStrings(
    input.metrics
      || dataset?.metrics
      || plan.metrics
      || classification.metrics
      || [],
  );

  const companies = uniqueStrings(
    input.companies
      || (dataset?.company ? [dataset.company] : [])
      || plan.companies
      || classification.companies
      || [],
  );

  const year = input.year ?? dataset?.year ?? plan.year ?? classification.year ?? null;
  const years = uniqueStrings(
    (input.years || plan.years || classification.years || (year != null ? [year] : []))
      .map(String),
  );

  const intent = input.intent
    || plan.intent
    || classification.intent
    || null;

  const preferredIntent = input.preferredIntent
    || derivePreferredIntent(intent, input)
    || null;

  const userMessage = String(
    input.userMessage || plan.userMessage || classification.userMessage || '',
  );

  const chartPreference = input.chartPreference
    || extractChartPreference(userMessage)
    || null;

  const grouping = input.grouping
    || dataset?.grouping
    || null;

  const aggregation = input.aggregation
    ?? dataset?.aggregation
    ?? null;

  const ranking = Boolean(
    input.ranking
      ?? (preferredIntent === 'ranking'
        || intent === 'TOP_METRIC'
        || intent === 'BOTTOM_METRIC'
        || intent === 'CHART_REQUEST'),
  );
  const comparison = Boolean(
    input.comparison
      ?? (preferredIntent === 'comparison' || intent === 'COMPARE_COMPANIES'),
  );
  const trend = Boolean(
    input.trend
      ?? (preferredIntent === 'trend' || intent === 'TREND_ANALYSIS'),
  );

  return {
    intent: intent ? String(intent) : null,
    preferredIntent,
    metrics,
    companies,
    years,
    aggregation,
    grouping,
    comparison,
    ranking,
    trend,
    source: input.source || dataset?.source || 'BRSR structured reports',
    chartPreference,
    units: input.units ?? null,
    userMessage,
    title: input.title ?? null,
    subtitle: input.subtitle ?? null,
    year,
    company: input.company ?? dataset?.company ?? companies[0] ?? null,
    order: input.order === 'ASC' || input.order === 'DESC' ? input.order : (intent === 'BOTTOM_METRIC' ? 'ASC' : 'DESC'),
    includeInsights: input.includeInsights !== false,
    includeLlmExplanation: Boolean(input.includeLlmExplanation),
    metadata: {
      ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
      wantsChart: filters.wantsChart,
    },
  };
}

function derivePreferredIntent(intent, input) {
  if (input.preferredIntent) return input.preferredIntent;
  const planIntent = String(intent || '').toUpperCase();
  if (planIntent === 'TREND_ANALYSIS' || planIntent.includes('TREND')) return 'trend';
  if (planIntent === 'TOP_METRIC' || planIntent === 'BOTTOM_METRIC' || planIntent === 'CHART_REQUEST') {
    return 'ranking';
  }
  if (planIntent === 'COMPARE_COMPANIES') return 'comparison';
  if (planIntent === 'SECTOR_SUMMARY') return 'ranking';
  if (input.ranking) return 'ranking';
  if (input.comparison) return 'comparison';
  if (input.trend) return 'trend';
  return null;
}

function extractChartPreference(userMessage) {
  const text = String(userMessage || '').toLowerCase();
  if (/\bscatter\b/.test(text)) return 'scatter';
  if (/\bdoughnut\b/.test(text)) return 'doughnut';
  if (/\bpie\s*chart\b|\bpie\b/.test(text)) return 'pie';
  if (/\bline\s*chart\b|\bline\b/.test(text) && /\b(chart|graph|plot)\b/.test(text)) return 'line';
  if (/\bhorizontal\s*bar\b/.test(text)) return 'horizontalBar';
  if (/\bgrouped\s*bar\b/.test(text)) return 'groupedBar';
  if (/\bbar\s*chart\b/.test(text)) return 'bar';
  return null;
}

function uniqueStrings(list) {
  const out = [];
  const seen = new Set();
  for (const item of list || []) {
    if (item == null || item === '') continue;
    const key = String(item);
    if (seen.has(key.toLowerCase())) continue;
    seen.add(key.toLowerCase());
    out.push(key);
  }
  return out;
}
