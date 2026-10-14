import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadManifest, NAMESPACE, requireRegularPath } from './manifest.mjs';
import { profile } from './profile.mjs';

const OWNER = 'qualification.infra-sincere/';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const NAMES = Object.freeze({ frontend: 'gthf-frontend', stale: 'gthf-convergence-stale', gateway: 'gthf-convergence-gateway', access: 'gthf-convergence-access', code: 'gthf-convergence-code' });

// This wrapper calls the image's real gateway. It does not replace request(),
// set an Agent, or change any keep-alive option. Only socket tuples are observed.
export const GATEWAY_OBSERVER = `import { globalAgent } from 'node:http';
import { createGateway } from '/app/staging-gateway.mjs';
globalAgent.on('free', (socket) => {
  console.log(JSON.stringify({ event: 'upstream-socket-free', at: Date.now()/1000,
    localAddress: socket.localAddress, localPort: socket.localPort,
    remoteAddress: socket.remoteAddress, remotePort: socket.remotePort }));
});
const server = createGateway(process.env.STAGING_PASSWORD, process.env.STAGING_SESSION_KEY);
server.requestTimeout = 60000;
server.listen(3001, '0.0.0.0');
process.on('SIGTERM', () => server.close());
`;

export function previousCampaign(path, manifest) {
  const raw = JSON.parse(readFileSync(requireRegularPath(path, { privateFile: true }), 'utf8'));
  const { value, campaignRoot } = loadManifest(path, { target: 'vm', infraRevision: raw.sourceRevisions.infra });
  for (const field of ['runId', 'namespace', 'consumer', 'database', 'bucket']) assert.equal(value[field], manifest[field], 'Previous manifest belongs to another campaign');
  assert.deepEqual(value.vm, manifest.vm, 'Previous frontend belongs to another VM');
  assert.notEqual(value.images.frontend.runtimeManifestDigest, manifest.images.frontend.runtimeManifestDigest, 'Two distinct application images are required');
  assert.notEqual(value.images.frontend.revision, manifest.images.frontend.revision, 'Two real source revisions are required');
  return { previous: value, campaignRoot };
}

export function canonicalRuntimeReference(image) {
  assert.equal(image.canonicalRef.split('@')[1], image.digest);
  assert.match(image.runtimeManifestDigest, /^sha256:[a-f0-9]{64}$/);
  return image.canonicalRef.split('@')[0] + '@' + image.runtimeManifestDigest;
}

export function requireRuntimeTarget(output, image) {
  const rows = output.trim().split('\n');
  if (rows.length === 1) { assert.match(rows[0], /^REF\s+TYPE\s+DIGEST\s/); return false; }
  assert.equal(rows.length, 2, 'The runtime reference must be unambiguous');
  const fields = rows[1].trim().split(/\s+/);
  assert.equal(fields[0], canonicalRuntimeReference(image), 'The runtime reference must be canonical');
  assert.ok(['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'].includes(fields[1]), 'The runtime reference must target a manifest, never an index');
  assert.equal(fields[2], image.runtimeManifestDigest, 'The runtime import changed the expected descriptor');
  return true;
}

export function convergenceProfile(manifest, previous, credentials, token, password, sessionKey) {
  assert.match(token, UUID);
  const labels = { [OWNER + 'uuid']: manifest.vm.uuid, [OWNER + 'run-id']: manifest.runId, [OWNER + 'convergence-token']: token };
  const meta = (name) => ({ name, namespace: NAMESPACE, labels: { ...labels } });
  const image = canonicalRuntimeReference;
  const template = profile(manifest, credentials, '').applications.find((item) => item.kind === 'Deployment' && item.metadata.name === 'frontend-a');
  function frontend(name, component) {
    const deployment = structuredClone(template);
    deployment.metadata = meta(name);
    deployment.spec.selector.matchLabels = { ...labels, 'app.kubernetes.io/component': component };
    deployment.spec.template.metadata.labels = { ...deployment.spec.selector.matchLabels };
    deployment.spec.strategy = { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } };
    deployment.spec.template.spec.terminationGracePeriodSeconds = 45;
    const spec = deployment.spec.template.spec;
    spec.containers[0].name = 'frontend'; spec.containers[0].image = image(previous.images.frontend);
    spec.containers[0].lifecycle = { preStop: { exec: { command: ['node', '-e', 'setTimeout(()=>{},10000)'] } } };
    spec.initContainers[0].image = image(previous.images.frontend);
    return deployment;
  }
  const gateway = frontend(NAMES.gateway, 'convergence-gateway');
  const gatewaySpec = gateway.spec.template.spec;
  gatewaySpec.initContainers = [];
  gatewaySpec.volumes = [{ name: 'observer', configMap: { name: NAMES.code } }];
  const container = gatewaySpec.containers[0];
  Object.assign(container, { name: 'gateway', image: image(manifest.images.frontend), command: ['node', '/recovery/observer.mjs'],
    env: ['STAGING_PASSWORD', 'STAGING_SESSION_KEY'].map((name) => ({ name, valueFrom: { secretKeyRef: { name: NAMES.access, key: name } } })),
    ports: [{ containerPort: 3001 }], volumeMounts: [{ name: 'observer', mountPath: '/recovery', readOnly: true }],
    resources: { requests: { cpu: '25m', memory: '64Mi' }, limits: { cpu: '500m', memory: '256Mi' } },
  });
  for (const name of ['readinessProbe', 'startupProbe', 'livenessProbe']) container[name].httpGet = { path: '/_gateway/health', port: 3001 };
  const service = (name, component, port) => ({ apiVersion: 'v1', kind: 'Service', metadata: meta(name), spec: {
    type: 'ClusterIP', selector: { ...labels, 'app.kubernetes.io/component': component }, ports: [{ port, targetPort: port }],
  } });
  return { images: { previous: { image: image(previous.images.frontend), revision: previous.images.frontend.revision }, candidate: { image: image(manifest.images.frontend), revision: manifest.images.frontend.revision } }, resources: [
    { apiVersion: 'v1', kind: 'Secret', metadata: meta(NAMES.access), type: 'Opaque', stringData: { STAGING_PASSWORD: password, STAGING_SESSION_KEY: sessionKey } },
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: meta(NAMES.code), data: { 'observer.mjs': GATEWAY_OBSERVER } },
    service(NAMES.frontend, 'frontend', 3000), service(NAMES.gateway, 'convergence-gateway', 3001),
    frontend(NAMES.frontend, 'frontend'), frontend(NAMES.stale, 'convergence-stale'), gateway,
  ] };
}

function resourcePath(kind, name) {
  const collection = { Deployment: 'apps/v1/namespaces/' + NAMESPACE + '/deployments', Service: 'v1/namespaces/' + NAMESPACE + '/services', Secret: 'v1/namespaces/' + NAMESPACE + '/secrets', ConfigMap: 'v1/namespaces/' + NAMESPACE + '/configmaps' }[kind];
  assert.ok(collection && Object.values(NAMES).includes(name), 'Temporary convergence resource required');
  return (kind === 'Deployment' ? '/apis/' : '/api/') + collection + '/' + name;
}

export class PublicConvergenceJourney {
  constructor(bench, previousPath, evidenceDirectory) {
    this.bench = bench; this.previousPath = previousPath; this.directory = evidenceDirectory; this.results = []; this.cutCount = 0;
  }
  async guard(namespaceUid) {
    const { manifest } = this.bench;
    assert.equal(manifest.target, 'vm'); assert.equal(manifest.namespace, NAMESPACE); assert.match(manifest.vm.uuid, UUID);
    const state = await this.bench.status();
    assert.equal(state.consumer, 'gthf'); assert.equal(state.runId, manifest.runId); assert.equal(state.uuid, manifest.vm.uuid);
    assert.equal(state.hostname, 'infra-qualification-vm'); assert.equal(state.networkMode, 'isolated'); assert.equal(state.running, true); assert.equal(state.sshReady, true);
    const namespace = await this.bench.kubeJson(['get', 'namespace', NAMESPACE]);
    assert.equal(namespace.metadata.labels[OWNER + 'uuid'], manifest.vm.uuid); assert.equal(namespace.metadata.labels[OWNER + 'run-id'], manifest.runId);
    if (namespaceUid) assert.equal(namespace.metadata.uid, namespaceUid, 'Namespace was replaced');
    assert.match(namespace.metadata.uid, UUID); return namespace.metadata.uid;
  }
  async importRuntimeArchive(image, archive) {
    requireRegularPath(archive.path, { privateFile: true });
    assert.ok(dirname(archive.path).startsWith(this.bench.root + '/images-')); assert.equal(archive.path.split('/').at(-1), 'frontend.tar');
    const hash = createHash('sha256'); for await (const chunk of createReadStream(archive.path)) hash.update(chunk);
    assert.equal(hash.digest('hex'), archive.sha256, 'Frontend archive changed');
    const remote = '/home/ubuntu/gthf-recovery-import/convergence-' + randomUUID() + '.tar';
    const runtimeArchive = remote + '.runtime.tar';
    try {
      await this.bench.call('guest-put', ['--path', remote, '--timeout', '300'], { input: createReadStream(archive.path), timeout: 330000 });
      assert.equal((await this.bench.guest(['sha256sum', remote])).stdout.toString().split(' ')[0], archive.sha256);
      const conversion = await this.bench.guest(['python3', '-B', '-c', readFileSync(new URL('./oci-archive.py', import.meta.url), 'utf8'), remote, runtimeArchive, image.ref, '--runtime-only'], { timeout: 120000 });
      const graph = JSON.parse(conversion.stdout.toString());
      assert.equal(graph.sourceDigest, image.digest); assert.equal(graph.canonicalRef, canonicalRuntimeReference(image));
      assert.equal(graph.digest, image.runtimeManifestDigest); assert.equal(graph.runtimeManifestDigest, image.runtimeManifestDigest);
      assert.equal(graph.runtimeConfigDigest, image.runtimeConfigDigest);
      await this.bench.guest(['sudo', '-n', '/snap/bin/microk8s', 'ctr', 'images', 'import', '--all-platforms', '--digests', runtimeArchive], { timeout: 300000 });
    } finally { await this.bench.guest(['rm', '-f', '--', remote, runtimeArchive]); }
  }
  async materializeRuntime(image, archive) {
    const target = canonicalRuntimeReference(image);
    const listed = async () => (await this.bench.guest(['sudo', '-n', '/snap/bin/microk8s', 'ctr', 'images', 'ls', 'name==' + target])).stdout.toString();
    // Do not overwrite an existing immutable-looking name: an index aliased as
    // a runtime digest would otherwise conceal the original import defect.
    if (!requireRuntimeTarget(await listed(), image)) {
      await this.importRuntimeArchive(image, archive);
    }
    assert.equal(requireRuntimeTarget(await listed(), image), true, 'The single-platform runtime was not registered');
    const runtimeBytes = (await this.bench.guest(['sudo', '-n', '/snap/bin/microk8s', 'ctr', 'content', 'get', image.runtimeManifestDigest])).stdout;
    assert.equal('sha256:' + sha256(runtimeBytes), image.runtimeManifestDigest, 'Runtime metadata content changed');
    const runtime = JSON.parse(runtimeBytes.toString());
    assert.equal(runtime.config.digest, image.runtimeConfigDigest, 'Runtime configuration link differs');
    const configBytes = (await this.bench.guest(['sudo', '-n', '/snap/bin/microk8s', 'ctr', 'content', 'get', image.runtimeConfigDigest])).stdout;
    assert.equal(configBytes.length, runtime.config.size, 'Runtime configuration descriptor size differs');
    assert.equal('sha256:' + sha256(configBytes), image.runtimeConfigDigest, 'Runtime configuration content changed');
    const config = JSON.parse(configBytes.toString());
    assert.equal(config.os, 'linux'); assert.equal(config.architecture, 'amd64');
    assert.equal(config.config?.Labels?.['org.opencontainers.image.revision'], image.revision, 'Runtime source revision differs');
    const proof = { image: target, sourceIndex: image.canonicalRef, runtimeManifestDigest: image.runtimeManifestDigest, runtimeConfigDigest: image.runtimeConfigDigest, revision: image.revision, platform: 'linux/amd64' };
    this.bench.event({ event: 'convergence-runtime-verified', ...proof });
    return proof;
  }
  owned(resource, token, uid) {
    const manifest = this.bench.manifest;
    assert.equal(resource.metadata.namespace, NAMESPACE);
    assert.equal(resource.metadata.labels[OWNER + 'uuid'], manifest.vm.uuid); assert.equal(resource.metadata.labels[OWNER + 'run-id'], manifest.runId);
    assert.equal(resource.metadata.labels[OWNER + 'convergence-token'], token);
    if (uid) assert.equal(resource.metadata.uid, uid, 'Temporary resource was replaced');
    assert.match(resource.metadata.uid, UUID); return resource;
  }
  async run() {
    const { manifest } = this.bench;
    const { previous, campaignRoot } = previousCampaign(this.previousPath, manifest); assert.equal(campaignRoot, this.bench.root);
    const namespaceUid = await this.guard();
    const credentials = JSON.parse(readFileSync(requireRegularPath(join(this.bench.root, 'credentials.json'), { privateFile: true }), 'utf8'));
    const token = randomUUID(); const password = randomBytes(32).toString('hex'); const sessionKey = randomBytes(32).toString('hex');
    const fixture = convergenceProfile(manifest, previous, credentials, token, password, sessionKey);
    for (const resource of fixture.resources) {
      const existing = await this.bench.kube(['get', resource.kind, resource.metadata.name, '--ignore-not-found', '-o', 'json']);
      assert.equal(existing.stdout.toString().trim(), '', 'Previous convergence resources must be inspected first');
    }
    const runtimeProofs = [];
    for (const candidate of [previous, manifest]) runtimeProofs.push(await this.materializeRuntime(candidate.images.frontend, candidate.archives.frontend));
    writeFileSync(join(this.directory, 'runtime-images.json'), JSON.stringify(runtimeProofs, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const created = []; const identities = {};
    try {
      for (const resource of fixture.resources) {
        await this.guard(namespaceUid);
        const tracked = { kind: resource.kind, name: resource.metadata.name }; created.push(tracked);
        const value = this.owned(JSON.parse((await this.bench.kube(['create', '-f', '-', '-o', 'json'], { input: JSON.stringify(resource) })).stdout.toString()), token);
        tracked.uid = value.metadata.uid; identities[value.kind + '/' + value.metadata.name] = value.metadata.uid;
      }
      const fixtures = JSON.parse(readFileSync(requireRegularPath(join(this.bench.root, 'fixtures.json'), { privateFile: true }), 'utf8'));
      assert.equal(fixtures.campaignId, manifest.vm.uuid);
      // Resolve the current acknowledged title from the public CMS, using its
      // existing token only inside the guest process. No production URL is read.
      const titleResult = await this.bench.kube(['exec', 'deployment/cms', '--', 'node', '-e',
        "fetch('http://127.0.0.1:1337/api/articles?status=published&filters[slug][$eq]=recovery-published&fields[0]=title',{headers:{Authorization:'Bearer '+process.env.STRAPI_API_TOKEN},signal:AbortSignal.timeout(10000)}).then(async r=>{if(!r.ok)throw Error('CMS');const d=await r.json();if(d.data?.length!==1)throw Error('Article');process.stdout.write(JSON.stringify(d.data[0].title))}).catch(()=>process.exitCode=1)"], { timeout: 15000 });
      const articleTitle = JSON.parse(titleResult.stdout.toString()); assert.equal(typeof articleTitle, 'string'); assert.ok(articleTitle.length > 0);
      const releaseSource = readFileSync(new URL('../../infrastructure/delivery/release.py', import.meta.url));
      const input = { uuid: manifest.vm.uuid, runId: manifest.runId, namespaceUid, token, password, resources: identities, articleTitle,
        ...fixture.images, releaseSource: releaseSource.toString('base64'), releaseSha256: sha256(releaseSource) };
      const result = await this.bench.guest(['sudo', '-n', 'python3', '-B', '-c', readFileSync(new URL('./convergence-driver.py', import.meta.url), 'utf8')], {
        input: JSON.stringify(input), timeout: 900000, allowFailure: true,
      });
      writeFileSync(join(this.directory, 'convergence-private.stdout'), result.stdout, { flag: 'wx', mode: 0o600 });
      writeFileSync(join(this.directory, 'convergence-private.stderr'), result.stderr, { flag: 'wx', mode: 0o600 });
      const records = result.stdout.toString().trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const proof = records.at(-1);
      this.results = records.filter((record) => record.name?.startsWith('Golden Journey:'));
      assert.equal(result.code, 0, 'Convergence phase failed; inspect its private evidence'); assert.equal(proof.status, 'passed');
      assert.equal(proof.releaseSha256, input.releaseSha256); assert.equal(proof.results.length, 5);
      this.results = proof.results;
      writeFileSync(join(this.directory, 'convergence.json'), JSON.stringify({ ...proof, previous: fixture.images.previous, candidate: fixture.images.candidate, sourceRevisions: manifest.sourceRevisions }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    } finally {
      for (const item of created.reverse()) {
        await this.guard(namespaceUid);
        const result = await this.bench.kube(['get', item.kind, item.name, '--ignore-not-found', '-o', 'json']);
        if (!result.stdout.toString().trim()) continue;
        const value = this.owned(JSON.parse(result.stdout.toString()), token, item.uid);
        await this.bench.kube(['delete', '--raw', resourcePath(item.kind, item.name), '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'DeleteOptions',
          propagationPolicy: 'Foreground', preconditions: { uid: value.metadata.uid, resourceVersion: value.metadata.resourceVersion } }), timeout: 45000 });
        await this.bench.kube(['wait', '--for=delete', item.kind + '/' + item.name, '--timeout=60s'], { timeout: 70000 });
      }
      await this.guard(namespaceUid);
      const remaining = await this.bench.kubeJson(['get', 'pods', '-l', OWNER + 'convergence-token=' + token]);
      assert.equal(remaining.items.length, 0, 'Temporary application pods remain');
      this.bench.event({ event: 'convergence-resources-removed', token, namespaceUid });
    }
    return this.results;
  }
}
