/**
 * Phase 12 — Hybrid WHY queries.
 *
 * SQL  → verified emissions / metrics
 * RAG  → strategy / GHG narrative snippets
 * Merge → grounded explanation (no invented numbers)
 *
 * Example: "Why is Tata Steel's Scope 1 higher than JSW Steel?"
 */

import { runCompanyCompare } from '../sql-agent/compare-companies.js';
import { retrieveCompanyNarrative } from '../rag/brsr-chunks.js';
import { validateRagEvidence } from '../validation/response-validator.js';
import { INTENTS } from '../intent/classify-intent.js';

export function isHybridWhyQuestion(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (/\b(why|how\s+come|explain\s+why|what\s+makes?|reason\s+for|reason\s+why)\b/i.test(t)) return true;
  if (/\b(higher|lower|greater|less|more|worse|better)\s+than\b/i.test(t) && /\b(why|explain|because|vs|versus)\b/i.test(t)) {
    return true;
  }
  // Comparative causal without explicit "why"
  if (/\b(higher|lower)\s+than\b/i.test(t) && /\b(emission|carbon|scope|ghg|renewable)\b/i.test(t)) {
    return true;
  }
  return false;
}

/**
 * Decide whether this turn should use the hybrid WHY path.
 */
export function shouldRunHybridWhy(classification, userMessage, memory = null) {
  const companies = classification?.entities?.length
    ? classification.entities
    : (memory?.lastCompanies || memory?.entities || []);
  // Only causal WHY questions — not "how much X in above companies" metric lookups.
  const why = Boolean(classification?.filters?.hybridWhy)
    || isHybridWhyQuestion(userMessage)
    || (classification?.intent === INTENTS.FOLLOW_UP && isHybridWhyQuestion(userMessage));

  if (!why) return false;
  if (!companies.length) return false;

  // Need a metric from this turn or memory for SQL grounding.
  const metric = classification?.metric
    || classification?.filters?.metric
    || memory?.lastMetric
    || null;
  return Boolean(metric) || companies.length >= 1;
}

function metricLabel(metric) {
  if (!metric) return 'ESG metric';
  if (metric === 'total_emissions') return 'total GHG emissions (Scope 1+2+3)';
  return String(metric).replace(/_/g, ' ');
}

function formatValue(metric, value) {
  if (value == null || Number.isNaN(Number(value))) return 'n/a';
  const n = Number(value);
  if (/share|intensity/i.test(metric || '')) return n.toFixed(2);
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  return String(n);
}

/**
 * Derive a short SQL-grounded comparison insight (no causal invention).
 */
export function buildSqlInsight({ rows = [], metric, companies = [] }) {
  if (!rows.length || !metric) return null;
  const scored = rows
    .map((r) => ({ company: r.company, year: r.year, value: r[metric] != null ? Number(r[metric]) : null }))
    .filter((r) => r.value != null && !Number.isNaN(r.value));
  if (scored.length < 1) return null;
  scored.sort((a, b) => b.value - a.value);
  const top = scored[0];
  if (scored.length === 1) {
    return `Verified **${metricLabel(metric)}** for **${top.company}** (${top.year}): **${formatValue(metric, top.value)}**.`;
  }
  const second = scored[1];
  const delta = top.value - second.value;
  const pct = second.value !== 0 ? ((delta / Math.abs(second.value)) * 100) : null;
  return [
    `Verified BRSR values show **${top.company}** (${top.year}) at **${formatValue(metric, top.value)}**, `,
    `higher than **${second.company}** (${second.year}) at **${formatValue(metric, second.value)}**`,
    pct != null && Number.isFinite(pct) ? ` (about **${pct.toFixed(1)}%** higher)` : '',
    '.',
    companies.length ? ` Companies in scope: ${companies.slice(0, 3).join(', ')}.` : '',
  ].join('');
}

/**
 * Retrieve narrative snippets per company (strategy / GHG).
 */
export async function retrieveWhyNarratives(companies, {
  userMessage,
  year = null,
  perCompanyLimit = 3,
} = {}) {
  const narratives = [];
  for (const company of companies.slice(0, 3)) {
    const result = await retrieveCompanyNarrative(
      `${userMessage} GHG reduction projects climate strategy emissions`,
      { companyHint: company, year, limit: perCompanyLimit },
    );
    if (result.status === 'ambiguous') {
      narratives.push({
        company,
        status: 'ambiguous',
        message: result.message,
        chunks: [],
      });
      continue;
    }
    const ragCheck = validateRagEvidence({
      chunks: result.chunks || [],
      company: result.company || company,
      minChunks: 1,
    });
    narratives.push({
      company: result.company || company,
      year: result.year || year,
      pdf_url: result.pdf_url || null,
      status: result.status || 'ok',
      chunks: ragCheck.ok ? (result.chunks || []).slice(0, perCompanyLimit) : [],
      ragValidation: ragCheck,
    });
  }
  return narratives;
}

/**
 * Merge SQL + RAG into a deterministic hybrid answer.
 */
export function formatHybridWhyAnswer({
  companies = [],
  metric = null,
  year = null,
  sqlText = '',
  sqlInsight = null,
  narratives = [],
  userMessage = '',
} = {}) {
  const lines = [
    '### Hybrid analysis (SQL + BRSR narrative)',
    '',
    `Question focus: ${userMessage || 'why / comparison'}`,
    '',
    '#### 1) Verified metrics (SQL)',
    '',
  ];

  if (sqlInsight) {
    lines.push(sqlInsight, '');
  }
  if (sqlText) {
    lines.push(sqlText, '');
  } else {
    lines.push('_No verified metric rows were available for this comparison._', '');
  }

  lines.push('#### 2) Disclosure narrative (RAG)', '');

  let narrativeCount = 0;
  for (const n of narratives) {
    if (!n.chunks?.length) {
      lines.push(
        `- **${n.company}**: No indexed qualitative BRSR snippets (strategy / GHG projects) were available`
          + (n.status === 'ambiguous' ? ` — ${n.message || 'ambiguous name'}` : '.') ,
      );
      continue;
    }
    narrativeCount += n.chunks.length;
    lines.push(`- **${n.company}**${n.year ? ` (${n.year})` : ''}:`);
    for (const c of n.chunks.slice(0, 3)) {
      lines.push(`  - *${c.section}*: ${c.text}`);
    }
    if (n.pdf_url) lines.push(`  - PDF: [source](${n.pdf_url})`);
  }

  if (!narratives.length) {
    lines.push('_No company narrative context retrieved._');
  }

  lines.push(
    '',
    '#### 3) Grounded takeaway',
    '',
  );

  if (sqlInsight && narrativeCount > 0) {
    lines.push(
      'The **numeric difference** above comes only from the structured BRSR `reports` table. ',
      'The narrative snippets are what those companies disclosed about climate / GHG efforts — ',
      'they may help interpret drivers, but they are not a substitute for the SQL values, ',
      'and they do not by themselves prove causality.',
    );
  } else if (sqlInsight) {
    lines.push(
      'Numeric comparison is grounded in SQL. ',
      'Qualitative “why” drivers were not found in indexed BRSR narrative fields for these companies.',
    );
  } else if (narrativeCount > 0) {
    lines.push(
      'Narrative disclosures were found, but verified metric rows were incomplete — ',
      'so no numeric ranking/comparison is claimed.',
    );
  } else {
    lines.push(
      'I could not assemble enough verified SQL metrics and BRSR narrative evidence for a reliable hybrid answer.',
    );
  }

  lines.push(
    '',
    `_Metric: ${metricLabel(metric)}${year ? ` · Year filter: ${year}` : ' · Year: latest available per company where needed'}._`,
    `_Companies: ${companies.slice(0, 3).join(', ') || 'n/a'}._`,
  );

  return lines.join('\n');
}

/**
 * End-to-end hybrid WHY execution.
 * @returns {{ ok: boolean, text?: string, data?: object, error?: string }}
 */
export async function runHybridWhy({
  companies = [],
  metric = null,
  year = null,
  userMessage = '',
  metrics = null,
} = {}) {
  const useMetric = metric || (Array.isArray(metrics) ? metrics[0] : null) || 'total_emissions';
  const useMetrics = Array.isArray(metrics) && metrics.length ? metrics : [useMetric];
  const uniqueCompanies = [...new Set(companies.map((c) => String(c || '').trim()).filter(Boolean))].slice(0, 3);

  if (!uniqueCompanies.length) {
    return { ok: false, error: 'hybrid_why_needs_companies' };
  }

  const compare = await runCompanyCompare({
    entities: uniqueCompanies,
    metrics: useMetrics,
    year,
    wantsChart: false,
  });

  const narratives = await retrieveWhyNarratives(uniqueCompanies, {
    userMessage,
    year,
    perCompanyLimit: 3,
  });

  const rows = compare.data?.rows || [];
  const sqlInsight = buildSqlInsight({ rows, metric: useMetric, companies: uniqueCompanies });
  const text = formatHybridWhyAnswer({
    companies: uniqueCompanies,
    metric: useMetric,
    year,
    sqlText: compare.ok ? compare.text : '',
    sqlInsight,
    narratives,
    userMessage,
  });

  const hasSql = Boolean(compare.ok && rows.length);
  const hasRag = narratives.some((n) => n.chunks?.length);
  if (!hasSql && !hasRag) {
    return {
      ok: false,
      error: 'hybrid_why_no_evidence',
      text,
      data: { compare, narratives },
    };
  }

  return {
    ok: true,
    text,
    data: {
      compare,
      narratives,
      rows,
      metric: useMetric,
      year,
      companies: uniqueCompanies,
      sqlInsight,
      hasSql,
      hasRag,
    },
  };
}
