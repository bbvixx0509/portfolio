// Read-only production comparison. Never prints Secret values or returns food rows.
// Start a local Cloud SQL proxy on 15432 before running with --production-readonly.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import pg from 'pg';
import { buildProductQuery } from '../server/productSearch.js';

if (!process.argv.includes('--production-readonly')) throw new Error('Pass --production-readonly explicitly');
const secret = JSON.parse(execFileSync('kubectl', [
  '--context=gke_example-gcp-project_asia-northeast3_foodiguard-cluster',
  'get', 'secret', 'foodiguard-db-secret', '-o', 'json',
], { encoding: 'utf8', maxBuffer: 1024 * 1024 })).data;
const decode = (key) => Buffer.from(secret[key], 'base64').toString();
const pool = new pg.Pool({
  host: '127.0.0.1', port: 15432, database: decode('DB_NAME'), user: decode('DB_USER'), password: decode('DB_PASSWORD'),
  max: 1, connectionTimeoutMillis: 10000,
  options: '-c default_transaction_read_only=on -c statement_timeout=5000 -c jit=off -c random_page_cost=1.0',
});
const cases = [
  { label: 'catalogue', input: {} },
  { label: 'allergen-exclusion', input: { excludeCodes: ['BUCKWHEAT'] } },
  { label: 'theme-sodium', input: { theme: 'sodium' } },
  ...['면', '냉면', '우유', '초코파이', 'zzunlikelyzz'].map((query) => ({ label: query, input: { query } })),
  { label: 'keyword+allergen+page2', input: { query: '면', excludeCodes: ['WHEAT'], start: 31, display: 30 } },
];
function details(plan) {
  const nodes = [];
  const visit = (node) => {
    if (node['Node Type'] === 'Sort' || node['Subplan Name']) nodes.push({
      type: node['Node Type'], subplan: node['Subplan Name'], rows: node['Actual Rows'],
      loops: node['Actual Loops'], method: node['Sort Method'],
    });
    for (const child of node.Plans || []) visit(child);
  };
  visit(plan.Plan);
  return { executionMs: plan['Execution Time'], sharedHitBlocks: plan.Plan['Shared Hit Blocks'],
    sharedReadBlocks: plan.Plan['Shared Read Blocks'], nodes };
}
try {
  const state = await pool.query("SELECT current_setting('transaction_read_only') AS readonly, count(*)::int AS products FROM food_products");
  console.log(JSON.stringify({ state: state.rows[0] }));
  for (const entry of cases) {
    const plan = buildProductQuery(entry.input);
    const baseline = await pool.query(plan.baselineListSql, plan.listValues);
    const next = await pool.query(plan.listSql, plan.listValues);
    assert.deepEqual(next.rows, baseline.rows, `${entry.label}: rows/order changed`);
    const measurements = { baseline: [], candidate: [] };
    for (let round = 0; round < 3; round += 1) {
      const variants = round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
      for (const variant of variants) {
        const sql = variant === 'baseline' ? plan.baselineListSql : plan.listSql;
        const result = await pool.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql, plan.listValues);
        measurements[variant].push(details(result.rows[0]['QUERY PLAN'][0]));
      }
    }
    const count = await pool.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + plan.countSql, plan.countValues);
    console.log(JSON.stringify({ scenario: entry.label, sameRows: true, returned: next.rows.length,
      exactTotal: plan.exactTotal, countMs: count.rows[0]['QUERY PLAN'][0]['Execution Time'], measurements }));
  }
} finally { await pool.end(); }
