import assert from 'node:assert/strict';
import { NAMESPACE } from './manifest.mjs';

/** A real VM-only frontend-to-CMS partition; CMS workers and MinIO stay alive. */
export async function withCmsPartition(bench, action) {
  const manifest = bench.manifest;
  assert.equal(manifest.target, 'vm'); assert.equal(manifest.namespace, NAMESPACE);
  assert.match(manifest.vm.uuid, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  const state = await bench.status(); assert.equal(state.networkMode, 'isolated');
  assert.equal(state.uuid, manifest.vm.uuid);
  const labels = { 'qualification.infra-sincere/uuid': manifest.vm.uuid };
  const name = 'frontend-cms-partition-' + manifest.vm.uuid.slice(0, 8);
  const namespace = await bench.kubeJson(['get', 'namespace', NAMESPACE]);
  assert.equal(namespace.metadata.labels['qualification.infra-sincere/uuid'], manifest.vm.uuid);
  const policies = await bench.kubeJson(['get', 'networkpolicy']);
  assert.ok(!policies.items.some((policy) => policy.metadata.name === name), 'A previous partition must be investigated first');
  let attempted = false;
  try {
    attempted = true;
    await bench.apply([{
      apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name, namespace: NAMESPACE, labels },
      spec: {
        podSelector: { matchLabels: labels, matchExpressions: [{ key: 'app.kubernetes.io/component', operator: 'In', values: ['frontend-a', 'frontend-b'] }] },
        policyTypes: ['Egress'],
        egress: [
          { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } }, podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }], ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
          { to: [{ podSelector: { matchLabels: { ...labels, 'app.kubernetes.io/component': 'minio' } } }], ports: [{ protocol: 'TCP', port: 9000 }] },
        ],
      },
    }]);
    bench.event({ event: 'vm-frontend-cms-partition-started', policy: name });
    return await action();
  } finally {
    if (attempted) {
      const remaining = await bench.kubeJson(['get', 'networkpolicy']);
      const policy = remaining.items.find((item) => item.metadata.name === name);
      if (policy) {
        assert.equal(policy.metadata.labels['qualification.infra-sincere/uuid'], manifest.vm.uuid, 'Never delete a foreign partition');
        await bench.kube(['delete', 'networkpolicy', name, '--wait=true', '--timeout=30s']);
      }
      assert.ok(!(await bench.kubeJson(['get', 'networkpolicy'])).items.some((item) => item.metadata.name === name));
      bench.event({ event: 'vm-frontend-cms-partition-removed', policy: name });
    }
  }
}
