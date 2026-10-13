import assert from 'node:assert/strict';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const EVIDENCE_ROOT = '/home/ubuntu/.local/state/infra-sincere/qualification-vm';
export const NAMESPACE = 'gthf-recovery';
export const GUEST_ROOT = '/var/lib/gthf-recovery';
const sha = /^[a-f0-9]{40}$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

/** Do not follow any symlink, including a symlink in a parent directory. */
export function requireRegularPath(path, { directory = false, privateFile = false } = {}) {
  assert.ok(isAbsolute(path), 'An absolute path is required');
  const normalized = resolve(path);
  assert.equal(path, normalized, 'A canonical path is required');
  let component = sep;
  for (const part of normalized.split(sep).filter(Boolean)) {
    component = join(component, part);
    assert.ok(!lstatSync(component).isSymbolicLink(), 'Symbolic paths are refused');
  }
  const stat = lstatSync(path);
  assert.ok(directory ? stat.isDirectory() : stat.isFile(), 'Unexpected path type');
  assert.equal(realpathSync(path), path, 'Unexpected path resolution');
  if (privateFile) {
    assert.equal(stat.uid, process.getuid(), 'Private file belongs to another user');
    assert.equal(stat.mode & 0o077, 0, 'Private file is accessible to other users');
  }
  return path;
}

export function validateManifest(value, { target, infraRevision } = {}) {
  assert.equal(target, 'vm', 'The only recovery target is the isolated VM');
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.consumer, 'gthf');
  assert.match(value.runId, /^gthf-recovery-[a-z0-9-]{1,64}$/);
  assert.equal(value.target, 'vm');
  assert.equal(value.namespace, NAMESPACE);
  assert.equal(value.vm.hostname, 'infra-qualification-vm');
  assert.equal(value.vm.service, 'infra-qualification-vm.service');
  assert.match(value.vm.uuid, uuid);
  assert.equal(value.vm.host, 'game-prod-ovh-gra');
  assert.equal(value.vm.microk8sVersion, '1.35.6');
  assert.equal(value.vm.microk8sRevision, '9072');
  assert.equal(value.sourceRevisions.infra, infraRevision, 'Infrastructure revision is not pinned');
  for (const component of ['infra', 'cms', 'frontend']) assert.match(value.sourceRevisions[component], sha);
  for (const component of ['postgres', 'minio', 'cms', 'frontend']) {
    const image = value.images[component];
    for (const field of ['digest', 'runtimeManifestDigest', 'runtimeConfigDigest', 'imageId']) {
      assert.match(image[field], digest, component + ' requires an exact nonempty ' + field);
    }
    assert.match(image.ref, /^[a-z0-9][a-z0-9./_-]*(?::[A-Za-z0-9_.-]+)?@sha256:[a-f0-9]{64}$/);
    assert.equal(image.ref.split('@')[1], image.digest);
    assert.ok(!/[\s\\]/.test(image.ref));
    const repository = image.ref.split('@')[0];
    const canonical = !repository.includes('/') ? 'docker.io/library/' + repository
      : !/[.:]/.test(repository.split('/')[0]) ? 'docker.io/' + repository : repository;
    assert.equal(image.canonicalRef, canonical + '@' + image.digest, 'OCI import name must normalize the candidate reference');
    assert.equal(image.imageId, image.runtimeConfigDigest, 'Runtime image ID must be linked to the OCI configuration');
    if (component === 'cms' || component === 'frontend') assert.equal(image.revision, value.sourceRevisions[component]);
  }
  assert.equal(value.guestRoot, GUEST_ROOT);
  assert.equal(value.database, 'gthf_recovery_' + value.vm.uuid.replaceAll('-', ''));
  assert.equal(value.bucket, 'gthf-recovery-' + value.vm.uuid);
  // Origins and database/object-store addresses are built by the profile. They
  // cannot be supplied by a campaign file and redirected to production.
  for (const key of ['origins', 'databaseUrl', 's3Endpoint', 'kubeconfig', 'sshCommand', 'credentials']) {
    assert.ok(!(key in value), 'Connection overrides and credentials are refused');
  }
  return value;
}

export function loadManifest(path, options) {
  requireRegularPath(path, { privateFile: true });
  const value = validateManifest(JSON.parse(readFileSync(path, 'utf8')), options);
  const campaignRoot = join(EVIDENCE_ROOT, value.runId);
  assert.equal(dirname(path), campaignRoot, 'Manifest is outside its campaign');
  requireRegularPath(campaignRoot, { directory: true, privateFile: true });
  assert.ok(!relative(EVIDENCE_ROOT, path).startsWith('..'));
  return { value, campaignRoot };
}

export function verifyReservation(manifest, status) {
  assert.equal(status.consumer, manifest.consumer, 'Another consumer owns the bench');
  assert.equal(status.runId, manifest.runId, 'Another campaign owns the bench');
  assert.equal(status.uuid, manifest.vm.uuid, 'VM identity mismatch');
  assert.equal(status.hostname, manifest.vm.hostname, 'Guest identity mismatch');
  return status;
}

export function publishedImage(candidate, component, revision, deployerRevision) {
  assert.ok(['cms', 'frontend'].includes(component));
  assert.match(revision, sha); assert.match(deployerRevision, sha);
  assert.equal(candidate.publication.component, component);
  assert.equal(candidate.publication.repository, 'thedamfr/gthf-' + component);
  assert.equal(candidate.publication.revision, revision);
  assert.equal(candidate.deployerRevision, deployerRevision);
  const image = candidate.components[component];
  assert.equal(image.processedRevision, revision);
  assert.equal(image.revision, revision, 'Recovery qualifies the exact image source revision');
  assert.match(image.image, new RegExp('^ghcr\\.io/thedamfr/gthf-' + component + '@sha256:[a-f0-9]{64}$'));
  return image.image;
}
