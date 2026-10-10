# Time-bounded request diagnostics

This is operational instrumentation, not a performance improvement or a load test.
It is disabled by default. Product SQL, ranking, payloads, DB limits, HPA and Services
are unchanged. Approved diagnostic requests use the normal production read path.

## Activation boundary

Temporarily provide both `FOODIGUARD_TRACE_RUN` (`fgtrace-` plus 8–60 lowercase
letters/digits/hyphens) and `FOODIGUARD_TRACE_UNTIL` (an absolute UTC expiry, at most
60 minutes after process startup). Missing/invalid/expired settings fail closed.
Only GET `/api/products` and `/api/health/ready` with an exact run-prefixed
`X-Load-Diagnostic-Id` and a bounded numeric suffix (or `h-` numeric suffix) are traced.
The run prefix is not authentication; do not use it to authorize data access.

The local file `/tmp/foodiguard-request-trace-<run>.ndjson` has mode 0600 and is
created exclusively. Limits are 10,000 accepted requests and 20 MiB per process;
pending batches are bounded. Storage failure disables tracing, not the API.
There is no HTTP endpoint that serves trace files. Preserve evidence before Pod
replacement and remove the temporary activation settings after the approved run.

## What is recorded

- Request ID, Pod hostname, fixed route, HTTP status and monotonic/wall timestamps.
- Handler-to-headers/finish, JSON response generation, product mapping, search total,
  admission queue, shared-search follower wait, DB pool acquisition and SQL duration.
- For active tracing only: event-loop/runtime samples approximately every 200 ms,
  CPU throttling/TCP counter snapshots approximately every second and GC durations.
- Schema version 2 also records numeric pool total/idle/waiting snapshots before,
  just after, and after completion of each connection request. Lazy pool listeners
  record connection creation/acquisition/removal counters and per-client acquire
  timestamps without SQL, client objects, connection options or error messages.
  At most eight acquisition records per request are kept. Listeners are installed
  only after a traced acquisition, once per pool, and live until that pool/Pod ends.
- Kernel samples include main-thread `/proc/<pid>/task/<pid>/schedstat` counters,
  the schedstats sysctl hint, and cumulative cgroup CPU/IO/memory pressure totals.
  Missing/malformed counters are null, never fabricated zeros. Samples include
  their collection start/end and duration because asynchronous reads can be delayed.
- No SQL text, bound values, query strings, bodies, food names, cookies, auth headers,
  user IDs, passwords or secrets. SQL span names are fixed operation names.

Writers batch asynchronously. Do not launch diagnostic processes in the API
container during the measured interval; collect files afterwards. Instrumentation
has overhead, so this run must not be called an unbiased performance comparison.

## Interpretation and safety

Pair each client request ID with its Pod and persisted server record. Check missing
records, duplicate IDs, storage errors, buffer drops, counter resets and Pod changes.
Nested/parallel spans cannot simply be summed. A follower shares its leader's work;
its missing SQL span does not mean a DB cache hit. Server `finish` means handed to
the operating system, not received by the client. Per-request client TTFB minus
handler-to-headers approximates time outside that handler; it does not isolate
network time from scheduling, connection establishment or socket queues.

Pool elapsed time includes idle-client allocation scheduled for a later event-loop
turn. A nonzero `waitingCount` alone is not exhaustion: pg-pool briefly queues idle
acquisitions too. Inspect idle/total counts, creation/acquire events and elapsed time
together. Acquisition events can occur in a releasing request's async context, so
they are correlated by weak client identity, not the active AsyncLocalStorage context.
Counters are per pool, and concurrent creations must not be assigned to a request
solely from the global creation count. `clientCreatedDuringCall` refers to its client.

Scheduler counters describe time running or waiting on a run queue, not every kind
of blocking. Zero deltas or disabled/unknown scheduler accounting cannot rule out
scheduling delay. Pressure totals cover all tasks in this cgroup, not only the main
thread. These samples do not give a JavaScript/native stack profile or prove an
individual request's entire wall time was scheduler wait. Never change kernel sysctls
or increase CPU/DB limits merely to make a diagnostic pass.

Runtime sampling also stalls during event-loop pauses. A delayed sample's duration
and CPU deltas must be interpreted over its actual elapsed interval. TCP counters
belong to the Pod network namespace and include SQL Proxy traffic. GC timestamps
use the process monotonic clock. Never infer packet loss from delayed HTTP alone.

Before replay: verify health, immutable image/Pod identity, public route, DB CPU
freshness, observer lease and exact request budget. Preserve the 64 in-flight cap,
DB CPU 75% threshold and existing health/content/deadline stop criteria. Stop means
stop; no automatic retry or escalation of limits. Restore temporary settings and
verify API/web readiness, HPA bounds and removal of the owned load Pod.

References: [AsyncLocalStorage](https://nodejs.org/api/async_context.html),
[Node 22 performance hooks](https://nodejs.org/download/release/v22.16.0/docs/api/perf_hooks.html),
[HTTP completion semantics](https://nodejs.org/api/http.html#event-finish).
Additional counter definitions: [Linux schedstat](https://www.kernel.org/doc/html/latest/scheduler/sched-stats.html),
[Linux pressure stall information](https://docs.kernel.org/accounting/psi.html).
