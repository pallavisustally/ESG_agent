/**
 * Chart response composer — standard user-facing structure for visualization answers.
 *
 * Summary → Chart → Key Insights → Observations → Recommendations (optional) → Sources
 */

import { formatInsightMarkdown } from './chart-insights.js';

/**
 * @typedef {Object} ChartResponseSections
 * @property {string} summary
 * @property {string} chart
 * @property {string} keyInsights
 * @property {string} observations
 * @property {string} recommendations
 * @property {string} sources
 * @property {string} omitNotice
 */

/**
 * Build structured sections from an engine result + optional surrounding text.
 * @param {Object} input
 * @returns {ChartResponseSections & { markdown: string }}
 */
export function composeChartResponse(input = {}) {
  const {
    summary = '',
    chartBlock = '',
    insights = [],
    insightMarkdown = '',
    observations = '',
    recommendations = '',
    sources = '',
    omitReason = null,
    omitMessage = null,
    ok = true,
  } = input;

  const sections = {
    summary: String(summary || '').trim(),
    chart: ok && chartBlock ? String(chartBlock).trim() : '',
    keyInsights: '',
    observations: String(observations || '').trim(),
    recommendations: String(recommendations || '').trim(),
    sources: String(sources || '').trim(),
    omitNotice: '',
  };

  if (ok) {
    if (insightMarkdown) {
      sections.keyInsights = String(insightMarkdown).trim();
    } else if (insights?.length) {
      sections.keyInsights = formatInsightMarkdown(insights).trim();
    }
  } else if (omitMessage || omitReason) {
    sections.omitNotice = omitMessage
      || userFacingOmitMessage(omitReason)
      || 'A chart could not be generated for this data.';
  }

  const markdown = joinSections(sections);
  return { ...sections, markdown };
}

/**
 * Append visualization sections after an existing summary/body (SQL formatter style).
 * Preserves backward-compatible ordering: body, chart, insights (+ optional observations/sources).
 * Failed charts stay silent unless `showOmitNotice: true` (avoids changing SQL UX).
 */
export function appendVisualizationToText(body, vizResult = {}, extras = {}) {
  const summary = String(body || '').trim();
  if (!vizResult?.ok) {
    if (!extras.showOmitNotice) return summary;
    return composeChartResponse({
      summary,
      ok: false,
      omitReason: vizResult.reason || vizResult.omitReason,
      omitMessage: vizResult.omitMessage,
      recommendations: extras.recommendations || '',
      sources: extras.sources || '',
    }).markdown;
  }

  return composeChartResponse({
    summary,
    ok: true,
    chartBlock: vizResult.chartBlock,
    insights: vizResult.insights,
    insightMarkdown: vizResult.insightMarkdown,
    observations: vizResult.observations || extras.observations || '',
    recommendations: extras.recommendations || '',
    sources: extras.sources || '',
  }).markdown;
}

/**
 * Deduplicate json-chart fences when merging multi-capability answers.
 * Keeps the first valid-looking fence; strips later duplicates with identical JSON.
 */
export function dedupeChartBlocks(text) {
  const re = /```json-chart\s*([\s\S]*?)\s*```/gi;
  const seen = new Set();
  let firstKept = false;
  return String(text || '').replace(re, (full, body) => {
    const key = String(body || '').replace(/\s+/g, ' ').trim();
    if (seen.has(key) || (firstKept && seen.size > 0 && key)) {
      if (seen.has(key)) return '';
    }
    seen.add(key);
    firstKept = true;
    return full;
  }).replace(/\n{3,}/g, '\n\n');
}

export function userFacingOmitMessage(reason) {
  switch (reason) {
    case 'empty_rows':
    case 'empty_dataset':
    case 'insufficient_data':
      return 'Not enough data points to draw a reliable chart.';
    case 'empty_labels':
      return 'Chart omitted because category labels were missing.';
    case 'no_metrics':
      return 'Chart omitted because no numeric metrics were available.';
    case 'all_null':
      return 'Chart omitted because all metric values were empty.';
    case 'single_value':
      return 'A single data point is shown in text only — charts need multiple values.';
    case 'validation_failed':
      return 'Chart omitted because the data did not pass validation (for example mismatched series or duplicate labels).';
    case 'no_chart':
      return 'A chart is not appropriate for this result.';
    default:
      return reason ? `Chart omitted (${reason}).` : null;
  }
}

function joinSections(sections) {
  const parts = [];
  if (sections.summary) parts.push(sections.summary);
  if (sections.omitNotice) parts.push(sections.omitNotice);
  if (sections.chart) parts.push(sections.chart);
  if (sections.keyInsights) parts.push(sections.keyInsights);
  if (sections.observations) {
    parts.push(sections.observations.startsWith('**')
      ? sections.observations
      : ['**Observations**', sections.observations].join('\n'));
  }
  if (sections.recommendations) {
    parts.push(sections.recommendations.startsWith('#') || sections.recommendations.startsWith('**')
      ? sections.recommendations
      : ['**Recommendations**', sections.recommendations].join('\n'));
  }
  if (sections.sources) {
    parts.push(sections.sources.startsWith('#') || sections.sources.startsWith('**')
      ? sections.sources
      : ['**Sources**', sections.sources].join('\n'));
  }
  return parts.filter(Boolean).join('\n\n').trim();
}
