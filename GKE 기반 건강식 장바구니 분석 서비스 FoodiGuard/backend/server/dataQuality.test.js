import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { loadDataQuality, requiredSyncSources } from './dataQuality.js';
import { latestSuccessfulWatermark, acquireSyncLock, releaseSyncLock, PRODUCT_CHANGED_IN_WINDOW } from './syncRuns.js';

test('quality SQL keeps source freshness separate and handles no successful run', async (t) => {
  const db=new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE TABLE food_products (active boolean, ingredient_status text,
    energy_kcal numeric, carbohydrate_g numeric, protein_g numeric, fat_g numeric, sugar_g numeric, sodium_mg numeric);
    INSERT INTO food_products VALUES (true,'MATCHED',1,1,1,1,1,1), (true,'matched',1,1,1,1,1,NULL);
    CREATE TABLE sync_runs (id bigint, source_type varchar, status varchar, started_at timestamptz, finished_at timestamptz);
    INSERT INTO sync_runs VALUES
      (1,'allergen_projection','completed','2026-08-01 00:00Z','2026-08-01 00:05Z'),
      (2,'other_import','completed',NOW(),NOW()),
      (3,'allergen_projection','failed',NOW(),NOW());`);
  const result=await loadDataQuality((_op,sql,values) => db.query(sql,values), ['allergen_projection','food_import']);
  assert.equal(result.quality.matchRatio,1);
  assert.equal(result.quality.missingRatio,0.5);
  assert.equal(result.quality.lastSuccessAt,Date.parse('2026-08-01T00:05:00Z')/1000);
  assert.equal(result.sync.find((r) => r.source_type==='allergen_projection').failures,1);
  assert.equal(result.sync.find((r) => r.source_type==='food_import').last_success,null);
  assert.equal(new Date(await latestSuccessfulWatermark(db,'allergen_projection')).toISOString(),'2026-08-01T00:00:00.000Z');
});

test('sync source metric labels are explicitly bounded', () => {
  assert.deepEqual(requiredSyncSources('allergen_projection,food_import,food_import'), ['allergen_projection','food_import']);
  assert.throws(() => requiredSyncSources('user@example.com'));
  assert.throws(() => requiredSyncSources(''));
});

test('incremental window revisits changes made during the prior run and defers newer changes', async (t) => {
  const db=new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE TABLE food_products(id bigint,updated_at timestamptz);
    CREATE TABLE food_ingredients(food_id bigint,source_row_id bigint);
    CREATE TABLE ingredient_source_rows(id bigint,updated_at timestamptz);
    INSERT INTO food_products VALUES (1,'2026-08-01 00:02Z'),(2,'2026-07-31 00:00Z'),(3,'2026-08-02 00:00Z'),(4,'2026-07-31 00:00Z');
    INSERT INTO ingredient_source_rows VALUES(10,'2026-08-01 00:03Z');
    INSERT INTO food_ingredients VALUES(4,10);`);
  const result=await db.query(`SELECT id FROM food_products p WHERE p.id > $1 AND ${PRODUCT_CHANGED_IN_WINDOW} ORDER BY id LIMIT $2`,
    [0,100,'2026-08-01T00:00:00Z','2026-08-02T00:00:00Z']);
  assert.deepEqual(result.rows.map((r)=>r.id),[1,4]);
});

test('a competing projection exits before writing; lock uses the same source key on release', async () => {
  const calls=[];
  const db={ query: async (sql,values) => { calls.push({sql,values}); return {rows:[{locked:false}]}; } };
  await assert.rejects(acquireSyncLock(db,'allergen_projection'), {code:'SYNC_ALREADY_RUNNING'});
  await releaseSyncLock(db,'allergen_projection');
  assert.deepEqual(calls[0].values,calls[1].values);
});
