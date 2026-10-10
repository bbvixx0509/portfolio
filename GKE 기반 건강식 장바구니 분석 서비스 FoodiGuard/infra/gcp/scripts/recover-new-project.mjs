// New-project recovery only. Secrets are generated locally, never sent to stdout.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const project = 'foodigard';
const context = `gke_${project}_asia-northeast3_foodiguard-cluster`;
const privateDir = path.join(root, '.foodiguard-recovery');
const credentialsFile = path.join(privateDir, 'credentials.json');
const action = process.argv[2];
fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
fs.chmodSync(privateDir, 0o700);
if (!fs.existsSync(credentialsFile)) {
  if (action !== 'sql-password') throw new Error('Run sql-password first.');
  fs.writeFileSync(credentialsFile, JSON.stringify({
    project, database: 'foodiguard', user: 'postgres',
    password: crypto.randomBytes(36).toString('base64url'),
    authTokenSecret: crypto.randomBytes(48).toString('base64url'),
  }), { mode: 0o600, flag: 'wx' });
}
fs.chmodSync(credentialsFile, 0o600);
const credentials = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
if (credentials.project !== project) throw new Error('Credential project mismatch.');
const run = (cmd, args, options = {}) => {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`${cmd} failed (${result.status}).`);
};
if (action === 'sql-password') {
  const token = execFileSync('gcloud', ['auth', 'print-access-token', '--account=rudans0601@gmail.com'], { encoding: 'utf8' }).trim();
  const api = async (url, options = {}) => {
    const response = await fetch(url, {
      ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`Cloud SQL API failed (${response.status}, ${body.error?.status ?? 'unknown'}).`);
    return body;
  };
  const base = `https://sqladmin.googleapis.com/sql/v1beta4/projects/${project}`;
  let operation = await api(`${base}/instances/foodiguard-db/users?name=postgres`, {
    method: 'PUT', body: JSON.stringify({ name: credentials.user, password: credentials.password }),
  });
  while (operation.status !== 'DONE') {
    await new Promise(resolve => setTimeout(resolve, 2000));
    operation = await api(`${base}/operations/${operation.name}`);
  }
  if (operation.error) throw new Error('Cloud SQL password update failed.');
  console.log('Cloud SQL password configured; private local credential file retained.');
} else if (action === 'k8s-secrets') {
  for (const [name, values] of Object.entries({
    'foodiguard-db-secret': { DB_NAME: credentials.database, DB_USER: credentials.user, DB_PASSWORD: credentials.password },
    'foodiguard-auth-secret': { AUTH_TOKEN_SECRET: credentials.authTokenSecret },
  })) {
    const existing = spawnSync('kubectl', ['--context', context, '-n', 'default', 'get', 'secret', name, '--ignore-not-found', '-o', 'name'], { encoding: 'utf8' });
    if (existing.status !== 0) throw new Error('Cannot inspect existing secrets.');
    if (existing.stdout.trim()) {
      console.log(`${name} exists; left unchanged.`);
      continue;
    }
    const object = { apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: 'default' }, type: 'Opaque',
      data: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Buffer.from(value).toString('base64')])) };
    const result = spawnSync('kubectl', ['--context', context, 'create', '-f', '-'], { input: JSON.stringify(object), encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Secret creation failed for ${name}.`);
    console.log(result.stdout.trim());
  }
} else if (action === 'verify' || action === 'migrate') {
  const env = { ...process.env, DB_HOST: '127.0.0.1', DB_PORT: '15433', DB_NAME: credentials.database,
    DB_USER: credentials.user, DB_PASSWORD: credentials.password, DB_STATEMENT_TIMEOUT_MS: '900000' };
  if (action === 'migrate') {
    run('npm', ['run', 'db:migrate'], { cwd: path.join(root, 'backend'), env });
  } else {
    const { default: pg } = await import(path.join(root, 'backend/node_modules/pg/lib/index.js'));
    const client = new pg.Client({ host: env.DB_HOST, port: 15433, database: credentials.database,
      user: credentials.user, password: credentials.password });
    await client.connect();
    try {
      const expected = { food_products: 79041, ingredient_source_rows: 78034, food_ingredient_matches: 79041,
        food_ingredients: 901315, food_allergens: 122080, health_functional_products: 45593, health_functional_matches: 79041 };
      const counts = {};
      for (const [table, count] of Object.entries(expected)) {
        counts[table] = Number((await client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
        if (counts[table] !== count) throw new Error(`Snapshot count mismatch: ${table}.`);
      }
      counts.users = Number((await client.query('SELECT count(*) AS count FROM users')).rows[0].count);
      console.log(JSON.stringify({ project, snapshotCountsMatch: true, counts }, null, 2));
    } finally { await client.end(); }
  }
} else if (action === 'restore') {
  const backupDir = process.argv[3];
  if (!backupDir) throw new Error('Provide the explicit backup directory.');
  const pgBin = '/opt/homebrew/Cellar/libpq/17.5/bin';
  const env = { ...process.env, PGHOST: '127.0.0.1', PGPORT: '15433', PGDATABASE: credentials.database,
    PGUSER: credentials.user, PGPASSWORD: credentials.password, PGCONNECT_TIMEOUT: '10' };
  const count = execFileSync(`${pgBin}/psql`, ['-X', '-At', '-c', "SELECT count(*) FROM pg_tables WHERE schemaname='public'"], { env, encoding: 'utf8' }).trim();
  if (count !== '0') throw new Error('Refusing restore into a nonempty schema.');
  for (const [archive, section] of [['schema.dump', 'pre-data'], ['food-data.dump', 'data'], ['schema.dump', 'post-data']]) {
    run(`${pgBin}/pg_restore`, ['--exit-on-error', '--no-owner', '--no-privileges', `--section=${section}`, '--dbname=foodiguard', path.join(backupDir, archive)], { env });
    console.log(`Restored ${section}.`);
  }
  run(`${pgBin}/psql`, ['-X', '-v', 'ON_ERROR_STOP=1', '-c', 'ANALYZE;'], { env });
  console.log('Food snapshot restored. User records were not part of this archive.');
} else {
  throw new Error('Use sql-password, k8s-secrets, or restore.');
}
