import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { canonicalRuntimeReference, convergenceProfile, GATEWAY_OBSERVER, PublicConvergenceJourney } from '../scripts/recovery/convergence.mjs';

const uuid = '22222222-2222-4222-8222-222222222222';
const token = '33333333-3333-4333-8333-333333333333';
const namespaceUid = '44444444-4444-4444-8444-444444444444';
const prefix = 'qualification.infra-sincere/';
const image = (revision: string, digest: string) => ({ ref: 'gthf/frontend@sha256:' + digest.repeat(64), canonicalRef: 'docker.io/gthf/frontend@sha256:' + digest.repeat(64), digest: 'sha256:' + digest.repeat(64), runtimeManifestDigest: 'sha256:' + revision.repeat(64), revision: revision.repeat(40) });
function fixture() {
  const manifest = { target: 'vm', namespace: 'gthf-recovery', consumer: 'gthf', runId: 'gthf-recovery-convergence-test', vm: { uuid, hostname: 'infra-qualification-vm' }, database: 'synthetic', bucket: 'synthetic',
    images: { frontend: image('a', 'b'), cms: image('c', 'd'), postgres: image('e', 'f'), minio: image('1', '2') } };
  return { manifest, previous: { ...manifest, images: { ...manifest.images, frontend: image('3', '4') } } };
}

test('convergence uses distinct real frontend images, production preStop and the existing gateway without modifying its Agent', () => {
  const { manifest, previous } = fixture();
  const plan = convergenceProfile(manifest, previous, {}, token, 'private synthetic password', 'private synthetic key');
  const workloads = plan.resources.filter((resource: { kind: string }) => resource.kind === 'Deployment');
  assert.deepEqual(workloads.map((resource: { metadata: { name: string } }) => resource.metadata.name), ['gthf-frontend', 'gthf-convergence-stale', 'gthf-convergence-gateway']);
  for (const deployment of workloads) {
    assert.equal(deployment.metadata.namespace, 'gthf-recovery');
    assert.equal(deployment.metadata.labels[prefix + 'convergence-token'], token);
    assert.equal(deployment.spec.template.metadata.labels[prefix + 'uuid'], uuid);
    assert.equal(deployment.spec.template.spec.automountServiceAccountToken, false);
  }
  const old = workloads[0];
  assert.deepEqual(old.spec.strategy, { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } });
  assert.equal(old.spec.template.spec.containers[0].image, plan.images.previous.image);
  assert.equal(old.spec.template.spec.initContainers[0].image, plan.images.previous.image);
  assert.deepEqual(old.spec.template.spec.containers[0].lifecycle.preStop.exec.command, ['node', '-e', 'setTimeout(()=>{},10000)']);
  assert.equal(old.spec.template.spec.containers[0].readinessProbe.httpGet.path, '/api/serving');
  assert.equal(workloads[2].spec.template.spec.containers[0].image, plan.images.candidate.image);
  assert.deepEqual(workloads[2].spec.template.spec.containers[0].command, ['node', '/recovery/observer.mjs']);
  assert.match(GATEWAY_OBSERVER, /from '\/app\/staging-gateway.mjs'/);
  assert.doesNotMatch(GATEWAY_OBSERVER, /new Agent|keepAlive|maxSockets|globalAgent\s*=|globalAgent\.[A-Za-z]+\s*=/);
  assert.ok(plan.resources.filter((resource: {kind:string}) => resource.kind === 'Service').every((resource: {spec:{type:string}}) => resource.spec.type === 'ClusterIP'));
  assert.ok(!plan.resources.some((resource: {kind:string}) => ['PersistentVolumeClaim', 'PersistentVolume', 'Namespace'].includes(resource.kind)));
});

test('convergence guard refuses foreign ownership, network, namespace and VM before any action', async () => {
  for (const change of [
    (value: ReturnType<typeof fixture>['manifest'], state: Record<string, unknown>) => { state.consumer = 'other'; },
    (value: ReturnType<typeof fixture>['manifest'], state: Record<string, unknown>) => { state.runId = 'other'; },
    (value: ReturnType<typeof fixture>['manifest'], state: Record<string, unknown>) => { state.uuid = token; },
    (value: ReturnType<typeof fixture>['manifest'], state: Record<string, unknown>) => { state.networkMode = 'bootstrap'; },
    (value: ReturnType<typeof fixture>['manifest']) => { value.target = 'production'; },
    (value: ReturnType<typeof fixture>['manifest']) => { value.namespace = 'gthf-staging'; },
  ]) {
    const { manifest } = fixture();
    const state = { consumer: 'gthf', runId: manifest.runId, uuid, hostname: 'infra-qualification-vm', networkMode: 'isolated', running: true, sshReady: true };
    change(manifest, state);
    const journey = new PublicConvergenceJourney({ manifest, status: async () => state, kubeJson: async () => { throw Error('Must refuse before namespace access'); } }, '/private/previous', '/private/evidence');
    await assert.rejects(journey.guard(namespaceUid));
  }
});

test('convergence resource identity never adopts replacement UIDs or a previous attempt', () => {
  const { manifest } = fixture(); const journey = new PublicConvergenceJourney({ manifest }, '/private/previous', '/private/evidence');
  const resource = { metadata: { namespace: 'gthf-recovery', uid: namespaceUid, labels: { [prefix+'uuid']:uuid,[prefix+'run-id']:manifest.runId,[prefix+'convergence-token']:token } } };
  assert.equal(journey.owned(resource, token, namespaceUid), resource);
  assert.throws(()=>journey.owned(resource,token,uuid),/replaced/);
  assert.throws(()=>journey.owned(resource,uuid,namespaceUid));
  assert.throws(()=>journey.owned({metadata:{...resource.metadata,namespace:'gthf-staging'}},token,namespaceUid));
});


test('the real driver attests the Service TCP tuple against its unique ready old Pod endpoint', () => {
  const result = execFileSync('python3', ['-B', '-c', `
import importlib.util
spec = importlib.util.spec_from_file_location('driver', 'scripts/recovery/convergence-driver.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
service = {'metadata': {'uid': 'service-uid'}, 'spec': {'clusterIP': '10.152.183.12'}}
pod = {'metadata': {'uid': 'pod-uid'}, 'status': {'podIP': '10.1.2.3'}}
endpoint = {'addresses': ['10.1.2.3'], 'targetRef': {'uid': 'pod-uid'}, 'conditions': {'ready': True}}
slices = [{'metadata': {'ownerReferences': [{'kind': 'Service', 'uid': 'service-uid'}]}, 'endpoints': [endpoint]}]
socket = {'localAddress': '10.1.2.8', 'localPort': 43100, 'remoteAddress': '::ffff:10.152.183.12', 'remotePort': 3000}
assert module.old_upstream_proof(service, pod, slices, [socket, socket]) == socket
for changed_slices, changed_events in [
  (slices, [socket, {**socket, 'remoteAddress': '10.1.2.3'}]),
  (slices, [socket, {**socket, 'localAddress': '10.1.2.9'}]),
  (slices, [socket, {**socket, 'remotePort': 3001}]),
  ([], [socket, socket]),
  ([{**slices[0], 'endpoints': [{**endpoint, 'targetRef': {'uid': 'other'}}]}], [socket, socket]),
  ([{**slices[0], 'endpoints': [endpoint, {**endpoint, 'addresses': ['10.1.2.4']}]}], [socket, socket]),
  ([{**slices[0], 'metadata': {'ownerReferences': [{'kind': 'Service', 'uid': 'other'}]}}], [socket, socket]),
  ([{**slices[0], 'endpoints': [{**endpoint, 'conditions': {'ready': False}}]}], [socket, socket]),
]:
  try: module.old_upstream_proof(service, pod, changed_slices, changed_events)
  except RuntimeError: pass
  else: raise AssertionError('A foreign socket or endpoint was accepted')
print('service and full TCP identity checked')
`], { cwd: process.cwd(), encoding: 'utf8' });
  assert.match(result, /service and full TCP identity checked/);
});


test('the real driver cannot certify an outage as a continuously old frontend or vice versa', () => {
  const result = execFileSync('python3', ['-B', '-c', `
import importlib.util
spec = importlib.util.spec_from_file_location('driver', 'scripts/recovery/convergence-driver.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
old = {'revision': 'old', 'expectedRevision': False}
error = {'transportError': 'HTTPError'}
def proof(values, calls=2): return {'httpCalls': calls, 'observations': [{'observations': values}]}
assert module.failure_observations(proof([old, old]), previous_revision='old') == [old, old]
assert module.failure_observations(proof([error, error])) == [error, error]
assert module.failure_observations(proof([old, old, {'oldPods': []}]), previous_revision='old') == [old, old]
for value, revision in [
  (proof([error, error]), 'old'),
  (proof([old, error]), 'old'),
  (proof([old, old]), None),
  (proof([error, old]), None),
  (proof([old, old], calls=0), 'old'),
  (proof([old, {}, old]), 'old'),
  (proof([{}, {}]), None),
  (proof([{'revision': 'new', 'expectedRevision': True}]), 'old'),
]:
  try: module.failure_observations(value, previous_revision=revision)
  except RuntimeError: pass
  else: raise AssertionError('The wrong failure scenario was certified')
print('old release and outage evidence kept distinct')
`], { cwd: process.cwd(), encoding: 'utf8' });
  assert.match(result, /old release and outage evidence kept distinct/);
});


function runtimeFixture({ badPlatform = false, badRevision = false, wrongConfigLink = false } = {}) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value));
  const digest = (value: Buffer) => 'sha256:' + createHash('sha256').update(value).digest('hex');
  const config = encode({ os: 'linux', architecture: badPlatform ? 'arm64' : 'amd64', config: { Labels: { 'org.opencontainers.image.revision': (badRevision ? 'b' : 'a').repeat(40) } } });
  const runtime = encode({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { digest: wrongConfigLink ? 'sha256:' + '0'.repeat(64) : digest(config), size: config.length }, layers: [] });
  const image = { canonicalRef: 'docker.io/library/gthf-frontend@sha256:' + 'c'.repeat(64), digest: 'sha256:' + 'c'.repeat(64), runtimeManifestDigest: digest(runtime), runtimeConfigDigest: digest(config), revision: 'a'.repeat(40) };
  return { image, runtime, config };
}

function runtimeBench(fixture: ReturnType<typeof runtimeFixture>, { existing = false, indexAlias = false, changedDigest = false, alteredConfig = false } = {}) {
  let registered = existing;
  const calls: string[][] = [];
  const target = canonicalRuntimeReference(fixture.image);
  const bench = {
    manifest: {}, event: () => {},
    guest: async (args: string[]) => {
      calls.push(args);
      if (args[4] === 'images' && args[5] === 'ls') {
        const header = 'REF TYPE DIGEST SIZE PLATFORMS LABELS\n';
        const type = indexAlias ? 'application/vnd.oci.image.index.v1+json' : 'application/vnd.oci.image.manifest.v1+json';
        const observedDigest = indexAlias || changedDigest ? fixture.image.digest : fixture.image.runtimeManifestDigest;
        return { stdout: Buffer.from(header + (registered ? target + ' ' + type + ' ' + observedDigest + ' 1MiB linux/amd64 -\n' : '')) };
      }
      if (args[4] === 'content' && args[5] === 'get') {
        return { stdout: args[6] === fixture.image.runtimeManifestDigest ? fixture.runtime : alteredConfig ? Buffer.from('{}') : fixture.config };
      }
      throw Error('Unexpected test command');
    },
  };
  const journey = new PublicConvergenceJourney(bench, '/private/previous', '/private/evidence');
  journey.importRuntimeArchive = async (image: typeof fixture.image) => { calls.push(['runtime-archive', image.canonicalRef]); registered = true; };
  return { journey, calls };
}

test('convergence registers and proves a real single-platform target, preserving the exact runtime and configuration digests', async () => {
  const fixture = runtimeFixture(); const { journey, calls } = runtimeBench(fixture);
  const proof = await journey.materializeRuntime(fixture.image);
  const imports = calls.filter((call) => call[0] === 'runtime-archive');
  assert.deepEqual(imports, [['runtime-archive', fixture.image.canonicalRef]]);
  assert.equal(proof.runtimeManifestDigest, fixture.image.runtimeManifestDigest);
  assert.equal(proof.runtimeConfigDigest, fixture.image.runtimeConfigDigest);
  const reused = runtimeBench(fixture, { existing: true });
  await reused.journey.materializeRuntime(fixture.image);
  assert.equal(reused.calls.some((call) => call[0] === 'runtime-archive'), false);
});

test('convergence refuses an index disguised as runtime, a changed import, or incorrect configuration without overwriting existing references', async () => {
  for (const options of [{ existing: true, indexAlias: true }, { changedDigest: true }, { alteredConfig: true }]) {
    const fixture = runtimeFixture(); const { journey, calls } = runtimeBench(fixture, options);
    await assert.rejects(journey.materializeRuntime(fixture.image));
    if (options.existing) assert.equal(calls.some((call) => call[0] === 'runtime-archive'), false);
  }
  for (const options of [{ badPlatform: true }, { badRevision: true }, { wrongConfigLink: true }]) {
    const fixture = runtimeFixture(options); const { journey } = runtimeBench(fixture);
    await assert.rejects(journey.materializeRuntime(fixture.image));
  }
});
