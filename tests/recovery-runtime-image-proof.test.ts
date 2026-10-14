import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { runtimeImageProof } from '../scripts/recovery/runtime-image-proof.mjs';
import { verifyImages } from '../scripts/recovery/prepare-vm.mjs';

const INDEX = 'application/vnd.oci.image.index.v1+json';
const MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const CONFIG = 'application/vnd.oci.image.config.v1+json';
const hash = (data: Buffer) => 'sha256:' + createHash('sha256').update(data).digest('hex');
function graph(configChanges = {}) {
  const blobs = new Map<string, Buffer>();
  function blob(value: object, mediaType: string) {
    const bytes = Buffer.from(JSON.stringify(value)); const digest = hash(bytes); blobs.set(digest, bytes);
    return { digest, size: bytes.length, mediaType };
  }
  const config = blob({ os: 'linux', architecture: 'amd64', config: { Labels: { 'org.opencontainers.image.revision': 'a'.repeat(40), 'io.gthf.media-recovery': '2', 'io.gthf.media-batch-recovery': '1' } }, rootfs: { type: 'layers', diff_ids: ['sha256:' + '1'.repeat(64)] }, ...configChanges }, CONFIG);
  const runtime = blob({ schemaVersion: 2, mediaType: MANIFEST, config, layers: [{ digest: 'sha256:' + '2'.repeat(64), size: 7, mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip' }] }, MANIFEST);
  const platform = { os: 'linux', architecture: 'amd64' };
  const root = blob({ schemaVersion: 2, mediaType: INDEX, manifests: [{ ...runtime, platform }], annotations: { fixture: 'candidate' } }, INDEX);
  const index = (manifests: object[] = [{ ...runtime, platform }]) => blob({ schemaVersion: 2, mediaType: INDEX, manifests, annotations: { fixture: 'alias' } }, INDEX);
  const alias = index();
  const expected = { ref: 'gthf-fixture@' + root.digest, digest: root.digest, runtimeManifestDigest: runtime.digest, runtimeConfigDigest: config.digest, revision: 'a'.repeat(40) };
  const reads: string[] = [];
  const read = async (digest: string) => { reads.push(digest); const bytes = blobs.get(digest); assert.ok(bytes, 'Missing fixture blob'); return bytes; };
  const input = { image: expected.ref, imageID: 'docker.io/library/gthf-fixture@' + alias.digest, expected };
  return { blobs, blob, config, runtime, root, alias, index, platform, expected, reads, read, input };
}

test('alternate index is accepted only through exact runtime/config hashes and records its layers', async () => {
  const fixture = graph();
  const proof = await runtimeImageProof(fixture.input, fixture.read);
  assert.deepEqual(proof, { kind: 'verified-runtime-index-alias', observedDigest: fixture.alias.digest, candidateDigest: fixture.root.digest, runtimeManifestDigest: fixture.runtime.digest, runtimeConfigDigest: fixture.config.digest, platform: 'linux/amd64', layerDigests: ['sha256:' + '2'.repeat(64)] });
  assert.deepEqual(fixture.reads, [fixture.alias.digest, fixture.runtime.digest, fixture.config.digest]);
});

test('the exact pod reference remains mandatory even when runtime bytes match', async () => {
  const fixture = graph();
  await assert.rejects(runtimeImageProof({ ...fixture.input, image: 'foreign@' + fixture.root.digest }, fixture.read), /exact candidate/);
  assert.deepEqual(fixture.reads, []);
});

test('existing pinned digest forms remain accepted and malformed identifiers fail closed', async () => {
  const fixture = graph();
  for (const digest of [fixture.root.digest, fixture.runtime.digest, fixture.config.digest]) {
    assert.deepEqual(await runtimeImageProof({ ...fixture.input, imageID: 'containerd://' + digest }, fixture.read), { observedDigest: digest, kind: 'pinned-digest' });
  }
  await assert.rejects(runtimeImageProof({ ...fixture.input, imageID: 'fixture:latest' }, fixture.read));
  assert.deepEqual(fixture.reads, []);
});

test('tampered index, runtime or config bytes are rejected by SHA256', async () => {
  for (const select of [(f: ReturnType<typeof graph>) => f.alias, (f: ReturnType<typeof graph>) => f.runtime, (f: ReturnType<typeof graph>) => f.config]) {
    const fixture = graph(); const digest = select(fixture).digest;
    const original = fixture.blobs.get(digest)!;
    const damaged = Buffer.from(original); damaged[damaged.length - 2] ^= 1; fixture.blobs.set(digest, damaged);
    await assert.rejects(runtimeImageProof(fixture.input, fixture.read), /SHA256/);
  }
});

test('ambiguous, foreign-platform and non-manifest index entries are refused', async () => {
  for (const entries of [
    (f: ReturnType<typeof graph>) => [{ ...f.runtime, platform: f.platform }, { ...f.runtime, platform: f.platform }],
    (f: ReturnType<typeof graph>) => [{ ...f.runtime, platform: { os: 'linux', architecture: 'arm64' } }],
    (f: ReturnType<typeof graph>) => [{ ...f.runtime, mediaType: INDEX, platform: f.platform }],
  ]) {
    const fixture = graph(); const alias = fixture.index(entries(fixture));
    await assert.rejects(runtimeImageProof({ ...fixture.input, imageID: alias.digest }, fixture.read));
  }
});

test('sharing a configuration digest cannot authorize a different runtime manifest', async () => {
  const fixture = graph();
  const original = JSON.parse(fixture.blobs.get(fixture.runtime.digest)!.toString());
  const different = fixture.blob({ ...original, annotations: { changed: 'runtime' } }, MANIFEST);
  const alias = fixture.index([{ ...different, platform: fixture.platform }]);
  await assert.rejects(runtimeImageProof({ ...fixture.input, imageID: alias.digest }, fixture.read), /runtime manifest must exactly match/);
  assert.deepEqual(fixture.reads, [alias.digest]);
});

test('wrong config, descriptor size, platform or absent content cannot resolve an alias', async () => {
  const wrongConfig = graph();
  await assert.rejects(runtimeImageProof({ ...wrongConfig.input, expected: { ...wrongConfig.expected, runtimeConfigDigest: 'sha256:' + '0'.repeat(64) } }, wrongConfig.read), /configuration must exactly match/);
  const wrongSize = graph(); const alias = wrongSize.index([{ ...wrongSize.runtime, size: wrongSize.runtime.size + 1, platform: wrongSize.platform }]);
  await assert.rejects(runtimeImageProof({ ...wrongSize.input, imageID: alias.digest }, wrongSize.read), /size differs/);
  const wrongPlatform = graph({ architecture: 'arm64' });
  await assert.rejects(runtimeImageProof(wrongPlatform.input, wrongPlatform.read));
  const absent = graph(); absent.blobs.delete(absent.alias.digest);
  await assert.rejects(runtimeImageProof(absent.input, absent.read), /Missing fixture blob/);
});

test('verifyImages records the cryptographic alias proof for the actual pod and initializer', async () => {
  const fixture = graph(); const uuid = '22222222-2222-4222-8222-222222222222';
  const pods = ['postgres', 'minio', 'cms', 'frontend-a', 'frontend-b'].map((component) => {
    const init = component.startsWith('frontend-');
    return { metadata: { uid: component + '-uid', labels: { 'app.kubernetes.io/component': component, 'qualification.infra-sincere/uuid': uuid } }, spec: { containers: [{ name: component, image: fixture.expected.ref }], ...(init ? { initContainers: [{ name: 'seed-next-app-cache', image: fixture.expected.ref }] } : {}) }, status: { phase: 'Running', containerStatuses: [{ name: component, imageID: component === 'minio' ? fixture.input.imageID : fixture.config.digest, ready: true, state: { running: {} } }], ...(init ? { initContainerStatuses: [{ name: 'seed-next-app-cache', imageID: fixture.input.imageID, state: { terminated: { exitCode: 0 } } }] } : {}) } };
  });
  const events: { event: string; pods: { component: string; containers: { runtimeProof: { kind: string } }[]; initContainers: { runtimeProof: { kind: string } }[] }[] }[] = [];
  const bench = { manifest: { vm: { uuid }, images: Object.fromEntries(['postgres', 'minio', 'cms', 'frontend'].map((name) => [name, fixture.expected])) },
    guest: async (args: string[]) => { assert.deepEqual(args.slice(0, -1), ['sudo', '-n', '/snap/bin/microk8s', 'ctr', 'content', 'get']); return { stdout: await fixture.read(args.at(-1)!) }; },
    kubeJson: async () => ({ items: pods }), event: (event: typeof events[number]) => { events.push(event); } };
  await verifyImages(bench);
  assert.equal(events.length, 1); assert.equal(events[0].event, 'candidate-images-verified');
  assert.equal(events[0].pods.find((pod) => pod.component === 'minio')?.containers[0].runtimeProof.kind, 'verified-runtime-index-alias');
  assert.equal(events[0].pods.find((pod) => pod.component === 'frontend-a')?.initContainers[0].runtimeProof.kind, 'verified-runtime-index-alias');
  events.splice(0); pods[1].spec.containers[0].image = 'foreign@' + fixture.root.digest;
  await assert.rejects(verifyImages(bench), /references must match/);
  assert.equal(events.length, 0);
});
