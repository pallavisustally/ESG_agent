#!/usr/bin/env node
/**
 * Copy local SQLite data/database.db → Neon Postgres (DATABASE_URL).
 *
 * Usage:
 *   npm run migrate:postgres
 *   npm run migrate:postgres -- --dry-run
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { createPgPool, PgDatabase } from '../src/pg-client.js';
import { resolveDbPath } from '../src/paths.js';

dotenv.config();

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH = Math.max(1, parseInt(process.env.MIGRATE_BATCH_SIZE || '25', 10));

async function openSqlite() {
  const dbPath = resolveDbPath();
  if (!fs.existsSync(dbPath)) {
    throw new Error(`SQLite file not found: ${dbPath}`);
  }
  return open({ filename: dbPath, driver: sqlite3.Database });
}

async function ensurePostgresSchema(pg) {
  // Reuse app schema init without caching a global dbInstance.
  process.env.DATABASE_URL = process.env.DATABASE_URL;
  const idCol = 'id SERIAL PRIMARY KEY';
  const real = 'DOUBLE PRECISION';
  const createdAt = 'created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP';

  await pg.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      ${idCol},
      company TEXT NOT NULL,
      year INTEGER NOT NULL,
      filename TEXT,
      is_custom INTEGER DEFAULT 0,
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

  await pg.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      google_id TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      name TEXT,
      picture TEXT,
      ${createdAt}
    )
  `);

  await pg.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      history_json TEXT NOT NULL,
      memory_json TEXT,
      updated_at BIGINT NOT NULL,
      ${createdAt}
    )
  `);

  await pg.exec(`
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_updated
    ON chat_sessions(user_id, updated_at DESC)
  `);
}

const REPORT_COLUMNS = [
  'company', 'year', 'filename', 'is_custom',
  'scope1_emissions', 'scope1_unit', 'scope2_emissions', 'scope2_unit',
  'scope3_emissions', 'scope3_unit', 'energy_consumption', 'energy_unit',
  'renewable_energy_consumption', 'renewable_energy_unit', 'renewable_energy_share',
  'water_consumption', 'water_consumption_unit', 'water_withdrawal', 'water_withdrawal_unit',
  'waste_generated', 'waste_unit', 'sector', 'industry', 'total_revenue',
  'emissions_intensity', 'energy_intensity', 'water_intensity', 'waste_intensity',
  'female_employee_count', 'total_employee_count', 'female_employee_share',
  'male_employee_count', 'male_employee_share',
  'female_board_count', 'total_board_count', 'female_board_share',
  'safety_ltifr', 'water_discharge_recycled', 'waste_recovered_recycled',
  'ghg_reduction_projects', 'waste_management_practices', 'zero_liquid_discharge_details',
  'data_json', 'pdf_url', 'xbrl_url', 'metric_pages_json',
];

const NUMERIC_COLUMNS = new Set([
  'year', 'is_custom',
  'scope1_emissions', 'scope2_emissions', 'scope3_emissions',
  'energy_consumption', 'renewable_energy_consumption', 'renewable_energy_share',
  'water_consumption', 'water_withdrawal', 'waste_generated',
  'total_revenue', 'emissions_intensity', 'energy_intensity', 'water_intensity', 'waste_intensity',
  'female_employee_count', 'total_employee_count', 'female_employee_share',
  'male_employee_count', 'male_employee_share',
  'female_board_count', 'total_board_count', 'female_board_share',
  'safety_ltifr', 'water_discharge_recycled', 'waste_recovered_recycled',
]);

function coerceValue(column, value) {
  if (value == null) return null;
  if (column === 'data_json' || column === 'metric_pages_json') {
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
  if (NUMERIC_COLUMNS.has(column)) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }
  return value;
}

async function migrateReports(sqlite, pg) {
  const rows = await sqlite.all(`SELECT ${REPORT_COLUMNS.join(', ')} FROM reports`);
  console.log(`Reports in SQLite: ${rows.length}`);
  if (DRY_RUN || rows.length === 0) return rows.length;

  const placeholders = REPORT_COLUMNS.map(() => '?').join(', ');
  const updates = REPORT_COLUMNS
    .filter((c) => c !== 'company' && c !== 'year')
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(', ');

  const sql = `
    INSERT INTO reports (${REPORT_COLUMNS.join(', ')})
    VALUES (${placeholders})
    ON CONFLICT (company, year) DO UPDATE SET ${updates}
  `;

  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    for (const row of batch) {
      const values = REPORT_COLUMNS.map((c) => coerceValue(c, row[c]));
      await pg.run(sql, values);
    }
    done += batch.length;
    console.log(`  migrated reports ${done}/${rows.length}`);
  }
  return rows.length;
}

async function migrateUsersAndChats(sqlite, pg) {
  let users = [];
  try {
    users = await sqlite.all('SELECT id, google_id, email, name, picture FROM users');
  } catch {
    console.log('No users table in SQLite — skipping users/chats');
    return { users: 0, chats: 0 };
  }

  console.log(`Users in SQLite: ${users.length}`);
  if (DRY_RUN) {
    let chats = 0;
    try {
      const rows = await sqlite.all('SELECT COUNT(*) AS c FROM chat_sessions');
      chats = rows[0]?.c || 0;
    } catch { /* ignore */ }
    return { users: users.length, chats };
  }

  const idMap = new Map();
  for (const u of users) {
    await pg.run(
      `INSERT INTO users (google_id, email, name, picture)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (google_id) DO UPDATE SET
         email = EXCLUDED.email,
         name = EXCLUDED.name,
         picture = EXCLUDED.picture`,
      [u.google_id, u.email, u.name, u.picture],
    );
    const created = await pg.get('SELECT id FROM users WHERE google_id = ?', [u.google_id]);
    idMap.set(u.id, created.id);
  }

  let chats = [];
  try {
    chats = await sqlite.all(
      'SELECT id, user_id, title, history_json, memory_json, updated_at FROM chat_sessions',
    );
  } catch {
    try {
      chats = await sqlite.all(
        'SELECT id, user_id, title, history_json, updated_at FROM chat_sessions',
      );
    } catch {
      return { users: users.length, chats: 0 };
    }
  }

  console.log(`Chat sessions in SQLite: ${chats.length}`);
  for (const s of chats) {
    const newUserId = s.user_id == null ? null : idMap.get(s.user_id);
    if (s.user_id != null && !newUserId) continue;
    await pg.run(
      `INSERT INTO chat_sessions (id, user_id, title, history_json, memory_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         history_json = EXCLUDED.history_json,
         memory_json = COALESCE(EXCLUDED.memory_json, chat_sessions.memory_json),
         updated_at = EXCLUDED.updated_at,
         user_id = EXCLUDED.user_id`,
      [s.id, newUserId, s.title, s.history_json, s.memory_json || null, s.updated_at],
    );
  }

  return { users: users.length, chats: chats.length };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('Set DATABASE_URL in .env first');
  }

  console.log(`Source SQLite: ${resolveDbPath()}`);
  console.log(`Target: Neon Postgres${DRY_RUN ? ' (dry-run)' : ''}`);

  const sqlite = await openSqlite();
  const pool = createPgPool();
  const pg = new PgDatabase(pool);

  try {
    await ensurePostgresSchema(pg);
    const reportCount = await migrateReports(sqlite, pg);
    const { users, chats } = await migrateUsersAndChats(sqlite, pg);

    if (!DRY_RUN) {
      const pgReports = await pg.get('SELECT COUNT(*)::int AS c FROM reports');
      console.log(`\nDone. Postgres reports: ${pgReports.c} (copied ${reportCount})`);
      console.log(`Users: ${users}, chat sessions: ${chats}`);
    } else {
      console.log(`\nDry-run OK. Would copy reports=${reportCount}, users=${users}, chats=${chats}`);
    }
  } finally {
    await sqlite.close();
    await pg.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
