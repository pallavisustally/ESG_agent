/**
 * Senior tester: verify indexed DB metric values against cited PDF pages.
 *
 * Usage:
 *   node agent/scripts/verify_pdf_sources.js
 *   node agent/scripts/verify_pdf_sources.js --company "Aarti Drugs Limited" --year 2023
 *   node agent/scripts/verify_pdf_sources.js --limit 20
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { getDb, ensureMetricPagesIndexed } from '../src/db.js';
import { verifySourceRowMetrics } from '../src/pdf-verifier.js';
import { resolveFromProject } from '../src/paths.js';

dotenv.config();

const OUT_DIR = resolveFromProject('data', 'citation_tests');

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { limit: 25, company: null, year: null };

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--limit' && args[i + 1]) parsed.limit = parseInt(args[++i], 10);
    if (args[i] === '--company' && args[i + 1]) parsed.company = args[++i];
    if (args[i] === '--year' && args[i + 1]) parsed.year = parseInt(args[++i], 10);
  }

  return parsed;
}

async function loadRows({ limit, company, year }) {
  const db = await getDb();

  if (company && year != null) {
    const row = await db.get(
      `SELECT company, year, pdf_url, metric_pages_json,
              scope1_emissions, scope2_emissions, scope3_emissions,
              energy_consumption, renewable_energy_share, water_consumption,
              water_withdrawal, waste_generated, total_revenue, emissions_intensity,
              energy_intensity, water_intensity, waste_intensity,
              female_employee_count, total_employee_count, female_employee_share,
              female_board_count, total_board_count, female_board_share, safety_ltifr
       FROM reports
       WHERE company = ? AND year = ?`,
      [company, year],
    );
    return row ? [row] : [];
  }

  return db.all(
    `SELECT company, year, pdf_url, metric_pages_json,
            scope1_emissions, scope2_emissions, scope3_emissions,
            energy_consumption, renewable_energy_share, water_consumption,
            water_withdrawal, waste_generated, total_revenue, emissions_intensity,
            energy_intensity, water_intensity, waste_intensity,
            female_employee_count, total_employee_count, female_employee_share,
            female_board_count, total_board_count, female_board_share, safety_ltifr
     FROM reports
     WHERE pdf_url IS NOT NULL AND pdf_url != ''
     ORDER BY year DESC, company ASC
     LIMIT ?`,
    [limit],
  );
}

async function run() {
  const args = parseArgs();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const rows = await loadRows(args);
  if (!rows.length) {
    console.log('No report rows found for verification.');
    return;
  }

  console.log(`Verifying ${rows.length} report(s) against PDF page text...\n`);

  const results = [];
  for (const row of rows) {
    const indexed = await ensureMetricPagesIndexed(row.company, row.year);
    const verification = await verifySourceRowMetrics(indexed || row);
    const pass = verification.summary.failed === 0;
    results.push({ ...verification, pass });

    console.log(
      `${pass ? 'PASS' : 'FAIL'} | ${verification.company} (${verification.year}) `
      + `verified=${verification.summary.verified} failed=${verification.summary.failed} skipped=${verification.summary.skipped}`,
    );

    for (const check of verification.checks.filter((c) => c.verified === false)) {
      console.log(`  - ${check.metric}=${check.value} page ${check.page}: ${check.status}`);
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const output = {
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: `${((passed / results.length) * 100).toFixed(1)}%`,
    results,
  };

  const jsonPath = path.join(OUT_DIR, 'pdf_source_verification.json');
  fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2));
  console.log(`\nPass rate: ${output.passRate}`);
  console.log(`Wrote ${jsonPath}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
