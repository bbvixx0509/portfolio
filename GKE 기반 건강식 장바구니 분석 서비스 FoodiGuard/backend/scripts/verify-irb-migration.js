import fs from 'node:fs/promises';
import path from 'node:path';

import { pool } from '../server/db.js';
import { runMigrations } from '../server/migrations.js';

const preservedTables = [
  'food_products',
  'food_product_versions',
  'ingredient_source_rows',
  'food_ingredients',
  'health_functional_products',
  'food_health_functional_checks',
  'sync_runs',
  'users',
  'user_consents',
];

async function tableExists(tableName) {
  const result = await pool.query('SELECT TO_REGCLASS($1) IS NOT NULL AS exists', [`public.${tableName}`]);
  return Boolean(result.rows[0]?.exists);
}

async function tableCount(tableName) {
  if (!(await tableExists(tableName))) return null;
  const result = await pool.query(`SELECT COUNT(*)::BIGINT AS count FROM ${tableName}`);
  return Number(result.rows[0].count);
}

async function collectCounts() {
  return Object.fromEntries(await Promise.all(
    preservedTables.map(async (tableName) => [tableName, await tableCount(tableName)]),
  ));
}

async function count(sql) {
  const result = await pool.query(sql);
  return Number(result.rows[0].count);
}

const checks = [];

function recordCheck(name, passed, observed, expected) {
  checks.push({ name, passed, observed, expected });
}

async function verify(before, after) {
  for (const tableName of preservedTables) {
    if (before[tableName] === null) continue;
    recordCheck(
      `${tableName} 행 수 보존`,
      before[tableName] === after[tableName],
      after[tableName],
      before[tableName],
    );
  }

  const productCount = after.food_products;
  const ingredientSourceNulls = await count(`
    SELECT COUNT(*) AS count
    FROM ingredient_source_rows
    WHERE raw_hash IS NULL OR normalized_product_name IS NULL OR created_at IS NULL OR updated_at IS NULL
  `);
  recordCheck('원재료 원본행 필수 열 채움', ingredientSourceNulls === 0, ingredientSourceNulls, 0);

  const healthFunctionalNulls = await count(`
    SELECT COUNT(*) AS count
    FROM health_functional_products
    WHERE report_no IS NULL OR normalized_report_no IS NULL
       OR product_name IS NULL OR normalized_product_name IS NULL
  `);
  recordCheck('건강기능식품 식별 열 채움', healthFunctionalNulls === 0, healthFunctionalNulls, 0);

  const ingredientMatchCount = await tableCount('food_ingredient_matches');
  const ingredientMatchDuplicates = await count(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT food_id FROM food_ingredient_matches GROUP BY food_id HAVING COUNT(*) > 1
    ) duplicated
  `);
  recordCheck('상품별 원재료 매칭행 생성', ingredientMatchCount === productCount, ingredientMatchCount, productCount);
  recordCheck('상품별 원재료 매칭 중복 없음', ingredientMatchDuplicates === 0, ingredientMatchDuplicates, 0);

  const healthMatchCount = await tableCount('health_functional_matches');
  const healthMatchDuplicates = await count(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT food_id FROM health_functional_matches GROUP BY food_id HAVING COUNT(*) > 1
    ) duplicated
  `);
  recordCheck('상품별 건강기능식품 판정행 생성', healthMatchCount === productCount, healthMatchCount, productCount);
  recordCheck('상품별 건강기능식품 판정 중복 없음', healthMatchDuplicates === 0, healthMatchDuplicates, 0);

  const ingredientOrphans = await count(`
    SELECT COUNT(*) AS count
    FROM food_ingredients i
    LEFT JOIN food_products p ON p.id = i.food_id
    LEFT JOIN ingredient_source_rows s ON s.id = i.source_row_id
    WHERE p.id IS NULL OR s.id IS NULL
  `);
  recordCheck('상품-원재료 참조 무결성', ingredientOrphans === 0, ingredientOrphans, 0);

  const appViewCount = await tableCount('food_app_view');
  recordCheck('앱 조회 뷰 상품 수', appViewCount === productCount, appViewCount, productCount);

  const consentColumnsResult = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user_consents'
    ORDER BY ordinal_position
  `);
  const consentColumns = consentColumnsResult.rows.map((row) => row.column_name);
  const expectedConsentColumns = [
    'id', 'user_id', 'consent_type', 'consent_version', 'content_hash',
    'status', 'consented_at', 'withdrawn_at',
  ];
  recordCheck(
    'IRB 동의 이력 테이블 열 구성',
    JSON.stringify(consentColumns) === JSON.stringify(expectedConsentColumns),
    consentColumns,
    expectedConsentColumns,
  );

  // 확인하려는 것은 "마이그레이션이 동의 이력을 임의로 만들지 않는다"이지 "동의 이력이 없다"가
  // 아니다. 앱이 실제로 동의를 받기 시작하면 행이 쌓이므로, 0 을 기대하면 기능이 정상 동작할수록
  // 검증이 실패한다. 마이그레이션 전후 행 수가 같은지로 본다.
  const consentBefore = before.user_consents;
  const consentAfter = after.user_consents;
  recordCheck(
    '마이그레이션이 동의 이력을 만들지 않음',
    consentBefore === null ? consentAfter === 0 : consentBefore === consentAfter,
    consentAfter,
    consentBefore === null ? 0 : consentBefore,
  );
}

const startedAt = new Date();
let report;

try {
  const before = await collectCounts();
  await runMigrations(pool);
  const after = await collectCounts();
  await verify(before, after);

  report = {
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    durationSeconds: Number(((Date.now() - startedAt.getTime()) / 1000).toFixed(3)),
    passed: checks.every((check) => check.passed),
    before,
    after,
    checks,
  };
} catch (error) {
  report = {
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    passed: false,
    checks,
    error: { name: error.name, message: error.message, code: error.code || null },
  };
} finally {
  await pool.end();
}

const output = `${JSON.stringify(report, null, 2)}\n`;
if (process.env.MIGRATION_REPORT_PATH) {
  const reportPath = path.resolve(process.env.MIGRATION_REPORT_PATH);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, output, 'utf8');
}
process.stdout.write(output);
if (!report.passed) process.exitCode = 1;
