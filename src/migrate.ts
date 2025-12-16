import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { pool } from './db';

async function run() {
  const dir = join(__dirname, '..', 'sql');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const fullPath = join(dir, file);
    const sql = readFileSync(fullPath, 'utf8');
    // eslint-disable-next-line no-console
    console.log(`Running migration: ${file}`);
    await pool.query(sql);
  }

  await pool.end();
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Migration failed', err);
  process.exit(1);
});


