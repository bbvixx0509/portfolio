// Prometheus 계측.
//
// GKE 는 Autopilot 이고 수집은 Google Managed Service for Prometheus 가 맡는다.
// 서버가 할 일은 /metrics 를 텍스트로 내보내는 것까지이고, 무엇을 긁어갈지는
// PodMonitoring 이 정한다(k8s/pod-monitoring.yaml).
//
// 라벨 규칙 — method · route · status_class · operation · result 만 쓴다.
// 회원 id·이메일·검색어·식품명·전체 URL 은 넣지 않는다. 개인정보가 지표로 새는 것도
// 문제지만, 검색어처럼 값이 무한한 라벨은 시계열을 폭증시켜 수집 자체를 망가뜨린다.

import client from 'prom-client';

export const registry = new client.Registry();

const coalescing = new client.Counter({ name: 'foodiguard_search_coalescing_total',
  help: 'Concurrent product searches: started, joined, rejected; no completed-result cache',
  labelNames: ['result'], registers: [registry] });
const searchActive = new client.Gauge({ name: 'foodiguard_search_active',
  help: 'Active product/alternative search tasks in this API process', registers: [registry] });
const searchQueued = new client.Gauge({ name: 'foodiguard_search_queued',
  help: 'Queued product/alternative search tasks in this API process', registers: [registry] });
export const recordSearchCoalescing = (result) => coalescing.inc({ result });
export function setSearchAdmission({ active, queued }) { searchActive.set(active); searchQueued.set(queued); }
export function registerDbPoolMetrics(pool) {
  for (const [suffix, property] of [['connections', 'totalCount'], ['idle', 'idleCount'], ['waiting', 'waitingCount']]) {
    new client.Gauge({ name: `foodiguard_db_pool_${suffix}`, help: `API SQL pool ${suffix}`,
      registers: [registry], collect() { this.set(Number(pool[property] || 0)); } });
  }
}

const httpRequestsTotal = new client.Counter({
  name: 'foodiguard_http_requests_total',
  help: 'HTTP 요청 수',
  labelNames: ['method', 'route', 'status_class'],
  registers: [registry],
});

const httpRequestDuration = new client.Histogram({
  name: 'foodiguard_http_request_duration_seconds',
  help: 'HTTP 응답 시간(초)',
  labelNames: ['method', 'route', 'status_class'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

const httpInFlight = new client.Gauge({
  name: 'foodiguard_http_in_flight_requests',
  help: '처리 중인 HTTP 요청 수',
  registers: [registry],
});

const dbQueryDuration = new client.Histogram({
  name: 'foodiguard_db_query_duration_seconds',
  help: 'DB 조회 시간(초)',
  labelNames: ['operation', 'result'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

const dbQueryErrors = new client.Counter({
  name: 'foodiguard_db_query_errors_total',
  help: 'DB 조회 실패 수',
  labelNames: ['operation'],
  registers: [registry],
});

const dbPoolWait = new client.Histogram({
  name: 'foodiguard_db_pool_wait_seconds',
  help: 'DB 연결 획득 경과시간 (새 연결 및 이벤트 루프 지연 포함, SQL 실행시간 제외)',
  labelNames: ['operation', 'result'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2],
  registers: [registry],
});
const syncLastSuccess = new client.Gauge({
  name: 'foodiguard_sync_last_success_timestamp_seconds',
  help: '작업별 마지막 성공 시각; 0은 조회했으나 성공 이력이 없음',
  labelNames: ['operation'], registers: [registry],
});
const syncFailures = new client.Gauge({
  name: 'foodiguard_sync_failures_24h', help: '작업별 최근 24시간 실패 건수',
  labelNames: ['operation'], registers: [registry],
});
const qualityLastRefresh = new client.Gauge({
  name: 'foodiguard_data_quality_last_refresh_timestamp_seconds',
  help: 'DB에서 데이터 품질을 마지막으로 확인한 시각', registers: [registry],
});

export async function observeDbPoolWait(operation, run) {
  const stop = dbPoolWait.startTimer({ operation });
  try {
    const result = await run();
    stop({ result: 'success' });
    return result;
  } catch (error) {
    stop({ result: 'error' });
    throw error;
  }
}

export function setSyncHealth(rows, refreshedAt) {
  for (const row of rows) {
    syncLastSuccess.set({ operation: row.source_type }, Number(row.last_success || 0));
    syncFailures.set({ operation: row.source_type }, Number(row.failures || 0));
  }
  qualityLastRefresh.set(refreshedAt);
}

const geminiRequests = new client.Counter({
  name: 'foodiguard_gemini_requests_total',
  help: 'Gemini 호출 수',
  labelNames: ['result'],
  registers: [registry],
});

const geminiRequestDuration = new client.Histogram({
  name: 'foodiguard_gemini_request_duration_seconds',
  help: 'Gemini 응답 시간(초)',
  labelNames: ['result'],
  // 생성 모델은 초 단위로 움직인다. HTTP 버킷을 그대로 쓰면 전부 마지막 칸에 몰린다.
  buckets: [0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 13, 21],
  registers: [registry],
});

const geminiFallback = new client.Counter({
  name: 'foodiguard_gemini_fallback_total',
  help: 'Gemini 실패로 규칙 기반 설명을 대신 내보낸 횟수',
  registers: [registry],
});

const allergenExclusions = new client.Counter({
  name: 'foodiguard_allergen_exclusions_total',
  help: '알레르기 제외 조건이 적용된 조회 수',
  labelNames: ['operation'],
  registers: [registry],
});

// 데이터 품질 게이지는 레지스트리에 미리 넣지 않는다. 라벨 없는 Gauge 는 등록되는
// 순간부터 0 을 내보내는데, 여기서 0 은 '매칭률 0%', '마지막 적재 1970년'으로 읽혀
// 기동 직후 첫 수집에서 알림을 잘못 울린다. 값을 처음 알게 된 순간에 등록한다.
const dataQualityGauges = [
  ['matchRatio', new client.Gauge({
    name: 'foodiguard_ingredient_match_ratio',
    help: '원재료 분석이 끝난 상품 비율(0~1)',
  })],
  ['missingRatio', new client.Gauge({
    name: 'foodiguard_nutrition_missing_ratio',
    help: '주요 영양성분이 비어 있는 상품 비율(0~1)',
  })],
  ['lastSuccessAt', new client.Gauge({
    name: 'foodiguard_data_last_success_timestamp_seconds',
    help: '마지막으로 성공한 증분 적재의 완료 시각(유닉스 초)',
  })],
];

export function statusClass(statusCode) {
  const code = Number(statusCode);
  if (!Number.isFinite(code) || code < 100) return 'unknown';
  return `${Math.floor(code / 100)}xx`;
}

// 라벨에는 실제 URL 이 아니라 라우트 패턴을 넣는다. /api/products/12345/ingredients 를
// 그대로 쓰면 상품 수만큼 시계열이 생긴다.
export function routeLabel(req) {
  const pattern = req.route?.path;
  if (typeof pattern === 'string') return `${req.baseUrl || ''}${pattern}` || '/';
  // 정규식 라우트(SPA 폴백)와 정적 파일은 개별 경로를 남기지 않는다.
  if (pattern) return 'spa';
  return 'unmatched';
}

export function httpMetricsMiddleware(req, res, next) {
  // /metrics 자체는 세지 않는다. 30초마다 오는 수집 요청이 트래픽 지표를 흐린다.
  if (req.path === '/metrics') {
    next();
    return;
  }

  const stop = httpRequestDuration.startTimer();
  httpInFlight.inc();
  let settled = false;

  const record = () => {
    if (settled) return;
    settled = true;
    httpInFlight.dec();
    const labels = {
      method: req.method,
      route: routeLabel(req),
      status_class: statusClass(res.statusCode),
    };
    stop(labels);
    httpRequestsTotal.inc(labels);
  };

  // finish 는 응답을 다 보낸 경우, close 는 클라이언트가 먼저 끊은 경우다.
  // 둘 다 잡지 않으면 in-flight 게이지가 영원히 올라간 채로 남는다.
  res.on('finish', record);
  res.on('close', record);
  next();
}

export async function metricsHandler(_req, res) {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
}

// DB 조회를 감싸 시간과 실패를 기록한다. operation 은 호출부가 정하는 고정 문자열이다.
export async function observeDbQuery(operation, run) {
  const stop = dbQueryDuration.startTimer({ operation });
  try {
    const result = await run();
    stop({ result: 'success' });
    return result;
  } catch (error) {
    stop({ result: 'error' });
    dbQueryErrors.inc({ operation });
    throw error;
  }
}

export async function observeGeminiRequest(run) {
  const stop = geminiRequestDuration.startTimer();
  try {
    const result = await run();
    stop({ result: 'success' });
    geminiRequests.inc({ result: 'success' });
    return result;
  } catch (error) {
    stop({ result: 'error' });
    geminiRequests.inc({ result: 'error' });
    throw error;
  }
}

export function recordGeminiFallback() {
  geminiFallback.inc();
}

// 알레르기 제외가 걸린 조회 수를 센다. 제외된 상품 건수가 아니라 조회 건수다 —
// 상품 건수를 세려면 제외 없는 COUNT 를 매 요청 한 번 더 돌려야 해서 비용이 두 배가 된다.
export function recordAllergenExclusion(operation) {
  allergenExclusions.inc({ operation });
}

// 값을 아는 게이지만 등록하고 채운다. 아직 모르는 지표는 /metrics 에 아예 나오지
// 않으므로, 알림에서는 absent() 로 '아직 값이 없는 상태'를 따로 잡아야 한다.
export function setDataQuality(values = {}) {
  for (const [key, gauge] of dataQualityGauges) {
    const value = values[key];
    if (!Number.isFinite(value)) continue;
    if (!registry.getSingleMetric(gauge.name)) registry.registerMetric(gauge);
    gauge.set(value);
  }
}
