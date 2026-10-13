import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// This fixture deliberately completes a previously interrupted PUT later. It
// uses real isolated MinIO, but does not claim to induce provider/network delay.
export const INJECT_INTERRUPTED_MEDIA = `
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
(async () => {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const env = process.env;
  assert.match(input.campaign, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.match(input.attempt, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.equal(env.GTHF_RECOVERY_ISOLATED, 'true');
  assert.equal(env.GTHF_RECOVERY_CAMPAIGN, input.campaign);
  assert.equal(env.GTHF_NAMESPACE, 'gthf-recovery');
  assert.equal(env.AWS_ENDPOINT, 'http://minio:9000');
  assert.equal(env.AWS_BUCKET, 'gthf-recovery-' + input.campaign);
  assert.equal(input.bucket, env.AWS_BUCKET);
  assert.match(input.object.key, /^[a-zA-Z0-9/_.-]+$/);
  assert.ok(!input.object.key.includes('..'));
  assert.ok(input.object.key.split('/').at(-1).startsWith('gthf_' + input.attempt.replaceAll('-', '') + '_'));
  const body = Buffer.from(input.body, 'base64');
  assert.ok(body.length > 0 && body.length <= 10 * 1024 * 1024);
  assert.equal(body.length, input.object.bytes);
  assert.equal(createHash('sha256').update(body).digest('hex'), input.object.sha256);
  const client = new S3Client({ endpoint: env.AWS_ENDPOINT, region: 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
    maxAttempts: 1, requestChecksumCalculation: 'WHEN_REQUIRED' });
  try {
    await client.send(new PutObjectCommand({ Bucket: env.AWS_BUCKET, Key: input.object.key,
      Body: body, ContentLength: body.length, ContentType: input.object.mime || 'application/octet-stream',
      Metadata: { gthfsha256: input.object.sha256 }, IfNoneMatch: '*' }), { abortSignal: AbortSignal.timeout(30000) });
    const head = await client.send(new HeadObjectCommand({ Bucket: env.AWS_BUCKET, Key: input.object.key }), { abortSignal: AbortSignal.timeout(10000) });
    assert.equal(Number(head.ContentLength), body.length);
    assert.equal(head.Metadata?.gthfsha256, input.object.sha256);
    process.stdout.write(JSON.stringify({ injected: true, sha256: input.object.sha256, bytes: body.length }));
  } finally { client.destroy(); }
})().catch((error) => { process.stderr.write('Synthetic delayed PUT injection failed: ' + error.name); process.exitCode = 1; });
`;

export async function injectInterruptedMedia(bench, { attempt, object, bytes, role }) {
  assert.equal(bench.manifest.target, 'vm');
  assert.equal(bench.manifest.namespace, 'gthf-recovery');
  assert.match(bench.manifest.vm.uuid, UUID);
  assert.equal(bench.manifest.bucket, 'gthf-recovery-' + bench.manifest.vm.uuid);
  assert.match(attempt, UUID);
  assert.match(object.key, /^[a-zA-Z0-9/_.-]+$/); assert.ok(!object.key.includes('..'));
  assert.ok(object.key.split('/').at(-1).startsWith('gthf_' + attempt.replaceAll('-', '') + '_'));
  assert.ok(['delayed-put', 'foreign-collision'].includes(role));
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 10 * 1024 * 1024);
  assert.equal(object.bytes, bytes.length); assert.equal(object.sha256, sha256(bytes));
  const response = await bench.kube(['exec', '-i', 'deployment/cms', '--', 'node', '-e', INJECT_INTERRUPTED_MEDIA], {
    input: JSON.stringify({ campaign: bench.manifest.vm.uuid, bucket: bench.manifest.bucket,
      attempt, object, body: bytes.toString('base64') }), timeout: 50000,
  });
  const result = JSON.parse(response.stdout.toString());
  assert.deepEqual(result, { injected: true, sha256: object.sha256, bytes: object.bytes });
  bench.event({ event: 'simulated-delayed-put-fixture', role, attempt,
    objectKey: object.key, sha256: object.sha256, bytes: object.bytes,
    limitation: 'explicit reinjection into real MinIO; not an induced provider/network delay' });
}
