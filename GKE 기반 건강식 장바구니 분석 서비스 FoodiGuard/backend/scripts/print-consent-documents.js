// IRB 제출용 동의 문구 사본을 만든다. 앱 화면과 같은 원본(consentDocuments)에서 뽑으므로
// 문구를 고치면 다시 실행해 문서를 갱신해야 한다. 전문 해시는 user_consents.content_hash 에
// 저장되는 값과 동일하다 — 어느 문장에 동의했는지가 이 값으로 대조된다.
//
//   npm run consents:print > ../docs/irb-consent.md

import { canonicalConsentText, consentContentHash, consentDocuments } from '../server/consents.js';

const out = [];

out.push('# 푸디가드 동의 문구 (앱 실제 노출 문구)');
out.push('');
out.push('이 문서는 `backend/server/consentDocuments.js` 에서 자동 생성됩니다. 직접 고치지 마세요.');
out.push('');
out.push('- 생성 명령: `cd backend && npm run consents:print > ../docs/irb-consent.md`');
out.push('- 아래 문구는 앱 가입 화면(동의 화면)에서 "전문 보기"를 눌렀을 때 표시되는 내용과 글자 단위로 같습니다.');
out.push('- 전문 해시(SHA-256)는 동의 시 `user_consents.content_hash` 에 저장되므로, 회원이 어떤 판본의 어떤 문장에 동의했는지 대조할 수 있습니다.');
out.push('');

out.push('## 동의 항목 요약');
out.push('');
out.push('| 구분 | 동의 유형(consent_type) | 판본 | 화면 문구 | 전문 해시 |');
out.push('| --- | --- | --- | --- | --- |');
for (const document of consentDocuments) {
  out.push(`| ${document.required ? '필수' : '선택'} | \`${document.type}\` | ${document.version} | ${document.checkboxLabel} | \`${consentContentHash(document).slice(0, 16)}…\` |`);
}
out.push('');

for (const document of consentDocuments) {
  out.push('---');
  out.push('');
  out.push(`## ${document.title}`);
  out.push('');
  out.push(`- 유형: \`${document.type}\` / 판본: \`${document.version}\` / ${document.required ? '**필수**' : '**선택**'}`);
  out.push(`- 전문 해시(SHA-256): \`${consentContentHash(document)}\``);
  out.push(`- 체크박스 문구: **${document.checkboxLabel}**`);
  out.push(`- 요약 문구: ${document.summary}`);
  out.push('');
  out.push('### 전문');
  out.push('');
  for (const section of document.sections) {
    out.push(`**${section.heading}**`);
    out.push('');
    if (section.body) {
      out.push(section.body);
      out.push('');
    }
    if ((section.rows || []).length) {
      out.push('| 항목 | 내용 |');
      out.push('| --- | --- |');
      for (const row of section.rows) out.push(`| ${row.label} | ${row.value} |`);
      out.push('');
    }
    for (const bullet of section.bullets || []) out.push(`- ${bullet}`);
    if ((section.bullets || []).length) out.push('');
  }
  out.push(`> ${document.footer}`);
  out.push('');
}

out.push('---');
out.push('');
out.push('## 해시 계산 대상 평문');
out.push('');
out.push('해시는 아래 평문(제목 → 요약 → 섹션 순서 → 마지막 고지문)을 UTF-8 로 SHA-256 한 값입니다.');
out.push('');
for (const document of consentDocuments) {
  out.push(`### ${document.type}`);
  out.push('');
  out.push('```');
  out.push(canonicalConsentText(document));
  out.push('```');
  out.push('');
}

process.stdout.write(`${out.join('\n')}\n`);
