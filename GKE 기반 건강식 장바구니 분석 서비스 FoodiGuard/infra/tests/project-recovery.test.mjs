import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('new-project deployment entry points consistently target foodigard', () => {
  for (const prefix of ['', 'infra/gcp/']) {
    assert.match(read(`${prefix}Jenkinsfile`), /PROJECT_ID = 'foodigard'/);
    for (const file of ['backend-deployment.yaml', 'migration-job.yaml', 'data-sync-job.yaml', 'allergen-projection-cronjob.yaml']) {
      const content = read(`${prefix}k8s/${file}`);
      assert.match(content, /foodigard:asia-northeast3:foodiguard-db/);
      assert.doesNotMatch(content, /example-gcp-project/);
    }
    assert.match(read(`${prefix}k8s/backend-service-account.yaml`), /foodiguard-api-sa@foodigard\.iam\.gserviceaccount\.com/);
  }
});
test('new Terraform backend cannot automatically import the deleted project', () => {
  assert.equal(fs.existsSync(path.join(root, 'infra/gcp/terraform/imports.tf')), false);
  assert.match(read('infra/gcp/terraform/imports.example-gcp-project.tf.disabled'), /example-gcp-project/);
  assert.doesNotMatch(read('infra/gcp/terraform/versions.tf'), /example-gcp-project/);
  assert.match(read('infra/gcp/terraform/state_bucket.tf'), /\$\{var.project_id\}-foodiguard-tfstate/);
  assert.match(read('.gitignore'), /\*\*\/backend\.hcl/);
  assert.match(read('.gitignore'), /\.foodiguard-recovery\//);
});
test('fresh-project alerts wait for metric ingestion and only use primary channel', () => {
  assert.match(read('infra/gcp/terraform/monitoring.tf'), /var\.create_application_alerts/);
  assert.match(read('infra/gcp/terraform/monitoring.tf'), /enabled\s*= var\.alerts_enabled/);
  assert.match(read('infra/gcp/terraform/monitoring.tf'), /notification_channels\s*= \[google_monitoring_notification_channel\.primary\.name\]/);
});
test('mobile API tunnel targets the restored project and stays local', () => {
  const content = read('mobile/scripts/gke-api-tunnel.sh');
  assert.match(content, /GKE_CONTEXT:-gke_foodigard_asia-northeast3_foodiguard-cluster/);
  assert.doesNotMatch(content, /--address[= ]0\.0\.0\.0/);
});
