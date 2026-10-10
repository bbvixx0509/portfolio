import assert from 'node:assert/strict';
import test from 'node:test';

import { formatBirthDate, isValidBirthDate, stepError, validMetric } from './profileInput.js';

const baseForm = {
  gender: '녀',
  birthDate: '2000.01.02',
  height: '165.25',
  weight: '57.75',
  activityLevel: '주 1~3회 걷기&가벼운 운동',
  dietaryGoal: '당류 저감',
};

test('P1 입력 — 생년월일은 입력 중간 단계까지 형식을 잡아 준다', () => {
  assert.equal(formatBirthDate('2000'), '2000');
  assert.equal(formatBirthDate('200001'), '2000.01');
  assert.equal(formatBirthDate('20000102'), '2000.01.02');
  // 사용자가 점을 직접 찍어도, 자릿수를 넘겨 눌러도 같은 결과가 된다.
  assert.equal(formatBirthDate('2000.01.02'), '2000.01.02');
  assert.equal(formatBirthDate('2000010299'), '2000.01.02');
  assert.equal(formatBirthDate(''), '');
});

test('P1 입력 — 달력에 없는 날짜와 미래 날짜는 통과시키지 않는다', () => {
  assert.equal(isValidBirthDate('2000.01.02'), true);
  assert.equal(isValidBirthDate('2000.02.30'), false);
  assert.equal(isValidBirthDate('2000.13.01'), false);
  assert.equal(isValidBirthDate('2000.1.2'), false);
  assert.equal(isValidBirthDate('2999.01.01'), false);
});

test('P1 입력 — 키·체중은 범위를 벗어나면 막는다', () => {
  assert.equal(validMetric('165.25', 30, 300), true);
  assert.equal(validMetric('30', 30, 300), false);
  assert.equal(validMetric('301', 30, 300), false);
  assert.equal(validMetric('', 30, 300), false);
  assert.equal(validMetric('abc', 30, 300), false);
});

test('P1 입력 — 단계마다 빠진 항목을 하나씩 알려 준다', () => {
  assert.equal(stepError(0, baseForm), '');
  assert.equal(stepError(1, baseForm), '');
  assert.equal(stepError(2, baseForm), '');

  assert.equal(stepError(0, { ...baseForm, gender: '' }), '성별을 선택해주세요.');
  assert.equal(stepError(0, { ...baseForm, birthDate: '2000.02.30' }), '생년월일을 YYYY.MM.DD 형식으로 입력해주세요.');
  assert.equal(stepError(0, { ...baseForm, height: '0' }), '키를 소수점 둘째 자리까지 입력해주세요.');
  assert.equal(stepError(0, { ...baseForm, weight: '600' }), '체중을 소수점 둘째 자리까지 입력해주세요.');
  assert.equal(stepError(1, { ...baseForm, activityLevel: '' }), '활동량을 하나 선택해주세요.');
  assert.equal(stepError(2, { ...baseForm, dietaryGoal: '' }), '식생활 목표를 한 가지 선택해주세요.');
});
