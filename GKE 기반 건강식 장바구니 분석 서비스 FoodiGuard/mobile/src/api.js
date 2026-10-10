import { Platform } from 'react-native';

function getApiBaseUrl() {
  const configured = process.env.EXPO_PUBLIC_API_BASE_URL?.trim();
  if (configured) return configured.replace(/\/$/, '');

  if (Platform.OS === 'web' && globalThis.location?.origin) {
    const { origin, port } = globalThis.location;
    if (port === '8081' || port === '8082') return 'http://127.0.0.1:8080/api';
    return `${origin}/api`;
  }

  // iOS Simulator reaches the Mac host through loopback. Physical devices can
  // override this with EXPO_PUBLIC_API_BASE_URL.
  return 'http://127.0.0.1:8080/api';
}

export const apiBaseUrl = getApiBaseUrl();

// 로그인 응답으로 받은 세션 토큰. 프로필 수정처럼 본인 확인이 필요한 요청에 붙는다.
let sessionToken = '';

export function setAuthToken(token) {
  sessionToken = token ? String(token) : '';
}

async function readPayload(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`서버 응답을 읽지 못했습니다. (${response.status})`);
  }
}

// Render 무료 인스턴스는 유휴 시 잠들어 콜드스타트가 수십 초까지 간다. 타임아웃이 없으면
// 사용자가 이미 스크롤한 뒤에 응답이 도착해 레이아웃을 밀어낸다. 호출부가 signal을 주면 그것을 쓴다.
const DEFAULT_TIMEOUT_MS = 8000;

export async function apiRequest(path, options = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    signal: options.signal ?? (typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(DEFAULT_TIMEOUT_MS) : undefined),
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
      ...(options.headers || {}),
    },
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    const error = new Error(payload.message || '요청을 처리하지 못했습니다.');
    error.status = response.status;
    error.code = payload.code || '';
    throw error;
  }
  return payload;
}

async function authenticate(path, body) {
  const payload = await apiRequest(path, { method: 'POST', body: JSON.stringify(body) });
  setAuthToken(payload.token);
  return payload;
}

export function login(email, password) {
  return authenticate('/auth/login', { email, password });
}

export function signup(name, email, password) {
  return authenticate('/auth/signup', { name, email, password });
}

// 동의 문서는 서버가 원본을 갖는다. 앱에 사본을 두면 문구를 고칠 때 한쪽만 바뀌어,
// 사용자가 읽은 문장과 서버가 해시로 저장한 문장이 어긋난다.
export function fetchConsentDocuments() {
  return apiRequest('/consents');
}

export function submitConsents(userId, agreements) {
  return apiRequest(`/auth/users/${encodeURIComponent(userId)}/consents`, {
    method: 'POST',
    body: JSON.stringify({ agreements }),
  });
}

export function saveOnboardingProfile(userId, profile) {
  return apiRequest(`/auth/users/${encodeURIComponent(userId)}/profile`, {
    method: 'PATCH',
    body: JSON.stringify(profile),
  });
}

export function fetchProducts({ query = '', start = 1, display = 30, excludeAllergens = [], theme = '' } = {}) {
  const params = new URLSearchParams({ query, start: String(start), display: String(display) });
  if (excludeAllergens.length) params.set('excludeAllergens', excludeAllergens.join(','));
  if (theme) params.set('theme', theme);
  return apiRequest(`/products?${params.toString()}`);
}

export function fetchProductIngredients(productId) {
  const dbId = String(productId).replace(/^db-/, '');
  return apiRequest(`/products/${dbId}/ingredients`);
}

export function fetchApiHealth() {
  return apiRequest('/health');
}

export function explainCart(payload) {
  return apiRequest('/cart/explanation', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// 대체 상품 후보. 서버는 프로필을 모르므로 카테고리·동일명·나트륨0·원재료 유사도까지만 좁혀 주고,
// 점수와 1회 섭취량이 필요한 판정은 domain.js의 findReplacements가 한다(감사보고서 R1~R13).
// level — 카테고리 사다리 단계(0 정확일치 / 1 대분류+중분류 / 2 대분류). 서버는 점수를 모르므로
// "게이트를 통과하는 후보가 0"을 판정할 수 없다. 그 판정은 클라이언트만 할 수 있어 단계를 넘긴다.
export function fetchAlternatives(productId, { limit = 200, level, excludeAllergens = [], signal } = {}) {
  const params = new URLSearchParams({ id: String(productId), limit: String(limit) });
  if (level != null) params.set('level', String(level));
  if (excludeAllergens.length) params.set('excludeAllergens', excludeAllergens.join(','));
  return apiRequest(`/products/alternatives?${params.toString()}`, { signal });
}
