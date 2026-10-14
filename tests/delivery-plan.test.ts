import assert from 'node:assert/strict';
import test from 'node:test';
import { fingerprintEntries, classifyInput, planDelivery } from '../infrastructure/delivery/plan.mjs';
import { requireImageRevision } from '../infrastructure/delivery/image-proof.mjs';

test('an existing image must prove its requested source revision before reuse', () => {
  const revision = 'a'.repeat(40);
  requireImageRevision({ config: { Labels: { 'org.opencontainers.image.revision': revision } } }, revision);
  assert.throws(() => requireImageRevision({ config: { Labels: { 'org.opencontainers.image.revision': 'b'.repeat(40) } } }, revision));
  assert.throws(() => requireImageRevision({ config: {} }, revision));
});

test('a documentation push still delivers runtime inputs missed by the previous failed push', () => {
  const plan = planDelivery({ runtime: 'new', infrastructure: 'same', postgres: 'same' }, {
    runtime: 'old', infrastructure: 'same', postgres: 'same',
  });
  assert.equal(plan.build, true);
  assert.equal(plan.infrastructure, false);
});

test('missing baseline requires qualification; identical runtime inputs reuse the image', () => {
  const current = { runtime: 'app', infrastructure: 'infra', postgres: 'pg' };
  assert.deepEqual(planDelivery(current, null), { build: true, infrastructure: true, postgres: true });
  assert.deepEqual(planDelivery(current, current), { build: false, infrastructure: false, postgres: false });
});

test('narrative docs and tests do not rebuild runtime; data and unknown files do', () => {
  const initial = fingerprintEntries([['app/page.tsx', 'aaa']]);
  const documentation = fingerprintEntries([['app/page.tsx', 'aaa'], ['documentation/runbook.md', 'bbb'], ['tests/qa.test.ts', 'ccc']]);
  assert.deepEqual(initial, documentation);
  assert.equal(classifyInput('documentation/data/villes.csv'), 'runtime');
  assert.equal(classifyInput('new-runtime.conf'), 'runtime');
  assert.equal(classifyInput('infrastructure/docker/postgres/Dockerfile'), 'postgres');
  assert.equal(classifyInput('infrastructure/kubernetes/base/cms.yaml'), 'infrastructure');
});

test('infrastructure runbooks do not trigger reconciliation or a database rollout', () => {
  const initial = fingerprintEntries([['app/page.tsx', 'app']]);
  const updated = fingerprintEntries([['app/page.tsx', 'app'], ['infrastructure/README.md', 'new-guide'], ['infrastructure/docker/postgres/README.md', 'new-db-guide']]);
  assert.deepEqual(planDelivery(updated, initial), { build: false, infrastructure: false, postgres: false });
});


test('CMS candidate image requires history-retaining capability 2 at its expected revision', () => {
  const revision = 'a'.repeat(40);
  const image = (capability?: string) => ({ config: { Labels: { 'org.opencontainers.image.revision': revision, 'io.gthf.media-recovery': capability, 'io.gthf.media-batch-recovery': '1' } } });
  requireImageRevision(image('2'), revision, 'cms');
  for (const batch of ['', '0', '2']) {
    const value = image('2'); value.config.Labels['io.gthf.media-batch-recovery'] = batch;
    assert.throws(() => requireImageRevision(value, revision, 'cms'));
  }
  requireImageRevision(image(), revision, 'frontend');
  for (const version of [undefined, '0', '1', '3']) assert.throws(() => requireImageRevision(image(version), revision, 'cms'));
  assert.throws(() => requireImageRevision(image('2'), 'b'.repeat(40), 'cms'));
});
