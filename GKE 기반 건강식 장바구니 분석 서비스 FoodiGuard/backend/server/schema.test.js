import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./schema.js', import.meta.url), 'utf8');

function block(name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} 를 찾지 못했다`);
  const end = source.indexOf('\n}', start);
  return source.slice(start, end);
}

// 술어는 상수로 빠져 있으므로 함수 본문과 함께 본다.
function constant(name) {
  const start = source.indexOf(`const ${name} =`);
  assert.notEqual(start, -1, `${name} 을 찾지 못했다`);
  return source.slice(start, source.indexOf('`;', start));
}

const searchIndex = constant('SEARCHABLE_PREDICATE') + block('createSearchIndexes');
const appView = block('rebuildAppView');

// 앱은 food_app_view 를 통해 조건을 걸기 때문에 플래너가 보는 것은 원본 컬럼이 아니라
// 뷰가 노출하는 표현식이다. 부분 인덱스 술어를 원본 컬럼으로 쓰면 그 표현식을 함의하지
// 못해 인덱스가 통째로 죽고 검색이 전수 스캔으로 돌아간다. 실제로 한 번 그렇게 죽었다
// (뷰 경유 86ms, 원본 테이블 직접 1.8ms). 둘이 같이 움직이도록 묶어 둔다.
const filterColumns = [
  { column: 'ingredient_status', expression: "LOWER(COALESCE(p.ingredient_status, 'UNMATCHED'))" },
  { column: 'health_functional_decision', expression: "COALESCE(p.health_functional_decision, 'UNVERIFIED')" },
];

for (const { column, expression } of filterColumns) {
  test(`검색 인덱스 술어가 뷰의 ${column} 표현식과 같은 모양이다`, () => {
    assert.ok(appView.includes(expression), `뷰가 ${expression} 를 더 이상 쓰지 않는다`);

    // 인덱스는 food_products 를 직접 걸므로 별칭만 빠진다.
    const withoutAlias = expression.replace(/\bp\./g, '');
    const normalize = (text) => text.replace(/::TEXT/gi, '').replace(/\s+/g, ' ');
    assert.ok(
      normalize(searchIndex).includes(normalize(withoutAlias)),
      `인덱스 술어가 ${withoutAlias} 를 쓰지 않는다 — 뷰 경유 검색이 전수 스캔이 된다`,
    );
  });
}

test('검색 인덱스는 원본 컬럼을 그대로 술어에 쓰지 않는다', () => {
  const predicate = searchIndex.slice(searchIndex.indexOf('WHERE'));
  assert.doesNotMatch(predicate, /(?<!COALESCE\()\bingredient_status\s*=/);
  assert.doesNotMatch(predicate, /(?<!COALESCE\()\bhealth_functional_decision\s+NOT\s+IN/i);
});

// 테마 조회는 정렬 키가 달라 기본 인덱스를 못 탄다. 정렬 키마다 부분 인덱스를 두는데,
// 그 목록이 index.js 의 ORDER BY 와 갈라지면 갈라진 테마만 조용히 전수 정렬로 돌아간다.
// 표를 schema.js 한 곳에서 내보내고, 인덱스가 그 표를 다 덮는지 여기서 확인한다.
test('테마마다 정렬 키 부분 인덱스가 있다', async () => {
  const { themeOrderColumns } = await import('./schema.js');
  const themes = Object.entries(themeOrderColumns);
  assert.ok(themes.length > 0, '테마 표가 비어 있다');

  for (const [theme, [column, direction]] of themes) {
    assert.match(
      searchIndex,
      new RegExp(`idx_food_products_theme_\\$\\{theme\\.toLowerCase\\(\\)\\}|${theme.toLowerCase()}`),
      `${theme} 인덱스 이름이 없다`,
    );
    assert.ok(['ASC', 'DESC'].includes(direction), `${theme} 정렬 방향이 이상하다: ${direction}`);
    assert.match(column, /^[a-z_]+$/, `${theme} 정렬 컬럼이 이상하다: ${column}`);
  }

  // 인덱스는 표를 순회해서 만들어야 한다. 하드코딩하면 표에 테마를 추가할 때 빠진다.
  assert.ok(
    searchIndex.includes('Object.entries(themeOrderColumns)'),
    '테마 인덱스를 themeOrderColumns 순회로 만들지 않는다',
  );
  assert.ok(searchIndex.includes('IS NOT NULL'), '테마 인덱스 술어에 IS NOT NULL 이 없다');
});
