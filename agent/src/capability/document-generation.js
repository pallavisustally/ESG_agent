/**
 * Document Generation Engine — draft sustainability policies, roadmaps, and plans.
 * Source: structured LLM-ready templates (no SQL required).
 */

function detectDocType(text) {
  const t = String(text || '');
  if (/\bbrsr\s+disclosure\b/i.test(t)) return 'brsr_disclosure';
  if (/\bclimate\s+action\s+plan\b/i.test(t)) return 'climate_action_plan';
  if (/\b(net\s*zero|carbon)\s+(roadmap|plan)\b/i.test(t) || /\bsustainability\s+roadmap\b/i.test(t)) {
    return 'sustainability_roadmap';
  }
  if (/\bdiversity\s+policy\b/i.test(t)) return 'diversity_policy';
  if (/\bwaste\s+management\s+policy\b/i.test(t)) return 'waste_policy';
  if (/\benvironmental\s+policy\b/i.test(t)) return 'environmental_policy';
  if (/\besg\s+policy\b|\bsustainability\s+policy\b/i.test(t)) return 'esg_policy';
  return 'esg_policy';
}

const TEMPLATES = {
  esg_policy: {
    title: 'ESG Policy (draft)',
    sections: [
      ['1. Purpose', 'State the company’s commitment to responsible environmental, social, and governance practices and long-term value creation.'],
      ['2. Scope', 'Apply to all operations, subsidiaries, and — where feasible — value-chain partners.'],
      ['3. Governance', 'Board/ESG committee oversight; management accountability; periodic policy review.'],
      ['4. Environmental commitments', 'Measure and reduce GHG emissions, energy, water, and waste; protect biodiversity; pursue efficiency and renewables.'],
      ['5. Social commitments', 'Fair labour, health & safety, diversity & inclusion, human rights due diligence, community engagement.'],
      ['6. Governance commitments', 'Ethics, anti-corruption, transparency, responsible lobbying, data privacy, and ESG risk integration.'],
      ['7. Targets & disclosure', 'Set measurable KPIs; disclose progress via BRSR and applicable frameworks; seek assurance where required.'],
      ['8. Grievance & continuous improvement', 'Provide channels to raise concerns; review incidents; update the policy annually.'],
    ],
  },
  sustainability_roadmap: {
    title: 'Sustainability Roadmap (draft)',
    sections: [
      ['Phase 0 — Baseline (0–6 months)', 'Complete GHG/water/waste/workforce baseline; materiality assessment; gap analysis vs peers and BRSR requirements.'],
      ['Phase 1 — Foundations (6–18 months)', 'Governance charter, data systems, quick-win efficiency projects, renewable pilots, supplier code updates.'],
      ['Phase 2 — Scale (18–36 months)', 'Absolute reduction programs, renewable scale-up, Scope 3 engagement, diversity & safety targets, CapEx alignment.'],
      ['Phase 3 — Leadership (3–7 years)', 'Science-aligned / Net Zero pathway, circularity programs, nature-positive actions, assured disclosures.'],
      ['Enablers', 'Board oversight, ESG-linked incentives, training, digital MRV (measure-report-verify), stakeholder engagement.'],
    ],
  },
  climate_action_plan: {
    title: 'Climate Action Plan (draft)',
    sections: [
      ['1. Ambition', 'Commit to near-term and long-term GHG targets aligned with climate science; define organizational boundary.'],
      ['2. Inventory', 'Annual Scope 1/2 inventory; material Scope 3 categories; intensity and absolute metrics.'],
      ['3. Reduction levers', 'Energy efficiency, renewables/PPAs, process electrification, fuel switching, logistics optimization, supplier standards.'],
      ['4. Transition & finance', 'CapEx/OpEx plan, internal carbon price (optional), risk & opportunity analysis (TCFD/ISSB S2).'],
      ['5. Adaptation', 'Physical climate risk screening for critical sites and supply chains.'],
      ['6. Governance & disclosure', 'Board review cadence; BRSR Principle 6 metrics; public progress report.'],
    ],
  },
  brsr_disclosure: {
    title: 'BRSR disclosure outline (draft)',
    sections: [
      ['Section A — General disclosures', 'Company details, products/services, markets, workforce overview, ethics & transparency basics.'],
      ['Section B — Management & process', 'Policies mapped to NGRBC principles; governance structures; grievance redressal.'],
      ['Section C — Principle-wise performance', 'Essential indicators for Principles 1–9; leadership indicators where pursuing higher maturity.'],
      ['Environment focus (P6)', 'Energy, GHG (Scope 1/2/3), water, waste, air emissions, biodiversity, GHG reduction projects.'],
      ['Social focus (P3/P5/P8)', 'Workforce, health & safety, human rights, community, inclusive growth.'],
      ['Assurance & narrative', 'Attach methodologies, restatements, and case studies; align numbers with structured fields.'],
    ],
  },
  diversity_policy: {
    title: 'Diversity & Inclusion Policy (draft)',
    sections: [
      ['1. Purpose', 'Foster an inclusive workplace where all employees can contribute and advance fairly.'],
      ['2. Scope', 'Recruitment, pay, promotion, learning, leadership, and board composition.'],
      ['3. Commitments', 'Non-discrimination; equal opportunity; pay equity reviews; inclusive benefits.'],
      ['4. Goals & metrics', 'Representation targets; hiring/promotion/attrition dashboards; board diversity disclosure.'],
      ['5. Accountability', 'CHRO/CEO ownership; board oversight; annual public disclosure (BRSR workforce metrics).'],
    ],
  },
  waste_policy: {
    title: 'Waste Management Policy (draft)',
    sections: [
      ['1. Hierarchy', 'Prevent → reuse → recycle → recover → responsible dispose.'],
      ['2. Segregation & tracking', 'Hazardous vs non-hazardous streams; digital waste logs; authorized recyclers only.'],
      ['3. Targets', 'Landfill diversion, plastic reduction, e-waste compliance, circular packaging goals.'],
      ['4. Value chain', 'Supplier packaging standards; take-back where product-relevant.'],
      ['5. Disclosure', 'BRSR waste metrics and narrative practices; incident reporting.'],
    ],
  },
  environmental_policy: {
    title: 'Environmental Policy (draft)',
    sections: [
      ['1. Commitment', 'Protect the environment and continuously improve environmental performance.'],
      ['2. Compliance', 'Meet or exceed applicable environmental laws and BRSR/SEBI expectations.'],
      ['3. Focus areas', 'Climate & energy, water, waste, air quality, biodiversity, and sustainable procurement.'],
      ['4. Management system', 'Objectives, monitoring, audits, training, and corrective action.'],
      ['5. Transparency', 'Public disclosure of material environmental metrics and incidents.'],
    ],
  },
};

/**
 * Generate a structured sustainability document draft.
 */
export function buildDocumentDraft(userMessage = '') {
  const docType = detectDocType(userMessage);
  const tpl = TEMPLATES[docType] || TEMPLATES.esg_policy;
  const lines = [
    `### ${tpl.title}`,
    '',
    '_Draft template for customization — not legal advice and not a filed disclosure._',
    '',
  ];
  for (const [heading, body] of tpl.sections) {
    lines.push(`#### ${heading}`, '', body, '');
  }
  lines.push(
    '---',
    '',
    'Next steps: adapt ownership, KPIs, and timelines to your sector; align numbers with verified BRSR data where available.',
  );
  return lines.join('\n');
}
