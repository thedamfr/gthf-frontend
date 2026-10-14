import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NAMESPACE } from './manifest.mjs';

export const URL_FIXTURE_IP = '203.0.113.42';
export const URL_FIXTURE_ORIGIN = 'http://' + URL_FIXTURE_IP + ':9000';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const OWNER = 'qualification.infra-sincere/';

// A Service externalIP is intercepted by guest kube-proxy. No host address,
// route, firewall, SSRF exception, bucket policy or S3 object is installed here.
// Kubernetes contract: https://kubernetes.io/docs/concepts/services-networking/service/#external-ips
// Actual reachability is required below, never inferred from Service creation.
export const PROBE_URL_FIXTURE = String.raw`
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
(async () => {
  const [url, campaign, expectedHash, length] = process.argv.slice(1);
  const expectedBytes = Number(length);
  assert.equal(process.env.GTHF_RECOVERY_ISOLATED, 'true');
  assert.equal(process.env.GTHF_RECOVERY_CAMPAIGN, campaign);
  assert.equal(process.env.GTHF_NAMESPACE, 'gthf-recovery');
  assert.equal(process.env.AWS_ENDPOINT, 'http://minio:9000');
  assert.equal(new URL(url).origin, 'http://203.0.113.42:9000');
  assert.ok(new URL(url).pathname.startsWith('/gthf-recovery-' + campaign + '/'));
  const deadline = Date.now() + 15000;
  let response;
  for (;;) {
    try {
      response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await sleep(250);
    }
  }
  assert.equal(response.status, 200);
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    assert.ok(bytes <= expectedBytes, 'Fixture exceeds its expected size');
    hash.update(chunk);
  }
  assert.equal(bytes, expectedBytes);
  const sha256 = hash.digest('hex'); assert.equal(sha256, expectedHash);
  process.stdout.write(JSON.stringify({ bytes, sha256 }));
})().catch(() => { process.stderr.write('Synthetic URL fixture probe failed'); process.exitCode = 1; });
`;

function context(bench, object) {
  const manifest = bench.manifest;
  assert.equal(manifest.consumer, 'gthf');
  assert.equal(manifest.target, 'vm');
  assert.equal(manifest.namespace, NAMESPACE);
  assert.match(manifest.runId, /^gthf-recovery-[a-z0-9-]{1,64}$/);
  assert.match(manifest.vm.uuid, UUID);
  assert.equal(manifest.vm.hostname, 'infra-qualification-vm');
  assert.equal(manifest.bucket, 'gthf-recovery-' + manifest.vm.uuid);
  assert.match(object.key, /^[A-Za-z0-9_-][A-Za-z0-9/_.-]{0,1023}$/);
  assert.ok(object.key.split('/').every((part) => part && part !== '.' && part !== '..'), 'Canonical fixture key required');
  assert.match(object.sha256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(object.bytes) && object.bytes > 0 && object.bytes <= 10 * 1024 * 1024);
  return { uuid: manifest.vm.uuid, runId: manifest.runId,
    name: 'url-import-source-' + manifest.vm.uuid.slice(0, 8),
    url: URL_FIXTURE_ORIGIN + '/' + manifest.bucket + '/' + object.key,
    labels: { [OWNER + 'uuid']: manifest.vm.uuid, [OWNER + 'run-id']: manifest.runId },
  };
}

async function guard(bench, expected, namespaceUid) {
  const state = await bench.status();
  assert.equal(state.consumer, 'gthf'); assert.equal(state.uuid, expected.uuid);
  assert.equal(state.runId, expected.runId); assert.equal(state.hostname, 'infra-qualification-vm');
  assert.equal(state.networkMode, 'isolated'); assert.equal(state.running, true); assert.equal(state.sshReady, true);
  assert.ok(state.bootId);
  const namespace = await bench.kubeJson(['get', 'namespace', NAMESPACE]);
  assert.equal(namespace.metadata.name, NAMESPACE);
  assert.match(namespace.metadata.uid, UUID);
  if (namespaceUid) assert.equal(namespace.metadata.uid, namespaceUid, 'Namespace was replaced');
  for (const [key, value] of Object.entries(expected.labels)) assert.equal(namespace.metadata.labels?.[key], value, 'Foreign namespace');
  return namespace.metadata.uid;
}

function ownedService(service, desired, uid) {
  assert.equal(service.apiVersion, 'v1'); assert.equal(service.kind, 'Service');
  assert.equal(service.metadata.name, desired.metadata.name);
  assert.equal(service.metadata.namespace, NAMESPACE);
  assert.match(service.metadata.uid, UUID);
  if (uid) assert.equal(service.metadata.uid, uid, 'Fixture Service was replaced');
  for (const [key, value] of Object.entries(desired.metadata.labels)) assert.equal(service.metadata.labels?.[key], value, 'Foreign URL fixture Service');
  assert.deepEqual(service.spec.externalIPs, [URL_FIXTURE_IP]);
  assert.equal(service.spec.type, 'ClusterIP');
  assert.deepEqual(service.spec.selector, desired.spec.selector);
  assert.deepEqual(service.spec.ports, desired.spec.ports);
}

/** Serve an existing anonymous QA object during action; never creates/deletes data. */
export async function withUrlFixture(bench, object, action) {
  const expected = context(bench, object);
  assert.equal(typeof action, 'function');
  const namespaceUid = await guard(bench, expected);
  const services = (await bench.kubeJson(['get', 'services', '--all-namespaces'])).items;
  assert.ok(!services.some((item) => item.metadata.namespace === NAMESPACE && item.metadata.name === expected.name), 'Previous URL fixture must be investigated');
  assert.ok(!services.some((item) => item.spec.externalIPs?.includes(URL_FIXTURE_IP)), 'Fixture address already belongs to a Service');
  const minio = await bench.kubeJson(['get', 'deployment', 'minio']);
  assert.equal(minio.metadata.name, 'minio'); assert.equal(minio.metadata.namespace, NAMESPACE);
  for (const [key, value] of Object.entries(expected.labels)) {
    assert.equal(minio.metadata.labels?.[key], value, 'Foreign MinIO workload');
    assert.equal(minio.spec.template.metadata.labels?.[key], value, 'Foreign MinIO pod template');
  }
  assert.equal(minio.spec.template.metadata.labels['app.kubernetes.io/component'], 'minio');
  const desired = { apiVersion: 'v1', kind: 'Service', metadata: {
    name: expected.name, namespace: NAMESPACE,
    labels: { ...expected.labels, [OWNER + 'url-fixture-token']: randomUUID() },
  }, spec: { type: 'ClusterIP', externalIPs: [URL_FIXTURE_IP],
    selector: { ...expected.labels, 'app.kubernetes.io/component': 'minio' },
    ports: [{ name: 'http', protocol: 'TCP', port: 9000, targetPort: 9000 }],
  } };
  let attempted = false; let createdUid;
  try {
    await guard(bench, expected, namespaceUid);
    attempted = true;
    const created = JSON.parse((await bench.kube(['create', '-f', '-', '-o', 'json'], { input: JSON.stringify(desired) })).stdout.toString());
    ownedService(created, desired); createdUid = created.metadata.uid;
    bench.event({ event: 'vm-url-fixture-created', service: expected.name, uid: createdUid, address: URL_FIXTURE_IP });
    // kube-proxy/EndpointSlice propagation may lag API creation. kubectl exec
    // itself is bounded; failed content/hash checks never authorize the Journey.
    const probe = await bench.kube(['exec', 'deployment/cms', '--', 'node', '-e', PROBE_URL_FIXTURE,
      expected.url, expected.uuid, object.sha256, String(object.bytes)], { timeout: 30000 });
    assert.deepEqual(JSON.parse(probe.stdout.toString()), { bytes: object.bytes, sha256: object.sha256 });
    return await action({ url: expected.url, serviceName: expected.name, serviceUid: createdUid });
  } finally {
    if (attempted) {
      await guard(bench, expected, namespaceUid);
      const remaining = (await bench.kubeJson(['get', 'services'])).items.find((item) => item.metadata.name === expected.name);
      if (remaining) {
        ownedService(remaining, desired, createdUid);
        // Kubernetes 1.35 kubectl delete --raw accepts DeleteOptions on stdin.
        // UID + resourceVersion close the read/delete replacement race.
        assert.match(remaining.metadata.resourceVersion, /^[0-9]+$/);
        await bench.kube(['delete', '--raw', '/api/v1/namespaces/' + NAMESPACE + '/services/' + expected.name, '-f', '-'], {
          input: JSON.stringify({ apiVersion: 'v1', kind: 'DeleteOptions',
            preconditions: { uid: remaining.metadata.uid, resourceVersion: remaining.metadata.resourceVersion } }),
          timeout: 30000,
        });
      }
      assert.ok(!(await bench.kubeJson(['get', 'services'])).items.some((item) => item.metadata.name === expected.name), 'URL fixture cleanup incomplete');
      bench.event({ event: 'vm-url-fixture-removed', service: expected.name });
    }
  }
}
