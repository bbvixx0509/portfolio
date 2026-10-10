import assert from 'node:assert/strict';
import test from 'node:test';
import { createQueryGate } from './queryGate.js';

test('admission gate bounds work, rejects overflow, and releases after failure', async () => {
  const run=createQueryGate({ concurrency:1,maxQueue:1,timeoutMs:1000 });
  let finish;
  const first=run(() => new Promise((resolve) => { finish=resolve; }));
  const second=run(async () => 'queued');
  await assert.rejects(run(async () => 'overflow'), { code:'SEARCH_BUSY' });
  finish();
  await first;
  assert.equal(await second,'queued');
  await assert.rejects(run(async () => { throw new Error('query failed'); }));
  assert.equal(await run(async () => 'recovered'),'recovered');
});

test('expired queued request never executes later', async () => {
  const run=createQueryGate({ concurrency:1,maxQueue:1,timeoutMs:5 });
  let finish, executed=false;
  const first=run(() => new Promise((resolve) => { finish=resolve; }));
  await assert.rejects(run(async () => { executed=true; }), { code:'SEARCH_BUSY' });
  finish(); await first;
  assert.equal(executed,false);
  assert.equal(await run(async () => 'ok'),'ok');
});
