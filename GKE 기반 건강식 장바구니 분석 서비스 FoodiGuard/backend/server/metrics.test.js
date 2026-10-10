import assert from 'node:assert/strict';
import test from 'node:test';

import {
  httpMetricsMiddleware,
  observeDbQuery,
  observeGeminiRequest,
  recordAllergenExclusion,
  recordGeminiFallback,
  registry,
  routeLabel,
  setDataQuality,
  statusClass,
} from './metrics.js';

// 응답 객체 대역. express 없이 finish/close 이벤트만 흉내 낸다.
function fakeResponse(statusCode = 200) {
  const handlers = { finish: [], close: [] };
  return {
    statusCode,
    on(event, handler) { handlers[event].push(handler); },
    emit(event) { handlers[event].forEach((handler) => handler()); },
  };
}

async function metricValue(name, labels = {}) {
  const metric = await registry.getSingleMetricAsString(name);
  return metric;
}

// 히스토그램은 _count·_sum·_bucket 을 metric.name 이 아니라 각 값의 metricName 으로
// 노출한다. 두 경우를 함께 본다.
async function sampleValue(name, labelMatch = {}) {
  const json = await registry.getMetricsAsJSON();
  for (const metric of json) {
    const sample = metric.values.find((value) => {
      const sampleName = value.metricName || metric.name;
      if (sampleName !== name) return false;
      return Object.entries(labelMatch).every(([key, expected]) => value.labels[key] === expected);
    });
    if (sample) return sample.value;
  }
  return null;
}

test('상태 코드는 계열로만 남긴다', () => {
  assert.equal(statusClass(200), '2xx');
  assert.equal(statusClass(404), '4xx');
  assert.equal(statusClass(503), '5xx');
  assert.equal(statusClass(undefined), 'unknown');
});

test('경로 라벨은 URL 이 아니라 라우트 패턴이다', () => {
  // 상품 id 가 그대로 들어가면 상품 수만큼 시계열이 생긴다.
  assert.equal(routeLabel({ route: { path: '/api/products/:id/ingredients' } }), '/api/products/:id/ingredients');
  assert.equal(routeLabel({ baseUrl: '/api', route: { path: '/products' } }), '/api/products');
  assert.equal(routeLabel({ route: { path: /^(?!\/api).*/ } }), 'spa');
  assert.equal(routeLabel({}), 'unmatched');
});

test('요청이 끝나면 카운터와 히스토그램이 함께 오른다', async () => {
  const req = { method: 'GET', path: '/api/products', route: { path: '/api/products' } };
  const res = fakeResponse(200);
  const labels = { method: 'GET', route: '/api/products', status_class: '2xx' };

  const before = (await sampleValue('foodiguard_http_requests_total', labels)) || 0;
  httpMetricsMiddleware(req, res, () => {});
  assert.equal(await sampleValue('foodiguard_http_in_flight_requests'), 1, '처리 중에는 in-flight 가 올라간다');

  res.emit('finish');
  assert.equal(await sampleValue('foodiguard_http_requests_total', labels), before + 1);
  assert.equal(await sampleValue('foodiguard_http_in_flight_requests'), 0);
  assert.ok((await metricValue('foodiguard_http_request_duration_seconds')).includes('/api/products'));
});

test('클라이언트가 먼저 끊어도 in-flight 는 내려간다', async () => {
  const req = { method: 'GET', path: '/api/products', route: { path: '/api/products' } };
  const res = fakeResponse(499);

  httpMetricsMiddleware(req, res, () => {});
  res.emit('close');
  // finish 가 뒤늦게 와도 두 번 세지 않는다.
  res.emit('finish');
  assert.equal(await sampleValue('foodiguard_http_in_flight_requests'), 0);
});

test('/metrics 자체는 트래픽 지표에 넣지 않는다', async () => {
  const before = await sampleValue('foodiguard_http_requests_total', { route: 'unmatched' });
  let passed = false;
  httpMetricsMiddleware({ method: 'GET', path: '/metrics' }, fakeResponse(200), () => { passed = true; });

  assert.equal(passed, true);
  assert.equal(await sampleValue('foodiguard_http_requests_total', { route: 'unmatched' }), before);
});

test('DB 조회는 성공·실패를 나눠 기록하고 실패는 따로 센다', async () => {
  await observeDbQuery('unit_test', async () => 'ok');
  assert.equal(await sampleValue('foodiguard_db_query_duration_seconds_count', { operation: 'unit_test', result: 'success' }), 1);

  await assert.rejects(observeDbQuery('unit_test', async () => { throw new Error('boom'); }));
  assert.equal(await sampleValue('foodiguard_db_query_duration_seconds_count', { operation: 'unit_test', result: 'error' }), 1);
  assert.equal(await sampleValue('foodiguard_db_query_errors_total', { operation: 'unit_test' }), 1);
});

test('Gemini 호출과 규칙 설명 대체를 각각 센다', async () => {
  await observeGeminiRequest(async () => 'ok');
  assert.equal(await sampleValue('foodiguard_gemini_requests_total', { result: 'success' }), 1);

  await assert.rejects(observeGeminiRequest(async () => { throw new Error('unavailable'); }));
  assert.equal(await sampleValue('foodiguard_gemini_requests_total', { result: 'error' }), 1);

  recordGeminiFallback();
  assert.equal(await sampleValue('foodiguard_gemini_fallback_total'), 1);
});

test('알레르기 제외와 데이터 품질 게이지가 노출된다', async () => {
  recordAllergenExclusion('product_search');
  assert.equal(await sampleValue('foodiguard_allergen_exclusions_total', { operation: 'product_search' }), 1);

  setDataQuality({ matchRatio: 1, missingRatio: 0.25, lastSuccessAt: 1756000000 });
  assert.equal(await sampleValue('foodiguard_ingredient_match_ratio'), 1);
  assert.equal(await sampleValue('foodiguard_nutrition_missing_ratio'), 0.25);
  assert.equal(await sampleValue('foodiguard_data_last_success_timestamp_seconds'), 1756000000);

  // 값이 없으면 덮어쓰지 않는다 — 적재 이력이 없을 때 0(=1970년)으로 떨어지면 안 된다.
  setDataQuality({});
  assert.equal(await sampleValue('foodiguard_data_last_success_timestamp_seconds'), 1756000000);
});

test('필수 지표 12종이 모두 등록되어 있다', async () => {
  // 데이터 품질 게이지는 값을 처음 알았을 때 등록되므로 여기서 한 번 채워 준다.
  setDataQuality({ matchRatio: 1, missingRatio: 0, lastSuccessAt: 1756000000 });
  const json = await registry.getMetricsAsJSON();
  const names = new Set(json.map((metric) => metric.name));
  const required = [
    'foodiguard_http_requests_total',
    'foodiguard_http_request_duration_seconds',
    'foodiguard_http_in_flight_requests',
    'foodiguard_db_query_duration_seconds',
    'foodiguard_db_query_errors_total',
    'foodiguard_gemini_requests_total',
    'foodiguard_gemini_request_duration_seconds',
    'foodiguard_gemini_fallback_total',
    'foodiguard_allergen_exclusions_total',
    'foodiguard_ingredient_match_ratio',
    'foodiguard_nutrition_missing_ratio',
    'foodiguard_data_last_success_timestamp_seconds',
  ];

  for (const name of required) assert.ok(names.has(name), `${name} 미등록`);
});

test('라벨은 허용된 다섯 가지만 쓴다', async () => {
  const json = await registry.getMetricsAsJSON();
  const allowed = new Set(['method', 'route', 'status_class', 'operation', 'result', 'le', 'quantile']);

  for (const metric of json) {
    const used = new Set(metric.values.flatMap((value) => Object.keys(value.labels)));
    for (const label of used) {
      assert.ok(allowed.has(label), `${metric.name} 에 허용되지 않은 라벨 ${label}`);
    }
  }
});
