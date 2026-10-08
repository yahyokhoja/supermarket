import 'dotenv/config';
import { connectDb, initDb } from '../src/db';

const url = String(process.env.DATABASE_URL || '').trim();
if (!url) throw new Error('DATABASE_URL is required');

async function main() {
  const pool = connectDb(url);
  try {
    const existing = await pool.query<{ exists: boolean }>("SELECT to_regclass('public.users') IS NOT NULL AS exists");
    if (existing.rows[0]?.exists) {
      throw new Error('Baseline tables already exist; refusing to bootstrap over an existing database');
    }
    await initDb(pool);
    console.log('Legacy baseline created. Apply versioned migrations next.');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
