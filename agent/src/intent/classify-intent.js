/**
 * Intent classifier for BRSR chat questions.
 * Deterministic rules first; returns structured JSON for the planner/router.
 */

import {
  METRIC_RESOLUTION,
  resolveMetricState,
  shouldReuseMemoryMetric,
} from './metric-resolution.js';
import { extractMetricsFromEngine } from './metric-normalization-engine.js';
import {
  refersToPriorCompanies,
  validatePriorCompanyReference,
  getPriorCompanyList,
} from './conversation-context.js';
import { chooseEntitiesByPrecedence } from './entity-precedence.js';

export { refersToPriorCompanies };

export const INTENTS = Object.freeze({
  LIST_ALL_COMPANIES: 'LIST_ALL_COMPANIES',
  COUNT_COMPANIES: 'COUNT_COMPANIES',
  COMPARE_COMPANIES: 'COMPARE_COMPANIES',
  FILTER_BY_SECTOR: 'FILTER_BY_SECTOR',
  TOP_METRIC: 'TOP_METRIC',
  BOTTOM_METRIC: 'BOTTOM_METRIC',
  COMPANY_SUMMARY: 'COMPANY_SUMMARY',
  SECTOR_SUMMARY: 'SECTOR_SUMMARY',
  REPORT_LOOKUP: 'REPORT_LOOKUP',
  METRIC_LOOKUP: 'METRIC_LOOKUP',
  CHART_REQUEST: 'CHART_REQUEST',
  TREND_ANALYSIS: 'TREND_ANALYSIS',
  GENERAL_ESG_QUESTION: 'GENERAL_ESG_QUESTION',
  /** Definitions / concepts / explanations — never SQL. */
  INFORMATIONAL: 'INFORMATIONAL',
  /** How-to / reduce / control guidance (not a ranking). */
  HOW_TO: 'HOW_TO',
  /** Pronoun / shorthand follow-up over prior structured context. */
  FOLLOW_UP: 'FOLLOW_UP',
  PAGINATE_CONTINUE: 'PAGINATE_CONTINUE',
  UNKNOWN: 'UNKNOWN',
});

/** Default metric when user asks "top N companies" without naming one. */
export const DEFAULT_RANK_METRIC = 'total_emissions';

const SECTOR_ALIASES = [
  ['healthcare', 'Healthcare'],
  ['health care', 'Healthcare'],
  ['technology', 'Technology'],
  ['tech', 'Technology'],
  ['financial services', 'Financial Services'],
  ['finance', 'Financial Services'],
  ['banking', 'Financial Services'],
  ['materials', 'Materials'],
  ['utilities', 'Utilities'],
  ['energy', 'Energy & Renewables'],
  ['renewables', 'Energy & Renewables'],
  ['telecommunications', 'Telecommunications'],
  ['telecom', 'Telecommunications'],
  ['consumer defensive', 'Consumer Defensive'],
  ['consumer cyclical', 'Consumer Cyclical'],
  ['consumer services', 'Consumer Services'],
  ['industrials', 'Industrials'],
  ['industrial', 'Other/Industrial'],
];

const METRIC_HINTS = [
  { re: /\bscope\s*1\b|\bscope1\b/i, metric: 'scope1_emissions' },
  { re: /\bscope\s*2\b|\bscope2\b/i, metric: 'scope2_emissions' },
  { re: /\bscope\s*3\b|\bscope3\b/i, metric: 'scope3_emissions' },
  // Longer / more specific intensity phrases before generic carbon+emissions.
  {
    re: /\b(carbon|ghg|greenhouse)\s+emissions?\s+intensity\b|\bemissions?\s+intensity\b|\bemissions?_intensity\b|\bcarbon\s+intensity\b|\bghg\s+intensity\b/i,
    metric: 'emissions_intensity',
  },
  {
    re: /\b(carbon|ghg|greenhouse)\s+footprint\b|\btotal\s+(carbon|ghg|greenhouse)\b|\b(carbon|ghg|greenhouse)\b(?!\s+emissions?\s+intensity).{0,40}\bemissions?\b(?!\s+intensity)|\bemissions?\b(?!\s+intensity).{0,40}\b(carbon|ghg)\b|\bhigh\s+amount\s+of\s+carbon\b|\brelease[sd]?\s+.*\bcarbon\b|\bcarbon\s+release/i,
    metric: 'total_emissions',
  },
  // Count before share so "female/male employee count" does not fall through unmatched.
  { re: /\bfemale\s+emplo\w*\s+count\b|\bnumber\s+of\s+female\s+emplo\w*\b|\bfemale\s+emplo\w*\s+numbers?\b|\bwomen\s+emplo\w*\s+count\b|\bhow\s+many\s+female\s+emplo\w*\b/i, metric: 'female_employee_count' },
  { re: /\bfemale employee share\b|\bfemale\s+emplo\w*\s+share\b|\bwomen(?:'s)?\s+workforce\b|\bwomen\s+in\s+(the\s+)?workforce\b|\bfemale\s+workforce\b|\bworkforce\s*%|\bgender diversity\b|\bwomen workforce\s*%/i, metric: 'female_employee_share' },
  { re: /\bmale\s+emplo\w*\s+share\b|\bmale\s+workforce\b|\bmale\s+(employee|workforce)\s+(percent|percentage|%)\b|\bmen\s+in\s+(the\s+)?workforce\b|\bmale\s+share\b|\bpercentage\s+of\s+male\s+emplo\w*\b/i, metric: 'male_employee_share' },
  { re: /\bmale\s+emplo\w*\s+count\b|\bnumber\s+of\s+male\s+emplo\w*\b|\bhow\s+many\s+male\s+emplo\w*\b|\bmale\s+headcount\b|\bmale\s+emplo\w*(?:\s+numbers?)?\b(?!\s*(share|percent|percentage|%))|\bmen\s+emplo\w*\s+count\b|\bhow\s+many\s+men\s+(?:employees?|workers?)\b/i, metric: 'male_employee_count' },
  { re: /\bfemale board (?:share|count)\b|\bboard diversity\b|\bwomen\s+on\s+(the\s+)?board\b/i, metric: 'female_board_share' },
  { re: /\brenewable energy\b|\brenewables?\b|\bgreen energy\b|\bclean energy\b/i, metric: 'renewable_energy_share' },
  { re: /\bwater (?:consumption|use|intensity)\b/i, metric: 'water_consumption' },
  { re: /\bwaste\b/i, metric: 'waste_generated' },
  { re: /\benergy (?:consumption|intensity)\b/i, metric: 'energy_consumption' },
  { re: /\bltifr\b|\bsafety\b/i, metric: 'safety_ltifr' },
  { re: /\brevenue\b/i, metric: 'total_revenue' },
];

/** Short / common BRSR issuer hints for compare & lookup. */
const COMPANY_NAME_HINTS = [
  'infosys',
  'wipro',
  'asian paints',
  'hdfc bank',
  'tata consultancy',
  'tcs',
  'tata power',
  'tata steel',
  'jsw steel',
  'ultratech',
  'itc',
  'reliance',
  'adani green',
  'apollo hospitals',
  '3m india',
  'abb india',
  'aarti drugs',
];

function extractYears(text) {
  return [...new Set([...String(text).matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1])))];
}

function extractSector(text) {
  const lower = String(text).toLowerCase();
  for (const [alias, sector] of SECTOR_ALIASES) {
    if (lower.includes(alias)) return sector;
  }
  return null;
}

/**
 * Metric ids from the Metric Normalization Engine (features + registry).
 * METRIC_HINTS retained below for reference / legacy tooling only.
 */
export function extractMetrics(text) {
  return extractMetricsFromEngine(text);
}

function extractMetric(text) {
  return extractMetrics(text)[0] || null;
}

function cleanCompanyFragment(raw) {
  return String(raw || '')
    .replace(/\b(scope\s*[123]|emissions?|renewable|revenue|female|board|water|waste|energy|share|intensity|carbon|ghg)\b.*$/i, '')
    .replace(/^(compare|for|of|between)\s+/i, '')
    .replace(/[?.!,;:]+$/g, '')
    .trim();
}

/**
 * True when the user is explicitly comparing companies.
 * Bare "and" (e.g. "rank sectors and show a chart") is NOT a comparison cue.
 */
export function looksLikeCompanyComparison(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (/\bcompare\b/i.test(t)) return true;
  if (/\bvs\.?\b|\bversus\b/i.test(t)) return true;
  if (/\b(higher|lower|greater|less|more)\s+than\b/i.test(t)) return true;
  return false;
}

/**
 * Aggregate analytics over sectors/industries — company entities not required.
 */
export function looksLikeSectorAggregate(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (/\b(across|among|per|by)\s+(all\s+)?(sectors?|industries)\b/i.test(t)) return true;
  if (/\bsector[- ]wise\b|\bindustry[- ]wise\b/i.test(t)) return true;
  if (/\brank(?:ing)?\s+sectors?\b|\bsectors?\s+rank/i.test(t)) return true;
  if (/\b(average|avg\.?|mean|median)\b/i.test(t) && /\b(sectors?|industries)\b/i.test(t)) return true;
  if (/\b(top|highest|lowest|bottom)\b.{0,40}\b(sectors?|industries)\b/i.test(t)) return true;
  return false;
}

export function detectAggregation(text) {
  const t = String(text || '');
  if (/\b(average|avg\.?|mean)\b/i.test(t)) return 'AVG';
  if (/\b(sum|total)\b/i.test(t) && !/\btotal\s+emissions?\b/i.test(t)) return 'SUM';
  if (/\b(count|number of)\b/i.test(t)) return 'COUNT';
  if (/\b(minimum|lowest|min)\b/i.test(t)) return 'MIN';
  if (/\b(maximum|highest|max)\b/i.test(t)) return 'MAX';
  return null;
}

/**
 * Context-aware company candidate extraction.
 * Comparison parse (A and/vs B) runs only for comparison-shaped queries.
 */
export function extractCompanyCandidates(text, { allowCompareParse = null } = {}) {
  const entities = [];
  const raw = String(text || '');
  const runCompareParse = allowCompareParse == null
    ? looksLikeCompanyComparison(raw)
    : Boolean(allowCompareParse);

  // Quoted names
  for (const m of raw.matchAll(/["']([^"']{2,80})["']/g)) {
    entities.push(m[1].trim());
  }
  // Legal-suffix names (skip leading verbs like Compare/Analyze)
  for (const m of raw.matchAll(/\b([A-Z][A-Za-z0-9&.\- ]{1,60}(?:Limited|Ltd\.?|Bank|Motors|Power|Industries|Services|Paints))\b/g)) {
    const name = m[1].trim();
    if (/^(Compare|Analyze|Explain|List|Show|Find|What|Which|How)\b/i.test(name)) continue;
    entities.push(name);
  }

  // Compare A and/vs B — ONLY after comparison query type is established.
  if (runCompareParse) {
    const cmp = raw.match(
      /(?:compare\s+)?(.+?)\s+(?:vs\.?|versus|and)\s+(.+?)(?:\s+(?:on|for|in|across|by|using)\b|\s*$)/i,
    );
    if (cmp) {
      const a = cleanCompanyFragment(cmp[1]);
      const b = cleanCompanyFragment(cmp[2].split(/\s+(?:on|for|in|across|scope|with)\b/i)[0]);
      if (a) entities.push(a);
      if (b) entities.push(b);
    }
  }

  // "Why is A higher than B" / "A higher than B" — comparative cue already present.
  if (runCompareParse || /\b(higher|lower|greater|less|more)\s+than\b/i.test(raw)) {
    const than = raw.match(
      /(?:why\s+is\s+|why\s+are\s+|is\s+)?(.+?)\s+(?:higher|lower|greater|less|more)\s+than\s+(.+?)(?:\s+(?:on|for|in|across|scope|with)\b|[?.!,]|$)/i,
    );
    if (than) {
      const a = cleanCompanyFragment(than[1].replace(/^(why\s+is|why\s+are|is)\s+/i, ''));
      const b = cleanCompanyFragment(than[2].split(/\s+(?:on|for|in|across|scope|with)\b/i)[0]);
      if (a && !/^(why|is|are|the)$/i.test(a)) entities.push(a);
      if (b) entities.push(b);
    }
  }

  // Known short names (safe on all query types)
  const lower = raw.toLowerCase();
  for (const hint of COMPANY_NAME_HINTS) {
    if (lower.includes(hint)) entities.push(hint);
  }

  // Dedupe case-insensitively, prefer longer strings
  const uniq = [];
  for (const name of entities) {
    const n = name.trim();
    if (n.length < 2) continue;
    // Drop fragments that are clearly not company names
    if (/^(analyze|average|show|rank|sectors?|industries|chart|graph|plot|bar)\b/i.test(n)) continue;
    if (/\b(chart|graph|plot|sectors?|industries|average|analyze)\b/i.test(n)) continue;
    const idx = uniq.findIndex((u) => u.toLowerCase() === n.toLowerCase());
    if (idx === -1) uniq.push(n);
    else if (n.length > uniq[idx].length) uniq[idx] = n;
  }
  return uniq.slice(0, 5);
}

function wantsAllRecords(text) {
  return /\b(all|every|entire|complete|full|total)\b.*\b(compan(y|ies)|names?|list|records?)\b|\b(compan(y|ies)|names?)\b.*\b(all|every|entire|complete|full)\b|\blist\s+(out\s+)?(all|every|the\s+total)\b/i.test(text)
    || /\bi\s*need\s+(the\s+)?(total|all|every|complete)\b/i.test(text)
    || /\btotal company names\b/i.test(text);
}

/** Fix common “companies” / “how many” typos before count/list detection. */
export function normalizeCompanyCountText(text = '') {
  return String(text || '')
    .replace(/\bhow\s+man\b/gi, 'how many')
    .replace(/\b(comanies|comanie|comannis|comanys|companis|campanies|compaines|companeis|comapnies|comannies|compnaies|compnies|companys|comapanies|companes|comapany)\b/gi, 'companies')
    // Fuzzy leftover misspellings of "companies" (com…nies / com…ny)
    .replace(/\bcom[a-z]{0,4}n(?:ie|ei|ee|y)s?\b/gi, 'companies');
}

/**
 * True when the user is asking how many companies exist / have BRSR filings —
 * not a workforce headcount and not a prior-company metric follow-up.
 */
export function looksLikeCompanyCountAsk(text = '') {
  const t = normalizeCompanyCountText(text);
  if (/\b(male|female|women|men|employee|employe|worker|workforce|staff|scope\s*[123]|emission)\b/i.test(t)) {
    return false;
  }
  // Allow missing leading "h": "ow many companies…"
  if (/\b(?:h)?ow\s+man(?:y)?\s+companies\b/i.test(t)) return true;
  if (/\b(?:h)?ow\s+man(?:y)?\s+com\w{2,12}\b/i.test(t)) return true;
  if (/\b(count|number|total)\s+(of\s+)?companies\b/i.test(t)) return true;
  if (/\bcompanies\b.{0,48}\b(hold|have|with|filed|filing)\b.{0,40}\bbrsr\b/i.test(t)) return true;
  if (/\bcom\w{2,12}\b.{0,48}\b(hold|have|with|filed|filing)\b.{0,40}\bbrsr\b/i.test(t)) return true;
  if (/\b(?:h)?ow\s+many\b.{0,24}\bcompanies\b.{0,40}\b(brsr|report)/i.test(t)) return true;
  if (
    /\b(?:(?:h)?ow\s+man(?:y)?|count|number)\b/i.test(t)
    && /\bcompan/i.test(t)
    && /\b(in|for|year)\b.{0,12}\b20\d{2}\b/i.test(t)
  ) {
    return true;
  }
  return false;
}

function isFollowUpPagination(text, memory = null) {
  const t = String(text).trim().toLowerCase();
  if (/^(next|more|continue|show more|next page|previous|prev|page\s*\d+)$/i.test(t)) return true;
  if (memory?.lastList && /^(yes|yeah|yep|ok|okay|please|sure)$/i.test(t) && memory.awaitingMore) {
    return true;
  }
  return false;
}

function extractTopLimit(text) {
  const m = String(text).match(/\b(?:top|bottom)\s+(\d{1,3})\b/i);
  if (!m) return null;
  return Math.min(50, Math.max(1, parseInt(m[1], 10)));
}

function isRankingQuestion(text, metric) {
  const hasRankWord = /\b(top|highest|most|largest|maximum|biggest|bottom|lowest|least|smallest|minimum)\b/i.test(text)
    || /\bhigh(?:est)?\s+amount\b/i.test(text)
    || /\brelease[sd]?\s+high\b/i.test(text)
    || /\bhigh\s+amount\s+of\s+(carbon|ghg|emission)/i.test(text)
    || /\btop\s+\d{1,3}\b/i.test(text)
    || /\bbottom\s+\d{1,3}\b/i.test(text);

  if (!hasRankWord) return false;
  // "top 5 companies" with no metric is still a ranking (default metric applied later).
  if (metric) return true;
  return /\b(compan(y|ies)|emitters?|firms?)\b/i.test(text);
}

function isBottomRanking(text) {
  return /\b(bottom|lowest|least|smallest|minimum)\b/i.test(text)
    && !/\b(top|highest|most|largest|maximum|biggest)\b/i.test(text);
}

/** How-to / control / reduce guidance — not a ranking or metric lookup. */
export function isGuidanceQuestion(text) {
  const t = String(text || '');
  // "how can/to/should … reduce|control|improve|cut …" — company optional.
  if (/\bhow\s+(can|do|to|should|could|i\s+can)\b/i.test(t)
    && /\b(reduce|control|cut|lower|mitigate|manage|improve|increase|decrease)\b/i.test(t)) {
    return true;
  }
  if (!/\b(carbon|ghg|emissions?|energy|water|waste|esg|sustainab|scope\s*[123]|score)\b/i.test(t)) {
    return false;
  }
  if (/\bhow\s+(can|do|to|should|could|i\s+can)\b/i.test(t)) return true;
  if (/\b(best\s+practices?|ways?)\s+to\b/i.test(t) && /\b(reduce|control|cut|lower|mitigate|manage|improve)\b/i.test(t)) {
    return true;
  }
  if (/\b(control|reduce|mitigate|manage|lower|cut|improve)\b.{0,48}\b(carbon|ghg|emissions?|scope\s*[123]|energy|water|waste|esg|score)\b/i.test(t)) {
    return true;
  }
  if (/\b(carbon|ghg|emissions?|scope\s*[123]).{0,48}\b(control|reduce|mitigate|manage|lower|cut)\b/i.test(t)) {
    return true;
  }
  return false;
}

/**
 * Definition / concept / explanation questions — never company SQL.
 *
 * Classifies QUESTION TYPE (definition), not whether the topic is a known ESG term.
 * Topic validation belongs in the Knowledge Engine.
 *
 * "What is a metric?" → INFORMATIONAL (even if the glossary has no entry yet)
 * "What are the carbon emissions of Infosys?" → not informational (value lookup)
 */
export function isInformationalQuestion(text, entities = []) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (isGuidanceQuestion(t)) return false;

  // Structural non-definition shapes (question type), not topic allowlists.
  if (isRankingQuestion(t, null)) return false;
  if (/\b(how\s+many|number\s+of|count\s+of)\b/i.test(t) && /\bcompan/i.test(t)) return false;
  if (/\b(which|list|show|name)\b.{0,24}\bcompan/i.test(t)) return false;
  if (/\bcompare\b/i.test(t)) return false;

  const hasCompany = Array.isArray(entities) && entities.length > 0;
  const refersToCompanies = refersToPriorCompanies(t)
    || /\b(above|those|these|prior|previous)\s+companies\b/i.test(t)
    || /\bof\s+the\s+above\b/i.test(t);

  const definitionCue = /\b(what\s+is|what\s+are|what\s+does|what\s+do|explain|define|definition|meaning\s+of|tell\s+me\s+about|describe)\b/i.test(t)
    || /\b(mean|means|definition|concept|difference\s+between)\b/i.test(t);
  if (!definitionCue) return false;

  const isDefinitionMeta = /\b(mean|means|definition|concept|difference|stand\s+for|meaning)\b/i.test(t);

  // Value-lookup shapes → metric/report paths, not knowledge.
  // "what is/are the X of/for Y" and company/anaphora value asks.
  const valueLookupShape = /\bwhat\s+(is|are)\s+(the\s+)?.{0,80}\b(of|for)\b/i.test(t);
  if (!isDefinitionMeta) {
    if (refersToCompanies) return false;
    if (hasCompany && /\b(of|for|from|at|in)\b/i.test(t)) return false;
    if (valueLookupShape) return false;
  }
  if (hasCompany && /\b(how\s+much|value|figure|number|reported|in\s+20\d{2})\b/i.test(t)) {
    return false;
  }

  // Bare definition question type — topic known/unknown decided later by Knowledge Engine.
  if (!hasCompany) return true;

  // With a company only if clearly definitional meta-language.
  return isDefinitionMeta;
}

/**
 * Metric value question on prior companies — NOT a causal "why" follow-up.
 * e.g. "how much female employee count in above companies"
 */
export function isAnaphoricMetricLookup(text, memory = null) {
  const t = String(text || '').trim();
  if (!t) return false;
  // Causal why-follow-ups are handled separately.
  if (/\b(why|how\s+come|explain\s+why|what\s+makes?|reason)\b/i.test(t)) return false;
  if (!refersToPriorCompanies(t)) return false;
  if (!getPriorCompanyList(memory).length) return false;
  const state = resolveMetricState(t);
  return state.state === METRIC_RESOLUTION.FOUND
    || state.state === METRIC_RESOLUTION.DERIVED;
}

export function isFollowUpExplanation(text, memory = null) {
  const t = String(text || '').trim();
  if (!t) return false;
  // Pronoun / anaphora only — do NOT treat bare "why is Tata Steel…" as a follow-up.
  const refersToPrior = refersToPriorCompanies(t)
    || /\b(they|them|those|these|their)\b/i.test(t)
    || /\b(why|how\s+come)\s+(are|is|do|did|was|were)\s+(they|these|those|them|it|this|that)\b/i.test(t);
  const asksWhy = /\b(why|how\s+come|explain\s+why|what\s+makes?|reason)\b/i.test(t);
  if (!asksWhy) return false;
  if (refersToPrior) return true;
  // Short bare "why?" only when prior structured context exists.
  if (
    (memory?.lastIntent || memory?.lastPlan || memory?.lastCompanies?.length || memory?.entities?.length || memory?.lastPageItems?.length)
    && /^(why\??|why\s+though\??|and\s+why\??)$/i.test(t)
  ) {
    return true;
  }
  return false;
}

/**
 * @param {string} userMessage
 * @param {{ lastIntent?: string, lastList?: object, awaitingMore?: boolean }|null} memory
 * @param {{ validatedCompanies?: string[]|null }} [opts]
 *   When `validatedCompanies` is provided (array, possibly empty), entity
 *   precedence uses validated companies — never raw extract length.
 * @returns {{ intent: string, entities: string[], filters: object, confidence: number, wantsAll: boolean, metric: string|null }}
 */
export function classifyIntent(userMessage, memory = null, opts = {}) {
  const text = String(userMessage || '').trim();
  const lower = text.toLowerCase();

  // 1–2. Query-type signals BEFORE entity extraction (parsing-order fix).
  const isComparisonQuery = looksLikeCompanyComparison(text);
  const isSectorAggregateQuery = looksLikeSectorAggregate(text);
  const aggregation = detectAggregation(text);

  // 3. Metric resolution (longest match wins via extractMetrics).
  const metrics = extractMetrics(text);
  const extractedMetric = metrics[0] || null;
  const metricState = resolveMetricState(text, { metrics, metric: extractedMetric });
  const metricExecutable = metricState.state === METRIC_RESOLUTION.FOUND
    || metricState.state === METRIC_RESOLUTION.DERIVED;
  const metric = metricExecutable ? metricState.metric : null;

  // 4. Entity extraction — comparison parse only for comparison queries.
  //    Sector/industry aggregates never invent company entities from "and".
  const entities = isSectorAggregateQuery
    ? extractCompanyCandidates(text, { allowCompareParse: false }).filter((e) => {
      // Keep only known short-name / legal-suffix hits; drop garbage.
      return COMPANY_NAME_HINTS.some((h) => e.toLowerCase().includes(h))
        || /\b(Limited|Ltd\.?|Bank|Motors|Power|Industries|Services|Paints)\b/i.test(e);
    })
    : extractCompanyCandidates(text, { allowCompareParse: isComparisonQuery });

  const validatedOpt = Object.prototype.hasOwnProperty.call(opts, 'validatedCompanies')
    ? opts.validatedCompanies
    : null;
  const years = extractYears(text);
  const sector = extractSector(text);
  // Never treat anaphoric "above companies" as a request for ALL companies.
  const wantsAll = wantsAllRecords(text) && !refersToPriorCompanies(text);
  const wantsChart = /\b(chart|plot|graph|visuali[sz]e|bar chart|line chart|pie)\b/i.test(text);

  const filters = {};
  if (sector) filters.sector = sector;
  if (years.length) filters.years = years;
  if (metric) filters.metric = metric;
  if (metricState.metrics.length) filters.metrics = metricState.metrics;
  if (wantsChart) filters.wantsChart = true;
  if (aggregation) filters.aggregation = aggregation;
  if (isSectorAggregateQuery) {
    filters.groupBy = /\bindustr/i.test(text) && !/\bsector/i.test(text) ? 'industry' : 'sector';
    filters.acrossAllSectors = !sector || /\ball\s+(sectors?|industries)\b/i.test(text);
  }
  filters.metricResolution = metricState.state;
  if (metricState.state === METRIC_RESOLUTION.DERIVED) {
    filters.derivedMetric = true;
    filters.derivedFrom = metricState.derived?.requires || [];
  }

  if (isFollowUpPagination(text, memory)) {
    return {
      intent: INTENTS.PAGINATE_CONTINUE,
      entities: memory?.entities || [],
      filters: { ...(memory?.filters || {}), ...filters, pageDelta: /prev|previous/i.test(text) ? -1 : 1 },
      confidence: 0.95,
      wantsAll: Boolean(memory?.wantsAll),
      metric: memory?.filters?.metric || metric,
      metricResolution: METRIC_RESOLUTION.NONE,
      source: 'rules',
    };
  }

  // Conversation context validation: "above/those companies" / "them" require a stored list.
  const priorCompanyCheck = validatePriorCompanyReference(text, memory);
  if (priorCompanyCheck.refersToPrior && !priorCompanyCheck.ok) {
    return {
      intent: INTENTS.UNKNOWN,
      entities: [],
      filters: {
        ...filters,
        needsPriorCompanies: true,
        // Explicitly forbid expanding to the full company universe.
        wantsAll: false,
      },
      confidence: 0.96,
      wantsAll: false,
      metric,
      metrics: metric ? [metric] : [],
      metricResolution: metricState.state,
      clarification: priorCompanyCheck.clarification,
      assumptions: [],
      source: 'rules',
    };
  }

  const priorEntities = priorCompanyCheck.ok && priorCompanyCheck.companies.length
    ? priorCompanyCheck.companies
    : getPriorCompanyList(memory);

  // Unsupported metric on prior companies — never inherit lastMetric.
  if (metricState.state === METRIC_RESOLUTION.UNSUPPORTED) {
    const decided = chooseEntitiesByPrecedence({
      validatedCompanies: validatedOpt,
      candidates: entities,
      userMessage: text,
      memory,
    });
    const resolvedEntities = decided.companies;
    const priorYears = years.length
      ? years
      : (memory?.lastYear ? [memory.lastYear] : (memory?.filters?.years || []));
    return {
      intent: INTENTS.METRIC_LOOKUP,
      entities: resolvedEntities,
      filters: {
        ...filters,
        ...(priorYears.length ? { years: priorYears } : {}),
        followUpCompanies: decided.source === 'memory' || priorCompanyCheck.refersToPrior,
        priorIntent: memory?.lastIntent || null,
        unsupportedMetric: true,
        metricResolution: METRIC_RESOLUTION.UNSUPPORTED,
        wantsAll: false,
        ...(decided.needsClarification ? { needsPriorCompanies: true } : {}),
      },
      confidence: 0.95,
      wantsAll: false,
      metric: null,
      metrics: [],
      metricResolution: METRIC_RESOLUTION.UNSUPPORTED,
      assumptions: decided.source === 'memory' && resolvedEntities.length
        ? [`Using companies from prior context: ${resolvedEntities.slice(0, 3).join(', ')}.`]
        : [],
      clarification: decided.needsClarification ? decided.clarification : undefined,
      source: 'rules',
    };
  }

  // Metric on prior companies ("female/male employee count in above companies") → SQL compare/lookup.
  // Must run BEFORE causal FOLLOW_UP so we do not reuse the previous Scope 1 metric.
  // Entity precedence uses validated companies — never entities.length alone.
  if (isAnaphoricMetricLookup(text, memory) && metric) {
    const decided = chooseEntitiesByPrecedence({
      // When caller has not validated yet, treat raw candidates as unvalidated:
      // anaphoric turns must use memory, not garbage extraction.
      validatedCompanies: validatedOpt,
      candidates: entities,
      userMessage: text,
      memory,
    });
    const resolvedEntities = decided.companies;
    const priorYears = years.length
      ? years
      : (memory?.lastYear ? [memory.lastYear] : (memory?.filters?.years || []));
    const multi = resolvedEntities.length >= 2;
    return {
      intent: multi ? INTENTS.COMPARE_COMPANIES : INTENTS.METRIC_LOOKUP,
      entities: resolvedEntities,
      filters: {
        ...filters,
        ...(priorYears.length ? { years: priorYears } : {}),
        metric,
        metrics: metricState.metrics.length ? metricState.metrics : [metric],
        followUpCompanies: decided.source === 'memory' || priorCompanyCheck.refersToPrior,
        priorIntent: memory?.lastIntent || null,
        metricResolution: metricState.state,
        wantsAll: false,
        ...(decided.needsClarification ? { needsPriorCompanies: true } : {}),
      },
      confidence: 0.94,
      wantsAll: false,
      metric,
      metrics: metricState.metrics.length ? metricState.metrics : [metric],
      metricResolution: metricState.state,
      assumptions: resolvedEntities.length
        ? [
          decided.source === 'memory'
            ? `Using companies from prior context: ${resolvedEntities.slice(0, 3).join(', ')}.`
            : `Using companies named in the current message: ${resolvedEntities.slice(0, 3).join(', ')}.`,
          ...(metricState.state === METRIC_RESOLUTION.DERIVED
            ? [`Derived metric ${metric} from ${metricState.derived?.requires?.join(' − ') || 'schema fields'}.`]
            : []),
        ]
        : [],
      clarification: decided.needsClarification ? decided.clarification : undefined,
      source: 'rules',
    };
  }

  // Follow-up explanation ("Why are these companies high?") before list/rank heuristics.
  if (isFollowUpExplanation(text, memory)) {
    // NONE → may reuse prior metric; FOUND already set above; UNSUPPORTED handled earlier.
    const priorMetric = metric
      || (metricState.state === METRIC_RESOLUTION.NONE
        ? (memory?.lastMetric || memory?.filters?.metric || null)
        : null);
    const priorYears = years.length
      ? years
      : (memory?.lastYear ? [memory.lastYear] : (memory?.filters?.years || []));
    const decided = chooseEntitiesByPrecedence({
      validatedCompanies: validatedOpt,
      candidates: entities,
      userMessage: text,
      memory,
    });
    return {
      intent: INTENTS.FOLLOW_UP,
      entities: decided.companies,
      filters: {
        ...(memory?.filters || {}),
        ...filters,
        ...(priorYears.length ? { years: priorYears } : {}),
        followUp: true,
        priorIntent: memory?.lastIntent || null,
        ...(priorMetric ? { metric: priorMetric } : {}),
        ...(decided.source === 'memory' ? { followUpCompanies: true } : {}),
        ...(decided.needsClarification ? { needsPriorCompanies: true } : {}),
      },
      confidence: 0.9,
      wantsAll: false,
      metric: priorMetric,
      metrics: priorMetric ? [priorMetric] : [],
      metricResolution: metricState.state,
      assumptions: decided.source === 'memory' && decided.companies.length
        ? [`Using companies from prior context: ${decided.companies.slice(0, 3).join(', ')}.`]
        : [],
      clarification: decided.needsClarification ? decided.clarification : undefined,
      source: 'rules',
    };
  }

  const topLimit = extractTopLimit(text);
  if (topLimit) filters.limit = topLimit;

  const stamp = (result) => ({
    ...result,
    metricResolution: result.metricResolution || metricState.state,
    metrics: result.metrics ?? (metric ? [metric] : metrics),
    filters: {
      ...(result.filters || {}),
      metricResolution: result.metricResolution || metricState.state,
    },
  });

  // Intent type BEFORE metric routing: HOW_TO and INFORMATIONAL never go to SQL.
  // Guidance / how-to (e.g. "how can I control carbon emissions") — never treat as top-N ranking.
  if (isGuidanceQuestion(text)) {
    return stamp({
      intent: INTENTS.HOW_TO,
      entities,
      filters: { ...filters, guidance: true, answerType: 'QUALITATIVE' },
      confidence: 0.94,
      wantsAll: false,
      // Keep metric for context in guidance text, but do not treat as SQL lookup.
      metric,
      metrics,
      source: 'rules',
    });
  }

  // Anaphoric company refs with memory — never collapse to INFORMATIONAL with empty entities.
  // Covers "their emissions" / "same company" when the metric is omitted (reuse lastMetric).
  if (
    priorCompanyCheck.refersToPrior
    && priorEntities.length
    && !isGuidanceQuestion(text)
  ) {
    const decided = chooseEntitiesByPrecedence({
      validatedCompanies: validatedOpt,
      candidates: entities,
      userMessage: text,
      memory,
    });
    if (decided.companies.length) {
      const reuseMetric = shouldReuseMemoryMetric(metricState.state)
        ? (metric || memory?.lastMetric || memory?.filters?.metric || null)
        : metric;
      const priorYears = years.length
        ? years
        : (memory?.lastYear ? [memory.lastYear] : (memory?.filters?.years || []));
      const multi = decided.companies.length >= 2;
      if (reuseMetric) {
        return stamp({
          intent: multi ? INTENTS.COMPARE_COMPANIES : INTENTS.METRIC_LOOKUP,
          entities: decided.companies,
          filters: {
            ...filters,
            ...(priorYears.length ? { years: priorYears } : {}),
            metric: reuseMetric,
            followUpCompanies: decided.source === 'memory',
            priorIntent: memory?.lastIntent || null,
            followUp: true,
          },
          confidence: 0.9,
          wantsAll: false,
          metric: reuseMetric,
          metrics: [reuseMetric],
          assumptions: [
            `Using companies from prior context: ${decided.companies.slice(0, 3).join(', ')}.`,
          ],
          source: 'rules',
        });
      }
      return stamp({
        intent: INTENTS.FOLLOW_UP,
        entities: decided.companies,
        filters: {
          ...filters,
          ...(priorYears.length ? { years: priorYears } : {}),
          followUp: true,
          followUpCompanies: true,
          priorIntent: memory?.lastIntent || null,
        },
        confidence: 0.88,
        wantsAll: false,
        metric: null,
        metrics: [],
        assumptions: [
          `Using companies from prior context: ${decided.companies.slice(0, 3).join(', ')}.`,
        ],
        source: 'rules',
      });
    }
  }

  // Definitions / concepts ("What are carbon emissions?", "Explain Scope 1", "What is ESG?").
  if (isInformationalQuestion(text, entities)) {
    return stamp({
      intent: INTENTS.INFORMATIONAL,
      entities: [],
      filters: {
        ...filters,
        informational: true,
        answerType: 'INFORMATIONAL',
        // Do not carry metric into SQL planning for definitions.
      },
      confidence: 0.95,
      wantsAll: false,
      metric: null,
      metrics: [],
      metricResolution: METRIC_RESOLUTION.NONE,
      source: 'rules',
    });
  }

  // Count (typo-tolerant: comannies → companies; “hold/have BRSR reports”)
  {
    const countText = normalizeCompanyCountText(text);
    if (
      looksLikeCompanyCountAsk(countText)
      && !wantsAll
      && !isRankingQuestion(countText, metric)
    ) {
      return stamp({
        intent: INTENTS.COUNT_COMPANIES,
        entities: [],
        filters,
        confidence: 0.96,
        wantsAll: false,
        metric: null,
        source: 'rules',
      });
    }
  }

  // Sector / industry aggregate analytics — company entities NOT required.
  // Must run before company ranking / METRIC_LOOKUP so "across all sectors" never asks for a company.
  if (isSectorAggregateQuery && (metric || aggregation)) {
    const bottom = isBottomRanking(text);
    const resolvedMetric = metric || DEFAULT_RANK_METRIC;
    return stamp({
      intent: INTENTS.SECTOR_SUMMARY,
      entities: [],
      filters: {
        ...filters,
        metric: resolvedMetric,
        aggregation: aggregation || 'AVG',
        groupBy: filters.groupBy || 'sector',
        order: bottom ? 'ASC' : 'DESC',
        wantsChart,
        acrossAllSectors: filters.acrossAllSectors !== false,
        answerType: 'QUANTITATIVE',
      },
      confidence: metric ? 0.93 : 0.85,
      wantsAll: false,
      metric: resolvedMetric,
      metrics: metrics.length ? metrics : [resolvedMetric],
      assumptions: [
        'Sector/industry aggregate query — companies not required.',
        ...(metric ? [] : ['No metric named — using total_emissions (Scope 1+2+3 proxy).']),
      ],
      source: 'rules',
    });
  }

  // Rankings BEFORE company-list discovery — "show top 5 companies" is RANK, not LIST.
  if (isRankingQuestion(text, metric)) {
    const assumedMetric = !metric;
    const resolvedMetric = metric || DEFAULT_RANK_METRIC;
    const bottom = isBottomRanking(text);
    if (assumedMetric) {
      filters.assumedMetric = true;
      filters.metricAssumption = 'Carbon/ESG ranking without an explicit metric → total_emissions (Scope 1+2+3 when available).';
    }
    filters.metric = resolvedMetric;
    return stamp({
      intent: bottom ? INTENTS.BOTTOM_METRIC : INTENTS.TOP_METRIC,
      entities,
      filters: {
        ...filters,
        order: bottom ? 'ASC' : 'DESC',
        limit: topLimit || filters.limit || 5,
        wantsChart,
      },
      confidence: assumedMetric ? 0.88 : 0.95,
      wantsAll: false,
      metric: resolvedMetric,
      metrics: metrics.length ? metrics : [resolvedMetric],
      assumptions: assumedMetric
        ? ['No metric named — using total_emissions (Scope 1+2+3 proxy).']
        : [],
      source: 'rules',
    });
  }

  if (isBottomRanking(text) && metric) {
    return stamp({
      intent: INTENTS.BOTTOM_METRIC,
      entities,
      filters: { ...filters, order: 'ASC', limit: topLimit || filters.limit || 5 },
      confidence: 0.93,
      wantsAll: false,
      metric,
      metrics,
      source: 'rules',
    });
  }

  // Comparison intent only with explicit compare/vs/versus cues (not bare "and").
  if (isComparisonQuery && (entities.length >= 1 || /\band\b/i.test(text))) {
    return stamp({
      intent: INTENTS.COMPARE_COMPANIES,
      entities,
      filters: { ...filters, wantsChart },
      confidence: entities.length >= 2 ? 0.93 : 0.85,
      wantsAll: false,
      metric,
      metrics,
    });
  }

  // Phase 12: "Why is A higher than B on Scope 1?" → compare + hybrid why (SQL+RAG).
  // Require comparative "higher/lower than" — not bare "explain what Scope 1 means".
  const asksWhyCompare = /\b(higher|lower|greater|less)\s+than\b/i.test(text)
    && (/\b(why|how\s+come|explain)\b/i.test(text) || /\b(emission|carbon|scope|ghg|renewable)\b/i.test(text));
  if (asksWhyCompare && entities.length >= 2 && (metric || /\b(emission|carbon|scope|ghg|renewable)\b/i.test(text))) {
    return stamp({
      intent: INTENTS.COMPARE_COMPANIES,
      entities,
      filters: {
        ...filters,
        hybridWhy: true,
        metric: metric || 'total_emissions',
      },
      confidence: 0.9,
      wantsAll: false,
      metric: metric || DEFAULT_RANK_METRIC,
      metrics: metrics.length ? metrics : [metric || DEFAULT_RANK_METRIC],
      assumptions: !metric
        ? ['No metric named — using total_emissions (Scope 1+2+3 proxy).']
        : [],
      source: 'rules',
    });
  }

  if (/\b(trend|over time|across years|year over year|yoy)\b/i.test(text)) {
    return stamp({ intent: INTENTS.TREND_ANALYSIS, entities, filters, confidence: 0.9, wantsAll: false, metric });
  }

  // List all / discovery company lists (exclude ranking / metric top-N phrasing)
  if (
    (wantsAll
      || /\b(list|show|give).{0,40}\bcompan(y|ies)\b/i.test(text)
      || /\bwhat companies\b|\bwhich companies\b|\bwho publishes brsr\b|\bcompanies (in|with) (the )?database\b|\bbrsr in india\b/i.test(text))
    && !metric
  ) {
    if (sector && !wantsAll && !/\ball\b|\bevery\b/i.test(text)) {
      return stamp({ intent: INTENTS.FILTER_BY_SECTOR, entities, filters, confidence: 0.92, wantsAll: false, metric });
    }
    return stamp({
      intent: wantsAll || /\ball\b|\bevery\b|\btotal company/i.test(text)
        ? INTENTS.LIST_ALL_COMPANIES
        : (sector ? INTENTS.FILTER_BY_SECTOR : INTENTS.LIST_ALL_COMPANIES),
      entities,
      filters,
      confidence: wantsAll ? 0.98 : 0.9,
      wantsAll: wantsAll || !sector,
      metric,
      metrics,
    });
  }

  // "list/give companies" WITH a metric but no ranking word → still treat as top metric if emissions/share asked
  if (
    metric
    && /\b(list|show|give|which|what)\b.*\bcompan(y|ies)\b/i.test(text)
    && /\b(emission|carbon|ghg|renewable|water|waste|revenue|female|intensity)\b/i.test(text)
  ) {
    return stamp({
      intent: INTENTS.TOP_METRIC,
      entities,
      filters: { ...filters, order: 'DESC', limit: topLimit || 5 },
      confidence: 0.9,
      wantsAll: false,
      metric,
      metrics,
    });
  }

  if (sector && /\b(companies|firms)\b/i.test(text) && !metric) {
    return stamp({ intent: INTENTS.FILTER_BY_SECTOR, entities, filters, confidence: 0.9, wantsAll: false, metric });
  }

  if (/\b(summary|overview|profile|tell me about)\b/i.test(text) && (entities.length || sector)) {
    return stamp({
      intent: sector && !entities.length ? INTENTS.SECTOR_SUMMARY : INTENTS.COMPANY_SUMMARY,
      entities,
      filters,
      confidence: 0.85,
      wantsAll: false,
      metric,
    });
  }

  // Conceptual BRSR explainers before report/metric lookup (legacy path → INFORMATIONAL).
  if (isInformationalQuestion(text, entities)
      || (/\b(what is|explain|tell me about|what are|what do)\b.*\b(esg|brsr|scope|carbon|sustainability|emission)/i.test(text)
        && !entities.length)) {
    return stamp({
      intent: INTENTS.INFORMATIONAL,
      entities: [],
      filters: { ...filters, informational: true, answerType: 'INFORMATIONAL' },
      confidence: 0.9,
      wantsAll: false,
      metric: null,
      metrics: [],
      metricResolution: METRIC_RESOLUTION.NONE,
      source: 'rules',
    });
  }

  if (entities.length && metric && years.length) {
    return stamp({ intent: INTENTS.METRIC_LOOKUP, entities, filters, confidence: 0.9, wantsAll: false, metric, metrics });
  }

  if (entities.length && /\b(report|filing|pdf)\b/i.test(text) && !/\bmean\b/i.test(text)) {
    return stamp({ intent: INTENTS.REPORT_LOOKUP, entities, filters, confidence: 0.86, wantsAll: false, metric, metrics });
  }

  if (entities.length && metric) {
    return stamp({ intent: INTENTS.METRIC_LOOKUP, entities, filters, confidence: 0.84, wantsAll: false, metric, metrics });
  }

  if (wantsChart) {
    return stamp({ intent: INTENTS.CHART_REQUEST, entities, filters, confidence: 0.8, wantsAll: false, metric, metrics });
  }

  // Only default to ranking when the user clearly asks about companies/leaders — not bare metric mentions.
  if (
    metric
    && !entities.length
    && /\b(compan(y|ies)|rank|leader|emitters?|intensive)\b/i.test(text)
  ) {
    return stamp({
      intent: INTENTS.TOP_METRIC,
      entities,
      filters: { ...filters, order: 'DESC', limit: topLimit || 5 },
      confidence: 0.7,
      wantsAll: false,
      metric,
      metrics,
    });
  }

  return stamp({
    intent: INTENTS.UNKNOWN,
    entities,
    filters,
    confidence: 0.4,
    wantsAll: false,
    metric,
  });
}
