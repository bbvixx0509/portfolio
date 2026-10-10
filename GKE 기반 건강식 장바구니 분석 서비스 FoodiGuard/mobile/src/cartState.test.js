import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcileCartWithProfile, replaceCartItemOnce } from './cartState.js';

function product(id, name, allergens = []) {
  return { id, name, allergens, nutrients: { calories: 100 } };
}

test('B07 — 새 알레르기와 겹치는 식품만 기존 장바구니에서 제거한다', () => {
  const peanut = product('peanut', '땅콩 포함 식품', ['PEANUT']);
  const safe = product('safe', '안전 식품', []);
  const result = reconcileCartWithProfile([peanut, safe], { avoidIngredients: ['땅콩'] });

  assert.deepEqual(result.cart.map((item) => item.id), ['safe']);
  assert.deepEqual(result.removed.map((item) => item.id), ['peanut']);
});

test('B13 — 교체 버튼을 연속 실행해도 대체 식품은 정확히 하나만 남는다', () => {
  const original = product('original', '기존 식품');
  const replacement = product('replacement', '대체 식품');
  const first = replaceCartItemOnce([original], original, replacement);
  const second = replaceCartItemOnce(first, original, replacement);

  assert.equal(second.length, 1);
  assert.equal(second[0].id, 'replacement');
});

test('B13 — 이미 담긴 식품으로 교체할 때 중복을 만들지 않는다', () => {
  const original = product('original', '기존 식품');
  const replacement = product('replacement', '대체 식품');
  const result = replaceCartItemOnce([original, replacement], original, replacement);

  assert.deepEqual(result.map((item) => item.id), ['replacement']);
});

test('P1 장바구니 — 새 알레르기 조건이 여러 항목을 한 번에 걷어낸다', () => {
  const cart = [
    product('buckwheat', '메밀 냉면', ['BUCKWHEAT']),
    product('sulfite', '단무지', ['SULFITES']),
    product('safe', '흰쌀 즉석밥', []),
  ];
  // B06 으로 메밀·아황산류가 DB 에 생겼으므로, 그 조건을 고른 사용자의 장바구니에서도 빠져야 한다.
  const result = reconcileCartWithProfile(cart, { avoidIngredients: ['메밀', '아황산류'] });

  assert.deepEqual(result.cart.map((item) => item.id), ['safe']);
  assert.deepEqual(result.removed.map((item) => item.id), ['buckwheat', 'sulfite']);
});

test('P1 장바구니 — 제한이 없으면 담긴 것을 그대로 둔다', () => {
  const cart = [product('a', '식품 A', ['MILK']), product('b', '식품 B', [])];
  const result = reconcileCartWithProfile(cart, { avoidIngredients: [] });

  assert.deepEqual(result.cart.map((item) => item.id), ['a', 'b']);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(reconcileCartWithProfile([], { avoidIngredients: ['우유'] }).cart, []);
});
