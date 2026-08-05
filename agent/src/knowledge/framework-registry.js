/**
 * Shared ESG framework / concept registry.
 *
 * Consumed by Compliance (frameworks) and Knowledge (concepts + dual-surface).
 * Feature flag: USE_FRAMEWORK_REGISTRY=false disables registry-backed lookups
 * in engines that still keep legacy arrays as fallback.
 */

/** @typedef {{ title: string, url?: string }} RegistryCitation */
/**
 * @typedef {{
 *   id: string,
 *   family: string,
 *   kind: 'framework'|'concept',
 *   aliases?: string[],
 *   match: RegExp,
 *   title: string,
 *   body: string,
 *   related?: string[],
 *   citations?: RegistryCitation[],
 *   knowledgeOk?: boolean,
 * }} RegistryEntry
 */

export function useFrameworkRegistry() {
  return process.env.USE_FRAMEWORK_REGISTRY !== 'false';
}

/** @type {RegistryEntry[]} */
export const REGISTRY = [
  // ── BRSR principles (specific before overview) ───────────────────────────
  {
    id: 'brsr-p1',
    family: 'brsr',
    kind: 'framework',
    aliases: ['brsr principle 1', 'principle 1'],
    match: /\bbrsr\s+principle\s*(1|one|i)\b|\bprinciple\s*1\b/i,
    title: 'BRSR Principle 1',
    body: 'Businesses should conduct and govern themselves with integrity, in a manner that is ethical, transparent, and accountable. Typical disclosures cover ethics policies, anti-corruption, and governance oversight.',
    related: ['brsr', 'ngrbc'],
    citations: [{ title: 'SEBI BRSR / NGRBC Principle 1', url: 'https://www.sebi.gov.in/' }],
  },
  {
    id: 'brsr-p2',
    family: 'brsr',
    kind: 'framework',
    aliases: ['brsr principle 2', 'principle 2'],
    match: /\bbrsr\s+principle\s*(2|two|ii)\b|\bprinciple\s*2\b/i,
    title: 'BRSR Principle 2',
    body: 'Businesses should provide goods and services in a manner that is sustainable and safe — covering product stewardship, lifecycle impacts, and responsible marketing.',
    related: ['brsr', 'ngrbc'],
  },
  {
    id: 'brsr-p3',
    family: 'brsr',
    kind: 'framework',
    aliases: ['brsr principle 3', 'principle 3'],
    match: /\bbrsr\s+principle\s*(3|three|iii)\b|\bprinciple\s*3\b/i,
    title: 'BRSR Principle 3',
    body: 'Businesses should respect and promote the well-being of all employees, including those in the value chain — covering health & safety, working conditions, and human rights.',
    related: ['brsr', 'ngrbc'],
  },
  {
    id: 'brsr-p4',
    family: 'brsr',
    kind: 'framework',
    aliases: ['brsr principle 4', 'principle 4'],
    match: /\bbrsr\s+principle\s*(4|four|iv)\b|\bprinciple\s*4\b/i,
    title: 'BRSR Principle 4',
    body: 'Businesses should respect the interests of and be responsive to all stakeholders — covering stakeholder engagement and grievance mechanisms.',
    related: ['brsr', 'ngrbc'],
  },
  {
    id: 'brsr-p5',
    family: 'brsr',
    kind: 'framework',
    aliases: ['brsr principle 5', 'principle 5'],
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
    related: ['brsr', 'ngrbc'],
  },
  {
    id: 'brsr-p6',
    family: 'brsr',
    kind: 'framework',
    aliases: ['brsr principle 6', 'principle 6'],
    match: /\bbrsr\s+principle\s*(6|six|vi)\b|\bprinciple\s*6\b/i,
    title: 'BRSR Principle 6',
    body: 'Businesses should respect and make efforts to protect and restore the environment — the primary home for emissions, energy, water, waste, and biodiversity indicators in BRSR.',
    related: ['brsr', 'gri-305', 'issb'],
  },
  {
    id: 'brsr-p7',
    family: 'brsr',
    kind: 'framework',
    aliases: ['brsr principle 7', 'principle 7'],
    match: /\bbrsr\s+principle\s*(7|seven|vii)\b|\bprinciple\s*7\b/i,
    title: 'BRSR Principle 7',
    body: 'Businesses, when engaging in influencing public and regulatory policy, should do so in a manner that is responsible and transparent.',
    related: ['brsr', 'ngrbc'],
  },
  {
    id: 'brsr-p8',
    family: 'brsr',
    kind: 'framework',
    aliases: ['brsr principle 8', 'principle 8'],
    match: /\bbrsr\s+principle\s*(8|eight|viii)\b|\bprinciple\s*8\b/i,
    title: 'BRSR Principle 8',
    body: 'Businesses should promote inclusive growth and equitable development — covering community, CSR, and inclusive value-chain practices.',
    related: ['brsr', 'ngrbc'],
  },
  {
    id: 'brsr-p9',
    family: 'brsr',
    kind: 'framework',
    aliases: ['brsr principle 9', 'principle 9'],
    match: /\bbrsr\s+principle\s*(9|nine|ix)\b|\bprinciple\s*9\b/i,
    title: 'BRSR Principle 9',
    body: 'Businesses should engage with and provide value to their consumers in a responsible manner — covering product safety, data privacy, and responsible advertising.',
    related: ['brsr', 'ngrbc'],
  },

  // ── Global / regional frameworks ─────────────────────────────────────────
  {
    id: 'issb',
    family: 'issb',
    kind: 'framework',
    aliases: ['issb', 'ifrs s1', 'ifrs s2', 'international sustainability standards board'],
    match: /\bissb\b|\bifrs\s*s[12]\b/i,
    title: 'ISSB',
    body: [
      '**ISSB** (International Sustainability Standards Board) issues global baseline sustainability disclosure standards.',
      '',
      '- **IFRS S1** — general sustainability-related financial disclosures',
      '- **IFRS S2** — climate-related disclosures (governance, strategy, risk, metrics/targets)',
      '',
      'ISSB focuses on information useful to investors (enterprise-value lens). Many jurisdictions are converging toward ISSB-aligned climate reporting.',
      '',
      '**Related:** TCFD recommendations are largely absorbed into IFRS S2. India’s BRSR is a jurisdictional disclosure format; companies may map BRSR climate metrics toward ISSB-aligned investor reporting.',
    ].join('\n'),
    related: ['tcfd', 'brsr', 'sasb'],
    citations: [{ title: 'IFRS Sustainability / ISSB', url: 'https://www.ifrs.org/issued-standards/ifrs-sustainability-standards-navigator/' }],
  },
  {
    id: 'csrd-esrs',
    family: 'csrd',
    kind: 'framework',
    aliases: ['csrd', 'esrs', 'corporate sustainability reporting directive'],
    match: /\bcsrd\b|\besrs\b/i,
    title: 'CSRD / ESRS',
    body: [
      '**CSRD** (Corporate Sustainability Reporting Directive) is the EU mandate for detailed sustainability reporting.',
      '',
      '**ESRS** (European Sustainability Reporting Standards) are the detailed standards under CSRD, built on **double materiality** (impact + financial).',
      '',
      'Coverage includes climate, pollution, water, biodiversity, workforce, value chain, and governance topics — typically broader than investor-only frameworks.',
    ].join('\n'),
    related: ['materiality', 'gri', 'issb'],
    citations: [{ title: 'EU CSRD overview', url: 'https://finance.ec.europa.eu/capital-markets-union-and-financial-markets/company-reporting-and-auditing/company-reporting/corporate-sustainability-reporting_en' }],
  },
  {
    id: 'gri-305',
    family: 'gri',
    kind: 'framework',
    aliases: ['gri 305', 'gri emissions'],
    match: /\bgri\s*305\b/i,
    title: 'GRI 305 — Emissions',
    body: [
      '**GRI 305** is the GRI topic standard for **Emissions**.',
      '',
      'It covers disclosure of direct (Scope 1), energy indirect (Scope 2), and other indirect (Scope 3) GHG emissions, plus GHG intensity, reduction initiatives, and ozone-depleting / other significant air emissions where relevant.',
      '',
      'BRSR Principle 6 environmental indicators overlap thematically with GRI 305 even though the filing templates differ.',
    ].join('\n'),
    related: ['gri', 'brsr-p6', 'scope-1'],
    citations: [{ title: 'GRI 305 Emissions', url: 'https://www.globalreporting.org/' }],
  },
  {
    id: 'gri-303',
    family: 'gri',
    kind: 'framework',
    aliases: ['gri 303', 'gri water'],
    match: /\bgri\s*303\b/i,
    title: 'GRI 303 — Water and Effluents',
    body: '**GRI 303** covers water and effluents — interactions with water as a shared resource, withdrawal, consumption, discharge, and impacts in water-stressed areas.',
    related: ['gri', 'brsr-p6'],
  },
  {
    id: 'gri',
    family: 'gri',
    kind: 'framework',
    aliases: ['gri', 'global reporting initiative'],
    match: /\bgri\b(?!\s*\d)/i,
    title: 'GRI',
    body: [
      '**GRI** (Global Reporting Initiative) is a widely used sustainability reporting framework with topic standards (e.g. GRI 305 Emissions, GRI 303 Water).',
      '',
      'Companies use GRI to structure impact-focused disclosures. In India, BRSR often overlaps thematically with GRI topics even when the filing format differs.',
    ].join('\n'),
    related: ['gri-305', 'gri-303', 'brsr'],
    knowledgeOk: true,
    citations: [{ title: 'Global Reporting Initiative', url: 'https://www.globalreporting.org/' }],
  },
  {
    id: 'tcfd',
    family: 'tcfd',
    kind: 'framework',
    aliases: ['tcfd'],
    match: /\btcfd\b/i,
    title: 'TCFD',
    body: '**TCFD** (Task Force on Climate-related Financial Disclosures) recommends climate disclosures across Governance, Strategy, Risk Management, and Metrics & Targets. Much of TCFD has been absorbed into **IFRS S2** (ISSB).',
    related: ['issb'],
  },
  {
    id: 'sasb',
    family: 'sasb',
    kind: 'framework',
    aliases: ['sasb'],
    match: /\bsasb\b/i,
    title: 'SASB',
    body: '**SASB** (Sustainability Accounting Standards Board) provides industry-specific financially material ESG metrics. SASB standards are now part of the IFRS Foundation / ISSB ecosystem.',
    related: ['issb'],
  },
  {
    id: 'cdp',
    family: 'cdp',
    kind: 'framework',
    aliases: ['cdp', 'carbon disclosure project'],
    match: /\bcdp\b/i,
    title: 'CDP',
    body: [
      '**CDP** (formerly the Carbon Disclosure Project) runs a global disclosure system for environmental data — climate, forests, and water.',
      '',
      'Companies and cities answer standardized questionnaires; scores (A to D-) reflect disclosure completeness and environmental performance. CDP data often feeds investor ESG ratings and supply-chain engagement programs.',
    ].join('\n'),
    related: ['issb', 'tcfd'],
    citations: [{ title: 'CDP', url: 'https://www.cdp.net/' }],
  },
  {
    id: 'sfdr',
    family: 'sfdr',
    kind: 'framework',
    aliases: ['sfdr', 'sustainable finance disclosure regulation'],
    match: /\bsfdr\b/i,
    title: 'SFDR',
    body: [
      '**SFDR** (Sustainable Finance Disclosure Regulation) is an EU rule for financial market participants on how they disclose sustainability risks and impacts of investment products.',
      '',
      'It introduces entity- and product-level disclosures, including Article 8 (promote E/S characteristics) and Article 9 (sustainable investment objective) classifications, plus Principal Adverse Impact (PAI) indicators.',
    ].join('\n'),
    related: ['csrd-esrs'],
  },
  {
    id: 'ngrbc',
    family: 'brsr',
    kind: 'framework',
    aliases: ['ngrbc', 'national guidelines on responsible business'],
    match: /\bngrbc\b|national\s+guidelines\s+on\s+responsible\s+business/i,
    title: 'NGRBC',
    body: '**NGRBC** (National Guidelines on Responsible Business Conduct) underpin India’s **BRSR** nine principles. They set expectations for ethics, product stewardship, employee well-being, stakeholders, human rights, environment, policy advocacy, inclusive growth, and consumer value.',
    related: ['brsr'],
  },
  {
    id: 'brsr',
    family: 'brsr',
    kind: 'framework',
    aliases: ['brsr', 'business responsibility and sustainability report'],
    match: /\bbrsr\b/i,
    title: 'BRSR (Business Responsibility and Sustainability Report)',
    body: [
      '**BRSR** is SEBI’s sustainability disclosure format for listed Indian companies.',
      '',
      'It organizes disclosures under nine principles (NGRBC), with essential and leadership indicators spanning ethics, products, employees, stakeholders, human rights, environment, policy advocacy, inclusive growth, and consumers.',
      '',
      'This Copilot answers company questions from indexed BRSR structured fields and report text.',
      '',
      '**Related frameworks:** thematic overlap with **GRI** topics and **ISSB**/TCFD climate pillars; BRSR remains the India filing format.',
    ].join('\n'),
    related: ['ngrbc', 'gri', 'issb', 'eid'],
    knowledgeOk: true,
    citations: [{ title: 'SEBI — BRSR', url: 'https://www.sebi.gov.in/' }],
  },

  // ── Concepts (knowledge) ─────────────────────────────────────────────────
  {
    id: 'metric',
    family: 'concepts',
    kind: 'concept',
    aliases: ['metric', 'metrics'],
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
    id: 'biodiversity',
    family: 'concepts',
    kind: 'concept',
    aliases: ['biodiversity', 'tnfd'],
    match: /\bbiodiversity\b|\btnfd\b/i,
    title: 'Biodiversity',
    body: [
      '**Biodiversity** is the variety of life on Earth — genes, species, and ecosystems.',
      '',
      'For companies, biodiversity risk covers how operations affect habitats, species, and natural capital (e.g. land use, water, pollution, supply-chain commodities).',
      '',
      'Emerging disclosure practice includes **TNFD**-aligned nature risk assessment and BRSR narrative on ecological impacts and restoration projects.',
    ].join('\n'),
    related: ['brsr-p6'],
  },
  {
    id: 'materiality',
    family: 'concepts',
    kind: 'concept',
    aliases: ['materiality', 'double materiality'],
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
    related: ['csrd-esrs'],
  },
  {
    id: 'carbon-neutrality',
    family: 'concepts',
    kind: 'concept',
    aliases: ['carbon neutrality', 'carbon neutral'],
    match: /\b(carbon\s+neutral|carbon\s+neutrality)\b/i,
    title: 'Carbon neutrality',
    body: [
      '**Carbon neutrality** means balancing residual GHG emissions with an equivalent amount of carbon removals or high-quality offsets for a defined boundary and period.',
      '',
      'Best practice: measure → reduce first → neutralize residuals → disclose assumptions.',
      '',
      'It is related to, but not identical with, **Net Zero** (which usually requires deep absolute reductions aligned to 1.5°C pathways, with limited neutralization of hard-to-abate residuals).',
    ].join('\n'),
    related: ['net-zero'],
  },
  {
    id: 'net-zero',
    family: 'concepts',
    kind: 'concept',
    aliases: ['net zero'],
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
    related: ['sbti', 'climate-transition'],
  },
  {
    id: 'greenwashing',
    family: 'concepts',
    kind: 'concept',
    aliases: ['greenwashing'],
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
    id: 'circular-economy',
    family: 'concepts',
    kind: 'concept',
    aliases: ['circular economy'],
    match: /\b(circular\s+economy)\b/i,
    title: 'Circular economy',
    body: [
      'A **circular economy** designs out waste and keeps materials in use through reuse, repair, remanufacturing, and recycling — instead of a linear take-make-dispose model.',
      '',
      'Company levers: product redesign, take-back programs, recycled content, waste diversion, and supplier circularity requirements.',
    ].join('\n'),
  },
  {
    id: 'sbti',
    family: 'concepts',
    kind: 'concept',
    aliases: ['sbti', 'science-based targets', 'science based targets'],
    match: /\b(science[- ]based\s+targets?|sbti)\b/i,
    title: 'Science-based targets (SBTi)',
    body: [
      '**Science-based targets** are GHG reduction targets aligned with climate science pathways that limit warming (commonly 1.5°C).',
      '',
      'The **SBTi** (Science Based Targets initiative) provides methods and validation for corporate near-term and Net Zero targets across Scope 1, 2, and (where material) Scope 3.',
    ].join('\n'),
    related: ['net-zero'],
    citations: [{ title: 'Science Based Targets initiative', url: 'https://sciencebasedtargets.org/' }],
  },
  {
    id: 'carbon-footprint',
    family: 'concepts',
    kind: 'concept',
    aliases: ['carbon footprint'],
    match: /\b(carbon\s+footprint)\b/i,
    title: 'Carbon footprint',
    body: [
      'A **carbon footprint** is the total GHG emissions associated with an entity, product, or activity, usually expressed in tCO₂e.',
      '',
      'Organizational footprints commonly follow the GHG Protocol and are split into Scope 1, Scope 2, and Scope 3.',
    ].join('\n'),
    related: ['scope-1', 'scope-2', 'scope-3'],
  },
  {
    id: 'esg-score',
    family: 'concepts',
    kind: 'concept',
    aliases: ['esg score'],
    match: /\b(esg\s+score)\b/i,
    title: 'ESG score',
    body: [
      'An **ESG score** is a third-party or internal rating that summarizes environmental, social, and governance performance.',
      '',
      'Scores vary by methodology (weights, data sources, controversies). Improving a score usually means strengthening disclosures, reducing material risks (emissions, safety, governance), and closing peer gaps — not optimizing a single vanity metric.',
    ].join('\n'),
    related: ['esg'],
  },
  {
    id: 'eid',
    family: 'brsr',
    kind: 'concept',
    aliases: ['eid', 'essential indicators', 'essential indicator'],
    match: /\b(eid|essential\s+indicators?)\b/i,
    title: 'Essential Indicators (EID)',
    body: [
      'In **BRSR**, **Essential Indicators** are mandatory disclosure items that listed companies must report under each of the nine NGRBC principles.',
      '',
      'They sit alongside **Leadership Indicators** (more advanced / voluntary-leaning practices). Essential Indicators typically cover core policies, quantitative ESG metrics, and governance processes regulators expect as a baseline.',
      '',
      'Ask about a specific BRSR principle (e.g. “Explain BRSR Principle 6”) for the themes those indicators cover.',
    ].join('\n'),
    related: ['brsr'],
  },
  {
    id: 'sdgs',
    family: 'concepts',
    kind: 'concept',
    aliases: ['sdg', 'sdgs', 'sustainable development goals'],
    match: /\b(sdgs?|sustainable\s+development\s+goals?)\b/i,
    title: 'Sustainable Development Goals (SDGs)',
    body: [
      'The **UN Sustainable Development Goals (SDGs)** are 17 global goals adopted in 2015 covering poverty, climate, equality, clean energy, responsible consumption, and more.',
      '',
      'Companies often map BRSR / GRI disclosures to relevant SDGs to show how operations contribute to (or risk undermining) those goals. Mapping should be evidence-based — not logo washing.',
    ].join('\n'),
    related: ['brsr', 'gri'],
  },
  {
    id: 'climate-transition',
    family: 'concepts',
    kind: 'concept',
    aliases: ['transition plan', 'climate transition'],
    match: /\b(transition\s+plan|climate\s+transition)\b/i,
    title: 'Climate transition plan',
    body: [
      'A **climate transition plan** explains how an organization will align its business model with a low-carbon pathway (often 1.5°C / Net Zero).',
      '',
      'Credible plans typically include targets, CapEx/OpEx alignment, governance, Scope 1/2/3 levers, and progress metrics — not only aspirational statements.',
    ].join('\n'),
    related: ['net-zero', 'issb'],
  },
  {
    id: 'scope-3',
    family: 'concepts',
    kind: 'concept',
    aliases: ['scope 3', 'value chain emissions'],
    match: /\b(scope\s*3|value[- ]chain\s+emissions)\b/i,
    title: 'Scope 3 emissions',
    body: [
      '**Scope 3** covers indirect GHG emissions in a company’s value chain (upstream and downstream) that are not Scope 1 or Scope 2 — e.g. purchased goods, logistics, use of sold products, investments.',
      '',
      'For many sectors Scope 3 dominates the footprint. BRSR and GRI 305 ask companies to disclose material Scope 3 categories with methodology notes.',
    ].join('\n'),
    related: ['scope-1', 'scope-2', 'gri-305'],
  },
  {
    id: 'scope-1',
    family: 'concepts',
    kind: 'concept',
    aliases: ['scope 1'],
    match: /\bscope\s*1\b/i,
    title: 'Scope 1 emissions',
    body: [
      '**Scope 1** emissions are **direct GHG emissions** from sources a company owns or controls.',
      '',
      'Typical examples in BRSR disclosures:',
      '- Fuel burned in boilers, furnaces, and company vehicles',
      '- Process emissions from manufacturing',
      '- Fugitive emissions (e.g. refrigerants)',
      '',
      'In this agent, company Scope 1 values come from structured BRSR fields (SQL), not from a dictionary definition.',
    ].join('\n'),
    related: ['scope-2', 'scope-3'],
  },
  {
    id: 'scope-2',
    family: 'concepts',
    kind: 'concept',
    aliases: ['scope 2'],
    match: /\bscope\s*2\b/i,
    title: 'Scope 2 emissions',
    body: [
      '**Scope 2** emissions are **indirect GHG emissions** from purchased electricity, steam, heating, or cooling.',
      '',
      'Companies often reduce Scope 2 by increasing renewable power (on-site or via PPAs) and improving energy efficiency.',
      '',
      'Ask for a company name if you want the reported Scope 2 figure from BRSR data.',
    ].join('\n'),
    related: ['scope-1', 'scope-3', 'renewable-energy'],
  },
  {
    id: 'ghg-emissions',
    family: 'concepts',
    kind: 'concept',
    aliases: ['carbon emissions', 'ghg emissions', 'greenhouse emissions'],
    match: /\b(carbon|ghg|greenhouse)\s+emissions?\b|\bwhat\s+are\s+carbon\b|\bcarbon\s+emission\b/i,
    title: 'Carbon / GHG emissions',
    body: [
      '**Carbon emissions** (more precisely **greenhouse gas / GHG emissions**) are gases released into the atmosphere that contribute to climate change — chiefly CO₂, plus other GHGs expressed as CO₂-equivalent (tCO₂e).',
      '',
      'In BRSR / GHG Protocol terms they are usually grouped as:',
      '- **Scope 1** — direct emissions from owned/controlled sources',
      '- **Scope 2** — emissions from purchased energy',
      '- **Scope 3** — other indirect value-chain emissions',
      '',
      '**Total emissions** in this database often means a Scope 1+2+3 (or best available) proxy for ranking and lookup.',
      '',
      'This answer is a definition. To see **reported numbers**, ask e.g. “What are Infosys Scope 1 emissions in 2024?”',
    ].join('\n'),
    related: ['scope-1', 'scope-2', 'scope-3'],
  },
  {
    id: 'esg',
    family: 'concepts',
    kind: 'concept',
    aliases: ['esg'],
    match: /\besg\b/i,
    title: 'ESG',
    body: [
      '**ESG** stands for **Environmental, Social, and Governance** — a framework for assessing how companies manage sustainability and responsibility risks and opportunities.',
      '',
      '- **E** — climate, emissions, energy, water, waste, biodiversity',
      '- **S** — workforce, diversity, safety, community, human rights',
      '- **G** — board composition, ethics, transparency, compliance',
      '',
      'In India, listed companies disclose much of this through **BRSR** (Business Responsibility and Sustainability Report) filings, which this agent queries.',
    ].join('\n'),
    related: ['brsr'],
  },
  {
    id: 'renewable-energy',
    family: 'concepts',
    kind: 'concept',
    aliases: ['renewable energy'],
    match: /\brenewable\s+energy\b/i,
    title: 'Renewable energy (BRSR)',
    body: [
      '**Renewable energy** in BRSR typically refers to electricity or energy from solar, wind, hydro, biomass, and similar sources.',
      '',
      'Companies often report renewable consumption and **renewable energy share** (renewables as a % of total energy).',
      '',
      'Ask for a company if you want the reported share or consumption value.',
    ].join('\n'),
    related: ['scope-2'],
  },
];

const BY_ID = new Map(REGISTRY.map((e) => [e.id, e]));

export function getRegistryEntry(id) {
  return BY_ID.get(id) || null;
}

/**
 * First matching registry entry for the user text.
 * @param {string} text
 * @param {{ kind?: 'framework'|'concept'|null, knowledgeSurface?: boolean }} [opts]
 */
export function lookupRegistry(text, opts = {}) {
  const t = String(text || '');
  if (!t.trim()) return null;
  const wantKind = opts.kind || null;
  const knowledgeSurface = Boolean(opts.knowledgeSurface);

  for (const entry of REGISTRY) {
    if (wantKind === 'framework' && entry.kind !== 'framework') continue;
    if (wantKind === 'concept' && entry.kind !== 'concept') continue;
    if (knowledgeSurface) {
      // Concepts always; frameworks only when dual-surfaced for knowledge routing
      if (entry.kind === 'framework' && !entry.knowledgeOk) continue;
    }
    if (entry.match.test(t)) return entry;
  }
  return null;
}

export function formatRelatedBlock(entry) {
  const related = (entry?.related || [])
    .map((id) => getRegistryEntry(id))
    .filter(Boolean);
  if (!related.length) return '';
  const labels = related.map((r) => r.title).slice(0, 5);
  return `\n\n**Also see:** ${labels.join(' · ')}`;
}

export function formatCitationsBlock(entry) {
  const cites = entry?.citations || [];
  if (!cites.length) return '';
  const lines = cites.map((c) => (c.url ? `- [${c.title}](${c.url})` : `- ${c.title}`));
  return `\n\n**Sources**\n${lines.join('\n')}`;
}

export function formatRegistryAnswer(entry, {
  footer = '_ESG knowledge answer — general concept explanation, not a company database lookup._',
  includeRelated = true,
  includeCitations = true,
} = {}) {
  if (!entry) return '';
  const related = includeRelated ? formatRelatedBlock(entry) : '';
  const cites = includeCitations ? formatCitationsBlock(entry) : '';
  return [
    `### ${entry.title}`,
    '',
    entry.body + related + cites,
    '',
    footer,
  ].join('\n');
}

/** Framework aliases useful for compliance routing detectors. */
export function frameworkAliasTerms() {
  const terms = new Set();
  for (const e of REGISTRY) {
    if (e.kind !== 'framework') continue;
    for (const a of e.aliases || []) {
      const s = String(a).trim().toLowerCase();
      if (s) terms.add(s);
    }
  }
  return [...terms];
}

export function listFrameworkMenu() {
  return REGISTRY
    .filter((e) => e.kind === 'framework' && !/-p\d$/.test(e.id) && !/^gri-\d/.test(e.id))
    .map((e) => e.title);
}
