import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { requireRegularPath, verifyReservation, NAMESPACE } from './manifest.mjs';

export const infrastructureLock = JSON.parse(readFileSync(new URL('./infra.lock.json', import.meta.url), 'utf8'));
const SOURCE = '/home/ubuntu/source/infra-sincere-qualification-vm';

function checkController() {
  assert.equal(infrastructureLock.repository, 'thedamfr/infra-sincere');
  assert.equal(infrastructureLock.controller, 'scripts/qualification/vm.py');
  assert.match(infrastructureLock.revision, /^[a-f0-9]{40}$/);
  assert.notEqual(infrastructureLock.revision, '0'.repeat(40), 'Review and pin the infrastructure candidate first');
  requireRegularPath(SOURCE, { directory: true });
  const git = (...args) => execFileSync('git', ['-C', SOURCE, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  assert.equal(git('rev-parse', 'HEAD'), infrastructureLock.revision, 'Infrastructure checkout differs from its pin');
  assert.ok(['git@github.com:thedamfr/infra-sincere.git', 'https://github.com/thedamfr/infra-sincere.git'].includes(git('remote', 'get-url', 'origin')));
  assert.equal(git('status', '--porcelain', '--untracked-files=normal', '--', 'scripts/qualification', 'package.json'), '', 'Infrastructure controller is modified');
  return requireRegularPath(join(SOURCE, infrastructureLock.controller));
}

export class Bench {
  constructor(manifest, campaignRoot) {
    this.manifest = manifest;
    this.root = campaignRoot;
    this.controller = checkController();
    this.tunnels = new Map();
  }
  args(action, extra = []) {
    checkController();
    return ['-n', 'python3', '-B', this.controller, action, '--consumer', 'gthf', '--run-id', this.manifest.runId, '--expect-uuid', this.manifest.vm.uuid, ...extra];
  }
  event(event) {
    const fd = openSync(join(this.root, 'recovery-events.jsonl'), 'a', 0o600);
    try { writeSync(fd, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
  }
  async call(action, extra = [], { input, timeout = 360000, allowFailure = false } = {}) {
    const child = spawn('sudo', this.args(action, extra), { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; const errors = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.stdin.on('error', () => {});
    if (input?.pipe) input.pipe(child.stdin);
    else child.stdin.end(input);
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(timer));
    const result = { code, stdout: Buffer.concat(chunks), stderr: Buffer.concat(errors) };
    if (code !== 0 && !allowFailure) {
      // Guest output can contain private HTTP bodies or environment values.
      // Do not interpolate it into tool output or a public test report.
      this.event({ action, status: 'failed', exitCode: code });
      const failure = new Error('Bench action failed: ' + action);
      Object.defineProperty(failure, 'privateResult', { value: result, enumerable: false });
      throw failure;
    }
    return result;
  }
  async status() {
    const result = await this.call('status');
    return verifyReservation(this.manifest, JSON.parse(result.stdout.toString()));
  }
  async guest(argv, options = {}) {
    return this.call('guest-exec', ['--timeout', String(Math.min(3600, Math.ceil((options.timeout ?? 300000) / 1000))), '--', ...argv], options);
  }
  async kube(args, options = {}) {
    return this.guest(['sudo', '-n', '/snap/bin/microk8s', 'kubectl', '--namespace', NAMESPACE, ...args], options);
  }
  async kubeJson(args) {
    return JSON.parse((await this.kube([...args, '-o', 'json'])).stdout.toString());
  }
  async apply(items) {
    return this.kube(['apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items }) });
  }
  async waitGuest({ timeout = 300000, previousBootId } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const state = await this.status();
        if (state.running && state.sshReady && state.bootId && state.networkMode === 'isolated') {
          if (previousBootId) assert.notEqual(state.bootId, previousBootId, 'A new guest boot is required');
          return state;
        }
      } catch (error) {
        if (/owner|identity|pin|modified/.test(error.message)) throw error;
      }
      await sleep(2000);
    }
    throw new Error('Identified isolated guest did not become available before the deadline');
  }
  async powerCut(label) {
    const before = await this.status();
    assert.equal(before.networkMode, 'isolated');
    assert.ok(before.bootId);
    await this.closeTunnels();
    const event = JSON.parse((await this.call('power-cut')).stdout.toString());
    assert.equal(event.previousBootId, before.bootId);
    this.event({ event: 'real-qemu-sigkill', label, vmUuid: before.uuid, bootId: before.bootId });
    await this.call('start');
    const after = await this.waitGuest({ previousBootId: before.bootId });
    this.event({ event: 'guest-returned', label, bootId: after.bootId });
    return after;
  }
  async openTunnel(name, localPort, guestPort) {
    const existing = this.tunnels.get(name);
    if (existing && existing.exitCode === null) return;
    const child = spawn('sudo', this.args('guest-forward', ['--local-port', String(localPort), '--guest-port', String(guestPort), '--duration', '3600']), { stdio: ['ignore', 'pipe', 'pipe'] });
    this.tunnels.set(name, child);
    child.stderr.resume();
    await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Qualification tunnel timeout')); }, 25000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Qualification tunnel closed')); });
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        if (buffer.includes('\n')) {
          try {
            const state = JSON.parse(buffer.split('\n')[0]);
            assert.equal(state.uuid, this.manifest.vm.uuid); assert.equal(state.forwarding, true);
            assert.equal(state.localAddress, '127.0.0.1'); assert.equal(state.localPort, localPort);
            clearTimeout(timer); resolve();
          } catch (error) { clearTimeout(timer); child.kill('SIGTERM'); reject(error); }
        }
      });
    });
  }
  async closeTunnels() {
    for (const child of this.tunnels.values()) if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.all([...this.tunnels.values()].map((child) => child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5000).unref(); })));
    this.tunnels.clear();
  }
}
