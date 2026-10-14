import assert from 'node:assert/strict';
import test from 'node:test';
import { createServingReadiness } from '../lib/serving-readiness.ts';

test('a cold process waits for CMS admission, an admitted process preserves its warm-cache routing', async () => {
  let available = false;
  let checks = 0;
  const check = async () => { checks++; return available; };
  const serving = createServingReadiness(check);
  assert.equal(await serving(), false);
  available = true;
  assert.equal(await serving(), true);
  available = false;
  assert.equal(await serving(), true);
  assert.equal(checks, 2);
  // The strict dependency check and a replacement process still fail during the outage.
  assert.equal(await check(), false);
  assert.equal(await createServingReadiness(check)(), false);
});

test('concurrent admission probes share one real check, failure can be retried', async () => {
  let calls = 0;
  const serving = createServingReadiness(async () => { calls++; throw new Error('offline'); });
  assert.deepEqual(await Promise.all([serving(), serving()]), [false, false]);
  assert.equal(calls, 1);
  assert.equal(await serving(), false);
  assert.equal(calls, 2);
});
