import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { resolveDbPath } from './paths.js';
import { lookupNseMetadata } from './report-sources.js';
import { extractMetricValuesFromRow, findMetricPages } from './page-index.js';

dotenv.config();

const DB_PATH = resolveDbPath();
const DB_DIR = path.dirname(DB_PATH);

// Ensure data directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

let dbInstance = null;

export async function getDb() {
  if (dbInstance) return dbInstance;

  if (process.env.VERCEL) {
    console.log("Initializing database using sql.js for Vercel...");
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();
    
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
    const sqlite3 = (await import('sqlite3')).default;
    const { open } = await import('sqlite');
    
    dbInstance = await open({
      filename: DB_PATH,
      driver: sqlite3.Database
    });
  }

  await initDb(dbInstance);
  return dbInstance;
}

async function initDb(db) {
  // Create reports metadata & structured data table with dedicated columns for querying
  await db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company TEXT NOT NULL,
      year INTEGER NOT NULL,
      filename TEXT,
      is_custom INTEGER DEFAULT 0,
      
      -- Numeric Metrics
      scope1_emissions REAL,
      scope1_unit TEXT,
      scope2_emissions REAL,
      scope2_unit TEXT,
      scope3_emissions REAL,
      scope3_unit TEXT,
      energy_consumption REAL,
      energy_unit TEXT,
      renewable_energy_consumption REAL,
      renewable_energy_unit TEXT,
      renewable_energy_share REAL,
      water_consumption REAL,
      water_consumption_unit TEXT,
      water_withdrawal REAL,
      water_withdrawal_unit TEXT,
      waste_generated REAL,
      waste_unit TEXT,
      
      -- New Premium ESG Features
      sector TEXT,
      industry TEXT,
      total_revenue REAL,
      emissions_intensity REAL,
      energy_intensity REAL,
      water_intensity REAL,
      waste_intensity REAL,
      female_employee_count REAL,
      female_employee_share REAL,
      female_board_share REAL,
      safety_ltifr REAL,
      water_discharge_recycled REAL,
      waste_recovered_recycled REAL,
      
      -- Qualitative Text Blocks
      ghg_reduction_projects TEXT,
      waste_management_practices TEXT,
      zero_liquid_discharge_details TEXT,
      
      data_json TEXT NOT NULL,
      pdf_url TEXT,
      xbrl_url TEXT,
      metric_pages_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company, year)
    )
  `);

  await ensureReportSourceColumns(db);
}

async function ensureReportSourceColumns(db) {
  const columns = await db.all('PRAGMA table_info(reports)');
  const names = new Set(columns.map((c) => c.name));
  const additions = [
    ['pdf_url', 'TEXT'],
    ['xbrl_url', 'TEXT'],
    ['metric_pages_json', 'TEXT'],
  ];

  for (const [name, type] of additions) {
    if (!names.has(name)) {
      await db.exec(`ALTER TABLE reports ADD COLUMN ${name} ${type}`);
    }
  }
}

export async function syncReportSourceUrls(company, year, filename) {
  const db = await getDb();
  const meta = lookupNseMetadata({ filename, company, year });
  if (!meta?.pdfUrl && !meta?.xbrlUrl) return null;

  await db.run(
    `UPDATE reports
     SET pdf_url = COALESCE(?, pdf_url),
         xbrl_url = COALESCE(?, xbrl_url)
     WHERE company = ? AND year = ?`,
    [meta.pdfUrl, meta.xbrlUrl, company, year],
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
            female_employee_share, female_board_share, safety_ltifr
     FROM reports WHERE company = ? AND year = ?`;

  let row = await db.get(selectSql, [company, year]);
  if (!row) return null;

  if (!row.pdf_url && !row.xbrl_url) {
    await syncReportSourceUrls(company, year, row.filename);
    row = await db.get(selectSql, [company, year]);
  }

  return row;
}

export async function ensureMetricPagesIndexed(company, year) {
  const row = await getReportSourceRow(company, year);
  if (!row?.pdf_url) return row;

  let existingPages = null;
  if (row.metric_pages_json) {
    try {
      existingPages = JSON.parse(row.metric_pages_json);
    } catch {
      existingPages = null;
    }
  }

  // Treat empty {} as "not yet indexed" so failed downloads can be retried later.
  if (existingPages && typeof existingPages === 'object' && Object.keys(existingPages).length > 0) {
    return row;
  }

  const metricValues = extractMetricValuesFromRow(row);
  if (Object.keys(metricValues).length === 0) return row;

  const pages = await findMetricPages(row.pdf_url, metricValues);
  // Only persist when we found at least one page (avoid locking in empty results from 404s).
  if (Object.keys(pages).length === 0) {
    return { ...row, metric_pages_json: row.metric_pages_json };
  }

  const db = await getDb();
  await db.run(
    'UPDATE reports SET metric_pages_json = ? WHERE company = ? AND year = ?',
    [JSON.stringify(pages), company, year],
  );

  return { ...row, metric_pages_json: JSON.stringify(pages) };
}

export async function getSourceRowsForReports(rows) {
  const sourceRowsByKey = new Map();
  const unique = new Map();

  for (const row of rows) {
    if (!row?.company || row.year == null) continue;
    unique.set(`${row.company}|${row.year}`, { company: row.company, year: row.year });
  }

  await Promise.all(
    [...unique.values()].map(async ({ company, year }) => {
      const sourceRow = await ensureMetricPagesIndexed(company, year);
      if (sourceRow) {
        sourceRowsByKey.set(`${company}|${year}`, sourceRow);
      }
    }),
  );

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
  
  const scope1 = metrics.scope1_emissions?.value ?? null;
  const scope1_unit = metrics.scope1_emissions?.unit ?? null;
  const scope2 = metrics.scope2_emissions?.value ?? null;
  const scope2_unit = metrics.scope2_emissions?.unit ?? null;
  const scope3 = metrics.scope3_emissions?.value ?? null;
  const scope3_unit = metrics.scope3_emissions?.unit ?? null;
  
  const energy = metrics.energy_consumption?.value ?? null;
  const energy_unit = metrics.energy_consumption?.unit ?? null;
  const renewable_energy = metrics.renewable_energy_consumption?.value ?? null;
  const renewable_energy_unit = metrics.renewable_energy_consumption?.unit ?? null;
  const renewable_share = metrics.renewable_energy_share?.value ?? null;
  
  const water_consumption = metrics.water_consumption?.value ?? null;
  const water_consumption_unit = metrics.water_consumption?.unit ?? null;
  const water_withdrawal = metrics.water_withdrawal?.value ?? null;
  const water_withdrawal_unit = metrics.water_withdrawal?.unit ?? null;
  
  const waste = metrics.waste_generated?.value ?? null;
  const waste_unit = metrics.waste_generated?.unit ?? null;
  
  // Premium features
  const sector = metrics.sector ?? null;
  const industry = metrics.industry ?? null;
  const total_revenue = metrics.total_revenue ?? null;
  const emissions_intensity = metrics.emissions_intensity ?? null;
  const energy_intensity = metrics.energy_intensity ?? null;
  const water_intensity = metrics.water_intensity ?? null;
  const waste_intensity = metrics.waste_intensity ?? null;
  const female_employee_count = metrics.female_employee_count ?? null;
  const female_employee_share = metrics.female_employee_share ?? null;
  const female_board_share = metrics.female_board_share ?? null;
  const safety_ltifr = metrics.safety_ltifr ?? null;
  const water_discharge_recycled = metrics.water_discharge_recycled ?? null;
  const waste_recovered_recycled = metrics.waste_recovered_recycled ?? null;
  
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
      female_employee_count, female_employee_share, female_board_share,
      safety_ltifr, water_discharge_recycled, waste_recovered_recycled,
      ghg_reduction_projects, waste_management_practices, zero_liquid_discharge_details,
      data_json
    ) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      female_employee_share = excluded.female_employee_share,
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
      female_employee_count, female_employee_share, female_board_share,
      safety_ltifr, water_discharge_recycled, waste_recovered_recycled,
      ghg_reduction_projects, waste_management_practices, zero_liquid_discharge_details,
      dataJson
    ]
  );
}

export async function deleteReport(company, year) {
  const db = await getDb();
  await db.run('DELETE FROM reports WHERE company = ? AND year = ?', [company, year]);
}

export async function getAvailableReports() {
  const db = await getDb();
  return db.all('SELECT company, year, filename, is_custom as isCustom FROM reports ORDER BY company, year DESC');
}

export async function getCompanyList() {
  const db = await getDb();
  const rows = await db.all('SELECT DISTINCT company FROM reports ORDER BY company');
  return rows.map(r => r.company);
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
