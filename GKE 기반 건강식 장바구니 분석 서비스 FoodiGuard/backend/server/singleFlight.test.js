import test from 'node:test';
import assert from 'node:assert/strict';
import { createSingleFlight } from './singleFlight.js';
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test('concurrent equal keys share one task, completed data is never cached', async () => {
  const wait = deferred(), events = [], run = createSingleFlight({ observe: (e) => events.push(e) });
  let calls = 0;
  const task = async () => { calls++; await wait.promise; return calls; };
  const a = run('same', task), b = run('same', task);
  wait.resolve();
  assert.deepEqual(await Promise.all([a,b]), [1,1]);
  assert.equal(await run('same', task), 2);
  assert.deepEqual(events, ['started','joined','started']);
});

test('distinct allergy/page keys cannot share results', async () => {
  const run = createSingleFlight();
  assert.deepEqual(await Promise.all([run('milk', () => [1]), run('wheat', () => [2])]), [[1],[2]]);
});

test('failure releases key and is not retained', async () => {
  const run = createSingleFlight();
  await assert.rejects(run('key', () => { throw new Error('db'); }), /db/);
  assert.equal(await run('key', () => 7), 7);
});

test('both unique keys and duplicate waiters are bounded', async () => {
  const wait = deferred(), run = createSingleFlight({ maxKeys: 1, maxWaiters: 2 });
  const a = run('a', () => wait.promise), b = run('a', () => wait.promise);
  await assert.rejects(run('b', () => 2), { code: 'SEARCH_BUSY' });
  await assert.rejects(run('a', () => 2), { code: 'SEARCH_BUSY' });
  wait.resolve(1); await Promise.all([a,b]);
  assert.equal(await run('b', () => 2), 2);
});
