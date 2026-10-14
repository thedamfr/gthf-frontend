import assert from 'node:assert/strict';
import test from 'node:test';
import { withCmsPartition } from '../scripts/recovery/network-partition.mjs';

const uuid = '22222222-2222-4222-8222-222222222222';
type Policy = { metadata: { name: string; labels: Record<string, string> }; spec: {
  podSelector: { matchLabels: Record<string, string>; matchExpressions: { values: string[] }[] };
  policyTypes: string[]; egress: { to: { podSelector?: { matchLabels: Record<string, string> } }[]; ports: { port: number }[] }[];
} };
function fixture() {
  const policies: Policy[] = []; const events: unknown[] = []; const mutations: string[][] = [];
  const bench = {
    manifest: { target: 'vm', namespace: 'gthf-recovery', vm: { uuid } },
    status: async () => ({ uuid, networkMode: 'isolated' }),
    kubeJson: async (args: string[]) => args[1] === 'namespace'
      ? { metadata: { labels: { 'qualification.infra-sincere/uuid': uuid } } }
      : { items: policies.slice() },
    apply: async (items: Policy[]) => { policies.push(...items); },
    kube: async (args: string[]) => { mutations.push(args); policies.splice(0); },
    event: (value: unknown) => { events.push(value); },
  };
  return { bench, policies, events, mutations };
}
test('isolated partition keeps only DNS and MinIO egress and is removed even when the Journey fails', async () => {
  const current = fixture();
  await assert.rejects(withCmsPartition(current.bench, async () => {
    const policy = current.policies[0]; assert.ok(policy);
    assert.deepEqual(policy.spec.podSelector.matchExpressions[0].values, ['frontend-a', 'frontend-b']);
    assert.equal(policy.spec.podSelector.matchLabels['qualification.infra-sincere/uuid'], uuid);
    assert.deepEqual(policy.spec.policyTypes, ['Egress']);
    assert.deepEqual(policy.spec.egress.flatMap((rule) => rule.ports.map((port) => port.port)), [53, 53, 9000]);
    assert.equal(policy.spec.egress[1].to[0].podSelector?.matchLabels['app.kubernetes.io/component'], 'minio');
    throw new Error('synthetic Journey failed');
  }), /synthetic Journey failed/);
  assert.equal(current.policies.length, 0); assert.equal(current.mutations[0][0], 'delete');
  assert.equal(current.events.length, 2);
});
test('partition refuses a different target or VM identity before applying any policy', async () => {
  for (const change of [
    (value: ReturnType<typeof fixture>) => { value.bench.manifest.target = 'production'; },
    (value: ReturnType<typeof fixture>) => { value.bench.status = async () => ({ uuid: 'foreign', networkMode: 'isolated' }); },
    (value: ReturnType<typeof fixture>) => { value.bench.status = async () => ({ uuid, networkMode: 'nat' }); },
  ]) {
    const current = fixture(); change(current);
    await assert.rejects(withCmsPartition(current.bench, async () => assert.fail('Must not run')));
    assert.equal(current.policies.length, 0); assert.equal(current.mutations.length, 0);
  }
});
