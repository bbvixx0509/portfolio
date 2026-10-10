// 알레르기 유발물질 재계산(B06).
//
// 적재 시점 규칙이 메밀·잣·아황산류를 한 건도 잡지 못했다. 원재료 전체 목록
// (food_ingredients)을 다시 훑어 allergens.js 규칙으로 판정하고, 기존 값과 합집합해
// food_products.allergen_codes 를 채운다. food_allergens 테이블이 있으면 같이 채운다.
//
// 기존 표시는 원칙적으로 지우지 않는다. 복합조미식품처럼 하위 원재료가 공개되지 않는
// 항목이 있어 '원재료명에 없음'이 '들어 있지 않음'을 뜻하지 않기 때문이다.
// 예외는 적재 규칙의 글자 겹침으로 설명되는 표시뿐이다(메밀가루→밀, 염소고기→쇠고기,
// 청미래덩굴잎→조개류). 이건 근거 원재료를 특정할 수 있어 정정한다.
//
//   node scripts/recalculate-allergens.js            # 조회만(기본)
//   node scripts/recalculate-allergens.js --apply    # DB 반영
//   node scripts/recalculate-allergens.js --apply --incremental
//   ALLERGEN_REPORT_PATH=... 로 JSON 보고서 저장

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  ALLERGEN_CODE_BY_LABEL,
  ALLERGEN_LABELS,
  deriveAllergens,
  findCollisionEvidence,
  matchesAllergen,
} from '../server/allergens.js';
import { pool } from '../server/db.js';
import {
  completeSyncRun,
  failSyncRun,
  latestSuccessfulWatermark,
  acquireSyncLock,
  releaseSyncLock,
  PRODUCT_CHANGED_IN_WINDOW,
  startSyncRun,
} from '../server/syncRuns.js';

const apply = process.argv.includes('--apply');
const incremental = process.argv.includes('--incremental');
const batchSize = Number(process.env.ALLERGEN_BATCH_SIZE || 2000);
const writeChunk = 400;
const syncSourceType = 'allergen_projection';
let database;
const ALLERGEN_LABEL_BY_CODE = Object.fromEntries(
  Object.entries(ALLERGEN_CODE_BY_LABEL).map(([label, code]) => [code, label]),
);

const added = Object.fromEntries(ALLERGEN_LABELS.map((label) => [label, 0]));
const removed = Object.fromEntries(ALLERGEN_LABELS.map((label) => [label, 0]));
const unsupported = Object.fromEntries(ALLERGEN_LABELS.map((label) => [label, 0]));
let scanned = 0;
let changed = 0;
let withoutIngredients = 0;

async function hasTable(tableName) {
  const result = await database.query('SELECT TO_REGCLASS($1) IS NOT NULL AS exists', [`public.${tableName}`]);
  return Boolean(result.rows[0]?.exists);
}

async function hasColumn(tableName, columnName) {
  const result = await database.query(
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

async function loadBatch(afterId, changedSince, watermark, options) {
  const legacyAllergens = options.productAllergenColumnExists
    ? 'COALESCE(p.allergen_codes, ARRAY[]::VARCHAR[])'
    : 'ARRAY[]::VARCHAR[]';
  const { rows } = await database.query(
    `
      SELECT p.id, p.name, ${legacyAllergens} AS allergen_codes
      FROM food_products p
      WHERE p.id > $1
        AND ${PRODUCT_CHANGED_IN_WINDOW}
      ORDER BY p.id
      LIMIT $2
    `,
    [afterId, batchSize, changedSince, watermark],
  );
  if (!rows.length) return [];

  const ids = rows.map((row) => row.id);
  const { rows: ingredientRows } = await database.query(
    'SELECT food_id, ingredient_name FROM food_ingredients WHERE food_id = ANY($1::bigint[]) ORDER BY food_id, ordinal',
    [ids],
  );

  const byFood = new Map();
  for (const row of ingredientRows) {
    const key = String(row.food_id);
    if (!byFood.has(key)) byFood.set(key, []);
    byFood.get(key).push(row.ingredient_name);
  }

  const allergensByFood = new Map();
  if (options.allergenTableExists) {
    const { rows: allergenRows } = await database.query(
      `
        SELECT food_id, allergen_code
        FROM food_allergens
        WHERE food_id = ANY($1::BIGINT[]) AND presence_status = 'PRESENT'
        ORDER BY food_id, allergen_code
      `,
      [ids],
    );
    for (const row of allergenRows) {
      const key = String(row.food_id);
      if (!allergensByFood.has(key)) allergensByFood.set(key, []);
      allergensByFood.get(key).push(ALLERGEN_LABEL_BY_CODE[row.allergen_code] || row.allergen_code);
    }
  }

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    existing: [...new Set([
      ...(row.allergen_codes || []),
      ...(allergensByFood.get(String(row.id)) || []),
    ])],
    ingredients: byFood.get(String(row.id)) || [],
  }));
}

async function writeProducts(database, updates, productAllergenColumnExists) {
  for (let index = 0; index < updates.length; index += writeChunk) {
    const chunk = updates.slice(index, index + writeChunk);
    if (!productAllergenColumnExists) {
      await database.query(
        'UPDATE food_products SET updated_at = NOW() WHERE id = ANY($1::BIGINT[])',
        [chunk.map((update) => update.id)],
      );
      continue;
    }
    const values = [];
    const tuples = chunk.map((update, position) => {
      values.push(update.id, update.labels);
      const idParam = position * 2 + 1;
      return position === 0
        ? `($${idParam}::BIGINT, $${idParam + 1}::VARCHAR[])`
        : `($${idParam}, $${idParam + 1})`;
    });

    await database.query(
      `
        UPDATE food_products AS p
        SET allergen_codes = v.labels, updated_at = NOW()
        FROM (VALUES ${tuples.join(', ')}) AS v(id, labels)
        WHERE p.id = v.id
      `,
      values,
    );
  }
}

async function writeAllergenRows(database, updates) {
  for (let index = 0; index < updates.length; index += writeChunk) {
    const chunk = updates.slice(index, index + writeChunk);
    const removedFoodIds = [];
    const removedCodes = [];
    const foodIds = [];
    const codes = [];
    for (const update of chunk) {
      for (const label of update.removedLabels) {
        removedFoodIds.push(update.id);
        removedCodes.push(ALLERGEN_CODE_BY_LABEL[label] || label);
      }
      for (const label of update.labels) {
        foodIds.push(update.id);
        codes.push(ALLERGEN_CODE_BY_LABEL[label] || label);
      }
    }

    if (removedFoodIds.length) {
      await database.query(
        `
          DELETE FROM food_allergens existing
          USING UNNEST($1::BIGINT[], $2::VARCHAR[]) AS removed(food_id, allergen_code)
          WHERE existing.food_id = removed.food_id
            AND existing.allergen_code = removed.allergen_code
            AND existing.presence_status = 'PRESENT'
        `,
        [removedFoodIds, removedCodes],
      );
    }
    if (!foodIds.length) continue;

    await database.query(
      `
        INSERT INTO food_allergens (food_id, allergen_code, presence_status)
        SELECT food_id, allergen_code, 'PRESENT'
        FROM UNNEST($1::BIGINT[], $2::VARCHAR[]) AS t(food_id, allergen_code)
        ON CONFLICT (food_id, allergen_code, presence_status) DO NOTHING
      `,
      [foodIds, codes],
    );
  }
}

const startedAt = new Date();
let report;
let syncRunId = null;
let syncRunStatus = null;
let changedSince = null;
let watermark = null;
let lockHeld = false;

try {
  // Native proxy sidecar can still be establishing its upstream connection.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      database = await pool.connect();
      await database.query('SELECT 1');
      break;
    } catch (error) {
      database?.release(true);
      database = null;
      if (attempt === 29) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  if (apply) {
    await acquireSyncLock(database, syncSourceType);
    lockHeld = true;
  }
  if (incremental) {
    changedSince = await latestSuccessfulWatermark(database, syncSourceType);
  }
  const clock = await database.query('SELECT clock_timestamp() AS watermark');
  watermark = clock.rows[0].watermark;
  if (apply) {
    const syncRun = await startSyncRun(database, {
      sourceType: syncSourceType,
      mode: incremental ? 'incremental' : 'full',
      metadata: {
        trigger: process.env.SYNC_TRIGGER || 'manual',
        buildNumber: process.env.BUILD_NUMBER || null,
        changedSince: changedSince ? new Date(changedSince).toISOString() : null,
      },
    });
    syncRunId = syncRun.id;
    watermark = syncRun.started_at;
    syncRunStatus = 'running';
  }

  const allergenTableExists = await hasTable('food_allergens');
  const productAllergenColumnExists = await hasColumn('food_products', 'allergen_codes');
  let afterId = 0;

  for (;;) {
    const batch = await loadBatch(afterId, changedSince, watermark, {
      allergenTableExists,
      productAllergenColumnExists,
    });
    if (!batch.length) break;
    afterId = batch[batch.length - 1].id;

    const updates = [];
    for (const product of batch) {
      scanned += 1;
      if (!product.ingredients.length) withoutIngredients += 1;

      const derived = deriveAllergens(product.ingredients);
      const existing = new Set(product.existing);
      const merged = new Set([...product.existing, ...derived.labels]);
      const removedLabels = [];

      for (const label of derived.labels) if (!existing.has(label)) added[label] += 1;
      for (const label of product.existing) {
        if (!ALLERGEN_LABELS.includes(label) || derived.labels.includes(label)) continue;
        // 상품명이 그 유발물질을 말하고 있으면 떼지 않는다. '전복순대'처럼 원재료 목록에는
        // 안 나오지만 표시는 맞는 경우가 있어, 겹침어만 보고 지우면 위험한 쪽으로 틀린다.
        if (matchesAllergen(label, product.name)) {
          unsupported[label] += 1;
        } else if (findCollisionEvidence(label, product.ingredients)) {
          merged.delete(label);
          removedLabels.push(label);
          removed[label] += 1;
        } else {
          unsupported[label] += 1;
        }
      }

      const unchanged = merged.size === existing.size
        && [...merged].every((label) => existing.has(label));
      if (unchanged) continue;
      changed += 1;
      // 라벨 순서를 고정해 두면 재실행해도 같은 값이 되어 diff 가 깨끗하다.
      updates.push({
        id: product.id,
        labels: ALLERGEN_LABELS.filter((label) => merged.has(label)),
        removedLabels,
      });
    }

    if (apply && updates.length) {
      const client = database;
      try {
        await client.query('BEGIN');
        await writeProducts(client, updates, productAllergenColumnExists);
        if (allergenTableExists) await writeAllergenRows(client, updates);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    }
  }

  report = {
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    mode: apply ? 'apply' : 'dry-run',
    scope: incremental ? 'incremental' : 'full',
    changedSince: changedSince ? new Date(changedSince).toISOString() : null,
    watermarkBefore: new Date(watermark).toISOString(),
    allergenTableUpdated: apply && allergenTableExists,
    scanned,
    changed,
    withoutIngredients,
    addedByLabel: Object.fromEntries(Object.entries(added).filter(([, count]) => count > 0)),
    // 글자 겹침으로 잘못 붙었던 표시를 뗀 건수.
    removedByLabel: Object.fromEntries(Object.entries(removed).filter(([, count]) => count > 0)),
    // 기존 DB 에는 있는데 규칙 근거를 찾지 못한 표시. 지우지 않고 세기만 한다.
    keptWithoutRuleEvidence: Object.fromEntries(Object.entries(unsupported).filter(([, count]) => count > 0)),
  };

  if (syncRunId) {
    await completeSyncRun(database, syncRunId, {
      read: scanned,
      updated: changed,
      matched: scanned - withoutIngredients,
      unmatched: withoutIngredients,
    }, {
      changedProducts: changed,
      watermarkBefore: new Date(watermark).toISOString(),
      allergenTableUpdated: apply && allergenTableExists,
    });
    syncRunStatus = 'completed';
  }
} catch (error) {
  if (syncRunId && syncRunStatus === 'running') {
    await failSyncRun(database, syncRunId, error, {
      read: scanned,
      updated: changed,
      matched: scanned - withoutIngredients,
      unmatched: withoutIngredients,
    }).catch(() => {});
    syncRunStatus = 'failed';
  }
  report = {
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    mode: apply ? 'apply' : 'dry-run',
    scope: incremental ? 'incremental' : 'full',
    scanned,
    error: { name: error.name, message: error.message, code: error.code || null },
  };
} finally {
  if (lockHeld) await releaseSyncLock(database, syncSourceType).catch(() => {});
  database?.release();
  await pool.end();
}

const output = `${JSON.stringify(report, null, 2)}\n`;
if (process.env.ALLERGEN_REPORT_PATH) {
  const reportPath = path.resolve(process.env.ALLERGEN_REPORT_PATH);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, output, 'utf8');
}
process.stdout.write(output);
if (syncRunId) {
  process.stdout.write(`SYNC_RUN_RESULT=${JSON.stringify({ syncRunId, syncRunStatus })}\n`);
}
// Embedded database shutdown can reset process.exitCode. Set the outcome after
// cleanup so a failed run is never reported as a successful Job/CLI execution.
if (report.error) process.exitCode = 1;
