/**
 * ESG Knowledge Engine — glossary, concepts, and topic validation.
 *
 * Intent classification only detects definition QUESTION TYPE.
 * This engine decides whether the requested concept can be answered.
 */

import { findInformationalDefinition } from '../answers/informational.js';
import {
  useFrameworkRegistry,
  lookupRegistry,
  formatRegistryAnswer,
} from '../knowledge/framework-registry.js';

const KNOWLEDGE_FOOTER =
  '_ESG knowledge answer — general concept explanation, not a company database lookup._';

/** Legacy glossary kept for USE_FRAMEWORK_REGISTRY=false rollback. */
const LEGACY_GLOSSARY = [
  {
    match: /\bmetrics?\b/i,
    title: 'Metric',
    body: [
      'A **metric** is a measurable indicator used to track performance.',
      '',
      'In ESG / BRSR contexts, metrics are quantitative fields such as:',
      '- **Environmental** — Scope 1/2/3 emissions, renewable energy share, water consumption, waste generated',
      '- **Social** — female employee share, board diversity, safety (LTIFR), total employees',
      '- **Governance / economic** — board composition indicators, revenue (when used alongside ESG analysis)',
      '',
      'This Copilot can look up reported metric **values** when you name a company (and optionally a year), e.g. “What are Infosys Scope 1 emissions in 2024?”',
      '',
      'Ask “What is Scope 1?” if you want a definition of a specific metric.',
    ].join('\n'),
  },
  {
    match: /\bbiodiversity\b/i,
    title: 'Biodiversity',
    body: [
      '**Biodiversity** is the variety of life on Earth — genes, species, and ecosystems.',
      '',
      'For companies, biodiversity risk covers how operations affect habitats, species, and natural capital (e.g. land use, water, pollution, supply-chain commodities).',
      '',
      'Emerging disclosure practice includes TNFD-aligned nature risk assessment and BRSR narrative on ecological impacts and restoration projects.',
    ].join('\n'),
  },
  {
    match: /\b(double\s+)?materiality\b/i,
    title: 'Materiality',
    body: [
      '**Materiality** identifies which ESG topics matter most for a company and its stakeholders.',
      '',
      '- **Financial materiality** — topics that affect enterprise value (risks/opportunities)',
      '- **Impact materiality** — topics where the company significantly affects people or the environment',
      '- **Double materiality** — both lenses together (central to CSRD/ESRS)',
      '',
      'A materiality assessment typically surveys stakeholders, maps impacts, and prioritizes topics for strategy and disclosure.',
    ].join('\n'),
  },
  {
    match: /\b(carbon\s+neutral|carbon\s+neutrality)\b/i,
    title: 'Carbon neutrality',
    body: [
      '**Carbon neutrality** means balancing residual GHG emissions with an equivalent amount of carbon removals or high-quality offsets for a defined boundary and period.',
      '',
      'Best practice: measure → reduce first → neutralize residuals → disclose assumptions.',
      '',
      'It is related to, but not identical with, **Net Zero** (which usually requires deep absolute reductions aligned to 1.5°C pathways, with limited neutralization of hard-to-abate residuals).',
    ].join('\n'),
  },
  {
    match: /\bnet\s*zero\b/i,
    title: 'Net Zero',
    body: [
      '**Net Zero** means reducing GHG emissions to as close to zero as possible, with any remaining hard-to-abate emissions balanced by durable removals.',
      '',
      'Common elements of a credible Net Zero approach:',
      '1. Science-based near- and long-term targets (e.g. SBTi)',
      '2. Absolute Scope 1/2 reductions and Scope 3 engagement',
      '3. Transition plan with capital allocation and governance',
      '4. Transparent progress reporting (BRSR / TCFD / ISSB-aligned)',
    ].join('\n'),
  },
  {
    match: /\b(greenwashing)\b/i,
    title: 'Greenwashing',
    body: [
      '**Greenwashing** is misleading communication that overstates environmental or ESG performance.',
      '',
      'Red flags: vague claims without data, selective metrics, unverified offsets, or targets without a transition plan.',
      '',
      'Strong practice: use verified metrics, clear boundaries, third-party assurance where required, and consistent year-over-year disclosure.',
    ].join('\n'),
  },
  {
    match: /\b(circular\s+economy)\b/i,
    title: 'Circular economy',
    body: [
      'A **circular economy** designs out waste and keeps materials in use through reuse, repair, remanufacturing, and recycling — instead of a linear take-make-dispose model.',
      '',
      'Company levers: product redesign, take-back programs, recycled content, waste diversion, and supplier circularity requirements.',
    ].join('\n'),
  },
  {
    match: /\b(science[- ]based\s+targets?|sbti)\b/i,
    title: 'Science-based targets (SBTi)',
    body: [
      '**Science-based targets** are GHG reduction targets aligned with climate science pathways that limit warming (commonly 1.5°C).',
      '',
      'The **SBTi** (Science Based Targets initiative) provides methods and validation for corporate near-term and Net Zero targets across Scope 1, 2, and (where material) Scope 3.',
    ].join('\n'),
  },
  {
    match: /\b(carbon\s+footprint)\b/i,
    title: 'Carbon footprint',
    body: [
      'A **carbon footprint** is the total GHG emissions associated with an entity, product, or activity, usually expressed in tCO₂e.',
      '',
      'Organizational footprints commonly follow the GHG Protocol and are split into Scope 1, Scope 2, and Scope 3.',
    ].join('\n'),
  },
  {
    match: /\b(esg\s+score)\b/i,
    title: 'ESG score',
    body: [
      'An **ESG score** is a third-party or internal rating that summarizes environmental, social, and governance performance.',
      '',
      'Scores vary by methodology (weights, data sources, controversies). Improving a score usually means strengthening disclosures, reducing material risks (emissions, safety, governance), and closing peer gaps — not optimizing a single vanity metric.',
    ].join('\n'),
  },
  {
    match: /\bgri\b(?!\s*\d)/i,
    title: 'GRI',
    body: [
      '**GRI** (Global Reporting Initiative) is a widely used sustainability reporting framework with topic standards (e.g. GRI 305 Emissions, GRI 303 Water).',
      '',
      'Companies use GRI to structure impact-focused disclosures. In India, BRSR often overlaps thematically with GRI topics even when the filing format differs.',
    ].join('\n'),
  },
  {
    match: /\b(eid|essential\s+indicators?)\b/i,
    title: 'Essential Indicators (EID)',
    body: [
      'In **BRSR**, **Essential Indicators** are mandatory disclosure items that listed companies must report under each of the nine NGRBC principles.',
      '',
      'They sit alongside **Leadership Indicators** (more advanced / voluntary-leaning practices). Essential Indicators typically cover core policies, quantitative ESG metrics, and governance processes regulators expect as a baseline.',
      '',
      'Ask about a specific BRSR principle (e.g. “Explain BRSR Principle 6”) for the themes those indicators cover.',
    ].join('\n'),
  },
  {
    match: /\b(sdgs?|sustainable\s+development\s+goals?)\b/i,
    title: 'Sustainable Development Goals (SDGs)',
    body: [
      'The **UN Sustainable Development Goals (SDGs)** are 17 global goals adopted in 2015 covering poverty, climate, equality, clean energy, responsible consumption, and more.',
      '',
      'Companies often map BRSR / GRI disclosures to relevant SDGs to show how operations contribute to (or risk undermining) those goals. Mapping should be evidence-based — not logo washing.',
    ].join('\n'),
  },
  {
    match: /\b(transition\s+plan|climate\s+transition)\b/i,
    title: 'Climate transition plan',
    body: [
      'A **climate transition plan** explains how an organization will align its business model with a low-carbon pathway (often 1.5°C / Net Zero).',
      '',
      'Credible plans typically include targets, CapEx/OpEx alignment, governance, Scope 1/2/3 levers, and progress metrics — not only aspirational statements.',
    ].join('\n'),
  },
  {
    match: /\b(scope\s*3|value[- ]chain\s+emissions)\b/i,
    title: 'Scope 3 emissions',
    body: [
      '**Scope 3** covers indirect GHG emissions in a company’s value chain (upstream and downstream) that are not Scope 1 or Scope 2 — e.g. purchased goods, logistics, use of sold products, investments.',
      '',
      'For many sectors Scope 3 dominates the footprint. BRSR and GRI 305 ask companies to disclose material Scope 3 categories with methodology notes.',
    ].join('\n'),
  },
];

/**
 * Extract a short topic phrase from a definition-style question for clarifications.
 */
export function extractKnowledgeTopic(userMessage = '') {
  const t = String(userMessage || '').trim();
  const patterns = [
    /\bwhat\s+(?:is|are)\s+(?:a|an|the)?\s*(.+?)[?.!]*$/i,
    /\b(?:explain|define|describe)\s+(.+?)[?.!]*$/i,
    /\b(?:meaning|definition)\s+of\s+(.+?)[?.!]*$/i,
    /\btell\s+me\s+about\s+(.+?)[?.!]*$/i,
    /\bdifference\s+between\s+(.+?)[?.!]*$/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m?.[1]) {
      return m[1].replace(/\s+/g, ' ').trim().replace(/[?.!]+$/, '');
    }
  }
  return t.replace(/[?.!]+$/, '').trim() || 'that concept';
}

/**
 * Look up a known concept. Returns null when the topic is unknown.
 * Intent classification must not gate on this — only the knowledge engine does.
 */
export function lookupKnowledge(userMessage = '') {
  const text = String(userMessage || '');

  if (useFrameworkRegistry()) {
    // Prefer concepts; allow dual-surface frameworks (BRSR, GRI overview)
    const concept = lookupRegistry(text, { kind: 'concept' });
    if (concept) {
      return {
        known: true,
        title: concept.title,
        body: concept.body,
        source: 'registry',
        entry: concept,
      };
    }
    const dual = lookupRegistry(text, { knowledgeSurface: true });
    if (dual) {
      return {
        known: true,
        title: dual.title,
        body: dual.body,
        source: 'registry',
        entry: dual,
      };
    }
  } else {
    for (const entry of LEGACY_GLOSSARY) {
      if (entry.match.test(text)) {
        return {
          known: true,
          title: entry.title,
          body: entry.body,
          source: 'glossary',
        };
      }
    }
  }

  const legacy = findInformationalDefinition(text);
  if (legacy) {
    return {
      known: true,
      title: legacy.title,
      body: legacy.body,
      source: 'informational',
    };
  }
  return {
    known: false,
    topic: extractKnowledgeTopic(text),
    source: null,
  };
}

function formatKnownAnswer(entry) {
  if (entry.entry && useFrameworkRegistry()) {
    return formatRegistryAnswer(entry.entry, { footer: KNOWLEDGE_FOOTER });
  }
  return [
    `### ${entry.title}`,
    '',
    entry.body,
    '',
    KNOWLEDGE_FOOTER,
  ].join('\n');
}

/**
 * Concise clarification when the concept is not in the knowledge base.
 */
export function buildUnknownConceptAnswer(userMessage = '') {
  const topic = extractKnowledgeTopic(userMessage);
  return [
    `I don’t have a built-in definition for **${topic}** yet.`,
    '',
    'I can explain common ESG / BRSR concepts (e.g. Scope 1, ESG, materiality, Net Zero), or look up a company’s reported metrics if you name the company.',
    '',
    'Could you rephrase with a specific sustainability term, or ask for a company metric?',
  ].join('\n');
}

/**
 * Build an ESG knowledge answer, or a concise unknown-concept clarification.
 */
export function buildKnowledgeAnswer(userMessage = '') {
  const resolved = lookupKnowledge(userMessage);
  if (resolved.known) {
    return formatKnownAnswer(resolved);
  }
  return buildUnknownConceptAnswer(userMessage);
}
