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
      text: dedupeChartBlocks(applyTonePolish(String(rendered[0].text).trim(), rendered[0])),
      responseSource: CAPABILITY_META[rendered[0].capability]?.label || 'Copilot',
      capabilitiesUsed: [rendered[0].capability],
    };
  }

  const ordered = [...rendered].sort(
    (a, b) => SECTION_ORDER.indexOf(a.capability) - SECTION_ORDER.indexOf(b.capability),
  );

  const dataCaps = new Set([
    CAPABILITIES.ESG_KNOWLEDGE,
    CAPABILITIES.ESG_COMPLIANCE,
    CAPABILITIES.COMPANY_ANALYTICS,
    CAPABILITIES.BENCHMARKING,
    CAPABILITIES.COMPANY_REPORTS,
  ]);
  const adviceCaps = new Set([
    CAPABILITIES.ESG_GUIDANCE,
    CAPABILITIES.RECOMMENDATION,
    CAPABILITIES.DOCUMENT_GENERATION,
  ]);

  const dataParts = ordered
    .filter((r) => dataCaps.has(r.capability))
    .map((r) => stripComposerNoise(r.text));
  const adviceParts = ordered
    .filter((r) => adviceCaps.has(r.capability))
    .map((r) => stripComposerNoise(r.text));
  const leftover = ordered
    .filter((r) => !dataCaps.has(r.capability) && !adviceCaps.has(r.capability))
    .map((r) => stripComposerNoise(r.text));

  const hybrid = dataParts.length > 0 && adviceParts.length > 0;
  const parts = [];
  if (hybrid) {
    parts.push('Here is a combined view — verified company data first, then practical improvement suggestions.');
  }
  parts.push(...dataParts);
  if (adviceParts.length) {
    const adviceBody = adviceParts.join('\n\n');
    if (!/^###\s/m.test(adviceBody)) {
      parts.push('### What this means', '', adviceBody);
    } else {
      parts.push(adviceBody);
    }
  }
  parts.push(...leftover);

  let text = parts.filter(Boolean).join('\n\n');
  text = dedupeChartBlocks(text);

  return {
    text: applyTonePolish(text, ordered[0]),
    responseSource: 'Copilot',
    capabilitiesUsed: ordered.map((r) => r.capability),
    multi: true,
  };
}

function stripComposerNoise(text) {
  return String(text || '')
    .replace(/^I found the following in verified BRSR data:\s*/i, '')
    .trim();
}

/**
 * Light positive framing — never rewrite numeric tables/cells.
 */
function applyTonePolish(text, result = null) {
  const body = String(text || '').trim();
  if (!body) return body;
  // Already has a structured heading / table — leave facts intact.
  if (/^###\s/m.test(body) || /^\|/m.test(body)) {
    if (/could\s+\*\*not\*\*\s+find|could not find|not available/i.test(body)) {
      return body; // no-data template already framed
    }
    if (
      result?.capability === CAPABILITIES.COMPANY_ANALYTICS
      || result?.capability === CAPABILITIES.BENCHMARKING
    ) {
      if (!/^I found\b/i.test(body) && !/^Here is\b/i.test(body)) {
        return `I found the following in verified BRSR data:\n\n${body}`;
      }
    }
    return body;
  }
  return body;
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
