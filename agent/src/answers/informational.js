/**
 * BRSR knowledge answers for INFORMATIONAL intents (definitions / concepts).
 * No SQL — explains terms without company-specific values.
 *
 * Prefer the shared framework registry when enabled; local DEFINITIONS remain
 * as rollback content when USE_FRAMEWORK_REGISTRY=false.
 */

import {
  useFrameworkRegistry,
  lookupRegistry,
} from '../knowledge/framework-registry.js';

const DEFINITIONS = [
  {
    match: /\bscope\s*1\b/i,
    title: 'Scope 1 emissions',
    body: [
      '**Scope 1** emissions are **direct GHG emissions** from sources a company owns or controls.',
      '',
      'Typical examples in BRSR disclosures:',
      '- Fuel burned in boilers, furnaces, and company vehicles',
      '- Process emissions from manufacturing',
      '- Fugitive emissions (e.g. refrigerants)',
    ].join('\n'),
  },
  {
    match: /\bscope\s*2\b/i,
    title: 'Scope 2 emissions',
    body: [
      '**Scope 2** emissions are **indirect GHG emissions** from purchased electricity, steam, heating, or cooling.',
      '',
      'Companies often reduce Scope 2 by increasing renewable power (on-site or via PPAs) and improving energy efficiency.',
    ].join('\n'),
  },
  {
    match: /\bscope\s*3\b/i,
    title: 'Scope 3 emissions',
    body: [
      '**Scope 3** emissions are **value-chain GHG emissions** not owned or directly controlled by the company.',
      '',
      'Common categories: purchased goods, logistics, business travel, employee commuting, use of sold products, and investments.',
    ].join('\n'),
  },
  {
    match: /\b(carbon|ghg|greenhouse)\s+emissions?\b|\bwhat\s+are\s+carbon\b|\bcarbon\s+emission\b/i,
    title: 'Carbon / GHG emissions',
    body: [
      '**Carbon emissions** (more precisely **greenhouse gas / GHG emissions**) are gases released into the atmosphere that contribute to climate change — chiefly CO₂, plus other GHGs expressed as CO₂-equivalent (tCO₂e).',
      '',
      'In BRSR / GHG Protocol terms they are usually grouped as:',
      '- **Scope 1** — direct emissions from owned/controlled sources',
      '- **Scope 2** — emissions from purchased energy',
      '- **Scope 3** — other indirect value-chain emissions',
    ].join('\n'),
  },
  {
    match: /\besg\b/i,
    title: 'ESG',
    body: [
      '**ESG** stands for **Environmental, Social, and Governance** — a framework for assessing how companies manage sustainability and responsibility risks and opportunities.',
      '',
      '- **E** — climate, emissions, energy, water, waste, biodiversity',
      '- **S** — workforce, diversity, safety, community, human rights',
      '- **G** — board composition, ethics, transparency, compliance',
      '',
      'In India, listed companies disclose much of this through **BRSR** (Business Responsibility and Sustainability Report) filings.',
    ].join('\n'),
  },
  {
    match: /\bbrsr\b/i,
    title: 'BRSR',
    body: [
      '**BRSR** (Business Responsibility and Sustainability Report) is the SEBI-mandated sustainability disclosure format for listed Indian companies.',
      '',
      'It covers essential and leadership indicators across environmental, social, and governance topics — including GHG emissions, energy, water, waste, and workforce metrics.',
    ].join('\n'),
  },
  {
    match: /\brenewable\s+energy\b/i,
    title: 'Renewable energy (BRSR)',
    body: [
      '**Renewable energy** in BRSR typically refers to electricity or energy from solar, wind, hydro, biomass, and similar sources.',
      '',
      'Companies often report renewable consumption and **renewable energy share** (renewables as a % of total energy).',
    ].join('\n'),
  },
];

/**
 * Find a known definition entry, or null if the topic is unknown.
 * Topic validation for the Copilot lives here / in the Knowledge Engine —
 * not in the intent classifier.
 */
export function findInformationalDefinition(userMessage = '') {
  const text = String(userMessage || '');
  if (useFrameworkRegistry()) {
    const concept = lookupRegistry(text, { kind: 'concept' });
    if (concept) return { match: concept.match, title: concept.title, body: concept.body, id: concept.id };
    const dual = lookupRegistry(text, { knowledgeSurface: true });
    if (dual) return { match: dual.match, title: dual.title, body: dual.body, id: dual.id };
  }
  for (const def of DEFINITIONS) {
    if (def.match.test(text)) return def;
  }
  return null;
}

export function formatInformationalDefinition(def) {
  return [`### ${def.title}`, '', def.body].join('\n');
}

/**
 * Build a definition / concept answer (no company SQL).
 * Unknown topics return null so the Knowledge Engine can clarify.
 */
export function buildInformationalAnswer(userMessage = '', { allowUnknown = true } = {}) {
  const def = findInformationalDefinition(userMessage);
  if (def) return formatInformationalDefinition(def);

  if (!allowUnknown) return null;

  // Legacy fallback for direct callers; Knowledge Engine prefers its own clarification.
  return [
    '### Concept',
    '',
    'I don’t have a built-in definition for that term yet.',
    '',
    'Try a common ESG / BRSR concept (e.g. Scope 1, ESG, BRSR, materiality), or name a company if you want a reported metric value.',
  ].join('\n');
}
