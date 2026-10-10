import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalConsentText,
  consentContentHash,
  consentDocuments,
  consentStateFromRecords,
  normalizeConsentSubmission,
  publicConsentDocuments,
  requiredConsentTypes,
} from './consents.js';

function agreementFor(...types) {
  return {
    agreements: types.map((type) => {
      const document = consentDocuments.find((item) => item.type === type);
      return { type, version: document.version };
    }),
  };
}

// 스키마의 CHECK 제약에 있는 값. 화면에 띄우는 문서는 이 중 일부일 수 있다 — RESEARCH 는
// 실제 처리(이용 기록 적재·가명처리·철회)가 구현되지 않아 문구에서 빼 두었다.
const SCHEMA_TYPES = ['PRIVACY', 'HEALTH_DATA', 'RESEARCH', 'NON_MEDICAL_NOTICE'];
const SHOWN_TYPES = ['PRIVACY', 'HEALTH_DATA', 'NON_MEDICAL_NOTICE'];

test('화면에 띄우는 문서는 스키마가 허용한 consent_type 안에만 있다', () => {
  for (const document of consentDocuments) {
    assert.ok(SCHEMA_TYPES.includes(document.type), `${document.type}: user_consents CHECK 제약에 없는 값`);
  }
});

test('IRB 가 요구한 개인정보·건강정보·비의료 안내 세 문서가 모두 필수로 들어 있다', () => {
  assert.deepEqual(consentDocuments.map((document) => document.type), SHOWN_TYPES);
  assert.deepEqual(requiredConsentTypes(), SHOWN_TYPES);
});

// 하지 않는 처리에 동의를 받으면 동의서 자체가 허위 진술이 된다. 연구 목적 이용을 다시 넣으려면
// 이용 기록 적재·가명처리·철회 경로를 먼저 구현해야 하므로, 되돌아오는 것을 여기서 막는다.
test('구현되지 않은 연구 목적 이용 동의는 화면에 뜨지 않는다', () => {
  assert.equal(consentDocuments.some((document) => document.type === 'RESEARCH'), false);
});

test('문서마다 화면이 그려야 할 항목이 모두 있다', () => {
  for (const document of consentDocuments) {
    assert.ok(document.version, `${document.type}: version 누락`);
    assert.ok(document.title, `${document.type}: title 누락`);
    assert.ok(document.summary, `${document.type}: summary 누락`);
    assert.ok(document.checkboxLabel, `${document.type}: checkboxLabel 누락`);
    assert.ok(document.footer, `${document.type}: footer 누락`);
    assert.ok(document.sections.length >= 2, `${document.type}: 전문 섹션이 너무 적다`);
    for (const section of document.sections) {
      assert.ok(section.heading, `${document.type}: 섹션 heading 누락`);
      const hasContent = Boolean(section.body) || (section.rows || []).length > 0 || (section.bullets || []).length > 0;
      assert.ok(hasContent, `${document.type}/${section.heading}: 본문이 비어 있다`);
    }
  }
});

// 화면은 heading·label·bullet 문자열을 그대로 React key 로 쓴다. 한 문서 안에서 겹치면
// 항목이 사라지거나 잘못 갱신된다.
test('한 문서 안에서 제목·항목명·불릿이 겹치지 않는다', () => {
  for (const document of consentDocuments) {
    const headings = document.sections.map((section) => section.heading);
    assert.equal(new Set(headings).size, headings.length, `${document.type}: 섹션 제목 중복`);

    for (const section of document.sections) {
      const labels = (section.rows || []).map((row) => row.label);
      assert.equal(new Set(labels).size, labels.length, `${document.type}/${section.heading}: 항목명 중복`);
      const bullets = section.bullets || [];
      assert.equal(new Set(bullets).size, bullets.length, `${document.type}/${section.heading}: 불릿 중복`);
    }
  }
});

test('체크박스 라벨이 필수·선택을 앞에서 밝힌다', () => {
  for (const document of consentDocuments) {
    const expected = document.required ? '(필수)' : '(선택)';
    assert.ok(
      document.checkboxLabel.startsWith(expected),
      `${document.type}: 라벨이 ${expected} 로 시작하지 않는다 — ${document.checkboxLabel}`,
    );
  }
});

// backend/server/llm.js 의 compactProfile() 이 성별·만 나이·키·체중·활동량·목표·알레르기 항목을
// Vertex AI 프롬프트에 실어 보낸다. 이 사실을 건강정보 동의서가 빠뜨리거나, 반대로 "보내지
// 않는다"고 적으면 민감정보에 관한 허위 고지가 된다. 문구가 되돌아가는 것을 여기서 막는다.
test('건강정보 동의서가 외부 AI 전송을 사실대로 고지한다', () => {
  const health = consentDocuments.find((document) => document.type === 'HEALTH_DATA');
  const text = canonicalConsentText(health);

  assert.match(text, /Vertex AI/, '수탁자(Vertex AI)를 밝히지 않았다');
  assert.match(text, /전송 항목/, '전송 항목을 표로 밝히지 않았다');
  for (const field of ['성별', '만 나이', '키', '체중', '활동량', '식생활 목표', '알레르기']) {
    assert.ok(text.includes(field), `전송 항목 고지에 ${field} 가 빠졌다`);
  }
  assert.match(text, /대한민국 밖|국외/, '국외 처리 가능성을 밝히지 않았다');

  // 한 줄 안에서만 본다. [^.]* 로 두면 줄바꿈을 넘어가 "전송 항목" 줄과 그 다음의
  // "전송되지 않는 항목" 줄이 이어져 붙는다.
  const denial = /(성별|키|체중|알레르기)[^.\n]*전송(되지|하지) 않/;
  assert.equal(denial.test(text), false, '실제로 전송되는 항목을 전송하지 않는다고 적었다');
});

test('개인정보 동의서가 이름·이메일 전송 여부만 다룬다', () => {
  const privacy = consentDocuments.find((document) => document.type === 'PRIVACY');
  const text = canonicalConsentText(privacy);
  const overreach = /(식품명과 영양성분 수치뿐|영양성분 수치만)/;
  assert.equal(overreach.test(text), false, '외부 전송 범위를 실제보다 좁게 적었다');
});

test('동의 거부권과 불이익을 모든 문서가 고지한다', () => {
  for (const document of consentDocuments) {
    assert.match(document.footer, /거부/, `${document.type}: 거부권 고지 누락`);
  }
});

// IRB 제출 문서로 그대로 캡처되므로 채우다 만 자리표시자가 남으면 안 된다.
test('문구에 자리표시자가 남아 있지 않다', () => {
  const placeholder = /(\[[^\]]*\]|\{\{|OO대학교|○○|TODO|TBD|xxx)/i;
  for (const document of consentDocuments) {
    const text = canonicalConsentText(document);
    const match = text.match(placeholder);
    assert.equal(match, null, `${document.type}: 자리표시자 "${match?.[0]}" 가 남아 있다`);
  }
});

test('전문 해시는 같은 문서에 대해 항상 같고, 한 글자만 달라도 바뀐다', () => {
  const [document] = consentDocuments;
  assert.equal(consentContentHash(document), consentContentHash(document));
  assert.match(consentContentHash(document), /^[0-9a-f]{64}$/);

  const edited = { ...document, footer: `${document.footer} ` };
  assert.notEqual(consentContentHash(document), consentContentHash(edited));
});

test('전문 평문에 화면에 보이는 모든 문장이 들어간다', () => {
  const privacy = consentDocuments.find((document) => document.type === 'PRIVACY');
  const text = canonicalConsentText(privacy);
  assert.ok(text.includes(privacy.title));
  assert.ok(text.includes(privacy.summary));
  assert.ok(text.includes(privacy.footer));
  for (const section of privacy.sections) {
    assert.ok(text.includes(section.heading), `${section.heading} 가 해시 대상에서 빠졌다`);
    for (const row of section.rows || []) assert.ok(text.includes(row.value));
    for (const bullet of section.bullets || []) assert.ok(text.includes(bullet));
  }
});

test('앱에 내려보내는 문서에는 해시가 함께 실린다', () => {
  const published = publicConsentDocuments();
  assert.equal(published.length, consentDocuments.length);
  for (const document of published) {
    assert.equal(document.contentHash, consentContentHash(document));
  }
});

test('필수 항목을 모두 받아야 동의가 완료된다', () => {
  const version = consentDocuments[0].version;
  assert.equal(consentStateFromRecords([]).completed, false);
  assert.equal(
    consentStateFromRecords([`PRIVACY:${version}`, `HEALTH_DATA:${version}`]).completed,
    false,
    '비의료 안내가 빠졌는데 완료로 판정됐다',
  );

  const all = requiredConsentTypes().map((type) => {
    const document = consentDocuments.find((item) => item.type === type);
    return `${type}:${document.version}`;
  });
  const state = consentStateFromRecords(all);
  assert.equal(state.completed, true);
  assert.deepEqual(state.missing, []);
});

// 문구를 개정하면 version 이 올라간다. 예전 판본 동의를 최신 동의로 인정하면
// "사용자가 읽은 문장"과 "현재 문장"이 다른데도 동의한 것으로 남는다.
test('예전 판본 동의는 현재 판본 동의로 인정되지 않는다', () => {
  const stale = requiredConsentTypes().map((type) => `${type}:0.9`);
  const state = consentStateFromRecords(stale);
  assert.equal(state.completed, false);
  assert.deepEqual(state.granted, []);
  assert.deepEqual(state.missing.sort(), ['HEALTH_DATA', 'NON_MEDICAL_NOTICE', 'PRIVACY']);
});

// 스키마에만 남아 있는 값이 어디선가 기록되더라도 필수 동의를 대신할 수는 없다.
test('스키마에만 있는 항목은 필수 동의를 대신하지 못한다', () => {
  assert.equal(consentStateFromRecords(['RESEARCH:1.0']).completed, false);
});

test('필수 항목이 빠진 제출은 거절한다', () => {
  assert.throws(
    () => normalizeConsentSubmission(agreementFor('PRIVACY', 'HEALTH_DATA')),
    (error) => error.status === 400 && error.code === 'CONSENT_REQUIRED_MISSING',
  );
});

test('필수 항목만 동의한 제출은 통과하고, 선택 항목은 기록되지 않는다', () => {
  const agreed = normalizeConsentSubmission(agreementFor('PRIVACY', 'HEALTH_DATA', 'NON_MEDICAL_NOTICE'));
  assert.deepEqual(agreed.map((entry) => entry.type), ['PRIVACY', 'HEALTH_DATA', 'NON_MEDICAL_NOTICE']);
});

test('같은 항목을 두 번 보내도 한 번만 기록한다', () => {
  const agreed = normalizeConsentSubmission(agreementFor('PRIVACY', 'PRIVACY', 'HEALTH_DATA', 'NON_MEDICAL_NOTICE'));
  assert.equal(agreed.filter((entry) => entry.type === 'PRIVACY').length, 1);
});

test('모르는 항목이 섞이면 거절한다', () => {
  assert.throws(
    () => normalizeConsentSubmission({ agreements: [{ type: 'RESEARCH', version: '1.0' }] }),
    (error) => error.status === 400 && error.code === 'CONSENT_TYPE_UNKNOWN',
  );
  assert.throws(
    () => normalizeConsentSubmission({ agreements: [{ type: 'MARKETING', version: '1.0' }] }),
    (error) => error.status === 400 && error.code === 'CONSENT_TYPE_UNKNOWN',
  );
});

// 개정 전 화면을 띄워 둔 앱이 옛 문구에 대한 동의를 최신 동의로 기록시키면 안 된다.
test('판본이 어긋난 제출은 거절한다', () => {
  assert.throws(
    () => normalizeConsentSubmission({ agreements: [{ type: 'PRIVACY', version: '0.9' }] }),
    (error) => error.status === 409 && error.code === 'CONSENT_VERSION_STALE',
  );
});

test('형식이 어긋난 본문은 거절한다', () => {
  assert.throws(
    () => normalizeConsentSubmission({}),
    (error) => error.status === 400 && error.code === 'CONSENT_PAYLOAD_INVALID',
  );
});
