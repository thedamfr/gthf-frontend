import assert from 'node:assert/strict';
import test from 'node:test';
import { requirePublication, publishCandidate, readBoundedJson, validatedBaseline } from '../infrastructure/delivery/publication.mjs';
import { localCandidate, requireUnchangedRuntime, waitingState, requirePrivateState, reconcileNext } from '../infrastructure/delivery/pull-policy.mjs';

test('the state guard refuses symlinks, files and a different owner', () => {
  const metadata = { mode: 0o700, uid: 1000, isDirectory: () => true, isSymbolicLink: () => false };
  assert.doesNotThrow(() => requirePrivateState(metadata, 1000));
  assert.throws(() => requirePrivateState({ ...metadata, isSymbolicLink: () => true }, 1000));
  assert.throws(() => requirePrivateState({ ...metadata, isDirectory: () => false }, 1000));
  assert.throws(() => requirePrivateState(metadata, 1001));
});

test('one invocation attempts one component and a failure does not starve the other', async () => {
  let cursor: { next: string } | undefined;
  const attempted: string[] = [];
  const save = (value: { next: string }) => { cursor = value; };
  await assert.rejects(() => reconcileNext(cursor, save, async (component: string) => { attempted.push(component); throw new Error('failed'); }));
  assert.deepEqual(attempted, ['frontend']);
  await reconcileNext(cursor, save, async (component: string) => { attempted.push(component); });
  assert.deepEqual(attempted, ['frontend', 'cms']);
});

test('pending and superseded candidates back off before another anonymous API request', () => {
  for (const status of ['ci-pending', 'superseded']) {
    const state = waitingState({ runId: 1, runAttempt: 1 }, status, 1000);
    assert.equal(state.status, status);
    assert.ok(state.retryAfter - 1000 >= 5 * 60 * 1000);
  }
});

test('an expired workflow record forces a fresh build instead of blocking publication', () => {
  assert.equal(validatedBaseline({ publication: {} }, null, 'frontend'), undefined);
});

test('release metadata preserves UTF-8 across network chunks and rejects oversized input', async () => {
  const payload = Buffer.from('{"label":"é"}');
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(payload.subarray(0, 11)); controller.enqueue(payload.subarray(11)); controller.close(); } }));
  assert.deepEqual(await readBoundedJson(response), { label: 'é' });
  await assert.rejects(() => readBoundedJson(new Response(payload), 4), /size limit/);
});

test('an unchanged publication does not hide a runtime rollback or incomplete rollout', () => {
  const deployment = { metadata: { generation: 2 }, spec: { replicas: 1, template: { spec: { containers: [{ image: 'verified-image' }] } } }, status: { observedGeneration: 2, readyReplicas: 1, updatedReplicas: 1 } };
  assert.doesNotThrow(() => requireUnchangedRuntime(deployment, 'verified-image'));
  assert.throws(() => requireUnchangedRuntime(deployment, 'different-image'));
  assert.throws(() => requireUnchangedRuntime({ ...deployment, status: { ...deployment.status, readyReplicas: 0 } }, 'verified-image'));
  assert.throws(() => requireUnchangedRuntime({ ...deployment, status: { readyReplicas: 1, updatedReplicas: 1 } }, 'verified-image'));
});

test('a published candidate is eligible only after its exact main workflow succeeds', () => {
  const revision = 'a'.repeat(40);
  const publication = { component: 'frontend', repository: 'thedamfr/gthf-frontend', runId: 123, runAttempt: 1, revision };
  const run = { id: 123, run_attempt: 1, head_sha: revision, head_branch: 'main', event: 'push', path: '.github/workflows/delivery.yml', status: 'completed', conclusion: 'success', repository: { full_name: publication.repository } };

  assert.doesNotThrow(() => requirePublication(publication, run, 'frontend'));
  assert.throws(() => requirePublication(publication, { ...run, conclusion: 'failure' }, 'frontend'));
});

test('local reconciliation compares the cumulative change with verified production', () => {
  const fingerprints = { runtime: 'b'.repeat(64), infrastructure: 'c'.repeat(64), postgres: 'd'.repeat(64) };
  const value = { image: `ghcr.io/thedamfr/gthf-frontend@sha256:${'1'.repeat(64)}`, revision: 'a'.repeat(40), processedRevision: 'a'.repeat(40), fingerprints };
  const candidate = { owner: 'github-frontend-123', publication: { component: 'frontend', runId: 123, revision: value.processedRevision }, plan: { build: false, infrastructure: false, postgres: false }, components: { frontend: value } };
  const production = { components: { frontend: { ...value, image: 'old', fingerprints: { ...fingerprints, runtime: 'old' } } } };

  const selected = localCandidate(candidate, production, fingerprints, fingerprints);

  assert.equal(selected.plan.build, true);
  assert.equal(selected.components.frontend.image, value.image);

  const unchanged = localCandidate(candidate, { components: { frontend: value } }, fingerprints, fingerprints);
  assert.deepEqual(unchanged.plan, { build: false, infrastructure: false, postgres: false });
  assert.throws(() => localCandidate(candidate, production, { ...fingerprints, runtime: 'e'.repeat(64) }, fingerprints));
  assert.throws(() => localCandidate(candidate, production, fingerprints, { ...fingerprints, runtime: 'e'.repeat(64) }));
  assert.throws(() => localCandidate(candidate, { components: { frontend: { ...value, fingerprints: { ...fingerprints, postgres: 'e'.repeat(64) } } } }, fingerprints, fingerprints));
});

test('an obsolete main run cannot replace the candidate polled by the server', async () => {
  const writes: string[] = [];
  const github = async (path: string, options: { method?: string } = {}) => {
    if (options.method) writes.push(path);
    return { object: { sha: 'b'.repeat(40) } };
  };

  const published = await publishCandidate(github, { publication: { revision: 'a'.repeat(40) } });

  assert.equal(published, false);
  assert.deepEqual(writes, []);
});

test('only a fast-forward candidate pointer is published after checking main again', async () => {
  const revision = 'a'.repeat(40);
  const requests: { path: string; method?: string; body?: unknown }[] = [];
  const github = async (path: string, options: { method?: string; body?: unknown } = {}) => {
    requests.push({ path, ...options });
    if (path === 'git/ref/heads/main') return { object: { sha: revision } };
    if (path === 'git/ref/heads/gthf-release') return { object: { sha: 'previous' } };
    return { sha: path === 'git/trees' ? 'tree' : 'commit' };
  };

  assert.equal(await publishCandidate(github, { publication: { revision } }), true);
  assert.deepEqual(requests.at(-1), { path: 'git/refs/heads/gthf-release', method: 'PATCH', body: { sha: 'commit', force: false } });
  assert.deepEqual(requests.at(-2), { path: 'git/ref/heads/main' });
});
