/**
 * Recommendation Engine — company-specific levers grounded in verified analytics.
 *
 * Rules:
 * - Prefer levers tied to verified facts (analytics / peers / sector).
 * - If no company-specific facts exist, clearly label advice as general guidance.
 * - Never invent metric values.
 */

import { buildGuidanceAnswer } from './guidance-engine.js';
import {
  buildRecommendationGrounding,
  fetchSectorBenchmark,
  formatFactsSummary,
  groundedLeverFromFact,
  GENERAL_GUIDANCE_BANNER,
} from './recommendation-grounding.js';

function inferFocusTopics(userMessage = '', dataContext = null, metric = null) {
  const t = String(userMessage || '');
  const topics = [];
  if (/\b(water)\b/i.test(t)) topics.push('water');
  if (/\b(waste)\b/i.test(t)) topics.push('waste');
  if (/\b(diversity|female|gender|inclusion|dei)\b/i.test(t)) topics.push('diversity');
  if (/\b(esg\s+score|improve\s+esg)\b/i.test(t)) topics.push('esg_score');
  if (/\b(net\s*zero|carbon\s+neutral)\b/i.test(t)) topics.push('net_zero');
  if (/\b(carbon|ghg|emission|scope\s*[123]|climate)\b/i.test(t)) topics.push('carbon');

  if (metric) {
    if (/emission|scope|carbon|renewable|energy/i.test(metric)) topics.push('carbon');
    if (/water/i.test(metric)) topics.push('water');
    if (/waste/i.test(metric)) topics.push('waste');
    if (/female|board|employee_share/i.test(metric)) topics.push('diversity');
  }

  if (!topics.length) {
    const blob = JSON.stringify(dataContext || {}).toLowerCase();
    if (/water/.test(blob)) topics.push('water');
    if (/waste/.test(blob)) topics.push('waste');
    if (/female|diversity|board/.test(blob)) topics.push('diversity');
    if (/emission|scope|ghg|carbon/.test(blob)) topics.push('carbon');
    if (!topics.length) topics.push('esg_score');
  }
  return [...new Set(topics)];
}

function guidanceQuestionForTopics(topics) {
  if (topics.includes('carbon') && topics.length === 1) return 'How can I reduce carbon emissions?';
  if (topics.includes('water')) return 'How can I reduce water consumption?';
  if (topics.includes('waste')) return 'How can I reduce waste?';
  if (topics.includes('diversity')) return 'How do I improve diversity?';
  if (topics.includes('net_zero')) return 'How can my company become carbon neutral?';
  return 'How do I improve ESG score?';
}

function extractGuidanceLevers(guidanceText, limit = 6) {
  const lines = String(guidanceText || '')
    .split('\n')
    .filter((ln) => /^\d+\.\s/.test(ln.trim()))
    .map((ln) => ln.replace(/^\d+\.\s*/, '').trim())
    .filter(Boolean);
  return lines.slice(0, limit);
}

/**
 * @param {string} userMessage
 * @param {{
 *   companies?: string[],
 *   dataText?: string|null,
 *   metric?: string|null,
 *   analyticsData?: object|null,
 *   peerData?: object|null,
 *   sectorData?: object|null,
 *   fetchSector?: boolean,
 * }} [ctx]
 * @returns {Promise<{ text: string, grounding: object, assumptions: string[] }>}
 */
export async function buildRecommendationAnswer(userMessage = '', ctx = {}) {
  const companies = ctx.companies || [];
  const companyLabel = companies.length
    ? companies.join(' and ')
    : (/\bmy\s+company\b/i.test(userMessage) ? 'your company' : 'the company');
  const metric = ctx.metric || ctx.analyticsData?.metric || null;
  const topics = inferFocusTopics(userMessage, ctx.dataText || ctx.analyticsData, metric);

  let sectorData = ctx.sectorData || null;
  if (
    !sectorData
    && ctx.fetchSector !== false
    && companies.length === 1
    && metric
  ) {
    sectorData = await fetchSectorBenchmark({
      company: companies[0],
      metric,
      year: ctx.analyticsData?.year ?? null,
    });
  }

  const peerData = ctx.peerData
    || (Array.isArray(ctx.analyticsData?.rows) && ctx.analyticsData.rows.length >= 2
      ? ctx.analyticsData
      : null);

  const grounding = buildRecommendationGrounding({
    analyticsData: ctx.analyticsData || null,
    peerData,
    sectorData,
    companies,
    metric,
  });

  const guidance = await buildGuidanceAnswer(guidanceQuestionForTopics(topics));
  const generalLevers = extractGuidanceLevers(guidance, 6);

  const lines = [
    `### Recommendations for ${companyLabel}`,
    '',
  ];
  const assumptions = [];

  const factsSummary = formatFactsSummary(grounding.facts);
  if (factsSummary) {
    lines.push('**Verified BRSR figures used for these recommendations**', factsSummary, '');
  }

  if (grounding.companySpecific) {
    lines.push(
      'Based on verified BRSR analytics'
      + (sectorData ? ' and sector benchmarks' : '')
      + (peerData ? ' / peer comparison' : '')
      + ', prioritize:',
      '',
    );
    const grounded = grounding.facts.slice(0, 5).map((f, i) => `${i + 1}. ${groundedLeverFromFact(f)}`);
    lines.push(...grounded, '');

    // Supplement with general levers for topics not covered by facts
    const uncovered = topics.filter((t) => !grounding.groundedTopics.has(t));
    if (uncovered.length && generalLevers.length) {
      lines.push(
        '**Additional general guidance** (not tied to a verified company figure for this topic):',
        '',
      );
      generalLevers.slice(0, 3).forEach((lever, i) => {
        lines.push(`${i + 1}. ${lever}`);
      });
      lines.push('');
      assumptions.push('Some levers are general best practice and not tied to a verified company metric.');
    }
  } else {
    const banner = companies.length
      ? GENERAL_GUIDANCE_BANNER.replace(
        'this company',
        `**${companies.join(' / ')}**`,
      )
      : GENERAL_GUIDANCE_BANNER;
    lines.push(`_${banner}_`, '');
    assumptions.push(banner);

    lines.push('General sustainability improvement actions:', '');
    if (generalLevers.length) {
      generalLevers.forEach((lever, i) => {
        lines.push(`${i + 1}. ${lever}`);
      });
    } else {
      lines.push(
        '1. Close disclosure gaps with complete, year-comparable BRSR metrics',
        '2. Set science-aligned targets on material environmental topics',
        '3. Improve workforce diversity, safety, and governance oversight',
        '4. Benchmark peers and fix the largest negative gaps first',
      );
    }
    lines.push('');
  }

  if (companies.length === 1) {
    lines.push(
      `Suggested follow-ups: “What are ${companies[0]} Scope 1 emissions?” · “How does ${companies[0]} compare to sector peers?”`,
      '',
    );
  }

  lines.push(
    grounding.companySpecific
      ? '_Recommendations are limited to actions supported by verified BRSR analytics (and sector/peer benchmarks when available)._'
      : '_Ask for a company metric or comparison if you want recommendations grounded in reported numbers._',
  );

  return {
    text: lines.join('\n'),
    grounding,
    assumptions,
  };
}
