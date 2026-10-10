import assert from 'node:assert/strict';
import test from 'node:test';

import {
  completeSyncRun,
  failSyncRun,
  latestSuccessfulSyncAt,
  normalizeStats,
  startSyncRun,
} from './syncRuns.js';

function fakeDatabase(results) {
  const calls = [];
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values });
      return results.shift() || { rows: [] };
    },
  };
}

test('sync run 시작은 카운터를 0으로 명시하고 민감정보 없는 메타데이터만 저장한다', async () => {
  const database = fakeDatabase([{ rows: [{ id: 7, started_at: new Date() }] }]);
  const run = await startSyncRun(database, {
    sourceType: 'allergen_projection',
    mode: 'incremental',
    metadata: { trigger: 'jenkins', buildNumber: '31' },
  });

  assert.equal(run.id, 7);
  assert.deepEqual(database.calls[0].values.slice(2, 7), [0, 0, 0, 0, 0]);
  assert.deepEqual(JSON.parse(database.calls[0].values[7]), { trigger: 'jenkins', buildNumber: '31' });
});

test('sync run 완료는 음수와 실수를 안전한 카운터로 정규화한다', async () => {
  const database = fakeDatabase([{ rows: [{ id: 7, status: 'completed' }] }]);
  const result = await completeSyncRun(database, 7, {
    read: 12.8,
    updated: 3,
    matched: -1,
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(database.calls[0].values.slice(1, 6), [12, 0, 3, 0, 0]);
});

test('sync run 실패는 오류 메시지를 남기고 처리 건수도 보존한다', async () => {
  const database = fakeDatabase([{ rows: [{ id: 9, status: 'failed' }] }]);
  const result = await failSyncRun(database, 9, new Error('API timeout'), { read: 40, matched: 8 });

  assert.equal(result.status, 'failed');
  assert.equal(database.calls[0].values[1], 40);
  assert.equal(database.calls[0].values[4], 8);
  assert.equal(database.calls[0].values[6], 'API timeout');
});

test('마지막 성공 시각은 source_type별 completed 행만 조회한다', async () => {
  const finishedAt = new Date('2026-08-31T00:00:00Z');
  const database = fakeDatabase([{ rows: [{ finished_at: finishedAt }] }]);
  assert.equal(await latestSuccessfulSyncAt(database, 'allergen_projection'), finishedAt);
  assert.match(database.calls[0].sql, /status = 'completed'/);
  assert.deepEqual(database.calls[0].values, ['allergen_projection']);
});

test('통계 정규화는 누락값과 NaN을 0으로 만든다', () => {
  assert.deepEqual(normalizeStats({ read: '5', inserted: Number.NaN }), {
    read: 5,
    inserted: 0,
    updated: 0,
    matched: 0,
    unmatched: 0,
  });
});
