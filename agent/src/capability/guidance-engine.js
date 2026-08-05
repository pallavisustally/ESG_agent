/**
 * ESG Guidance Engine — best-practice recommendations by topic.
 * Extends carbon-only guidance to water, waste, diversity, ESG score, Net Zero.
 */

import { buildCarbonControlGuidance } from '../answers/carbon-guidance.js';

const TOPICS = [
  {
    id: 'carbon',
    match: /\b(carbon|ghg|emission|emissions|scope\s*[123]|climate|decarbon)\b/i,
    title: 'How to reduce carbon emissions',
    levers: [
      'Establish a GHG inventory (Scope 1/2/3) and set science-aligned reduction targets',
      'Improve energy efficiency and electrify high-emission processes',
      'Increase renewable electricity (on-site, PPAs, green tariffs)',
      'Switch fuels and cut fugitive / process emissions for Scope 1',
      'Engage suppliers and logistics partners on Scope 3 hotspots',
      'Disclose progress in BRSR (`ghg_reduction_projects`) and link CapEx to the transition plan',
    ],
  },
  {
    id: 'water',
    match: /\bwater\b/i,
    title: 'How to reduce water consumption',
    levers: [
      'Map water withdrawal, consumption, and discharge by site and basin stress',
      'Fix leaks, optimize cooling/process water, and install low-flow fixtures',
      'Increase recycling / reuse (ZTLD where feasible) and rainwater harvesting',
      'Engage high-water suppliers and set intensity targets',
      'Disclose BRSR water metrics and watershed stewardship actions',
    ],
  },
  {
    id: 'waste',
    match: /\bwaste\b/i,
    title: 'How to reduce waste',
    levers: [
      'Measure waste by stream (hazardous / non-hazardous / plastic / e-waste)',
      'Redesign packaging and processes for less material intensity',
      'Maximize reuse, recycling, and co-processing; divert from landfill',
      'Set supplier take-back and recycled-content requirements',
      'Publish waste management practices and diversion rates in BRSR narratives',
    ],
  },
  {
    id: 'diversity',
    match: /\b(diversity|inclusion|dei|gender|female\s+employ|women\s+in|board\s+diversity)\b/i,
    title: 'How to improve diversity & inclusion',
    levers: [
      'Set measurable representation goals (hiring, promotion, leadership, board)',
      'Audit pay equity and remove biased screening criteria',
      'Expand inclusive hiring pipelines and returnship / caregiving policies',
      'Train managers on inclusive leadership; track attrition by demographic',
      'Disclose workforce and board diversity metrics consistently in BRSR',
    ],
  },
  {
    id: 'esg_score',
    match: /\besg\s+score\b|\bimprove\s+esg\b/i,
    title: 'How to improve ESG performance / score',
    levers: [
      'Close disclosure gaps — complete, assured, year-comparable metrics beat sparse narratives',
      'Prioritize material topics from a fresh materiality assessment',
      'Reduce environmental intensity (emissions, water, waste, energy)',
      'Strengthen social programs (safety, diversity, community) with KPIs',
      'Improve governance (board oversight, ethics, ESG-linked incentives)',
      'Benchmark peers and fix the largest negative gaps first',
    ],
  },
  {
    id: 'circular',
    match: /\b(circular\s+economy|circularity|reuse|recycle|closed[- ]loop)\b/i,
    title: 'How to advance circular economy practices',
    levers: [
      'Map material flows and identify waste hotspots by product / site',
      'Redesign products for durability, repairability, and recycled content',
      'Launch take-back, remanufacturing, or packaging reuse programs',
      'Set supplier circularity requirements and track diversion from landfill',
      'Disclose circularity KPIs alongside BRSR waste indicators',
    ],
  },
  {
    id: 'net_zero',
    match: /\b(carbon\s+neutral|net\s*zero|climate\s+neutral)\b/i,
    title: 'How to become carbon neutral / Net Zero',
    levers: [
      'Measure a complete baseline and set near-term + Net Zero targets',
      'Build a transition plan with absolute reduction levers before offsets',
      'Decarbonize operations (efficiency, renewables, process change)',
      'Address value-chain Scope 3 with procurement standards',
      'Use high-quality removals/offsets only for residual hard-to-abate emissions',
      'Report progress annually (BRSR + climate frameworks) with clear boundaries',
    ],
  },
];

function detectTopics(text) {
  const hits = TOPICS.filter((t) => t.match.test(text));
  if (hits.length) return hits;
  // Default general ESG improvement guidance.
  return [TOPICS.find((t) => t.id === 'esg_score')];
}

function formatTopicGuidance(topic) {
  const lines = [`### ${topic.title}`, ''];
  topic.levers.forEach((lever, i) => {
    lines.push(`${i + 1}. ${lever}`);
  });
  lines.push('');
  return lines.join('\n');
}

/**
 * Build topic-aware sustainability guidance.
 * Carbon questions still enrich with BRSR sample disclosures via the existing builder.
 */
export async function buildGuidanceAnswer(userMessage = '') {
  const text = String(userMessage || '');
  const topics = detectTopics(text);
  const carbonOnly = topics.length === 1 && topics[0].id === 'carbon';

  if (carbonOnly) {
    return buildCarbonControlGuidance(text);
  }

  const parts = [
    '### Sustainability guidance',
    '',
    'Practical levers you can apply (framework-aligned best practices):',
    '',
  ];

  for (const topic of topics) {
    if (topic.id === 'carbon') {
      // Keep carbon section concise here; full BRSR examples available via carbon builder.
      parts.push(formatTopicGuidance(topic));
    } else {
      parts.push(formatTopicGuidance(topic));
    }
  }

  parts.push(
    'For company-specific advice with verified BRSR numbers, name the company — e.g. “Suggest how Infosys can improve its ESG score.”',
    '',
    '_Guidance answer — best practices and framework knowledge; not a company SQL lookup unless you ask for one._',
  );

  // If carbon is among multiple topics, append BRSR-grounded carbon examples.
  if (topics.some((t) => t.id === 'carbon')) {
    try {
      const carbon = await buildCarbonControlGuidance(text);
      parts.push('', '---', '', carbon);
    } catch {
      // ignore enrichment failure
    }
  }

  return parts.join('\n');
}
