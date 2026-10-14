import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { requireRegularPath, verifyReservation, NAMESPACE } from './manifest.mjs';

const parsedLock = JSON.parse(readFileSync(new URL('./infra.lock.json', import.meta.url), 'utf8'));
export const infrastructureLock = Object.freeze({ ...parsedLock, files: Object.freeze(parsedLock.files) });
const SOURCE = '/home/ubuntu/source/infra-sincere-qualification-vm';

export function checkController(source = SOURCE, lock = infrastructureLock) {
  assert.equal(lock.repository, 'thedamfr/infra-sincere');
  assert.equal(lock.controller, 'scripts/qualification/vm.py');
  assert.match(lock.revision, /^[a-f0-9]{40}$/);
  assert.notEqual(lock.revision, '0'.repeat(40), 'Review and pin the infrastructure candidate first');
  assert.deepEqual(Object.keys(lock.files).sort(), ['provision-vm.py', 'vm.py'], 'Pin the complete local Python dependency graph');
  for (const value of Object.values(lock.files)) assert.match(value, /^[a-f0-9]{64}$/, 'Reviewed script hash required');
  requireRegularPath(source, { directory: true });
  const git = (...args) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  assert.equal(git('rev-parse', 'HEAD'), lock.revision, 'Infrastructure checkout differs from its pin');
  assert.ok(['git@github.com:thedamfr/infra-sincere.git', 'https://github.com/thedamfr/infra-sincere.git'].includes(git('remote', 'get-url', 'origin')));
  assert.equal(git('status', '--porcelain', '--untracked-files=normal', '--', 'scripts/qualification', 'package.json'), '', 'Infrastructure controller is modified');
  for (const name of Object.keys(lock.files)) requireRegularPath(join(source, 'scripts/qualification', name));
  return requireRegularPath(join(source, lock.controller));
}

// The privileged interpreter copies verified bytes into a protected temporary
// directory before running anything. Git/index state cannot authorise code, and
// neither a changed checkout nor a sibling import is read after verification.
// Existing sudo rights remain the trust boundary; this grants no extra rights.
export const PINNED_BOOTSTRAP = String.raw`import hashlib,json,os,pathlib,runpy,signal,stat,sys,tempfile
source=pathlib.Path(sys.argv[1]); pins=json.loads(sys.argv[2]); parent=pathlib.Path(sys.argv[3]); arguments=sys.argv[4:]
def require(value):
 if not value:raise RuntimeError('Pinned controller snapshot refused')
info=parent.lstat()
require(parent.resolve()==parent and stat.S_ISDIR(info.st_mode) and info.st_uid==os.geteuid() and not info.st_mode & 0o022)
require(set(pins)=={'vm.py','provision-vm.py'})
contents={}
for name,expected in pins.items():
 descriptor=os.open(source/name,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(descriptor,'rb') as handle:
  info=os.fstat(handle.fileno())
  require(stat.S_ISREG(info.st_mode) and 0<info.st_size<=2*1024*1024)
  value=handle.read(2*1024*1024+1)
 require(hashlib.sha256(value).hexdigest()==expected)
 contents[name]=value
os.umask(0o077)
def terminate(signum,frame):
 raise SystemExit(128+signum)
signal.signal(signal.SIGTERM,terminate)
signal.signal(signal.SIGINT,terminate)
# Root creates this private directory under protected /run. The finally in
# TemporaryDirectory removes only this snapshot, including controller errors
# and normal tunnel termination (SIGTERM). SIGKILL cannot run any cleanup.
with tempfile.TemporaryDirectory(prefix='infra-qualification-code-',dir=parent) as directory:
 snapshot=pathlib.Path(directory)
 for name,value in contents.items():
  with (snapshot/name).open('xb') as handle:handle.write(value)
  (snapshot/name).chmod(0o600)
 del contents
 sys.path.insert(0,str(snapshot))
 sys.argv=[str(snapshot/'vm.py'),*arguments]
 runpy.run_path(sys.argv[0],run_name='__main__')
`;
export function pinnedControllerArgs(controller, files, actionArgs, snapshotRoot = '/run') {
  return ['-n', '/usr/bin/python3', '-I', '-B', '-c', PINNED_BOOTSTRAP,
    dirname(controller), JSON.stringify(files), snapshotRoot, ...actionArgs];
}

export class BenchInterrupted extends Error {
  constructor(signal) {
    super('Recovery interrupted by ' + signal);
    this.name = 'BenchInterrupted';
    this.signal = signal;
    this.exitCode = signal === 'SIGINT' ? 130 : 143;
  }
}

// Keep handlers until the caller has written its report and completed local
// transport cleanup. A second signal does not interrupt an owned child's finally.
export function installBenchSignalHandlers(bench, emitter = process) {
  let rejectInterruption;
  const interrupted = new Promise((_, reject) => { rejectInterruption = reject; });
  interrupted.catch(() => {});
  const handlers = new Map(['SIGINT', 'SIGTERM'].map((signal) => [signal, () => {
    if (bench.interruption) return;
    bench.interrupt(signal);
    rejectInterruption(bench.interruption);
  }]));
  for (const [signal, handler] of handlers) emitter.on(signal, handler);
  return {
    run: (action) => Promise.race([Promise.resolve().then(() => { bench.assertRunning(); return action(); }), interrupted]),
    dispose: () => { for (const [signal, handler] of handlers) emitter.off(signal, handler); },
  };
}

export class Bench {
  constructor(manifest, campaignRoot, { controllerSource = SOURCE, lock = infrastructureLock, launch = spawn, shutdownTimeout = 10000 } = {}) {
    this.manifest = manifest;
    this.root = campaignRoot;
    this.controllerSource = controllerSource;
    this.lock = lock;
    this.controller = checkController(controllerSource, lock);
    this.launch = launch;
    this.shutdownTimeout = shutdownTimeout;
    this.children = new Map();
    this.tunnels = new Map();
    this.closed = false;
    this.interrupted = new Promise((_, reject) => { this.rejectInterruption = reject; });
    this.interrupted.catch(() => {});
  }
  args(action, extra = []) {
    const controller = checkController(this.controllerSource, this.lock);
    return pinnedControllerArgs(controller, this.lock.files, [action, '--consumer', 'gthf', '--run-id', this.manifest.runId, '--expect-uuid', this.manifest.vm.uuid, ...extra]);
  }
  event(event) {
    const fd = openSync(join(this.root, 'recovery-events.jsonl'), 'a', 0o600);
    try { writeSync(fd, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
  }
  assertRunning() {
    if (this.interruption) throw this.interruption;
    assert.ok(!this.closed, 'Recovery transports are closed');
  }
  spawnChild(action, extra, options) {
    this.assertRunning();
    const child = this.launch('sudo', this.args(action, extra), options);
    const record = { child, action, closed: false, detached: false, error: undefined, completion: undefined };
    record.completion = new Promise((resolve) => {
      child.once('error', (error) => { record.error = error; });
      child.once('close', (code, signal) => {
        record.closed = true;
        this.children.delete(child);
        resolve({ code, signal });
      });
    });
    this.children.set(child, record);
    return record;
  }
  stopChild(record, signal = 'SIGTERM') {
    if (record.closed || record.stopSignal) return;
    record.stopSignal = signal;
    record.child.kill(signal);
  }
  interrupt(signal) {
    if (this.interruption) return;
    this.interruption = new BenchInterrupted(signal);
    this.rejectInterruption(this.interruption);
    for (const record of this.children.values()) this.stopChild(record, signal);
  }
  async awaitStopped(record) {
    if (record.closed) return record.completion;
    let timer;
    try {
      return await Promise.race([record.completion, new Promise((_, reject) => {
        timer = setTimeout(() => {
          // A refusing child stays recorded as unconfirmed. Disconnect only our
          // local pipes so it cannot hold the reporting parent alive forever.
          // No reservation, VM, foreign PID or process group is touched.
          record.detached = true;
          record.child.stdin?.destroy(); record.child.stdout?.destroy(); record.child.stderr?.destroy();
          record.child.unref();
          reject(new Error('Owned recovery child did not close before the cleanup deadline'));
        }, this.shutdownTimeout);
      })]);
    } finally { clearTimeout(timer); }
  }
  transportState() {
    return [...this.children.values()].map(({ child, action, detached }) => ({ pid: child.pid ?? null, action, status: detached ? 'closure-unconfirmed' : 'closing' }));
  }
  async close() {
    this.closed = true;
    const remaining = [...this.children.values()];
    for (const record of remaining) this.stopChild(record);
    const results = await Promise.allSettled(remaining.map((record) => this.awaitStopped(record)));
    if (results.some((result) => result.status === 'rejected')) throw new Error('Recovery transport cleanup incomplete; reservation retained');
    this.tunnels.clear();
  }
  async call(action, extra = [], { input, timeout = 360000, allowFailure = false } = {}) {
    const record = this.spawnChild(action, extra, { stdio: ['pipe', 'pipe', 'pipe'] });
    const child = record.child;
    const chunks = []; const errors = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.stdin.on('error', () => {});
    if (input?.pipe) input.pipe(child.stdin);
    else child.stdin.end(input);
    let timer; let deadlineExceeded = false;
    const timedOut = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        deadlineExceeded = true;
        this.stopChild(record);
        this.awaitStopped(record).then(resolve, reject);
      }, timeout);
    });
    const { code, signal } = await Promise.race([record.completion, timedOut, this.interrupted]).finally(() => {
      clearTimeout(timer); input?.unpipe?.(child.stdin);
    });
    if (this.interruption) throw this.interruption;
    if (deadlineExceeded) {
      this.event({ action, status: 'timed-out', exitCode: code });
      throw new Error('Bench action exceeded its deadline: ' + action);
    }
    if (record.error) throw record.error;
    const result = { code, signal, stdout: Buffer.concat(chunks), stderr: Buffer.concat(errors) };
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
        if (error instanceof BenchInterrupted || /owner|identity|pin|modified/.test(error.message)) throw error;
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
    this.assertRunning();
    const existing = this.tunnels.get(name);
    if (existing && !existing.closed) return;
    const record = this.spawnChild('guest-forward', ['--local-port', String(localPort), '--guest-port', String(guestPort), '--duration', '3600'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const child = record.child;
    this.tunnels.set(name, record);
    child.stderr.resume();
    let timer;
    const ready = new Promise((resolve, reject) => {
      let buffer = '';
      timer = setTimeout(() => { this.stopChild(record); reject(new Error('Qualification tunnel timeout')); }, 25000);
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
          } catch (error) { clearTimeout(timer); this.stopChild(record); reject(error); }
        }
      });
    });
    await Promise.race([ready, this.interrupted]).finally(() => clearTimeout(timer));
  }
  async closeTunnels() {
    const remaining = [...this.tunnels.values()];
    for (const record of remaining) this.stopChild(record);
    const results = await Promise.allSettled(remaining.map((record) => this.awaitStopped(record)));
    if (results.some((result) => result.status === 'rejected')) throw new Error('Recovery tunnel cleanup incomplete; reservation retained');
    this.tunnels.clear();
  }
}
