/**
 * ESG Compliance Engine — frameworks, principles, and disclosure standards.
 * Source: shared framework registry (with legacy fallback when flag off).
 */

import {
  useFrameworkRegistry,
  lookupRegistry,
  formatRegistryAnswer,
  listFrameworkMenu,
} from '../knowledge/framework-registry.js';

/** @deprecated Prefer registry; kept for USE_FRAMEWORK_REGISTRY=false rollback. */
const LEGACY_FRAMEWORKS = [
  {
    match: /\bbrsr\s+principle\s*(1|one|i)\b|\bprinciple\s*1\b/i,
    title: 'BRSR Principle 1',
    body: 'Businesses should conduct and govern themselves with integrity, in a manner that is ethical, transparent, and accountable. Typical disclosures cover ethics policies, anti-corruption, and governance oversight.',
  },
  {
    match: /\bbrsr\s+principle\s*(2|two|ii)\b|\bprinciple\s*2\b/i,
    title: 'BRSR Principle 2',
    body: 'Businesses should provide goods and services in a manner that is sustainable and safe — covering product stewardship, lifecycle impacts, and responsible marketing.',
  },
  {
    match: /\bbrsr\s+principle\s*(3|three|iii)\b|\bprinciple\s*3\b/i,
    title: 'BRSR Principle 3',
    body: 'Businesses should respect and promote the well-being of all employees, including those in the value chain — covering health & safety, working conditions, and human rights.',
  },
  {
    match: /\bbrsr\s+principle\s*(4|four|iv)\b|\bprinciple\s*4\b/i,
    title: 'BRSR Principle 4',
    body: 'Businesses should respect the interests of and be responsive to all stakeholders — covering stakeholder engagement and grievance mechanisms.',
  },
  {
    match: /\bbrsr\s+principle\s*(5|five|v)\b|\bprinciple\s*5\b/i,
    title: 'BRSR Principle 5',
    body: [
      '**BRSR Principle 5** — Businesses should respect and promote human rights.',
      '',
      'Typical disclosure themes:',
      '- Human rights policy and due diligence',
      '- Awareness training for employees and value-chain partners',
      '- Mechanisms to address human-rights grievances',
      '- Assessment of plants/offices and value chain for human-rights risks',
      '',
      'Essential and leadership indicators under Principle 5 ask companies to show how rights are embedded in operations, not only stated in policy.',
    ].join('\n'),
  },
  {
    match: /\bbrsr\s+principle\s*(6|six|vi)\b|\bprinciple\s*6\b/i,
    title: 'BRSR Principle 6',
    body: 'Businesses should respect and make efforts to protect and restore the environment — the primary home for emissions, energy, water, waste, and biodiversity indicators in BRSR.',
  },
  {
    match: /\bbrsr\s+principle\s*(7|seven|vii)\b|\bprinciple\s*7\b/i,
    title: 'BRSR Principle 7',
    body: 'Businesses, when engaging in influencing public and regulatory policy, should do so in a manner that is responsible and transparent.',
  },
  {
    match: /\bbrsr\s+principle\s*(8|eight|viii)\b|\bprinciple\s*8\b/i,
    title: 'BRSR Principle 8',
    body: 'Businesses should promote inclusive growth and equitable development — covering community, CSR, and inclusive value-chain practices.',
  },
  {
    match: /\bbrsr\s+principle\s*(9|nine|ix)\b|\bprinciple\s*9\b/i,
    title: 'BRSR Principle 9',
    body: 'Businesses should engage with and provide value to their consumers in a responsible manner — covering product safety, data privacy, and responsible advertising.',
  },
  {
    match: /\bissb\b|\bifrs\s*s[12]\b/i,
    title: 'ISSB',
    body: [
      '**ISSB** (International Sustainability Standards Board) issues global baseline sustainability disclosure standards.',
      '',
      '- **IFRS S1** — general sustainability-related financial disclosures',
      '- **IFRS S2** — climate-related disclosures (governance, strategy, risk, metrics/targets)',
      '',
      'ISSB focuses on information useful to investors (enterprise-value lens). Many jurisdictions are converging toward ISSB-aligned climate reporting.',
    ].join('\n'),
  },
  {
    match: /\bcsrd\b|\besrs\b/i,
    title: 'CSRD / ESRS',
    body: [
      '**CSRD** (Corporate Sustainability Reporting Directive) is the EU mandate for detailed sustainability reporting.',
      '',
      '**ESRS** (European Sustainability Reporting Standards) are the detailed standards under CSRD, built on **double materiality** (impact + financial).',
      '',
      'Coverage includes climate, pollution, water, biodiversity, workforce, value chain, and governance topics — typically broader than investor-only frameworks.',
    ].join('\n'),
  },
  {
    match: /\bgri\s*305\b/i,
    title: 'GRI 305 — Emissions',
    body: [
      '**GRI 305** is the GRI topic standard for **Emissions**.',
      '',
      'It covers disclosure of direct (Scope 1), energy indirect (Scope 2), and other indirect (Scope 3) GHG emissions, plus GHG intensity, reduction initiatives, and ozone-depleting / other significant air emissions where relevant.',
      '',
      'BRSR Principle 6 environmental indicators overlap thematically with GRI 305 even though the filing templates differ.',
    ].join('\n'),
  },
  {
    match: /\bgri\s*303\b/i,
    title: 'GRI 303 — Water and Effluents',
    body: '**GRI 303** covers water and effluents — interactions with water as a shared resource, withdrawal, consumption, discharge, and impacts in water-stressed areas.',
  },
  {
    match: /\btcfd\b/i,
    title: 'TCFD',
    body: '**TCFD** (Task Force on Climate-related Financial Disclosures) recommends climate disclosures across Governance, Strategy, Risk Management, and Metrics & Targets. Much of TCFD has been absorbed into **IFRS S2** (ISSB).',
  },
  {
    match: /\bsasb\b/i,
    title: 'SASB',
    body: '**SASB** (Sustainability Accounting Standards Board) provides industry-specific financially material ESG metrics. SASB standards are now part of the IFRS Foundation / ISSB ecosystem.',
  },
  {
    match: /\bcdp\b/i,
    title: 'CDP',
    body: [
      '**CDP** (formerly the Carbon Disclosure Project) runs a global disclosure system for environmental data — climate, forests, and water.',
      '',
      'Companies and cities answer standardized questionnaires; scores (A to D-) reflect disclosure completeness and environmental performance. CDP data often feeds investor ESG ratings and supply-chain engagement programs.',
    ].join('\n'),
  },
  {
    match: /\bsfdr\b/i,
    title: 'SFDR',
    body: [
      '**SFDR** (Sustainable Finance Disclosure Regulation) is an EU rule for financial market participants on how they disclose sustainability risks and impacts of investment products.',
      '',
      'It introduces entity- and product-level disclosures, including Article 8 (promote E/S characteristics) and Article 9 (sustainable investment objective) classifications, plus Principal Adverse Impact (PAI) indicators.',
    ].join('\n'),
  },
  {
    match: /\bngrbc\b|national\s+guidelines\s+on\s+responsible\s+business/i,
    title: 'NGRBC',
    body: '**NGRBC** (National Guidelines on Responsible Business Conduct) underpin India’s **BRSR** nine principles. They set expectations for ethics, product stewardship, employee well-being, stakeholders, human rights, environment, policy advocacy, inclusive growth, and consumer value.',
  },
  {
    match: /\bbrsr\b/i,
    title: 'BRSR (Business Responsibility and Sustainability Report)',
    body: [
      '**BRSR** is SEBI’s sustainability disclosure format for listed Indian companies.',
      '',
      'It organizes disclosures under nine principles (NGRBC), with essential and leadership indicators spanning ethics, products, employees, stakeholders, human rights, environment, policy advocacy, inclusive growth, and consumers.',
      '',
      'This Copilot answers company questions from indexed BRSR structured fields and report text.',
    ].join('\n'),
  },
];

const COMPLIANCE_FOOTER = '_ESG compliance / framework knowledge — not a company filing check._';

function buildMenuAnswer() {
  const menu = useFrameworkRegistry()
    ? listFrameworkMenu()
    : ['BRSR', 'ISSB', 'CSRD / ESRS', 'GRI', 'TCFD', 'SASB', 'CDP', 'SFDR', 'NGRBC'];
  return [
    '### ESG frameworks & compliance',
    '',
    'I can explain major sustainability frameworks and BRSR principles, for example:',
    '- **BRSR** principles 1–9 (e.g. “Explain BRSR Principle 5”)',
    ...menu.filter((t) => !/^BRSR/i.test(t)).slice(0, 8).map((t) => `- **${t}**`),
    '',
    'Ask about a specific framework, principle, or standard for a focused explanation.',
    '',
    COMPLIANCE_FOOTER,
  ].join('\n');
}

/**
 * Build a compliance / framework explanation answer.
 */
export function buildComplianceAnswer(userMessage = '') {
  const text = String(userMessage || '');

  if (useFrameworkRegistry()) {
    const entry = lookupRegistry(text, { kind: 'framework' });
    if (entry) {
      return formatRegistryAnswer(entry, { footer: COMPLIANCE_FOOTER });
    }
    return buildMenuAnswer();
  }

  for (const fw of LEGACY_FRAMEWORKS) {
    if (fw.match.test(text)) {
      return [
        `### ${fw.title}`,
        '',
        fw.body,
        '',
        COMPLIANCE_FOOTER,
      ].join('\n');
    }
  }

  return buildMenuAnswer();
}
