import assert from 'node:assert/strict';
import test from 'node:test';
import { URL_FIXTURE_IP, withUrlFixture } from '../scripts/recovery/url-fixture.mjs';

const uuid = '22222222-2222-4222-8222-222222222222';
const namespaceUid = '33333333-3333-4333-8333-333333333333';
const serviceUid = '44444444-4444-4444-8444-444444444444';
const runId = 'gthf-recovery-url-test';
const owner = 'qualification.infra-sincere/';
const object = { key: 'fixtures/source.png', bytes: 17, sha256: 'a'.repeat(64) };
type Service = { apiVersion: string; kind: string; metadata: { name: string; namespace: string; uid: string; resourceVersion: string; labels: Record<string, string> }; spec: { type: string; externalIPs: string[]; selector: Record<string, string>; ports: { name: string; protocol: string; port: number; targetPort: number }[] } };
function fixture() {
  const labels = { [owner + 'uuid']: uuid, [owner + 'run-id']: runId };
  const namespace = { metadata: { name: 'gthf-recovery', uid: namespaceUid, labels: { ...labels } } };
  const minio = { metadata: { name: 'minio', namespace: 'gthf-recovery', labels: { ...labels } }, spec: { template: { metadata: { labels: { ...labels, 'app.kubernetes.io/component': 'minio' } } } } };
  const services: Service[] = []; const operations: { args: string[]; input?: string }[] = []; const events: unknown[] = [];
  const state = { consumer: 'gthf', uuid, runId, hostname: 'infra-qualification-vm', networkMode: 'isolated', running: true, sshReady: true, bootId: 'boot-1' };
  const modes = { badProbe: false, uncertainCreate: false, deleteConflict: false };
  const bench = {
    manifest: { consumer: 'gthf', target: 'vm', namespace: 'gthf-recovery', runId, vm: { uuid, hostname: 'infra-qualification-vm' }, bucket: 'gthf-recovery-' + uuid },
    status: async () => state,
    kubeJson: async (args: string[]) => {
      if (args[1] === 'namespace') return structuredClone(namespace);
      if (args[1] === 'deployment') return structuredClone(minio);
      assert.equal(args[1], 'services'); return { items: structuredClone(services) };
    },
    kube: async (args: string[], options: { input?: string; timeout?: number } = {}) => {
      operations.push({ args, input: options.input });
      if (args[0] === 'create') {
        const created: Service = JSON.parse(options.input!);
        created.metadata.uid = serviceUid; created.metadata.resourceVersion = '17'; services.push(created);
        if (modes.uncertainCreate) throw new Error('connection lost after create');
        return { stdout: Buffer.from(JSON.stringify(created)) };
      }
      if (args[0] === 'exec') {
        assert.equal(args[1], 'deployment/cms');
        return { stdout: Buffer.from(JSON.stringify({ bytes: object.bytes, sha256: modes.badProbe ? 'b'.repeat(64) : object.sha256 })) };
      }
      assert.deepEqual(args.slice(0, 2), ['delete', '--raw']);
      assert.equal(args[2], '/api/v1/namespaces/gthf-recovery/services/url-import-source-' + uuid.slice(0, 8));
      assert.deepEqual(JSON.parse(options.input!), { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: serviceUid, resourceVersion: '17' } });
      if (modes.deleteConflict) throw new Error('UID precondition conflict');
      services.splice(0); return { stdout: Buffer.from('{}') };
    },
    event: (entry: unknown) => { events.push(entry); },
  };
  return { bench, namespace, minio, services, operations, events, state, modes };
}

test('URL fixture uses only the isolated run MinIO and removes its exact Service after a Journey failure', async () => {
  const current = fixture();
  await assert.rejects(withUrlFixture(current.bench, object, async ({ url, serviceUid: actualUid }: { url: string; serviceUid: string }) => {
    assert.equal(url, 'http://203.0.113.42:9000/gthf-recovery-' + uuid + '/fixtures/source.png');
    assert.equal(actualUid, serviceUid);
    const service = current.services[0];
    assert.equal(service.spec.type, 'ClusterIP'); assert.deepEqual(service.spec.externalIPs, [URL_FIXTURE_IP]);
    assert.deepEqual(service.spec.selector, { [owner + 'uuid']: uuid, [owner + 'run-id']: runId, 'app.kubernetes.io/component': 'minio' });
    assert.deepEqual(service.spec.ports, [{ name: 'http', protocol: 'TCP', port: 9000, targetPort: 9000 }]);
    throw new Error('business Journey failed');
  }), /business Journey failed/);
  assert.deepEqual(current.operations.map((entry) => entry.args[0]), ['create', 'exec', 'delete']);
  assert.equal(current.services.length, 0); assert.equal(current.events.length, 2);
});

test('URL fixture returns the business result after byte verification and cleanup', async () => {
  const current = fixture();
  assert.equal(await withUrlFixture(current.bench, object, async () => 'receipt'), 'receipt');
  assert.equal(current.services.length, 0);
});

test('foreign reservation, namespace, target or MinIO refuses before any mutation', async () => {
  const changes = [
    (f: ReturnType<typeof fixture>) => { f.bench.manifest.target = 'production'; },
    (f: ReturnType<typeof fixture>) => { f.bench.manifest.namespace = 'gthf-staging'; },
    (f: ReturnType<typeof fixture>) => { f.state.consumer = 'podcast-studio'; },
    (f: ReturnType<typeof fixture>) => { f.state.uuid = namespaceUid; },
    (f: ReturnType<typeof fixture>) => { f.state.runId = 'gthf-recovery-foreign'; },
    (f: ReturnType<typeof fixture>) => { f.state.networkMode = 'bootstrap'; },
    (f: ReturnType<typeof fixture>) => { f.state.running = false; },
    (f: ReturnType<typeof fixture>) => { f.namespace.metadata.labels[owner + 'run-id'] = 'foreign'; },
    (f: ReturnType<typeof fixture>) => { f.minio.spec.template.metadata.labels[owner + 'uuid'] = namespaceUid; },
  ];
  for (const change of changes) {
    const current = fixture(); change(current);
    await assert.rejects(withUrlFixture(current.bench, object, async () => assert.fail('Must not run')));
    assert.equal(current.operations.length, 0);
  }
});

test('invalid object keys, bucket or digest never reach the cluster', async () => {
  for (const key of ['../secret', 'a/../b', '/outside', 'a//b', 'a?token=x', 'a%2fb', 'https://other/a']) {
    const current = fixture();
    await assert.rejects(withUrlFixture(current.bench, { ...object, key }, async () => assert.fail('Must not run')));
    assert.equal(current.operations.length, 0);
  }
  for (const changed of [{ ...object, sha256: 'invalid' }, { ...object, bytes: 0 }, { ...object, bytes: 11 * 1024 * 1024 }]) {
    await assert.rejects(withUrlFixture(fixture().bench, changed, async () => assert.fail('Must not run')));
  }
  const current = fixture(); current.bench.manifest.bucket = 'production';
  await assert.rejects(withUrlFixture(current.bench, object, async () => assert.fail('Must not run')));
});

test('an existing fixture name or externalIP collision is never adopted', async () => {
  for (const sameName of [false, true]) {
    const current = fixture();
    current.services.push({ apiVersion: 'v1', kind: 'Service', metadata: { name: sameName ? 'url-import-source-' + uuid.slice(0, 8) : 'another-service', namespace: 'gthf-recovery', uid: serviceUid, resourceVersion: '1', labels: {} }, spec: { type: 'ClusterIP', externalIPs: sameName ? [] : [URL_FIXTURE_IP], selector: {}, ports: [] } });
    await assert.rejects(withUrlFixture(current.bench, object, async () => assert.fail('Must not run')));
    assert.equal(current.operations.length, 0); assert.equal(current.services.length, 1);
  }
});

test('bad HTTP bytes block the Journey and remove only the owned fixture', async () => {
  const current = fixture(); current.modes.badProbe = true;
  await assert.rejects(withUrlFixture(current.bench, object, async () => assert.fail('Must not run')));
  assert.equal(current.services.length, 0); assert.equal(current.operations.at(-1)?.args[0], 'delete');
});

test('uncertain create result can clean its own token without adopting another Service', async () => {
  const current = fixture(); current.modes.uncertainCreate = true;
  await assert.rejects(withUrlFixture(current.bench, object, async () => assert.fail('Must not run')), /connection lost/);
  assert.deepEqual(current.operations.map((entry) => entry.args[0]), ['create', 'delete']);
  assert.equal(current.services.length, 0);
});

test('cleanup refuses replaced Service, namespace or changed reservation', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.services[0].metadata.uid = namespaceUid; },
    (f: ReturnType<typeof fixture>) => { f.services[0].metadata.labels[owner + 'url-fixture-token'] = 'foreign'; },
    (f: ReturnType<typeof fixture>) => { f.services[0].spec.externalIPs = ['8.8.8.8']; },
    (f: ReturnType<typeof fixture>) => { f.namespace.metadata.uid = serviceUid; },
    (f: ReturnType<typeof fixture>) => { f.state.runId = 'gthf-recovery-other'; },
  ]) {
    const current = fixture();
    await assert.rejects(withUrlFixture(current.bench, object, async () => { change(current); }));
    assert.equal(current.services.length, 1);
    assert.ok(!current.operations.some((entry) => entry.args[0] === 'delete'));
  }
});

test('API delete precondition failure is surfaced and never retried without its guard', async () => {
  const current = fixture(); current.modes.deleteConflict = true;
  await assert.rejects(withUrlFixture(current.bench, object, async () => 'receipt'), /precondition/);
  assert.equal(current.services.length, 1);
  assert.equal(current.operations.filter((entry) => entry.args[0] === 'delete').length, 1);
});
