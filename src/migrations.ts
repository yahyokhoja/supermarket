import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';

export async function runMigrations(pool: Pool, migrationsDir = path.join(process.cwd(), 'migrations')) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const baseline = await pool.query<{ exists: boolean }>("SELECT to_regclass('public.users') IS NOT NULL AS exists");
  if (!baseline.rows[0]?.exists) {
    throw new Error('Baseline schema is missing. Create the legacy baseline before applying versioned migrations.');
  }

  const files = (await readdir(migrationsDir)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  for (const file of files) {
    const applied = await pool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
    if (applied.rowCount) continue;
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

