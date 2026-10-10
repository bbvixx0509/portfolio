import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defaultProfile,
  expandAvoidToAllergens,
  getAvoidMatches,
  isAllowedForProfile,
  sortProducts,
  uniqueProducts,
} from './domain.js';

function product(id, name, extra = {}) {
  return {
    id,
    name,
    maker: extra.maker ?? '테스트제조',
    allergens: extra.allergens ?? [],
    ingredients: extra.ingredients ?? '',
    nutrients: {
      calories: 150, protein: 8, carbs: 20, fat: 4,
      sugar: 3, sodium: 200, saturatedFat: 1, fiber: 2,
      ...(extra.nutrients || {}),
    },
    ...extra.rest,
  };
}

test('P1 검색 — 앱 알레르기 표기를 DB 코드로 넓혀 준다', () => {
  assert.deepEqual(expandAvoidToAllergens(['메밀']), ['BUCKWHEAT']);
  assert.deepEqual(expandAvoidToAllergens(['잣']), ['PINE_NUT']);
  assert.deepEqual(expandAvoidToAllergens(['아황산류']), ['SULFITES']);
  // 묶음 표기는 해당 코드 전부로 펼쳐진다.
  assert.deepEqual(expandAvoidToAllergens(['갑각류']).sort(), ['CRAB', 'SHELLFISH', 'SHRIMP']);
  // 같은 코드를 두 번 골라도 중복되지 않고, 모르는 값은 무시한다.
  assert.deepEqual(expandAvoidToAllergens(['우유', '우유', '없는항목']), ['MILK']);
  assert.deepEqual(expandAvoidToAllergens([]), []);
});

test('P1 검색 — 프로필 알레르기와 겹치는 식품을 집어낸다', () => {
  const profile = { ...defaultProfile, avoidIngredients: ['메밀'] };
  const buckwheat = product('a', '평양냉면', { allergens: ['BUCKWHEAT'] });
  const safe = product('b', '흰쌀 즉석밥', { allergens: [] });

  assert.deepEqual(getAvoidMatches(buckwheat, profile), ['BUCKWHEAT']);
  assert.equal(isAllowedForProfile(buckwheat, profile), false);
  assert.equal(isAllowedForProfile(safe, profile), true);
  // 프로필에 제한이 없으면 아무것도 막지 않는다.
  assert.equal(isAllowedForProfile(buckwheat, defaultProfile), true);
});

test('P1 검색 — 같은 상품의 중복 노출을 접는다', () => {
  const items = [
    product('1', '저염 닭가슴살'),
    product('2', '저염  닭가슴살'), // 공백만 다른 같은 상품
    product('3', '저염 닭가슴살', { maker: '다른제조' }),
  ];
  const unique = uniqueProducts(items);

  assert.deepEqual(unique.map((item) => item.id), ['1', '3']);
  assert.deepEqual(uniqueProducts([]), []);
});

test('P1 검색 — 정렬 기준을 바꾸면 순서가 그에 맞게 바뀐다', () => {
  const items = [
    product('salty', '나 저염 라면', { nutrients: { sodium: 1800, sugar: 12 } }),
    product('clean', '가 담백 닭가슴살', { nutrients: { sodium: 90, sugar: 0 } }),
  ];

  const byName = sortProducts(items, 'name', defaultProfile).map((item) => item.id);
  assert.deepEqual(byName, ['clean', 'salty'], '가나다순은 이름 기준이다');

  const byScore = sortProducts(items, 'score', defaultProfile);
  assert.ok(byScore[0].analysis.score >= byScore[1].analysis.score, '추천순은 점수 내림차순이다');

  // 제한 성분 상품도 목록에서 사라지지 않는다 — 카드에 배지로 알리고 담기만 막는 설계다.
  const profile = { ...defaultProfile, avoidIngredients: ['메밀'] };
  const withBlocked = sortProducts(
    [...items, product('block', '메밀 냉면', { allergens: ['BUCKWHEAT'] })],
    'score',
    profile,
  );
  assert.equal(withBlocked.length, 3);
});
