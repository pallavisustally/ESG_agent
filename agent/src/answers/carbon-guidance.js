/**
 * BRSR-grounded guidance for "how can I control / reduce carbon emissions?"
 * Combines Scope 1/2/3 levers with sample GHG reduction narratives from the DB.
 */

import { getDb } from '../db.js';
import { hybridRetrieve } from '../rag/hybrid-retrieval.js';

async function sampleGhgProjects(limit = 5) {
  const db = await getDb();
  try {
    return await db.all(
      `SELECT company, year, substr(ghg_reduction_projects, 1, 320) AS snippet, pdf_url
       FROM reports
       WHERE ghg_reduction_projects IS NOT NULL
         AND length(trim(ghg_reduction_projects)) > 80
       ORDER BY year DESC
       LIMIT ?`,
      [limit * 3],
    );
  } catch {
    return [];
  }
}

function dedupeByCompany(rows, limit) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = String(row.company || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Build a guidance answer (no ranking).
 */
export async function buildCarbonControlGuidance(userMessage = '') {
  const samples = dedupeByCompany(await sampleGhgProjects(5), 5);
  let retrievalSnippets = [];
  try {
    const retrieval = await hybridRetrieve(
      userMessage || 'GHG reduction renewable energy efficiency carbon neutrality',
      { limit: 4 },
    );
    retrievalSnippets = retrieval.chunks || [];
  } catch {
    retrievalSnippets = [];
  }

  const lines = [
    '### How companies control carbon emissions (BRSR lens)',
    '',
    'In BRSR reporting, emissions are tracked as:',
    '- **Scope 1** — direct fuel combustion / process emissions → control via fuel switching, efficiency, process redesign',
    '- **Scope 2** — purchased electricity/heat → control via renewable power, PPAs, on-site solar/wind, grid green tariffs',
    '- **Scope 3** — value chain (travel, logistics, purchased goods, etc.) → control via supplier engagement, logistics optimization, low-carbon materials',
    '',
    'Practical levers commonly disclosed in BRSR narratives:',
    '1. Measure baseline Scope 1/2/3 and set reduction targets',
    '2. Cut energy intensity (equipment upgrades, waste-heat recovery)',
    '3. Increase **renewable_energy_share**',
    '4. Electrify processes and reduce high-GWP fuels',
    '5. Engage suppliers on Scope 3 hotspots',
    '6. Disclose progress in BRSR (`ghg_reduction_projects` and related metrics)',
    '',
  ];

  if (samples.length) {
    lines.push('### Examples from indexed BRSR GHG reduction disclosures', '');
    for (const row of samples) {
      const snip = String(row.snippet || '').replace(/\s+/g, ' ').trim();
      lines.push(`- **${row.company}** (${row.year}): ${snip}${snip.length >= 300 ? '…' : ''}`);
    }
    lines.push('');
  } else if (retrievalSnippets.length) {
    lines.push('### Related BRSR snippets', '');
    for (const c of retrievalSnippets.slice(0, 4)) {
      const text = c.ghg_reduction_projects || c.text || c.waste_management_practices || '';
      if (!text) continue;
      lines.push(`- **${c.company}** (${c.year}): ${String(text).replace(/\s+/g, ' ').slice(0, 280)}`);
    }
    lines.push('');
  }

  lines.push(
    'Ask about a specific company for tailored actions, e.g. “What GHG reduction projects does Infosys report?” or “Infosys renewable energy share 2026”.',
    '',
    '_Guidance is grounded in BRSR metric structure and indexed disclosure text — not generic web advice._',
  );

  return lines.join('\n');
}
