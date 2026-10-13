import assert from 'node:assert/strict';
import test from 'node:test';
import { GET } from '../app/api/health/route.ts';

test('health identifies the serving revision without allowing cached proof', async () => {
  const previous = process.env.GTHF_REVISION;
  process.env.GTHF_REVISION = 'a'.repeat(40);
  try {
    const response = GET();
    assert.deepEqual(await response.json(), { status: 'ok', revision: 'a'.repeat(40) });
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  } finally {
    if (previous === undefined) delete process.env.GTHF_REVISION;
    else process.env.GTHF_REVISION = previous;
  }
});

test('health still identifies an existing image configured with its legacy revision variable', async () => {
  const current = process.env.GTHF_REVISION;
  const legacy = process.env.GTHDF_REVISION;
  delete process.env.GTHF_REVISION;
  process.env.GTHDF_REVISION = 'b'.repeat(40);
  try {
    assert.equal((await GET().json()).revision, 'b'.repeat(40));
    process.env.GTHF_REVISION = 'c'.repeat(40);
    assert.equal((await GET().json()).revision, 'c'.repeat(40));
  } finally {
    if (current === undefined) delete process.env.GTHF_REVISION;
    else process.env.GTHF_REVISION = current;
    if (legacy === undefined) delete process.env.GTHDF_REVISION;
    else process.env.GTHDF_REVISION = legacy;
  }
});
