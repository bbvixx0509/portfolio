import crypto from 'node:crypto';

import { consentDocuments } from './consentDocuments.js';

export { consentDocuments };

// 화면에 렌더링되는 순서 그대로 평문으로 펼친다. user_consents.content_hash 는 이 문자열의
// SHA-256 이고, 앱은 서버가 준 문서를 그대로 그리므로 "사용자가 실제로 읽은 문구"와 저장된
// 해시가 같다는 것이 IRB 감사 시 증명된다. 렌더링 순서를 바꾸면 해시도 바뀌어야 하므로
// 이 함수와 ConsentScreen 의 렌더링 순서는 함께 고쳐야 한다.
export function canonicalConsentText(document) {
  const lines = [`# ${document.title}`, document.summary];
  for (const section of document.sections) {
    lines.push(`## ${section.heading}`);
    if (section.body) lines.push(section.body);
    for (const row of section.rows || []) lines.push(`- ${row.label}: ${row.value}`);
    for (const bullet of section.bullets || []) lines.push(`* ${bullet}`);
  }
  lines.push(document.footer);
  return lines.join('\n');
}

export function consentContentHash(document) {
  return crypto.createHash('sha256').update(canonicalConsentText(document), 'utf8').digest('hex');
}

// 앱에 내려보내는 형태. 해시를 함께 주어 화면이 어떤 판본을 그리고 있는지 확인할 수 있게 한다.
export function publicConsentDocuments() {
  return consentDocuments.map((document) => ({
    ...document,
    contentHash: consentContentHash(document),
  }));
}

export function requiredConsentTypes() {
  return consentDocuments.filter((document) => document.required).map((document) => document.type);
}

function documentByType(type) {
  return consentDocuments.find((document) => document.type === type) || null;
}

// 현재 판본으로 유효하게 동의한 항목만 남긴다. 문서를 개정하면 version 이 올라가고
// 예전 판본 동의는 자동으로 무효가 되어 다시 받게 된다.
export function grantedTypesFromRecords(records = []) {
  const granted = new Set();
  for (const record of records) {
    const [type, version] = String(record).split(':');
    const document = documentByType(type);
    if (document && document.version === version) granted.add(type);
  }
  return [...granted].sort();
}

export function consentStateFromRecords(records = []) {
  const granted = grantedTypesFromRecords(records);
  const missing = requiredConsentTypes().filter((type) => !granted.includes(type));
  return { completed: missing.length === 0, granted, missing };
}

function createConsentError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

// 앱이 보낸 동의 항목을 검증한다. 필수 항목이 빠졌거나 서버가 모르는 판본이면 거절한다.
// 판본 검증이 없으면 예전 화면을 띄운 앱이 개정 전 문구에 대한 동의를 최신 동의로 기록시킬 수 있다.
export function normalizeConsentSubmission(payload = {}) {
  const raw = Array.isArray(payload.agreements) ? payload.agreements : null;
  if (!raw) throw createConsentError(400, 'CONSENT_PAYLOAD_INVALID', '동의 항목을 확인할 수 없습니다.');

  const agreed = [];
  for (const item of raw) {
    const type = String(item?.type || '').trim();
    const version = String(item?.version || '').trim();
    const document = documentByType(type);
    if (!document) throw createConsentError(400, 'CONSENT_TYPE_UNKNOWN', '알 수 없는 동의 항목입니다.');
    if (document.version !== version) {
      throw createConsentError(409, 'CONSENT_VERSION_STALE', '동의 문서가 갱신되었습니다. 앱을 새로고침한 뒤 다시 동의해주세요.');
    }
    if (!agreed.some((entry) => entry.type === type)) agreed.push({ document, type, version });
  }

  const missing = requiredConsentTypes().filter((type) => !agreed.some((entry) => entry.type === type));
  if (missing.length) {
    throw createConsentError(400, 'CONSENT_REQUIRED_MISSING', '필수 동의 항목에 모두 동의해야 서비스를 이용할 수 있습니다.');
  }

  return agreed;
}

export async function recordUserConsents(pool, userId, payload) {
  const id = String(userId || '').trim();
  if (!id) throw createConsentError(400, 'USER_REQUIRED', '회원 정보를 찾을 수 없습니다.');
  const agreed = normalizeConsentSubmission(payload);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT 1 FROM users WHERE id = $1', [id]);
    if (!existing.rows[0]) throw createConsentError(404, 'USER_NOT_FOUND', '회원 정보를 찾을 수 없습니다.');

    for (const entry of agreed) {
      await client.query(
        `
          INSERT INTO user_consents (user_id, consent_type, consent_version, content_hash, status, consented_at)
          VALUES ($1, $2, $3, $4, 'GRANTED', NOW())
          ON CONFLICT (user_id, consent_type, consent_version) DO UPDATE SET
            status = 'GRANTED',
            content_hash = EXCLUDED.content_hash,
            consented_at = NOW(),
            withdrawn_at = NULL
        `,
        [id, entry.type, entry.version, consentContentHash(entry.document)],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return agreed.map((entry) => entry.type);
}

// 건강정보를 받기 전에 동의가 있었는지 확인한다. 개인정보 보호법 제23조는 민감정보를
// '수집하기 전에' 별도 동의를 받으라고 하므로, 화면 순서만으로 막지 않고 서버에서도 막는다.
export async function assertHealthDataConsent(pool, userId) {
  const result = await pool.query(
    `
      SELECT consent_type || ':' || consent_version AS record
      FROM user_consents
      WHERE user_id = $1 AND status = 'GRANTED'
    `,
    [userId],
  );
  const state = consentStateFromRecords(result.rows.map((row) => row.record));
  if (!state.completed) {
    throw createConsentError(403, 'CONSENT_REQUIRED', '개인정보·건강정보 수집 동의 후에 이용할 수 있습니다.');
  }
  return state;
}
