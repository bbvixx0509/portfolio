import { ensureAuthSchema } from './auth.js';
import { ensureDataSchema } from './schema.js';

export async function runMigrations(database) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await ensureDataSchema(client);
    await ensureAuthSchema(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
