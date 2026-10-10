import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const read = (p) => readFileSync(new URL('../../'+p, import.meta.url), 'utf8');
test('deployment mirrors, HPA and disruption budget remain identical', () => {
  for (const file of ['backend-deployment.yaml','backend-hpa.yaml','backend-pdb.yaml','deployment.yaml','service.yaml','web-pdb.yaml']) {
    assert.equal(read('k8s/'+file), read('infra/gcp/k8s/'+file));
  }
});
test('web HA preserves readiness, drains nginx, and keeps the verified external route', () => {
  const deploy=read('k8s/deployment.yaml'), service=read('k8s/service.yaml'), pdb=read('k8s/web-pdb.yaml');
  assert.match(deploy,/replicas: 2/);assert.match(deploy,/maxUnavailable: 0/);assert.match(deploy,/maxSurge: 1/);
  assert.match(deploy,/minDomains: 2/);assert.match(deploy,/whenUnsatisfiable: DoNotSchedule/);assert.match(deploy,/topologyKey: kubernetes.io\/hostname/);
  assert.match(deploy,/terminationGracePeriodSeconds: 60/);assert.match(deploy,/sleep 30; nginx -s quit; sleep 5/);
  assert.match(pdb,/minAvailable: 1/);assert.match(pdb,/app: foodiguard-web/);assert.match(service,/externalTrafficPolicy: Local/);
  for(const p of ['Jenkinsfile','infra/gcp/Jenkinsfile']){
    const src=read(p);assert.match(src,/kubectl apply -f k8s\/web-pdb.yaml/);
    assert(src.indexOf('rollout status deployment/foodiguard-web')<src.indexOf('kubectl apply -f k8s/service.yaml'));
  }
});
test('bounded scaling and SQL pool budget, without declarative replica reset', () => {
  const deploy = read('k8s/backend-deployment.yaml'), hpa = read('k8s/backend-hpa.yaml');
  assert.doesNotMatch(deploy, /^\s+replicas:/m);
  assert.match(deploy, /DB_POOL_MAX\s+value: "3"/);
  assert.match(deploy, /SEARCH_CONCURRENCY\s+value: "1"/);
  assert.match(deploy, /SEARCH_QUEUE_MAX\s+value: "10"/);
  assert.match(hpa, /minReplicas: 2/); assert.match(hpa, /maxReplicas: 4/);
  assert.match(hpa, /type: ContainerResource/); assert.match(hpa, /container: foodiguard-api/);
});
test('rolling deployments drain before the native SQL sidecar terminates', () => {
  const deploy = read('k8s/backend-deployment.yaml');
  assert.match(deploy, /maxUnavailable: 0/); assert.match(deploy, /maxSurge: 1/);
  assert.match(deploy, /terminationGracePeriodSeconds: 45/);
  assert.match(deploy, /initContainers:\s+- name: cloud-sql-proxy\s+restartPolicy: Always/);
  assert.match(read('backend/server/index.js'), /installGracefulShutdown\(\{ server, pools: \[pool, readinessPool\] \}\)/);
});
test('both Jenkins entry points deploy and test scaling configuration', () => {
  for (const path of ['Jenkinsfile','infra/gcp/Jenkinsfile']) {
    const source = read(path);
    assert.match(source, /kubectl apply -f k8s\/backend-hpa.yaml -f k8s\/backend-pdb.yaml/);
    assert.match(source, /infra\/tests\/\*\.test.mjs/);
  }
});
