import 'dotenv/config';
import { connectDb } from '../src/db';
import { runMigrations } from '../src/migrations';

const url = String(process.env.DATABASE_URL || '').trim();
if (!url) throw new Error('DATABASE_URL is required');

async function main() {
  const pool = connectDb(url);
  try {
    await runMigrations(pool);
    console.log('Migrations applied');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
