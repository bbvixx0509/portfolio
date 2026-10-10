import crypto from 'node:crypto';

import { consentStateFromRecords } from './consents.js';

const PASSWORD_KEY_LENGTH = 64;
const PASSWORD_MIN_LENGTH = 6;
const TOKEN_TTL_SECONDS = Number(process.env.AUTH_TOKEN_TTL_SECONDS || 60 * 60 * 24 * 14);

const activityDefinitions = {
  '운동 거의 안함': { code: 'NONE', value: 'none' },
  '주 1~3회 걷기&가벼운 운동': { code: 'LIGHT', value: 'light' },
  '주3~5회 운동': { code: 'NORMAL', value: 'normal' },
  '육체활동 많은 직업&거의 매일 고강도 운동': { code: 'HIGH', value: 'high' },
};

const activityByCode = Object.fromEntries(
  Object.entries(activityDefinitions).map(([label, definition]) => [definition.code, { ...definition, label }]),
);

const goalDefinitions = {
  '감량·근육 보존 목표': {
    code: 'LOSS_MUSCLE_PRESERVE', goal: 'loss', weightGoal: 'lossProtein', intensity: 'gentle', goalIntensity: 'gentle', reduceTargets: [],
  },
  '단백질 우선 목표': {
    code: 'PROTEIN_PRIORITY', goal: 'maintain', weightGoal: 'preserve', intensity: 'gentle', goalIntensity: 'gentle', reduceTargets: [], recommendationTheme: 'protein',
  },
  '체중 유지 목표': {
    code: 'WEIGHT_MAINTENANCE', goal: 'maintain', weightGoal: 'maintain', intensity: 'gentle', goalIntensity: 'gentle', reduceTargets: [],
  },
  '적극적 감량 목표': {
    code: 'AGGRESSIVE_WEIGHT_LOSS', goal: 'loss', weightGoal: 'loss', intensity: 'aggressive', goalIntensity: 'aggressive', reduceTargets: [],
  },
  '열량 저감': {
    code: 'CALORIE_REDUCTION', goal: 'maintain', weightGoal: 'maintain', intensity: 'gentle', goalIntensity: 'gentle', reduceTargets: [],
  },
  '당류 저감': {
    code: 'SUGAR_REDUCTION', goal: 'maintain', weightGoal: 'maintain', intensity: 'gentle', goalIntensity: 'gentle', reduceTargets: ['sugar'], recommendationTheme: 'sugar',
  },
  '포화지방 저감': {
    code: 'SATURATED_FAT_REDUCTION', goal: 'maintain', weightGoal: 'maintain', intensity: 'gentle', goalIntensity: 'gentle', reduceTargets: ['saturatedFat'], recommendationTheme: 'saturatedFat',
  },
  '나트륨 저감': {
    code: 'SODIUM_REDUCTION', goal: 'maintain', weightGoal: 'maintain', intensity: 'gentle', goalIntensity: 'gentle', reduceTargets: ['sodium'], recommendationTheme: 'sodium',
  },
};

// Previous builds used these two labels. They are accepted only while migrating
// stored profiles; all new API responses use the IRB document labels above.
const legacyGoalAliases = {
  '체중 보존 목표': '체중 유지 목표',
  '적극적 목표 강도(엄격한 체중감량)': '적극적 감량 목표',
};

const goalByCode = Object.fromEntries(
  Object.entries(goalDefinitions).map(([label, definition]) => [definition.code, { ...definition, label }]),
);

const allergyDefinitions = {
  '알류(가금류)': 'EGG', 우유: 'MILK',
  메밀: 'BUCKWHEAT', 땅콩: 'PEANUT', 대두: 'SOY', 밀: 'WHEAT', 호두: 'WALNUT', 잣: 'PINE_NUT',
  고등어: 'MACKEREL', 게: 'CRAB', 새우: 'SHRIMP', 오징어: 'SQUID', 조개류: 'SHELLFISH',
  돼지고기: 'PORK', 닭고기: 'CHICKEN', 쇠고기: 'BEEF',
  복숭아: 'PEACH', 토마토: 'TOMATO', 아황산류: 'SULFITES',
};

const allergyByCode = Object.fromEntries(Object.entries(allergyDefinitions).map(([label, code]) => [code, label]));

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ─── 세션 토큰 ───────────────────────────────────────────────────────────────
// 프로필 수정은 지금까지 URL 의 userId 만 보고 처리했다. UUID 만 알면 남의 키·체중·
// 알레르기를 바꿀 수 있는 상태였으므로, 로그인 때 발급한 토큰으로 본인 여부를 확인한다.
//
// 토큰은 서버 비밀키로 서명한 페이로드다. 세션 테이블을 두지 않아 스키마 변경이 없고,
// 만료는 페이로드에 담아 검증할 때 본다.
let cachedTokenSecret = null;

function tokenSecret() {
  if (cachedTokenSecret) return cachedTokenSecret;

  const configured = String(process.env.AUTH_TOKEN_SECRET || '').trim();
  if (configured) {
    cachedTokenSecret = configured;
    return cachedTokenSecret;
  }

  // 비밀키가 없다고 고정 기본값을 쓰면 누구나 토큰을 위조할 수 있다. 대신 프로세스마다
  // 임의 키를 만든다 — 재시작하면 로그인이 풀리고, 레플리카가 여러 개면 서로의 토큰을
  // 거부하므로 반드시 눈에 띄게 경고한다.
  cachedTokenSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[auth] AUTH_TOKEN_SECRET 이 없어 임시 키를 생성했습니다. 재시작·다중 인스턴스에서 로그인이 유지되지 않습니다.');
  return cachedTokenSecret;
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function signPayload(encodedPayload) {
  return crypto.createHmac('sha256', tokenSecret()).update(encodedPayload).digest();
}

export function issueSessionToken(userId, issuedAtMs = Date.now()) {
  const issuedAt = Math.floor(issuedAtMs / 1000);
  const payload = { sub: String(userId), iat: issuedAt, exp: issuedAt + TOKEN_TTL_SECONDS };
  const encodedPayload = base64url(JSON.stringify(payload));
  return {
    token: `${encodedPayload}.${base64url(signPayload(encodedPayload))}`,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
  };
}

export function verifySessionToken(token, nowMs = Date.now()) {
  const [encodedPayload, signature] = String(token || '').split('.');
  if (!encodedPayload || !signature) {
    throw createAuthError(401, 'AUTH_TOKEN_INVALID', '로그인이 필요합니다.');
  }

  const expected = signPayload(encodedPayload);
  const provided = Buffer.from(signature, 'base64url');
  // 길이가 다르면 timingSafeEqual 이 예외를 던지므로 먼저 거른다.
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    throw createAuthError(401, 'AUTH_TOKEN_INVALID', '로그인이 필요합니다.');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    throw createAuthError(401, 'AUTH_TOKEN_INVALID', '로그인이 필요합니다.');
  }

  if (!payload?.sub || typeof payload.exp !== 'number') {
    throw createAuthError(401, 'AUTH_TOKEN_INVALID', '로그인이 필요합니다.');
  }
  if (payload.exp * 1000 <= nowMs) {
    throw createAuthError(401, 'AUTH_TOKEN_EXPIRED', '로그인이 만료되었습니다. 다시 로그인해주세요.');
  }

  return { userId: String(payload.sub), issuedAt: payload.iat, expiresAt: payload.exp };
}

export function readBearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  const [scheme, value] = String(header).split(' ');
  if (!value || scheme.toLowerCase() !== 'bearer') return '';
  return value.trim();
}

export function sendAuthError(res, error) {
  if (error.status && error.code) {
    res.status(error.status).json({ code: error.code, message: error.message });
    return;
  }

  res.status(500).json({ code: 'AUTH_FAILED', message: '회원 인증 처리 중 오류가 발생했습니다.' });
}

// 토큰이 유효한 요청만 통과시킨다. 통과하면 req.auth 에 토큰 주체를 남긴다.
export function requireAuth(req, res, next) {
  try {
    const token = readBearerToken(req);
    if (!token) throw createAuthError(401, 'AUTH_REQUIRED', '로그인이 필요합니다.');
    req.auth = verifySessionToken(token);
    next();
  } catch (error) {
    sendAuthError(res, error);
  }
}

// 경로의 회원 id 가 토큰 주체와 같을 때만 통과시킨다. requireAuth 다음에 놓는다.
export function requireSelf(paramName) {
  return (req, res, next) => {
    const target = String(req.params?.[paramName] || '').trim();
    if (!req.auth?.userId || req.auth.userId !== target) {
      sendAuthError(res, createAuthError(403, 'PROFILE_FORBIDDEN', '본인 회원 정보만 수정할 수 있습니다.'));
      return;
    }
    next();
  };
}

function createAuthError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, PASSWORD_KEY_LENGTH).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, passwordHash) {
  const [method, salt, storedHash] = String(passwordHash || '').split(':');
  if (method !== 'scrypt' || !salt || !storedHash) return false;

  const candidateHash = crypto.scryptSync(password, salt, PASSWORD_KEY_LENGTH);
  const storedBuffer = Buffer.from(storedHash, 'hex');
  if (storedBuffer.length !== candidateHash.length) return false;
  return crypto.timingSafeEqual(storedBuffer, candidateHash);
}

function normalizeBirthDate(value) {
  const normalized = String(value || '').trim().replaceAll('.', '-');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw createAuthError(400, 'BIRTH_DATE_INVALID', '생년월일을 YYYY.MM.DD 형식으로 입력해주세요.');
  }

  const [year, month, day] = normalized.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
    || parsed.getTime() > Date.now()
  ) {
    throw createAuthError(400, 'BIRTH_DATE_INVALID', '올바른 생년월일을 입력해주세요.');
  }
  return normalized;
}

function dateOnly(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function calculateAge(birthDate) {
  const [year, month, day] = dateOnly(birthDate).split('-').map(Number);
  const today = new Date();
  let age = today.getFullYear() - year;
  if (today.getMonth() + 1 < month || (today.getMonth() + 1 === month && today.getDate() < day)) age -= 1;
  return age;
}

function normalizeMetric(value, label, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= min || parsed > max) {
    throw createAuthError(400, 'METRIC_INVALID', `올바른 ${label}을 입력해주세요.`);
  }
  return parsed.toFixed(2);
}

function resolveGoalLabel(label) {
  const normalized = legacyGoalAliases[String(label || '').trim()] || String(label || '').trim();
  return goalDefinitions[normalized] ? normalized : '';
}

export function normalizeOnboardingProfile(payload = {}) {
  const gender = String(payload.gender || '').trim();
  if (!['남', '녀'].includes(gender)) {
    throw createAuthError(400, 'GENDER_REQUIRED', '성별을 선택해주세요.');
  }

  const activityLevel = String(payload.activityLevel || '').trim();
  const activity = activityDefinitions[activityLevel];
  if (!activity) {
    throw createAuthError(400, 'ACTIVITY_REQUIRED', '활동량을 선택해주세요.');
  }

  const dietaryGoal = resolveGoalLabel(payload.dietaryGoal);
  const goalProfile = goalDefinitions[dietaryGoal];
  if (!goalProfile) {
    throw createAuthError(400, 'GOAL_REQUIRED', '식생활 목표를 선택해주세요.');
  }

  const allergyLabels = Array.isArray(payload.allergies)
    ? [...new Set(payload.allergies.map((item) => String(item).trim()).filter(Boolean))]
    : [];
  if (allergyLabels.some((item) => !allergyDefinitions[item])) {
    throw createAuthError(400, 'ALLERGY_INVALID', '지원하지 않는 알레르기 항목이 포함되어 있습니다.');
  }

  const birthDate = normalizeBirthDate(payload.birthDate);
  const height = normalizeMetric(payload.height, '키', 30, 300);
  const weight = normalizeMetric(payload.weight, '체중', 10, 500);
  return {
    onboardingCompleted: true,
    gender,
    genderCode: gender === '남' ? 'MALE' : 'FEMALE',
    birthDate,
    age: String(calculateAge(birthDate)),
    height,
    weight,
    sex: gender === '남' ? 'male' : 'female',
    activityLevel,
    activityCode: activity.code,
    activity: activity.value,
    dietaryGoal,
    goalCode: goalProfile.code,
    allergies: allergyLabels,
    allergyCodes: allergyLabels.map((label) => allergyDefinitions[label]),
    avoidIngredients: allergyLabels,
    ...goalProfile,
    dietaryGoal,
  };
}

function serializeProfile(row) {
  if (!row.gender_code || !row.birth_date) return { displayName: row.name, onboardingCompleted: false };
  const activity = activityByCode[row.activity_code] || activityByCode.LIGHT;
  const goal = goalByCode[row.goal_code] || goalByCode.WEIGHT_MAINTENANCE;
  const birthDate = dateOnly(row.birth_date);
  const allergyCodes = Array.isArray(row.allergy_codes) ? row.allergy_codes : [];
  const allergies = allergyCodes.map((code) => allergyByCode[code]).filter(Boolean);
  return {
    displayName: row.name,
    onboardingCompleted: true,
    gender: row.gender_code === 'MALE' ? '남' : '녀',
    genderCode: row.gender_code,
    birthDate,
    age: String(calculateAge(birthDate)),
    height: Number(row.height_cm).toFixed(2),
    weight: Number(row.weight_kg).toFixed(2),
    sex: row.gender_code === 'MALE' ? 'male' : 'female',
    activityLevel: activity.label,
    activityCode: row.activity_code,
    activity: activity.value,
    dietaryGoal: goal.label,
    goalCode: row.goal_code,
    allergies,
    allergyCodes,
    avoidIngredients: allergies,
    goal: goal.goal,
    weightGoal: goal.weightGoal,
    intensity: goal.intensity,
    goalIntensity: goal.goalIntensity,
    reduceTargets: [...goal.reduceTargets],
    ...(goal.recommendationTheme ? { recommendationTheme: goal.recommendationTheme } : {}),
  };
}

function serializeUser(row) {
  return {
    id: String(row.id),
    name: row.name,
    email: row.email,
    profile: serializeProfile(row),
    // 동의 이력은 프로필과 별개다. 프로필을 다 채운 기존 회원이라도 현재 판본에 동의한
    // 적이 없으면 completed 가 false 가 되어 앱이 동의 화면을 먼저 띄운다.
    consent: consentStateFromRecords(row.granted_consents || []),
    createdAt: row.created_at,
  };
}

async function getUserRow(pool, whereSql, value, includePassword = false) {
  const result = await pool.query(
    `
      SELECT
        u.id, u.name, u.email, u.created_at${includePassword ? ', u.password_hash' : ''},
        p.gender_code, p.birth_date, p.height_cm, p.weight_kg, p.activity_code, p.goal_code,
        COALESCE(ARRAY(
          SELECT ua.allergen_code
          FROM user_allergies ua
          WHERE ua.user_id = u.id
          ORDER BY ua.allergen_code
        ), ARRAY[]::VARCHAR[]) AS allergy_codes,
        COALESCE(ARRAY(
          SELECT uc.consent_type || ':' || uc.consent_version
          FROM user_consents uc
          WHERE uc.user_id = u.id AND uc.status = 'GRANTED'
          ORDER BY uc.consent_type
        ), ARRAY[]::TEXT[]) AS granted_consents
      FROM users u
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE ${whereSql}
      LIMIT 1
    `,
    [value],
  );
  return result.rows[0] || null;
}

async function userColumnInfo(pool) {
  return pool.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users'
  `);
}

async function createUserTables(pool, emailType) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email ${emailType} NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      gender_code VARCHAR(10) NOT NULL CHECK (gender_code IN ('MALE', 'FEMALE')),
      birth_date DATE NOT NULL,
      height_cm NUMERIC(5, 2) NOT NULL,
      weight_kg NUMERIC(6, 2) NOT NULL,
      activity_code VARCHAR(20) NOT NULL CHECK (activity_code IN ('NONE', 'LIGHT', 'NORMAL', 'HIGH')),
      goal_code VARCHAR(40) NOT NULL CHECK (goal_code IN (
        'LOSS_MUSCLE_PRESERVE', 'PROTEIN_PRIORITY', 'WEIGHT_MAINTENANCE', 'AGGRESSIVE_WEIGHT_LOSS',
        'CALORIE_REDUCTION', 'SUGAR_REDUCTION', 'SATURATED_FAT_REDUCTION', 'SODIUM_REDUCTION'
      )),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_allergies (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      allergen_code VARCHAR(30) NOT NULL,
      PRIMARY KEY (user_id, allergen_code)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_consents (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      consent_type VARCHAR(30) NOT NULL CHECK (consent_type IN ('PRIVACY', 'HEALTH_DATA', 'RESEARCH', 'NON_MEDICAL_NOTICE')),
      consent_version VARCHAR(30) NOT NULL,
      content_hash CHAR(64) NOT NULL,
      status VARCHAR(20) NOT NULL CHECK (status IN ('GRANTED', 'WITHDRAWN')),
      consented_at TIMESTAMPTZ NOT NULL,
      withdrawn_at TIMESTAMPTZ,
      UNIQUE (user_id, consent_type, consent_version)
    )
  `);
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email::TEXT))');
}

async function migrateLegacyProfiles(pool, legacyRows) {
  for (const row of legacyRows) {
    const legacy = row.profile;
    if (!legacy || typeof legacy !== 'object' || !legacy.birthDate || !legacy.height || !legacy.weight) continue;
    const activityLevel = legacy.activityLevel || Object.values(activityByCode).find((item) => item.value === legacy.activity)?.label;
    const dietaryGoal = legacy.dietaryGoal || '체중 유지 목표';
    let normalized;
    try {
      normalized = normalizeOnboardingProfile({
        gender: legacy.gender || (legacy.sex === 'female' ? '녀' : '남'),
        birthDate: legacy.birthDate,
        height: legacy.height,
        weight: legacy.weight,
        activityLevel,
        dietaryGoal,
        allergies: legacy.allergies || legacy.avoidIngredients || [],
      });
    } catch {
      continue;
    }

    await pool.query(
      `
        INSERT INTO user_profiles (user_id, gender_code, birth_date, height_cm, weight_kg, activity_code, goal_code)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (user_id) DO NOTHING
      `,
      [row.id, normalized.genderCode, normalized.birthDate, normalized.height, normalized.weight, normalized.activityCode, normalized.goalCode],
    );
    for (const code of normalized.allergyCodes) {
      await pool.query(
        'INSERT INTO user_allergies (user_id, allergen_code) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [row.id, code],
      );
    }
  }
}

export async function ensureAuthSchema(pool) {
  const existing = await userColumnInfo(pool);
  if (existing.rows.length && !existing.rows.some((row) => row.column_name === 'password_hash')) {
    const count = await pool.query('SELECT COUNT(*)::int AS count FROM users');
    if ((count.rows[0]?.count || 0) > 0) {
      throw new Error('기존 users 테이블이 인증 스키마와 다르고 데이터가 있어 자동 교체할 수 없습니다.');
    }
    await pool.query('DROP TABLE users CASCADE');
  }

  let emailType = 'TEXT';
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS citext');
    emailType = 'CITEXT';
  } catch {
    // PGlite does not bundle every PostgreSQL extension. The unique lowercase
    // index below preserves the same email semantics for the simulator.
  }

  const refreshed = await userColumnInfo(pool);
  const legacyProfiles = refreshed.rows.some((row) => row.column_name === 'profile')
    ? (await pool.query('SELECT id, profile FROM users WHERE profile IS NOT NULL')).rows
    : [];
  const idColumn = refreshed.rows.find((row) => row.column_name === 'id');
  if (idColumn && idColumn.data_type !== 'uuid') {
    await pool.query('ALTER TABLE users ALTER COLUMN id TYPE UUID USING id::UUID');
  }

  await createUserTables(pool, emailType);
  await migrateLegacyProfiles(pool, legacyProfiles);
}

export async function signupUser(pool, payload) {
  const name = String(payload.name || '').trim();
  const email = normalizeEmail(payload.email);
  const password = String(payload.password || '');

  if (!name) throw createAuthError(400, 'NAME_REQUIRED', '이름을 입력해주세요.');
  if (!isValidEmail(email)) throw createAuthError(400, 'EMAIL_INVALID', '올바른 이메일을 입력해주세요.');
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw createAuthError(400, 'PASSWORD_TOO_SHORT', '비밀번호는 6자 이상으로 입력해주세요.');
  }

  const userId = crypto.randomUUID();
  try {
    await pool.query(
      'INSERT INTO users (id, name, email, password_hash) VALUES ($1, $2, $3, $4)',
      [userId, name, email, hashPassword(password)],
    );
    return {
      user: serializeUser(await getUserRow(pool, 'u.id = $1', userId)),
      session: issueSessionToken(userId),
    };
  } catch (error) {
    if (error.code === '23505') {
      throw createAuthError(409, 'EMAIL_ALREADY_EXISTS', '이미 가입된 이메일입니다.');
    }
    throw error;
  }
}

export async function saveOnboardingProfile(pool, userId, payload) {
  const id = String(userId || '').trim();
  if (!id) throw createAuthError(400, 'USER_REQUIRED', '회원 정보를 찾을 수 없습니다.');
  const profile = normalizeOnboardingProfile(payload);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT 1 FROM users WHERE id = $1', [id]);
    if (!existing.rows[0]) throw createAuthError(404, 'USER_NOT_FOUND', '회원 정보를 찾을 수 없습니다.');

    await client.query(
      `
        INSERT INTO user_profiles (user_id, gender_code, birth_date, height_cm, weight_kg, activity_code, goal_code, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
          gender_code = EXCLUDED.gender_code,
          birth_date = EXCLUDED.birth_date,
          height_cm = EXCLUDED.height_cm,
          weight_kg = EXCLUDED.weight_kg,
          activity_code = EXCLUDED.activity_code,
          goal_code = EXCLUDED.goal_code,
          updated_at = NOW()
      `,
      [id, profile.genderCode, profile.birthDate, profile.height, profile.weight, profile.activityCode, profile.goalCode],
    );
    await client.query('DELETE FROM user_allergies WHERE user_id = $1', [id]);
    for (const allergenCode of profile.allergyCodes) {
      await client.query('INSERT INTO user_allergies (user_id, allergen_code) VALUES ($1, $2)', [id, allergenCode]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return serializeUser(await getUserRow(pool, 'u.id = $1', id));
}

export async function findUserById(pool, userId) {
  const row = await getUserRow(pool, 'u.id = $1', String(userId || '').trim());
  if (!row) throw createAuthError(404, 'USER_NOT_FOUND', '회원 정보를 찾을 수 없습니다.');
  return serializeUser(row);
}

export async function loginUser(pool, payload) {
  const email = normalizeEmail(payload.email);
  const password = String(payload.password || '');
  if (!email || !password) throw createAuthError(400, 'LOGIN_REQUIRED', '이메일과 비밀번호를 입력해주세요.');

  const user = await getUserRow(pool, 'LOWER(u.email::TEXT) = $1', email, true);
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw createAuthError(401, 'INVALID_CREDENTIALS', '계정 정보가 맞지 않습니다.');
  }
  return { user: serializeUser(user), session: issueSessionToken(user.id) };
}
