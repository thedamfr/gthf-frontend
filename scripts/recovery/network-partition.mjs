import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NAMESPACE } from './manifest.mjs';

const OWNER = 'qualification.infra-sincere/';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function ownedPolicy(policy, desired, created) {
  assert.equal(policy.apiVersion, desired.apiVersion);
  assert.equal(policy.kind, desired.kind);
  assert.equal(policy.metadata.name, desired.metadata.name);
  assert.equal(policy.metadata.namespace, NAMESPACE);
  assert.match(policy.metadata.uid, UUID);
  assert.match(policy.metadata.resourceVersion, /^[0-9]+$/);
  for (const [key, value] of Object.entries(desired.metadata.labels)) {
    assert.equal(policy.metadata.labels?.[key], value, 'Never delete a foreign partition');
  }
  if (created) {
    assert.equal(policy.metadata.uid, created.uid, 'Partition was replaced');
    assert.equal(policy.metadata.resourceVersion, created.resourceVersion, 'Partition was modified');
  }
  assert.deepEqual(policy.spec, desired.spec, 'Partition specification was modified');
}

/** A real VM-only frontend-to-CMS partition; CMS workers and MinIO stay alive. */
export async function withCmsPartition(bench, action) {
  const manifest = bench.manifest;
  assert.equal(manifest.target, 'vm'); assert.equal(manifest.namespace, NAMESPACE);
  assert.match(manifest.vm.uuid, UUID);
  assert.equal(typeof action, 'function');
  const state = await bench.status(); assert.equal(state.networkMode, 'isolated');
  assert.equal(state.uuid, manifest.vm.uuid);
  const labels = { [OWNER + 'uuid']: manifest.vm.uuid };
  const name = 'frontend-cms-partition-' + manifest.vm.uuid.slice(0, 8);
  const namespace = await bench.kubeJson(['get', 'namespace', NAMESPACE]);
  assert.equal(namespace.metadata.labels['qualification.infra-sincere/uuid'], manifest.vm.uuid);
  const policies = await bench.kubeJson(['get', 'networkpolicy']);
  assert.ok(!policies.items.some((policy) => policy.metadata.name === name), 'A previous partition must be investigated first');
  const desired = {
    apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: {
      name, namespace: NAMESPACE, labels: { ...labels, [OWNER + 'partition-token']: randomUUID() },
    },
    spec: {
      podSelector: { matchLabels: labels, matchExpressions: [{ key: 'app.kubernetes.io/component', operator: 'In', values: ['frontend-a', 'frontend-b'] }] },
      policyTypes: ['Egress'],
      egress: [
        { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } }, podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }], ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
        { to: [{ podSelector: { matchLabels: { ...labels, 'app.kubernetes.io/component': 'minio' } } }], ports: [{ protocol: 'TCP', port: 9000 }] },
      ],
    },
  };
  let attempted = false;
  let created;
  try {
    attempted = true;
    // create refuses an object that appeared after the preflight read; apply
    // would replace its specification before ownership could be established.
    const policy = JSON.parse((await bench.kube(['create', '-f', '-', '-o', 'json'], { input: JSON.stringify(desired) })).stdout.toString());
    ownedPolicy(policy, desired);
    created = { uid: policy.metadata.uid, resourceVersion: policy.metadata.resourceVersion };
    bench.event({ event: 'vm-frontend-cms-partition-started', policy: name });
    return await action();
  } finally {
    if (attempted) {
      const remaining = await bench.kubeJson(['get', 'networkpolicy']);
      const policy = remaining.items.find((item) => item.metadata.name === name);
      if (policy) {
        // A lost create response may still leave our resource behind. The
        // per-attempt token distinguishes it from every previous/concurrent run.
        ownedPolicy(policy, desired, created);
        await bench.kube(['delete', '--raw', '/apis/networking.k8s.io/v1/namespaces/' + NAMESPACE + '/networkpolicies/' + name, '-f', '-'], {
          input: JSON.stringify({ apiVersion: 'v1', kind: 'DeleteOptions', preconditions: {
            uid: policy.metadata.uid, resourceVersion: policy.metadata.resourceVersion,
          } }),
          timeout: 30000,
        });
      }
      assert.ok(!(await bench.kubeJson(['get', 'networkpolicy'])).items.some((item) => item.metadata.name === name));
      bench.event({ event: 'vm-frontend-cms-partition-removed', policy: name });
    }
  }
}
