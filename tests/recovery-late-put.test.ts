import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { injectInterruptedMedia, INJECT_INTERRUPTED_MEDIA } from '../scripts/recovery/late-put.mjs';

const campaign = '22222222-2222-4222-8222-222222222222';
const attempt = '33333333-3333-4333-8333-333333333333';
const bytes = Buffer.from('synthetic');
const object = { key: 'gthf_' + attempt.replaceAll('-', '') + '_0.png',
  sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
const manifest = () => ({ target: 'vm', namespace: 'gthf-recovery', vm: { uuid: campaign }, bucket: 'gthf-recovery-' + campaign });

test('delayed PUT fixture sends only synthetic bytes to the identified CMS and records its simulation limit', async () => {
  const calls: [string[], { input: string; timeout: number }][] = [];
  const events: { limitation: string }[] = [];
  const bench = { manifest: manifest(), event: (value: { limitation: string }) => events.push(value), kube: async (...args: [string[], { input: string; timeout: number }]) => {
    calls.push(args); return { stdout: Buffer.from(JSON.stringify({ injected: true, sha256: object.sha256, bytes: object.bytes })) };
  } };
  await injectInterruptedMedia(bench, { attempt, object, bytes, role: 'delayed-put' });
  assert.deepEqual(calls[0][0].slice(0, -1), ['exec', '-i', 'deployment/cms', '--', 'node', '-e']);
  const input = JSON.parse(calls[0][1].input);
  assert.equal(input.campaign, campaign); assert.equal(input.bucket, manifest().bucket);
  assert.equal(Buffer.from(input.body, 'base64').toString(), 'synthetic');
  assert.equal('credentials' in input, false);
  assert.match(events[0].limitation, /not an induced provider/);
});

test('fixture rejects another target, bucket, attempt, or bytes before any VM call', async () => {
  let calls = 0;
  const bench = { manifest: manifest(), kube: async () => { calls++; } };
  const input = { attempt, object, bytes, role: 'delayed-put' };
  bench.manifest.target = 'production'; await assert.rejects(injectInterruptedMedia(bench, input));
  bench.manifest = { ...manifest(), bucket: 'foreign' }; await assert.rejects(injectInterruptedMedia(bench, input));
  bench.manifest = manifest();
  await assert.rejects(injectInterruptedMedia(bench, { ...input, attempt: campaign }));
  await assert.rejects(injectInterruptedMedia(bench, { ...input, bytes: Buffer.from('other') }));
  assert.equal(calls, 0);
});

test('guest injection validates its environment and uses conditional PUT without any delete', async () => {
  let stdout = ''; let stderr = '';
  type StorageInput = { Bucket: string; Key: string; IfNoneMatch?: string };
  class PutObjectCommand { input: StorageInput; constructor(input: StorageInput) { this.input = input; } }
  class HeadObjectCommand { input: StorageInput; constructor(input: StorageInput) { this.input = input; } }
  const commands: (PutObjectCommand | HeadObjectCommand)[] = [];
  class S3Client {
    async send(command: PutObjectCommand | HeadObjectCommand) { commands.push(command); return command instanceof HeadObjectCommand
      ? { ContentLength: bytes.length, Metadata: { gthfsha256: object.sha256 } } : {}; }
    destroy() {}
  }
  const env = { GTHF_RECOVERY_ISOLATED: 'true', GTHF_RECOVERY_CAMPAIGN: campaign, GTHF_NAMESPACE: 'gthf-recovery',
    AWS_ENDPOINT: 'http://minio:9000', AWS_BUCKET: manifest().bucket, AWS_ACCESS_KEY_ID: 'synthetic', AWS_SECRET_ACCESS_KEY: 'synthetic' };
  const processFixture: { env: typeof env; stdout: { write(value: string): void }; stderr: { write(value: string): void }; exitCode?: number } = { env, stdout: { write(value: string) { stdout += value; } }, stderr: { write(value: string) { stderr += value; } } };
  const script = new vm.Script(INJECT_INTERRUPTED_MEDIA);
  const context = { Buffer, AbortSignal, process: processFixture, require: (name: string) => {
    if (name === 'node:assert/strict') return assert;
    if (name === 'node:crypto') return { createHash };
    if (name === 'node:fs') return { readFileSync: () => JSON.stringify({ campaign, attempt, bucket: manifest().bucket, object, body: bytes.toString('base64') }) };
    assert.equal(name, '@aws-sdk/client-s3'); return { S3Client, PutObjectCommand, HeadObjectCommand };
  } };
  await script.runInNewContext({ ...context });
  assert.equal(stderr, ''); assert.equal(JSON.parse(stdout).injected, true);
  assert.equal(commands.length, 2); assert.ok(commands[0] instanceof PutObjectCommand);
  assert.equal(commands[0].input.IfNoneMatch, '*'); assert.equal(commands[0].input.Bucket, manifest().bucket);
  assert.ok(commands[1] instanceof HeadObjectCommand);
  processFixture.env = { ...env, AWS_ENDPOINT: 'https://foreign.invalid' };
  await script.runInNewContext({ ...context });
  assert.equal(processFixture.exitCode, 1); assert.equal(commands.length, 2);
});
