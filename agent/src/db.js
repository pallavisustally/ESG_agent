import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { resolveDbPath } from './paths.js';
import { lookupNseMetadata, isUsablePdfUrl } from './report-sources.js';
import { extractMetricValuesFromRow, findMetricPagesResult, isPdfMarkedUnavailable, PDF_UNAVAILABLE_MARKER } from './page-index.js';
import { coerceDbNumber, normalizeMetricObject } from './metric-coerce.js';
import {
  withCompanyListCache,
  invalidateCompanyCache,
} from './cache/company-cache.js';

dotenv.config();

const DB_PATH = resolveDbPath();
const DB_DIR = path.dirname(DB_PATH);

// Ensure data directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

let dbInstance = null;
let dbInitPromise = null;

export function isPostgres() {
  return Boolean(dbInstance?.dialect === 'postgres' || (!dbInstance && process.env.DATABASE_URL));
}

async function openSqliteNative() {
  const sqlite3 = (await import('sqlite3')).default;
  const { open } = await import('sqlite');
  const db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database,
  });
  db.dialect = 'sqlite';
  return db;
}

async function tryPostgresOrFallback() {
  const { createPgPool, PgDatabase } = await import('./pg-client.js');
  const { checkDbHealth, allowSqliteFallback, withDbRetry } = await import('./db-health.js');

  console.log('Initializing database using Neon Postgres (DATABASE_URL)...');
  const pool = createPgPool(process.env.DATABASE_URL);
  const pgDb = new PgDatabase(pool);

  try {
    await withDbRetry(async () => pgDb.get('SELECT 1 AS ok'), { label: 'postgres-connect', retries: 3 });
    const health = await checkDbHealth(pgDb);
    if (!health.ok) throw new Error(health.error || 'Postgres health check failed');
    console.log(`[DB] Postgres OK (${health.latencyMs}ms, companies=${health.companyCount ?? '?'})`);
    return pgDb;
  } catch (err) {
    console.error(`[DB] Postgres unavailable: ${err.message}`);
    try { await pool.end(); } catch { /* ignore */ }

    if (!allowSqliteFallback()) {
      throw new Error(
        `BRSR database (Neon) is unavailable: ${err.message}. `
        + 'Set ALLOW_SQLITE_FALLBACK=true for local SQLite fallback, or fix DATABASE_URL.',
      );
    }

    if (!fs.existsSync(DB_PATH)) {
      throw new Error(
        `Neon unavailable (${err.message}) and no local SQLite at ${DB_PATH}.`,
      );
    }

    console.warn(`[DB] Falling back to local SQLite: ${DB_PATH}`);
    const sqliteDb = await openSqliteNative();
    sqliteDb._fallbackFromPostgres = true;
    await checkDbHealth(sqliteDb);
    return sqliteDb;
  }
}

export async function getDb() {
  if (dbInstance) return dbInstance;
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = (async () => {
  if (process.env.DATABASE_URL) {
    dbInstance = await tryPostgresOrFallback();
  } else if (process.env.VERCEL) {
    console.log("Initializing database using sql.js for Vercel...");
    const initSqlJs = (await import('sql.js')).default;
    const path = (await import('path')).default;
    const wasmPath = path.resolve(process.cwd(), 'node_modules/sql.js/dist/sql-wasm.wasm');
    
    console.log(`Loading sql.js with wasmPath: ${wasmPath}`);
    const SQL = await initSqlJs({
      locateFile: () => wasmPath
    });
    
    let fileBuffer;
    if (fs.existsSync(DB_PATH)) {
      fileBuffer = fs.readFileSync(DB_PATH);
      console.log(`Loaded SQLite database from ${DB_PATH} (${fileBuffer.length} bytes)`);
    } else {
      fileBuffer = Buffer.alloc(0);
      console.log(`Database file not found at ${DB_PATH}. Initializing empty database.`);
    }
    
    const db = new SQL.Database(fileBuffer);
    
    class SqlJsWrapper {
      constructor(db, filePath) {
        this.db = db;
        this.filePath = filePath;
        this.dialect = 'sqlite';
      }

      async exec(sql) {
        this.db.run(sql);
        this.saveToDisk();
      }

      async all(sql, params = []) {
        const stmt = this.db.prepare(sql);
        stmt.bind(Array.isArray(params) ? params : [params]);
        const rows = [];
        while (stmt.step()) {
          rows.push(stmt.getAsObject());
        }
        stmt.free();
        return rows;
      }

      async get(sql, params = []) {
        const stmt = this.db.prepare(sql);
        stmt.bind(Array.isArray(params) ? params : [params]);
        let row = null;
        if (stmt.step()) {
          row = stmt.getAsObject();
        }
        stmt.free();
        return row;
      }

      async run(sql, params = []) {
        const stmt = this.db.prepare(sql);
        stmt.bind(Array.isArray(params) ? params : [params]);
        stmt.step();
        stmt.free();
        this.saveToDisk();
        return {
          changes: this.db.getRowsModified()
        };
      }

      saveToDisk() {
        if (this.filePath && !this.filePath.startsWith(':memory:')) {
          try {
            const data = this.db.export();
            const buffer = Buffer.from(data);
            fs.writeFileSync(this.filePath, buffer);
          } catch (err) {
            console.warn(`[SqlJsWrapper] Failed to write database to disk: ${err.message}`);
          }
        }
      }
    }

    dbInstance = new SqlJsWrapper(db, DB_PATH);
  } else {
    // Local: Use native sqlite3 driver
    dbInstance = await openSqliteNative();
  }

  await initDb(dbInstance);
  try {
    const { checkDbHealth } = await import('./db-health.js');
    await checkDbHealth(dbInstance);
  } catch { /* non-fatal */ }
  return dbInstance;
  })();

  try {
    return await dbInitPromise;
  } catch (err) {
    dbInitPromise = null;
    dbInstance = null;
    throw err;
  }
}

/** Reset cached DB (tests / after forced fallback). */
export function resetDbInstance() {
  dbInstance = null;
  dbInitPromise = null;
}

async function initDb(db) {
  const pg = db.dialect === 'postgres';
  const idCol = pg ? 'id SERIAL PRIMARY KEY' : 'id INTEGER PRIMARY KEY AUTOINCREMENT';
  const real = pg ? 'DOUBLE PRECISION' : 'REAL';
  const createdAt = pg
    ? 'created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP'
    : 'created_at DATETIME DEFAULT CURRENT_TIMESTAMP';

  // Create reports metadata & structured data table with dedicated columns for querying
  await db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      ${idCol},
      company TEXT NOT NULL,
      year INTEGER NOT NULL,
      filename TEXT,
      is_custom INTEGER DEFAULT 0,
      
      -- Numeric Metrics
      scope1_emissions ${real},
      scope1_unit TEXT,
      scope2_emissions ${real},
      scope2_unit TEXT,
      scope3_emissions ${real},
      scope3_unit TEXT,
      energy_consumption ${real},
      energy_unit TEXT,
      renewable_energy_consumption ${real},
      renewable_energy_unit TEXT,
      renewable_energy_share ${real},
      water_consumption ${real},
      water_consumption_unit TEXT,
      water_withdrawal ${real},
      water_withdrawal_unit TEXT,
      waste_generated ${real},
      waste_unit TEXT,
      
      -- New Premium ESG Features
      sector TEXT,
      industry TEXT,
      total_revenue ${real},
      emissions_intensity ${real},
      energy_intensity ${real},
      water_intensity ${real},
      waste_intensity ${real},
      female_employee_count ${real},
      total_employee_count ${real},
      female_employee_share ${real},
      male_employee_count ${real},
      male_employee_share ${real},
      female_board_count ${real},
      total_board_count ${real},
      female_board_share ${real},
      safety_ltifr ${real},
      water_discharge_recycled ${real},
      waste_recovered_recycled ${real},
      
      -- Qualitative Text Blocks
      ghg_reduction_projects TEXT,
      waste_management_practices TEXT,
      zero_liquid_discharge_details TEXT,
      
      data_json TEXT NOT NULL,
      pdf_url TEXT,
      xbrl_url TEXT,
      metric_pages_json TEXT,
      ${createdAt},
      UNIQUE(company, year)
    )
  `);

  await ensureReportSourceColumns(db);
  await ensureReportIndexes(db);

  const { initUserChatTables } = await import('./user-chats.js');
  await initUserChatTables(db);
}

async function ensureReportIndexes(db) {
  try {
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_reports_company ON reports(company)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_reports_sector ON reports(sector)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_reports_year ON reports(year)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_reports_company_year ON reports(company, year)`);
  } catch (err) {
    console.warn('[db] index creation skipped:', err.message);
  }
}

async function ensureReportSourceColumns(db) {
  const realType = db.dialect === 'postgres' ? 'DOUBLE PRECISION' : 'REAL';
  const additions = [
    ['pdf_url', 'TEXT'],
    ['xbrl_url', 'TEXT'],
    ['metric_pages_json', 'TEXT'],
    ['total_employee_count', realType],
    ['female_board_count', realType],
    ['total_board_count', realType],
    ['male_employee_count', realType],
    ['male_employee_share', realType],
  ];

  if (db.dialect === 'postgres') {
    for (const [name, type] of additions) {
      await db.exec(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS ${name} ${type}`);
    }
  } else {
    const columns = await db.all('PRAGMA table_info(reports)');
    const names = new Set(columns.map((c) => c.name));
    for (const [name, type] of additions) {
      if (!names.has(name)) {
        await db.exec(`ALTER TABLE reports ADD COLUMN ${name} ${type}`);
      }
    }
  }

  // SQLite: ROUND(x, 0). Postgres: ROUND only takes (numeric, int) — cast doubles.
  const roundExpr = db.dialect === 'postgres'
    ? 'ROUND((female_employee_count / (female_employee_share / 100.0))::numeric, 0)'
    : 'ROUND(female_employee_count / (female_employee_share / 100.0), 0)';

  await db.run(`
    UPDATE reports
    SET total_employee_count = ${roundExpr}
    WHERE total_employee_count IS NULL
      AND female_employee_count IS NOT NULL
      AND female_employee_share > 0
  `);

  // Backfill male headcount from total − female when XBRL male was never persisted.
  // Safe for BRSR two-way gender tables (Male + Female = Total).
  await db.run(`
    UPDATE reports
    SET male_employee_count = total_employee_count - female_employee_count
    WHERE male_employee_count IS NULL
      AND total_employee_count IS NOT NULL
      AND female_employee_count IS NOT NULL
      AND total_employee_count >= female_employee_count
  `);

  await db.run(`
    UPDATE reports
    SET male_employee_share = CASE
      WHEN total_employee_count > 0 AND male_employee_count IS NOT NULL
        THEN ROUND((male_employee_count * 100.0 / total_employee_count)${db.dialect === 'postgres' ? '::numeric' : ''}, 2)
      WHEN female_employee_share IS NOT NULL
        THEN ROUND((100.0 - female_employee_share)${db.dialect === 'postgres' ? '::numeric' : ''}, 2)
      ELSE male_employee_share
    END
    WHERE male_employee_share IS NULL
      AND (
        (total_employee_count > 0 AND male_employee_count IS NOT NULL)
        OR female_employee_share IS NOT NULL
      )
  `);
}

export async function syncReportSourceUrls(company, year, filename) {
  const db = await getDb();
  const meta = lookupNseMetadata({ filename, company, year });
  if (!meta?.pdfUrl && !meta?.xbrlUrl) return null;

  const pdfUrl = isUsablePdfUrl(meta.pdfUrl) ? meta.pdfUrl : null;
  await db.run(
    `UPDATE reports
     SET pdf_url = COALESCE(?, pdf_url),
         xbrl_url = COALESCE(?, xbrl_url)
     WHERE company = ? AND year = ?`,
    [pdfUrl, meta.xbrlUrl || null, company, year],
  );

  return meta;
}

export async function getReportSourceRow(company, year) {
  const db = await getDb();
  const selectSql = `SELECT company, year, filename, pdf_url, xbrl_url, metric_pages_json,
            scope1_emissions, scope2_emissions, scope3_emissions,
            energy_consumption, renewable_energy_share, water_consumption,
            water_withdrawal, waste_generated, total_revenue, emissions_intensity,
            energy_intensity, water_intensity, waste_intensity,
            female_employee_count, total_employee_count, female_employee_share,
            male_employee_count, male_employee_share,
            female_board_count, total_board_count, female_board_share, safety_ltifr
     FROM reports WHERE company = ? AND year = ?`;

  let row = await db.get(selectSql, [company, year]);
  if (!row) return null;

  if (!row.pdf_url && !row.xbrl_url) {
    await syncReportSourceUrls(company, year, row.filename);
    row = await db.get(selectSql, [company, year]);
  }

  return row;
}

const SHARE_METRICS_TO_REFRESH = [
  'female_employee_share',
  'male_employee_share',
  'female_board_share',
  'renewable_energy_share',
];

function stripUnavailableMarker(pages) {
  if (!pages || typeof pages !== 'object') return {};
  const out = { ...pages };
  delete out[PDF_UNAVAILABLE_MARKER];
  return out;
}

/** For citations: hide pdf_url when the PDF cannot be indexed. */
function rowForCitations(row, pages, pdfUnavailable) {
  if (!row) return row;
  if (pdfUnavailable || isPdfMarkedUnavailable(pages)) {
    return {
      ...row,
      pdf_url: null,
      metric_pages_json: null,
      pdf_unavailable: true,
    };
  }
  const cleanPages = stripUnavailableMarker(pages);
  if (Object.keys(cleanPages).length === 0) {
    return { ...row, metric_pages_json: row.metric_pages_json };
  }
  return {
    ...row,
    metric_pages_json: JSON.stringify(cleanPages),
  };
}

export async function ensureMetricPagesIndexed(company, year) {
  const row = await getReportSourceRow(company, year);
  if (!row?.pdf_url || !isUsablePdfUrl(row.pdf_url)) return row ? { ...row, pdf_url: isUsablePdfUrl(row.pdf_url) ? row.pdf_url : null } : row;

  let existingPages = null;
  if (row.metric_pages_json) {
    try {
      existingPages = JSON.parse(row.metric_pages_json);
    } catch {
      existingPages = null;
    }
  }

  // Previously failed to download/index — do not retry; no page citations.
  if (isPdfMarkedUnavailable(existingPages)) {
    return rowForCitations(row, existingPages, true);
  }

  const metricValues = extractMetricValuesFromRow(row);
  if (Object.keys(metricValues).length === 0) return row;

  let pages = existingPages && typeof existingPages === 'object' ? stripUnavailableMarker(existingPages) : {};
  let needsPersist = false;

  const hasIndexedPages = Object.keys(pages).length > 0;
  const onVercel = Boolean(process.env.VERCEL);
  // Chat on Vercel must stay under serverless time limits. PDF download + pdf.js
  // re-indexing (especially female_employee_share ranking for top-N companies)
  // routinely exceeds Hobby/Pro defaults and surfaces as HTTP 500 with no SSE.
  const allowPdfWorkOnVercel = process.env.VERCEL_INDEX_PDFS_ON_CHAT === 'true';

  // Already have page numbers from a prior index (e.g. local preprocess / committed DB).
  // On Vercel, NSE PDF downloads often fail — never wipe good pages just because a refresh failed.
  if (hasIndexedPages) {
    // Skip share-metric PDF refresh on Vercel — existing pages are good enough for citations.
    if (onVercel && !allowPdfWorkOnVercel) {
      return rowForCitations({ ...row, metric_pages_json: JSON.stringify(pages) }, pages, false);
    }

    // Optional best-effort share-metric refresh; ignore download failures.
    try {
      for (const metric of SHARE_METRICS_TO_REFRESH) {
        if (metricValues[metric] == null) continue;
        const { pages: refreshed, unavailable } = await findMetricPagesResult(
          row.pdf_url,
          { [metric]: metricValues[metric] },
          row,
        );
        if (unavailable) break;
        if (refreshed[metric] && pages[metric] !== refreshed[metric]) {
          pages[metric] = refreshed[metric];
          needsPersist = true;
        }
      }
    } catch {
      // Keep existing pages.
    }

    if (needsPersist && Object.keys(pages).length > 0) {
      const db = await getDb();
      await db.run(
        'UPDATE reports SET metric_pages_json = ? WHERE company = ? AND year = ?',
        [JSON.stringify(pages), company, year],
      );
      return rowForCitations({ ...row, metric_pages_json: JSON.stringify(pages) }, pages, false);
    }

    return rowForCitations({ ...row, metric_pages_json: JSON.stringify(pages) }, pages, false);
  }

  // First-time full index when nothing is stored yet.
  // On Vercel during chat, skip remote PDF fetch/parse — return row without page citations.
  if (onVercel && !allowPdfWorkOnVercel) {
    return rowForCitations(row, pages, false);
  }

  const { pages: indexed, unavailable } = await findMetricPagesResult(row.pdf_url, metricValues, row);
  if (unavailable) {
    // Do not persist unavailable permanently on ephemeral hosts — just skip citations this request.
    // (Persisting would poison /tmp DB copies and hide citations for the rest of the instance life.)
    if (!process.env.VERCEL) {
      const db = await getDb();
      const markerJson = JSON.stringify({ [PDF_UNAVAILABLE_MARKER]: true });
      await db.run(
        'UPDATE reports SET metric_pages_json = ? WHERE company = ? AND year = ?',
        [markerJson, company, year],
      );
    }
    return rowForCitations(row, { [PDF_UNAVAILABLE_MARKER]: true }, true);
  }

  pages = indexed;
  needsPersist = Object.keys(pages).length > 0;

  if (needsPersist) {
    const db = await getDb();
    await db.run(
      'UPDATE reports SET metric_pages_json = ? WHERE company = ? AND year = ?',
      [JSON.stringify(pages), company, year],
    );
    return rowForCitations({ ...row, metric_pages_json: JSON.stringify(pages) }, pages, false);
  }

  return rowForCitations(row, pages, false);
}

const PDF_INDEX_CONCURRENCY = parseInt(process.env.PDF_INDEX_CONCURRENCY, 10) || 3;

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

export async function getSourceRowsForReports(rows) {
  const sourceRowsByKey = new Map();
  const unique = new Map();

  for (const row of rows) {
    if (!row?.company || row.year == null) continue;
    unique.set(`${row.company}|${row.year}`, { company: row.company, year: row.year });
  }

  const uniqueRows = [...unique.values()];
  await mapWithConcurrency(uniqueRows, PDF_INDEX_CONCURRENCY, async ({ company, year }) => {
    const sourceRow = await ensureMetricPagesIndexed(company, year);
    if (sourceRow) {
      sourceRowsByKey.set(`${company}|${year}`, sourceRow);
    }
  });

  return sourceRowsByKey;
}

export async function insertReport(
  company, 
  year, 
  filename, 
  isCustom = 0, 
  dataJson = '{}',
  metrics = {},
  disclosures = {}
) {
  const db = await getDb();

  const s1 = normalizeMetricObject(metrics.scope1_emissions);
  const s2 = normalizeMetricObject(metrics.scope2_emissions);
  const s3 = normalizeMetricObject(metrics.scope3_emissions);
  const energyM = normalizeMetricObject(metrics.energy_consumption);
  const renewM = normalizeMetricObject(metrics.renewable_energy_consumption);
  const renewShareM = normalizeMetricObject(metrics.renewable_energy_share);
  const waterCM = normalizeMetricObject(metrics.water_consumption);
  const waterWM = normalizeMetricObject(metrics.water_withdrawal);
  const wasteM = normalizeMetricObject(metrics.waste_generated);

  const scope1 = s1?.value ?? null;
  const scope1_unit = s1?.unit ?? null;
  const scope2 = s2?.value ?? null;
  const scope2_unit = s2?.unit ?? null;
  const scope3 = s3?.value ?? null;
  const scope3_unit = s3?.unit ?? null;

  const energy = energyM?.value ?? null;
  const energy_unit = energyM?.unit ?? null;
  const renewable_energy = renewM?.value ?? null;
  const renewable_energy_unit = renewM?.unit ?? null;
  const renewable_share = renewShareM?.value ?? coerceDbNumber(metrics.renewable_energy_share?.value ?? metrics.renewable_energy_share);

  const water_consumption = waterCM?.value ?? null;
  const water_consumption_unit = waterCM?.unit ?? null;
  const water_withdrawal = waterWM?.value ?? null;
  const water_withdrawal_unit = waterWM?.unit ?? null;

  const waste = wasteM?.value ?? null;
  const waste_unit = wasteM?.unit ?? null;

  // Premium features
  const sector = metrics.sector ?? null;
  const industry = metrics.industry ?? null;
  const total_revenue = coerceDbNumber(metrics.total_revenue);
  const emissions_intensity = coerceDbNumber(metrics.emissions_intensity);
  const energy_intensity = coerceDbNumber(metrics.energy_intensity);
  const water_intensity = coerceDbNumber(metrics.water_intensity);
  const waste_intensity = coerceDbNumber(metrics.waste_intensity);
  const female_employee_count = coerceDbNumber(metrics.female_employee_count);
  const total_employee_count = coerceDbNumber(metrics.total_employee_count);
  const female_employee_share = coerceDbNumber(metrics.female_employee_share);
  let male_employee_count = coerceDbNumber(metrics.male_employee_count);
  let male_employee_share = coerceDbNumber(metrics.male_employee_share);
  // Persist residual male when XBRL omitted it but total + female are present.
  if (
    male_employee_count == null
    && total_employee_count != null
    && female_employee_count != null
    && total_employee_count >= female_employee_count
  ) {
    male_employee_count = Math.round((total_employee_count - female_employee_count) * 100) / 100;
  }
  if (male_employee_share == null && total_employee_count > 0 && male_employee_count != null) {
    male_employee_share = Math.round((male_employee_count / total_employee_count) * 10000) / 100;
  } else if (male_employee_share == null && female_employee_share != null) {
    male_employee_share = Math.round((100 - female_employee_share) * 100) / 100;
  }
  const female_board_count = coerceDbNumber(metrics.female_board_count);
  const total_board_count = coerceDbNumber(metrics.total_board_count);
  const female_board_share = coerceDbNumber(metrics.female_board_share);
  const safety_ltifr = coerceDbNumber(metrics.safety_ltifr);
  const water_discharge_recycled = coerceDbNumber(
    metrics.water_discharge_recycled?.value ?? metrics.water_discharge_recycled,
  );
  const waste_recovered_recycled = coerceDbNumber(
    metrics.waste_recovered_recycled?.value ?? metrics.waste_recovered_recycled,
  );
  
  const ghg_reduction_projects = disclosures.ghg_reduction_projects ?? null;
  const waste_management_practices = disclosures.waste_management_practices ?? null;
  const zero_liquid_discharge_details = disclosures.zero_liquid_discharge_details ?? null;

  await db.run(
    `INSERT INTO reports (
      company, year, filename, is_custom,
      scope1_emissions, scope1_unit,
      scope2_emissions, scope2_unit,
      scope3_emissions, scope3_unit,
      energy_consumption, energy_unit,
      renewable_energy_consumption, renewable_energy_unit,
      renewable_energy_share,
      water_consumption, water_consumption_unit,
      water_withdrawal, water_withdrawal_unit,
      waste_generated, waste_unit,
      sector, industry, total_revenue,
      emissions_intensity, energy_intensity, water_intensity, waste_intensity,
      female_employee_count, total_employee_count, female_employee_share,
      male_employee_count, male_employee_share,
      female_board_count, total_board_count, female_board_share,
      safety_ltifr, water_discharge_recycled, waste_recovered_recycled,
      ghg_reduction_projects, waste_management_practices, zero_liquid_discharge_details,
      data_json
    ) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(company, year) DO UPDATE SET 
      filename = excluded.filename,
      is_custom = excluded.is_custom,
      scope1_emissions = excluded.scope1_emissions,
      scope1_unit = excluded.scope1_unit,
      scope2_emissions = excluded.scope2_emissions,
      scope2_unit = excluded.scope2_unit,
      scope3_emissions = excluded.scope3_emissions,
      scope3_unit = excluded.scope3_unit,
      energy_consumption = excluded.energy_consumption,
      energy_unit = excluded.energy_unit,
      renewable_energy_consumption = excluded.renewable_energy_consumption,
      renewable_energy_unit = excluded.renewable_energy_unit,
      renewable_energy_share = excluded.renewable_energy_share,
      water_consumption = excluded.water_consumption,
      water_consumption_unit = excluded.water_consumption_unit,
      water_withdrawal = excluded.water_withdrawal,
      water_withdrawal_unit = excluded.water_withdrawal_unit,
      waste_generated = excluded.waste_generated,
      waste_unit = excluded.waste_unit,
      sector = excluded.sector,
      industry = excluded.industry,
      total_revenue = excluded.total_revenue,
      emissions_intensity = excluded.emissions_intensity,
      energy_intensity = excluded.energy_intensity,
      water_intensity = excluded.water_intensity,
      waste_intensity = excluded.waste_intensity,
      female_employee_count = excluded.female_employee_count,
      total_employee_count = excluded.total_employee_count,
      female_employee_share = excluded.female_employee_share,
      male_employee_count = excluded.male_employee_count,
      male_employee_share = excluded.male_employee_share,
      female_board_count = excluded.female_board_count,
      total_board_count = excluded.total_board_count,
      female_board_share = excluded.female_board_share,
      safety_ltifr = excluded.safety_ltifr,
      water_discharge_recycled = excluded.water_discharge_recycled,
      waste_recovered_recycled = excluded.waste_recovered_recycled,
      ghg_reduction_projects = excluded.ghg_reduction_projects,
      waste_management_practices = excluded.waste_management_practices,
      zero_liquid_discharge_details = excluded.zero_liquid_discharge_details,
      data_json = excluded.data_json,
      created_at = CURRENT_TIMESTAMP`,
    [
      company, year, filename, isCustom,
      scope1, scope1_unit,
      scope2, scope2_unit,
      scope3, scope3_unit,
      energy, energy_unit,
      renewable_energy, renewable_energy_unit,
      renewable_share,
      water_consumption, water_consumption_unit,
      water_withdrawal, water_withdrawal_unit,
      waste, waste_unit,
      sector, industry, total_revenue,
      emissions_intensity, energy_intensity, water_intensity, waste_intensity,
      female_employee_count, total_employee_count, female_employee_share,
      male_employee_count, male_employee_share,
      female_board_count, total_board_count, female_board_share,
      safety_ltifr, water_discharge_recycled, waste_recovered_recycled,
      ghg_reduction_projects, waste_management_practices, zero_liquid_discharge_details,
      dataJson
    ]
  );
  invalidateCompanyCache();
}

export async function deleteReport(company, year) {
  const db = await getDb();
  await db.run('DELETE FROM reports WHERE company = ? AND year = ?', [company, year]);
  invalidateCompanyCache();
}

export async function getAvailableReports() {
  const db = await getDb();
  return db.all('SELECT company, year, filename, is_custom as isCustom FROM reports ORDER BY company, year DESC');
}

export async function getCompanyList() {
  return withCompanyListCache(async () => {
    const db = await getDb();
    const rows = await db.all('SELECT DISTINCT company FROM reports ORDER BY company');
    return rows.map((r) => r.company);
  });
}

export async function getReportData(company, year) {
  const db = await getDb();
  let row = await db.get('SELECT data_json FROM reports WHERE company = ? AND year = ?', [company, year]);
  if (!row) {
    row = await db.get(
      `SELECT data_json FROM reports
       WHERE lower(company) LIKE '%' || lower(?) || '%' AND year = ?
       ORDER BY length(company) ASC
       LIMIT 1`,
      [company, year],
    );
  }
  return row ? JSON.parse(row.data_json) : null;
}

export async function resolveCompanyYear(company, year) {
  const db = await getDb();
  let row = await db.get(
    'SELECT company, year FROM reports WHERE company = ? AND year = ?',
    [company, year],
  );
  if (row) return row;

  row = await db.get(
    `SELECT company, year FROM reports
     WHERE lower(company) LIKE '%' || lower(?) || '%' AND year = ?
     ORDER BY length(company) ASC
     LIMIT 1`,
    [company, year],
  );
  return row || null;
}
