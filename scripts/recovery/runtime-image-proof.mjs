import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const INDEX_TYPES = new Set(['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json']);
const MANIFEST_TYPES = new Set(['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json']);
const CONFIG_TYPES = new Set(['application/vnd.oci.image.config.v1+json', 'application/vnd.docker.container.image.v1+json']);

/** Resolve containerd's alternate index name by exact executable graph, never config alone. */
export async function runtimeImageProof({ image, imageID, expected }, readBlob) {
  assert.equal(image, expected.ref, 'Container specification must use the exact candidate reference');
  const pinned = [expected.digest, expected.runtimeManifestDigest, expected.runtimeConfigDigest];
  for (const digest of pinned) assert.match(digest, DIGEST);
  const observed = /(?:^|@|:\/\/)(sha256:[a-f0-9]{64})$/.exec(imageID ?? '')?.[1];
  assert.ok(observed, 'Runtime image ID must contain a SHA256 digest');
  if (pinned.includes(observed)) return { observedDigest: observed, kind: 'pinned-digest' };

  async function verifiedBlob(digest, size) {
    assert.match(digest, DIGEST);
    const data = await readBlob(digest);
    assert.ok(Buffer.isBuffer(data) && data.length > 0 && data.length <= 16 * 1024 * 1024, 'Bounded OCI metadata bytes required');
    if (size !== undefined) assert.equal(data.length, size, 'OCI descriptor size differs from content');
    assert.equal('sha256:' + createHash('sha256').update(data).digest('hex'), digest, 'OCI metadata SHA256 mismatch');
    let value;
    try { value = JSON.parse(data.toString()); }
    catch { throw new Error('OCI metadata is not JSON'); }
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'OCI metadata object required');
    return value;
  }
  function descriptor(value) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'OCI descriptor required');
    assert.match(value.digest, DIGEST);
    assert.ok(Number.isSafeInteger(value.size) && value.size > 0 && value.size <= 16 * 1024 * 1024, 'Bounded OCI descriptor required');
  }

  const index = await verifiedBlob(observed);
  assert.equal(index.schemaVersion, 2);
  assert.ok(INDEX_TYPES.has(index.mediaType) && Array.isArray(index.manifests), 'Unknown runtime ID must resolve to an OCI image index');
  const runtimes = index.manifests.filter((entry) => entry?.platform?.os === 'linux' && entry?.platform?.architecture === 'amd64');
  assert.equal(runtimes.length, 1, 'Exactly one Linux amd64 runtime descriptor is required');
  const runtime = runtimes[0]; descriptor(runtime);
  assert.ok(MANIFEST_TYPES.has(runtime.mediaType), 'An executable OCI manifest is required');
  assert.equal(runtime.digest, expected.runtimeManifestDigest, 'Alias runtime manifest must exactly match the candidate');
  const manifest = await verifiedBlob(runtime.digest, runtime.size);
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.mediaType, runtime.mediaType);
  assert.ok(Array.isArray(manifest.layers), 'OCI layer descriptors are required');
  descriptor(manifest.config);
  assert.ok(CONFIG_TYPES.has(manifest.config.mediaType));
  assert.equal(manifest.config.digest, expected.runtimeConfigDigest, 'Alias configuration must exactly match the candidate');
  const config = await verifiedBlob(manifest.config.digest, manifest.config.size);
  assert.equal(config.os, 'linux'); assert.equal(config.architecture, 'amd64');
  assert.equal(config.rootfs?.type, 'layers');
  assert.ok(Array.isArray(config.rootfs.diff_ids));
  assert.equal(config.rootfs.diff_ids.length, manifest.layers.length, 'OCI configuration and layer counts differ');
  for (const digest of config.rootfs.diff_ids) assert.match(digest, DIGEST);
  for (const layer of manifest.layers) {
    assert.match(layer.digest, DIGEST);
    assert.ok(Number.isSafeInteger(layer.size) && layer.size >= 0);
  }
  return { kind: 'verified-runtime-index-alias', observedDigest: observed,
    candidateDigest: expected.digest, runtimeManifestDigest: runtime.digest,
    runtimeConfigDigest: manifest.config.digest, platform: 'linux/amd64',
    layerDigests: manifest.layers.map((layer) => layer.digest) };
}
