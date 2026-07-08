/**
 * Backfill report PDF/XBRL URLs and optional page indexes for cited metrics.
 *
 * Usage:
 *   node agent/scripts/enrich_report_sources.js
 *   node agent/scripts/enrich_report_sources.js --limit 50
 *   node agent/scripts/enrich_report_sources.js --with-pages --limit 10
 */

import dotenv from 'dotenv';
import { getDb, syncReportSourceUrls, ensureMetricPagesIndexed } from '../src/db.js';

dotenv.config();

function parseArgs() {
  const args = process.argv.slice(2);
  let limit = Infinity;
  let withPages = false;

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[++i], 10);
    } else if (args[i] === '--with-pages') {
      withPages = true;
    }
  }

  return { limit, withPages };
}

async function run() {
  const { limit, withPages } = parseArgs();
  const db = await getDb();
  const rows = await db.all(
    `SELECT company, year, filename, pdf_url, metric_pages_json
     FROM reports
     ORDER BY year DESC, company
     LIMIT ?`,
    [Number.isFinite(limit) ? limit : 1000000],
  );

  console.log(`Enriching ${rows.length} report(s)...`);

  let urlsUpdated = 0;
  let pagesIndexed = 0;

  for (const row of rows) {
    const beforeUrl = row.pdf_url;
    await syncReportSourceUrls(row.company, row.year, row.filename);

    const refreshed = await db.get(
      'SELECT pdf_url, metric_pages_json FROM reports WHERE company = ? AND year = ?',
      [row.company, row.year],
    );

    if (!beforeUrl && refreshed?.pdf_url) urlsUpdated += 1;

    if (withPages && refreshed?.pdf_url && !refreshed.metric_pages_json) {
      await ensureMetricPagesIndexed(row.company, row.year);
      pagesIndexed += 1;
      console.log(`  Indexed pages: ${row.company} (${row.year})`);
    }
  }

  console.log(`Done. URLs added/updated: ${urlsUpdated}, page indexes built: ${pagesIndexed}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
