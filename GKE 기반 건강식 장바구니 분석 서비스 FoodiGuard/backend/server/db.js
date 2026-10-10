import './env.js';
import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { observeDbQuery, observeDbPoolWait } from './metrics.js';
import { traceAsync, tracePoolConnect } from './requestTrace.js';

const { Pool } = pg;
const serverDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(serverDir, '..');
const localPglitePath = path.resolve(backendDir, process.env.LOCAL_PGLITE_PATH || '.pglite');

function createLocalPglitePool() {
  let database;

  function getDatabase() {
    if (!database) {
      database = new PGlite(localPglitePath);
    }
    return database;
  }

  async function query(sql, values) {
    const statements = String(sql)
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);

    if (!values?.length && statements.length > 1) {
      let result = { rows: [] };
      for (const statement of statements) {
        result = await getDatabase().query(statement);
      }
      return result;
    }

    return getDatabase().query(sql, values);
  }

  return {
    query,
    async connect() {
      return { query, release() {} };
    },
    async end() {
      if (database) await database.close();
    },
  };
}

// 관리형 Postgres(Render·Neon·Supabase 등)는 SSL 접속만 허용하며,
// 중간 인증서가 시스템 신뢰 저장소에 없어 rejectUnauthorized를 끄는 것이 이들 플랫폼의 표준 설정이다.
function resolveSsl(defaultOn) {
  const flag = process.env.DB_SSL;
  const enabled = flag === undefined ? defaultOn : flag === 'true';
  if (!enabled) return undefined;
  return { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true' };
}

function buildSessionOptions(statementTimeoutMs) {
  const settings = [];
  if (process.env.DB_JIT !== 'on') settings.push('jit=off');
  settings.push(`random_page_cost=${process.env.DB_RANDOM_PAGE_COST || '1.0'}`);
  settings.push(`statement_timeout=${statementTimeoutMs}`);
  return settings.map((setting) => `-c ${setting}`).join(' ');
}

export function createPool({ readiness = false } = {}) {
  if (process.env.LOCAL_PGLITE === 'true') {
    return createLocalPglitePool();
  }

  const shared = {
    max: readiness ? 1 : Number(process.env.DB_POOL_MAX || 5),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: readiness ? 500 : Number(process.env.DB_CONNECTION_TIMEOUT_MS || 1500),
    // JIT 컴파일을 끈다. 앱 뷰는 상관 서브쿼리 때문에 비용 추정치가 백만 단위로 나와
    // 매번 JIT 임계값을 넘기는데, 실제로 훑는 행은 8만 줄이라 컴파일 비용을 못 뽑는다.
    // 목록 조회 기준 컴파일에만 83ms 를 썼고, 끄면 같은 쿼리가 455ms → 229ms 였다(실측).
    //
    // 기존 운영의 random_page_cost=1.0 을 유지한다. SSD 라는 이유만으로 모든
    // 쿼리에 최적인 값은 아니며, 실제 관련도 정렬의 전수 후보 평가를 없애지 않는다.
    // 값 변경은 앱의 정렬/COUNT 를 포함한 부하 비교로 판단한다.
    options: buildSessionOptions(readiness ? 750 : Number(process.env.DB_STATEMENT_TIMEOUT_MS || 5000)),
    // A broken connection must also have a client-side bound. Readiness destroys
    // its dedicated client on timeout; normal SQL is cancelled by PostgreSQL first.
    query_timeout: readiness ? 1000 : Number(process.env.DB_STATEMENT_TIMEOUT_MS || 5000) + 1000,
  };

  // 관리형 Postgres는 개별 항목 대신 접속 문자열 하나를 제공한다.
  if (process.env.DATABASE_URL) {
    return new Pool({
      ...shared,
      connectionString: process.env.DATABASE_URL,
      ssl: resolveSsl(true),
    });
  }

  return new Pool({
    ...shared,
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || 'foodiguard',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    ssl: resolveSsl(false),
  });
}

export const pool = createPool();
export const readinessPool = process.env.LOCAL_PGLITE === 'true' ? pool : createPool({ readiness: true });

export async function queryWithMetrics(database, operation, sql, values) {
  const client = await traceAsync(`pool:${operation}`, () => tracePoolConnect(database, operation,
    () => observeDbPoolWait(operation, () => database.connect())));
  let destroy = false;
  try {
    return await traceAsync(`sql:${operation}`, () => observeDbQuery(operation, () => client.query(sql, values)));
  } catch (error) {
    destroy = error.message === 'Query read timeout';
    throw error;
  } finally {
    client.release(destroy);
  }
}
