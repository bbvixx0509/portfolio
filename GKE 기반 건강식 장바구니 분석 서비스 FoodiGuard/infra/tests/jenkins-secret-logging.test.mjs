import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Use fake values only; this test never contacts Kubernetes or reads credentials.
const root = new URL('../../', import.meta.url);
for (const path of ['Jenkinsfile', 'infra/gcp/Jenkinsfile']) {
  const source = readFileSync(new URL(path, root), 'utf8');
  const start = source.indexOf('          # Jenkins sh uses xtrace;');
  const end = source.indexOf('          set -x', start);
  assert.ok(start >= 0 && end > start, `${path}: Secret guard not found`);
  const guard = source.slice(start, end + '          set -x'.length);

  for (const missing of ['', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'AUTH_TOKEN_SECRET']) {
    test(`${path}: ${missing || 'all keys present'} hides values and preserves validation`, () => {
      const sentinel = 'SECRET_SENTINEL_NOT_REAL';
      const fakeKubectl = `kubectl() {
        case "$*" in
          *-o\\ name*) printf '%s\\n' secret/mock ;;
          *${missing || 'NEVER_MISSING'}*) : ;;
          *) printf '%s' ${sentinel} ;;
        esac
      }
      `;
      const result = spawnSync('/bin/sh', ['-xe'], {
        input: fakeKubectl + guard,
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      if (missing) assert.notEqual(result.status, 0);
      else assert.equal(result.status, 0);
      assert.ok(!(result.stdout + result.stderr).includes(sentinel));
    });
  }
}
