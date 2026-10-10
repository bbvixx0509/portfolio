import assert from 'node:assert/strict';
import test from 'node:test';

import { liveHealth, readyHealth, createReadinessCheck } from './health.js';

test('liveness does not depend on the database', () => {
  assert.deepEqual(liveHealth(), {
    ok: true,
    status: 'live',
    service: 'FoodiGuard API',
  });
});

test('readiness passes when the database and required schema are available', async () => {
  const database = {
    async query() {
      return {
        rows: [{
          food_app_view: 'food_app_view',
          users: 'users',
          user_profiles: 'user_profiles',
          user_allergies: 'user_allergies',
          user_consents: 'user_consents',
        }],
      };
    },
  };

  const result = await readyHealth(database, 100);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'ready');
  assert.equal(result.schemaReady, true);
});

test('readiness fails when a required relation is missing', async () => {
  const database = {
    async query() {
      return {
        rows: [{
          food_app_view: 'food_app_view',
          users: 'users',
          user_profiles: null,
          user_allergies: 'user_allergies',
          user_consents: 'user_consents',
        }],
      };
    },
  };

  await assert.rejects(
    readyHealth(database, 100),
    (error) => error.code === 'DB_SCHEMA_NOT_READY',
  );
});

test('readiness has a bounded timeout', async () => {
  const database = { query: () => new Promise(() => {}) };
  await assert.rejects(
    readyHealth(database, 5),
    (error) => error.code === 'DB_READY_TIMEOUT',
  );
});

test('timed-out readiness destroys its client and overlapping probes share a check', async () => {
  let calls=0, destroyed=false;
  const database={ connect: async () => ({
    query: () => { calls++; return new Promise(() => {}); },
    release: (destroy) => { destroyed=destroy; },
  }) };
  const check=createReadinessCheck(database,5);
  const a=check(),b=check();
  assert.equal(a,b);
  await assert.rejects(a,{code:'DB_READY_TIMEOUT'});
  assert.equal(calls,1);
  assert.equal(destroyed,true);
});
