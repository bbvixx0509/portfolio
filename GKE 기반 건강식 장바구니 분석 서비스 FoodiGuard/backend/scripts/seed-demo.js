import { pool } from '../server/db.js';
import { seedDemoData } from '../server/demoSeed.js';

try {
  if (process.env.SEED_DEMO_DATA !== 'true') {
    throw new Error('Demo seed is disabled. Set SEED_DEMO_DATA=true only in a local demo environment.');
  }
  await seedDemoData(pool);
  process.stdout.write('{"ok":true,"seed":"FoodiGuard demo data"}\n');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
