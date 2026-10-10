import { traceAsync, tracePoolConnect } from './requestTrace.js';

const requiredRelations = [
  'food_app_view',
  'users',
  'user_profiles',
  'user_allergies',
  'user_consents',
];

export function liveHealth() {
  return {
    ok: true,
    status: 'live',
    service: 'FoodiGuard API',
  };
}

export async function readyHealth(database, timeoutMs = 2000) {
  // In production this is a separate one-connection pool with short connect and
  // server statement timeouts. Never queue probes behind product searches.
  const client = database.connect ? await traceAsync('pool:readiness', () => tracePoolConnect(database, 'readiness', () => database.connect())) : database;
  let destroy = false;
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error('Database readiness check timed out');
      error.code = 'DB_READY_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });

  try {
    const result = await traceAsync('sql:readiness', () => Promise.race([
      client.query(`
        SELECT
          TO_REGCLASS('public.food_app_view')::TEXT AS food_app_view,
          TO_REGCLASS('public.users')::TEXT AS users,
          TO_REGCLASS('public.user_profiles')::TEXT AS user_profiles,
          TO_REGCLASS('public.user_allergies')::TEXT AS user_allergies,
          TO_REGCLASS('public.user_consents')::TEXT AS user_consents
      `),
      timeout,
    ]));
    const row = result.rows[0] || {};
    const missing = requiredRelations.filter((relation) => !row[relation]);
    if (missing.length) {
      const error = new Error(`Required database relations are missing: ${missing.join(', ')}`);
      error.code = 'DB_SCHEMA_NOT_READY';
      throw error;
    }

    return {
      ok: true,
      status: 'ready',
      service: 'FoodiGuard API',
      database: 'PostgreSQL (food DB)',
      schemaReady: true,
    };
  } catch (error) {
    destroy = error.code === 'DB_READY_TIMEOUT' || error.message === 'Query read timeout';
    throw error;
  } finally {
    clearTimeout(timeoutId);
    client.release?.(destroy);
  }
}

export function createReadinessCheck(database, timeoutMs = 1500) {
  let pending;
  return () => {
    if (!pending) pending = readyHealth(database, timeoutMs).finally(() => { pending = null; });
    return traceAsync('readiness_total', () => pending);
  };
}
