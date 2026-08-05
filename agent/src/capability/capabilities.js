/**
 * ESG Copilot capability taxonomy.
 * Capabilities sit above tool planning — they select *what kind of help*
 * the user needs; the existing planner/SQL/RAG stack still executes analytics.
 */

export const CAPABILITIES = Object.freeze({
  ESG_KNOWLEDGE: 'ESG_KNOWLEDGE',
  ESG_GUIDANCE: 'ESG_GUIDANCE',
  COMPANY_ANALYTICS: 'COMPANY_ANALYTICS',
  COMPANY_REPORTS: 'COMPANY_REPORTS',
  BENCHMARKING: 'BENCHMARKING',
  ESG_COMPLIANCE: 'ESG_COMPLIANCE',
  DOCUMENT_GENERATION: 'DOCUMENT_GENERATION',
  RECOMMENDATION: 'RECOMMENDATION',
});

export const CAPABILITY_META = Object.freeze({
  [CAPABILITIES.ESG_KNOWLEDGE]: {
    label: 'ESG Knowledge',
    source: 'llm_knowledge',
    usesSql: false,
    usesPdf: false,
    description: 'Explain ESG concepts and definitions',
  },
  [CAPABILITIES.ESG_GUIDANCE]: {
    label: 'ESG Guidance',
    source: 'llm_best_practices',
    usesSql: false,
    usesPdf: false,
    description: 'Sustainability recommendations and how-to guidance',
  },
  [CAPABILITIES.COMPANY_ANALYTICS]: {
    label: 'Company Analytics',
    source: 'sql',
    usesSql: true,
    usesPdf: false,
    description: 'Quantitative company ESG metrics via SQL',
  },
  [CAPABILITIES.COMPANY_REPORTS]: {
    label: 'Company Reports',
    source: 'narrative_pdf',
    usesSql: false,
    usesPdf: true,
    description: 'Qualitative company disclosures from narrative/PDF',
  },
  [CAPABILITIES.BENCHMARKING]: {
    label: 'Benchmarking',
    source: 'sql',
    usesSql: true,
    usesPdf: false,
    description: 'Compare companies on ESG metrics',
  },
  [CAPABILITIES.ESG_COMPLIANCE]: {
    label: 'ESG Compliance',
    source: 'framework_knowledge',
    usesSql: false,
    usesPdf: false,
    description: 'Explain ESG frameworks and disclosure rules',
  },
  [CAPABILITIES.DOCUMENT_GENERATION]: {
    label: 'Document Generation',
    source: 'llm',
    usesSql: false,
    usesPdf: false,
    description: 'Generate sustainability policies, roadmaps, and disclosures',
  },
  [CAPABILITIES.RECOMMENDATION]: {
    label: 'Recommendation Engine',
    source: 'sql_plus_llm',
    usesSql: true,
    usesPdf: false,
    description: 'Combine company data with sustainability advice',
  },
});

/** Capabilities that the existing SQL/report pipeline already handles end-to-end. */
export const PIPELINE_NATIVE_CAPABILITIES = new Set([
  CAPABILITIES.COMPANY_ANALYTICS,
  CAPABILITIES.COMPANY_REPORTS,
  CAPABILITIES.BENCHMARKING,
]);

/** Capabilities handled by dedicated Copilot engines (not the SQL agent). */
export const COPILOT_ENGINE_CAPABILITIES = new Set([
  CAPABILITIES.ESG_KNOWLEDGE,
  CAPABILITIES.ESG_GUIDANCE,
  CAPABILITIES.ESG_COMPLIANCE,
  CAPABILITIES.DOCUMENT_GENERATION,
  CAPABILITIES.RECOMMENDATION,
]);

export function isValidCapability(value) {
  return Object.values(CAPABILITIES).includes(String(value || ''));
}
