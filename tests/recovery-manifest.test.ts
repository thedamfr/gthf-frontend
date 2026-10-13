import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { publishedImage, requireRegularPath, validateManifest, verifyReservation } from '../scripts/recovery/manifest.mjs';
import { verifyImages } from '../scripts/recovery/prepare-vm.mjs';
import { COMPONENTS } from '../scripts/recovery/profile.mjs';

const revision = 'a'.repeat(40);
const id = '8eaed012-8eca-48e7-8cda-781e4d0762ab';
function fixture() {
  const image = { ref: 'recovery/image@sha256:' + 'b'.repeat(64), digest: 'sha256:' + 'b'.repeat(64),
    canonicalRef: 'docker.io/recovery/image@sha256:' + 'b'.repeat(64),
    runtimeManifestDigest: 'sha256:' + 'c'.repeat(64), runtimeConfigDigest: 'sha256:' + 'd'.repeat(64), imageId: 'sha256:' + 'd'.repeat(64), revision };
  return {
    schemaVersion: 1, target: 'vm', namespace: 'gthf-recovery', consumer: 'gthf', runId: 'gthf-recovery-test',
    vm: { uuid: id, host: 'game-prod-ovh-gra', hostname: 'infra-qualification-vm', service: 'infra-qualification-vm.service', microk8sVersion: '1.35.6', microk8sRevision: '9072' },
    sourceRevisions: { infra: revision, cms: revision, frontend: revision },
    images: { cms: { ...image }, frontend: { ...image }, postgres: { ...image }, minio: { ...image } },
    guestRoot: '/var/lib/gthf-recovery', database: 'gthf_recovery_' + id.replaceAll('-', ''), bucket: 'gthf-recovery-' + id,
  };
}
const options = { target: 'vm', infraRevision: revision };
test('published recovery refuses a foreign image, source revision or deployer before any registry pull', () => {
  const image = 'ghcr.io/thedamfr/gthf-cms@sha256:' + 'b'.repeat(64);
  const candidate = { publication: { component: 'cms', repository: 'thedamfr/gthf-cms', revision }, deployerRevision: revision,
    components: { cms: { image, revision, processedRevision: revision } } };
  assert.equal(publishedImage(candidate, 'cms', revision, revision), image);
  for (const change of [
    (value: typeof candidate) => { value.components.cms.image = image.replace('gthf-cms', 'foreign'); },
    (value: typeof candidate) => { value.components.cms.image = 'ghcr.io/thedamfr/gthf-cms:latest'; },
    (value: typeof candidate) => { value.components.cms.revision = 'c'.repeat(40); },
    (value: typeof candidate) => { value.publication.revision = 'c'.repeat(40); },
    (value: typeof candidate) => { value.deployerRevision = 'c'.repeat(40); },
    (value: typeof candidate) => { value.publication.repository = 'thedamfr/other'; },
  ]) { const value = structuredClone(candidate); change(value); assert.throws(() => publishedImage(value, 'cms', revision, revision)); }
});
test('recovery refuses an unknown target, production configuration and unpinned artifacts', () => {
  assert.doesNotThrow(() => validateManifest(fixture(), options));
  assert.throws(() => validateManifest(fixture(), { ...options, target: 'production' }));
  for (const change of [
    (m: ReturnType<typeof fixture>) => { m.namespace = 'gthf-staging'; },
    (m: ReturnType<typeof fixture>) => { m.database = 'gthdf'; },
    (m: ReturnType<typeof fixture>) => { m.bucket = 'gthdf-staging-media'; },
    (m: ReturnType<typeof fixture>) => { m.sourceRevisions.infra = 'c'.repeat(40); },
    (m: ReturnType<typeof fixture>) => { m.images.cms.ref = 'gthf:latest'; },
    (m: ReturnType<typeof fixture>) => { m.images.cms.revision = 'd'.repeat(40); },
    (m: ReturnType<typeof fixture>) => { m.images.cms.canonicalRef = 'docker.io/foreign/image@' + m.images.cms.digest; },
    (m: ReturnType<typeof fixture>) => { m.images.cms.imageId = 'sha256:' + 'f'.repeat(64); },
    (m: ReturnType<typeof fixture>) => { Object.assign(m, { origins: { cms: 'https://cms.gthf.fr' } }); },
  ]) {
    const manifest = fixture(); change(manifest);
    assert.throws(() => validateManifest(manifest, options));
  }
});

test('recovery requires complete OCI graph digests and never accepts an empty Docker image identifier', () => {
  for (const field of ['digest', 'runtimeManifestDigest', 'runtimeConfigDigest', 'imageId'] as const) {
    for (const value of ['', 'latest', 'sha256:abc', undefined]) {
      const manifest = fixture();
      Object.assign(manifest.images.frontend, { [field]: value });
      assert.throws(() => validateManifest(manifest, options), field);
    }
  }
});

function runtimeFixture() {
  const manifest = fixture();
  const pods = COMPONENTS.map((component) => {
    const expected = manifest.images[component.startsWith('frontend-') ? 'frontend' : component as keyof typeof manifest.images];
    const init = component.startsWith('frontend-') ? [{ name: 'seed-next-app-cache', image: expected.ref }] : [];
    return {
      metadata: { uid: component + '-uid', labels: { 'app.kubernetes.io/component': component, 'qualification.infra-sincere/uuid': id } },
      spec: { containers: [{ name: component, image: expected.ref }], initContainers: init },
      status: { phase: 'Running', containerStatuses: [{ name: component, ready: true, state: { running: {} }, imageID: 'containerd://' + expected.runtimeConfigDigest }],
        initContainerStatuses: init.map((container) => ({ name: container.name, imageID: 'recovery/image@' + expected.runtimeManifestDigest, state: { terminated: { exitCode: 0 } } })) },
    };
  });
  const events: unknown[] = [];
  return { pods, events, bench: { manifest, kubeJson: async () => ({ items: pods }), event: (value: unknown) => events.push(value) } };
}

test('recovery proves both the running process and the completed Next cache initializer image', async () => {
  const current = runtimeFixture();
  await verifyImages(current.bench);
  assert.equal(current.events.length, 1);
  const evidence = current.events[0] as { pods: Array<{ initContainers: unknown[] }> };
  assert.equal(evidence.pods.filter((pod) => pod.initContainers.length === 1).length, 2);
});

test('recovery refuses old init refs, failed init processes, missing or unlinked runtime digests', async () => {
  const mutations = [
    (value: ReturnType<typeof runtimeFixture>) => { value.pods[3].spec.initContainers[0].image = 'old/image@sha256:' + 'e'.repeat(64); },
    (value: ReturnType<typeof runtimeFixture>) => { value.pods[3].status.initContainerStatuses[0].imageID = 'containerd://sha256:' + 'e'.repeat(64); },
    (value: ReturnType<typeof runtimeFixture>) => { value.pods[3].status.initContainerStatuses[0].state.terminated.exitCode = 1; },
    (value: ReturnType<typeof runtimeFixture>) => { value.pods[3].status.initContainerStatuses = []; },
    (value: ReturnType<typeof runtimeFixture>) => { value.pods[3].spec.initContainers = []; value.pods[3].status.initContainerStatuses = []; },
    (value: ReturnType<typeof runtimeFixture>) => { value.pods[0].status.containerStatuses[0].imageID = ''; },
    (value: ReturnType<typeof runtimeFixture>) => { value.pods[0].status.containerStatuses[0].imageID = 'prefix-sha256:' + 'c'.repeat(64); },
    (value: ReturnType<typeof runtimeFixture>) => { value.pods[0].status.containerStatuses[0].ready = false; },
  ];
  for (const mutate of mutations) {
    const current = runtimeFixture(); mutate(current);
    await assert.rejects(verifyImages(current.bench));
    assert.equal(current.events.length, 0, 'Failure must not publish successful image evidence');
  }
});
test('recovery refuses a foreign reservation even on the same VM', () => {
  const state = { consumer: 'gthf', runId: 'gthf-recovery-test', uuid: id, hostname: 'infra-qualification-vm' };
  assert.doesNotThrow(() => verifyReservation(fixture(), state));
  for (const field of ['consumer', 'runId', 'uuid', 'hostname']) {
    assert.throws(() => verifyReservation(fixture(), { ...state, [field]: 'foreign' }));
  }
});
test('recovery refuses a symlinked parent and exposed credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'gthf-recovery-path-'));
  try {
    const real = join(root, 'real'); mkdirSync(real, { mode: 0o700 });
    const file = join(real, 'manifest.json'); writeFileSync(file, '{}', { mode: 0o600 });
    assert.doesNotThrow(() => requireRegularPath(file, { privateFile: true }));
    symlinkSync(real, join(root, 'alias'));
    assert.throws(() => requireRegularPath(join(root, 'alias', 'manifest.json')));
    const exposed = join(real, 'exposed.json'); writeFileSync(exposed, '{}', { mode: 0o644 });
    assert.throws(() => requireRegularPath(exposed, { privateFile: true }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
