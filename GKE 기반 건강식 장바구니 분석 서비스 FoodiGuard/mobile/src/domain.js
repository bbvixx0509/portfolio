import {
  buildAvoidTerms,
  getUnitConversion,
  scoreThresholds,
  buildNutritionRiskMatrix,
  calculateHealthMetrics,
  createScoreContext,
  getAvoidMatches as getWebAvoidMatches,
  scoreProduct as scoreWebProduct,
  summarizeCart as summarizeWebCart,
  summarizeCartCoverage,
} from './nutritionScoring.js';

export const defaultProfile = {
  age: '34',
  sex: 'male',
  height: '173',
  weight: '72',
  activity: 'light',
  goal: 'loss',
  intensity: 'gentle',
  // condition(질환명) 기본값을 두지 않는다. 사용자가 입력한 적 없는 건강정보가
  // 기기 프로필에 상주하고 explainCart 요청 본문에 실려 나가기 때문이다.
  // (프롬프트·DB에는 llm.js compactProfile·auth.js normalizeOnboardingProfile의
  //  허용목록이 막고 있으나, 허용목록에 기대는 구조 자체가 IRB에서 방어하기 어렵다.)
  // 점수 엔진은 이 필드를 참조하지 않는다 — 소비처 0건.
  avoidIngredients: [],
  // 목표는 점수식을 바꾸지 않고 테마 탐색과 하루 예산에만 사용한다.
  reduceTargets: [],
};

export const categories = [
  { key: 'all', label: '전체', query: '' },
  { key: 'meal', label: '간편식', query: '즉석' },
  { key: 'protein', label: '단백질', query: '닭가슴살' },
  { key: 'salad', label: '샐러드', query: '샐러드' },
  { key: 'rice', label: '밥·죽', query: '밥' },
  { key: 'snack', label: '건강 간식', query: '요거트' },
];

export const recommendationThemes = [
  { key: 'sodium', label: '나트륨을 고려한 식품', shortLabel: '나트륨', icon: 'water-outline' },
  { key: 'protein', label: '단백질을 챙기고 싶을 때', shortLabel: '단백질', icon: 'barbell-outline' },
  { key: 'sugar', label: '당류를 줄이고 싶을 때', shortLabel: '당류', icon: 'ice-cream-outline' },
  { key: 'saturatedFat', label: '포화지방을 줄이고 싶을 때', shortLabel: '포화지방', icon: 'heart-outline' },
];

// 앱 표기(피할 성분) → 식품 DB allergen_codes 값 매핑
export const allergenMap = {
  '난류': ['EGG'], '알류(가금류)': ['EGG'], '계란': ['EGG'], '달걀': ['EGG'],
  '우유': ['MILK'], '밀': ['WHEAT'], '대두': ['SOY'],
  '메밀': ['BUCKWHEAT'], '땅콩': ['PEANUT'], '호두': ['WALNUT'], '잣': ['PINE_NUT'], '견과류': ['WALNUT', 'PEANUT', 'PINE_NUT'],
  '갑각류': ['SHRIMP', 'CRAB', 'SHELLFISH'], '새우': ['SHRIMP'], '게': ['CRAB'], '조개류': ['SHELLFISH'],
  '생선': ['MACKEREL', 'SQUID'], '고등어': ['MACKEREL'], '오징어': ['SQUID'],
  '돼지고기': ['PORK'], '쇠고기': ['BEEF'], '소고기': ['BEEF'], '닭고기': ['CHICKEN'],
  '토마토': ['TOMATO'], '복숭아': ['PEACH'], '아황산류': ['SULFITES'],
};

export function expandAvoidToAllergens(avoidList = []) {
  const codes = new Set();
  avoidList.forEach((item) => (allergenMap[String(item).trim()] || []).forEach((code) => codes.add(code)));
  return [...codes];
}

export function toNumber(value, fallback = 0) {
  const parsed = Number(String(value ?? '').replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function calculateProfileMetrics(profile) {
  const metrics = calculateHealthMetrics(profile);
  return {
    ...metrics,
    bmi: Number(metrics.bmi.toFixed(1)),
    // 기존 화면에서 사용하는 이름을 유지합니다.
    calories: metrics.targetCalories,
    protein: metrics.proteinTarget,
  };
}

export function getAvoidMatches(product, profile = defaultProfile) {
  const scoringProduct = normalizeScoringProduct(product);
  const textHits = getWebAvoidMatches(scoringProduct, buildAvoidTerms(profile));
  const avoidCodes = expandAvoidToAllergens(profile.avoidIngredients || []);
  const productAllergens = Array.isArray(product?.allergens) ? product.allergens : [];
  const allergenHits = productAllergens.filter((code) => avoidCodes.includes(code));
  return [...new Set([...allergenHits, ...textHits])];
}

export function isAllowedForProfile(product, profile = defaultProfile) {
  return getAvoidMatches(product, profile).length === 0;
}

const scoreLabelCopy = {
  excellent: { label: '매우좋음', tone: 'green' },
  good: { label: '좋음', tone: 'leaf' },
  fair: { label: '보통', tone: 'sage' },
  poor: { label: '안좋음', tone: 'apricot' },
  veryPoor: { label: '매우안좋음', tone: 'crimson' },
  pending: { label: '점수 대기', tone: 'neutral' },
};

function normalizeScoringProduct(product = {}) {
  return {
    ...product,
    serving: product.serving || product.nutritionBasis?.servingSize || product.nutritionMatch?.servingSize || '',
    foodWeight: product.foodWeight || product.nutritionBasis?.totalWeight || product.nutritionMatch?.totalWeight || '',
    ingredients: product.ingredients || '',
    matchedProductName: product.matchedProductName || product.nutritionMatch?.foodName || product.name,
  };
}

function createMobileScoreContext(profile, productPool = [], overrides = {}) {
  return createScoreContext(profile, productPool.map(normalizeScoringProduct), overrides);
}

function getScoreReasons(analysis) {
  if (analysis.score === null) return ['필수 영양성분 정보가 부족해요.'];

  const reasons = [...(analysis.features?.guidelineComparison?.reasons || [])];
  if (!reasons.length) reasons.push('100g·1회 제공량 기준 주요 영양이 권장 범위에 들어요.');
  if (analysis.ingredientTags?.length) reasons.push(`원재료 확인: ${analysis.ingredientTags.join('·')}`);
  if (analysis.avoidMatches?.length) reasons.unshift(`제한 성분: ${analysis.avoidMatches.join(', ')}`);
  return [...new Set(reasons)].slice(0, 3);
}

export function scoreProduct(product, profile = defaultProfile, scoreContext = null) {
  const context = scoreContext?.profile
    ? scoreContext
    : createMobileScoreContext(profile, scoreContext?.productPool || []);
  const analysis = scoreWebProduct(normalizeScoringProduct(product), context);
  // 회피 성분은 점수로 벌하지 않는다 — 문헌 근거 없는 상한 대신 해당 식품을 목록·추천·장바구니에서
  // 통째로 제외하는 방식으로 간다(서버 excludeAllergens 쿼리 + 클라이언트 isAllowedForProfile).
  // 배지·목록 제외·담기 차단이 같은 판정을 쓰도록, 원재료 텍스트 매칭에 DB allergen 코드 매칭을 합친다.
  const avoidMatches = getAvoidMatches(product, context.profile || profile);
  if (avoidMatches.length) analysis.avoidMatches = avoidMatches;
  const copy = scoreLabelCopy[analysis.label] || scoreLabelCopy.fair;
  return {
    ...analysis,
    label: copy.label,
    tone: copy.tone,
    reasons: getScoreReasons(analysis),
  };
}

export function enrichProduct(product, profile, scoreContext = null) {
  return { ...product, analysis: scoreProduct(product, profile, scoreContext) };
}

export function uniqueProducts(products = []) {
  const seen = new Set();
  return products.filter((product) => {
    const normalizedName = String(product.name || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const normalizedMaker = String(product.maker || product.brand || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const key = `${normalizedName}|${normalizedMaker}|${product.foodWeight || product.serving || product.nutrients?.calories || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function sortProducts(products, mode = 'score', profile = defaultProfile, query = '') {
  const scoreContext = createMobileScoreContext(profile, products);
  // 제한 성분 상품도 결과에 남긴다 — 카드에 배지로 표시하고 장바구니 담기만 차단한다.
  const enriched = products.map((product) => enrichProduct(product, profile, scoreContext));
  return enriched.sort((a, b) => {
    if (mode === 'price') return toNumber(a.price, Number.MAX_SAFE_INTEGER) - toNumber(b.price, Number.MAX_SAFE_INTEGER);
    if (mode === 'name') return a.name.localeCompare(b.name, 'ko');
    if (mode === 'match') return getSearchRelevance(b, query) - getSearchRelevance(a, query) || b.analysis.score - a.analysis.score;
    return b.analysis.score - a.analysis.score;
  });
}

export function buildThemeRecommendations(products = [], themeKey, profile = defaultProfile, limit = 20) {
  if (!recommendationThemes.some((theme) => theme.key === themeKey)) return [];
  const scoreContext = createMobileScoreContext(profile, products);
  const candidates = uniqueProducts(products)
    .filter((product) => isAllowedForProfile(product, profile))
    .map((product) => enrichProduct(product, profile, scoreContext))
    .filter((product) => {
      const themeScore = product.analysis.features?.subScores?.[themeKey];
      return product.analysis.score >= scoreThresholds.good
        && Number.isFinite(themeScore)
        && themeScore >= 70;
    })
    .sort((a, b) => (
      b.analysis.features.subScores[themeKey] - a.analysis.features.subScores[themeKey]
      || b.analysis.score - a.analysis.score
      || String(a.id).localeCompare(String(b.id))
    ));

  const categoryCounts = new Map();
  const makerCounts = new Map();
  const result = [];
  for (const product of candidates) {
    const category = product.categorySmall || product.categories?.[2] || '기타';
    const maker = product.maker || product.brand || '제조사 미상';
    if ((categoryCounts.get(category) || 0) >= 2 || (makerCounts.get(maker) || 0) >= 2) continue;
    categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
    makerCounts.set(maker, (makerCounts.get(maker) || 0) + 1);
    result.push(product);
    if (result.length >= limit) break;
  }
  return result;
}

function getSearchRelevance(product, query) {
  const keyword = String(query || '').trim().toLowerCase();
  if (!keyword) return toNumber(product.nutritionMatch?.confidence || product.match?.nameScore, 0);
  const name = String(product.name || '').toLowerCase();
  const maker = String(product.maker || product.brand || product.store || '').toLowerCase();
  const category = String(product.category || '').toLowerCase();
  let score = 0;
  if (name === keyword) score += 1000;
  if (name.startsWith(keyword)) score += 700;
  if (name.includes(keyword)) score += 450;
  if (maker.includes(keyword)) score += 180;
  if (category.includes(keyword)) score += 120;
  return score + toNumber(product.nutritionMatch?.confidence || product.match?.nameScore, 0);
}

export function summarizeCart(items) {
  return summarizeWebCart(items);
}

export function analyzeCart(items, profile = defaultProfile, scope = { mode: 'meals', units: 1 }, productPool = []) {
  const eligibleItems = items.filter((item) => isAllowedForProfile(item, profile));
  const normalizedScope = typeof scope === 'number' ? { mode: 'meals', units: Math.max(1, scope) } : scope;
  const units = clamp(toNumber(normalizedScope.units, 1), 1, normalizedScope.mode === 'days' ? 7 : 3);
  const targetScale = normalizedScope.mode === 'days' ? units : units * 0.33;
  const settings = {
    singleMode: 'meal',
    cartMode: normalizedScope.mode === 'days' ? 'days' : 'meals',
    cartUnits: units,
  };
  const scoreContext = createMobileScoreContext(profile, productPool.length ? productPool : eligibleItems, { analysisSettings: settings });
  const totals = summarizeWebCart(eligibleItems);
  if (!eligibleItems.length) return { score: 0, label: '분석 대기', totals, reasons: [], weakest: null, riskRows: [], targetScale };

  const analyzedItems = eligibleItems.map((item) => enrichProduct(item, profile, scoreContext));
  const scoredItems = analyzedItems.filter((item) => item.analysis.score !== null);
  if (!scoredItems.length) return { score: 0, label: '분석 대기', totals, reasons: [], weakest: null, riskRows: [], targetScale };

  // 장바구니 점수는 이 값이 그대로 쓰인다(v2 8장 두 축 분리). 단일 식품과 같은 소수 한 자리 정밀도로 맞춘다.
  const productAverage = Math.round((scoredItems.reduce((sum, item) => sum + item.analysis.score, 0) / scoredItems.length) * 10) / 10;
  const riskMatrix = buildNutritionRiskMatrix(
    totals,
    scoreContext.profile,
    scoreContext.metrics,
    settings,
    productAverage,
    scoreContext.weights,
    summarizeCartCoverage(eligibleItems),
  );
  const cartLabel = scoreLabelCopy[riskMatrix.label] || scoreLabelCopy.fair;
  return {
    score: riskMatrix.score,
    label: cartLabel.label,
    totals,
    reasons: riskMatrix.reasons,
    // H5 — 합성 밥 항목은 cart에 없어 replaceCartItem이 매칭하지 못한다. weakest에서 제외해
    // '교체하기'가 아무 것도 안 바꾸면서 성공 토스트만 띄우는 상황을 없앤다.
    weakest: scoredItems.filter((item) => !item.isRice).slice().sort((a, b) => a.analysis.score - b.analysis.score)[0] || null,
    // H8 — AI 코치에 보낼 재채점 결과. 화면에 쓰는 점수와 같은 프로필로 계산된 값이다.
    scoredItems,
    // 위험도 행의 값·범위를 누적 영양량과 같은 "장바구니 합계" 기준으로 환산해 표시한다 (비율·판정은 동일).
    riskRows: riskMatrix.rows.map((row) => {
      const scale = (v) => (Number.isFinite(v) ? Math.round(v * units * 10) / 10 : v);
      return { ...row, value: scale(row.total), min: scale(row.min), max: scale(row.max), hardMax: scale(row.hardMax) };
    }),
    targetScale,
  };
}

export function buildReliability(items, profile = defaultProfile) {
  if (!items.length) return { score: 0, match: 0, nutrients: 0, profile: 0, reasons: [] };
  const required = ['calories', 'protein', 'carbs', 'sugar', 'sodium', 'saturatedFat'];
  const match = Math.round(items.reduce((sum, item) => sum + toNumber(item.nutritionMatch?.confidence || item.match?.nameScore, item.matchStatus === 'confirmed' ? 100 : 70), 0) / items.length);
  const nutrients = Math.round(items.reduce((sum, item) => sum + (required.filter((key) => item.nutrients?.[key] !== null && item.nutrients?.[key] !== undefined).length / required.length) * 100, 0) / items.length);
  const profileKeys = ['age', 'height', 'weight', 'sex', 'activity', 'goal', 'intensity'];
  const profileScore = Math.round((profileKeys.filter((key) => Boolean(profile[key])).length / profileKeys.length) * 100);
  const score = Math.round(match * 0.45 + nutrients * 0.35 + profileScore * 0.2);
  return { score, match, nutrients, profile: profileScore, reasons: [`DB 매칭 ${match}%`, `필수 영양소 ${nutrients}%`, `프로필 완성도 ${profileScore}%`] };
}

// 감사보고서 R1~R13 — 대체 상품 추천.
// 구조: 가중합을 폐기하고 「하드 필터 → 점수 단일 정렬」로 간다. 배포·검증된 6개 시스템
// (NHS Food Scanner · SaltSwitch · FoodSwitch · Stanford NCT06648226 · Forwood 2015 · Loesch 2022)이
// 예외 없이 이 구조이고, 유사도와 영양점수를 하나의 스칼라로 합치는 검증된 선례는 없다.
//
// 옛 식 `점수×0.68 + 유사도×22 + 동일카테고리×10`은 두 항이 고장나 있었다 —
// targetTokens가 중복 미제거 배열인데 분모만 Set이라 자카드가 1을 넘었고(전수 최대 1.500),
// '해당없음' 토큰이 전 상품 category에 있어 무관한 쌍도 유사도를 받았다.
//
// 후보는 서버(/api/products/alternatives)가 카테고리·동일명·나트륨0·원재료 자카드까지 좁혀 준다.
// 여기서는 점수 엔진이 필요한 판정만 한다.
const REPLACEMENT_MIN_GAIN = 5;        // R6 — 기존 값 유지. 실사용 경로에서 무영향이라 바꿀 근거가 없다.
const PORTION_BAND = [0.6, 1.4];       // R3 — Koutoukidis 2019 "between 60 and 140% of the weight"
const PARETO_KEYS = ['calories', 'sodium', 'sugar'];  // R4 — Stanford "at least as good or better"

// 1회 섭취량. 법정 참고량이 제품 총중량을 넘는 레코드가 13.5%라, 밴드·파레토를 그 값 위에
// 그대로 걸면 물리적으로 불가능한 비교가 된다. 총중량으로 클램프한다 — 포장보다 많이 먹을 수는 없다.
// ※ 점수 엔진의 getLegalReferenceAmount는 건드리지 않는다. 건드리면 등급 컷 재산출이 필요하다.
function intakeBasis(product) {
  const conversion = getUnitConversion(product, 1);
  const intake = conversion?.intakeAmount;
  if (!intake || !(intake.amount > 0)) return null;
  const pack = conversion?.packageAmount;
  const amount = pack && pack.unit === intake.unit && pack.amount > 0 ? Math.min(intake.amount, pack.amount) : intake.amount;
  return { amount, unit: intake.unit };
}

// 1회 섭취 기준 영양소. nutrients는 nutritionBasis.servingSize(대개 100g) 기준이다.
function perIntake(product, basis) {
  const per = parseAmount(product?.nutritionBasis?.servingSize || product?.serving) ;
  const denom = per && per.amount > 0 ? per.amount : 100;
  const out = {};
  for (const key of PARETO_KEYS) {
    const raw = product?.nutrients?.[key];
    out[key] = raw == null || raw === '' ? null : (toNumber(raw) / denom) * basis.amount;
  }
  return out;
}

function passesPortionBand(sourceBasis, candidateBasis) {
  if (!sourceBasis || !candidateBasis) return true;          // 판단할 수 없으면 막지 않는다
  if (sourceBasis.unit !== candidateBasis.unit) return true;  // g↔ml 혼재는 비교 불가
  const ratio = candidateBasis.amount / sourceBasis.amount;
  return ratio >= PORTION_BAND[0] && ratio <= PORTION_BAND[1];
}

// R4. 원본 값이 null이거나 0이면 그 축은 걸지 않는다 — 0에 '이하'를 요구하면 통과 가능한 후보가
// 정의상 존재하지 않는다(나트륨 0으로 등록된 원본 중 게이트 트리거 대상 182건이 여기 걸려 추천이 전멸했다).
function passesPareto(sourceNutrients, candidateNutrients) {
  return PARETO_KEYS.every((key) => {
    const src = sourceNutrients[key];
    if (src == null || src === 0) return true;
    const cand = candidateNutrients[key];
    return cand != null && cand <= src;
  });
}

// 후보 목록에서 대체안을 골라 점수 내림차순으로 돌려준다. 최대 limit개(R11).
// candidates는 서버가 준 배열이며, 이 함수는 순수 함수다 — 네트워크를 타지 않는다.
export function selectReplacements(weakest, candidates = [], profile = defaultProfile, cart = [], limit = 3) {
  if (!weakest) return [];
  const scoreContext = createMobileScoreContext(profile, []);
  const current = scoreProduct(weakest, profile, scoreContext);
  if (current.score == null) return [];
  // R10 — 원본이 이미 '좋음' 이상이면 대체를 권하지 않는다.
  if (current.score >= scoreThresholds.good) return [];

  const sourceBasis = intakeBasis(weakest);
  const sourceNutrients = sourceBasis ? perIntake(weakest, sourceBasis) : {};
  const cartIds = new Set(cart.map((item) => String(item.id)));
  const sourceName = String(weakest.name || '').toLowerCase().replace(/[^0-9a-z가-힣]/g, '');

  return candidates
    .filter((item) => {
      if (!item || cartIds.has(String(item.id)) || String(item.id) === String(weakest.id)) return false;
      if (String(item.name || '').toLowerCase().replace(/[^0-9a-z가-힣]/g, '') === sourceName) return false;  // R7
      return isAllowedForProfile(item, profile);
    })
    .map((item) => {
      const analysis = scoreProduct(item, profile, scoreContext);
      const basis = intakeBasis(item);
      return { item, analysis, basis, nutrients: basis ? perIntake(item, basis) : {} };
    })
    .filter(({ analysis, basis, nutrients }) => {
      if (analysis.score == null) return false;
      if (analysis.score < scoreThresholds.good) return false;                 // R5 절대 게이트
      if (analysis.score < current.score + REPLACEMENT_MIN_GAIN) return false; // R6 개선폭
      if (!passesPortionBand(sourceBasis, basis)) return false;                // R3 분량 밴드
      if (sourceBasis && !passesPareto(sourceNutrients, nutrients)) return false; // R4 파레토
      return true;
    })
    // R1 — 점수 단일 정렬키. 동점일 때만 원재료 유사도(서버가 계산해 실어 보낸 값) →
    // 동일 제조사(R13) → id 순으로 안정 정렬한다. 유사도를 랭킹 가중치로 쓰지 않는다.
    .sort((a, b) =>
      b.analysis.score - a.analysis.score
      || (toNumber(b.item.similarity) - toNumber(a.item.similarity))
      || ((b.item.maker === weakest.maker ? 1 : 0) - (a.item.maker === weakest.maker ? 1 : 0))
      || String(a.item.id).localeCompare(String(b.item.id)))
    .slice(0, limit)
    .map(({ item, analysis, nutrients }) => ({
      ...item,
      analysis,
      replacementMeta: {
        similarity: toNumber(item.similarity),
        sameMaker: item.maker === weakest.maker,
        gain: Math.round((analysis.score - current.score) * 10) / 10,
        // R12 — 이 값을 화면에 띄우지 않는다. 추천 3,015건 실측에서 델타가 커지는 원인의 상당수가
        // 영양 개선이 아니었다 — 스케일 오류 지문 18.3%, 원재료 유사도 0 쌍 44.5%,
        // 후보 1회량이 더 작아서인 경우 17.6%(열량 감소분 중앙 21.3%가 '덜 먹어서'), 단위 g↔ml 혼재 0.3%.
        // DB에도 나트륨 0인데 열량 100kcal 이상인 행이 389건 있어(결측을 0으로 코딩한 아티팩트),
        // 띄우는 순간 DB 오류가 소비자 대상 사실주장으로 승격된다.
        // 게다가 델타는 정렬키가 아니다 — 점수 1순위가 나트륨 감소 최대인 비율이 59.6%에 그친다
        // (후보 2개 이상인 원본 985건 기준. 성공 원본 전체로 넓히면 64.5%).
        // 표시로 전환하려면 게이트 4개를 전부 구현해야 한다:
        //   G1 나트륨 한 축만, 감소율 25~90%일 때만 (25%는 「식품등의 표시기준」 비교강조표시 관행)
        //   G2 replacementMeta.similarity === 0 이면 미표시
        //   G3 원본·후보 1회량 단위가 다르면 미표시
        //   G4 1회량 차이가 15% 초과면 미표시
        // 값 자체는 검증·A/B용으로 계산만 해 둔다.
        delta: PARETO_KEYS.reduce((acc, key) => {
          const from = sourceNutrients[key];
          const to = nutrients[key];
          if (from != null && to != null) acc[key] = { from: Math.round(from), to: Math.round(to) };
          return acc;
        }, {}),
      },
    }));
}

export function buildPairingSuggestions(product, pool = [], profile = defaultProfile) {
  const scoreContext = createMobileScoreContext(profile, pool);
  const text = `${product?.name || ''} ${product?.category || ''}`;
  const wanted = /밥|죽|면/.test(text)
    ? [{ label: '단백질', regex: /닭|두부|계란|달걀/ }, { label: '채소', regex: /샐러드|채소|야채/ }]
    : /닭|고기|두부|계란/.test(text)
      ? [{ label: '통곡물', regex: /현미|잡곡|밥/ }, { label: '채소', regex: /샐러드|채소|야채/ }]
      : [{ label: '단백질', regex: /닭|두부|계란/ }, { label: '식사', regex: /밥|죽|도시락/ }];
  return wanted.map((group) => ({
    label: group.label,
    product: pool
      .filter((item) => String(item.id) !== String(product.id) && group.regex.test(`${item.name} ${item.category}`) && isAllowedForProfile(item, profile))
      .map((item) => enrichProduct(item, profile, scoreContext))
      .sort((a, b) => b.analysis.score - a.analysis.score)[0] || null,
  })).filter((item) => item.product);
}

function parseAmount(value) {
  const match = String(value || '').replaceAll(',', '').match(/(\d+(?:\.\d+)?)\s*(kg|g|mg|ml|l)/i);
  if (!match) return null;
  let amount = Number(match[1]);
  let unit = match[2].toLowerCase();
  if (unit === 'kg') { amount *= 1000; unit = 'g'; }
  if (unit === 'l') { amount *= 1000; unit = 'ml'; }
  if (unit === 'mg') { amount /= 1000; unit = 'g'; }
  return { amount, unit };
}

export function getNutritionView(product, mode = 'per100') {
  const basis = parseAmount(product.serving) || { amount: 100, unit: 'g' };
  const packageAmount = parseAmount(product.foodWeight) || parseAmount(product.nutritionBasis?.totalWeight);
  let target = { amount: 100, unit: basis.unit };
  let label = `100${basis.unit} 기준`;
  if (mode === 'meal') {
    target = packageAmount && packageAmount.unit === basis.unit ? { ...packageAmount, amount: Math.min(packageAmount.amount, 250) } : basis;
    label = `한 끼 ${formatNumber(target.amount)}${target.unit}`;
  }
  if (mode === 'total') {
    target = packageAmount && packageAmount.unit === basis.unit ? packageAmount : basis;
    label = packageAmount ? `전체 ${formatNumber(target.amount)}${target.unit}` : '제품 기준';
  }
  const factor = basis.amount > 0 && basis.unit === target.unit ? target.amount / basis.amount : 1;
  const nutrients = Object.fromEntries(Object.entries(product.nutrients || {}).map(([key, value]) => [key, value == null ? null : toNumber(value) * factor]));
  return { nutrients, factor, label, basis, target };
}

export function createRiceItem(type = '현미밥', grams = 200) {
  const ratio = grams / 100;
  const brown = type === '현미밥';
  return {
    id: `rice-${type}-${grams}`,
    name: `${type} ${grams}g`,
    category: '밥류',
    store: '식사 추가',
    price: 0,
    isRice: true,
    // v2 점수 엔진은 nutritionBasis.servingSize로 100g 환산을 하므로, 합성 항목에도 기준량을 명시한다.
    // (없으면 총량이 100g당 밀도로 오독되어 열량 소점수가 부당하게 깎인다.)
    serving: `${grams}g`,
    nutritionBasis: { servingSize: `${grams}g`, referenceIntake: '210g' }, // 밥 1회 섭취참고량 210g(별표 3)
    nutrients: {
      calories: (brown ? 153 : 130) * ratio,
      carbs: (brown ? 32 : 28) * ratio,
      protein: (brown ? 3.3 : 2.6) * ratio,
      fat: (brown ? 1.1 : 0.3) * ratio,
      sugar: 0,
      sodium: 2 * ratio,
      fiber: (brown ? 1.8 : 0.4) * ratio,
      saturatedFat: 0.2 * ratio,
    },
  };
}

export function foodEmoji(product) {
  const text = `${product?.name || ''} ${product?.category || ''}`;
  if (/닭|고기|육류/.test(text)) return '🍗';
  if (/밥|죽|쌀/.test(text)) return '🍚';
  if (/샐러드|채소|야채/.test(text)) return '🥗';
  if (/요거트|우유|유제품/.test(text)) return '🥛';
  if (/과일|사과|바나나/.test(text)) return '🍎';
  if (/두부|콩/.test(text)) return '🫘';
  if (/국|탕|찌개/.test(text)) return '🍲';
  return '🥣';
}

export function formatNumber(value, maximumFractionDigits = 0) {
  return toNumber(value).toLocaleString('ko-KR', { maximumFractionDigits });
}
