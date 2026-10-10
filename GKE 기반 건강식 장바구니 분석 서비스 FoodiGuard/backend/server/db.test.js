import assert from 'node:assert/strict';
import test from 'node:test';

import { createPool } from './db.js';

function withEnv(overrides, run) {
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.entries(overrides).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  try {
    return run();
  } finally {
    Object.entries(saved).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
}

// JIT 를 켠 채로 두면 목록 조회가 두 배 느려진다(455ms 대 229ms, 실측). 앱 뷰의 비용
// 추정치가 백만 단위라 매번 JIT 임계값을 넘기는데 실제로 훑는 행은 8만 줄뿐이라
// 컴파일 비용을 회수하지 못한다. 설정이 조용히 사라지지 않도록 고정한다.
test('접속 풀은 JIT 를 꺼 둔다', () => {
  const pool = withEnv({ LOCAL_PGLITE: 'false', DATABASE_URL: 'postgres://u:p@h:5432/d' }, createPool);
  assert.match(pool.options.options, /-c jit=off/);
});

test('개별 접속 정보로 만든 풀에도 같은 설정이 붙는다', () => {
  const pool = withEnv({ LOCAL_PGLITE: 'false', DATABASE_URL: undefined, DB_HOST: '127.0.0.1' }, createPool);
  assert.match(pool.options.options, /-c jit=off/);
});

test('DB_JIT=on 이면 JIT 설정만 빠진다', () => {
  const pool = withEnv({ LOCAL_PGLITE: 'false', DATABASE_URL: 'postgres://u:p@h:5432/d', DB_JIT: 'on' }, createPool);
  assert.doesNotMatch(pool.options.options, /jit=off/);
});

// 기존 운영값과 환경변수 재정의 계약을 고정한다. 이 테스트는 성능 개선의 증거가 아니다.
test('접속 풀은 SSD 기준 random_page_cost 를 쓴다', () => {
  const pool = withEnv({ LOCAL_PGLITE: 'false', DATABASE_URL: 'postgres://u:p@h:5432/d' }, createPool);
  assert.match(pool.options.options, /-c random_page_cost=1\.0/);
});

test('DB_RANDOM_PAGE_COST 로 값을 바꿀 수 있다', () => {
  const pool = withEnv({ LOCAL_PGLITE: 'false', DATABASE_URL: 'postgres://u:p@h:5432/d', DB_RANDOM_PAGE_COST: '2.5' }, createPool);
  assert.match(pool.options.options, /-c random_page_cost=2\.5/);
});

test('readiness uses its own small pool and shorter server timeout', () => {
  const health = withEnv({ LOCAL_PGLITE: 'false' }, () => createPool({ readiness: true }));
  assert.equal(health.options.max, 1);
  assert.equal(health.options.connectionTimeoutMillis, 500);
  assert.match(health.options.options, /statement_timeout=750/);
});
