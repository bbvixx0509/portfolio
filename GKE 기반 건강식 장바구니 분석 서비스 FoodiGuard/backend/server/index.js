import './env.js';
import cors from 'cors';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  findUserById,
  loginUser,
  requireAuth,
  requireSelf,
  saveOnboardingProfile,
  sendAuthError,
  signupUser,
} from './auth.js';
import {
  assertHealthDataConsent,
  publicConsentDocuments,
  recordUserConsents,
} from './consents.js';
import { generateCartExplanation } from './llm.js';
import { pool, readinessPool, queryWithMetrics } from './db.js';
import { liveHealth, createReadinessCheck } from './health.js';
import { createProductSearch } from './productSearch.js';
import { createQueryGate } from './queryGate.js';
import { installGracefulShutdown } from './shutdown.js';
import { createRequestTracer, traceAsync, traceSync } from './requestTrace.js';
import { loadDataQuality, requiredSyncSources } from './dataQuality.js';
import {
  httpMetricsMiddleware,
  metricsHandler,
  observeDbQuery,
  observeGeminiRequest,
  recordAllergenExclusion,
  recordGeminiFallback,
  setDataQuality,
  setSyncHealth,
  recordSearchCoalescing,
  setSearchAdmission,
  registerDbPoolMetrics,
} from './metrics.js';

const app = express();
const requestTracer = createRequestTracer();
await requestTracer.ready;
let lifecycle;
const port = Number(process.env.PORT || 8080);
const serverDir = path.dirname(fileURLToPath(import.meta.url));
const mobileDistPath = path.resolve(serverDir, '../../mobile/dist');
const allowedOrigins = (process.env.CORS_ORIGIN || '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(requestTracer.middleware);
app.use(httpMetricsMiddleware);
app.use((req, res, next) => {
  if (lifecycle?.isStopping() && req.path !== '/api/health/live' && req.path !== '/metrics') {
    res.set('Connection', 'close').set('Retry-After', '2');
    return res.status(503).json({ ok: false, code: 'SERVER_DRAINING' });
  }
  next();
});
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Not allowed by CORS'));
  },
}));
app.use(express.json({ limit: '1mb' }));

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function sendDatabaseError(res, error) {
  const busy = error.code === 'SEARCH_BUSY' || error.code === '57014';
  if (busy) res.set('Retry-After', '2');
  res.status(503).json({
    code: busy ? 'SEARCH_BUSY' : 'DB_QUERY_FAILED',
    message: busy ? '검색 요청이 많습니다. 잠시 후 다시 시도해주세요.' : '데이터를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.',
  });
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function buildNutritionFacts(row) {
  return [
    { key: 'calories', label: '열량', value: toNumber(row.energy_kcal), unit: 'kcal' },
    { key: 'carbs', label: '탄수화물', value: toNumber(row.carbohydrate_g), unit: 'g' },
    { key: 'protein', label: '단백질', value: toNumber(row.protein_g), unit: 'g' },
    { key: 'fat', label: '지방', value: toNumber(row.fat_g), unit: 'g' },
    { key: 'sugar', label: '당류', value: toNumber(row.sugar_g), unit: 'g' },
    { key: 'fiber', label: '식이섬유', value: toNumber(row.fiber_g), unit: 'g' },
    { key: 'sodium', label: '나트륨', value: toNumber(row.sodium_mg), unit: 'mg' },
    { key: 'saturatedFat', label: '포화지방', value: toNumber(row.saturated_fat_g), unit: 'g' },
    { key: 'cholesterol', label: '콜레스테롤', value: toNumber(row.cholesterol_mg), unit: 'mg' },
  ];
}

// 앱에서 쓰는 알레르기 표기 → DB allergen_codes 값 확장 매핑
const allergenExpansion = {
  '난류': ['EGG'], '계란': ['EGG'], '달걀': ['EGG'], '알류(가금류)': ['EGG'],
  '우유': ['MILK'], '메밀': ['BUCKWHEAT'], '땅콩': ['PEANUT'], '대두': ['SOY'], '밀': ['WHEAT'],
  '호두': ['WALNUT'], '잣': ['PINE_NUT'], '견과류': ['WALNUT', 'PEANUT', 'PINE_NUT'],
  '갑각류': ['SHRIMP', 'CRAB', 'SHELLFISH'], '새우': ['SHRIMP'], '게': ['CRAB'], '조개류': ['SHELLFISH'],
  '생선': ['MACKEREL', 'SQUID'], '고등어': ['MACKEREL'], '오징어': ['SQUID'],
  '돼지고기': ['PORK'], '쇠고기': ['BEEF'], '소고기': ['BEEF'], '닭고기': ['CHICKEN'],
  '토마토': ['TOMATO'], '복숭아': ['PEACH'], '아황산류': ['SULFITES'],
};

export function expandAllergens(labels = []) {
  const codes = new Set();
  labels.forEach((label) => {
    (allergenExpansion[String(label).trim()] || []).forEach((code) => codes.add(code));
  });
  return [...codes];
}

function normalizeKeyword(value) {
  return String(value || '').toLowerCase().replace(/[^0-9a-z가-힣]+/g, '');
}

function mapProduct(row, source = 'food-db') {
  const nutritionFacts = buildNutritionFacts(row);
  const maker = row.manufacturer || '';
  const categories = [row.category_large, row.category_medium, row.category_small, row.category_detail]
    .filter(Boolean);
  const servingBasis = row.serving_basis || '';
  const totalWeight = row.food_weight || '';
  const referenceIntake = row.serving_reference || '';

  return {
    source,
    id: `db-${row.id}`,
    dbId: row.id,
    productId: row.food_code || String(row.id),
    name: row.name,
    originalTitle: row.name,
    // 네이버 쇼핑 API 종료 대체: 상품명+제조사 검색 링크 제공 (설계 문서 2번)
    link: `https://search.shopping.naver.com/search/all?query=${encodeURIComponent([row.name, row.manufacturer].filter(Boolean).join(' '))}`,
    image: '',
    price: 0,
    store: maker || '식품안전나라 DB',
    maker,
    brand: maker,
    categories,
    category: categories.join(' > ') || '가공식품',
    categoryLarge: row.category_large || '',
    categoryMedium: row.category_medium || '',
    categorySmall: row.category_small || '',
    categoryDetail: row.category_detail || '',
    dataTypeName: row.data_type_name || '',
    serving: servingBasis || totalWeight,
    foodWeight: totalWeight,
    nutritionBasis: {
      servingSize: servingBasis,
      totalWeight,
      referenceIntake,
      sourceFile: row.source_name || '식약처 통합식품영양성분DB',
      sourceColumn: 'serving_basis',
    },
    sourceType: row.source_name || '식약처 통합식품영양성분DB(가공식품)',
    ingredients: row.ingredient_summary_text || '',
    ingredientStatus: row.ingredient_status || 'pending',
    ingredientCount: row.ingredient_count ?? null,
    allergens: row.allergen_codes ?? null,
    flags: {
      addedSugar: row.has_added_sugar ?? null,
      sweetener: row.has_sweetener ?? null,
      refinedCarb: row.has_refined_carb ?? null,
      sodiumAdditive: row.has_sodium_additive ?? null,
      preservative: row.has_preservative ?? null,
    },
    reportNo: row.report_no || '',
    matchedProductName: row.name,
    nutrients: {
      calories: toNumber(row.energy_kcal),
      protein: toNumber(row.protein_g),
      carbs: toNumber(row.carbohydrate_g),
      fat: toNumber(row.fat_g),
      sugar: toNumber(row.sugar_g),
      sodium: toNumber(row.sodium_mg),
      saturatedFat: toNumber(row.saturated_fat_g),
      transFat: toNumber(row.trans_fat_g),
      cholesterol: toNumber(row.cholesterol_mg),
      fiber: toNumber(row.fiber_g),
    },
    match: {
      type: 'FOOD_DB',
      nameScore: 100,
      makerScore: maker ? 100 : 0,
      sameReportNo: Boolean(row.report_no),
      nutritionKey: row.food_code || '',
      evidence: '식약처 통합식품영양성분 정보',
    },
    nutritionMatch: {
      status: 'confirmed',
      statusLabel: '식약처 공식 데이터',
      confidence: 100,
      foodCode: row.food_code || '',
      foodName: row.name,
      makerName: maker,
      category: categories.join(' > '),
      servingSize: servingBasis,
      totalWeight,
      referenceIntake,
      sourceFile: row.source_name || '식약처 통합식품영양성분DB',
      sourceName: row.source_name || '식약처 통합식품영양성분DB',
      updateDate: row.source_updated_on || '',
      evidence: ['식약처 공식 영양성분', row.ingredient_status === 'matched' ? '원재료 분석 완료' : '원재료 분석 대기'],
      nutritionFacts,
    },
    nutritionFacts,
    matchStatus: 'confirmed',
  };
}


const searchGate = createQueryGate({
  concurrency: Number(process.env.SEARCH_CONCURRENCY || 2),
  maxQueue: Number(process.env.SEARCH_QUEUE_MAX || 20),
  timeoutMs: Number(process.env.SEARCH_QUEUE_TIMEOUT_MS || 1500),
  onChange: setSearchAdmission,
});
const searchProducts = createProductSearch({
  query: (operation, sql, values) => queryWithMetrics(pool, operation, sql, values),
  countTtlMs: Number(process.env.PRODUCT_COUNT_TTL_MS || 30000),
  admit: searchGate,
  observeCoalescing: recordSearchCoalescing,
});
registerDbPoolMetrics(pool);
const checkReadiness = createReadinessCheck(readinessPool, Number(process.env.DB_HEALTH_TIMEOUT_MS || 1500));

async function queryProducts({ excludeAllergens = [], ...input }) {
  const excludeCodes = expandAllergens(excludeAllergens);
  if (excludeCodes.length) recordAllergenExclusion('product_search');
  const { rows, ...pagination } = await traceAsync('search_total', () => searchProducts({ ...input, excludeCodes }));
  return { ...pagination, products: traceSync('map_products', () => rows.map((row) => mapProduct(row))) };
}

// 배포 플랫폼은 헬스체크를 수 초 간격으로 폴링한다. 전수 COUNT는 160만 행을 훑기 때문에
// 매 요청마다 실행하면 소형 인스턴스에서 응답보다 요청이 빨리 쌓여 커넥션 풀이 고갈된다.
// 따라서 응답은 즉시 내보내고, 집계는 캐시해 백그라운드에서만 갱신한다.
const healthCacheTtlMs = Number(process.env.HEALTH_CACHE_TTL_MS || 300000);
let healthCounts = null;
let healthCountsAt = 0;
let healthRefresh = null;

function refreshHealthCounts() {
  if (healthRefresh) return healthRefresh;
  if (healthCounts && Date.now() - healthCountsAt < healthCacheTtlMs) return null;

  healthRefresh = observeDbQuery('health_counts', () => Promise.all([
    pool.query('SELECT COUNT(*)::int AS count FROM food_products WHERE active'),
    pool.query('SELECT COUNT(*)::int AS count FROM food_ingredients'),
    pool.query('SELECT COUNT(*)::int AS count FROM ingredient_source_rows'),
    pool.query(`
      SELECT COUNT(*)::int AS count
      FROM food_app_view
      WHERE active
        AND ingredient_status = 'matched'
        AND health_functional_decision NOT IN ('EXCLUDE', 'REVIEW')
    `),
  ]))
    .then(([products, ingredients, sourceRows, matched]) => {
      healthCounts = {
        products: products.rows[0]?.count || 0,
        ingredientRows: ingredients.rows[0]?.count || 0,
        ingredientSourceRows: sourceRows.rows[0]?.count || 0,
        ingredientMatchedProducts: matched.rows[0]?.count || 0,
        // 검색·앱 노출 대상은 원재료 분석이 끝난 식품뿐이다.
        searchableProducts: matched.rows[0]?.count || 0,
      };
      healthCountsAt = Date.now();
    })
    .catch(() => {})
    .finally(() => { healthRefresh = null; });

  return healthRefresh;
}

app.get('/api/health/live', (_req, res) => {
  res.json(liveHealth());
});

async function sendReadiness(res, includeMetadata = false) {
  try {
    const readiness = await checkReadiness();
    if (includeMetadata) refreshHealthCounts();
    res.json({
      ...readiness,
      ...(includeMetadata ? {
        activeTable: 'food_products',
        searchMode: 'food-db',
        externalShoppingApi: false,
        countsReady: Boolean(healthCounts),
        ...(healthCounts || {}),
      } : {}),
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      status: 'not_ready',
      service: 'FoodiGuard API',
      code: error.code || 'DB_NOT_READY',
    });
  }
}

// 데이터 품질 게이지. 전수 집계라 매 수집(30초)마다 돌리면 DB 를 갉아먹으므로
// 헬스 집계와 같은 TTL 캐시를 쓰고, /metrics 요청은 갱신을 걸어 두기만 한다.
const dataQualityTtlMs = Number(process.env.DATA_QUALITY_TTL_MS || 300000);
let dataQualityAt = 0;
let dataQualityRefresh = null;
let dataQualityRetryAt = 0;
const syncSources = requiredSyncSources(process.env.SYNC_REQUIRED_SOURCES);

function refreshDataQuality() {
  if (dataQualityRefresh) return dataQualityRefresh;
  if (Date.now() < dataQualityRetryAt) return null;
  if (dataQualityAt && Date.now() - dataQualityAt < dataQualityTtlMs) return null;

  dataQualityRefresh = loadDataQuality(
    (operation, sql, values) => queryWithMetrics(pool, operation, sql, values),
    syncSources,
  )
    .then(({ quality, sync }) => {
      setDataQuality(quality);
      setSyncHealth(sync, Date.now() / 1000);
      dataQualityAt = Date.now();
    })
    .catch(() => { dataQualityRetryAt = Date.now() + 30000; })
    .finally(() => { dataQualityRefresh = null; });

  return dataQualityRefresh;
}

// 관리형 Prometheus 가 PodMonitoring 설정대로 긁어 간다. 인증은 클러스터 네트워크
// 경계에 맡기고, 여기서는 개인정보가 라벨에 들어가지 않도록 하는 것까지만 책임진다.
app.get('/metrics', (req, res) => {
  refreshDataQuality();
  return metricsHandler(req, res);
});

app.get('/api/health/ready', (_req, res) => sendReadiness(res));
app.get('/api/health', (_req, res) => sendReadiness(res, true));

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { user, session } = await signupUser(pool, req.body || {});
    res.status(201).json({ user, token: session.token, expiresAt: session.expiresAt });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { user, session } = await loginUser(pool, req.body || {});
    res.json({ user, token: session.token, expiresAt: session.expiresAt });
  } catch (error) {
    sendAuthError(res, error);
  }
});

// 동의 문서 원본. 앱은 이 응답을 그대로 그리고, 서버는 같은 원본의 해시를 저장한다.
// 로그인 전에도 읽을 수 있어야 하므로 인증을 걸지 않는다.
app.get('/api/consents', (_req, res) => {
  res.json({ documents: publicConsentDocuments() });
});

app.post('/api/auth/users/:userId/consents', requireAuth, requireSelf('userId'), async (req, res) => {
  try {
    await recordUserConsents(pool, req.params.userId, req.body || {});
    const user = await findUserById(pool, req.params.userId);
    res.status(201).json({ user });
  } catch (error) {
    sendAuthError(res, error);
  }
});

// 프로필은 본인만 수정한다. requireAuth 가 토큰을, requireSelf 가 경로의 회원 id 와
// 토큰 주체가 같은지를 본다. 둘 중 하나라도 빠지면 UUID 만 알면 남의 프로필을 바꿀 수 있다.
//
// 이 요청이 실어 오는 키·체중·알레르기는 민감정보라 동의 없이 받아 두면 안 된다.
// 화면 순서로만 막으면 API 를 직접 부르는 경로가 남으므로 서버에서 한 번 더 확인한다.
app.patch('/api/auth/users/:userId/profile', requireAuth, requireSelf('userId'), async (req, res) => {
  try {
    await assertHealthDataConsent(pool, req.params.userId);
    const user = await saveOnboardingProfile(pool, req.params.userId, req.body || {});
    res.json({ user });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const display = clampInteger(req.query.display, 48, 1, 200);
    const start = clampInteger(req.query.start, 1, 1, 1000000);
    const query = String(req.query.query || req.query.q || '').trim();
    const theme = String(req.query.theme || '').trim();
    const excludeAllergens = String(req.query.excludeAllergens || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    const result = await queryProducts({ query, start, display, excludeAllergens, theme });
    res.json({
      query,
      start,
      display: result.products.length,
      total: result.total,
      exactTotal: result.exactTotal,
      hasMore: result.hasMore,
      excludeAllergens,
      theme,
      sourceFile: 'food_products',
      sourceFormat: 'postgresql',
      searchSource: 'food-db',
      products: result.products,
    });
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

// ─── 대체 상품 후보 ─────────────────────────────────────────────────────────
// 감사보고서 R1~R13. 프로필을 모르는 서버는 "누가 후보가 될 수 있나"만 좁히고,
// 점수·1회 섭취량이 필요한 판정(R3 분량 밴드 · R4 파레토 · R5 게이트 · R6 개선폭)은
// 클라이언트가 한다. 점수 엔진을 서버로 복제하지 않기 위한 분업이다.
//
// 원재료 요약은 "상위 6개 절단본"이라 토큰 중복·괄호 안 콤마가 섞여 있다.
// 괄호 depth를 세며 잘라야 '천연향료(Pepper, black)' 같은 값이 두 토큰으로 깨지지 않는다(실측 45건).
function tokenizeIngredients(text) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of String(text || '')) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return new Set(out);
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const token of a) if (b.has(token)) inter += 1;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

// 카테고리 사다리. category_small은 쓰지 않는다 — 36개 조합 중 27개에서 결과가 같고,
// 나머지 9개에서는 '해당없음' 센티넬(5,317행)이 무관한 식품을 끌어온다(실측).
const ALTERNATIVE_LEVELS = [
  { level: 0, columns: ['category_large', 'category_medium', 'category_small', 'category_detail'] },
  { level: 1, columns: ['category_large', 'category_medium'] },
  { level: 2, columns: ['category_large'] },
];

app.get('/api/products/alternatives', async (req, res) => {
  try {
    const rawId = String(req.query.id || '').trim().replace(/^db-/, '');
    const sourceId = Number(rawId);
    if (!Number.isInteger(sourceId) || sourceId <= 0) {
      return res.status(400).json({ message: '대체 후보를 찾을 상품 id가 필요합니다.' });
    }
    const limit = clampInteger(req.query.limit, 200, 1, 400);
    // 클라이언트가 단계를 지정할 수 있다. 서버는 점수를 모르므로 "후보 0"만 감지할 수 있는데,
    // 실제로 필요한 폴백 조건은 "게이트(≥73.9)를 통과하는 후보가 0"이다 — 유탕면 869건 중
    // 73.9점 이상이 0건이라 같은 카테고리 안에서는 대체가 원리적으로 불가능하다.
    // 그 판정은 점수 엔진을 가진 클라이언트만 할 수 있으므로 단계를 넘겨받는다.
    const requestedLevel = req.query.level === undefined ? null : clampInteger(req.query.level, 0, 0, 2);
    const excludeAllergens = String(req.query.excludeAllergens || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

    return await searchGate(async () => {
    const { rows: sourceRows } = await observeDbQuery('alternatives_source', () => pool.query(
      `SELECT * FROM food_app_view WHERE id = $1 AND active AND ingredient_status = 'matched'`,
      [sourceId],
    ));
    const source = sourceRows[0];
    if (!source) return res.status(404).json({ message: '원본 상품을 찾을 수 없습니다.' });

    const excludeCodes = expandAllergens(excludeAllergens);
    if (excludeCodes.length) recordAllergenExclusion('alternatives');
    const sourceTokens = tokenizeIngredients(source.ingredient_summary_text);

    let candidates = [];
    let usedLevel = 0;
    const ladder = requestedLevel === null
      ? ALTERNATIVE_LEVELS
      : ALTERNATIVE_LEVELS.filter((step) => step.level === requestedLevel);
    for (const step of ladder) {
      // 바인드 파라미터는 단계별로 필요한 것만 만든다. 쓰이지 않는 $n을 넘기면
      // Postgres가 타입을 정하지 못해 'could not determine data type' 으로 실패한다.
      const values = [sourceId, source.normalized_name];
      const conditions = [
        'active',
        `ingredient_status = 'matched'`,
        `health_functional_decision NOT IN ('EXCLUDE', 'REVIEW')`,
        'id <> $1',
        'normalized_name <> $2',   // R7 — 같은 제품의 다른 용량을 '대체'라 부르지 않는다
        'sodium_mg IS NOT NULL AND sodium_mg <> 0',  // R8 — 문헌 없음, 내부 판단
      ];
      for (const [column, value] of step.columns.map((c) => [c, source[c]])) {
        values.push(value);
        conditions.push(`${column} = $${values.length}`);
      }

      // 100g 파레토 프리필터. 정확 일치(레벨 0)에서만 건다 — 폴백 단계에서까지 걸면
      // 자기 카테고리에서 열량·나트륨·당류가 최저인 제품의 후보가 사라진다 — 3단계 전부에서
      // 후보 0이 되는 상품 33건(0.04%), 정확 일치 단계만 걸 때 142건(0.18%)(실측).
      if (step.level === 0) {
        for (const [column, value] of [['energy_kcal', source.energy_kcal], ['sodium_mg', source.sodium_mg], ['sugar_g', source.sugar_g]]) {
          // 원본 값이 없거나 0이면 이 축은 걸지 않는다. 0에 '이하'를 요구하면 통과 가능한 후보가 정의상 없다.
          if (value == null || Number(value) === 0) continue;
          values.push(value);
          conditions.push(`${column} IS NOT NULL AND ${column} <= $${values.length}`);
        }
      }
      if (excludeCodes.length) {
        values.push(excludeCodes);
        // 검색과 같은 이유로 안티조인을 쓴다(queryProducts 주석 참고).
        conditions.push(`NOT EXISTS (
          SELECT 1 FROM food_allergens fa
          WHERE fa.food_id = food_app_view.id AND fa.allergen_code = ANY($${values.length}::varchar[])
        )`);
      }

      const { rows } = await observeDbQuery('alternatives_candidates', () => pool.query(
        `SELECT id, ingredient_summary_text FROM food_app_view WHERE ${conditions.join(' AND ')}`,
        values,
      ));
      if (rows.length) { candidates = rows; usedLevel = step.level; break; }
    }

    if (!candidates.length) {
      return res.json({ sourceId: `db-${sourceId}`, fallbackLevel: null, total: 0, products: [] });
    }

    // 자카드는 Node에서 계산한다. 최대 카테고리(19,061행)에서 토큰화+정렬까지 약 22ms인 반면,
    // 같은 계산을 SQL(array_agg DISTINCT)로 하면 1초가 넘는다(실측).
    const ranked = candidates
      .map((row) => ({ id: row.id, similarity: jaccard(sourceTokens, tokenizeIngredients(row.ingredient_summary_text)) }))
      .sort((a, b) => b.similarity - a.similarity || a.id - b.id)
      .slice(0, limit);

    const { rows: full } = await observeDbQuery('alternatives_detail', () => pool.query('SELECT * FROM food_app_view WHERE id = ANY($1::bigint[])', [ranked.map((r) => r.id)]));
    const byId = new Map(full.map((row) => [String(row.id), row]));
    const products = ranked
      .map((r) => {
        const row = byId.get(String(r.id));
        return row ? { ...mapProduct(row), similarity: Math.round(r.similarity * 1000) / 1000 } : null;
      })
      .filter(Boolean);

    return res.json({ sourceId: `db-${sourceId}`, fallbackLevel: usedLevel, total: candidates.length, products });
    });
  } catch (error) {
    if (error.code === 'SEARCH_BUSY' || error.code === '57014') return sendDatabaseError(res, error);
    console.error('[alternatives]', error);
    return res.status(500).json({ message: '대체 후보를 불러오지 못했습니다.' });
  }
});

app.get('/api/products/:id/ingredients', async (req, res) => {
  const dbId = Number.parseInt(String(req.params.id).replace(/^db-/, ''), 10);
  if (!Number.isInteger(dbId) || dbId <= 0) {
    res.status(400).json({ code: 'INVALID_PRODUCT_ID', message: '유효한 식품 ID가 아닙니다.' });
    return;
  }

  try {
    const [productResult, ingredientResult] = await observeDbQuery('ingredient_detail', () => Promise.all([
      pool.query(
        `
          SELECT id, name, report_no, ingredient_status, ingredient_count, ingredient_summary_text,
                 allergen_codes, has_added_sugar, has_sweetener, has_refined_carb,
                 has_sodium_additive, has_preservative, current_ingredient_source_id
          FROM food_app_view
          WHERE id = $1
        `,
        [dbId],
      ),
      pool.query(
        `
          SELECT ordinal, ingredient_name
          FROM food_ingredients
          WHERE food_id = $1
          ORDER BY ordinal ASC, id ASC
        `,
        [dbId],
      ),
    ]));

    const product = productResult.rows[0];
    if (!product) {
      res.status(404).json({ code: 'PRODUCT_NOT_FOUND', message: '식품을 찾을 수 없습니다.' });
      return;
    }

    let sourceText = '';
    let sourceChangedOn = null;
    if (product.current_ingredient_source_id) {
      const sourceResult = await observeDbQuery('ingredient_source', () => pool.query(
        'SELECT ingredient_text, changed_on FROM ingredient_source_rows WHERE id = $1',
        [product.current_ingredient_source_id],
      ));
      sourceText = sourceResult.rows[0]?.ingredient_text || '';
      sourceChangedOn = sourceResult.rows[0]?.changed_on || null;
    }

    res.json({
      ok: true,
      foodId: product.id,
      name: product.name,
      reportNo: product.report_no || '',
      status: product.ingredient_status,
      count: product.ingredient_count ?? ingredientResult.rows.length,
      summary: product.ingredient_summary_text || '',
      allergens: product.allergen_codes ?? null,
      flags: {
        addedSugar: product.has_added_sugar ?? null,
        sweetener: product.has_sweetener ?? null,
        refinedCarb: product.has_refined_carb ?? null,
        sodiumAdditive: product.has_sodium_additive ?? null,
        preservative: product.has_preservative ?? null,
      },
      ingredients: ingredientResult.rows.map((row) => ({ ordinal: row.ordinal, name: row.ingredient_name })),
      sourceText,
      sourceChangedOn,
      versions: [],
    });
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

app.get('/api/shopping/search', async (req, res) => {
  const query = String(req.query.query || '').trim();
  if (!query) {
    res.status(400).json({ code: 'QUERY_REQUIRED', message: 'query is required.' });
    return;
  }

  try {
    const display = clampInteger(req.query.display, 48, 1, 100);
    const start = clampInteger(req.query.start, 1, 1, 1000000);
    const result = await queryProducts({ query, start, display });
    res.json({
      query,
      total: result.products.length,
      localTotal: result.total,
      exactMatchTotal: result.total,
      sourceFile: 'Cloud SQL naver_products',
      sourceFormat: 'postgresql',
      searchSource: 'cloudsql-only',
      deprecatedAliasOf: '/api/products',
      scannedItems: result.total,
      pagesFetched: 0,
      start,
      display: result.products.length,
      products: result.products,
    });
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

app.get('/api/naver/shop', (_req, res) => {
  res.status(410).json({
    code: 'DB_ONLY_MODE',
    message: '실시간 네이버 쇼핑 API는 비활성화되어 있습니다. Cloud SQL DB 검색은 /api/products를 사용하세요.',
  });
});

app.post('/api/cart/explanation', async (req, res) => {
  try {
    const explanation = await observeGeminiRequest(() => generateCartExplanation(req.body || {}));
    res.json({ ok: true, explanation });
  } catch (error) {
    const status = error.status || 502;
    // 400(장바구니 비어 있음)은 호출부 입력 문제다. 그 외 실패는 앱이 규칙 기반
    // 설명으로 대체하는 경우라 폴백으로 센다.
    if (status !== 400) recordGeminiFallback();
    res.status(status).json({
      ok: false,
      code: error.code || 'LLM_EXPLANATION_FAILED',
      message: error.message || 'Failed to generate cart explanation.',
    });
  }
});

app.use(express.static(mobileDistPath));
app.get(/^(?!\/api(?:\/|$)).*/, (req, res, next) => {
  const mobileIndexPath = path.join(mobileDistPath, 'index.html');
  if (!fs.existsSync(mobileIndexPath)) {
    next();
    return;
  }
  res.sendFile(mobileIndexPath);
});

const server = app.listen(port, () => {
  console.log(`FoodiGuard API server listening on http://0.0.0.0:${port}`);
});
requestTracer.observeServer(server);
lifecycle = installGracefulShutdown({ server, pools: [pool, readinessPool] });
