import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { EVIDENCE_ROOT, GUEST_ROOT, NAMESPACE, publishedImage, requireRegularPath, requireRunId, validateManifest } from './manifest.mjs';
import { infrastructureLock } from './infra-client.mjs';
import { requireImageRevision } from '../../infrastructure/delivery/image-proof.mjs';
import { readBoundedJson, requirePublication } from '../../infrastructure/delivery/publication.mjs';

const { values } = parseArgs({ options: { 'run-id': { type: 'string' }, uuid: { type: 'string' }, 'cms-source': { type: 'string' }, 'published-cms': { type: 'string' }, 'published-frontend': { type: 'string' } }, strict: true });
assert.equal(Boolean(values['published-cms']), Boolean(values['published-frontend']), 'Both exact CI candidates must be supplied together');
const published = Boolean(values['published-cms']);
requireRunId(values['run-id']);
assert.match(values.uuid ?? '', /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
assert.notEqual(infrastructureLock.revision, '0'.repeat(40), 'Infrastructure revision must be reviewed and pinned');
process.umask(0o077);
const root = join(EVIDENCE_ROOT, values['run-id']);
mkdirSync(root, { mode: 0o700, recursive: true }); requireRegularPath(root, { directory: true, privateFile: true });
const front = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cms = requireRegularPath(values['cms-source'], { directory: true });
const git = (source, ...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const revisions = {};
for (const [component, source] of [['cms', cms], ['frontend', front]]) {
  assert.ok(['git@github.com:thedamfr/gthf-' + component + '.git', 'https://github.com/thedamfr/gthf-' + component + '.git'].includes(git(source, 'remote', 'get-url', 'origin')));
  assert.equal(git(source, 'status', '--porcelain', '--untracked-files=normal'), '', 'Candidate must be committed and clean: ' + component);
  revisions[component] = git(source, 'rev-parse', 'HEAD');
}
const suffix = published ? '-published' : '';
const artifacts = join(root, 'images-' + revisions.cms.slice(0, 12) + '-' + revisions.frontend.slice(0, 12) + suffix);
mkdirSync(artifacts, { mode: 0o700 });
async function command(name, argv, cwd) {
  const log = openSync(join(artifacts, name + '.log'), 'wx', 0o600);
  console.log(JSON.stringify({ event: 'started', step: name, at: new Date().toISOString() }));
  try {
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', log, log] });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, name + ' failed; inspect its private build log');
  } finally { closeSync(log); }
  console.log(JSON.stringify({ event: 'completed', step: name, at: new Date().toISOString() }));
}
async function checksum(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
function inspect(ref, revision, component) {
  const data = JSON.parse(execFileSync('sudo', ['-n', 'docker', 'image', 'inspect', ref], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }))[0];
  const reference = ref.includes('@') ? data.RepoDigests?.find((item) => item === ref)
    : data.RepoDigests?.find((item) => item.startsWith(ref.split(':')[0] + '@'));
  assert.ok(reference?.includes('@sha256:'), 'Built image must have an immutable repository digest');
  if (revision) requireImageRevision({ config: data.Config }, revision, component);
  return { ref: reference, digest: reference.split('@')[1], imageId: data.Id, ...(revision ? { revision } : {}), ...(component === 'cms' ? { mediaRecoveryVersion: data.Config.Labels['io.gthf.media-recovery'], mediaBatchRecoveryVersion: data.Config.Labels['io.gthf.media-batch-recovery'] } : {}) };
}
const dependencyPath = join(root, 'dependency-images.json');
let dependencies;
if (existsSync(dependencyPath)) {
  requireRegularPath(dependencyPath, { privateFile: true });
  dependencies = JSON.parse(readFileSync(dependencyPath, 'utf8'));
  assert.equal(dependencies.schemaVersion, 1);
  assert.equal(dependencies.runId, values['run-id']);
  assert.equal(dependencies.vmUuid, values.uuid);
  for (const name of ['postgres', 'minio']) {
    const archive = dependencies.archives[name];
    requireRegularPath(archive.path, { privateFile: true });
    assert.ok(!relative(root, archive.path).startsWith('..'), 'Dependency archive belongs to another campaign');
    assert.equal(statSync(archive.path).size, archive.bytes);
    assert.equal(await checksum(archive.path), archive.sha256, 'Frozen dependency archive changed');
  }
}
const images = dependencies ? structuredClone(dependencies.images) : {};
const archives = dependencies ? structuredClone(dependencies.archives) : {};
const frozen = {};
for (const [component, source] of [['cms', cms], ['frontend', front]]) {
  const directory = join(artifacts, component + '-source');
  mkdirSync(directory, { mode: 0o700 });
  const archive = join(artifacts, component + '-source.tar');
  execFileSync('git', ['-C', source, 'archive', '--format=tar', '--output=' + archive, revisions[component]]);
  execFileSync('tar', ['--extract', '--file=' + archive, '--directory=' + directory]);
  frozen[component] = directory;
}
const publications = {};
for (const component of ['cms', 'frontend']) {
  if (published) {
    const path = requireRegularPath(values['published-' + component], { privateFile: true });
    assert.equal(dirname(path), root, 'Publication proof must belong to this campaign');
    assert.ok(statSync(path).size <= 262144);
    const candidate = JSON.parse(readFileSync(path, 'utf8'));
    const reference = publishedImage(candidate, component, revisions[component], revisions.frontend);
    const response = await fetch('https://api.github.com/repos/thedamfr/gthf-' + component + '/actions/runs/' + candidate.publication.runId,
      { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'gthf-recovery-qualification' }, redirect: 'error', signal: AbortSignal.timeout(20000) });
    assert.ok(response.ok, 'Exact candidate CI proof is unavailable');
    const workflow = await readBoundedJson(response);
    requirePublication(candidate.publication, workflow, component);
    publications[component] = { ...candidate.publication, candidateSha256: await checksum(path), workflowUrl: workflow.html_url };
    await command('pull-' + component, ['sudo', '-n', 'docker', 'pull', reference]);
    images[component] = inspect(reference, revisions[component], component);
  } else {
    const tag = 'gthf-' + component + ':recovery-' + revisions[component];
    await command('build-' + component, ['sudo', '-n', 'docker', 'buildx', 'build', '--load', '--tag', tag, '--build-arg', 'GTHF_REVISION=' + revisions[component], '.'], frozen[component]);
    images[component] = inspect(tag, revisions[component], component);
  }
}
if (!dependencies) {
  images.postgres = inspect('gthf-postgres@sha256:350a73c4b179649dbf542a425f01e37e24d3129432c61a9fd86b7675d924a1b0');
  const minioDirectory = join(artifacts, 'minio-context'); mkdirSync(minioDirectory, { mode: 0o700 });
  const minioVersion = 'RELEASE.2025-09-07T16-13-09Z';
  const minioSha = '7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f';
  await command('download-minio', ['curl', '--fail', '--location', '--max-time', '180', '--output', join(minioDirectory, 'minio'), 'https://github.com/minio/minio/releases/download/' + minioVersion + '/minio.linux-amd64.' + minioVersion]);
  assert.equal(await checksum(join(minioDirectory, 'minio')), minioSha, 'Official MinIO binary checksum mismatch');
  writeFileSync(join(minioDirectory, 'Dockerfile'), readFileSync(join(frozen.frontend, 'scripts/recovery/Dockerfile.minio')), { mode: 0o600 });
  const minioTag = 'gthf-recovery-minio:' + minioSha.slice(0, 16);
  await command('build-minio', ['sudo', '-n', 'docker', 'buildx', 'build', '--load', '--tag', minioTag, '.'], minioDirectory);
  images.minio = { ...inspect(minioTag), upstreamVersion: minioVersion, upstreamSha256: minioSha };
}
for (const [name, image] of Object.entries(images)) {
  if (dependencies && ['postgres', 'minio'].includes(name)) continue;
  const path = join(artifacts, name + '.tar');
  const original = join(artifacts, name + '-docker.tar');
  await command('export-' + name, ['sudo', '-n', 'docker', 'image', 'save', '--output', original, image.ref]);
  // docker writes as root. Read permission stays private; assign only this
  // newly created archive to the invoking account for the transport process.
  execFileSync('sudo', ['-n', 'chown', String(process.getuid()) + ':' + String(process.getgid()), original]);
  const graph = JSON.parse(execFileSync('python3', ['-B', join(frozen.frontend, 'scripts/recovery/oci-archive.py'), original, path, image.ref], { encoding: 'utf8' }));
  Object.assign(image, graph);
  archives[name] = { path, sha256: await checksum(path), bytes: statSync(path).size };
}
const manifest = validateManifest({ schemaVersion: 1, target: 'vm', namespace: NAMESPACE, consumer: 'gthf', runId: values['run-id'],
  vm: { uuid: values.uuid, host: 'game-prod-ovh-gra', hostname: 'infra-qualification-vm', service: 'infra-qualification-vm.service', microk8sVersion: '1.35.6', microk8sRevision: '9072' },
  guestRoot: GUEST_ROOT, database: 'gthf_recovery_' + values.uuid.replaceAll('-', ''), bucket: 'gthf-recovery-' + values.uuid,
  sourceRevisions: { ...revisions, infra: infrastructureLock.revision }, images, archives,
  builtAt: new Date().toISOString(), ...(published ? { publications } : {}),
}, { target: 'vm', infraRevision: infrastructureLock.revision });
if (!dependencies) {
  writeFileSync(dependencyPath, JSON.stringify({ schemaVersion: 1, runId: values['run-id'], vmUuid: values.uuid,
    images: { postgres: images.postgres, minio: images.minio }, archives: { postgres: archives.postgres, minio: archives.minio },
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
const path = join(root, 'manifest-' + revisions.cms.slice(0, 12) + '-' + revisions.frontend.slice(0, 12) + suffix + '.json');
assert.ok(!existsSync(path), 'A previous campaign manifest is never overwritten');
writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ status: 'images-prepared', manifest: path, revisions: manifest.sourceRevisions, images }));
