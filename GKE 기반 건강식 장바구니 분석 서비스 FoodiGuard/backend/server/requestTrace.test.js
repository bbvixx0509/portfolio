import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import pg from 'pg';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequestTracer, traceAsync, traceSync, tracePoolConnect } from './requestTrace.js';
import { createSingleFlight } from './singleFlight.js';
import { createQueryGate } from './queryGate.js';
import { queryWithMetrics } from './db.js';

const run = 'fgtrace-test-01234567';
function fixture(options = {}) {
  const lines = [];
  const tracer = createRequestTracer({ runtime: false,
    env: { FOODIGUARD_TRACE_RUN: run, FOODIGUARD_TRACE_UNTIL: new Date(Date.now() + 60000).toISOString(), HOSTNAME: 'test-pod' },
    initialize: async () => {}, writer: async s => lines.push(...s.trim().split('\n').map(x => JSON.parse(x))), ...options });
  return { tracer, lines };
}
async function serve(t, tracer, route) {
  await tracer.ready;
  const app = express(); app.use(tracer.middleware); app.get('/api/products', route);
  app.get('/api/health/ready', (_q, r) => r.json({ ok: true }));
  app.post('/api/products', (_q, r) => r.json({ ok: true }));
  const server = http.createServer(app); tracer.observeServer(server);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await tracer.close(); });
  return async (id, extra = {}) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/products?query=private-test-text`,
      { headers: { 'X-Load-Diagnostic-Id': id, Authorization: 'private-test-token', Cookie: 'private-cookie' }, ...extra });
    return { status: r.status, headers: Object.fromEntries(r.headers), body: await r.json() };
  };
}

test('disabled, malformed, expired and excessive expiry never start trace persistence', async () => {
  for (const env of [{}, { FOODIGUARD_TRACE_RUN: '../bad' },
    { FOODIGUARD_TRACE_RUN: run, FOODIGUARD_TRACE_UNTIL: new Date(Date.now() - 1).toISOString() },
    { FOODIGUARD_TRACE_RUN: run, FOODIGUARD_TRACE_UNTIL: new Date(Date.now() + 7200000).toISOString() }]) {
    let writes = 0; const { tracer } = fixture({ env, initialize: async () => { writes++; } });
    await tracer.ready; await tracer.close(); assert.equal(writes, 0); assert.equal(tracer.file, null);
  }
});

test('request/Pod pairing and spans preserve the original JSON; sensitive fields never persist', async t => {
  const { tracer, lines } = fixture();
  const read = await serve(t, tracer, async (_q, r) => {
    const value = await traceAsync('sql:product_search_list', async () => { await delay(5); return 42; });
    r.json(traceSync('map_products', () => ({ value, name: 'private-product-name' })));
  });
  const result = await read(run + '-0'); await tracer.flush();
  assert.deepEqual(result.body, { value: 42, name: 'private-product-name' });
  assert.equal(result.headers['x-load-diagnostic-id'], run + '-0');
  assert.equal(result.headers['x-foodiguard-trace-pod'], 'test-pod');
  assert.match(result.headers['server-timing'], /^handler;dur=\d+\.\d+$/);
  const row = lines.find(x => x.type === 'request'); assert.equal(row.id, run + '-0');
  assert(row.finishMs >= row.headersMs); assert(row.spans.every(s => s.durationMs >= 0));
  assert.deepEqual(row.spans.map(x => x.name), ['sql:product_search_list', 'map_products', 'response_json']);
  assert(!JSON.stringify(lines).includes('private-'));
});

test('only bounded, opted-in GET IDs are traced and expiry is checked per request', async t => {
  let now = Date.now(); const { tracer, lines } = fixture({ now: () => now, maxRequests: 1 });
  const read = await serve(t, tracer, (_q, r) => r.json({ ok: true }));
  for (const id of ['other-0', run + '-x', run + '-100000', run + '-0/path']) {
    const r = await read(id); assert.equal(r.headers['x-foodiguard-trace-pod'], undefined);
  }
  assert.equal((await read(run + '-0', { method: 'POST' })).headers['x-foodiguard-trace-pod'], undefined);
  assert.equal((await read(run + '-0')).headers['x-foodiguard-trace-pod'], 'test-pod');
  assert.equal((await read(run + '-1')).headers['x-foodiguard-trace-pod'], undefined);
  now += 61000;
  assert.equal((await read(run + '-2')).headers['x-foodiguard-trace-pod'], undefined);
  await tracer.flush(); assert.equal(lines.filter(x => x.type === 'request').length, 1);
});

test('independent async contexts distinguish a shared follower from its leader', async t => {
  const { tracer, lines } = fixture(), coalesce = createSingleFlight();
  let calls = 0;
  const read = await serve(t, tracer, async (_q, r) => {
    const value = await coalesce('same', () => traceAsync('sql:product_search_list', async () => { calls++; await delay(40); return 10; }));
    r.json({ value });
  });
  await Promise.all([read(run + '-0'), read(run + '-1')]); await tracer.flush();
  const rows = lines.filter(x => x.type === 'request'); assert.equal(calls, 1); assert.equal(rows.length, 2);
  assert.equal(rows.filter(x => x.coalescing === 'started').length, 1);
  const follower = rows.find(x => x.coalescing === 'joined');
  assert(follower.spans.some(x => x.name === 'search_shared_wait'));
  assert(!follower.spans.some(x => x.name.startsWith('sql:')));
  assert(rows.every(x => x.spans.every(s => s.durationMs !== null)));
});

test('gate waiting, pool connection and SQL execution remain distinguishable', async t => {
  const { tracer, lines } = fixture();
  const gate = createQueryGate({ concurrency: 1, maxQueue: 2, timeoutMs: 500 }); let released = 0;
  const database = { connect: async () => { await delay(3); return { query: async () => { await delay(30); return { rows: [] }; }, release: () => released++ }; } };
  const read = await serve(t, tracer, async (_q, r) => r.json(await gate(() => queryWithMetrics(database, 'product_search_list', 'not-recorded-SQL', ['not-recorded-value']))));
  await Promise.all([read(run + '-0'), read(run + '-1')]); await tracer.flush();
  const rows = lines.filter(x => x.type === 'request'); assert.equal(released, 2);
  assert(rows.some(x => x.spans.some(s => s.name === 'search_queue' && s.durationMs > 10)));
  assert(rows.every(x => x.spans.some(s => s.name === 'pool:product_search_list') && x.spans.some(s => s.name === 'sql:product_search_list')));
  assert(!JSON.stringify(lines).includes('not-recorded'));
});

test('writer initialization errors and later failures do not break product responses', async t => {
  const { tracer } = fixture({ writer: async () => { throw new Error('storage unavailable'); } });
  const read = await serve(t, tracer, (_q, r) => r.json({ ok: true }));
  assert.equal((await read(run + '-0')).status, 200); await tracer.flush();
  assert.equal(tracer.state.ioErrors, 1);
  assert.equal((await read(run + '-1')).headers['x-foodiguard-trace-pod'], undefined);
  const bad = fixture({ initialize: async () => { throw new Error('no disk'); } }).tracer;
  await bad.ready; assert.equal(bad.state.ioErrors, 1); await bad.close();
});

test('byte budget is bounded and untraced async return/rejection behavior is unchanged', async () => {
  const { tracer, lines } = fixture({ maxBytes: 1 }); await tracer.ready; await tracer.close();
  assert.equal(lines.length, 0); assert(tracer.state.dropped >= 1); assert.equal(tracer.state.bytes, 0);
  const promise = Promise.resolve(42); assert.equal(traceAsync('test', () => promise), promise);
  const error = new Error('preserve'); assert.throws(() => traceAsync('test', () => { throw error; }), e => e === error);
});

test('runtime sampling is bounded to active tracing and closes cleanly', async t => {
  const { tracer, lines } = fixture({ runtime: true });
  const read = await serve(t, tracer, (_q, r) => r.json({ ok: true }));
  await read(run + '-0'); await delay(250); await tracer.close();
  const samples = lines.filter(x => x.type === 'runtime'); assert(samples.length >= 1);
  assert(samples.every(x => Number.isFinite(x.intervalMs) && Number.isFinite(x.eventLoopMaxMs)));
  assert(lines.some(x => x.type === 'kernel'));
  const count = lines.length; await delay(250); assert.equal(lines.length, count);
  assert.equal((await read(run + '-1')).headers['x-foodiguard-trace-pod'], undefined);
});

class FakePgClient extends EventEmitter {
  constructor() { super(); this._queryable = true; this._ending = false; }
  connect(cb) { queueMicrotask(() => cb(null)); }
  end(cb) { this._ending = true; queueMicrotask(() => { this.emit('end'); cb?.(); }); }
}

test('untraced pool calls preserve identity and install no listeners', () => {
  const database = new EventEmitter(), promise = Promise.resolve(42);
  assert.equal(tracePoolConnect(database, 'readiness', () => promise), promise);
  assert.equal(database.eventNames().length, 0);
  const error = new Error('unchanged');
  assert.throws(() => tracePoolConnect(database, 'readiness', () => { throw error; }), e => e === error);
});

test('real pg-pool reuse records spare connections, deferred acquire and new connection separately', async t => {
  const database = new pg.Pool({ Client: FakePgClient, max: 3, idleTimeoutMillis: 0 });
  t.after(() => database.end());
  const warm = await database.connect(); warm.release();
  const { tracer, lines } = fixture(); let iteration = 0;
  const read = await serve(t, tracer, async (_q, res) => {
    const client = await tracePoolConnect(database, 'product_search_list', () => {
      const pending = database.connect();
      // Demonstrate acquisition elapsed time with an idle connection, not capacity exhaustion.
      const at = performance.now(); while (performance.now() - at < 15) { /* bounded local test */ }
      return pending;
    });
    client.release(++iteration === 1); res.json({ ok: true });
  });
  await read(run + '-0'); await read(run + '-1'); await tracer.flush();
  const rows = lines.filter(x => x.type === 'request');
  const reused = rows[0].poolAcquisitions[0], created = rows[1].poolAcquisitions[0];
  assert.equal(reused.before.idleCount, 1); assert.equal(reused.afterCall.idleCount, 1);
  assert.equal(reused.clientCreatedDuringCall, false); assert(reused.acquireEventMs >= 10);
  assert.equal(reused.outcome, 'success'); assert(reused.afterAcquireEventMs >= 0);
  assert.equal(created.clientCreatedDuringCall, true); assert.equal(created.eventsAfter.created, 1);
  assert.equal(database.listenerCount('connect'), 1); assert.equal(database.listenerCount('acquire'), 1);
  assert(rows.every(r => r.poolAcquisitions.every(p => Number.isFinite(p.durationMs))));
});

test('pool trace failures preserve errors and do not persist error messages or database fields', async t => {
  const { tracer, lines } = fixture(), database = { totalCount:0, idleCount:0, waitingCount:0, password:'private-db-password' };
  const failure = new Error('private-connection-details');
  const read = await serve(t, tracer, async (_q, res) => {
    for (let i=0; i<10; i++) {
      try { await tracePoolConnect(database, 'readiness', () => Promise.reject(failure)); }
      catch (e) { assert.equal(e, failure); }
    }
    res.status(503).json({ ok:false });
  });
  assert.equal((await read(run + '-0')).status, 503); await tracer.flush();
  const row = lines.find(x => x.type === 'request'); assert.equal(row.poolAcquisitions.length, 8);
  assert(row.poolAcquisitions.every(p => p.outcome === 'error' && p.durationMs >= 0));
  assert(!JSON.stringify(lines).includes('private-'));
});
