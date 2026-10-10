import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// P1 접근성. 화면을 렌더링하지 않고 소스에서 계약을 확인한다 — 이 저장소에는
// react-native 렌더러 기반 테스트 도구가 없고, 스크린리더가 읽는 값은 결국
// JSX 에 적힌 accessibility* 속성이라 정적으로도 회귀를 막을 수 있다.
const here = path.dirname(fileURLToPath(import.meta.url));
const appSource = fs.readFileSync(path.resolve(here, '../App.js'), 'utf8');

// 가입 흐름은 App.js 밖에 있다. 동의 화면은 IRB 제출 대상이라 여기서 함께 지킨다.
const flowSources = [
  ['ConsentScreen.js', fs.readFileSync(path.resolve(here, 'ConsentScreen.js'), 'utf8')],
  ['SignupOnboarding.js', fs.readFileSync(path.resolve(here, 'SignupOnboarding.js'), 'utf8')],
];

// <Pressable ...> 하나를 여는 태그와 본문으로 잘라 낸다. 중첩 Pressable 을 고려해
// 여는 태그 수를 세면서 짝이 맞는 </Pressable> 까지 모은다.
function collectPressables(source) {
  const found = [];
  const openTag = /<Pressable(\s|>)/g;
  let match = openTag.exec(source);

  while (match) {
    const start = match.index;
    let cursor = start + '<Pressable'.length;
    let inString = '';
    // 여는 태그의 끝(>)을 찾는다. 속성값 문자열 안의 > 는 건너뛴다.
    while (cursor < source.length) {
      const char = source[cursor];
      if (inString) {
        if (char === inString) inString = '';
      } else if (char === '"' || char === "'" || char === '`') {
        inString = char;
      } else if (char === '>') break;
      cursor += 1;
    }

    const attributes = source.slice(start, cursor + 1);
    const selfClosing = source[cursor - 1] === '/';
    let body = '';
    if (!selfClosing) {
      let depth = 1;
      let scan = cursor + 1;
      const bodyStart = scan;
      while (scan < source.length && depth > 0) {
        if (source.startsWith('<Pressable', scan)) depth += 1;
        else if (source.startsWith('</Pressable>', scan)) depth -= 1;
        scan += 1;
      }
      body = source.slice(bodyStart, scan - 1);
    }

    const line = source.slice(0, start).split('\n').length;
    found.push({ line, attributes, body });
    openTag.lastIndex = cursor;
    match = openTag.exec(source);
  }

  return found;
}

const pressables = collectPressables(appSource);

test('P1 접근성 — 누를 수 있는 요소는 모두 역할을 밝힌다', () => {
  assert.ok(pressables.length > 30, `Pressable 을 찾지 못했다 (${pressables.length}개)`);

  const missing = pressables
    .filter((item) => !/accessibilityRole=/.test(item.attributes))
    .map((item) => `App.js:${item.line}`);

  assert.deepEqual(missing, [], `accessibilityRole 누락: ${missing.join(', ')}`);
});

test('P1 접근성 — 아이콘만 있는 버튼은 읽어 줄 이름을 가진다', () => {
  // 본문에 <Text> 가 없으면 스크린리더가 읽을 글자가 없다. 이때는 라벨이 필수다.
  const iconOnly = pressables.filter((item) => !/<Text/.test(item.body));
  const missing = iconOnly
    .filter((item) => !/accessibilityLabel=/.test(item.attributes))
    .map((item) => `App.js:${item.line}`);

  assert.deepEqual(missing, [], `accessibilityLabel 누락: ${missing.join(', ')}`);
});

test('P1 접근성 — 켜고 끄는 요소는 상태를 함께 노출한다', () => {
  const stateful = pressables.filter((item) => /accessibilityRole="(switch|checkbox|radio)"/.test(item.attributes));
  assert.ok(stateful.length > 0, '상태를 가진 컨트롤이 하나도 없다');

  const missing = stateful
    .filter((item) => !/accessibilityState=/.test(item.attributes))
    .map((item) => `App.js:${item.line}`);

  assert.deepEqual(missing, [], `accessibilityState 누락: ${missing.join(', ')}`);
});

test('P1 접근성 — 가입 흐름 화면도 역할과 이름을 밝힌다', () => {
  for (const [name, source] of flowSources) {
    const items = collectPressables(source);
    assert.ok(items.length > 0, `${name}: Pressable 을 찾지 못했다`);

    const noRole = items
      .filter((item) => !/accessibilityRole=/.test(item.attributes))
      .map((item) => `${name}:${item.line}`);
    assert.deepEqual(noRole, [], `accessibilityRole 누락: ${noRole.join(', ')}`);

    const noName = items
      .filter((item) => !/<Text/.test(item.body) && !/accessibilityLabel=/.test(item.attributes))
      .map((item) => `${name}:${item.line}`);
    assert.deepEqual(noName, [], `accessibilityLabel 누락: ${noName.join(', ')}`);
  }
});

// react-native-web 0.21 은 accessibilityState 를 DOM 으로 옮기지 않는다(forwardedProps 에
// 항목 자체가 없다). 웹 빌드에서 스크린리더가 체크 상태를 읽으려면 aria-* 를 따로 줘야 한다.
// 동의 화면에서 이게 빠지면 "무엇에 동의했는지" 자체가 읽히지 않는다.
test('P1 접근성 — 동의 화면 체크박스는 웹에서도 상태를 노출한다', () => {
  const source = flowSources.find(([name]) => name === 'ConsentScreen.js')[1];
  const checkboxes = collectPressables(source)
    .filter((item) => /accessibilityRole="checkbox"/.test(item.attributes));

  assert.ok(checkboxes.length >= 2, `동의 체크박스를 찾지 못했다 (${checkboxes.length}개)`);
  const missing = checkboxes
    .filter((item) => !/aria-checked=/.test(item.attributes))
    .map((item) => `ConsentScreen.js:${item.line}`);

  assert.deepEqual(missing, [], `aria-checked 누락: ${missing.join(', ')}`);
});

test('동의 저장 인증 실패는 다시 로그인할 수 있는 화면으로 복구한다', () => {
  const consentSource = flowSources.find(([name]) => name === 'ConsentScreen.js')[1];
  const apiSource = fs.readFileSync(path.resolve(here, 'api.js'), 'utf8');

  assert.match(apiSource, /error\.status = response\.status/);
  assert.match(consentSource, /error\.status === 401/);
  assert.match(consentSource, /accessibilityLabel="다시 로그인"/);
  assert.match(consentSource, /onPress=\{onRequireLogin\}/);
  assert.match(appSource, /onRequireLogin=\{clearSession\}/);
});
