/**
 * Phase 5/6 — Planner validation engine before execution.
 *
 * Pipeline: Planner → Planner Validation → Execution
 *
 * Verifies:
 * - Does the metric exist?
 * - Is the selected tool correct?
 * - Is this SQL or Narrative?
 * - Are companies correct?
 * - Is the year correct?
 * - Is this a follow-up or a new query?
 *
 * On failure: reject plan → deterministic repair → re-plan once.
 */

import { INTENTS, DEFAULT_RANK_METRIC, isGuidanceQuestion } from '../intent/classify-intent.js';
import { METRIC_RESOLUTION } from '../intent/metric-resolution.js';
import { planQuery, TOOLS } from '../planner/plan-query.js';
import { scorePlan, isWeakPlanScore } from '../planner/planner-score.js';
import { RANKABLE_METRICS } from '../sql-sanitize.js';
import {
  validateSemanticPlan,
  ANSWER_TYPES,
  quantitativeIntentForCompanies,
} from './semantic-plan.js';

const MIN_CONFIDENCE = Number(process.env.PLAN_MIN_CONFIDENCE || 0.45);
const MIN_YEAR = 2015;
const MAX_YEAR = 2035;

/** Metrics the SQL agent can rank/compare, including computed / derived metrics. */
export const PLAN_METRICS = new Set([
  ...RANKABLE_METRICS,
  'total_emissions',
  'male_board_count',
  'male_board_share',
]);

/** Intent → allowed primary tools / strategies. */
const INTENT_TOOL_RULES = {
  [INTENTS.LIST_ALL_COMPANIES]: {
    tools: [TOOLS.SQL],
    strategies: ['sql_list_all_paginated', 'sql_list_overview'],
    forbidStrategies: ['sql_rank_metric', 'guidance_templates'],
  },
  [INTENTS.COUNT_COMPANIES]: {
    tools: [TOOLS.SQL],
    strategies: ['sql_count'],
    forbidStrategies: ['sql_rank_metric', 'guidance_templates'],
  },
  [INTENTS.FILTER_BY_SECTOR]: {
    tools: [TOOLS.SQL],
    strategies: ['sql_filter_sector'],
  },
  [INTENTS.TOP_METRIC]: {
    tools: [TOOLS.SQL],
    strategies: ['sql_rank_metric'],
    forbidStrategies: ['guidance_templates', 'sql_list_all_paginated'],
    requireMetric: true,
  },
  [INTENTS.BOTTOM_METRIC]: {
    tools: [TOOLS.SQL],
    strategies: ['sql_rank_metric'],
    forbidStrategies: ['guidance_templates'],
    requireMetric: true,
  },
  [INTENTS.COMPARE_COMPANIES]: {
    tools: [TOOLS.SQL, TOOLS.HYBRID],
    strategies: ['sql_compare_companies', 'hybrid_why_compare'],
    minCompanies: 2,
  },
  [INTENTS.METRIC_LOOKUP]: {
    tools: [TOOLS.SQL],
    strategies: ['sql_company_metric'],
    minCompanies: 1,
  },
  [INTENTS.REPORT_LOOKUP]: {
    tools: [TOOLS.RAG, TOOLS.HYBRID, TOOLS.SQL],
    strategies: ['brsr_narrative_summary'],
    minCompanies: 1,
  },
  [INTENTS.COMPANY_SUMMARY]: {
    tools: [TOOLS.HYBRID, TOOLS.RAG, TOOLS.SQL],
    strategies: ['brsr_narrative_summary'],
    minCompanies: 1,
  },
  [INTENTS.HOW_TO]: {
    tools: [TOOLS.RAG, TOOLS.HYBRID],
    strategies: ['guidance_templates'],
    forbidStrategies: ['sql_rank_metric', 'sql_compare_companies', 'sql_list_all_paginated', 'sql_company_metric'],
    forbidTools: [TOOLS.SQL], // SQL must not be primary for how-to
  },
  [INTENTS.INFORMATIONAL]: {
    tools: [TOOLS.RAG, TOOLS.HYBRID],
    strategies: ['informational_definition', 'rag_with_schema_context'],
    forbidStrategies: ['sql_rank_metric', 'sql_compare_companies', 'sql_company_metric'],
    forbidTools: [TOOLS.SQL],
  },
  [INTENTS.FOLLOW_UP]: {
    tools: [TOOLS.HYBRID, TOOLS.RAG, TOOLS.SQL],
    strategies: ['follow_up_from_memory'],
  },
  [INTENTS.GENERAL_ESG_QUESTION]: {
    tools: [TOOLS.RAG, TOOLS.HYBRID],
    strategies: ['rag_with_schema_context', 'informational_definition'],
    forbidStrategies: ['sql_rank_metric', 'sql_company_metric'],
    forbidTools: [TOOLS.SQL],
  },
  [INTENTS.TREND_ANALYSIS]: {
    tools: [TOOLS.SQL, TOOLS.CHARTS],
    strategies: ['sql_trend'],
  },
  [INTENTS.SECTOR_SUMMARY]: {
    tools: [TOOLS.ANALYTICS, TOOLS.SQL],
    strategies: ['sql_sector_aggregate'],
    // Aggregate / group-by analytics — companies are optional.
    minCompanies: 0,
  },
  [INTENTS.PAGINATE_CONTINUE]: {
    tools: [TOOLS.SQL, TOOLS.HYBRID, TOOLS.RAG, TOOLS.LLM_TOOLS, TOOLS.ANALYTICS, TOOLS.CHARTS],
    strategies: null, // inherits prior strategy
  },
};

function yearsFrom(classification, plan) {
  const y = plan?.filters?.years || classification?.filters?.years || [];
  return Array.isArray(y) ? y.map(Number).filter((n) => Number.isFinite(n)) : [];
}

function metricFrom(classification, plan) {
  return plan?.metric || classification?.metric || plan?.filters?.metric || classification?.filters?.metric || null;
}

function companiesFrom(classification, plan) {
  const list = plan?.entities?.length ? plan.entities : classification?.entities;
  return Array.isArray(list) ? list.filter(Boolean) : [];
}

/**
 * Validate plan against classification before any SQL/RAG execution.
 * @returns {{ ok: boolean, errors: string[], warnings: string[], repairs: object[] }}
 */
export function validatePlan(plan, classification, { memory = null, userMessage = '' } = {}) {
  const errors = [];
  const warnings = [];
  const repairs = [];

  if (!plan || !classification) {
    return { ok: false, errors: ['Missing plan or classification'], warnings, repairs };
  }

  const intent = classification.intent || plan.intent;
  const rules = INTENT_TOOL_RULES[intent];
  const metric = metricFrom(classification, plan);
  const companies = companiesFrom(classification, plan);
  const years = yearsFrom(classification, plan);
  const confidence = Number(classification.confidence ?? plan.confidence ?? 0);

  // Guidance question must never execute as a ranking plan.
  if (isGuidanceQuestion(userMessage) && (intent === INTENTS.TOP_METRIC || intent === INTENTS.BOTTOM_METRIC || plan.strategy === 'sql_rank_metric')) {
    errors.push('HOW_TO / guidance question cannot be answered by ranking SQL');
    repairs.push({ type: 'force_how_to' });
  }

  if (intent === INTENTS.HOW_TO && plan.strategy === 'sql_rank_metric') {
    errors.push('HOW_TO intent planned with sql_rank_metric');
    repairs.push({ type: 'force_how_to' });
  }

  if (rules) {
    if (rules.tools && !rules.tools.includes(plan.primaryTool)) {
      errors.push(`Tool ${plan.primaryTool} does not match intent ${intent}`);
      repairs.push({ type: 'replan_from_intent' });
    }
    if (rules.forbidTools?.includes(plan.primaryTool)) {
      errors.push(`Tool ${plan.primaryTool} is forbidden for intent ${intent}`);
      repairs.push({ type: 'force_how_to' });
    }
    if (rules.strategies && !rules.strategies.includes(plan.strategy)) {
      // PAGINATE inherits — skip strict strategy check when null rules.strategies
      errors.push(`Strategy ${plan.strategy} does not match intent ${intent}`);
      repairs.push({ type: 'replan_from_intent' });
    }
    if (rules.forbidStrategies?.includes(plan.strategy)) {
      errors.push(`Strategy ${plan.strategy} is forbidden for intent ${intent}`);
      if (intent === INTENTS.HOW_TO || isGuidanceQuestion(userMessage)) {
        repairs.push({ type: 'force_how_to' });
      } else {
        repairs.push({ type: 'replan_from_intent' });
      }
    }
    if (rules.requireMetric && !metric) {
      errors.push('Ranking plan is missing a metric');
      repairs.push({ type: 'default_rank_metric' });
    }
    if (rules.minCompanies != null && companies.length < rules.minCompanies) {
      errors.push(`${intent} requires at least ${rules.minCompanies} compan${rules.minCompanies === 1 ? 'y' : 'ies'} (got ${companies.length})`);
      if (intent === INTENTS.COMPARE_COMPANIES && companies.length === 1) {
        repairs.push({ type: 'compare_to_lookup' });
      } else if (intent === INTENTS.COMPARE_COMPANIES && companies.length === 0) {
        repairs.push({ type: 'clarify_companies', min: 2 });
      } else if (companies.length === 0) {
        repairs.push({ type: 'clarify_companies', min: rules.minCompanies });
      }
    }
  }

  if (metric && !PLAN_METRICS.has(metric)) {
    errors.push(`Unknown or unsupported metric: ${metric}`);
    repairs.push({ type: 'drop_invalid_metric' });
  }

  if (intent === INTENTS.FILTER_BY_SECTOR && !plan.filters?.sector && !classification.filters?.sector) {
    errors.push('FILTER_BY_SECTOR plan is missing sector');
    repairs.push({ type: 'filter_to_list' });
  }

  for (const year of years) {
    if (year < MIN_YEAR || year > MAX_YEAR) {
      errors.push(`Year ${year} is outside supported BRSR range (${MIN_YEAR}–${MAX_YEAR})`);
      repairs.push({ type: 'drop_invalid_year', year });
    }
  }

  if (confidence > 0 && confidence < MIN_CONFIDENCE) {
    warnings.push(`Low intent confidence (${confidence})`);
    if (confidence < MIN_CONFIDENCE * 0.7) {
      errors.push(`Confidence ${confidence} below hard threshold ${MIN_CONFIDENCE}`);
      repairs.push({ type: 'low_confidence_unknown' });
    }
  }

  // FOLLOW_UP vs new query — follow-ups need recoverable prior context
  if (intent === INTENTS.FOLLOW_UP) {
    const hasPrior = Boolean(
      memory?.lastIntent
      || memory?.lastCompanies?.length
      || memory?.lastMetric
      || memory?.lastYear
      || memory?.comparisonContext
      || companies.length
      || metric
      || memory?.lastPageItems?.length,
    );
    if (!hasPrior) {
      warnings.push('FOLLOW_UP has little prior context');
      errors.push('FOLLOW_UP without recoverable conversation context');
      repairs.push({ type: 'low_confidence_unknown' });
    }
  }

  // SQL vs Narrative path: structured metrics must not route to narrative/RAG primary.
  const structuredMetricIntent = intent === INTENTS.METRIC_LOOKUP
    || intent === INTENTS.REPORT_LOOKUP
    || intent === INTENTS.TOP_METRIC
    || intent === INTENTS.BOTTOM_METRIC
    || intent === INTENTS.COMPARE_COMPANIES;
  if (
    structuredMetricIntent
    && metric
    && PLAN_METRICS.has(metric)
    && (
      plan.primaryTool === TOOLS.RAG
      || plan.strategy === 'guidance_templates'
      || plan.strategy === 'rag_with_schema_context'
      || plan.strategy === 'brsr_narrative_summary'
    )
  ) {
    errors.push(`Metric ${metric} planned as Narrative/RAG instead of SQL`);
    repairs.push({ type: 'force_sql_metric' });
  }

  // WHY / explanation follow-ups — prefer hybrid when hybridWhy is set.
  if (
    classification?.filters?.hybridWhy
    && intent === INTENTS.COMPARE_COMPANIES
    && plan.strategy === 'sql_compare_companies'
  ) {
    warnings.push('hybridWhy compare planned as SQL-only — prefer hybrid_why_compare');
  }

  // Phase 6b — Semantic answer-type validation (quantitative vs qualitative).
  const semantic = validateSemanticPlan(plan, classification, { userMessage, memory });
  for (const w of semantic.warnings || []) warnings.push(w);
  for (const e of semantic.errors || []) errors.push(e);
  for (const r of semantic.repairs || []) repairs.push(r);

  // Deduplicate repair actions by type
  const seen = new Set();
  const uniqueRepairs = [];
  for (const r of repairs) {
    const key = `${r.type}:${r.year || r.min || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueRepairs.push(r);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    repairs: uniqueRepairs,
    answerType: semantic.answerType,
    semantic,
  };
}

/**
 * Apply deterministic repairs to classification (no LLM).
 * @returns {{ classification: object, repaired: boolean, clarification?: string, assumptions: string[] }}
 */
export function repairClassification(classification, plan, validation, { memory = null, userMessage = '' } = {}) {
  if (!validation || validation.ok || !validation.repairs?.length) {
    return { classification, repaired: false, assumptions: [] };
  }

  let next = {
    ...classification,
    filters: { ...(classification.filters || {}) },
    entities: [...(classification.entities || [])],
    assumptions: [...(classification.assumptions || [])],
  };
  const assumptions = [];
  let repaired = false;
  let clarification = null;

  for (const action of validation.repairs) {
    switch (action.type) {
      case 'force_how_to':
        next.intent = INTENTS.HOW_TO;
        next.canonicalIntent = 'HOW_TO';
        next.filters = { ...next.filters, guidance: true, answerType: 'QUALITATIVE' };
        next.confidence = Math.max(next.confidence || 0, 0.9);
        repaired = true;
        break;

      case 'force_informational':
        next.intent = INTENTS.INFORMATIONAL;
        next.canonicalIntent = 'INFORMATIONAL';
        next.entities = [];
        next.metric = null;
        next.metricResolution = METRIC_RESOLUTION.NONE;
        next.filters = {
          ...next.filters,
          informational: true,
          answerType: 'INFORMATIONAL',
          metricResolution: METRIC_RESOLUTION.NONE,
        };
        delete next.filters.metric;
        next.confidence = Math.max(next.confidence || 0, 0.92);
        assumptions.push('Definition / concept question — answering without company SQL lookup.');
        repaired = true;
        break;

      case 'default_rank_metric':
        next.metric = DEFAULT_RANK_METRIC;
        next.filters.metric = DEFAULT_RANK_METRIC;
        next.filters.assumedMetric = true;
        assumptions.push('No metric named — using total_emissions (Scope 1+2+3 proxy).');
        repaired = true;
        break;

      case 'compare_to_lookup':
        next.intent = INTENTS.METRIC_LOOKUP;
        next.canonicalIntent = 'LOOKUP';
        assumptions.push('Only one company detected — treating as a metric lookup instead of a compare.');
        repaired = true;
        break;

      case 'clarify_companies':
        clarification = action.min >= 2
          ? 'Please name at least two companies to compare (for example: “Compare Tata Steel and JSW Steel Scope 1 emissions”).'
          : 'Please name the company you want me to look up in the BRSR database.';
        break;

      case 'filter_to_list':
        next.intent = INTENTS.LIST_ALL_COMPANIES;
        next.canonicalIntent = 'LIST';
        next.wantsAll = false;
        assumptions.push('No sector detected — showing a company list overview instead.');
        repaired = true;
        break;

      case 'drop_invalid_metric':
        // Never silently substitute a default metric when the user asked for an unsupported one.
        if (
          next.metricResolution === METRIC_RESOLUTION.UNSUPPORTED
          || next.filters?.unsupportedMetric
          || next.filters?.metricResolution === METRIC_RESOLUTION.UNSUPPORTED
        ) {
          next.metric = null;
          delete next.filters.metric;
          next.metricResolution = METRIC_RESOLUTION.UNSUPPORTED;
          next.filters.unsupportedMetric = true;
          next.filters.metricResolution = METRIC_RESOLUTION.UNSUPPORTED;
          assumptions.push('Requested metric is not available in the BRSR reports table.');
        } else if (next.intent === INTENTS.TOP_METRIC || next.intent === INTENTS.BOTTOM_METRIC) {
          next.metric = DEFAULT_RANK_METRIC;
          next.filters.metric = DEFAULT_RANK_METRIC;
          next.filters.assumedMetric = true;
          assumptions.push(`Unsupported metric replaced with ${DEFAULT_RANK_METRIC}.`);
        } else {
          next.metric = null;
          delete next.filters.metric;
        }
        repaired = true;
        break;

      case 'drop_invalid_year': {
        const years = (next.filters.years || []).filter((y) => y !== action.year && y >= MIN_YEAR && y <= MAX_YEAR);
        next.filters.years = years;
        assumptions.push(`Year ${action.year} looked invalid — using latest available BRSR report year instead.`);
        repaired = true;
        break;
      }

      case 'low_confidence_unknown':
        next.intent = INTENTS.UNKNOWN;
        next.canonicalIntent = 'UNKNOWN';
        repaired = true;
        break;

      case 'replan_from_intent':
        // Intent kept; planner will rebuild strategy/tool on next planQuery call.
        repaired = true;
        break;

      case 'force_sql_metric': {
        // Carbon / structured metric must use SQL, never narrative primary.
        if (next.intent === INTENTS.TOP_METRIC || next.intent === INTENTS.BOTTOM_METRIC) {
          // keep ranking intent
        } else if (next.intent === INTENTS.COMPARE_COMPANIES) {
          delete next.filters.hybridWhy;
        } else {
          next.intent = INTENTS.METRIC_LOOKUP;
          next.canonicalIntent = 'LOOKUP';
        }
        assumptions.push('Structured metric asks use SQL first — corrected narrative routing.');
        repaired = true;
        break;
      }

      case 'force_sql_quantitative': {
        // Never hijack informational / how-to into SQL.
        if (
          next.intent === INTENTS.INFORMATIONAL
          || next.intent === INTENTS.HOW_TO
          || next.filters?.informational
          || next.filters?.guidance
        ) {
          break;
        }
        // Measurable value ask — SQL (lookup/compare), never Narrative first.
        const companies = next.entities?.length
          ? next.entities
          : (memory?.lastCompanies || memory?.entities || memory?.lastPageItems?.slice?.(0, 5) || []);
        if (companies.length && !next.entities?.length) {
          next.entities = [...companies];
        }
        // Preserve year from memory when omitted.
        if (!next.filters.years?.length && memory?.lastYear) {
          next.filters.years = [memory.lastYear];
        }
        // Current message metric wins; do not keep prior metric when a new one was resolved.
        const metric = next.metric || next.filters.metric || null;
        next.intent = quantitativeIntentForCompanies(next.entities, next);
        next.canonicalIntent = next.intent === INTENTS.COMPARE_COMPANIES ? 'COMPARE' : 'LOOKUP';
        delete next.filters.guidance;
        delete next.filters.hybridWhy;
        delete next.filters.informational;
        next.filters.answerType = ANSWER_TYPES.QUANTITATIVE;
        next.filters.followUpCompanies = Boolean(
          memory?.lastCompanies?.length || memory?.lastPageItems?.length,
        );
        if (metric) {
          next.metric = metric;
          next.filters.metric = metric;
        }
        next.confidence = Math.max(next.confidence || 0, 0.92);
        assumptions.push(
          'Quantitative metric request — routing to SQL (not company narrative / initiatives).',
        );
        repaired = true;
        break;
      }

      case 'force_current_metric':
        // Drop stale prior metric from filters when current message named a new one.
        if (next.metric) {
          next.filters.metric = next.metric;
        }
        repaired = true;
        break;

      default:
        break;
    }
  }

  // If user text is clearly guidance, force HOW_TO even if other repairs ran.
  if (isGuidanceQuestion(userMessage) && next.intent !== INTENTS.HOW_TO) {
    next.intent = INTENTS.HOW_TO;
    next.canonicalIntent = 'HOW_TO';
    next.filters.guidance = true;
    repaired = true;
  }

  next.assumptions = [...new Set([...next.assumptions, ...assumptions])];
  return { classification: next, repaired, clarification, assumptions };
}

/**
 * Plan → validate → repair → re-plan at most once.
 * Also attaches Phase 12 planner intelligence score.
 * @returns {{ classification, plan, validation, replanCount, clarification?: string|null, plannerScore?: object }}
 */
export function planAndValidate(classification, memory = null, { userMessage = '' } = {}) {
  let current = {
    ...classification,
    filters: { ...(classification.filters || {}) },
    entities: [...(classification.entities || [])],
    assumptions: [...(classification.assumptions || [])],
  };

  // Phase 9 — low intent confidence → ask clarification instead of guessing.
  const confidence = Number(current.confidence ?? 0);
  if (confidence > 0 && confidence < MIN_CONFIDENCE * 0.7 && current.intent === INTENTS.UNKNOWN) {
    const clarification = 'I am not sure what you need yet. '
      + 'Please name the company (or companies), the metric (for example Scope 1 emissions), '
      + 'and optionally the year.';
    const plan = planQuery(current, memory, { userMessage });
    return {
      classification: current,
      plan,
      validation: {
        ok: false,
        errors: [`Confidence ${confidence} too low to execute`],
        warnings: [],
        repairs: [{ type: 'low_confidence_unknown' }],
        clarification,
      },
      replanCount: 0,
      clarification,
      plannerScore: scorePlan(plan, current, { memory }),
    };
  }

  let plan = planQuery(current, memory, { userMessage });
  let validation = validatePlan(plan, current, { memory, userMessage });
  let replanCount = 0;
  let clarification = null;

  if (!validation.ok) {
    const repair = repairClassification(current, plan, validation, { memory, userMessage });
    clarification = repair.clarification || null;

    if (clarification) {
      return {
        classification: current,
        plan,
        validation: { ...validation, ok: false, clarification },
        replanCount: 0,
        clarification,
        plannerScore: scorePlan(plan, current, { memory, validation }),
      };
    }

    if (repair.repaired) {
      current = repair.classification;
      plan = planQuery(current, memory, { userMessage });
      validation = validatePlan(plan, current, { memory, userMessage });
      replanCount = 1;
    }
  }

  // Phase 12 — reject weak scored plans once (wrong tool / metric path).
  let plannerScore = scorePlan(plan, current, { memory, validation });
  if (validation.ok && isWeakPlanScore(plannerScore) && replanCount < 1) {
    validation = {
      ...validation,
      ok: false,
      errors: [...(validation.errors || []), `Planner score ${plannerScore.score} below threshold`],
      repairs: [...(validation.repairs || []), { type: 'replan_from_intent' }],
    };
    const repair = repairClassification(current, plan, validation, { memory, userMessage });
    if (repair.repaired) {
      current = repair.classification;
      plan = planQuery(current, memory, { userMessage });
      validation = validatePlan(plan, current, { memory, userMessage });
      replanCount = 1;
      plannerScore = scorePlan(plan, current, { memory, validation });
    }
  }

  // After one re-plan, if still invalid for a hard structural reason, surface clarification when possible.
  if (!validation.ok && replanCount >= 1) {
    const stillNeedsCompanies = validation.errors.some((e) => /requires at least/i.test(e));
    if (stillNeedsCompanies && !clarification) {
      clarification = 'I could not build a reliable plan for this question yet. Please name the company (or companies) and metric you care about.';
    }
  }

  const answerType = validation.answerType
    || validation.semantic?.answerType
    || null;
  if (answerType) {
    current = {
      ...current,
      filters: { ...(current.filters || {}), answerType },
    };
    plan = {
      ...plan,
      filters: { ...(plan.filters || {}), answerType },
    };
  }

  return {
    classification: current,
    plan,
    validation,
    replanCount,
    clarification,
    plannerScore,
  };
}

export { MIN_CONFIDENCE, MIN_YEAR, MAX_YEAR };
