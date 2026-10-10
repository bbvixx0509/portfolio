// 대체 상품 추천(감사보고서 R1~R13)과 장바구니 정합 규칙의 골든 테스트.
// 실행: node --test mobile/src/replacement.test.js
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import { analyzeCart, buildThemeRecommendations, defaultProfile, selectReplacements } from './domain.js';
import { buildNutritionRiskMatrix, calculateHealthMetrics, createScoreContext, defaultAnalysisSettings, scoreProduct, scoreThresholds, summarizeCart, summarizeCartCoverage } from './nutritionScoring.js';

const PROFILE = { age: '30', sex: 'female', height: '160', weight: '57', activity: 'normal', weightGoal: 'maintain', avoidIngredients: [] };

// 100g 기준 영양소를 받아 상품 하나를 만든다. serving/referenceIntake를 명시해
// 1회 섭취량이 테스트마다 결정적으로 나오게 한다.
function makeProduct(id, name, per100, { serving = '100g', reference = '100g', weight = '100g', category = '면류 > 해당없음 > 유탕면 > 해당없음', maker = 'A사', ingredients = '밀가루, 정제소금' } = {}) {
  return {
    id, name, category, maker, ingredients,
    serving, foodWeight: weight,
    nutritionBasis: { servingSize: serving, totalWeight: weight, referenceIntake: reference },
    nutrients: { calories: null, protein: null, carbs: null, fat: null, sugar: null, sodium: null, saturatedFat: null, fiber: null, ...per100 },
  };
}

const POOR = makeProduct('src', '원본라면', { calories: 450, protein: 9, sugar: 6, sodium: 1500, saturatedFat: 8, fiber: 2 });
const GOOD = makeProduct('good', '메밀국수', { calories: 340, protein: 14, sugar: 1, sodium: 6, saturatedFat: 0.3, fiber: 3 });

function scoreOf(product) {
  return scoreProduct(product, PROFILE, createScoreContext(PROFILE, [])).score;
}

test('R5 — 절대 게이트: 좋음 미만 후보는 추천하지 않는다', () => {
  const mediocre = makeProduct('mid', '보통라면', { calories: 430, protein: 9, sugar: 5, sodium: 1200, saturatedFat: 7, fiber: 2 });
  assert.ok(scoreOf(mediocre) < scoreThresholds.good, '전제: 후보가 좋음 미만이어야 한다');
  assert.equal(selectReplacements(POOR, [mediocre], PROFILE, []).length, 0);
});

test('R5/R1 — 게이트를 통과한 후보는 점수 내림차순으로 나온다', () => {
  const better = makeProduct('b2', '쌀국수', { calories: 330, protein: 15, sugar: 1, sodium: 5, saturatedFat: 0.2, fiber: 4 });
  const picked = selectReplacements(POOR, [GOOD, better], PROFILE, [], 3);
  assert.ok(picked.length >= 2, '두 후보 모두 게이트를 통과해야 한다');
  assert.ok(picked[0].analysis.score >= picked[1].analysis.score, '점수 내림차순');
});

test('R6 — 개선폭이 5점 미만이면 제외한다', () => {
  const src = makeProduct('s2', '준수한면', { calories: 300, protein: 16, sugar: 1, sodium: 5, saturatedFat: 0.2, fiber: 4 });
  const barely = makeProduct('b3', '거의같은면', { calories: 302, protein: 16, sugar: 1, sodium: 5, saturatedFat: 0.2, fiber: 4 });
  const gap = scoreOf(barely) - scoreOf(src);
  assert.ok(Math.abs(gap) < 5, `전제: 점수 차가 5 미만이어야 한다 (실제 ${gap})`);
  assert.equal(selectReplacements(src, [barely], PROFILE, []).length, 0);
});

test('R10 — 원본이 이미 좋음 이상이면 아예 추천하지 않는다', () => {
  assert.ok(scoreOf(GOOD) >= scoreThresholds.good, '전제: 원본이 좋음 이상');
  assert.equal(selectReplacements(GOOD, [makeProduct('x', '더좋은면', { calories: 300, protein: 20, sugar: 0, sodium: 3, saturatedFat: 0, fiber: 6 })], PROFILE, []).length, 0);
});

test('R7 — 이름이 같은 제품(다른 용량)은 대체로 치지 않는다', () => {
  const sameName = makeProduct('dup', '원본라면', { calories: 340, protein: 14, sugar: 1, sodium: 6, saturatedFat: 0.3, fiber: 3 }, { weight: '230g' });
  assert.equal(selectReplacements(POOR, [sameName], PROFILE, []).length, 0);
});

test('R4 — 파레토: 1회 섭취 기준으로 한 축이라도 원본보다 나쁘면 제외한다', () => {
  const worseSodium = makeProduct('ws', '고나트륨면', { calories: 300, protein: 20, sugar: 0, sodium: 1600, saturatedFat: 0, fiber: 6 });
  const picked = selectReplacements(POOR, [worseSodium], PROFILE, []);
  assert.equal(picked.length, 0, '나트륨이 원본보다 높으면 점수가 높아도 제외');
});

test('R4 — 원본 나트륨이 0이면 그 축은 걸지 않는다 (추천 전멸 방지)', () => {
  // 나트륨 0으로 등록된 원본은 '후보 나트륨 ≤ 0'을 만족할 후보가 정의상 없다.
  const zeroNa = makeProduct('z', '나트륨0원본', { calories: 500, protein: 3, sugar: 20, sodium: 0, saturatedFat: 10, fiber: 0 });
  assert.ok(scoreOf(zeroNa) < scoreThresholds.good, '전제: 원본이 좋음 미만');
  const cand = makeProduct('zc', '개선면', { calories: 300, protein: 14, sugar: 1, sodium: 40, saturatedFat: 0.3, fiber: 3 });
  assert.equal(selectReplacements(zeroNa, [cand], PROFILE, []).length, 1, '나트륨 축을 풀어야 추천이 나온다');
});

test('R3 — 분량 밴드: 1회 섭취량이 0.6~1.4배를 벗어나면 제외한다', () => {
  const tiny = makeProduct('t', '초소량면', { calories: 340, protein: 14, sugar: 1, sodium: 6, saturatedFat: 0.3, fiber: 3 },
    { serving: '100g', reference: '20g', weight: '20g' });
  const picked = selectReplacements(POOR, [tiny], PROFILE, []);
  assert.equal(picked.length, 0, '1회 20g vs 원본 100g = 0.2배라 밴드 이탈');
});

test('R13 — 점수 동점이면 원재료 유사도 → 동일 제조사 순으로 가른다', () => {
  const base = { calories: 340, protein: 14, sugar: 1, sodium: 6, saturatedFat: 0.3, fiber: 3 };
  const farSim = { ...makeProduct('f', '동점A', base, { maker: 'B사' }), similarity: 0.1 };
  const nearSim = { ...makeProduct('n', '동점B', base, { maker: 'B사' }), similarity: 0.9 };
  const picked = selectReplacements(POOR, [farSim, nearSim], PROFILE, [], 2);
  assert.equal(picked.length, 2);
  assert.equal(picked[0].analysis.score, picked[1].analysis.score, '전제: 점수가 같아야 한다');
  assert.equal(picked[0].id, 'n', '유사도가 높은 쪽이 앞');
});

test('R11 — 최대 개수를 넘겨 반환하지 않는다', () => {
  const many = Array.from({ length: 8 }, (_, i) =>
    makeProduct(`m${i}`, `대안${i}`, { calories: 340 - i, protein: 14, sugar: 1, sodium: 6, saturatedFat: 0.3, fiber: 3 }));
  assert.ok(selectReplacements(POOR, many, PROFILE, [], 3).length <= 3);
});

test('장바구니에 이미 담긴 후보는 제외한다', () => {
  assert.equal(selectReplacements(POOR, [GOOD], PROFILE, [{ id: 'good' }]).length, 0);
});

test('H5 — weakest에 합성 밥 항목은 뽑히지 않는다', () => {
  const rice = { ...makeProduct('rice-현미밥-200', '현미밥 200g', { calories: 76, protein: 1.6, sugar: 0, sodium: 2, saturatedFat: 0.2, fiber: 0.6 }), isRice: true };
  const result = analyzeCart([POOR, rice], PROFILE, { mode: 'meals', units: 1 }, []);
  assert.ok(result.weakest, 'weakest가 있어야 한다');
  assert.equal(result.weakest.isRice, undefined, '밥이 weakest로 뽑히면 교체가 no-op이 된다');
});

test('H8 — analyzeCart가 재채점 결과(scoredItems)를 노출한다', () => {
  const result = analyzeCart([POOR, GOOD], PROFILE, { mode: 'meals', units: 1 }, []);
  assert.ok(Array.isArray(result.scoredItems));
  assert.equal(result.scoredItems.length, 2);
  assert.ok(result.scoredItems.every((item) => item.analysis?.score != null));
});

test('H2 — 위험 사유는 stable이 아닌 행만 담는다', () => {
  const cart = [POOR, POOR];
  const metrics = calculateHealthMetrics(PROFILE);
  const ctx = createScoreContext(PROFILE, []);
  const matrix = buildNutritionRiskMatrix(
    summarizeCart(cart, defaultAnalysisSettings), PROFILE, metrics, defaultAnalysisSettings,
    60, ctx.weights, summarizeCartCoverage(cart),
  );
  const stableReasons = matrix.rows.filter((row) => row.level === 'stable').map((row) => row.reason);
  assert.ok(matrix.reasons.every((reason) => !stableReasons.includes(reason)), 'stable 행의 문구가 사유에 섞이면 안 된다');
});

test('장바구니 점수는 담은 식품 점수의 평균이다 (v2 8장 두 축 분리)', () => {
  const result = analyzeCart([POOR, GOOD], PROFILE, { mode: 'meals', units: 1 }, []);
  const expected = Math.round(((scoreOf(POOR) + scoreOf(GOOD)) / 2) * 10) / 10;
  assert.equal(result.score, expected);
});

test('좋은 식품을 더 담아도 점수가 떨어지지 않는다', () => {
  const one = analyzeCart([GOOD], PROFILE, { mode: 'meals', units: 1 }, []).score;
  const six = analyzeCart(Array.from({ length: 6 }, () => GOOD), PROFILE, { mode: 'meals', units: 1 }, []).score;
  assert.equal(six, one, '예산 축이 점수를 먹으면 개수가 늘수록 떨어진다');
});

test('H7 — 기본 프로필에 저감 목표가 켜져 있지 않다', () => {
  assert.deepEqual(defaultProfile.reduceTargets, [], '사용자가 고른 적 없는 목표가 채점 상한을 조이면 안 된다');
});

test('IRB 1-5 — 식생활 목표는 단일식품 점수를 바꾸지 않는다', async () => {
  const { calculateHealthMetrics, getNutrientGuidelineSpecs } = await import('./nutritionScoring.js');
  const limitOf = (targets) => {
    const p = { ...PROFILE, reduceTargets: targets };
    const specs = getNutrientGuidelineSpecs(p, calculateHealthMetrics(p), 'single');
    return { sugar: specs.find((x) => x.key === 'sugar').max, sat: specs.find((x) => x.key === 'saturatedFat').max };
  };
  const off = limitOf([]);
  const on = limitOf(['sugar', 'saturatedFat']);
  assert.deepEqual(on, off, '목표 선택이 개인 영양 기준을 임의로 조이면 안 된다');
  const ctxOff = createScoreContext({ ...PROFILE, reduceTargets: [] }, []);
  const ctxOn = createScoreContext({ ...PROFILE, reduceTargets: ['sugar', 'saturatedFat'] }, []);
  const sweet = makeProduct('sw', '단과자', { calories: 420, protein: 4, sugar: 30, sodium: 200, saturatedFat: 9, fiber: 1 });
  assert.equal(scoreProduct(sweet, PROFILE, ctxOn).score, scoreProduct(sweet, PROFILE, ctxOff).score);
});

test('IRB 1-5 — 테마 추천은 전체 좋음 이상과 축 점수 70 이상만 통과시킨다', () => {
  const proteinGood = makeProduct('p-theme', '고단백식품', { calories: 140, protein: 32, sugar: 1, sodium: 100, saturatedFat: 0.5, fiber: 4 }, { category: '가공식품 > 단백질 > 닭가슴살', maker: 'A사' });
  const proteinLow = makeProduct('p-low', '저단백식품', { calories: 140, protein: 1, sugar: 1, sodium: 100, saturatedFat: 0.5, fiber: 4 }, { category: '가공식품 > 단백질 > 닭가슴살', maker: 'B사' });
  const result = buildThemeRecommendations([proteinGood, proteinLow], 'protein', PROFILE);
  assert.ok(result.every((item) => item.analysis.score >= scoreThresholds.good));
  assert.ok(result.every((item) => item.analysis.features.subScores.protein >= 70));
  assert.ok(result.some((item) => item.id === 'p-theme'));
  assert.ok(!result.some((item) => item.id === 'p-low'));
});

test('R12 — 델타는 계산되지만 수치 표시용 게이트를 통과한 것만 쓸 수 있다', () => {
  const picked = selectReplacements(POOR, [GOOD], PROFILE, [], 1);
  assert.equal(picked.length, 1);
  const meta = picked[0].replacementMeta;
  assert.ok(meta.delta && typeof meta.delta === 'object', '값 자체는 검증·A/B용으로 남긴다');
  // similarity가 0인 후보는 G2에서 걸러져야 한다 — 서버가 유사도를 실어 보내지 않으면 0이다
  assert.equal(meta.similarity, 0, '이 테스트 픽스처는 서버 유사도가 없으므로 0');
});

test('R2 — 카테고리 사다리 단계가 요청까지 실제로 전달된다', () => {
  // 서버는 점수를 모르므로 "게이트 통과 후보 0"을 판정할 수 없다. 그래서 단계를 클라이언트가 올리는데,
  // level을 URL에 싣지 않으면 세 번의 요청이 완전히 같아져 폴백이 조용히 죽는다(실제로 그렇게 나갔었다).
  // api.js는 react-native에 의존해 node에서 import할 수 없으므로 소스로 확인한다.
  const here = path.dirname(new URL(import.meta.url).pathname);
  const api = fs.readFileSync(path.join(here, 'api.js'), 'utf8');
  const app = fs.readFileSync(path.join(here, '..', 'App.js'), 'utf8');

  const fn = api.slice(api.indexOf('export function fetchAlternatives'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(/\blevel\b/.test(body), 'fetchAlternatives가 level 인자를 받지 않는다');
  assert.ok(body.includes("params.set('level'"), 'level이 쿼리스트링에 실리지 않는다');

  const loop = app.slice(app.indexOf('for (const level of [0, 1, 2]'));
  const call = loop.slice(0, loop.indexOf('});'));
  assert.ok(/^\s*level,\s*$/m.test(call), '루프의 level이 fetchAlternatives 호출에 전달되지 않는다');
});

test('R2 — 후보가 0인 단계에서 사다리를 멈추지 않는다', () => {
  // "이 단계에서 후보가 없으면 더 넓혀도 같다"는 최적화가 들어 있었으나 전제가 틀렸다.
  // 파레토 프리필터가 정확 일치(레벨 0)에만 걸리므로 레벨 0이 비어도 레벨 1에는 후보가 남는다.
  // 실측 200건 중 9건이 여기서 끊겼고 8건은 계속 내려갔다면 카드가 나왔다(성공률 83.5% → 87.5%).
  const here = path.dirname(new URL(import.meta.url).pathname);
  const app = fs.readFileSync(path.join(here, '..', 'App.js'), 'utf8');
  const loop = app.slice(app.indexOf('for (const level of [0, 1, 2]'));
  const body = loop.slice(0, loop.indexOf('\n        }'));
  assert.ok(
    !/if \(!payload\.products\?\.length\) break/.test(body),
    '후보 0에서 break하면 폴백이 조용히 죽는다',
  );
});
