/**
 * Hybrid retrieval over BRSR structured + narrative fields.
 * Grounded only in the local reports table / metadata — not the open web.
 *
 * Layers:
 * 1) Metadata search (company, sector, industry)
 * 2) Narrative column search (GHG projects, waste practices, ZLD)
 * 3) Simple lexical rerank
 *
 * Embedding hooks are stubbed for a later vector index; SQL remains primary for metrics.
 */

import { getDb, isPostgres } from '../db.js';
import { scoreCompanyMatch } from '../sql-agent/company-resolve.js';

let ftsReady = null;

async function ensureFts(db) {
  if (ftsReady !== null) return ftsReady;
  if (isPostgres() || db.dialect === 'postgres') {
    ftsReady = false;
    return ftsReady;
  }
  try {
    await db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS reports_fts USING fts5(
        company,
        sector,
        industry,
        ghg_reduction_projects,
        waste_management_practices,
        zero_liquid_discharge_details,
        content='reports',
        content_rowid='id'
      );
    `);
    // Best-effort rebuild (ignore if already populated / triggers missing)
    const count = await db.get('SELECT COUNT(*) AS n FROM reports_fts');
    const base = await db.get('SELECT COUNT(*) AS n FROM reports');
    if ((count?.n || 0) === 0 && (base?.n || 0) > 0) {
      await db.exec(`
        INSERT INTO reports_fts(rowid, company, sector, industry, ghg_reduction_projects, waste_management_practices, zero_liquid_discharge_details)
        SELECT id, company, sector, industry, ghg_reduction_projects, waste_management_practices, zero_liquid_discharge_details
        FROM reports
      `);
    }
    ftsReady = true;
  } catch (err) {
    console.warn('[RAG] FTS5 unavailable:', err.message);
    ftsReady = false;
  }
  return ftsReady;
}

function tokenize(q) {
  return String(q || '')
    .toLowerCase()
    .replace(/[^a-z0-9%\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2)
    .slice(0, 8);
}

function lexicalScore(query, row) {
  const blob = [
    row.company,
    row.sector,
    row.industry,
    row.ghg_reduction_projects,
    row.waste_management_practices,
    row.zero_liquid_discharge_details,
  ].map((x) => String(x || '').toLowerCase()).join(' ');
  const tokens = tokenize(query);
  let score = scoreCompanyMatch(query, row.company || '') / 100;
  for (const t of tokens) {
    if (blob.includes(t)) score += 2;
  }
  if (row.pdf_url) score += 0.5;
  return score;
}

async function metadataSearch(db, query, limit) {
  const like = `%${query.replace(/%/g, '')}%`;
  return db.all(
    `SELECT id, company, year, sector, industry, pdf_url,
            substr(COALESCE(ghg_reduction_projects,''), 1, 400) AS ghg_reduction_projects,
            substr(COALESCE(waste_management_practices,''), 1, 400) AS waste_management_practices,
            substr(COALESCE(zero_liquid_discharge_details,''), 1, 280) AS zero_liquid_discharge_details
     FROM reports
     WHERE lower(company) LIKE lower(?)
        OR lower(COALESCE(sector,'')) LIKE lower(?)
        OR lower(COALESCE(industry,'')) LIKE lower(?)
     ORDER BY year DESC
     LIMIT ?`,
    [like, like, like, limit],
  );
}

async function narrativeSearch(db, query, limit) {
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const where = tokens.map(() => (
    `(lower(COALESCE(ghg_reduction_projects,'')) LIKE ?
      OR lower(COALESCE(waste_management_practices,'')) LIKE ?
      OR lower(COALESCE(zero_liquid_discharge_details,'')) LIKE ?)`
  )).join(' OR ');
  const params = [];
  for (const t of tokens) {
    const like = `%${t}%`;
    params.push(like, like, like);
  }
  params.push(limit);
  return db.all(
    `SELECT id, company, year, sector, industry, pdf_url,
            substr(COALESCE(ghg_reduction_projects,''), 1, 400) AS ghg_reduction_projects,
            substr(COALESCE(waste_management_practices,''), 1, 400) AS waste_management_practices,
            substr(COALESCE(zero_liquid_discharge_details,''), 1, 280) AS zero_liquid_discharge_details
     FROM reports
     WHERE ${where}
     ORDER BY year DESC
     LIMIT ?`,
    params,
  );
}

async function ftsSearch(db, query, limit) {
  const ready = await ensureFts(db);
  if (!ready) return [];
  const q = tokenize(query).join(' ');
  if (!q) return [];
  try {
    return await db.all(
      `SELECT r.id, r.company, r.year, r.sector, r.industry, r.pdf_url,
              substr(COALESCE(r.ghg_reduction_projects,''), 1, 400) AS ghg_reduction_projects,
              substr(COALESCE(r.waste_management_practices,''), 1, 400) AS waste_management_practices,
              substr(COALESCE(r.zero_liquid_discharge_details,''), 1, 280) AS zero_liquid_discharge_details
       FROM reports_fts f
       JOIN reports r ON r.id = f.rowid
       WHERE reports_fts MATCH ?
       LIMIT ?`,
      [q, limit],
    );
  } catch {
    return [];
  }
}

function mergeAndRerank(query, buckets, limit) {
  const byKey = new Map();
  for (const row of buckets.flat()) {
    if (!row?.company) continue;
    const key = `${String(row.company).toLowerCase()}|${row.year}`;
    const score = lexicalScore(query, row);
    const prev = byKey.get(key);
    if (!prev || score > prev.score) {
      byKey.set(key, { ...row, score, confidence: Math.min(0.99, score / 20) });
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Retrieve BRSR evidence snippets for narrative questions.
 * @returns {{ chunks: object[], method: string }}
 */
export async function hybridRetrieve(query, { limit = 8 } = {}) {
  const db = await getDb();
  const [meta, narrative, fts] = await Promise.all([
    metadataSearch(db, query, limit),
    narrativeSearch(db, query, limit),
    ftsSearch(db, query, limit),
  ]);

  // Enrich top narrative hits with data_json section chunks when available
  let dataJsonChunks = [];
  try {
    const { buildChunksFromReportRow } = await import('./brsr-chunks.js');
    const seedRows = [...narrative, ...meta].slice(0, 4);
    const detailed = [];
    for (const seed of seedRows) {
      if (!seed?.company || seed.year == null) continue;
      const full = await db.get(
        `SELECT company, year, sector, industry, pdf_url, ghg_reduction_projects,
                waste_management_practices, zero_liquid_discharge_details, data_json
         FROM reports WHERE company = ? AND year = ?`,
        [seed.company, seed.year],
      );
      if (full) detailed.push(...buildChunksFromReportRow(full).slice(0, 3));
    }
    dataJsonChunks = detailed.map((c) => ({
      ...c,
      ghg_reduction_projects: c.section === 'ghg' ? c.text : null,
      waste_management_practices: c.section === 'waste' ? c.text : null,
      zero_liquid_discharge_details: c.section === 'water' ? c.text : null,
    }));
  } catch {
    dataJsonChunks = [];
  }

  const chunks = mergeAndRerank(query, [meta, narrative, fts, dataJsonChunks], limit);
  return {
    chunks,
    method: dataJsonChunks.length
      ? 'fts+metadata+narrative+data_json'
      : (fts.length ? 'fts+metadata+narrative' : 'metadata+narrative'),
    embeddingsEnabled: false,
  };
}

/** Format retrieved BRSR chunks for LLM context. */
export function formatRagContext(retrieval) {
  if (!retrieval?.chunks?.length) {
    return 'No matching BRSR narrative snippets found in the local reports table.';
  }
  return retrieval.chunks.map((c, i) => {
    const bits = [
      `[${i + 1}] ${c.company} (${c.year}) — ${c.sector || 'n/a'} / ${c.industry || 'n/a'}`,
      c.ghg_reduction_projects ? `GHG projects: ${c.ghg_reduction_projects}` : null,
      c.waste_management_practices ? `Waste practices: ${c.waste_management_practices}` : null,
      c.zero_liquid_discharge_details ? `ZLD: ${c.zero_liquid_discharge_details}` : null,
      c.pdf_url ? `PDF: ${c.pdf_url}` : null,
      `confidence=${(c.confidence ?? 0).toFixed(2)}`,
    ].filter(Boolean);
    return bits.join('\n');
  }).join('\n\n');
}

/**
 * Future hook: store/query vector embeddings for BRSR PDF page chunks.
 * Not active yet — keep SQL primary for metrics.
 */
export async function embedAndStoreBrsrChunks() {
  return { ok: false, reason: 'embeddings_not_configured', note: 'Use hybridRetrieve (FTS/metadata) for BRSR narrative today.' };
}
