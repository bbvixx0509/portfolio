import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALLERGEN_LABELS,
  deriveAllergens,
  findCollisionEvidence,
  matchesAllergen,
} from './allergens.js';

test('B06 — 적재 규칙이 놓친 메밀·아황산류·잣을 원재료에서 찾아낸다', () => {
  // 평양냉면 계열. 적재 규칙이 메밀을 한 건도 잡지 못했던 대표 사례다.
  const buckwheat = deriveAllergens(['정제소금', '흑미가루', '주정', '소스', '메밀가루']);
  assert.deepEqual(buckwheat.labels, ['메밀']);
  assert.deepEqual(buckwheat.codes, ['BUCKWHEAT']);
  assert.equal(buckwheat.evidence['메밀'], '메밀가루');

  // 단무지 계열. 아황산계 표백제가 표시대상인데 0건이었다.
  const sulfites = deriveAllergens(['무', '젖산칼슘', '구연산', '아스파탐', '아황산나트륨']);
  assert.deepEqual(sulfites.labels, ['아황산류']);

  assert.deepEqual(deriveAllergens(['잣가루', '설탕']).labels, ['잣']);
});

test('B06 — 라벨 순서가 고정되고 19종 전부 코드로 매핑된다', () => {
  const derived = deriveAllergens(['밀가루', '계란', '우유', '새우']);
  assert.deepEqual(derived.labels, ['난류', '우유', '밀', '새우']);
  assert.deepEqual(derived.codes, ['EGG', 'MILK', 'WHEAT', 'SHRIMP']);
  assert.equal(new Set(ALLERGEN_LABELS).size, 19);
});

test('B06 — 원재료 사전에서 확인된 글자 겹침을 오판하지 않는다', () => {
  // 왼쪽은 걸려야 하는 원재료, 오른쪽은 같은 글자를 품었지만 걸리면 안 되는 원재료다.
  const cases = [
    ['밀', '밀가루', ['메밀가루', '밀크초콜릿', '호밀분말', '말토게닉아밀라아제', '밀리타리스동충하초분말']],
    ['쇠고기', '사골육수', ['염소고기', '돼지사골']],
    ['게', '꽃게', ['삶은스파게티면', '성게알', '멍게', '게피분말']],
    ['조개류', '굴농축액', ['굴비살', '건조덩굴월귤', '둥굴레뿌리']],
    ['난류', '알가열제품', ['알룰로오스', '면류첨가알칼리제', '알긴산나트륨', '명태알']],
    ['우유', '탈지분유', ['콩기름(대두유)', '유탕면', '유화제', '땅콩버터', '락토바실러스']],
    ['대두', '분리대두단백', ['호두분태', '완두', '녹두전분']],
    ['닭고기', '닭가슴살', ['김스낵용불닭소스']],
    ['땅콩', '땅콩분태', ['토피넛향혼합분말']],
  ];

  for (const [label, positive, negatives] of cases) {
    assert.equal(matchesAllergen(label, positive), true, `${label}: ${positive}`);
    for (const negative of negatives) {
      assert.equal(matchesAllergen(label, negative), false, `${label}: ${negative}`);
    }
  }
});

test('B06 — 밀 글자가 없는 밀가루(박력분·중력분·강력분)를 잡는다', () => {
  // 박력분·강력분·중력분은 밀가루이고, 같은 자리에 오는 박력쌀가루·강력쌀가루는 쌀가루다.
  for (const flour of ['박력분', '중력분', '강력분']) {
    assert.equal(matchesAllergen('밀', flour), true, flour);
  }
  for (const rice of ['박력쌀가루', '강력쌀가루', '화과자중력쌀가루']) {
    assert.equal(matchesAllergen('밀', rice), false, rice);
  }

  assert.equal(matchesAllergen('우유', '가공유장분'), true);
  assert.deepEqual(deriveAllergens(['모밀']).labels, ['메밀']);
});

test('B06 — 겹침으로 설명되는 오표시만 정정 대상으로 본다', () => {
  // 적재 규칙이 부분일치로 붙인 오표시는 근거 원재료를 특정할 수 있을 때만 뗀다.
  assert.equal(findCollisionEvidence('밀', ['메밀가루', '곤약분말']), '메밀가루');
  assert.equal(findCollisionEvidence('쇠고기', ['염소고기', '대파']), '염소고기');
  assert.equal(findCollisionEvidence('조개류', ['청미래덩굴잎', '팥앙금']), '청미래덩굴잎');

  // 겹침으로 설명되지 않으면 null 이고, 이때 재계산은 기존 표시를 유지한다.
  assert.equal(findCollisionEvidence('조개류', ['복합조미식품', '돼지지방']), null);
  assert.equal(findCollisionEvidence('우유', ['식물성크림']), null);
});

test('B06 — 공백·전각 표기를 정규화한 뒤 판정한다', () => {
  assert.equal(matchesAllergen('새우', ' 건 새우 '), true);
  assert.equal(matchesAllergen('토마토', '토마토　페이스트'), true);
  assert.deepEqual(deriveAllergens(['', null, undefined]).labels, []);
});
