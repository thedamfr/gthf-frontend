import assert from 'node:assert/strict';
import test from 'node:test';
import { withCmsPartition } from '../scripts/recovery/network-partition.mjs';

const uuid = '22222222-2222-4222-8222-222222222222';
const policyUid = '33333333-3333-4333-8333-333333333333';
const tokenLabel = 'qualification.infra-sincere/partition-token';
type Policy = { apiVersion: string; kind: string; metadata: {
  name: string; namespace: string; labels: Record<string, string>; uid: string; resourceVersion: string;
}; spec: {
  podSelector: { matchLabels: Record<string, string>; matchExpressions: { values: string[] }[] };
  policyTypes: string[]; egress: { to: { podSelector?: { matchLabels: Record<string, string> } }[]; ports: { port: number }[] }[];
} };
type KubeOptions = { input?: string; timeout?: number };
type Mutation = { args: string[]; options: KubeOptions };
function fixture() {
  const policies: Policy[] = []; const events: unknown[] = []; const mutations: Mutation[] = [];
  const faults: { lostCreateReply: boolean; beforeDelete?: () => void; beforeCreate?: (desired: Policy) => void } = { lostCreateReply: false };
  const bench = {
    manifest: { target: 'vm', namespace: 'gthf-recovery', vm: { uuid } },
    status: async () => ({ uuid, networkMode: 'isolated' }),
    kubeJson: async (args: string[]) => args[1] === 'namespace'
      ? { metadata: { labels: { 'qualification.infra-sincere/uuid': uuid } } }
      : { items: structuredClone(policies) },
    kube: async (args: string[], options: KubeOptions = {}) => {
      mutations.push({ args, options });
      if (args[0] === 'create') {
        assert.deepEqual(args, ['create', '-f', '-', '-o', 'json']);
        const created = JSON.parse(options.input!) as Policy;
        faults.beforeCreate?.(created);
        assert.equal(policies.length, 0, 'AlreadyExists');
        created.metadata.uid = policyUid; created.metadata.resourceVersion = '17';
        policies.push(created);
        if (faults.lostCreateReply) throw new Error('Create response lost');
        return { stdout: Buffer.from(JSON.stringify(created)) };
      }
      assert.deepEqual(args, ['delete', '--raw', '/apis/networking.k8s.io/v1/namespaces/gthf-recovery/networkpolicies/frontend-cms-partition-' + uuid.slice(0, 8), '-f', '-']);
      assert.equal(options.timeout, 30000);
      const request = JSON.parse(options.input!) as { apiVersion: string; kind: string; preconditions: { uid: string; resourceVersion: string } };
      assert.equal(request.apiVersion, 'v1'); assert.equal(request.kind, 'DeleteOptions');
      faults.beforeDelete?.();
      assert.deepEqual(request.preconditions, { uid: policies[0].metadata.uid, resourceVersion: policies[0].metadata.resourceVersion }, 'API precondition conflict');
      policies.splice(0);
      return { stdout: Buffer.from('{}') };
    },
    event: (value: unknown) => { events.push(value); },
  };
  return { bench, policies, events, mutations, faults };
}
test('isolated partition keeps only DNS and MinIO egress and conditionally cleans up after Journey failure', async () => {
  const current = fixture();
  await assert.rejects(withCmsPartition(current.bench, async () => {
    const policy = current.policies[0]; assert.ok(policy);
    assert.deepEqual(policy.spec.podSelector.matchExpressions[0].values, ['frontend-a', 'frontend-b']);
    assert.equal(policy.spec.podSelector.matchLabels['qualification.infra-sincere/uuid'], uuid);
    assert.deepEqual(policy.spec.policyTypes, ['Egress']);
    assert.deepEqual(policy.spec.egress.flatMap((rule) => rule.ports.map((port) => port.port)), [53, 53, 9000]);
    assert.equal(policy.spec.egress[1].to[0].podSelector?.matchLabels['app.kubernetes.io/component'], 'minio');
    assert.match(policy.metadata.labels[tokenLabel], /^[a-f0-9-]{36}$/);
    throw new Error('synthetic Journey failed');
  }), /synthetic Journey failed/);
  assert.equal(current.policies.length, 0);
  assert.deepEqual(current.mutations.map((value) => value.args[0]), ['create', 'delete']);
  assert.deepEqual(JSON.parse(current.mutations[1].options.input!).preconditions, { uid: policyUid, resourceVersion: '17' });
  assert.equal(current.events.length, 2);
});
test('each partition attempt receives an independent token', async () => {
  const current = fixture(); const tokens: string[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await withCmsPartition(current.bench, async () => { tokens.push(current.policies[0].metadata.labels[tokenLabel]); });
  }
  assert.notEqual(tokens[0], tokens[1]);
});
test('same-campaign replacements and edits are preserved during cleanup', async () => {
  for (const change of [
    (policy: Policy) => { policy.metadata.labels[tokenLabel] = 'foreign-attempt'; },
    (policy: Policy) => { policy.metadata.uid = '44444444-4444-4444-8444-444444444444'; },
    (policy: Policy) => { policy.metadata.resourceVersion = '18'; },
  ]) {
    const current = fixture();
    await assert.rejects(withCmsPartition(current.bench, async () => { change(current.policies[0]); }), /foreign partition|Partition was replaced|Partition was modified/);
    assert.equal(current.policies.length, 1);
    assert.deepEqual(current.mutations.map((value) => value.args[0]), ['create']);
  }
});
test('API preconditions preserve a replacement racing the cleanup read', async () => {
  const current = fixture();
  current.faults.beforeDelete = () => { current.policies[0].metadata.uid = '44444444-4444-4444-8444-444444444444'; };
  await assert.rejects(withCmsPartition(current.bench, async () => {}), /API precondition conflict/);
  assert.equal(current.policies.length, 1);
  assert.equal(current.policies[0].metadata.uid, '44444444-4444-4444-8444-444444444444');
  assert.equal(current.events.length, 1);
});
test('API preconditions preserve a same-UID edit racing the cleanup read', async () => {
  const current = fixture();
  current.faults.beforeDelete = () => { current.policies[0].metadata.resourceVersion = '18'; };
  await assert.rejects(withCmsPartition(current.bench, async () => {}), /API precondition conflict/);
  assert.equal(current.policies.length, 1);
});
test('a lost create reply only permits cleanup of the matching per-attempt object', async () => {
  const current = fixture(); current.faults.lostCreateReply = true;
  await assert.rejects(withCmsPartition(current.bench, async () => assert.fail('Must not run')), /Create response lost/);
  assert.equal(current.policies.length, 0);
  assert.deepEqual(current.mutations.map((value) => value.args[0]), ['create', 'delete']);
});
test('a concurrent same-campaign policy is neither overwritten nor removed after create conflict', async () => {
  const current = fixture();
  current.faults.beforeCreate = (desired) => {
    const foreign = structuredClone(desired); foreign.metadata.labels[tokenLabel] = 'foreign-attempt';
    foreign.metadata.uid = policyUid; foreign.metadata.resourceVersion = '17'; current.policies.push(foreign);
  };
  await assert.rejects(withCmsPartition(current.bench, async () => assert.fail('Must not run')), /foreign partition/);
  assert.equal(current.policies.length, 1);
  assert.equal(current.policies[0].metadata.labels[tokenLabel], 'foreign-attempt');
  assert.deepEqual(current.mutations.map((value) => value.args[0]), ['create']);
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
