/**
 * Extract BRSR qualitative chunks from narrative columns + data_json.
 * Section-aware lexical search for company ESG strategy / disclosure Q&A.
 */

import { getDb, getCompanyList } from '../db.js';
import { resolveCompanyEntity } from '../sql-agent/company-resolve.js';

const SECTION_KEYS = [
  { key: 'ghg', labels: ['ghg', 'emission', 'carbon', 'climate', 'scope'] },
  { key: 'energy', labels: ['energy', 'renewable', 'electricity', 'power'] },
  { key: 'water', labels: ['water', 'effluent', 'zld', 'discharge'] },
  { key: 'waste', labels: ['waste', 'recycle', 'circular'] },
  { key: 'workforce', labels: ['employee', 'workforce', 'diversity', 'female', 'gender', 'safety', 'ltifr'] },
  { key: 'governance', labels: ['board', 'governance', 'principle', 'policy', 'brsr'] },
  { key: 'strategy', labels: ['strategy', 'sustainability', 'esg', 'initiative', 'project', 'reduction'] },
];

function asText(value, depth = 0) {
  if (value == null || depth > 4) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map((v) => asText(v, depth + 1)).filter(Boolean).join(' | ');
  }
  if (typeof value === 'object') {
    const parts = [];
    for (const [k, v] of Object.entries(value)) {
      if (/url|href|link|page|unit/i.test(k) && typeof v !== 'object') continue;
      const t = asText(v, depth + 1);
      if (t && t.length > 12) parts.push(`${k}: ${t}`);
    }
    return parts.join('\n');
  }
  return '';
}

function chunkText(text, { section = 'general', maxLen = 500 } = {}) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean || clean.length < 40) return [];
  const chunks = [];
  for (let i = 0; i < clean.length && chunks.length < 6; i += maxLen - 40) {
    const slice = clean.slice(i, i + maxLen).trim();
    if (slice.length >= 40) chunks.push({ section, text: slice });
  }
  return chunks;
}

function detectSections(query) {
  const q = String(query || '').toLowerCase();
  const hit = SECTION_KEYS.filter((s) => s.labels.some((l) => q.includes(l))).map((s) => s.key);
  return hit.length ? hit : ['strategy', 'ghg', 'governance'];
}

function scoreChunk(query, chunk) {
  const qTokens = String(query || '').toLowerCase().split(/\W+/).filter((t) => t.length > 2);
  const blob = `${chunk.section} ${chunk.text}`.toLowerCase();
  let score = 0;
  for (const t of qTokens) {
    if (blob.includes(t)) score += 2;
  }
  if (detectSections(query).includes(chunk.section)) score += 3;
  return score;
}

/**
 * Build chunks for one report row.
 */
export function buildChunksFromReportRow(row, dataJson = null) {
  const chunks = [];
  const base = {
    company: row.company,
    year: row.year,
    sector: row.sector,
    industry: row.industry,
    pdf_url: row.pdf_url,
  };

  for (const [section, field] of [
    ['ghg', 'ghg_reduction_projects'],
    ['waste', 'waste_management_practices'],
    ['water', 'zero_liquid_discharge_details'],
  ]) {
    for (const c of chunkText(row[field], { section })) {
      chunks.push({ ...base, ...c, source: field });
    }
  }

  let data = dataJson;
  if (!data && row.data_json) {
    try {
      data = typeof row.data_json === 'string' ? JSON.parse(row.data_json) : row.data_json;
    } catch {
      data = null;
    }
  }
  if (data && typeof data === 'object') {
    const interesting = [
      ['strategy', data.sustainability_strategy || data.esg_strategy || data.strategy],
      ['ghg', data.ghg_reduction_projects || data.climate || data.emissions],
      ['energy', data.energy || data.renewable_energy],
      ['water', data.water || data.water_management],
      ['waste', data.waste || data.waste_management],
      ['workforce', data.employees || data.workforce || data.social],
      ['governance', data.governance || data.principles || data.policies],
    ];
    for (const [section, node] of interesting) {
      const text = asText(node);
      for (const c of chunkText(text, { section, maxLen: 450 })) {
        chunks.push({ ...base, ...c, source: `data_json.${section}` });
      }
    }
    // Fallback: walk a shallow string dump of data_json if still thin
    if (chunks.length < 2) {
      const dump = asText(data).slice(0, 2500);
      for (const c of chunkText(dump, { section: 'strategy', maxLen: 450 })) {
        chunks.push({ ...base, ...c, source: 'data_json' });
      }
    }
  }

  return chunks;
}

/**
 * Retrieve qualitative BRSR chunks for a company-focused question.
 */
export async function retrieveCompanyNarrative(query, {
  companyHint = null,
  year = null,
  limit = 8,
} = {}) {
  const db = await getDb();
  let company = null;
  if (companyHint) {
    const resolved = await resolveCompanyEntity(companyHint, getCompanyList);
    if (resolved.status === 'resolved') company = resolved.company;
    else if (resolved.status === 'ambiguous') {
      return { status: 'ambiguous', ...resolved, chunks: [] };
    }
  }

  let row;
  if (company && year) {
    row = await db.get(
      `SELECT company, year, sector, industry, pdf_url, ghg_reduction_projects,
              waste_management_practices, zero_liquid_discharge_details, data_json
       FROM reports WHERE company = ? AND year = ?`,
      [company, year],
    );
  } else if (company) {
    row = await db.get(
      `SELECT company, year, sector, industry, pdf_url, ghg_reduction_projects,
              waste_management_practices, zero_liquid_discharge_details, data_json
       FROM reports WHERE company = ? ORDER BY year DESC LIMIT 1`,
      [company],
    );
  } else {
    // Broad narrative search via hybrid columns
    const likeTokens = String(query).toLowerCase().split(/\W+/).filter((t) => t.length > 3).slice(0, 4);
    if (!likeTokens.length) return { status: 'ok', chunks: [], company: null };
    const where = likeTokens.map(() => (
      `(lower(COALESCE(ghg_reduction_projects,'')) LIKE ?
        OR lower(COALESCE(waste_management_practices,'')) LIKE ?
        OR lower(COALESCE(zero_liquid_discharge_details,'')) LIKE ?)`
    )).join(' OR ');
    const params = [];
    for (const t of likeTokens) {
      const like = `%${t}%`;
      params.push(like, like, like);
    }
    params.push(5);
    const rows = await db.all(
      `SELECT company, year, sector, industry, pdf_url, ghg_reduction_projects,
              waste_management_practices, zero_liquid_discharge_details, data_json
       FROM reports WHERE ${where} ORDER BY year DESC LIMIT ?`,
      params,
    );
    const all = rows.flatMap((r) => buildChunksFromReportRow(r));
    const ranked = all
      .map((c) => ({ ...c, score: scoreChunk(query, c), confidence: Math.min(0.95, scoreChunk(query, c) / 15) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return { status: 'ok', chunks: ranked, company: null };
  }

  if (!row) return { status: 'not_found', company, chunks: [] };

  const ranked = buildChunksFromReportRow(row)
    .map((c) => ({ ...c, score: scoreChunk(query, c), confidence: Math.min(0.95, scoreChunk(query, c) / 15) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    status: 'ok',
    company: row.company,
    year: row.year,
    pdf_url: row.pdf_url,
    sector: row.sector,
    chunks: ranked,
  };
}

export function formatNarrativeAnswer({ company, year, pdf_url, chunks, query }) {
  if (!chunks?.length) {
    return company
      ? `No qualitative BRSR narrative snippets were found for **${company}**${year ? ` (${year})` : ''} matching “${query}”. Try a metric question (e.g. Scope 1) or open the PDF if linked.`
      : `No matching BRSR narrative snippets were found for that question.`;
  }

  const lines = [
    `### BRSR narrative${company ? ` — ${company}` : ''}${year ? ` (${year})` : ''}`,
    '',
    `Based on indexed BRSR text fields / report JSON (not web search):`,
    '',
  ];
  for (const c of chunks.slice(0, 6)) {
    lines.push(`- **${c.section}** (${c.source || 'brsr'}): ${c.text}`);
  }
  if (pdf_url) {
    lines.push('', `PDF: [source](${pdf_url})`);
  }
  lines.push('', '_Citations are grounded in structured/narrative BRSR fields available in the database._');
  return lines.join('\n');
}
