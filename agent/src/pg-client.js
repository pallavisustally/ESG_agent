import pg from 'pg';

const { Pool } = pg;

/**
 * Convert SQLite-style `?` placeholders to Postgres `$1, $2, ...`.
 */
export function toPgQuery(sql, params = []) {
  const values = Array.isArray(params) ? params : [params];
  let i = 0;
  const text = String(sql).replace(/\?/g, () => `$${++i}`);
  return { text, values };
}

/**
 * Thin wrapper so the rest of the app can keep using db.all / db.get / db.run / db.exec.
 */
export class PgDatabase {
  constructor(pool) {
    this.pool = pool;
    this.dialect = 'postgres';
  }

  async _query(sql, params = []) {
    const { withDbRetry } = await import('./db-health.js');
    const { text, values } = toPgQuery(sql, params);
    return withDbRetry(
      async () => this.pool.query(text, values),
      { label: 'pg-query', retries: parseInt(process.env.DB_RETRY_COUNT, 10) || 3 },
    );
  }

  async exec(sql) {
    await this._query(sql, []);
  }

  async all(sql, params = []) {
    const result = await this._query(sql, params);
    return result.rows;
  }

  async get(sql, params = []) {
    const rows = await this.all(sql, params);
    return rows[0] || null;
  }

  async run(sql, params = []) {
    const result = await this._query(sql, params);
    return { changes: result.rowCount ?? 0 };
  }

  async end() {
    await this.pool.end();
  }
}

export function createPgPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  // Avoid pg v9 sslmode warning: pass ssl explicitly and strip sslmode from URL.
  const url = connectionString
    .replace(/([?&])sslmode=[^&]*/i, '$1')
    .replace(/[?&]$/, '')
    .replace(/\?&/, '?');

  return new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: parseInt(process.env.PG_POOL_MAX || '10', 10),
  });
}
