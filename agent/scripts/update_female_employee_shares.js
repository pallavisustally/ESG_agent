/**
 * Recompute female/male/total employee_* from XBRL headcount without wiping PDF/citation enrichment.
 * Prefer each filing's current-year headcount over another filing's previous-year fallback.
 * Usage: node agent/scripts/update_female_employee_shares.js
 */
import fs from 'fs';
import path from 'path';
import { XMLParser } from 'fast-xml-parser';
import dotenv from 'dotenv';
import { getDb } from '../src/db.js';
import { resolveXbrlDir } from '../src/paths.js';
import { normalizeReport } from './preprocess.js';

dotenv.config();

const XBRL_DIR = resolveXbrlDir();

function scanXmlFiles(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const item of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) scanXmlFiles(fullPath, files);
    else if (/\.(xml|xbrl)$/i.test(item)) files.push(fullPath);
  }
  return files;
}

async function main() {
  const db = await getDb();
  const files = scanXmlFiles(XBRL_DIR);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

  /** @type {Map<string, { company: string, year: number, metrics: any, priority: number }>} */
  const bestByKey = new Map();
  let parsedYears = 0;
  let errors = 0;

  console.log(`Scanning ${files.length} XBRL file(s) for employee gender headcount...`);

  for (const filePath of files) {
    try {
      const xmlContent = fs.readFileSync(filePath, 'utf-8');
      const parsed = parser.parse(xmlContent);
      const years = normalizeReport(parsed, filePath);
      if (!Array.isArray(years) || years.length === 0) continue;

      const filingCurrentYear = years[0]?.year;
      for (const report of years) {
        const { company, year, metrics } = report;
        if (!company || !year) continue;
        parsedYears += 1;

        const femaleCount = metrics.female_employee_count ?? null;
        const totalCount = metrics.total_employee_count ?? null;
        const femaleShare = metrics.female_employee_share ?? null;
        const maleCount = metrics.male_employee_count ?? null;
        const maleShare = metrics.male_employee_share ?? null;
        if (
          femaleShare == null && femaleCount == null && totalCount == null
          && maleCount == null && maleShare == null
        ) continue;

        // Current-year Section A headcount beats previous-year membership fallbacks.
        const priority = year === filingCurrentYear ? 2 : 1;
        const key = `${company}::${year}`;
        const prev = bestByKey.get(key);
        if (!prev || priority > prev.priority) {
          bestByKey.set(key, { company, year, metrics, priority });
        }
      }
    } catch (err) {
      errors += 1;
      console.error(`Error ${path.basename(filePath)}: ${err.message}`);
    }
  }

  let updated = 0;
  let missingRow = 0;
  let skipped = 0;

  for (const { company, year, metrics } of bestByKey.values()) {
    const femaleCount = metrics.female_employee_count ?? null;
    const totalCount = metrics.total_employee_count ?? null;
    const femaleShare = metrics.female_employee_share ?? null;
    const maleCount = metrics.male_employee_count ?? null;
    const maleShare = metrics.male_employee_share ?? null;

    const row = await db.get(
      'SELECT id, data_json FROM reports WHERE company = ? AND year = ?',
      [company, year],
    );
    if (!row) {
      missingRow += 1;
      continue;
    }

    let dataJson = row.data_json;
    try {
      const parsedJson = JSON.parse(row.data_json || '{}');
      parsedJson.metrics = parsedJson.metrics || {};
      if (femaleCount != null) parsedJson.metrics.female_employee_count = femaleCount;
      if (totalCount != null) parsedJson.metrics.total_employee_count = totalCount;
      if (femaleShare != null) parsedJson.metrics.female_employee_share = femaleShare;
      if (maleCount != null) parsedJson.metrics.male_employee_count = maleCount;
      if (maleShare != null) parsedJson.metrics.male_employee_share = maleShare;
      dataJson = JSON.stringify(parsedJson);
    } catch {
      // keep original data_json if it cannot be patched
    }

    await db.run(
      `UPDATE reports
       SET female_employee_count = ?,
           total_employee_count = ?,
           female_employee_share = ?,
           male_employee_count = ?,
           male_employee_share = ?,
           data_json = ?
       WHERE company = ? AND year = ?`,
      [femaleCount, totalCount, femaleShare, maleCount, maleShare, dataJson, company, year],
    );
    updated += 1;
  }

  const top = await db.all(
    `SELECT company, female_employee_share, female_employee_count, total_employee_count,
            male_employee_count, male_employee_share
     FROM reports
     WHERE year = 2025 AND female_employee_share IS NOT NULL AND total_employee_count >= 50
     ORDER BY female_employee_share DESC
     LIMIT 5`,
  );

  console.log(JSON.stringify({
    parsedYears,
    selected: bestByKey.size,
    updated,
    skipped,
    missingRow,
    errors,
    top5_2025: top,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
