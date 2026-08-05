/**
 * Response Composer — merge multi-capability outputs into one coherent user-facing answer.
 *
 * Never exposes SQL, planner, PDF tooling, or internal routing labels.
 *
 * Chart-bearing answers follow:
 *   Summary → Chart → Key Insights → Observations → Recommendations → Sources
 */

import { CAPABILITIES, CAPABILITY_META } from './capabilities.js';
import {
  composeChartResponse,
  dedupeChartBlocks,
  appendVisualizationToText,
} from '../visualization/index.js';

const SECTION_ORDER = [
  CAPABILITIES.ESG_KNOWLEDGE,
  CAPABILITIES.ESG_COMPLIANCE,
  CAPABILITIES.COMPANY_ANALYTICS,
  CAPABILITIES.BENCHMARKING,
  CAPABILITIES.COMPANY_REPORTS,
  CAPABILITIES.ESG_GUIDANCE,
  CAPABILITIES.RECOMMENDATION,
  CAPABILITIES.DOCUMENT_GENERATION,
];

/**
 * @typedef {{
 *   capability: string,
 *   text: string,
 *   ok?: boolean,
 *   source?: string,
 *   visualization?: object,
 *   recommendations?: string,
 *   sources?: string,
 *   observations?: string,
 * }} CapabilityResult
 */

/**
 * Compose capability results into a single markdown response.
 * @param {CapabilityResult[]} results
 * @param {{ userMessage?: string, multi?: boolean }} [opts]
 */
export function composeCapabilityResults(results = [], opts = {}) {
  const usable = (results || []).filter((r) => r && (String(r.text || '').trim() || r.visualization));
  if (!usable.length) {
    return {
      text: 'I could not produce an answer for that sustainability question. Try rephrasing, or name a company if you need verified BRSR data.',
      responseSource: 'Composer',
    };
  }

  const rendered = usable.map((r) => ({
    ...r,
    text: renderCapabilityText(r),
  })).filter((r) => String(r.text || '').trim());

  if (!rendered.length) {
    return {
      text: 'I could not produce an answer for that sustainability question. Try rephrasing, or name a company if you need verified BRSR data.',
      responseSource: 'Composer',
    };
  }

  if (rendered.length === 1) {
    return {
      text: dedupeChartBlocks(String(rendered[0].text).trim()),
      responseSource: CAPABILITY_META[rendered[0].capability]?.label || 'Copilot',
      capabilitiesUsed: [rendered[0].capability],
    };
  }

  // Multi-capability: ordered sections with light headings (user-facing labels only).
  const ordered = [...rendered].sort(
    (a, b) => SECTION_ORDER.indexOf(a.capability) - SECTION_ORDER.indexOf(b.capability),
  );

  const parts = [];
  for (const r of ordered) {
    parts.push(String(r.text).trim());
  }

  let text = parts.join('\n\n---\n\n');
  text = dedupeChartBlocks(text);

  // Soft intro only for hybrid analytics + advice patterns.
  const caps = setOf(ordered.map((r) => r.capability));
  const hybrid = (caps.has(CAPABILITIES.COMPANY_ANALYTICS) || caps.has(CAPABILITIES.BENCHMARKING))
    && (caps.has(CAPABILITIES.RECOMMENDATION) || caps.has(CAPABILITIES.ESG_GUIDANCE));
  if (hybrid) {
    text = [
      'Here is a combined view — verified company data first, then practical improvement suggestions.',
      '',
      text,
    ].join('\n');
  }

  return {
    text,
    responseSource: 'Copilot',
    capabilitiesUsed: ordered.map((r) => r.capability),
    multi: true,
  };
}

/**
 * Render one capability result, applying chart response structure when a viz payload is present.
 */
function renderCapabilityText(result) {
  if (result?.visualization) {
    const viz = result.visualization;
    const summary = String(result.text || '').trim();
    return appendVisualizationToText(summary, viz, {
      observations: result.observations || viz.observations || '',
      recommendations: result.recommendations || '',
      sources: result.sources || '',
    });
  }

  // If text already contains a chart fence, leave structure intact (SQL path).
  return String(result?.text || '').trim();
}

/**
 * Explicit helper for analytics engines that already have a viz engine result.
 */
export function composeVisualizationAnswer({
  summary = '',
  visualization = null,
  observations = '',
  recommendations = '',
  sources = '',
} = {}) {
  if (!visualization) {
    return composeChartResponse({
      summary,
      ok: false,
      omitReason: 'no_chart',
      recommendations,
      sources,
      observations,
    }).markdown;
  }
  return appendVisualizationToText(summary, visualization, {
    observations: observations || visualization.observations || '',
    recommendations,
    sources,
  });
}

/**
 * Strip accidental internal jargon if a capability leaked it.
 * Defense-in-depth — engines should already avoid this.
 */
export function sanitizeUserFacingText(text) {
  return String(text || '')
    .replace(/\b(primaryTool|deterministic_sql|planQuery|routeTools)\b/gi, '')
    .replace(/\bSELECT\s+[\s\S]{0,200}?FROM\s+reports\b/gi, '[verified database result]')
    .trim();
}

function setOf(list) {
  return new Set(list);
}
