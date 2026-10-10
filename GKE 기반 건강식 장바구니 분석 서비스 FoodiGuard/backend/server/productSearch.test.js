import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { buildProductQuery, createProductSearch } from './productSearch.js';

test('real SQL preserves ranking, eligibility, exclusions, and page boundaries', async (t) => {
  const database = new PGlite();
  t.after(() => database.close());
  await database.exec(`CREATE TABLE food_app_view (
    id bigint PRIMARY KEY, normalized_name text, normalized_manufacturer text,
    active boolean DEFAULT true, ingredient_status text DEFAULT 'matched',
    health_functional_decision text DEFAULT 'CLEAR', sodium_mg numeric,
    protein_g numeric, sugar_g numeric, saturated_fat_g numeric);
    CREATE TABLE food_allergens (food_id bigint, allergen_code varchar);
    INSERT INTO food_app_view (id, normalized_name, normalized_manufacturer, sodium_mg)
    SELECT n, CASE WHEN n=1 THEN '냉면' WHEN n%2=0 THEN '냉면제품'||n ELSE '맛있는냉면'||n END,
      CASE WHEN n%3=0 THEN '우유회사' ELSE NULL END, n%5 FROM generate_series(1,70) n;
    INSERT INTO food_allergens VALUES (1,'MILK'), (2,'MILK'), (2,'WHEAT');
    UPDATE food_app_view SET active=false WHERE id=68;
    UPDATE food_app_view SET normalized_name='냉면ABC123' WHERE id=5;
    UPDATE food_app_view SET ingredient_status='unmatched' WHERE id=69;
    UPDATE food_app_view SET health_functional_decision='REVIEW' WHERE id=70;`);
  const calls = [];
  const search = createProductSearch({ query: async (op, sql, values) => {
    calls.push(op);
    return database.query(sql, values);
  } });
  for (const input of [
    { query: '냉면' }, { query: '냉면', start: 31, display: 30 },
    { query: '냉면', start: 61, display: 30 }, { query: '없음' },
    { query: '우유회사' }, { query: 'abc' }, { query: 'ABC' }, { query: '123' },
    { theme: 'constructor' }, { excludeCodes: ['MILK'] },
    { query: '냉면', excludeCodes: ['MILK','WHEAT'] },
    { theme: 'sodium', display: 30 }, {},
  ]) {
    const plan = buildProductQuery(input);
    const old = await database.query(plan.baselineListSql, plan.listValues);
    const next = await search(input);
    assert.deepEqual(next.rows, old.rows.slice(0, plan.display));
    assert.ok(next.rows.every((row) => row.id < 68));
  }
  const pages = await Promise.all([1,31,61].map((start) => search({ query: '냉면', start, display: 30 })));
  assert.deepEqual(pages.map((page) => page.rows.length), [30,30,7]);
  assert.deepEqual(pages.map((page) => page.hasMore), [true,true,false]);
  assert.equal(new Set(pages.flatMap((page) => page.rows.map((row) => row.id))).size, 67);
  assert.equal(pages[0].rows[0].id, 1, 'exact match remains first');
  assert.deepEqual((await search({ query: 'abc' })).rows.map((r) => r.id), [5], 'Latin search stays case-insensitive');
  const filtered = await search({ excludeCodes: ['MILK'], display: 200 });
  assert.equal(filtered.rows.length, 65);
  assert.equal(filtered.exactTotal, false);
  assert.equal(calls.filter((op) => op === 'product_search_count').length, 1);
});

for (const count of [0,30,31,60]) {
  test(`hasMore is correct with ${count} matching rows`, async () => {
    const search = createProductSearch({ query: async (operation) => {
      assert.equal(operation, 'product_search_list');
      return { rows: Array.from({ length: Math.min(31,count) }, (_,id) => ({ id })) };
    } });
    const result = await search({ query: '면', display: 30 });
    assert.equal(result.rows.length, Math.min(count,30));
    assert.equal(result.hasMore, count > 30);
  });
}

test('catalogue count coalesces concurrent calls and expires without caching filtered results', async () => {
  let time=0, countCalls=0;
  const search = createProductSearch({ now: () => time, countTtlMs: 100,
    query: async (operation) => {
      if (operation === 'product_search_count') { countCalls++; return { rows: [{ count: 100 }] }; }
      return { rows: [{ id: 1 }] };
    },
  });
  await Promise.all([search({}),search({})]);
  assert.equal(countCalls,1);
  time=101;
  assert.equal((await search({})).total,100);
  assert.equal(countCalls,2);
  await search({ excludeCodes: ['MILK'] });
  assert.equal(countCalls,2);
});

test('coalescing precedes admission and includes allergy, theme and pagination values', async () => {
  let admitted = 0, calls = 0, release;
  const wait = new Promise((resolve) => { release = resolve; });
  const search = createProductSearch({
    admit: async (run) => { admitted++; return run(); },
    query: async () => { calls++; await wait; return { rows: [{ id: calls }] }; },
  });
  const inputs = [{ query: '면' }, { query: '면' }, { query: '면', excludeCodes: ['MILK'] },
    { query: '면', excludeCodes: ['WHEAT'] }, { query: '면', start: 49 }, { theme: 'sodium' }];
  const pending = inputs.map((input) => search(input));
  release(); await Promise.all(pending);
  assert.equal(admitted, 5);
  assert.equal(calls, 5);
  await search({ query: '면' });
  assert.equal(calls, 6, 'subsequent request reads fresh product/allergen data');
});
