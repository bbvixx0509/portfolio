import { pool } from '../server/db.js';
import { runMigrations } from '../server/migrations.js';

async function waitForDatabase(retries = 30) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      if (attempt === retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

const startedAt = Date.now();
try {
  await waitForDatabase();
  await runMigrations(pool);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    migration: 'FoodiGuard IRB schema',
    durationSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
  })}\n`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
