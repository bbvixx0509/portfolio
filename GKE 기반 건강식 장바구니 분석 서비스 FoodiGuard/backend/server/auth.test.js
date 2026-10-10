import assert from 'node:assert/strict';
import test from 'node:test';

import {
  issueSessionToken,
  normalizeOnboardingProfile,
  readBearerToken,
  requireAuth,
  requireSelf,
  verifySessionToken,
} from './auth.js';

// 미들웨어는 express 없이도 검증할 수 있도록 최소한의 요청·응답 대역만 만들어 쓴다.
function fakeResponse() {
  return {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function runMiddleware(middleware, req) {
  const res = fakeResponse();
  let passed = false;
  middleware(req, res, () => { passed = true; });
  return { passed, res };
}


test('normalizes the IRB profile and database codes', () => {
  const profile = normalizeOnboardingProfile({
    gender: '녀',
    birthDate: '2000.01.02',
    height: '165.25',
    weight: '57.75',
    activityLevel: '주 1~3회 걷기&가벼운 운동',
    dietaryGoal: '당류 저감',
    allergies: ['우유', '새우', '우유'],
  });

  assert.equal(profile.gender, '녀');
  assert.equal(profile.birthDate, '2000-01-02');
  assert.equal(profile.height, '165.25');
  assert.equal(profile.weight, '57.75');
  assert.equal(profile.sex, 'female');
  assert.equal(profile.genderCode, 'FEMALE');
  assert.equal(profile.activity, 'light');
  assert.equal(profile.activityCode, 'LIGHT');
  assert.equal(profile.goalCode, 'SUGAR_REDUCTION');
  assert.deepEqual(profile.reduceTargets, ['sugar']);
  assert.deepEqual(profile.allergies, ['우유', '새우']);
  assert.deepEqual(profile.allergyCodes, ['MILK', 'SHRIMP']);
  assert.deepEqual(profile.avoidIngredients, ['우유', '새우']);
  assert.equal(profile.onboardingCompleted, true);
});

test('accepts all eight IRB dietary goals', () => {
  const goals = [
    '감량·근육 보존 목표', '단백질 우선 목표', '체중 유지 목표', '적극적 감량 목표',
    '열량 저감', '당류 저감', '포화지방 저감', '나트륨 저감',
  ];
  const codes = goals.map((dietaryGoal) => normalizeOnboardingProfile({
    gender: '남',
    birthDate: '2000.01.02',
    height: '175.00',
    weight: '70.00',
    activityLevel: '운동 거의 안함',
    dietaryGoal,
    allergies: [],
  }).goalCode);

  assert.equal(new Set(codes).size, 8);
});

test('rejects unsupported onboarding values', () => {
  assert.throws(
    () => normalizeOnboardingProfile({
      gender: '남',
      birthDate: '2026.99.99',
      height: '175.00',
      weight: '70.00',
      activityLevel: '운동 거의 안함',
      dietaryGoal: '당류 저감',
      allergies: [],
    }),
    (error) => error.code === 'BIRTH_DATE_INVALID',
  );
});

test('B04 — 서버 서명이 있는 세션 토큰만 통과한다', () => {
  const { token, expiresAt } = issueSessionToken('11111111-1111-4111-8111-111111111111');
  const verified = verifySessionToken(token);

  assert.equal(verified.userId, '11111111-1111-4111-8111-111111111111');
  assert.ok(new Date(expiresAt).getTime() > Date.now());

  // 페이로드만 바꿔치기하면 서명이 맞지 않는다 — 남의 id 로 토큰을 만들 수 없다.
  const [payload, signature] = token.split('.');
  const forgedPayload = Buffer.from(JSON.stringify({
    ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    sub: '22222222-2222-4222-8222-222222222222',
  })).toString('base64url');

  assert.throws(
    () => verifySessionToken(`${forgedPayload}.${signature}`),
    (error) => error.status === 401 && error.code === 'AUTH_TOKEN_INVALID',
  );
});

test('B04 — 형식이 깨졌거나 만료된 토큰은 거부한다', () => {
  for (const token of ['', 'not-a-token', 'a.b', undefined]) {
    assert.throws(() => verifySessionToken(token), (error) => error.status === 401);
  }

  const { token } = issueSessionToken('33333333-3333-4333-8333-333333333333', 0);
  assert.throws(
    () => verifySessionToken(token, Date.now()),
    (error) => error.code === 'AUTH_TOKEN_EXPIRED',
  );
});

test('B04 — Authorization 헤더는 Bearer 형식만 읽는다', () => {
  assert.equal(readBearerToken({ headers: { authorization: 'Bearer abc' } }), 'abc');
  assert.equal(readBearerToken({ headers: { authorization: 'bearer abc' } }), 'abc');
  assert.equal(readBearerToken({ headers: { authorization: 'Basic abc' } }), '');
  assert.equal(readBearerToken({ headers: {} }), '');
});

test('B04 — 토큰 주체가 아닌 회원의 프로필은 수정할 수 없다', () => {
  const owner = '44444444-4444-4444-8444-444444444444';
  const stranger = '55555555-5555-4555-8555-555555555555';
  const { token } = issueSessionToken(owner);

  // 토큰이 없으면 401.
  const anonymous = runMiddleware(requireAuth, { headers: {}, params: { userId: owner } });
  assert.equal(anonymous.passed, false);
  assert.equal(anonymous.res.statusCode, 401);
  assert.equal(anonymous.res.body.code, 'AUTH_REQUIRED');

  // 토큰이 있어도 남의 회원 id 면 403 — 이게 UUID 만 알면 뚫리던 자리다.
  const authorized = { headers: { authorization: `Bearer ${token}` } };
  runMiddleware(requireAuth, { ...authorized, params: { userId: stranger } });
  const other = runMiddleware(requireSelf('userId'), {
    auth: verifySessionToken(token),
    params: { userId: stranger },
  });
  assert.equal(other.passed, false);
  assert.equal(other.res.statusCode, 403);
  assert.equal(other.res.body.code, 'PROFILE_FORBIDDEN');

  // 본인이면 통과한다.
  const self = runMiddleware(requireSelf('userId'), {
    auth: verifySessionToken(token),
    params: { userId: owner },
  });
  assert.equal(self.passed, true);
});
