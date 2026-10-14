import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { GUEST_ROOT, NAMESPACE, requireRegularPath } from './manifest.mjs';
import { requireImageRevision } from '../../infrastructure/delivery/image-proof.mjs';
import { freshCredentials, profile, COMPONENTS } from './profile.mjs';
import { runtimeImageProof } from './runtime-image-proof.mjs';

async function checksum(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

export async function prepareVm(bench, { resume = false } = {}) {
  const manifest = bench.manifest;
  const state = await bench.status();
  assert.equal(state.networkMode, 'isolated'); assert.ok(state.sshReady);
  const marker = await bench.guest(['sudo', '-n', 'test', '-e', GUEST_ROOT], { allowFailure: true });
  const credentialsPath = join(bench.root, 'credentials.json');
  let credentials;
  if (resume) {
    assert.equal(marker.code, 0, 'There is no identified preparation to resume');
    credentials = JSON.parse(readFileSync(requireRegularPath(credentialsPath, { privateFile: true }), 'utf8'));
    const identity = JSON.parse((await bench.guest(['sudo', '-n', 'cat', GUEST_ROOT + '/identity.json'])).stdout.toString());
    assert.deepEqual(identity, { uuid: manifest.vm.uuid, consumer: 'gthf', runId: manifest.runId });
    assert.ok(!existsSync(join(bench.root, 'fixtures.json')), 'An application campaign is never reseeded');
    const namespace = await bench.kubeJson(['get', 'namespace', NAMESPACE]);
    assert.equal(namespace.metadata.labels['qualification.infra-sincere/uuid'], manifest.vm.uuid);
    assert.equal(namespace.metadata.labels['qualification.infra-sincere/run-id'], manifest.runId);
    assert.notEqual((await bench.kube(['get', 'job', 'synthetic-fixtures'], { allowFailure: true })).code, 0, 'A previously started fixture Job requires diagnosis, never automatic repetition');
    const secret = await bench.kubeJson(['get', 'secret', 'gthf-recovery-secrets']);
    for (const [key, value] of Object.entries(credentials)) assert.equal(Buffer.from(secret.data[key], 'base64').toString(), value, 'Campaign credentials differ');
    bench.event({ event: 'pre-fixture-preparation-resumed', retainedCredentials: true, retainedVolumes: true });
  } else {
    assert.notEqual(marker.code, 0, 'A previous application campaign is never overwritten');
    assert.ok(!existsSync(credentialsPath), 'Existing campaign credentials are never replaced');
    credentials = freshCredentials();
    writeFileSync(credentialsPath, JSON.stringify(credentials) + '\n', { mode: 0o600, flag: 'wx' });
  }
  const foundation = profile(manifest, credentials, readFileSync(new URL('./seed.mjs', import.meta.url), 'utf8'));
  await bench.guest(['sudo', '-n', 'python3', '-c', `import os,pathlib,json
p=pathlib.Path('${GUEST_ROOT}')
p.mkdir(mode=0o700,exist_ok=${resume ? 'True' : 'False'})
if not (p/'identity.json').exists(): (p/'identity.json').write_text(json.dumps({'uuid':'${manifest.vm.uuid}','consumer':'gthf','runId':'${manifest.runId}'}))
(p/'faults').mkdir(mode=0o700,exist_ok=${resume ? 'True' : 'False'})
os.chown(p/'faults',1000,1000)
campaign=p/'faults'/'campaign.json'
expected={'campaignId':'${manifest.vm.uuid}','databaseName':'${manifest.database}','namespace':'${NAMESPACE}','isolated':True}
if campaign.exists():
 assert json.loads(campaign.read_text())==expected
else:
 with campaign.open('x') as f:
  f.write(json.dumps(expected));f.flush();os.fsync(f.fileno())
campaign.chmod(0o600);os.chown(campaign,1000,1000)
with (p/'identity.json').open('rb') as f: os.fsync(f.fileno())
fd=os.open(p,os.O_DIRECTORY);os.fsync(fd);os.close(fd)
`]);
  await importImages(bench);
  const version = (await bench.guest(['sudo', '-n', '/snap/bin/microk8s', 'kubectl', 'version', '-o', 'json'])).stdout.toString();
  assert.equal(JSON.parse(version).serverVersion.gitVersion, 'v' + manifest.vm.microk8sVersion);
  const snaps = (await bench.guest(['snap', 'list', 'microk8s'])).stdout.toString().trim().split('\n');
  assert.equal(snaps.at(-1).trim().split(/\s+/)[2], manifest.vm.microk8sRevision);
  const existingNamespace = await bench.kube(['get', 'namespace', NAMESPACE], { allowFailure: true });
  if (!resume) assert.notEqual(existingNamespace.code, 0, 'Existing namespace is never adopted');
  await bench.apply(foundation.foundation);
  for (const component of ['postgres', 'minio']) await bench.kube(['rollout', 'status', 'deployment/' + component, '--timeout=300s'], { timeout: 330000 });
  await bench.apply(foundation.fixtures);
  await completePreparation(bench, foundation, 'synthetic-fixtures');
}

async function completePreparation(bench, foundation, jobName) {
  const manifest = bench.manifest;
  const deadline = Date.now() + 330000;
  let succeeded = false;
  while (Date.now() < deadline) {
    const job = await bench.kubeJson(['get', 'job', jobName]);
    assert.equal(job.metadata.labels['qualification.infra-sincere/uuid'], manifest.vm.uuid);
    if (job.status.succeeded === 1) { succeeded = true; break; }
    if (job.status.failed > 0 || job.status.conditions?.some((item) => item.type === 'Failed' && item.status === 'True')) break;
    await sleep(2000);
  }
  const logs = await bench.kube(['logs', 'job/' + jobName], { allowFailure: true });
  writeFileSync(join(bench.root, jobName + '.log'), logs.stdout, { mode: 0o600, flag: 'wx' });
  assert.ok(succeeded, 'Synthetic fixture Job failed; inspect its private log');
  const seedResult = logs.stdout.toString().split('\n').flatMap((line) => { try { const value = JSON.parse(line); return value.status === 'seeded' ? [value] : []; } catch { return []; } });
  assert.equal(seedResult.length, 1); assert.equal(seedResult[0].campaignId, manifest.vm.uuid);
  writeFileSync(join(bench.root, 'fixtures.json'), JSON.stringify(seedResult[0], null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await bench.apply(foundation.applications);
  for (const component of COMPONENTS) await bench.kube(['rollout', 'status', 'deployment/' + component, '--timeout=300s'], { timeout: 330000 });
  await verifyImages(bench);
  bench.event({ event: 'application-prepared', bootId: (await bench.status()).bootId, sourceRevisions: manifest.sourceRevisions, fixtureJob: jobName });
  console.log(JSON.stringify({ status: 'application-prepared', vmUuid: manifest.vm.uuid, namespace: NAMESPACE }));
}

export async function resumeFixtures(bench) {
  const manifest = bench.manifest;
  await bench.waitGuest();
  assert.ok(!existsSync(join(bench.root, 'fixtures.json')), 'A completed fixture campaign is never reseeded');
  const identity = JSON.parse((await bench.guest(['sudo', '-n', 'cat', GUEST_ROOT + '/identity.json'])).stdout.toString());
  assert.deepEqual(identity, { uuid: manifest.vm.uuid, consumer: 'gthf', runId: manifest.runId });
  const namespace = await bench.kubeJson(['get', 'namespace', NAMESPACE]);
  assert.equal(namespace.metadata.labels['qualification.infra-sincere/uuid'], manifest.vm.uuid);
  assert.equal(namespace.metadata.labels['qualification.infra-sincere/run-id'], manifest.runId);
  const deployments = await bench.kubeJson(['get', 'deployments']);
  assert.deepEqual(deployments.items.map((item) => item.metadata.name).sort(), ['minio', 'postgres'], 'No application or business journey may have started');
  const previous = await bench.kubeJson(['get', 'jobs']);
  assert.ok(previous.items.length > 0);
  for (const job of previous.items) {
    assert.ok(job.metadata.name.startsWith('synthetic-fixtures'));
    assert.equal(job.metadata.labels['qualification.infra-sincere/uuid'], manifest.vm.uuid);
    assert.ok(job.status.failed > 0 && !job.status.active && !job.status.succeeded, 'Only failed, stopped fixture jobs may be retried');
  }
  const credentials = JSON.parse(readFileSync(requireRegularPath(join(bench.root, 'credentials.json'), { privateFile: true }), 'utf8'));
  const secret = await bench.kubeJson(['get', 'secret', 'gthf-recovery-secrets']);
  for (const [key, value] of Object.entries(credentials)) assert.equal(Buffer.from(secret.data[key], 'base64').toString(), value);
  const foundation = profile(manifest, credentials, readFileSync(new URL('./seed.mjs', import.meta.url), 'utf8'));
  const jobName = 'synthetic-fixtures-r' + Date.now();
  foundation.fixtures[0].metadata.name = jobName + '-code';
  const job = foundation.fixtures[1]; job.metadata.name = jobName;
  job.spec.template.spec.volumes.find((item) => item.name === 'fixture-code').configMap.name = jobName + '-code';
  job.spec.template.spec.containers[0].env.push({ name: 'GTHF_RECOVERY_SEED_RESUME', value: manifest.vm.uuid });
  await bench.apply(foundation.fixtures);
  bench.event({ event: 'failed-fixture-preparation-retried', fixtureJob: jobName, previousJobs: previous.items.map((item) => item.metadata.name), preservedVolumes: true });
  await completePreparation(bench, foundation, jobName);
}

export async function importImages(bench) {
  const manifest = bench.manifest;
  const importDirectory = '/home/ubuntu/gthf-recovery-import';
  await bench.guest(['mkdir', '-p', '-m', '700', importDirectory]);
  for (const name of ['postgres', 'minio', 'cms', 'frontend']) {
    const archive = manifest.archives[name];
    requireRegularPath(archive.path, { privateFile: true });
    assert.ok(dirname(archive.path).startsWith(bench.root + '/images-'));
    assert.ok(!relative(bench.root, archive.path).startsWith('..'));
    assert.equal(archive.path.split('/').at(-1), name + '.tar');
    assert.equal(await checksum(archive.path), archive.sha256, 'Image archive changed');
    const remote = importDirectory + '/' + name + '.tar';
    await bench.call('guest-put', ['--path', remote, '--timeout', '900'], { input: createReadStream(archive.path), timeout: 930000 });
    const remoteHash = (await bench.guest(['sha256sum', remote])).stdout.toString().split(' ')[0];
    assert.equal(remoteHash, archive.sha256, 'Transferred image checksum differs');
    await bench.guest(['sudo', '-n', '/snap/bin/microk8s', 'ctr', 'images', 'import', '--all-platforms', '--digests', remote], { timeout: 900000 });
    const imported = (await bench.guest(['sudo', '-n', '/snap/bin/microk8s', 'ctr', 'images', 'ls', 'name==' + manifest.images[name].canonicalRef])).stdout.toString().trim().split('\n');
    assert.equal(imported.length, 2, 'The imported candidate must have its canonical immutable name');
    assert.equal(imported[1].trim().split(/\s+/)[2], manifest.images[name].digest, 'Imported OCI root differs from the candidate');
    bench.event({ event: 'image-imported', component: name, digest: manifest.images[name].digest, archiveSha256: archive.sha256 });
    // Only the newly imported transfer archive is removed; persistent stores
    // and the host's immutable evidence stay intact.
    await bench.guest(['rm', '--', remote]);
  }
}

export async function installCandidate(bench) {
  await bench.waitGuest();
  const manifest = bench.manifest;
  const identity = JSON.parse((await bench.guest(['sudo', '-n', 'cat', GUEST_ROOT + '/identity.json'])).stdout.toString());
  assert.deepEqual(identity, { uuid: manifest.vm.uuid, consumer: 'gthf', runId: manifest.runId });
  const fixture = JSON.parse(readFileSync(requireRegularPath(join(bench.root, 'fixtures.json'), { privateFile: true }), 'utf8'));
  assert.equal(fixture.campaignId, manifest.vm.uuid);
  const namespace = await bench.kubeJson(['get', 'namespace', NAMESPACE]);
  assert.equal(namespace.metadata.labels['qualification.infra-sincere/uuid'], manifest.vm.uuid);
  assert.equal(namespace.metadata.labels['qualification.infra-sincere/run-id'], manifest.runId);
  const credentials = JSON.parse(readFileSync(requireRegularPath(join(bench.root, 'credentials.json'), { privateFile: true }), 'utf8'));
  const secret = await bench.kubeJson(['get', 'secret', 'gthf-recovery-secrets']);
  for (const [key, value] of Object.entries(credentials)) assert.equal(Buffer.from(secret.data[key], 'base64').toString(), value);
  for (const name of ['postgres', 'minio']) {
    const dependency = await bench.kubeJson(['get', 'deployment', name]);
    assert.equal(dependency.metadata.labels['qualification.infra-sincere/uuid'], manifest.vm.uuid);
    assert.equal(dependency.spec.template.spec.containers[0].image, manifest.images[name].ref, 'Persistent dependency upgrades require a separate campaign');
  }
  await importImages(bench);
  const foundation = profile(manifest, credentials, readFileSync(new URL('./seed.mjs', import.meta.url), 'utf8'));
  await bench.apply(foundation.applications);
  for (const component of COMPONENTS) await bench.kube(['rollout', 'status', 'deployment/' + component, '--timeout=300s'], { timeout: 330000 });
  await verifyImages(bench);
  bench.event({ event: 'candidate-installed', sourceRevisions: manifest.sourceRevisions, retainedFixtures: true, retainedVolumes: true });
}

export async function quiesceJournalCms(bench, { timeout = 180000, interval = 2000 } = {}) {
  const uuid = bench.manifest.vm.uuid;
  const namespace = await bench.kubeJson(['get', 'namespace', NAMESPACE]);
  assert.equal(namespace.metadata.labels['qualification.infra-sincere/uuid'], uuid);
  assert.equal(namespace.metadata.labels['qualification.infra-sincere/run-id'], bench.manifest.runId);
  const deployments = await bench.kubeJson(['get', 'deployments', '--field-selector=metadata.name=cms']);
  assert.ok(deployments.items.length <= 1, 'Only one identified CMS deployment may be quiesced');
  for (const deployment of deployments.items) {
    assert.equal(deployment.metadata.name, 'cms');
    assert.equal(deployment.metadata.labels['qualification.infra-sincere/uuid'], uuid);
  }
  const pods = await bench.kubeJson(['get', 'pods', '-l', 'app.kubernetes.io/component=cms']);
  for (const pod of pods.items) assert.equal(pod.metadata.labels['qualification.infra-sincere/uuid'], uuid);
  const previousReplicas = deployments.items[0]?.spec.replicas ?? 0;
  if (deployments.items.length) await bench.kube(['scale', 'deployment/cms', '--replicas=0']);
  const deadline = Date.now() + timeout;
  do {
    const current = await bench.kubeJson(['get', 'pods', '-l', 'app.kubernetes.io/component=cms']);
    for (const pod of current.items) assert.equal(pod.metadata.labels['qualification.infra-sincere/uuid'], uuid);
    if (current.items.length === 0) {
      bench.event({ event: 'journal-cms-quiesced', previousReplicas, retainedVolumes: true,
        nextAction: 'install the candidate before application qualification; never restart the older runtime after additive migration' });
      return;
    }
    await sleep(interval);
  } while (Date.now() < deadline);
  throw new Error('The identified CMS did not stop before the journal deadline');
}

export async function checkJournal(bench) {
  await bench.waitGuest();
  const manifest = bench.manifest;
  const credentials = JSON.parse(readFileSync(requireRegularPath(join(bench.root, 'credentials.json'), { privateFile: true }), 'utf8'));
  const secret = await bench.kubeJson(['get', 'secret', 'gthf-recovery-secrets']);
  assert.equal(secret.metadata.labels['qualification.infra-sincere/uuid'], manifest.vm.uuid);
  for (const [key, value] of Object.entries(credentials)) assert.equal(Buffer.from(secret.data[key], 'base64').toString(), value);
  await importImages(bench);
  await quiesceJournalCms(bench);
  const foundation = profile(manifest, credentials, '');
  const job = foundation.fixtures[1];
  const name = 'journal-check-' + manifest.sourceRevisions.cms.slice(0, 12) + '-' + Date.now();
  job.metadata.name = name;
  job.spec.template.spec.containers[0].command = ['node', 'dist/scripts/recovery/check-journal.js'];
  job.spec.template.spec.containers[0].volumeMounts = job.spec.template.spec.containers[0].volumeMounts.filter((item) => item.name !== 'fixture-code');
  job.spec.template.spec.volumes = job.spec.template.spec.volumes.filter((item) => item.name !== 'fixture-code');
  await bench.apply([job]);
  let succeeded = false;
  const deadline = Date.now() + 330000;
  while (Date.now() < deadline) {
    const current = await bench.kubeJson(['get', 'job', name]);
    if (current.status.succeeded === 1) { succeeded = true; break; }
    if (current.status.failed > 0) break;
    await sleep(2000);
  }
  const logs = await bench.kube(['logs', 'job/' + name], { allowFailure: true });
  writeFileSync(join(bench.root, name + '.log'), logs.stdout, { mode: 0o600, flag: 'wx' });
  assert.ok(succeeded, 'The real PostgreSQL journal Job failed; inspect its private log');
  const text = logs.stdout.toString();
  const begin = text.indexOf('{\n  "status": "passed"');
  const end = text.indexOf('\n}', begin);
  assert.ok(begin >= 0 && end > begin, 'Missing actual journal check results');
  const result = JSON.parse(text.slice(begin, end + 2));
  assert.equal(result.campaign, manifest.vm.uuid);
  assert.equal(result.revision, manifest.sourceRevisions.cms);
  assert.ok(result.checks.length >= 7);
  bench.event({ event: 'real-postgres-journal-verified', job: name, ...result, image: manifest.images.cms });
  console.log(JSON.stringify({ status: 'journal-verified', checks: result.checks.length, revision: result.revision }));
}

export async function verifyImages(bench) {
  const cmsImage = bench.manifest.images.cms;
  const cmsConfig = (await bench.guest(['sudo', '-n', '/snap/bin/microk8s', 'ctr', 'content', 'get', cmsImage.runtimeConfigDigest])).stdout;
  assert.equal('sha256:' + createHash('sha256').update(cmsConfig).digest('hex'), cmsImage.runtimeConfigDigest, 'CMS OCI configuration must match its linked digest');
  requireImageRevision(JSON.parse(cmsConfig.toString()), cmsImage.revision, 'cms');
  const pods = await bench.kubeJson(['get', 'pods']);
  const verified = [];
  for (const name of COMPONENTS) {
    const expected = bench.manifest.images[name.startsWith('frontend-') ? 'frontend' : name];
    const matching = pods.items.filter((pod) => pod.metadata.labels?.['app.kubernetes.io/component'] === name && !pod.metadata.deletionTimestamp);
    assert.equal(matching.length, 1, 'Exactly one identified pod per test component');
    const pod = matching[0];
    assert.equal(pod.metadata.labels['qualification.infra-sincere/uuid'], bench.manifest.vm.uuid);
    assert.equal(pod.status.phase, 'Running', 'Candidate pod must be running');
    const containers = pod.spec.containers;
    const initContainers = pod.spec.initContainers ?? [];
    assert.ok(containers.length > 0, 'Candidate runtime container is missing');
    if (name.startsWith('frontend-')) {
      assert.ok(initContainers.some((container) => container.name === 'seed-next-app-cache'), 'Frontend cache initializer is missing');
    }
    const proof = { component: name, podUid: pod.metadata.uid, containers: [], initContainers: [] };
    for (const [specs, statuses, isInit] of [
      [containers, pod.status.containerStatuses ?? [], false],
      [initContainers, pod.status.initContainerStatuses ?? [], true],
    ]) {
      assert.equal(statuses.length, specs.length, 'Every candidate container must have runtime status');
      for (const container of specs) {
        assert.equal(container.image, expected.ref, 'Runtime and initializer references must match the candidate');
        const status = statuses.find((entry) => entry.name === container.name);
        assert.ok(status, 'Candidate container status is missing');
        const runtimeProof = await runtimeImageProof({ image: container.image, imageID: status.imageID, expected },
          async (digest) => (await bench.guest(['sudo', '-n', '/snap/bin/microk8s', 'ctr', 'content', 'get', digest])).stdout);
        if (isInit) assert.equal(status.state?.terminated?.exitCode, 0, 'Cache initializer must finish successfully with the candidate image');
        else assert.ok(status.ready && status.state?.running, 'Candidate container is not running and ready');
        proof[isInit ? 'initContainers' : 'containers'].push({ name: container.name, image: container.image, imageID: status.imageID, runtimeProof });
      }
    }
    verified.push(proof);
  }
  bench.event({ event: 'candidate-images-verified', images: Object.fromEntries(Object.entries(bench.manifest.images).map(([key, value]) => [key, value.digest])), pods: verified });
}
