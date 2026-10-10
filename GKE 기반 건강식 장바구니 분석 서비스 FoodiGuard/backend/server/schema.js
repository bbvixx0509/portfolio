import crypto from 'node:crypto';

// IRB final document database contract.
// Existing production dumps are migrated in place; new local databases are
// created directly with the normalized schema.

const BASE_SCHEMA = [
  `
    CREATE TABLE IF NOT EXISTS food_products (
      id BIGSERIAL PRIMARY KEY,
      food_code TEXT NOT NULL UNIQUE,
      report_no TEXT,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      manufacturer TEXT,
      normalized_manufacturer TEXT,
      data_type_name TEXT,
      category_large TEXT,
      category_medium TEXT,
      category_small TEXT,
      category_detail TEXT,
      nutrition_basis_amount NUMERIC(10, 3),
      nutrition_basis_unit VARCHAR(20),
      serving_reference_amount NUMERIC(10, 3),
      serving_reference_unit VARCHAR(20),
      food_weight_amount NUMERIC(10, 3),
      food_weight_unit VARCHAR(20),
      energy_kcal NUMERIC(12, 3),
      carbohydrate_g NUMERIC(12, 3),
      protein_g NUMERIC(12, 3),
      fat_g NUMERIC(12, 3),
      sugar_g NUMERIC(12, 3),
      fiber_g NUMERIC(12, 3),
      sodium_mg NUMERIC(12, 3),
      saturated_fat_g NUMERIC(12, 3),
      trans_fat_g NUMERIC(12, 3),
      cholesterol_mg NUMERIC(12, 3),
      source_name TEXT NOT NULL,
      source_created_on DATE,
      source_updated_on DATE,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS ingredient_source_rows (
      id BIGSERIAL PRIMARY KEY,
      report_no TEXT,
      product_name TEXT NOT NULL,
      normalized_product_name TEXT NOT NULL,
      manufacturer TEXT,
      normalized_manufacturer TEXT,
      product_type TEXT,
      changed_on DATE,
      ingredient_text TEXT NOT NULL,
      raw_hash CHAR(64) NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS food_ingredient_matches (
      id BIGSERIAL PRIMARY KEY,
      food_id BIGINT NOT NULL REFERENCES food_products(id) ON DELETE CASCADE,
      ingredient_source_id BIGINT REFERENCES ingredient_source_rows(id) ON DELETE SET NULL,
      match_method VARCHAR(40) NOT NULL CHECK (match_method IN ('REPORT_NO_EXACT', 'NAME_MANUFACTURER_EXACT', 'MANUAL', 'UNMATCHED')),
      match_status VARCHAR(20) NOT NULL CHECK (match_status IN ('MATCHED', 'UNMATCHED', 'REVIEW')),
      selected_changed_on DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS food_ingredients (
      id BIGSERIAL PRIMARY KEY,
      food_id BIGINT NOT NULL REFERENCES food_products(id) ON DELETE CASCADE,
      source_row_id BIGINT NOT NULL REFERENCES ingredient_source_rows(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      ingredient_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (food_id, ordinal)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS food_allergens (
      id BIGSERIAL PRIMARY KEY,
      food_id BIGINT NOT NULL REFERENCES food_products(id) ON DELETE CASCADE,
      allergen_code VARCHAR(30) NOT NULL,
      presence_status VARCHAR(20) NOT NULL CHECK (presence_status IN ('PRESENT', 'MAY_CONTAIN', 'UNKNOWN')),
      evidence_ingredient_id BIGINT REFERENCES food_ingredients(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (food_id, allergen_code, presence_status)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS health_functional_products (
      id BIGSERIAL PRIMARY KEY,
      report_no TEXT NOT NULL,
      normalized_report_no TEXT NOT NULL,
      product_name TEXT NOT NULL,
      normalized_product_name TEXT NOT NULL,
      company_name TEXT,
      normalized_company_name TEXT,
      product_type TEXT,
      changed_on DATE,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      source_updated_on DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS health_functional_matches (
      id BIGSERIAL PRIMARY KEY,
      food_id BIGINT NOT NULL REFERENCES food_products(id) ON DELETE CASCADE,
      health_functional_product_id BIGINT REFERENCES health_functional_products(id) ON DELETE SET NULL,
      match_method VARCHAR(40) NOT NULL CHECK (match_method IN ('REPORT_NO_EXACT', 'DATA_TYPE', 'NAME_COMPANY_EXACT', 'NONE', 'MANUAL')),
      decision VARCHAR(20) NOT NULL CHECK (decision IN ('EXCLUDE', 'REVIEW', 'CLEAR')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS sync_runs (
      id BIGSERIAL PRIMARY KEY,
      source_type VARCHAR NOT NULL,
      mode VARCHAR NOT NULL,
      status VARCHAR NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      read_count INTEGER NOT NULL DEFAULT 0,
      inserted_count INTEGER NOT NULL DEFAULT 0,
      updated_count INTEGER NOT NULL DEFAULT 0,
      matched_count INTEGER NOT NULL DEFAULT 0,
      unmatched_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB
    )
  `,
];

const PRODUCT_COLUMNS = [
  ['data_type_name', 'TEXT'],
  ['nutrition_basis_amount', 'NUMERIC(10, 3)'],
  ['nutrition_basis_unit', 'VARCHAR(20)'],
  ['serving_reference_amount', 'NUMERIC(10, 3)'],
  ['serving_reference_unit', 'VARCHAR(20)'],
  ['food_weight_amount', 'NUMERIC(10, 3)'],
  ['food_weight_unit', 'VARCHAR(20)'],
  // 건강기능식품 판정 결과를 상품 행에 함께 둔다. 판정 이력은 health_functional_matches 가
  // 계속 가지고 있고, 이 컬럼은 검색 필터가 인덱스를 탈 수 있게 하는 사본이다.
  // 조인 결과에 걸린 조건은 Postgres 가 선택도를 추정하지 못해(실측 79,041행을 1행으로 추정)
  // 정렬 대신 인덱스 순회를 고르지 못한다. 그 차이가 목록 조회에서 209ms 대 0.75ms 였다.
  ['health_functional_decision', 'VARCHAR(20)'],
];

const INGREDIENT_SOURCE_COLUMNS = [
  ['normalized_product_name', 'TEXT'],
  ['normalized_manufacturer', 'TEXT'],
  ['raw_hash', 'CHAR(64)'],
  ['created_at', 'TIMESTAMPTZ DEFAULT NOW()'],
  ['updated_at', 'TIMESTAMPTZ DEFAULT NOW()'],
];

const HEALTH_FUNCTIONAL_COLUMNS = [
  ['report_no', 'TEXT'],
  ['normalized_report_no', 'TEXT'],
  ['company_name', 'TEXT'],
  ['normalized_company_name', 'TEXT'],
  ['product_type', 'TEXT'],
  ['changed_on', 'DATE'],
  ['source_updated_on', 'DATE'],
  ['created_at', 'TIMESTAMPTZ DEFAULT NOW()'],
  ['updated_at', 'TIMESTAMPTZ DEFAULT NOW()'],
];

async function hasColumn(pool, tableName, columnName) {
  const result = await pool.query(
    `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
      LIMIT 1
    `,
    [tableName, columnName],
  );
  return Boolean(result.rows[0]);
}

async function addColumns(pool, tableName, columns) {
  for (const [name, type] of columns) {
    await pool.query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${name} ${type}`);
  }
}

async function migrateLegacyProductAmounts(pool) {
  const mappings = [
    ['serving_basis', 'nutrition_basis_amount', 'nutrition_basis_unit'],
    ['serving_reference', 'serving_reference_amount', 'serving_reference_unit'],
    ['food_weight', 'food_weight_amount', 'food_weight_unit'],
  ];

  for (const [legacyColumn, amountColumn, unitColumn] of mappings) {
    if (!(await hasColumn(pool, 'food_products', legacyColumn))) continue;
    await pool.query(`
      UPDATE food_products
      SET
        ${amountColumn} = COALESCE(
          ${amountColumn},
          NULLIF(SUBSTRING(${legacyColumn} FROM '([0-9]+(?:[.][0-9]+)?)'), '')::NUMERIC
        ),
        ${unitColumn} = COALESCE(
          ${unitColumn},
          NULLIF(SUBSTRING(LOWER(${legacyColumn}) FROM '(kg|mg|ml|g|l)'), '')
        )
      WHERE NULLIF(BTRIM(${legacyColumn}), '') IS NOT NULL
        AND (
          (${amountColumn} IS NULL AND SUBSTRING(${legacyColumn} FROM '([0-9]+(?:[.][0-9]+)?)') IS NOT NULL)
          OR (${unitColumn} IS NULL AND SUBSTRING(LOWER(${legacyColumn}) FROM '(kg|mg|ml|g|l)') IS NOT NULL)
        )
    `);
  }
}

async function backfillIngredientSourceRows(pool) {
  await pool.query(`
    UPDATE ingredient_source_rows
    SET
      normalized_product_name = COALESCE(
        normalized_product_name,
        REGEXP_REPLACE(LOWER(product_name), '[^0-9a-z가-힣]+', '', 'g')
      ),
      normalized_manufacturer = COALESCE(
        normalized_manufacturer,
        REGEXP_REPLACE(LOWER(COALESCE(manufacturer, '')), '[^0-9a-z가-힣]+', '', 'g')
      ),
      created_at = COALESCE(created_at, NOW()),
      updated_at = COALESCE(updated_at, NOW())
    WHERE normalized_product_name IS NULL
       OR normalized_manufacturer IS NULL
       OR created_at IS NULL
       OR updated_at IS NULL
  `);

  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await pool.query(`
      UPDATE ingredient_source_rows
      SET raw_hash = ENCODE(DIGEST(COALESCE(ingredient_text, ''), 'sha256'), 'hex')
      WHERE raw_hash IS NULL
    `);
  } catch {
    let lastId = 0;
    while (true) {
      const batch = await pool.query(
        `
          SELECT id, ingredient_text
          FROM ingredient_source_rows
          WHERE raw_hash IS NULL AND id > $1
          ORDER BY id
          LIMIT 1000
        `,
        [lastId],
      );
      if (!batch.rows.length) break;
      const ids = batch.rows.map((row) => row.id);
      const hashes = batch.rows.map((row) => crypto.createHash('sha256').update(row.ingredient_text || '').digest('hex'));
      await pool.query(
        `
          UPDATE ingredient_source_rows AS source
          SET raw_hash = values.raw_hash
          FROM UNNEST($1::BIGINT[], $2::TEXT[]) AS values(id, raw_hash)
          WHERE source.id = values.id
        `,
        [ids, hashes],
      );
      lastId = ids[ids.length - 1];
    }
  }

  const missing = await pool.query('SELECT COUNT(*)::INTEGER AS count FROM ingredient_source_rows WHERE raw_hash IS NULL');
  if ((missing.rows[0]?.count || 0) === 0) {
    await pool.query('ALTER TABLE ingredient_source_rows ALTER COLUMN raw_hash SET NOT NULL');
  }
}

async function migrateLegacyHealthFunctionalProducts(pool) {
  const legacyColumns = {
    statementNo: await hasColumn(pool, 'health_functional_products', 'statement_no'),
    normalizedStatementNo: await hasColumn(pool, 'health_functional_products', 'normalized_statement_no'),
    manufacturer: await hasColumn(pool, 'health_functional_products', 'manufacturer'),
    normalizedManufacturer: await hasColumn(pool, 'health_functional_products', 'normalized_manufacturer'),
    registeredOn: await hasColumn(pool, 'health_functional_products', 'registered_on'),
    sourceUpdatedAt: await hasColumn(pool, 'health_functional_products', 'source_updated_at'),
  };

  const reportNo = legacyColumns.statementNo ? 'COALESCE(report_no, statement_no::TEXT)' : 'report_no';
  const normalizedReportNo = legacyColumns.normalizedStatementNo
    ? "COALESCE(normalized_report_no, normalized_statement_no::TEXT, REGEXP_REPLACE(LOWER(COALESCE(report_no, '')), '[^0-9a-z]+', '', 'g'))"
    : "COALESCE(normalized_report_no, REGEXP_REPLACE(LOWER(COALESCE(report_no, '')), '[^0-9a-z]+', '', 'g'))";
  const companyName = legacyColumns.manufacturer ? 'COALESCE(company_name, manufacturer::TEXT)' : 'company_name';
  const normalizedCompanyName = legacyColumns.normalizedManufacturer
    ? "COALESCE(normalized_company_name, normalized_manufacturer::TEXT, REGEXP_REPLACE(LOWER(COALESCE(company_name, '')), '[^0-9a-z가-힣]+', '', 'g'))"
    : "COALESCE(normalized_company_name, REGEXP_REPLACE(LOWER(COALESCE(company_name, '')), '[^0-9a-z가-힣]+', '', 'g'))";
  const changedOn = legacyColumns.registeredOn ? 'COALESCE(changed_on, registered_on::DATE)' : 'changed_on';
  const sourceUpdatedOn = legacyColumns.sourceUpdatedAt ? 'COALESCE(source_updated_on, source_updated_at::DATE)' : 'source_updated_on';

  await pool.query(`
    UPDATE health_functional_products
    SET
      report_no = ${reportNo},
      normalized_report_no = ${normalizedReportNo},
      company_name = ${companyName},
      normalized_company_name = ${normalizedCompanyName},
      changed_on = ${changedOn},
      source_updated_on = ${sourceUpdatedOn},
      created_at = COALESCE(created_at, NOW()),
      updated_at = COALESCE(updated_at, NOW())
    WHERE report_no IS NULL
       OR normalized_report_no IS NULL
       OR normalized_company_name IS NULL
       OR created_at IS NULL
       OR updated_at IS NULL
  `);

  const missing = await pool.query(`
    SELECT COUNT(*)::INTEGER AS count
    FROM health_functional_products
    WHERE report_no IS NULL
       OR normalized_report_no IS NULL
       OR product_name IS NULL
       OR normalized_product_name IS NULL
  `);
  if ((missing.rows[0]?.count || 0) === 0) {
    await pool.query('ALTER TABLE health_functional_products ALTER COLUMN report_no SET NOT NULL');
    await pool.query('ALTER TABLE health_functional_products ALTER COLUMN normalized_report_no SET NOT NULL');
    await pool.query('ALTER TABLE health_functional_products ALTER COLUMN product_name SET NOT NULL');
    await pool.query('ALTER TABLE health_functional_products ALTER COLUMN normalized_product_name SET NOT NULL');
  }
}

async function migrateLegacyIngredientMatches(pool) {
  if (!(await hasColumn(pool, 'food_products', 'ingredient_status'))) return;
  const hasSourceId = await hasColumn(pool, 'food_products', 'current_ingredient_source_id');
  const sourceExpression = hasSourceId ? 'p.current_ingredient_source_id' : 'NULL';
  const sourceJoin = hasSourceId
    ? 'LEFT JOIN ingredient_source_rows s ON s.id = p.current_ingredient_source_id'
    : 'LEFT JOIN ingredient_source_rows s ON FALSE';

  await pool.query(`
    INSERT INTO food_ingredient_matches (
      food_id, ingredient_source_id, match_method, match_status, selected_changed_on
    )
    SELECT
      p.id,
      ${sourceExpression},
      CASE
        WHEN p.ingredient_status = 'matched' AND s.report_no IS NOT NULL AND s.report_no = p.report_no THEN 'REPORT_NO_EXACT'
        WHEN p.ingredient_status = 'matched' AND s.id IS NOT NULL THEN 'NAME_MANUFACTURER_EXACT'
        ELSE 'UNMATCHED'
      END,
      CASE
        WHEN p.ingredient_status = 'matched' THEN 'MATCHED'
        WHEN p.ingredient_status = 'review' THEN 'REVIEW'
        ELSE 'UNMATCHED'
      END,
      s.changed_on
    FROM food_products p
    ${sourceJoin}
    WHERE NOT EXISTS (
      SELECT 1 FROM food_ingredient_matches m WHERE m.food_id = p.id
    )
  `);
}

async function migrateLegacyAllergens(pool) {
  if (!(await hasColumn(pool, 'food_products', 'allergen_codes'))) return;
  await pool.query(`
    INSERT INTO food_allergens (food_id, allergen_code, presence_status)
    SELECT p.id,
      CASE legacy.code
        WHEN '난류' THEN 'EGG'
        WHEN '우유' THEN 'MILK'
        WHEN '메밀' THEN 'BUCKWHEAT'
        WHEN '땅콩' THEN 'PEANUT'
        WHEN '대두' THEN 'SOY'
        WHEN '밀' THEN 'WHEAT'
        WHEN '호두' THEN 'WALNUT'
        WHEN '잣' THEN 'PINE_NUT'
        WHEN '고등어' THEN 'MACKEREL'
        WHEN '게' THEN 'CRAB'
        WHEN '새우' THEN 'SHRIMP'
        WHEN '오징어' THEN 'SQUID'
        WHEN '조개류' THEN 'SHELLFISH'
        WHEN '돼지고기' THEN 'PORK'
        WHEN '닭고기' THEN 'CHICKEN'
        WHEN '쇠고기' THEN 'BEEF'
        WHEN '복숭아' THEN 'PEACH'
        WHEN '토마토' THEN 'TOMATO'
        WHEN '아황산류' THEN 'SULFITES'
        ELSE legacy.code
      END,
      'PRESENT'
    FROM food_products p
    CROSS JOIN LATERAL unnest(p.allergen_codes) AS legacy(code)
    WHERE legacy.code IS NOT NULL AND BTRIM(legacy.code) <> ''
    ON CONFLICT (food_id, allergen_code, presence_status) DO NOTHING
  `);
}

async function migrateHealthFunctionalMatches(pool) {
  await pool.query(`
    INSERT INTO health_functional_matches (
      food_id, health_functional_product_id, match_method, decision
    )
    SELECT
      p.id,
      COALESCE(report_match.id, name_match.id),
      CASE
        WHEN report_match.id IS NOT NULL THEN 'REPORT_NO_EXACT'
        WHEN LOWER(COALESCE(p.data_type_name, '')) LIKE '%건강기능식품%' THEN 'DATA_TYPE'
        WHEN name_match.id IS NOT NULL THEN 'NAME_COMPANY_EXACT'
        ELSE 'NONE'
      END,
      CASE
        WHEN report_match.id IS NOT NULL THEN 'EXCLUDE'
        WHEN LOWER(COALESCE(p.data_type_name, '')) LIKE '%건강기능식품%' THEN 'EXCLUDE'
        WHEN name_match.id IS NOT NULL THEN 'REVIEW'
        ELSE 'CLEAR'
      END
    FROM food_products p
    LEFT JOIN LATERAL (
      SELECT h.id
      FROM health_functional_products h
      WHERE h.normalized_report_no = REGEXP_REPLACE(
        LOWER(COALESCE(p.report_no, '')), '[^0-9a-z]+', '', 'g'
      )
        AND h.normalized_report_no <> ''
      ORDER BY h.changed_on DESC NULLS LAST, h.id DESC
      LIMIT 1
    ) report_match ON TRUE
    LEFT JOIN LATERAL (
      SELECT h.id
      FROM health_functional_products h
      WHERE h.normalized_product_name = p.normalized_name
        AND NULLIF(h.normalized_company_name, '') = NULLIF(p.normalized_manufacturer, '')
      ORDER BY h.changed_on DESC NULLS LAST, h.id DESC
      LIMIT 1
    ) name_match ON report_match.id IS NULL
    WHERE NOT EXISTS (
      SELECT 1 FROM health_functional_matches existing WHERE existing.food_id = p.id
    )
  `);
}

function amountText(amountColumn, unitColumn, fallbackColumn = null) {
  const normalized = `CASE WHEN p.${amountColumn} IS NULL THEN NULL ELSE (p.${amountColumn}::DOUBLE PRECISION)::TEXT || COALESCE(p.${unitColumn}, '') END`;
  return fallbackColumn ? `COALESCE(${normalized}, p.${fallbackColumn})` : normalized;
}

// 앱 검색은 항상 active · ingredient_status · health_functional_decision 세 조건을 함께 건다.
// 그 조합을 인덱스 술어에 넣어 두면 기본 목록의 의사 난수 정렬이 전수 정렬 대신
// 인덱스 순회로 풀린다(86ms → 0.65ms, 실측). 술어가 컬럼을 직접 봐야 하므로
// 판정 사본을 채운 뒤에 만든다.
//
// 술어는 food_app_view 가 노출하는 표현식과 글자 그대로 같아야 한다. 앱은 뷰를 통해
// 조건을 걸기 때문에 플래너가 보는 것은 원본 컬럼이 아니라 LOWER(COALESCE(...)) 이고,
// 원본 컬럼으로 쓴 술어는 그 표현식을 함의하지 못해 인덱스가 통째로 죽는다.
const SEARCHABLE_PREDICATE = `
  WHERE active
    AND LOWER(COALESCE(ingredient_status, 'UNMATCHED')::TEXT) = 'matched'
    AND COALESCE(health_functional_decision, 'UNVERIFIED')::TEXT
        NOT IN ('EXCLUDE', 'REVIEW')`;

// 테마 조회의 정렬 키. 인덱스와 ORDER BY 가 한 곳에서 나와야 어긋나지 않으므로
// index.js 의 검색이 이 표를 그대로 쓴다.
export const themeOrderColumns = {
  sodium: ['sodium_mg', 'ASC'],
  protein: ['protein_g', 'DESC'],
  sugar: ['sugar_g', 'ASC'],
  saturatedFat: ['saturated_fat_g', 'ASC'],
};

async function createSearchIndexes(pool) {
  await pool.query(`
    DROP INDEX IF EXISTS idx_food_products_searchable
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_food_products_searchable
      ON food_products (((id * 2654435761) % 4294967296))
      ${SEARCHABLE_PREDICATE}
  `);

  // 테마 조회는 정렬 키가 달라 위 인덱스를 타지 못하고 전수 정렬로 돌아간다
  // (운영 291ms). 정렬 키마다 같은 술어의 부분 인덱스를 둔다(0.43ms, 실측).
  for (const [theme, [column, direction]] of Object.entries(themeOrderColumns)) {
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_food_products_theme_${theme.toLowerCase()}
        ON food_products (${column} ${direction})
        ${SEARCHABLE_PREDICATE}
          AND ${column} IS NOT NULL
    `);
  }
}

// 판정 이력(health_functional_matches)에서 상품 행의 사본 컬럼을 맞춘다.
// 이력 테이블이 여전히 근거이고, 컬럼은 검색이 인덱스를 탈 수 있게 하는 사본이다.
async function syncHealthFunctionalDecision(pool) {
  await pool.query(`
    UPDATE food_products p
    SET health_functional_decision = latest.decision,
        updated_at = NOW()
    FROM (
      SELECT DISTINCT ON (m.food_id) m.food_id, COALESCE(m.decision, 'UNVERIFIED') AS decision
      FROM health_functional_matches m
      ORDER BY m.food_id, m.created_at DESC, m.id DESC
    ) latest
    WHERE latest.food_id = p.id
      AND p.health_functional_decision IS DISTINCT FROM latest.decision
  `);
  // 판정행이 없는 상품은 뷰에서 'UNVERIFIED' 로 읽히지만, 인덱스 술어가 컬럼을 직접
  // 보기 때문에 NULL 로 두면 부분 인덱스에서 빠진다.
  await pool.query(`
    UPDATE food_products
    SET health_functional_decision = 'UNVERIFIED'
    WHERE health_functional_decision IS NULL
  `);
}

async function rebuildAppView(pool) {
  const hasLegacyServing = await hasColumn(pool, 'food_products', 'serving_basis');
  const hasLegacyReference = await hasColumn(pool, 'food_products', 'serving_reference');
  const hasLegacyWeight = await hasColumn(pool, 'food_products', 'food_weight');
  const serving = amountText('nutrition_basis_amount', 'nutrition_basis_unit', hasLegacyServing ? 'serving_basis' : null);
  const reference = amountText('serving_reference_amount', 'serving_reference_unit', hasLegacyReference ? 'serving_reference' : null);
  const weight = amountText('food_weight_amount', 'food_weight_unit', hasLegacyWeight ? 'food_weight' : null);

  await pool.query('DROP VIEW IF EXISTS food_app_view');
  await pool.query(`
    CREATE VIEW food_app_view AS
    SELECT
      p.id,
      p.food_code,
      p.report_no,
      p.name,
      p.normalized_name,
      p.manufacturer,
      p.normalized_manufacturer,
      p.data_type_name,
      p.category_large,
      p.category_medium,
      p.category_small,
      p.category_detail,
      p.nutrition_basis_amount,
      p.nutrition_basis_unit,
      p.serving_reference_amount,
      p.serving_reference_unit,
      p.food_weight_amount,
      p.food_weight_unit,
      ${serving} AS serving_basis,
      ${reference} AS serving_reference,
      ${weight} AS food_weight,
      p.energy_kcal,
      p.carbohydrate_g,
      p.protein_g,
      p.fat_g,
      p.sugar_g,
      p.fiber_g,
      p.sodium_mg,
      p.saturated_fat_g,
      p.trans_fat_g,
      p.cholesterol_mg,
      p.source_name,
      p.source_created_on,
      p.source_updated_on,
      p.active,
      p.created_at,
      p.updated_at,
      p.current_ingredient_source_id,
      LOWER(COALESCE(p.ingredient_status, 'UNMATCHED')) AS ingredient_status,
      (SELECT COUNT(*)::INTEGER FROM food_ingredients fi WHERE fi.food_id = p.id) AS ingredient_count,
      COALESCE((
        SELECT STRING_AGG(fi.ingredient_name, ', ' ORDER BY fi.ordinal, fi.id)
        FROM food_ingredients fi
        WHERE fi.food_id = p.id
      ), '') AS ingredient_summary_text,
      COALESCE(ARRAY(
        SELECT fa.allergen_code
        FROM food_allergens fa
        WHERE fa.food_id = p.id
        ORDER BY fa.allergen_code
      ), ARRAY[]::VARCHAR[]) AS allergen_codes,
      NULL::BOOLEAN AS has_added_sugar,
      NULL::BOOLEAN AS has_sweetener,
      NULL::BOOLEAN AS has_refined_carb,
      NULL::BOOLEAN AS has_sodium_additive,
      NULL::BOOLEAN AS has_preservative,
      COALESCE(p.health_functional_decision, 'UNVERIFIED') AS health_functional_decision
    FROM food_products p
  `);
}

async function createIndexes(pool) {
  const statements = [
    'CREATE INDEX IF NOT EXISTS idx_food_products_active_name ON food_products (active, normalized_name)',
    'CREATE INDEX IF NOT EXISTS idx_food_products_category ON food_products (category_large, category_medium, category_small)',
    'CREATE INDEX IF NOT EXISTS idx_ingredient_source_report_no ON ingredient_source_rows (report_no)',
    'CREATE INDEX IF NOT EXISTS idx_ingredient_source_name_maker ON ingredient_source_rows (normalized_product_name, normalized_manufacturer)',
    'CREATE INDEX IF NOT EXISTS idx_food_ingredient_matches_food ON food_ingredient_matches (food_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_food_ingredients_food ON food_ingredients (food_id, ordinal)',
    'CREATE INDEX IF NOT EXISTS idx_food_allergens_food_code ON food_allergens (food_id, allergen_code)',
    'CREATE INDEX IF NOT EXISTS idx_health_functional_report_no ON health_functional_products (normalized_report_no)',
    'CREATE INDEX IF NOT EXISTS idx_health_functional_name_company ON health_functional_products (normalized_product_name, normalized_company_name)',
    'CREATE INDEX IF NOT EXISTS idx_health_functional_matches_food ON health_functional_matches (food_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_sync_runs_latest_success ON sync_runs (source_type, finished_at DESC) WHERE status = \'completed\'',
  ];
  for (const statement of statements) await pool.query(statement);
}

export async function ensureDataSchema(pool) {
  for (const statement of BASE_SCHEMA) await pool.query(statement);
  await addColumns(pool, 'food_products', PRODUCT_COLUMNS);
  await addColumns(pool, 'ingredient_source_rows', INGREDIENT_SOURCE_COLUMNS);
  await addColumns(pool, 'health_functional_products', HEALTH_FUNCTIONAL_COLUMNS);
  await migrateLegacyProductAmounts(pool);
  await backfillIngredientSourceRows(pool);
  await migrateLegacyHealthFunctionalProducts(pool);
  await createIndexes(pool);
  await migrateLegacyIngredientMatches(pool);
  await migrateLegacyAllergens(pool);
  await migrateHealthFunctionalMatches(pool);
  await syncHealthFunctionalDecision(pool);
  await createSearchIndexes(pool);
  await rebuildAppView(pool);
}
