// Run only against the newly created foodigard Jenkins through its local IAP tunnel.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const file = path.join(root, '.foodiguard-recovery/jenkins.json');
const base = process.env.JENKINS_RECOVERY_URL || 'http://127.0.0.1:18082';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('Recovery requires a loopback IAP tunnel.');
const action = process.argv[2];
if (!fs.existsSync(file)) {
  const initialPassword = execFileSync('gcloud', ['compute', 'ssh', 'jenkins-vm', '--zone=asia-northeast3-a',
    '--project=foodigard', '--tunnel-through-iap', '--quiet', '--command=sudo cat /var/lib/jenkins/secrets/initialAdminPassword'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  fs.writeFileSync(file, JSON.stringify({ username: 'admin', password: initialPassword,
    newPassword: crypto.randomBytes(24).toString('base64url'), setupComplete: false }), { mode: 0o600, flag: 'wx' });
}
const auth = JSON.parse(fs.readFileSync(file, 'utf8'));
let cookie = '';
let crumb;
const request = async (endpoint, options = {}) => {
  const response = await fetch(base + endpoint, { signal: AbortSignal.timeout(15000), ...options, redirect: 'manual', headers: {
    Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`,
    ...(cookie ? { Cookie: cookie } : {}), ...(crumb ? { [crumb.crumbRequestField]: crumb.crumb } : {}),
    ...options.headers,
  } });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) cookie = cookies.map(value => value.split(';')[0]).join('; ');
  if (response.status >= 400) throw new Error(`Jenkins ${endpoint} failed (${response.status}).`);
  return response;
};
crumb = await (await request('/crumbIssuer/api/json')).json();
const post = (endpoint, values) => request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values) });
if (action === 'plugins') {
  const response = await request('/pluginManager/installPlugins', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plugins: ['workflow-aggregator', 'pipeline-model-definition', 'git'], dynamicLoad: true }) });
  const result = await response.json();
  if (result.status !== 'ok') throw new Error('Plugin install request rejected.');
  console.log('Pipeline and Git plugin installation requested.');
} else if (action === 'status') {
  const response = await request('/updateCenter/installStatus');
  const result = await response.json();
  const jobs = result.data?.jobs ?? [];
  console.log(JSON.stringify({ state: result.data?.state, total: jobs.length,
    unfinished: jobs.filter(job => !['Success', 'AlreadyInstalled'].includes(job.installStatus)).map(job => ({ name: job.name, status: job.installStatus })) }));
} else if (action === 'admin') {
  if (auth.setupComplete) throw new Error('Setup is already complete; refusing to change the password.');
  const response = await post('/setupWizard/createAdminUser', { username: 'admin', password1: auth.newPassword,
    password2: auth.newPassword, fullname: 'FoodiGuard Administrator', email: 'admin@example.com' });
  const result = await response.json();
  if (result.status !== 'ok') throw new Error('Admin creation failed.');
  auth.password = auth.newPassword;
  delete auth.newPassword;
  fs.writeFileSync(file, JSON.stringify(auth), { mode: 0o600 });
  crumb = await (await request('/crumbIssuer/api/json')).json();
  await post('/setupWizard/configureInstance', { rootUrl: `${base}/` });
  await post('/setupWizard/completeInstall', {});
  auth.setupComplete = true;
  fs.writeFileSync(file, JSON.stringify(auth), { mode: 0o600 });
  console.log('New admin configured; credentials retained only in private local file.');
} else if (action === 'job') {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<flow-definition plugin="workflow-job"><description>FoodiGuard main CI/CD in GCP foodigard</description>
<keepDependencies>false</keepDependencies><properties/>
<definition class="org.jenkinsci.plugins.workflow.cps.CpsScmFlowDefinition" plugin="workflow-cps">
<scm class="hudson.plugins.git.GitSCM" plugin="git"><configVersion>2</configVersion>
<userRemoteConfigs><hudson.plugins.git.UserRemoteConfig><url>https://github.com/rudans601/26-1_CloudCapstone.git</url></hudson.plugins.git.UserRemoteConfig></userRemoteConfigs>
<branches><hudson.plugins.git.BranchSpec><name>*/main</name></hudson.plugins.git.BranchSpec></branches>
<doGenerateSubmoduleConfigurations>false</doGenerateSubmoduleConfigurations><submoduleCfg class="empty-list"/><extensions/>
</scm><scriptPath>Jenkinsfile</scriptPath><lightweight>true</lightweight></definition><triggers/><disabled>false</disabled></flow-definition>`;
  await request('/createItem?name=foodiguard-main', { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body: xml });
  console.log('foodiguard-main pipeline created; build not yet started.');
} else if (action === 'deploy-key') {
  const repository = 'rudans601/26-1_CloudCapstone';
  const credentialId = 'foodigard-github-readonly';
  const oldUrl = `https://github.com/${repository}.git`;
  const sshUrl = `git@github.com:${repository}.git`;
  let xml = await (await request('/job/foodiguard-main/config.xml')).text();
  if (xml.includes(`<url>${sshUrl}</url>`) && xml.includes(`<credentialsId>${credentialId}</credentialsId>`)) {
    console.log('Repository-only SCM credential is already configured; no changes.');
    process.exit(0);
  }
  if (!xml.includes(`<url>${oldUrl}</url>`)) throw new Error('Unexpected SCM configuration; refusing replacement.');
  const ssh = ['compute', 'ssh', 'jenkins-vm', '--zone=asia-northeast3-a', '--project=foodigard', '--tunnel-through-iap', '--quiet'];
  const capture = command => execFileSync('gcloud', [...ssh, `--command=${command}`], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  capture('sudo install -d -m 0700 -o jenkins -g jenkins /var/lib/jenkins/.ssh; if [ ! -f /var/lib/jenkins/.ssh/foodiguard-github ]; then sudo -u jenkins ssh-keygen -q -t ed25519 -N "" -C foodigard-jenkins-readonly -f /var/lib/jenkins/.ssh/foodiguard-github; fi');
  const publicKey = capture('sudo cat /var/lib/jenkins/.ssh/foodiguard-github.pub');
  const keys = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/keys`], { encoding: 'utf8' }));
  const canonical = key => key.trim().split(/\s+/).slice(0, 2).join(' ');
  if (!keys.some(key => canonical(key.key) === canonical(publicKey))) {
    const response = spawnSync('gh', ['api', `repos/${repository}/keys`, '--method', 'POST', '--input', '-'], {
      input: JSON.stringify({ title: 'foodigard Jenkins read-only 20261002', key: publicKey, read_only: true }), encoding: 'utf8',
    });
    if (response.status !== 0) throw new Error('Read-only GitHub deploy key registration failed.');
    console.log(`Read-only repository deploy key registered (id ${JSON.parse(response.stdout).id}).`);
  }
  const meta = JSON.parse(execFileSync('gh', ['api', 'meta'], { encoding: 'utf8' }));
  const knownHosts = meta.ssh_keys.map(key => `github.com ${key}`).join('\n') + '\n';
  const hostsResult = spawnSync('gcloud', [...ssh, '--command=sudo -u jenkins tee /var/lib/jenkins/.ssh/known_hosts >/dev/null; sudo chmod 0600 /var/lib/jenkins/.ssh/known_hosts'], {
    input: knownHosts, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (hostsResult.status !== 0) throw new Error('Verified GitHub host key configuration failed.');
  const privateKey = capture('sudo cat /var/lib/jenkins/.ssh/foodiguard-github');
  await post('/credentials/store/system/domain/_/createCredentials', { json: JSON.stringify({
    credentials: { scope: 'GLOBAL', id: credentialId, username: 'git', description: 'Read-only deploy key for FoodiGuard repository',
      $class: 'com.cloudbees.jenkins.plugins.sshcredentials.impl.BasicSSHUserPrivateKey',
      privateKeySource: { $class: 'com.cloudbees.jenkins.plugins.sshcredentials.impl.BasicSSHUserPrivateKey$DirectEntryPrivateKeySource', privateKey },
      passphrase: '',
    },
  }) });
  xml = xml.replace(`<url>${oldUrl}</url>`, `<url>${sshUrl}</url><credentialsId>${credentialId}</credentialsId>`);
  await request('/job/foodiguard-main/config.xml', { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body: xml });
  console.log('Jenkins SCM uses repository-only SSH credential and verified host keys.');
} else if (action === 'build') {
  await post('/job/foodiguard-main/build', {});
  console.log('foodiguard-main build queued.');
} else if (action === 'job-status') {
  const data = await (await request('/job/foodiguard-main/api/json')).json();
  console.log(JSON.stringify({ name: data.name, buildable: data.buildable, inQueue: data.inQueue,
    lastBuild: data.lastBuild?.number ?? null }));
} else if (action === 'build-status') {
  const data = await (await request('/job/foodiguard-main/lastBuild/api/json')).json();
  console.log(JSON.stringify({ number: data.number, building: data.building, result: data.result, duration: data.duration }));
} else if (action === 'build-log') {
  const log = await (await request('/job/foodiguard-main/lastBuild/consoleText')).text();
  console.log(log.split('\n').slice(-45).join('\n'));
} else throw new Error('Use plugins, status, admin, job, deploy-key, build, job-status, build-status, or build-log.');
