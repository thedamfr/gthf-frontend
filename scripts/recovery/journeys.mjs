import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import sharp from 'sharp';
import { uploadPng } from '../../infrastructure/delivery/upload-fixture.mjs';
import { GUEST_ROOT, requireRegularPath } from './manifest.mjs';
import { COMPONENTS, PORTS, LOCAL_PORTS } from './profile.mjs';
import { verifyImages } from './prepare-vm.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MODEL = '/content-manager/collection-types/api::article.article';
const DEADLINE = 300000;
const derivativeFixture = () => sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 37, g: 112, b: 168 } } }).png().toBuffer();

export class RecoveryJourneys {
  constructor(bench) {
    this.bench = bench;
    const path = requireRegularPath(join(bench.root, 'credentials.json'), { privateFile: true });
    this.credentials = JSON.parse(readFileSync(path, 'utf8'));
    this.fixtures = JSON.parse(readFileSync(join(bench.root, 'fixtures.json'), 'utf8'));
    this.results = [];
    this.acknowledged = [];
    this.cutCount = 0;
    this.mediaChecksums = new Map();
    this.obsoleteMedia = [];
  }
  async tunnels() {
    for (const name of Object.keys(PORTS)) await this.bench.openTunnel(name, LOCAL_PORTS[name], PORTS[name]);
  }
  async request(component, path, { token, json, allow = [], timeout = 30000, ...options } = {}) {
    assert.ok(Object.hasOwn(LOCAL_PORTS, component)); assert.ok(path.startsWith('/') && !path.startsWith('//'));
    const response = await fetch('http://127.0.0.1:' + LOCAL_PORTS[component] + path, {
      ...options, redirect: options.redirect ?? 'manual', signal: AbortSignal.timeout(timeout),
      headers: { 'User-Agent': 'gthf-isolated-recovery', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    });
    assert.ok(response.ok || allow.includes(response.status), 'Unexpected isolated HTTP status ' + response.status + ' for ' + component + path.split('?')[0]);
    return response;
  }
  async admin(path, options = {}) {
    const response = await this.request('cms', path, { token: this.adminToken, ...options });
    return response.status === 204 ? null : response.json();
  }
  async login() {
    const session = await (await this.request('cms', '/admin/login', { method: 'POST', json: { email: 'recovery@gthf.invalid', password: this.credentials.RECOVERY_ADMIN_PASSWORD } })).json();
    this.adminToken = session.data?.token; assert.ok(this.adminToken);
    const other = await (await this.request('cms', '/admin/login', { method: 'POST', json: { email: 'other-recovery@gthf.invalid', password: this.credentials.RECOVERY_OTHER_ADMIN_PASSWORD } })).json();
    this.otherToken = other.data?.token; assert.ok(this.otherToken);
  }
  async eventually(label, check, { timeout = DEADLINE, interval = 2000 } = {}) {
    const started = Date.now(); let last;
    while (Date.now() - started < timeout) {
      try { const value = await check(); if (value) return { value, elapsedMs: Date.now() - started }; }
      catch (error) { last = error; }
      await sleep(interval);
    }
    throw new Error(label + ' exceeded ' + timeout + 'ms' + (last ? ' (' + last.name + ')' : ''));
  }
  async scenario(name, action) {
    const started = Date.now();
    this.bench.event({ event: 'golden-journey-started', name });
    try {
      const details = await action();
      const result = { name, status: 'passed', durationMs: Date.now() - started, ...details };
      this.results.push(result); this.bench.event({ event: 'golden-journey-result', ...result });
      console.log(JSON.stringify(result));
    } catch (error) {
      const result = { name, status: 'failed', durationMs: Date.now() - started, errorType: error.name };
      this.results.push(result); this.bench.event({ event: 'golden-journey-result', ...result });
      throw error;
    }
  }
  async dependencies() {
    await this.eventually('Durable dependencies', async () => {
      const pods = await this.bench.kubeJson(['get', 'pods']);
      return ['postgres', 'minio'].every((name) => pods.items.some((pod) => pod.metadata.labels?.['app.kubernetes.io/component'] === name && !pod.metadata.deletionTimestamp && pod.status.containerStatuses?.[0]?.ready));
    });
    const returnedAt = Date.now();
    this.bench.event({ event: 'dependencies-returned', atMilliseconds: returnedAt });
    return returnedAt;
  }
  async applications() {
    await this.tunnels();
    await this.eventually('CMS release readiness', async () => {
      const response = await this.request('cms', '/api/release', { allow: [503], timeout: 6000 });
      return response.ok;
    });
    await this.login();
  }
  async receipt(key, expected) {
    assert.match(key, UUID);
    return this.eventually('Durable receipt ' + expected, async () => {
      const result = await this.admin('/upload/recovery/operations/' + key);
      return result.status === expected ? result : false;
    });
  }
  async operationCount(key) {
    assert.match(key, UUID);
    const response = await this.bench.kube(['exec', 'deployment/postgres', '--', 'psql', '-U', 'gthf_recovery', '-d', this.bench.manifest.database, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', "SELECT count(*) FROM gthf_media_operations WHERE key='" + key + "'"]);
    return Number(response.stdout.toString().trim());
  }
  async fileCount(id) {
    assert.ok(Number.isSafeInteger(id));
    const response = await this.bench.kube(['exec', 'deployment/postgres', '--', 'psql', '-U', 'gthf_recovery', '-d', this.bench.manifest.database, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT count(*) FROM files WHERE id=' + id]);
    return Number(response.stdout.toString().trim());
  }
  async operationObjects(key) {
    assert.match(key, UUID);
    const result = await this.bench.kube(['exec', 'deployment/postgres', '--', 'psql', '-U', 'gthf_recovery', '-d', this.bench.manifest.database, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', "SELECT manifest->'objects' FROM gthf_media_operations WHERE key='" + key + "'"]);
    const objects = JSON.parse(result.stdout.toString().trim());
    assert.ok(Array.isArray(objects) && objects.length > 0);
    for (const object of objects) {
      assert.match(object.key, /^[a-zA-Z0-9/_.-]+$/); assert.ok(!object.key.includes('..'));
      assert.match(object.sha256, /^[a-f0-9]{64}$/); assert.ok(object.bytes > 0);
    }
    return objects;
  }
  async assertObjects(objects) {
    for (const object of objects) {
      const response = await this.request('minio', '/' + this.bench.manifest.bucket + '/' + object.key);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.length, object.bytes); assert.equal(sha256(bytes), object.sha256);
    }
  }
  async upload(key, { id, bytes = uploadPng, name = 'recovery.png', fileInfo } = {}) {
    const body = new FormData(); body.set('files', new Blob([bytes], { type: 'image/png' }), name);
    if (fileInfo) body.set('fileInfo', JSON.stringify(fileInfo));
    return this.admin('/upload' + (id ? '?id=' + id : ''), { method: 'POST', headers: { 'Idempotency-Key': key }, body, timeout: 120000 });
  }
  async gate(point, key, objectIndex) {
    assert.match(key, UUID);
    const value = { campaignId: this.bench.manifest.vm.uuid, key, point, ...(objectIndex !== undefined ? { objectIndex } : {}) };
    await this.bench.guest(['sudo', '-n', 'python3', '-c', `import pathlib,json,sys,os
p=pathlib.Path('${GUEST_ROOT}/faults')
for name in ('gate.json','claimed.json','observed.json','release.json'):
 f=p/name
 if f.exists(): f.unlink()
f=p/'gate.json';data=sys.stdin.buffer.read()
with f.open('xb') as out: out.write(data);out.flush();os.fsync(out.fileno())
f.chmod(0o600);os.chown(f,1000,1000)
fd=os.open(p,os.O_DIRECTORY);os.fsync(fd);os.close(fd)
`], { input: JSON.stringify(value) });
  }
  async observed(point, key) {
    return (await this.eventually('Observable media phase ' + point, async () => {
      const result = await this.bench.guest(['sudo', '-n', 'cat', GUEST_ROOT + '/faults/observed.json'], { allowFailure: true });
      if (result.code !== 0) return false;
      const value = JSON.parse(result.stdout.toString());
      if (value.campaignId !== this.bench.manifest.vm.uuid || value.key !== key || value.point !== point) return false;
      this.bench.event({ event: 'media-phase-observed', ...value }); return value;
    })).value;
  }
  async signal(component, signal = 'SIGKILL') {
    assert.ok(COMPONENTS.includes(component)); assert.ok(['SIGKILL', 'SIGSTOP', 'SIGCONT'].includes(signal));
    const pods = await this.bench.kubeJson(['get', 'pods', '-l', 'app.kubernetes.io/component=' + component]);
    assert.equal(pods.items.filter((pod) => !pod.metadata.deletionTimestamp).length, 1);
    const pod = pods.items.find((pod) => !pod.metadata.deletionTimestamp);
    assert.equal(pod.metadata.labels['qualification.infra-sincere/uuid'], this.bench.manifest.vm.uuid);
    const container = pod.status.containerStatuses[0].containerID;
    assert.match(container, /^containerd:\/\/[a-f0-9]{64}$/);
    await this.bench.guest(['sudo', '-n', '/snap/bin/microk8s', 'ctr', 'tasks', 'kill', '--signal', signal, container.slice('containerd://'.length)]);
    this.bench.event({ event: 'real-container-signal', component, signal, podUid: pod.metadata.uid, containerId: container });
  }
  async scale(component, replicas) {
    assert.ok(COMPONENTS.includes(component)); assert.ok([0, 1].includes(replicas));
    await this.bench.kube(['scale', 'deployment/' + component, '--replicas=' + replicas]);
  }
  async cut(label) {
    this.cutCount += 1;
    await this.bench.powerCut(label);
    const returnedAt = await this.dependencies();
    await this.applications();
    return returnedAt;
  }
  async assertArticle() {
    const data = await this.admin(MODEL + '/' + this.fixtures.article + '?status=draft');
    assert.equal((data.data ?? data).title, this.acknowledgedTitle);
  }
  async assertMedia(result, { width = 1, height = 1 } = {}) {
    const media = Array.isArray(result) ? result[0] : result;
    assert.ok(Number.isSafeInteger(media?.id)); assert.ok(media.url);
    assert.equal(media.width, width); assert.equal(media.height, height);
    for (const object of [media, ...Object.values(media.formats ?? {})]) {
      const url = new URL(object.url);
      assert.equal(url.origin, 'http://minio:9000');
      const response = await this.request('minio', url.pathname);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
      assert.equal(bytes.readUInt32BE(16), object.width); assert.equal(bytes.readUInt32BE(20), object.height);
      // Compare the bytes actually published by Strapi, including derivatives.
      const digest = sha256(bytes);
      if (this.mediaChecksums.has(object.url)) assert.equal(digest, this.mediaChecksums.get(object.url));
      else this.mediaChecksums.set(object.url, digest);
    }
    assert.equal(await this.fileCount(media.id), 1);
    return media;
  }
  async acknowledgement() {
    const denied = await this.request('cms', '/admin/users/me', { allow: [401] }); assert.equal(denied.status, 401);
    const preview = await this.request('frontendA', '/api/preview?url=/article/recovery-published&status=draft', { allow: [401] }); assert.equal(preview.status, 401);
    const legacyBody = new FormData(); legacyBody.set('files', new Blob([uploadPng], { type: 'image/png' }), 'legacy-admin.png');
    const legacy = await this.request('cms', '/upload', { method: 'POST', token: this.adminToken, body: legacyBody, allow: [409] });
    assert.equal(legacy.status, 409); assert.equal((await legacy.json()).error.name, 'ADMIN_RELOAD_REQUIRED');
    this.acknowledgedTitle = 'Modification acquittée ' + this.bench.manifest.vm.uuid;
    await this.admin(MODEL + '/' + this.fixtures.article, { method: 'PUT', json: { title: this.acknowledgedTitle } });
    await this.admin(MODEL + '/' + this.fixtures.article + '/actions/publish', { method: 'POST', json: {} });
    await this.assertArticle();
    this.bench.event({ event: 'publication-acknowledged', documentId: this.fixtures.article, titleHash: sha256(this.acknowledgedTitle) });
    const key = randomUUID(); const media = await this.assertMedia(await this.upload(key));
    const receipt = (await this.receipt(key, 'committed')).value;
    assert.equal(receipt.result[0].id, media.id);
    const foreign = await this.request('cms', '/upload/recovery/operations/' + key, { token: this.otherToken, allow: [404] }); assert.equal(foreign.status, 404);
    const anonymous = await this.request('cms', '/upload/recovery/operations/' + key, { allow: [401] }); assert.equal(anonymous.status, 401);
    const replay = await this.upload(key); assert.equal(replay[0].id, media.id); assert.equal(await this.operationCount(key), 1);
    const current = await this.admin('/admin/users/me');
    const user = current.data ?? current;
    const originalRoles = user.roles.map((role) => role.id);
    const roleResult = await this.admin('/admin/roles', { method: 'POST', token: this.otherToken, json: { name: 'Recovery no media ' + randomUUID().slice(0, 8), description: 'Synthetic rights revocation fixture' } });
    const role = roleResult.data ?? roleResult;
    try {
      await this.admin('/admin/users/' + user.id, { method: 'PUT', token: this.otherToken, json: { roles: [role.id] } });
      const deniedReceipt = await this.request('cms', '/upload/recovery/operations/' + key, { token: this.adminToken, allow: [403] });
      assert.equal(deniedReceipt.status, 403, 'A durable receipt must obey the actor’s current permissions');
      const deniedUpload = new FormData(); deniedUpload.set('files', new Blob([uploadPng], { type: 'image/png' }), 'recovery.png');
      const deniedReplay = await this.request('cms', '/upload', { method: 'POST', token: this.adminToken, headers: { 'Idempotency-Key': key }, body: deniedUpload, allow: [403] });
      assert.equal(deniedReplay.status, 403, 'Replay must not bypass revoked upload permissions');
    } finally {
      await this.admin('/admin/users/' + user.id, { method: 'PUT', token: this.otherToken, json: { roles: originalRoles } });
      await this.login();
    }
    this.acknowledged.push({ key, media });
    return { publicationPersisted: true, receiptOwnerVerified: true, currentRightsRechecked: true, retryUnique: true };
  }
  async interruptedUpload() {
    const key = randomUUID(); await this.gate('after-journal', key);
    const request = this.upload(key).then(() => ({ succeeded: true }), () => ({ succeeded: false }));
    await this.observed('after-journal', key); await this.signal('cms');
    assert.equal((await request).succeeded, false);
    await this.applications();
    const receipt = (await this.receipt(key, 'interrupted')).value; assert.equal(receipt.retryable, true);
    const media = await this.assertMedia(await this.upload(key));
    assert.equal(await this.operationCount(key), 1);
    return { key, interruptedExplicitly: true, retriedMediaId: media.id };
  }
  async revokedAuthorization() {
    const current = await this.admin('/admin/users/me');
    const user = current.data ?? current;
    const roles = user.roles.map((role) => role.id);
    const created = await this.admin('/admin/roles', { method: 'POST', token: this.otherToken,
      json: { name: 'Recovery revoked ' + randomUUID().slice(0, 8), description: 'Synthetic interruption with revoked permissions' } });
    const role = created.data ?? created;
    const key = randomUUID(); await this.gate('before-commit', key);
    const request = this.upload(key).then(() => true, () => false);
    await this.observed('before-commit', key);
    const objects = await this.operationObjects(key); await this.assertObjects(objects);
    let rtoMs;
    try {
      await this.admin('/admin/users/' + user.id, { method: 'PUT', token: this.otherToken, json: { roles: [role.id] } });
      const interruptedAt = Date.now(); await this.signal('cms');
      assert.equal(await request, false); await this.applications();
      await this.eventually('Revoked actor cannot commit during autonomous recovery', async () => {
        const value = await this.bench.kube(['exec', 'deployment/postgres', '--', 'psql', '-U', 'gthf_recovery', '-d', this.bench.manifest.database, '-At', '-c',
          "SELECT state||':'||coalesce(failure,'') FROM gthf_media_operations WHERE key='" + key + "'"]);
        return value.stdout.toString().trim() === 'failed:AUTHORIZATION_REVOKED';
      });
      rtoMs = Date.now() - interruptedAt; assert.ok(rtoMs <= DEADLINE);
      const files = await this.bench.kube(['exec', 'deployment/postgres', '--', 'psql', '-U', 'gthf_recovery', '-d', this.bench.manifest.database, '-At', '-c',
        "SELECT count(*) FROM files f JOIN gthf_media_operations o ON o.key='" + key + "' WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(o.manifest->'files') p WHERE p->'values'->>'hash'=f.hash)"]);
      assert.equal(Number(files.stdout.toString().trim()), 0);
      await this.eventually('Objects of the revoked operation are cleaned automatically', async () => {
        for (const object of objects) if ((await this.request('minio', '/' + this.bench.manifest.bucket + '/' + object.key, { allow: [404] })).status !== 404) return false;
        return true;
      });
    } finally {
      await this.admin('/admin/users/' + user.id, { method: 'PUT', token: this.otherToken, json: { roles } });
      await this.login();
    }
    const receipt = (await this.receipt(key, 'failed')).value;
    assert.equal(receipt.error, 'AUTHORIZATION_REVOKED'); assert.equal(receipt.retryable, false);
    await assert.rejects(this.upload(key)); assert.equal(await this.operationCount(key), 1);
    return { key, rtoMs, currentRightsCheckedDuringRecovery: true, noFileCommitted: true, objectsCleaned: objects.length, terminalReplayPreserved: true };
  }
  async completeUploadPowerCut() {
    const key = randomUUID(); await this.gate('before-commit', key);
    const request = this.upload(key).then(() => ({ succeeded: true }), () => ({ succeeded: false }));
    await this.observed('before-commit', key);
    const returnedAt = await this.cut('upload-storage-durable-before-sql');
    assert.equal((await request).succeeded, false);
    const receipt = (await this.receipt(key, 'committed')).value;
    const rtoMs = Date.now() - returnedAt; assert.ok(rtoMs <= DEADLINE);
    const media = await this.assertMedia(receipt.result);
    assert.equal((await this.upload(key))[0].id, media.id); assert.equal(await this.operationCount(key), 1);
    await this.assertArticle();
    for (const acknowledgement of this.acknowledged) await this.assertMedia((await this.receipt(acknowledgement.key, 'committed')).value.result);
    return { key, rtoMs, durableObjectRecovered: true, acknowledgedWritesPreserved: true };
  }
  async partialDerivativeUpload() {
    const bytes = await derivativeFixture();
    const key = randomUUID(); await this.gate('after-object', key, 0);
    const request = this.upload(key, { bytes, name: 'recovery-derivatives.png' }).then(() => true, () => false);
    await this.observed('after-object', key);
    const originalObjects = await this.operationObjects(key);
    assert.ok(originalObjects.length >= 3, 'The interruption must leave a genuinely incomplete multi-object upload');
    await this.assertObjects(originalObjects.slice(0, 1));
    await this.signal('cms'); assert.equal(await request, false); await this.applications();
    await this.receipt(key, 'interrupted');
    await this.eventually('Incomplete upload objects cleaned automatically', async () => {
      for (const object of originalObjects) if ((await this.request('minio', '/' + this.bench.manifest.bucket + '/' + object.key, { allow: [404] })).status !== 404) return false;
      return true;
    });
    const result = await this.upload(key, { bytes, name: 'recovery-derivatives.png' });
    const media = await this.assertMedia(result, { width: 1200, height: 800 });
    assert.ok(Object.keys(media.formats).length >= 2);
    const retried = await this.operationObjects(key); await this.assertObjects(retried);
    assert.ok(retried.every((object) => !originalObjects.some((old) => old.key === object.key)));
    assert.equal(await this.operationCount(key), 1);
    return { key, originalObjects: originalObjects.length, finalObjects: retried.length, partialObjectsRemoved: true, derivativesVerified: true };
  }
  async lateDependenciesAndSecondCrash() {
    const key = randomUUID(); await this.gate('before-commit', key);
    const request = this.upload(key).then(() => false, () => true);
    await this.observed('before-commit', key);
    await this.signal('cms');
    await this.scale('postgres', 0); await this.scale('minio', 0);
    await request;
    await this.gate('before-commit', key);
    await sleep(20000);
    await this.scale('postgres', 1);
    await this.bench.kube(['rollout', 'status', 'deployment/postgres', '--timeout=180s'], { timeout: 200000 });
    await sleep(20000);
    await this.scale('minio', 1);
    await this.dependencies(); await this.applications();
    await this.observed('before-commit', key);
    const returnedAt = await this.cut('second-crash-during-automatic-recovery');
    const receipt = (await this.receipt(key, 'committed')).value;
    const rtoMs = Date.now() - returnedAt; assert.ok(rtoMs <= DEADLINE);
    await this.assertMedia(receipt.result); assert.equal(await this.operationCount(key), 1);
    return { key, rtoMs, postgresDelayMs: 20000, s3AdditionalDelayMs: 20000, secondCrashDuringRecovery: true };
  }
  async replaceAfterCommit() {
    const original = await this.assertMedia(await this.upload(randomUUID(), { bytes: await derivativeFixture() }), { width: 1200, height: 800 });
    assert.ok(Object.keys(original.formats).length >= 2);
    const key = randomUUID(); await this.gate('after-commit', key);
    const request = this.upload(key, { id: original.id }).then(() => false, () => true);
    await this.observed('after-commit', key);
    const returnedAt = await this.cut('replace-committed-response-lost');
    assert.equal(await request, true);
    const receipt = (await this.receipt(key, 'committed')).value;
    const rtoMs = Date.now() - returnedAt; assert.ok(rtoMs <= DEADLINE);
    const replaced = await this.assertMedia(receipt.result);
    assert.equal(replaced.id, original.id); assert.notEqual(replaced.url, original.url);
    const replay = await this.assertMedia(await this.upload(key, { id: original.id })); assert.equal(replay.id, original.id); assert.equal(replay.url, replaced.url);
    assert.equal(await this.operationCount(key), 1); await this.assertArticle();
    await this.assertMedia(original, { width: 1200, height: 800 });
    const retention = await this.bench.kube(['exec', 'deployment/postgres', '--', 'psql', '-U', 'gthf_recovery', '-d', this.bench.manifest.database, '-At', '-c', "SELECT extract(epoch from(c.not_before-o.updated_at))*1000 FROM gthf_media_cleanup c JOIN gthf_media_operations o ON o.key=c.operation_key WHERE o.key='" + key + "'"]);
    assert.ok(Number(retention.stdout.toString().trim()) >= 600000, 'The durable cleanup schedule must retain objects for the real public cache TTLs');
    for (const object of [original, ...Object.values(original.formats)]) this.obsoleteMedia.push({ url: object.url, replacedAt: Date.now() });
    return { key, rtoMs, immutableReplacement: true, lostResponseReplayed: true };
  }
  async deletion() {
    const original = await this.assertMedia(await this.upload(randomUUID(), { bytes: await derivativeFixture() }), { width: 1200, height: 800 });
    const objects = [original, ...Object.values(original.formats)]; assert.ok(objects.length >= 3);
    const key = randomUUID();
    await this.gate('during-cleanup', key);
    await this.admin('/upload/files/' + original.id, { method: 'DELETE', headers: { 'Idempotency-Key': key } });
    await this.observed('during-cleanup', key);
    let remainingBeforeKill = 0;
    for (const object of objects) if ((await this.request('minio', new URL(object.url).pathname, { allow: [404] })).ok) remainingBeforeKill += 1;
    assert.ok(remainingBeforeKill > 0 && remainingBeforeKill < objects.length, 'The crash must interrupt a partially completed object cleanup');
    await this.signal('cms'); await this.applications();
    await this.receipt(key, 'committed'); assert.equal(await this.fileCount(original.id), 0);
    await this.admin('/upload/files/' + original.id, { method: 'DELETE', headers: { 'Idempotency-Key': key } });
    await this.eventually('All deleted image objects cleaned after the real crash', async () => {
      for (const object of objects) if ((await this.request('minio', new URL(object.url).pathname, { allow: [404] })).status !== 404) return false;
      const pending = await this.bench.kube(['exec', 'deployment/postgres', '--', 'psql', '-U', 'gthf_recovery', '-d', this.bench.manifest.database, '-At', '-c', "SELECT count(*) FROM gthf_media_cleanup WHERE operation_key='" + key + "'"]);
      return Number(pending.stdout.toString().trim()) === 0;
    });
    assert.equal(await this.operationCount(key), 1);
    return { key, objects: objects.length, remainingBeforeKill, cleanupTaskRemovedAfterResume: true, referenceRemovedBeforeCleanup: true, deleteReplayUnique: true };
  }
  async interruptedPublication() {
    const slug = 'recovery-interrupted-' + randomUUID();
    const created = await this.admin(MODEL, { method: 'POST', json: {
      title: 'Brouillon acquitté avant interruption', slug, description: 'Qualification de la transaction.',
      author: { connect: [{ documentId: (await this.request('cms', '/api/authors', { token: this.credentials.STRAPI_API_TOKEN }).then((response) => response.json())).data[0].documentId }] },
      category: { connect: [{ documentId: (await this.request('cms', '/api/categories', { token: this.credentials.STRAPI_API_TOKEN }).then((response) => response.json())).data[0].documentId }] },
    } });
    const documentId = (created.data ?? created).documentId; assert.ok(documentId);
    const sql = (...args) => this.bench.kube(['exec', 'deployment/postgres', '--', 'psql', '-U', 'gthf_recovery', '-d', this.bench.manifest.database, '-tA', '-v', 'ON_ERROR_STOP=1', ...args]);
    for (const operation of ['edit', 'publish']) {
      const lock = sql('-c', 'BEGIN; LOCK TABLE articles IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(25); ROLLBACK;');
      await this.eventually('Publication table locked by the fixture', async () => Number((await sql('-c', "SELECT count(*) FROM pg_locks WHERE relation='articles'::regclass AND mode='AccessExclusiveLock' AND granted")).stdout.toString().trim()) > 0);
      const request = this.admin(MODEL + '/' + documentId + (operation === 'publish' ? '/actions/publish' : ''), { method: operation === 'publish' ? 'POST' : 'PUT', json: operation === 'publish' ? {} : { title: 'Cette édition ne doit pas être acquittée' }, timeout: 60000 }).then(() => true, () => false);
      await this.eventually('CMS transaction waiting on the real database', async () => Number((await sql('-c', "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%articles%'")).stdout.toString().trim()) > 0, { timeout: 15000 });
      await this.signal('cms'); assert.equal(await request, false);
      await lock; await this.applications();
      const draft = await this.admin(MODEL + '/' + documentId + '?status=draft');
      assert.equal((draft.data ?? draft).title, 'Brouillon acquitté avant interruption');
      const published = await (await this.request('cms', '/api/articles?status=published&filters[slug][$eq]=' + slug, { token: this.credentials.STRAPI_API_TOKEN })).json();
      assert.equal(published.data.length, 0, 'Interrupted publication must not expose the draft');
    }
    await this.admin(MODEL + '/' + documentId + '/actions/publish', { method: 'POST', json: {} });
    const published = await (await this.request('cms', '/api/articles?status=published&filters[slug][$eq]=' + slug, { token: this.credentials.STRAPI_API_TOKEN })).json();
    assert.equal(published.data.length, 1);
    return { interruptedEditRolledBack: true, interruptedPublicationHidden: true, retryPublishedExactlyOnce: true };
  }
  async frontend() {
    const routes = ['/article/recovery-published', '/chapitres/recovery-chapter', '/itineraires-velo', '/itineraires-velo/recovery-itinerary', '/itineraires-velo/recovery-itinerary/gpx', '/itineraires-velo/recovery-itinerary/geometry'];
    const expectedText = (path) => path.startsWith('/article/') ? this.acknowledgedTitle : path.startsWith('/chapitres/') ? 'Chapitre de qualification' : 'Ville synthétique A';
    const warmed = new Map();
    for (const path of routes) {
      const response = await this.request('frontendA', path); const body = await response.text();
      if (path.endsWith('/gpx')) assert.ok(body.includes('<gpx') && body.includes('<trkpt'));
      else if (path.endsWith('/geometry')) assert.ok(JSON.parse(body).sequences[0].coordinates.length >= 2);
      else {
        assert.ok(body.includes(expectedText(path)), 'Warm-up must contain the expected business content');
        if (path.startsWith('/itineraires-velo')) assert.ok(body.includes('Ville synthétique B') && !body.includes('Aucun itinéraire publié'));
      }
      warmed.set(path, body);
    }
    const preview = await this.request('frontendA', '/api/preview?' + new URLSearchParams({ url: '/article/recovery-published', status: 'draft', secret: this.credentials.PREVIEW_SECRET }), { allow: [302, 307] });
    const cookies = preview.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
    assert.ok(cookies.includes('__prerender_bypass='));
    await this.request('frontendA', '/article/recovery-published', { headers: { Cookie: cookies } });
    await this.scale('cms', 0);
    await this.eventually('CMS stopped', async () => {
      const pods = await this.bench.kubeJson(['get', 'pods', '-l', 'app.kubernetes.io/component=cms']);
      return pods.items.length === 0;
    });
    const serving = await this.request('frontendA', '/api/serving'); assert.equal(serving.status, 200);
    const strict = await this.request('frontendA', '/api/ready', { allow: [503] }); assert.equal(strict.status, 503);
    // Use the real 60s/300s TTLs: an immediate hit would not qualify stale fallback.
    await sleep(301000);
    for (const object of this.obsoleteMedia) {
      const response = await this.request('minio', new URL(object.url).pathname);
      assert.equal(sha256(Buffer.from(await response.arrayBuffer())), this.mediaChecksums.get(object.url), 'The previous public media bytes must survive past the longest cache TTL');
    }
    for (const path of routes) {
      const response = await this.request('frontendA', path, { timeout: 60000 }); const body = await response.text();
      if (path.endsWith('/gpx') || path.endsWith('/geometry')) assert.equal(sha256(body), sha256(warmed.get(path)));
      else assert.ok(body.includes(expectedText(path)), 'Warm public business content was lost after its TTL during the outage');
    }
    const cold = await this.request('frontendB', '/article/recovery-published', { allow: [500, 502, 503], timeout: 60000 });
    assert.ok(cold.status >= 500, 'Cold cache must report a temporary outage');
    const draft = await this.request('frontendA', '/article/recovery-published', { headers: { Cookie: cookies }, allow: [500, 502, 503], timeout: 60000 });
    assert.ok(draft.status >= 500, 'Draft content must not use the public fallback');
    await this.signal('frontend-b');
    await this.eventually('Cold restarted frontend remains outside routing', async () => {
      const pods = await this.bench.kubeJson(['get', 'pods', '-l', 'app.kubernetes.io/component=frontend-b']);
      const container = pods.items[0]?.status.containerStatuses?.[0];
      return container?.restartCount > 0 && container.ready === false;
    });
    const before = await this.bench.kubeJson(['get', 'pods', '-l', 'app.kubernetes.io/component=frontend-a']);
    const previousContainer = before.items[0].status.containerStatuses[0].containerID;
    await this.signal('frontend-a', 'SIGSTOP');
    await this.eventually('Frozen frontend restarted by its actual liveness probe', async () => {
      const pods = await this.bench.kubeJson(['get', 'pods', '-l', 'app.kubernetes.io/component=frontend-a']);
      const container = pods.items[0]?.status.containerStatuses?.[0];
      return container?.containerID && container.containerID !== previousContainer && container.ready === false;
    });
    await this.scale('cms', 1); const returnedAt = Date.now(); await this.applications();
    for (const component of ['frontend-a', 'frontend-b']) await this.bench.kube(['rollout', 'status', 'deployment/' + component, '--timeout=180s'], { timeout: 200000 });
    const rtoMs = Date.now() - returnedAt; assert.ok(rtoMs <= DEADLINE);
    for (const frontend of ['frontendA', 'frontendB']) {
      assert.equal((await this.request(frontend, '/api/ready')).status, 200);
      const page = await (await this.request(frontend, '/article/recovery-published')).text();
      assert.ok(page.includes(this.acknowledgedTitle));
    }
    // Both processes now hold the old publication. A fresh acknowledged update
    // must replace those warm representations after the dependency returns.
    this.acknowledgedTitle = 'Publication après reprise ' + randomUUID();
    await this.admin(MODEL + '/' + this.fixtures.article, { method: 'PUT', json: { title: this.acknowledgedTitle } });
    await this.admin(MODEL + '/' + this.fixtures.article + '/actions/publish', { method: 'POST', json: {} });
    const publishedAt = Date.now();
    await this.eventually('Both warm caches converge to the new acknowledged publication', async () => {
      for (const frontend of ['frontendA', 'frontendB']) {
        const response = await this.request(frontend, '/article/recovery-published');
        if (!(await response.text()).includes(this.acknowledgedTitle)) return false;
      }
      return true;
    }, { timeout: 90000 });
    await this.assertArticle();
    return { warmPublicRoutes: routes.length, realCacheExpiryWaitMs: 301000, previousMediaRetainedPastCacheTtl: true, coldTemporaryError: cold.status, previewBypassedCache: true, frozenProcessRestarted: true, rtoMs, publicationConvergenceMs: Date.now() - publishedAt };
  }
  async revocation() {
    await this.request('frontendA', '/article/recovery-published');
    await this.request('frontendA', '/itineraires-velo/recovery-itinerary/gpx');
    await this.admin(MODEL + '/' + this.fixtures.article + '/actions/unpublish', { method: 'POST', json: {} });
    await this.admin('/content-manager/single-types/api::global.global', { method: 'PUT', json: { publishCityItinerariesToNext: false } });
    // Exercise the real production TTL. A confirmed revocation must remain
    // absent even if the CMS subsequently disappears.
    await sleep(61000);
    const article = await this.request('frontendA', '/article/recovery-published', { allow: [404] }); assert.equal(article.status, 404);
    const gpx = await this.request('frontendA', '/itineraires-velo/recovery-itinerary/gpx', { allow: [404] }); assert.equal(gpx.status, 404);
    await this.scale('cms', 0);
    await this.eventually('CMS no longer routed', async () => (await this.bench.kubeJson(['get', 'pods', '-l', 'app.kubernetes.io/component=cms'])).items.length === 0);
    const revokedArticle = await this.request('frontendA', '/article/recovery-published', { allow: [404, 500, 503] }); assert.notEqual(revokedArticle.status, 200);
    const revokedGpx = await this.request('frontendA', '/itineraires-velo/recovery-itinerary/gpx', { allow: [404, 500, 503] }); assert.notEqual(revokedGpx.status, 200);
    await this.scale('cms', 1); await this.applications();
    await this.admin(MODEL + '/' + this.fixtures.article + '/actions/publish', { method: 'POST', json: {} });
    await this.admin('/content-manager/single-types/api::global.global', { method: 'PUT', json: { publishCityItinerariesToNext: true } });
    await this.eventually('Publication restored after CMS recovery', async () => {
      const response = await this.request('frontendA', '/article/recovery-published', { allow: [404, 500, 503] });
      return response.ok && (await response.text()).includes(this.acknowledgedTitle);
    });
    await this.eventually('Catalogue restored after reopening', async () => {
      const response = await this.request('frontendA', '/itineraires-velo/recovery-itinerary/gpx', { allow: [404, 500, 503] });
      return response.ok && (await response.text()).includes('<gpx');
    });
    return { confirmedArticleRevocation: true, confirmedCatalogueClosure: true, staleFallbackRevoked: true, reopenedSuccessfully: true };
  }
  async run() {
    await this.tunnels(); await this.applications(); await verifyImages(this.bench);
    await this.scenario('Golden Journey: acknowledged publication, media and receipt permissions', () => this.acknowledgement());
    await this.scenario('Golden Journey: interrupted editing and publication preserve acknowledged drafts', () => this.interruptedPublication());
    await this.scenario('Golden Journey: interrupted upload retries the same intent', () => this.interruptedUpload());
    await this.scenario('Golden Journey: revoked permissions prevent autonomous media commit after a crash', () => this.revokedAuthorization());
    await this.scenario('Golden Journey: partially uploaded image derivatives are cleaned before retry', () => this.partialDerivativeUpload());
    await this.scenario('Golden Journey: durable S3 upload survives real VM power cut', () => this.completeUploadPowerCut());
    await this.scenario('Golden Journey: late PostgreSQL and S3, second crash during recovery', () => this.lateDependenciesAndSecondCrash());
    await this.scenario('Golden Journey: replacement commit survives lost response and power cut', () => this.replaceAfterCommit());
    await this.scenario('Golden Journey: deletion cleanup resumes without dangling references', () => this.deletion());
    await this.scenario('Golden Journey: warm, cold, dead and frozen frontend with protected preview', () => this.frontend());
    await this.scenario('Golden Journey: confirmed unpublication and catalogue closure revoke fallback', () => this.revocation());
    await this.scenario('Golden Journey: obsolete replacement objects are removed after cache retention', async () => {
      for (const object of this.obsoleteMedia) await this.eventually('Obsolete media retention cleanup', async () => (await this.request('minio', new URL(object.url).pathname, { allow: [404] })).status === 404, { timeout: Math.max(30000, object.replacedAt + 630000 - Date.now()) });
      return { retainedForPublicCachesThenRemoved: true, objects: this.obsoleteMedia.length };
    });
    assert.equal(this.cutCount, 3, 'Exactly three real business VM power cuts are required');
    await verifyImages(this.bench);
    return this.results;
  }
}
