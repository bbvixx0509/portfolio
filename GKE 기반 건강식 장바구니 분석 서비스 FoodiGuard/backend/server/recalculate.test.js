import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PGlite } from '@electric-sql/pglite';

const exec = promisify(execFile);
const backend = fileURLToPath(new URL('../', import.meta.url));

test('recalculation CLI applies atomically per batch and repeats without duplicate allergens', async (t) => {
  // Disposable fixture only. Never connects to the developer's or production DB.
  const directory = await mkdtemp(path.join(tmpdir(), 'foodiguard-recalc-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = await PGlite.create(directory);
  try {
    await db.exec(`CREATE TABLE food_products(id bigint PRIMARY KEY,name text,allergen_codes varchar[],updated_at timestamptz);
      CREATE TABLE ingredient_source_rows(id bigint PRIMARY KEY,updated_at timestamptz);
      CREATE TABLE food_ingredients(food_id bigint,source_row_id bigint,ingredient_name text,ordinal int);
      CREATE TABLE food_allergens(food_id bigint,allergen_code varchar,presence_status varchar,
        UNIQUE(food_id,allergen_code,presence_status));
      CREATE TABLE sync_runs(id bigserial PRIMARY KEY,source_type varchar,mode varchar,status varchar,
        started_at timestamptz DEFAULT NOW(),finished_at timestamptz,read_count int,inserted_count int,
        updated_count int,matched_count int,unmatched_count int,error_message text,metadata jsonb);
      INSERT INTO food_products VALUES(1,'메밀국수',ARRAY[]::varchar[],'2020-01-01');
      INSERT INTO ingredient_source_rows VALUES(1,'2020-01-01');
      INSERT INTO food_ingredients VALUES(1,1,'메밀가루',1);
      CREATE FUNCTION reject_fixture_insert() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'intentional fixture failure'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_fixture BEFORE INSERT ON food_allergens FOR EACH ROW EXECUTE FUNCTION reject_fixture_insert();`);
  } finally { await db.close(); }
  const invoke = (args) => exec(process.execPath, ['scripts/recalculate-allergens.js', ...args], {
    cwd: backend, timeout: 15000, env: { ...process.env, LOCAL_PGLITE: 'true',
      LOCAL_PGLITE_PATH: directory, ALLERGEN_REPORT_PATH: '', ALLERGEN_BATCH_SIZE: '1' },
  });
  const dry = await invoke(['--incremental']);
  assert.equal(JSON.parse(dry.stdout).changed, 1);
  await assert.rejects(invoke(['--apply', '--incremental']).then((result) => {
    throw new Error('Expected failure exit code, received success: ' + result.stdout);
  }), (error) => {
    if (typeof error.stdout !== 'string') throw error;
    assert.match(error.stdout, /intentional fixture failure/);
    return error.code === 1;
  });
  const failed = await PGlite.create(directory);
  try {
    assert.deepEqual((await failed.query('SELECT allergen_codes FROM food_products')).rows, [{allergen_codes:[]}],
      'failure after product update rolls back that update too');
    assert.deepEqual((await failed.query('SELECT status FROM sync_runs')).rows, [{status:'failed'}]);
    await failed.exec('DROP TRIGGER reject_fixture ON food_allergens');
  } finally { await failed.close(); }
  const first = await invoke(['--apply', '--incremental']);
  assert.match(first.stdout, /"changed": 1/);
  const second = await invoke(['--apply', '--incremental']);
  assert.match(second.stdout, /"changed": 0/);
  const check = await PGlite.create(directory);
  try {
    assert.deepEqual((await check.query('SELECT allergen_code FROM food_allergens')).rows, [{ allergen_code: 'BUCKWHEAT' }]);
    const runs = (await check.query('SELECT status,updated_count FROM sync_runs ORDER BY id')).rows;
    assert.deepEqual(runs, [{status:'failed',updated_count:1}, {status:'completed',updated_count:1}, {status:'completed',updated_count:0}]);
  } finally { await check.close(); }
});
