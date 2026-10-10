// Opt-in, time-limited operational diagnostics. No SQL, payloads, URLs, credentials,
// or user identifiers are recorded. Normal requests do not allocate trace contexts.
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance, monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSchedstat, parsePressure } from './diagnosticCounters.js';

const context = new AsyncLocalStorage();
const noop = () => {};
const tracedPools = new WeakMap();

function poolState(pool) {
  const result = {};
  for (const key of ['totalCount', 'idleCount', 'waitingCount']) {
    const value = pool[key];
    if (Number.isSafeInteger(value) && value >= 0) result[key] = value;
  }
  return result;
}

// Track numeric pool events without relying on the event emitter's async context:
// an acquire can run in the context of a different request that released a client.
export function tracePoolConnect(pool, operation, run) {
  const trace = context.getStore();
  if (!trace || !/^[a-z_]{1,48}$/.test(operation) || (trace.poolAcquisitions?.length || 0) >= 8) return run();
  let state = tracedPools.get(pool);
  if (!state) {
    state = { created: 0, acquired: 0, removed: 0, clients: new WeakMap() };
    if (typeof pool.on === 'function') {
      // Weak client keys and one listener per pool/event; no request objects retained.
      pool.on('connect', client => {
        const info = state.clients.get(client) || {};
        info.createdAt = performance.now(); state.clients.set(client, info); state.created++;
      });
      pool.on('acquire', client => {
        const info = state.clients.get(client) || {};
        info.acquiredAt = performance.now(); state.clients.set(client, info); state.acquired++;
      });
      pool.on('remove', () => { state.removed++; });
    }
    tracedPools.set(pool, state);
  }
  const start = performance.now();
  const entry = { operation, startMs: start - trace.start, before: poolState(pool),
    eventsBefore: { created: state.created, acquired: state.acquired, removed: state.removed } };
  (trace.poolAcquisitions ??= []).push(entry);
  return (async () => {
    try {
      const pending = run(); entry.afterCall = poolState(pool);
      const client = await pending, finished = performance.now(), info = state.clients.get(client);
      entry.acquired = poolState(pool);
      entry.clientCreatedDuringCall = info?.acquiredAt >= start ? info.createdAt >= start : null;
      entry.acquireEventMs = info?.acquiredAt >= start ? info.acquiredAt - start : null;
      entry.afterAcquireEventMs = info?.acquiredAt >= start ? finished - info.acquiredAt : null;
      entry.outcome = 'success'; return client;
    } catch (error) { entry.outcome = 'error'; throw error; }
    finally {
      entry.durationMs = performance.now() - start;
      entry.eventsAfter = { created: state.created, acquired: state.acquired, removed: state.removed };
    }
  })();
}

export function startTraceSpan(name) {
  const trace = context.getStore();
  if (!trace || trace.spans.length >= 24 || !/^[a-z_:.]{1,64}$/.test(name)) return noop;
  const span = { name, startMs: performance.now() - trace.start, durationMs: null };
  trace.spans.push(span);
  return () => { if (span.durationMs === null) span.durationMs = performance.now() - trace.start - span.startMs; };
}

export function traceAsync(name, run) {
  const stop = startTraceSpan(name);
  if (stop === noop) return run();
  return (async () => { try { return await run(); } finally { stop(); } })();
}

export function traceSync(name, run) {
  const stop = startTraceSpan(name);
  try { return run(); } finally { stop(); }
}

export function traceCoalescing(value) {
  const trace = context.getStore();
  if (trace && ['started', 'joined', 'rejected'].includes(value)) trace.coalescing = value;
}

function numericFields(text, wanted) {
  return Object.fromEntries(text.trim().split('\n').flatMap(line => {
    const [key, value] = line.trim().split(/\s+/);
    return wanted.includes(key) && Number.isFinite(Number(value)) ? [[key, Number(value)]] : [];
  }));
}

function tcpFields(text) {
  const result = {}, lines = text.trim().split('\n');
  const wanted = ['OutSegs', 'RetransSegs', 'TCPTimeouts', 'TCPFastRetrans', 'TCPLossProbes',
    'TCPDSACKRecvSegs', 'ListenOverflows', 'ListenDrops', 'TCPBacklogDrop', 'TCPRcvQDrop'];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const keys = lines[i].split(/\s+/), values = lines[i + 1].split(/\s+/);
    if (keys[0] !== values[0]) continue;
    keys.forEach((key, j) => { if (wanted.includes(key) && Number.isFinite(Number(values[j]))) result[key] = Number(values[j]); });
  }
  return result;
}

export function createRequestTracer({ env = process.env, now = Date.now,
  directory = '/tmp', runtime = true, maxRequests = 10000, maxBytes = 20 * 1024 * 1024,
  writer, initialize } = {}) {
  const run = env.FOODIGUARD_TRACE_RUN || '', expires = Date.parse(env.FOODIGUARD_TRACE_UNTIL);
  const configured = /^fgtrace-[a-z0-9-]{8,60}$/.test(run) && Number.isFinite(expires)
    && expires > now() && expires - now() <= 60 * 60000;
  const pod = /^[a-z0-9-]{1,100}$/.test(env.HOSTNAME || '') ? env.HOSTNAME : 'unknown';
  const file = configured ? path.join(directory, `foodiguard-request-trace-${run}.ndjson`) : null;
  const state = { accepted: 0, dropped: 0, ioErrors: 0, bytes: 0, closed: false };
  let enabled = false, buffer = [], bufferedBytes = 0, writing = Promise.resolve(), flushTimer;
  let timer, histogram, gc, lastActive = 0, sampleCount = 0, sampling = false;
  let previousCpu, previousElu, previousTick;
  const sockets = new WeakMap();
  const put = (row) => {
    if (!enabled || state.closed) return;
    const line = JSON.stringify({ run, pod, ...row }) + '\n', size = Buffer.byteLength(line);
    if (state.bytes + size > maxBytes || bufferedBytes + size > 1024 * 1024) { state.dropped++; return; }
    buffer.push(line); bufferedBytes += size; state.bytes += size;
  };
  const flush = () => {
    if (buffer.length) {
      const batch = buffer.join(''); buffer = []; bufferedBytes = 0;
      writing = writing.then(() => (writer || ((s) => appendFile(file, s)))(batch))
        .catch(() => { state.ioErrors++; enabled = false; });
    }
    return writing;
  };
  const stopRuntime = () => {
    if (timer) put({ type: 'status', at: new Date(now()).toISOString(), ...state });
    clearInterval(timer); timer = null; histogram?.disable(); gc?.disconnect();
  };
  async function kernelSample() {
    if (sampling) return;
    sampling = true;
    const begin = performance.now(), at = new Date(now()).toISOString();
    try {
      const optional = file => readFile(file, 'utf8').catch(() => null);
      const [cpu, snmp, netstat, schedstat, schedstatsEnabled, cpuPressure, ioPressure, memoryPressure] = await Promise.all([
        readFile('/sys/fs/cgroup/cpu.stat', 'utf8'), readFile('/proc/net/snmp', 'utf8'), readFile('/proc/net/netstat', 'utf8'),
        optional(`/proc/${process.pid}/task/${process.pid}/schedstat`),
        optional('/proc/sys/kernel/sched_schedstats'), optional('/sys/fs/cgroup/cpu.pressure'),
        optional('/sys/fs/cgroup/io.pressure'), optional('/sys/fs/cgroup/memory.pressure'),
      ]);
      put({ type: 'kernel', at, monoMs: begin, collectedAt: new Date(now()).toISOString(), collectionMs: performance.now() - begin,
        cpu: numericFields(cpu, ['usage_usec', 'user_usec', 'system_usec', 'nr_periods', 'nr_throttled', 'throttled_usec']),
        tcp: { ...tcpFields(snmp), ...tcpFields(netstat) },
        mainThread: schedstat === null ? null : parseSchedstat(schedstat),
        schedstatsEnabled: ['0', '1'].includes(schedstatsEnabled?.trim()) ? Number(schedstatsEnabled.trim()) : null,
        pressure: { cpu: parsePressure(cpuPressure), io: parsePressure(ioPressure), memory: parsePressure(memoryPressure) } });
    } catch { put({ type: 'kernel', at, unavailable: true }); }
    finally { sampling = false; }
  }
  function activateRuntime() {
    if (!runtime || timer) return;
    histogram = monitorEventLoopDelay({ resolution: 10 }); histogram.enable();
    previousCpu = process.cpuUsage(); previousElu = performance.eventLoopUtilization(); previousTick = performance.now();
    gc = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) put({ type: 'gc', at: new Date(now()).toISOString(),
        startMonoMs: entry.startTime, durationMs: entry.duration, kind: entry.detail?.kind });
    });
    gc.observe({ entryTypes: ['gc'] });
    void kernelSample();
    timer = setInterval(() => {
      const tick = performance.now(), cpu = process.cpuUsage(), elu = performance.eventLoopUtilization();
      put({ type: 'runtime', at: new Date(now()).toISOString(), monoMs: tick,
        intervalMs: tick - previousTick, timerLateMs: Math.max(0, tick - previousTick - 200),
        eventLoopMaxMs: histogram.max / 1e6, eventLoopP95Ms: histogram.percentile(95) / 1e6,
        eventLoopUtilization: performance.eventLoopUtilization(elu, previousElu).utilization,
        cpuUserUs: cpu.user - previousCpu.user, cpuSystemUs: cpu.system - previousCpu.system,
        heapUsed: process.memoryUsage().heapUsed });
      previousCpu = cpu; previousElu = elu; previousTick = tick; histogram.reset();
      if (++sampleCount % 5 === 0) { void kernelSample(); void flush(); }
      if (!enabled || now() >= expires || now() - lastActive > 5000) { stopRuntime(); void flush(); }
    }, 200); timer.unref();
  }
  const ready = configured ? Promise.resolve().then(() => initialize ? initialize() : appendFile(file, '', { flag: 'wx', mode: 0o600 }))
    .then(() => {
      enabled = true;
      put({ type: 'configuration', at: new Date(now()).toISOString(), expiresAt: new Date(expires).toISOString(),
        maxRequests, maxBytes, processVersion: process.version, schemaVersion: 2, sampleIntervalMs: 200, kernelIntervalMs: 1000 });
      flushTimer = setInterval(() => { void flush(); if (now() >= expires) clearInterval(flushTimer); }, 1000);
      flushTimer.unref();
    }).catch(() => { state.ioErrors++; }) : Promise.resolve();
  function middleware(req, res, next) {
    const id = req.headers['x-load-diagnostic-id'];
    const route = req.path;
    if (!enabled || state.closed || now() >= expires || state.accepted >= maxRequests || state.bytes >= maxBytes
      || req.method !== 'GET' || !['/api/products', '/api/health/ready'].includes(route)
      || typeof id !== 'string' || !id.startsWith(run + '-') || !/^(?:h-)?\d{1,5}$/.test(id.slice(run.length + 1))) return next();
    state.accepted++; lastActive = now(); activateRuntime();
    const trace = { id, at: new Date(now()).toISOString(), start: performance.now(), spans: [], route };
    const accepted = sockets.get(req.socket);
    if (accepted !== undefined) trace.socketAgeMs = trace.start - accepted;
    let finished = false;
    const record = (event) => {
      if (finished) return; finished = true;
      put({ type: 'request', id, at: trace.at, monoMs: trace.start, route,
        status: res.statusCode, event, socketAgeMs: trace.socketAgeMs,
        headersMs: trace.headersMs ?? null, finishMs: performance.now() - trace.start,
        coalescing: trace.coalescing ?? null, spans: trace.spans.map(s => ({ ...s })),
        poolAcquisitions: trace.poolAcquisitions || [] });
    };
    const writeHead = res.writeHead, json = res.json;
    res.writeHead = function (...args) {
      trace.headersMs ??= performance.now() - trace.start;
      if (!res.headersSent) {
        res.setHeader('X-Load-Diagnostic-Id', id);
        res.setHeader('X-FoodiGuard-Trace-Pod', pod);
        res.setHeader('Server-Timing', `handler;dur=${trace.headersMs.toFixed(3)}`);
      }
      return writeHead.apply(this, args);
    };
    if (json) res.json = function (...args) { return traceSync('response_json', () => json.apply(this, args)); };
    res.once('finish', () => record('finish')); res.once('close', () => record('close'));
    return context.run(trace, next);
  }
  return { middleware, ready, file, state,
    observeServer(server) { if (configured) server.on('connection', socket => { sockets.set(socket, performance.now()); }); },
    flush,
    async close() {
      stopRuntime(); clearInterval(flushTimer);
      put({ type: 'summary', at: new Date(now()).toISOString(), ...state });
      await flush(); state.closed = true;
    },
  };
}
