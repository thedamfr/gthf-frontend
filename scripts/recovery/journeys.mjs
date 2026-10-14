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
import { withCmsPartition } from './network-partition.mjs';
import { injectInterruptedMedia } from './late-put.mjs';
import { withUrlFixture } from './url-fixture.mjs';

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
  async interruptedUrlImport() {
    const sourceKey = randomUUID();
    const source = await this.assertMedia(await this.upload(sourceKey, { bytes: uploadPng, name: 'url-source.png' }));
    const prefix = '/' + this.bench.manifest.bucket + '/';
    const sourcePath = new URL(source.url).pathname; assert.ok(sourcePath.startsWith(prefix));
    const object = (await this.operationObjects(sourceKey)).find((item) => item.key === sourcePath.slice(prefix.length));
    assert.ok(object, 'The URL source must be an acknowledged, checksummed campaign object');
    const key = randomUUID();
    const urlFileCount = async () => {
      const result = await this.bench.kube(['exec', 'deployment/postgres', '--', 'psql', '-U', 'gthf_recovery', '-d', this.bench.manifest.database,
        '-tA', '-v', 'ON_ERROR_STOP=1', '-c', "SELECT count(*) FROM files WHERE provider_metadata->>'gthfOperation'='" + key + "'"]);
      return Number(result.stdout.toString().trim());
    };
    const stream = async (body) => {
      const response = await this.request('cms', '/upload/actions/upload-from-urls', { method: 'POST', token: this.adminToken, json: body, timeout: 120000 });
      assert.ok(response.headers.get('content-type')?.includes('text/event-stream'));
      const text = await response.text();
      return text.split('\n\n').filter(Boolean).map((block) => {
        const lines = block.split('\n');
        const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
        const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
        assert.ok(event && data); return { event, data: JSON.parse(data) };
      });
    };
    const recovered = await withUrlFixture(this.bench, object, async ({ url }) => {
      const payload = { urls: [url], folderId: null, operationKeys: [key] };
      const legacy = await this.request('cms', '/upload/actions/upload-from-urls', { method: 'POST', token: this.adminToken,
        json: { urls: [url], folderId: null }, allow: [409] });
      assert.equal(legacy.status, 409); assert.equal((await legacy.json()).error.name, 'ADMIN_RELOAD_REQUIRED');
      await this.gate('before-commit', key);
      const pending = stream(payload).then((events) => events.some((item) => item.event === 'stream:complete'), () => false);
      await this.observed('before-commit', key);
      const receipt = await this.admin('/upload/recovery/operations/' + key);
      assert.equal(receipt.kind, 'upload'); assert.equal(receipt.status, 'pending'); assert.equal(receipt.result, undefined);
      assert.equal(await urlFileCount(), 0, 'The streamed URL must have no file before its SQL commit');
      const objects = await this.operationObjects(key); await this.assertObjects(objects);
      const interruptedAt = Date.now(); await this.signal('cms');
      assert.equal(await pending, false, 'The killed URL stream must not acknowledge a completed import');
      await this.applications();
      const committed = (await this.receipt(key, 'committed')).value;
      const rtoMs = Date.now() - interruptedAt; assert.ok(rtoMs <= DEADLINE);
      const media = await this.assertMedia(committed.result);
      assert.equal(await urlFileCount(), 1); assert.equal(await this.operationCount(key), 1);
      await this.assertObjects(objects); await this.assertMedia(source);
      return { payload, media, rtoMs };
    });
    // withUrlFixture has now removed the only reachable source endpoint. A
    // committed replay must use its receipt without fetching that source again.
    const events = await stream(recovered.payload);
    const completed = events.filter((item) => item.event === 'file:complete');
    assert.equal(completed.length, 1); assert.equal(completed[0].data.operationKey, key);
    assert.equal(completed[0].data.replayed, true); assert.equal(completed[0].data.file.id, recovered.media.id);
    const summary = events.filter((item) => item.event === 'stream:complete'); assert.equal(summary.length, 1);
    assert.equal(summary[0].data.data.length, 1); assert.equal(summary[0].data.data[0].id, recovered.media.id); assert.deepEqual(summary[0].data.errors, []);
    assert.equal(await urlFileCount(), 1); assert.equal(await this.operationCount(key), 1);
    assert.equal((await this.request('cms', '/upload/recovery/operations/' + key, { token: this.otherToken, allow: [404] })).status, 404);
    assert.equal((await this.request('cms', '/upload/actions/upload-from-urls', { method: 'POST', token: this.otherToken, json: recovered.payload, allow: [404] })).status, 404);
    const changed = await this.request('cms', '/upload/actions/upload-from-urls', { method: 'POST', token: this.adminToken,
      json: { ...recovered.payload, urls: [recovered.payload.urls[0] + '?changed=1'] }, allow: [409] });
    assert.equal(changed.status, 409); assert.equal((await changed.json()).error.name, 'IDEMPOTENCY_CONFLICT');
    return { key, mediaId: recovered.media.id, rtoMs: recovered.rtoMs, realCmsSigkill: true, preparedObjectsPersisted: true,
      uniqueReceiptAndFile: true, receiptOwnerVerified: true, changedSourceRefused: true, sourceFixtureRemovedBeforeReplay: true,
      replayWithoutSourceFetch: true, sourceMediaPreserved: true, sourceScope: 'synthetic VM HTTP source with original Strapi SSRF checks' };
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
    await assert.rejects(this.upload(key), /Unexpected isolated HTTP status 409 for cms\/upload/); assert.equal(await this.operationCount(key), 1);
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
    const oldBytes = Buffer.from(await (await this.request('minio', '/' + this.bench.manifest.bucket + '/' + originalObjects[0].key)).arrayBuffer());
    assert.equal(sha256(oldBytes), originalObjects[0].sha256); assert.equal(oldBytes.length, originalObjects[0].bytes);
    await this.signal('cms'); assert.equal(await request, false); await this.applications();
    await this.receipt(key, 'interrupted');
    const cleanupSweep = async () => {
      const response = await this.bench.kube(['exec', 'deployment/postgres', '--', 'psql', '-U', 'gthf_recovery', '-d', this.bench.manifest.database, '-At', '-v', 'ON_ERROR_STOP=1', '-c',
        "SELECT row_to_json(c) FROM (SELECT id,attempt,updated_at,(lease_owner IS NULL AND not_before>clock_timestamp()) AS rescheduled FROM gthf_media_cleanup WHERE recurring=true AND state='pending' AND operation_key='" + key + "') c"]);
      const value = JSON.parse(response.stdout.toString().trim());
      assert.match(value.id, UUID); assert.match(value.attempt, UUID); assert.ok(Number.isFinite(Date.parse(value.updated_at)));
      return value;
    };
    const firstSweep = (await this.eventually('Incomplete upload cleaned with its late-write intention retained', async () => {
      for (const object of originalObjects) if ((await this.request('minio', '/' + this.bench.manifest.bucket + '/' + object.key, { allow: [404] })).status !== 404) return false;
      const sweep = await cleanupSweep(); return sweep.rescheduled ? sweep : false;
    })).value;
    const result = await this.upload(key, { bytes, name: 'recovery-derivatives.png' });
    const media = await this.assertMedia(result, { width: 1200, height: 800 });
    assert.ok(Object.keys(media.formats).length >= 2);
    const retried = await this.operationObjects(key); await this.assertObjects(retried);
    assert.ok(retried.every((object) => !originalObjects.some((old) => old.key === object.key)));
    assert.equal(await this.operationCount(key), 1);

    // Explicit simulation: replay the exact old immutable bytes only AFTER the
    // first real MinIO cleanup. No provider-side delayed request is claimed.
    await injectInterruptedMedia(this.bench, { attempt: firstSweep.attempt, object: originalObjects[0], bytes: oldBytes, role: 'delayed-put' });
    const foreignBytes = Buffer.from('Synthetic foreign ownership fixture: ' + key);
    const foreign = { key: originalObjects[1].key, sha256: sha256(foreignBytes), bytes: foreignBytes.length, mime: 'text/plain' };
    assert.notEqual(foreign.sha256, originalObjects[1].sha256);
    await injectInterruptedMedia(this.bench, { attempt: firstSweep.attempt, object: foreign, bytes: foreignBytes, role: 'foreign-collision' });
    await this.assertObjects([foreign]);
    const recovered = await this.eventually('A recurring sweep removes the late old PUT and preserves foreign ownership', async () => {
      if ((await this.request('minio', '/' + this.bench.manifest.bucket + '/' + originalObjects[0].key, { allow: [404] })).status !== 404) return false;
      const sweep = await cleanupSweep();
      assert.equal(sweep.id, firstSweep.id); assert.equal(sweep.attempt, firstSweep.attempt);
      if (!sweep.rescheduled || Date.parse(sweep.updated_at) <= Date.parse(firstSweep.updated_at)) return false;
      await this.assertObjects([foreign, ...retried]);
      return true;
    });
    await this.assertMedia(result, { width: 1200, height: 800 });
    // The deliberate foreign object remains in this disposable VM until teardown.
    // Removing it here would invalidate the ownership protection being exercised.
    return { key, originalObjects: originalObjects.length, finalObjects: retried.length, partialObjectsRemoved: true, derivativesVerified: true,
      delayedPut: { simulation: 'explicit old-byte reinjection after first real MinIO cleanup; not provider/network delay',
        recoveredWithinMs: recovered.elapsedMs, recurringIntentionRetained: true, retryObjectsPreserved: true,
        foreignCollisionPreserved: true, syntheticForeignObjectsRetainedUntilVmTeardown: 1 } };
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
    const retained = await this.bench.kube(['exec', 'deployment/postgres', '--', 'psql', '-U', 'gthf_recovery', '-d', this.bench.manifest.database, '-At', '-v', 'ON_ERROR_STOP=1', '-c', "SELECT count(*) FROM gthf_media_cleanup WHERE operation_key='" + key + "' AND retain_file_id=" + original.id + " AND state='pending' AND recurring=false AND lease_owner IS NULL"]);
    assert.equal(Number(retained.stdout.toString().trim()), 1, 'Replacement history must be held by the existing logical file');
    this.replacementHistory = { id: original.id, versions: [original, replaced] };
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
  async interruptedBulkDelete() {
    const emptyKey = randomUUID();
    const empty = await this.request('cms', '/upload/actions/bulk-delete', { method: 'POST', token: this.adminToken,
      headers: { 'Idempotency-Key': emptyKey }, json: { fileIds: [], folderIds: [] }, allow: [400] });
    assert.equal(empty.status, 400); assert.equal((await empty.json()).error.name, 'INVALID_MEDIA_BATCH');
    assert.equal((await this.request('cms', '/upload/recovery/operations/' + emptyKey, { token: this.adminToken, allow: [404] })).status, 404);
    const root = (await this.admin('/upload/folders', { method: 'POST', json: { name: 'recovery-bulk-' + randomUUID() } })).data;
    assert.ok(Number.isSafeInteger(root?.id));
    const nested = (await this.admin('/upload/folders', { method: 'POST', json: { name: 'recovery-nested-' + randomUUID(), parent: root.id } })).data;
    assert.ok(Number.isSafeInteger(nested?.id));
    const first = await this.assertMedia(await this.upload(randomUUID()));
    const second = await this.assertMedia(await this.upload(randomUUID(), { fileInfo: { folder: nested.id } }));
    const files = [first, second];
    const selection = { fileIds: [first.id], folderIds: [root.id] };
    const key = randomUUID();
    const legacy = await this.request('cms', '/upload/actions/bulk-delete', { method: 'POST', token: this.adminToken, json: selection, allow: [409] });
    assert.equal(legacy.status, 409); assert.equal((await legacy.json()).error.name, 'ADMIN_RELOAD_REQUIRED');
    await this.gate('after-batch-child', key, 0);
    const request = this.admin('/upload/actions/bulk-delete', { method: 'POST', headers: { 'Idempotency-Key': key }, json: selection, timeout: 120000 }).then(() => true, () => false);
    await this.observed('after-batch-child', key);
    const partial = await this.admin('/upload/recovery/operations/' + key);
    assert.equal(partial.kind, 'bulk-delete'); assert.equal(partial.status, 'pending'); assert.equal(partial.result, undefined);
    assert.equal(partial.progress.total, 2); assert.equal(partial.progress.committed, 1);
    assert.equal(await this.fileCount(first.id), 0); assert.equal(await this.fileCount(second.id), 1);
    assert.equal((await this.request('cms', '/upload/recovery/operations/' + key, { token: this.otherToken, allow: [404] })).status, 404);
    assert.equal((await this.request('cms', '/upload/recovery/operations/' + key, { allow: [401] })).status, 401);
    const conflict = await this.request('cms', '/upload/actions/bulk-delete', { method: 'POST', token: this.adminToken, headers: { 'Idempotency-Key': key }, json: { fileIds: [second.id], folderIds: [] }, allow: [409] });
    assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error.name, 'IDEMPOTENCY_CONFLICT');
    const current = await this.admin('/admin/users/me'); const user = current.data ?? current;
    const originalRoles = user.roles.map((role) => role.id);
    const roleResponse = await this.admin('/admin/roles', { method: 'POST', token: this.otherToken, json: { name: 'Recovery batch denied ' + randomUUID().slice(0, 8), description: 'Synthetic current-rights check' } });
    const deniedRole = roleResponse.data ?? roleResponse;
    try {
      await this.admin('/admin/users/' + user.id, { method: 'PUT', token: this.otherToken, json: { roles: [deniedRole.id] } });
      assert.equal((await this.request('cms', '/upload/recovery/operations/' + key, { token: this.adminToken, allow: [403] })).status, 403);
      assert.equal((await this.request('cms', '/upload/actions/bulk-delete', { method: 'POST', token: this.adminToken, headers: { 'Idempotency-Key': key }, json: selection, allow: [403] })).status, 403);
    } finally {
      await this.admin('/admin/users/' + user.id, { method: 'PUT', token: this.otherToken, json: { roles: originalRoles } });
      await this.login();
    }
    const interruptedAt = Date.now(); await this.signal('cms'); assert.equal(await request, false);
    await this.applications();
    const receipt = (await this.receipt(key, 'committed')).value;
    const rtoMs = Date.now() - interruptedAt; assert.ok(rtoMs <= DEADLINE);
    assert.equal(receipt.progress.total, 2); assert.equal(receipt.progress.committed, 2); assert.equal(receipt.progress.failed, 0);
    assert.deepEqual(receipt.result.files.map((file) => file.id).sort((a, b) => a - b), files.map((file) => file.id));
    assert.deepEqual(receipt.result.folders.map((folder) => folder.id), [root.id]);
    const replay = await this.admin('/upload/actions/bulk-delete', { method: 'POST', headers: { 'Idempotency-Key': key }, json: selection });
    assert.deepEqual(replay.data, receipt.result);
    for (const file of files) assert.equal(await this.fileCount(file.id), 0);
    for (const child of receipt.progress.children) { assert.match(child.key, UUID); assert.equal(await this.operationCount(child.key), 1); }
    const counts = await this.bench.kube(['exec', 'deployment/postgres', '--', 'psql', '-U', 'gthf_recovery', '-d', this.bench.manifest.database, '-At', '-v', 'ON_ERROR_STOP=1', '-c',
      "SELECT json_build_object('batches',(SELECT count(*) FROM gthf_media_batches WHERE key='" + key + "'),'folders',(SELECT count(*) FROM upload_folders WHERE id IN (" + root.id + ',' + nested.id + ')))']);
    assert.deepEqual(JSON.parse(counts.stdout.toString()), { batches: 1, folders: 0 });
    await this.eventually('Objects from both bulk children are removed after resume', async () => {
      for (const file of files) for (const object of [file, ...Object.values(file.formats ?? {})]) {
        if ((await this.request('minio', new URL(object.url).pathname, { allow: [404] })).status !== 404) return false;
      }
      return true;
    });
    await this.assertMedia(this.acknowledged[0].media);
    return { key, rtoMs, files: 2, folders: 2, partialReceiptHonest: true, ownerPermissionsVerified: true, currentRightsRechecked: true,
      parentAndChildrenUnique: true, completeReplayAfterLostResponse: true, unrelatedMediaPreserved: true };
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
    const history = this.replacementHistory;
    assert.ok(history?.versions.length === 2, 'The replacement Journey must first commit versions A and B');
    const versionB = history.versions[1];
    await this.admin(MODEL + '/' + this.fixtures.article, { method: 'PUT', json: { blocks: [
      { __component: 'shared.rich-text', body: 'Écriture acquittée de la campagne ' + this.bench.manifest.vm.uuid },
      { __component: 'shared.media', file: history.id },
    ] } });
    await this.admin(MODEL + '/' + this.fixtures.article + '/actions/publish', { method: 'POST', json: {} });
    const containsMedia = (body, media) => body.includes(media.url) || body.includes(encodeURIComponent(media.url));
    await this.eventually('The warm publication includes acknowledged media B', async () => {
      const body = await (await this.request('frontendA', '/article/recovery-published')).text();
      return body.includes(this.acknowledgedTitle) && containsMedia(body, versionB);
    }, { timeout: 90000 });
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

    const cmsProcess = async () => {
      const pods = (await this.bench.kubeJson(['get', 'pods', '-l', 'app.kubernetes.io/component=cms'])).items.filter((pod) => !pod.metadata.deletionTimestamp);
      assert.equal(pods.length, 1); assert.equal(pods[0].metadata.labels['qualification.infra-sincere/uuid'], this.bench.manifest.vm.uuid);
      const container = pods[0].status.containerStatuses[0]; assert.equal(container.ready, true);
      assert.equal((await this.request('cms', '/api/release')).status, 200);
      return { pod: pods[0].metadata.uid, container: container.containerID, restarts: container.restartCount };
    };
    const latestWorkerSweep = async () => {
      const response = await this.bench.kube(['exec', 'deployment/postgres', '--', 'psql', '-U', 'gthf_recovery', '-d', this.bench.manifest.database, '-At', '-v', 'ON_ERROR_STOP=1', '-c',
        "SELECT max(updated_at) FROM gthf_media_cleanup WHERE recurring=true AND state='pending'"]);
      const time = Date.parse(response.stdout.toString().trim()); assert.ok(Number.isFinite(time)); return time;
    };
    const frontendMedia = async () => {
      // Check the actual allowed path from the partitioned frontend, not merely
      // a healthy MinIO connection from the external controller.
      assert.equal(new URL(versionB.url).origin, 'http://minio:9000');
      const result = await this.bench.kube(['exec', 'deployment/frontend-a', '--', 'node', '-e',
        "const {createHash}=require('node:crypto');fetch(process.argv[1],{signal:AbortSignal.timeout(5000)}).then(async r=>{if(!r.ok)throw Error('storage');const b=Buffer.from(await r.arrayBuffer());process.stdout.write(createHash('sha256').update(b).digest('hex'))}).catch(()=>{process.exitCode=1})",
        versionB.url], { timeout: 10000 });
      assert.equal(result.stdout.toString(), this.mediaChecksums.get(versionB.url));
    };
    const cmsBefore = await cmsProcess(); const workerBefore = await latestWorkerSweep();
    let coldStatus; let actualRetentionWaitMs; let cmsAliveSamples = 0;
    await withCmsPartition(this.bench, async () => {
      await this.eventually('Both frontends really lose CMS access while the CMS stays ready', async () => {
        for (const frontend of ['frontendA', 'frontendB']) if ((await this.request(frontend, '/api/ready', { allow: [503] })).status !== 503) return false;
        assert.deepEqual(await cmsProcess(), cmsBefore); await frontendMedia(); return true;
      }, { timeout: 30000 });
      assert.equal((await this.request('frontendA', '/api/serving')).status, 200);
      const versionC = await this.assertMedia(await this.upload(randomUUID(), { id: history.id, bytes: await derivativeFixture() }), { width: 1200, height: 800 });
      assert.equal(versionC.id, history.id); assert.notEqual(versionC.url, versionB.url);
      history.versions.push(versionC);
      for (const object of [versionB, ...Object.values(versionB.formats)]) this.obsoleteMedia.push({ url: object.url });
      const replacedAt = Date.now();
      // A finite 600s cleanup was the defect: observe beyond that real boundary
      // with the same live CMS process, automatic worker and reachable storage.
      while (Date.now() - replacedAt < 601000) {
        await sleep(Math.min(30000, 601000 - (Date.now() - replacedAt)));
        assert.deepEqual(await cmsProcess(), cmsBefore);
        assert.equal((await this.request('minio', '/minio/health/ready')).status, 200);
        cmsAliveSamples++;
        this.bench.event({ event: 'media-history-retention-observation', elapsedMs: Date.now() - replacedAt, cmsUnchangedAndReady: true, storageReady: true });
      }
      actualRetentionWaitMs = Date.now() - replacedAt; assert.ok(actualRetentionWaitMs >= 601000);
      assert.ok(await latestWorkerSweep() > workerBefore, 'The automatic CMS cleanup worker must still make progress during the partition');
      await frontendMedia();
      for (const object of this.obsoleteMedia) {
        const response = await this.request('minio', new URL(object.url).pathname);
        assert.equal(sha256(Buffer.from(await response.arrayBuffer())), this.mediaChecksums.get(object.url), 'Old versions must remain intact while the logical file exists');
      }
      for (const path of routes) {
        const response = await this.request('frontendA', path, { timeout: 60000 }); const body = await response.text();
        if (path.endsWith('/gpx') || path.endsWith('/geometry')) assert.equal(sha256(body), sha256(warmed.get(path)));
        else assert.ok(body.includes(expectedText(path)), 'Warm public business content was lost during the partition');
        if (path.startsWith('/article/')) {
          assert.ok(containsMedia(body, versionB), 'The stale publication must still resolve its version B image');
          assert.equal(containsMedia(body, versionC), false, 'A disconnected cache must not claim to have refreshed');
        }
      }
      const cold = await this.request('frontendB', '/article/recovery-published', { allow: [500, 502, 503], timeout: 60000 });
      coldStatus = cold.status; assert.ok(coldStatus >= 500, 'Cold cache must report a temporary outage');
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
      assert.deepEqual(await cmsProcess(), cmsBefore);
    });
    const returnedAt = Date.now(); await this.applications();
    for (const component of ['frontend-a', 'frontend-b']) await this.bench.kube(['rollout', 'status', 'deployment/' + component, '--timeout=180s'], { timeout: 200000 });
    const rtoMs = Date.now() - returnedAt; assert.ok(rtoMs <= DEADLINE);
    for (const frontend of ['frontendA', 'frontendB']) {
      assert.equal((await this.request(frontend, '/api/ready')).status, 200);
      const page = await (await this.request(frontend, '/article/recovery-published')).text();
      assert.ok(page.includes(this.acknowledgedTitle)); assert.ok(containsMedia(page, history.versions[2]));
    }
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
    return { warmPublicRoutes: routes.length, realCacheExpiryWaitMs: actualRetentionWaitMs, historicalMediaRetainedWhileFileExists: true,
      cmsAliveSamples, automaticCleanupWorkerProgressed: true, actualFrontendCmsPartition: true, frontendMinioStillReachable: true,
      coldTemporaryError: coldStatus, previewBypassedCache: true, frozenProcessRestarted: true, rtoMs, publicationConvergenceMs: Date.now() - publishedAt };
  }

  async deleteReplacementHistory() {
    const history = this.replacementHistory; assert.equal(history.versions.length, 3);
    const objects = history.versions.flatMap((media) => [media, ...Object.values(media.formats)]);
    assert.equal(new Set(objects.map((object) => object.url)).size, objects.length, 'Each version must use distinct immutable keys');
    const unrelated = this.acknowledged[0].media;
    assert.notEqual(unrelated.id, history.id); await this.assertMedia(unrelated);
    const key = randomUUID();
    await this.admin('/upload/files/' + history.id, { method: 'DELETE', headers: { 'Idempotency-Key': key } });
    await this.receipt(key, 'committed'); assert.equal(await this.fileCount(history.id), 0);
    await this.admin('/upload/files/' + history.id, { method: 'DELETE', headers: { 'Idempotency-Key': key } });
    await this.eventually('One explicit media deletion cleans all A, B and C versions', async () => {
      for (const object of objects) if ((await this.request('minio', new URL(object.url).pathname, { allow: [404] })).status !== 404) return false;
      const result = await this.bench.kube(['exec', 'deployment/postgres', '--', 'psql', '-U', 'gthf_recovery', '-d', this.bench.manifest.database, '-At', '-v', 'ON_ERROR_STOP=1', '-c',
        "SELECT count(*) FROM gthf_media_cleanup WHERE retain_file_id=" + history.id + " OR operation_key='" + key + "'"]);
      return Number(result.stdout.toString().trim()) === 0;
    });
    assert.equal(await this.operationCount(key), 1); await this.assertMedia(unrelated);
    return { versions: 3, deletedObjects: objects.length, explicitDeletionOnly: true, historiesCleanedAfterSqlDelete: true,
      deleteReplayUnique: true, unrelatedMediaPreserved: true };
  }
  async revocation() {
    await this.request('frontendA', '/article/recovery-published');
    await this.request('frontendA', '/itineraires-velo/recovery-itinerary/gpx');
    // First admission reads readiness directly; it must not prewarm the full
    // global projection. Warm only the GPX feature switch on a fresh process.
    const before = await this.bench.kubeJson(['get', 'pods', '-l', 'app.kubernetes.io/component=frontend-b']);
    const previousContainer = before.items[0].status.containerStatuses[0].containerID;
    await this.signal('frontend-b');
    await this.eventually('Fresh frontend B admitted before cross-projection closure', async () => {
      const pods = await this.bench.kubeJson(['get', 'pods', '-l', 'app.kubernetes.io/component=frontend-b']);
      const container = pods.items[0]?.status.containerStatuses?.[0];
      return container?.containerID && container.containerID !== previousContainer && container.ready === true;
    });
    const openGpx = await this.request('frontendB', '/itineraires-velo/recovery-itinerary/gpx');
    assert.ok((await openGpx.text()).includes('<gpx'));
    const partialWarmedAt = Date.now();
    const globalResponse = await this.admin('/content-manager/single-types/api::global.global');
    const previousLlmsTxt = (globalResponse.data ?? globalResponse).llmsTxt ?? null;
    assert.ok(previousLlmsTxt === null || typeof previousLlmsTxt === 'string');
    const closureMarker = 'Qualification closure ' + randomUUID();
    await this.admin(MODEL + '/' + this.fixtures.article + '/actions/unpublish', { method: 'POST', json: {} });
    await this.admin('/content-manager/single-types/api::global.global', { method: 'PUT', json: { publishCityItinerariesToNext: false, llmsTxt: closureMarker } });
    // The real text route exposes a marker from the full global response. Its false
    // switch must revoke the still-fresh partial response used by the GPX route.
    const globalText = await this.request('frontendB', '/llms.txt');
    assert.equal(await globalText.text(), closureMarker, 'The full global projection must confirm this closure');
    const immediateGpx = await this.request('frontendB', '/itineraires-velo/recovery-itinerary/gpx', { allow: [404] });
    assert.equal(immediateGpx.status, 404);
    const crossProjectionClosureMs = Date.now() - partialWarmedAt;
    assert.ok(crossProjectionClosureMs < 60000, 'Cross-projection revocation must precede the partial response TTL');
    // Exercise the real production TTL. A confirmed revocation must remain
    // absent even if the CMS subsequently disappears.
    await sleep(61000);
    const article = await this.request('frontendA', '/article/recovery-published', { allow: [404] }); assert.equal(article.status, 404);
    const gpx = await this.request('frontendA', '/itineraires-velo/recovery-itinerary/gpx', { allow: [404] }); assert.equal(gpx.status, 404);
    await this.scale('cms', 0);
    await this.eventually('CMS no longer routed', async () => (await this.bench.kubeJson(['get', 'pods', '-l', 'app.kubernetes.io/component=cms'])).items.length === 0);
    const revokedArticle = await this.request('frontendA', '/article/recovery-published', { allow: [404, 500, 503] }); assert.notEqual(revokedArticle.status, 200);
    const revokedGpx = await this.request('frontendA', '/itineraires-velo/recovery-itinerary/gpx', { allow: [404, 500, 503] }); assert.notEqual(revokedGpx.status, 200);
    const revokedProjection = await this.request('frontendB', '/itineraires-velo/recovery-itinerary/gpx', { allow: [404, 500, 503] }); assert.notEqual(revokedProjection.status, 200);
    await this.scale('cms', 1); await this.applications();
    await this.admin(MODEL + '/' + this.fixtures.article + '/actions/publish', { method: 'POST', json: {} });
    await this.admin('/content-manager/single-types/api::global.global', { method: 'PUT', json: { publishCityItinerariesToNext: true, llmsTxt: previousLlmsTxt } });
    await this.eventually('Publication restored after CMS recovery', async () => {
      const response = await this.request('frontendA', '/article/recovery-published', { allow: [404, 500, 503] });
      return response.ok && (await response.text()).includes(this.acknowledgedTitle);
    });
    await this.eventually('Catalogue restored after reopening', async () => {
      const response = await this.request('frontendA', '/itineraires-velo/recovery-itinerary/gpx', { allow: [404, 500, 503] });
      return response.ok && (await response.text()).includes('<gpx');
    });
    return { confirmedArticleRevocation: true, confirmedCatalogueClosure: true, crossProjectionClosureMs,
      freshPartialProjectionRevokedByFullResponse: true, staleFallbackRevoked: true, reopenedSuccessfully: true };
  }
  async run() {
    await this.tunnels(); await this.applications(); await verifyImages(this.bench);
    await this.scenario('Golden Journey: acknowledged publication, media and receipt permissions', () => this.acknowledgement());
    await this.scenario('Golden Journey: URL import resumes after a real CMS crash and replays without refetch', () => this.interruptedUrlImport());
    await this.scenario('Golden Journey: interrupted editing and publication preserve acknowledged drafts', () => this.interruptedPublication());
    await this.scenario('Golden Journey: interrupted upload retries the same intent', () => this.interruptedUpload());
    await this.scenario('Golden Journey: revoked permissions prevent autonomous media commit after a crash', () => this.revokedAuthorization());
    await this.scenario('Golden Journey: partially uploaded image derivatives are cleaned before retry', () => this.partialDerivativeUpload());
    await this.scenario('Golden Journey: durable S3 upload survives real VM power cut', () => this.completeUploadPowerCut());
    await this.scenario('Golden Journey: late PostgreSQL and S3, second crash during recovery', () => this.lateDependenciesAndSecondCrash());
    await this.scenario('Golden Journey: replacement commit survives lost response and power cut', () => this.replaceAfterCommit());
    await this.scenario('Golden Journey: deletion cleanup resumes without dangling references', () => this.deletion());
    await this.scenario('Golden Journey: bulk deletion resumes a partial parent without duplicate child operations', () => this.interruptedBulkDelete());
    await this.scenario('Golden Journey: warm, cold, dead and frozen frontend with protected preview', () => this.frontend());
    await this.scenario('Golden Journey: confirmed unpublication and catalogue closure revoke fallback', () => this.revocation());
    await this.scenario('Golden Journey: explicit media deletion cleans all retained replacement versions', () => this.deleteReplacementHistory());
    assert.equal(this.cutCount, 3, 'Exactly three real business VM power cuts are required');
    await verifyImages(this.bench);
    return this.results;
  }
}
