import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Bench, checkController, pinnedControllerArgs } from '../scripts/recovery/infra-client.mjs';
const source = `import json,os,pathlib,runpy,sys,time
if __name__=='__main__':
 root=pathlib.Path(__file__).parent
 if '--wait' in sys.argv:
  marker=pathlib.Path(sys.argv[sys.argv.index('--wait')+1]);marker.write_text(str(root))
  while not marker.with_suffix('.go').exists():time.sleep(.01)
 if '--unknown-import' in sys.argv:import unreviewed
 sibling=runpy.run_path(str(root/'provision-vm.py'))
 print(json.dumps({'token':sibling['TOKEN'],'args':sys.argv[1:],'directory':str(root),'mode':root.stat().st_mode & 0o777,'files':{p.name:p.stat().st_mode & 0o777 for p in root.iterdir()},'isolated':sys.flags.isolated}),flush=True)
 if '--error' in sys.argv:raise RuntimeError('intentional synthetic controller failure')
`;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture(t: TestContext, controllerSource = source) {
  const root = mkdtempSync(join(tmpdir(), 'gthf-infra-pin-test-'));
  t.after(async () => {
    if (existsSync(root)) writeFileSync(join(root, 'stop'), 'stop');
    const snapshots = join(root, 'snapshots'); const deadline = Date.now() + 1500;
    while (existsSync(snapshots) && readdirSync(snapshots).length && Date.now() < deadline) await sleep(10);
    rmSync(root, { recursive: true, force: true });
  });
  const checkout = join(root, 'checkout'); const scripts = join(checkout, 'scripts', 'qualification'); const snapshots = join(root, 'snapshots');
  mkdirSync(scripts, { recursive: true }); mkdirSync(snapshots, { mode: 0o700 });
  const controller = join(scripts, 'vm.py'); const dependency = join(scripts, 'provision-vm.py');
  writeFileSync(controller, controllerSource); writeFileSync(dependency, "TOKEN='reviewed dependency'\n");
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', checkout, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'Synthetic test'); git('config', 'user.email', 'synthetic@gthf.invalid');
  git('remote', 'add', 'origin', 'https://github.com/thedamfr/infra-sincere.git'); git('add', '.'); git('commit', '-qm', 'synthetic fixture');
  const lock = { repository: 'thedamfr/infra-sincere', revision: git('rev-parse', 'HEAD'), controller: 'scripts/qualification/vm.py', files: { 'vm.py': sha(controllerSource), 'provision-vm.py': sha(readFileSync(dependency, 'utf8')) } };
  const args = (extra: string[] = [], parent = snapshots) => pinnedControllerArgs(controller, lock.files, ['status', '--consumer', 'gthf', ...extra], parent);
  const run = (extra: string[] = [], parent = snapshots) => {
    const [, python, ...argv] = args(extra, parent);
    return spawnSync(python, argv, { encoding: 'utf8', timeout: 5000, env: { ...process.env, PYTHONPATH: scripts }, cwd: checkout });
  };
  return { root, checkout, scripts, snapshots, controller, dependency, git, lock, args, run };
}
test('pinned controller runs private reviewed bytes and only its pinned sibling, then cleans up', (t) => {
  const f = fixture(t); assert.equal(checkController(f.checkout, f.lock), f.controller);
  assert.deepEqual(f.args().slice(0, 5), ['-n', '/usr/bin/python3', '-I', '-B', '-c']);
  const result = f.run(); assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.token, 'reviewed dependency'); assert.equal(body.isolated, 1); assert.equal(body.mode, 0o700);
  assert.deepEqual(body.args, ['status', '--consumer', 'gthf']); assert.deepEqual(body.files, { 'vm.py': 0o600, 'provision-vm.py': 0o600 });
  assert.ok(body.directory.startsWith(f.snapshots + '/')); assert.equal(existsSync(body.directory), false); assert.deepEqual(readdirSync(f.snapshots), []);
});
test('visible dirty checkout, wrong source revision and incomplete dependency pin are refused', (t) => {
  const f = fixture(t);
  assert.throws(() => checkController(f.checkout, { ...f.lock, revision: 'a'.repeat(40) }), /differs/);
  assert.throws(() => checkController(f.checkout, { ...f.lock, files: { 'vm.py': f.lock.files['vm.py'] } }), /dependency graph/);
  writeFileSync(f.controller, source + '\n'); assert.throws(() => checkController(f.checkout, f.lock), /modified/);
});
for (const name of ['vm.py', 'provision-vm.py']) test(`assume-unchanged cannot authorise modified reviewed file: ${name}`, (t) => {
  const f = fixture(t); f.git('update-index', '--assume-unchanged', 'scripts/qualification/' + name);
  const marker = join(f.root, 'must-not-execute');
  writeFileSync(join(f.scripts, name), `from pathlib import Path\nPath(${JSON.stringify(marker)}).touch()\n`);
  assert.equal(f.git('status', '--porcelain'), ''); assert.equal(checkController(f.checkout, f.lock), f.controller);
  const result = f.run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /Pinned controller snapshot refused/);
  assert.equal(existsSync(marker), false); assert.deepEqual(readdirSync(f.snapshots), []);
});
test('a checkout edit after Git verification is rejected before any synthetic action', (t) => {
  const f = fixture(t); checkController(f.checkout, f.lock);
  writeFileSync(f.controller, "raise RuntimeError('unreviewed controller executed')\n");
  const result = f.run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /Pinned controller snapshot refused/); assert.doesNotMatch(result.stderr, /unreviewed controller executed/);
});
test('changes after the private copy cannot replace the executing controller or its later local import', async (t) => {
  const f = fixture(t); checkController(f.checkout, f.lock); const marker = join(f.root, 'copied');
  const [, python, ...argv] = f.args(['--wait', marker]); const child = spawn(python, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const stdout: Buffer[] = []; const stderr: Buffer[] = []; child.stdout.on('data', (v) => stdout.push(v)); child.stderr.on('data', (v) => stderr.push(v));
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const deadline = Date.now() + 4000; while (!existsSync(marker) && Date.now() < deadline && child.exitCode === null) await sleep(10);
  assert.ok(existsSync(marker), Buffer.concat(stderr).toString());
  writeFileSync(f.controller, "raise RuntimeError('changed after copy')\n"); writeFileSync(f.dependency, "TOKEN='unreviewed replacement'\n"); writeFileSync(marker + '.go', 'continue');
  assert.equal(await exited, 0, Buffer.concat(stderr).toString());
  const body = JSON.parse(Buffer.concat(stdout).toString()); assert.equal(body.token, 'reviewed dependency'); assert.equal(existsSync(body.directory), false);
});
test('unreviewed siblings and PYTHONPATH cannot provide extra imports', (t) => {
  const f = fixture(t); const marker = join(f.root, 'extra-import-executed');
  writeFileSync(join(f.scripts, 'unreviewed.py'), `from pathlib import Path\nPath(${JSON.stringify(marker)}).touch()\n`);
  const result = f.run(['--unknown-import']); assert.notEqual(result.status, 0); assert.match(result.stderr, /ModuleNotFoundError/);
  assert.equal(existsSync(marker), false); assert.deepEqual(readdirSync(f.snapshots), []);
});
test('symlink scripts and writable or linked snapshot parents are refused', (t) => {
  const f = fixture(t); const original = readFileSync(f.dependency); rmSync(f.dependency); const replacement = join(f.root, 'replacement.py'); writeFileSync(replacement, original); symlinkSync(replacement, f.dependency);
  assert.throws(() => checkController(f.checkout, f.lock)); assert.notEqual(f.run().status, 0);
  rmSync(f.dependency); writeFileSync(f.dependency, original);
  chmodSync(f.snapshots, 0o777); assert.notEqual(f.run().status, 0); chmodSync(f.snapshots, 0o700);
  const link = join(f.root, 'linked-snapshots'); symlinkSync(f.snapshots, link); assert.notEqual(f.run([], link).status, 0);
  assert.deepEqual(readdirSync(f.snapshots), []);
});
test('controller exceptions remove the private copy without hiding the failure', (t) => {
  const f = fixture(t); const result = f.run(['--error']); assert.notEqual(result.status, 0); assert.match(result.stderr, /intentional synthetic controller failure/);
  const body = JSON.parse(result.stdout); assert.equal(existsSync(body.directory), false); assert.deepEqual(readdirSync(f.snapshots), []);
});
test('SIGTERM unwinds a running controller and removes its private snapshot', async (t) => {
  const f = fixture(t); const marker = join(f.root, 'running');
  const [, python, ...argv] = f.args(['--wait', marker]); const child = spawn(python, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const stderr: Buffer[] = []; child.stderr.on('data', (v) => stderr.push(v)); child.stdout.resume();
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const deadline = Date.now() + 4000; while (!existsSync(marker) && Date.now() < deadline && child.exitCode === null) await sleep(10);
  assert.ok(existsSync(marker), Buffer.concat(stderr).toString()); const snapshot = readFileSync(marker, 'utf8'); assert.ok(existsSync(snapshot));
  assert.equal(child.kill('SIGTERM'), true); assert.equal(await exited, 143, Buffer.concat(stderr).toString());
  assert.equal(existsSync(snapshot), false); assert.deepEqual(readdirSync(f.snapshots), []);
});


const lifecycleSource = `import json,os,pathlib,signal,sys,time
records=pathlib.Path(sys.argv[sys.argv.index('--records')+1]);action=sys.argv[1]
if '--refuse-signals' in sys.argv:
 signal.signal(signal.SIGINT,signal.SIG_IGN);signal.signal(signal.SIGTERM,signal.SIG_IGN)
(records/(action+'.pid')).write_text(str(os.getpid()))
try:
 if action=='guest-forward':
  print(json.dumps({'uuid':sys.argv[sys.argv.index('--expect-uuid')+1],'forwarding':True,'localAddress':'127.0.0.1','localPort':int(sys.argv[sys.argv.index('--local-port')+1])}),flush=True)
 while not (records/'stop').exists():time.sleep(.01)
finally:
 (records/(action+'.closing')).write_text('closing')
 time.sleep(.1)
 (records/(action+'.finally')).write_text('closed')
`;

function lifecycleParent(f: ReturnType<typeof fixture>, options: { refuse?: boolean; idle?: boolean; closing?: boolean } = {}) {
  const parent = join(f.root, 'parent.mjs');
  writeFileSync(join(f.root, 'reservation.json'), '{"consumer":"gthf","durable":true}\n');
  const clientModule = new URL('../scripts/recovery/infra-client.mjs', import.meta.url).href;
  writeFileSync(parent, `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { Bench, installBenchSignalHandlers } from ${JSON.stringify(clientModule)};
const root = ${JSON.stringify(f.root)};
const bench = new Bench({ runId: 'gthf-recovery-synthetic', vm: { uuid: '22222222-2222-4222-8222-222222222222' } }, root, {
 controllerSource: ${JSON.stringify(f.checkout)}, lock: ${JSON.stringify(f.lock)}, shutdownTimeout: ${options.refuse ? 180 : 3000},
 launch(command,args,options) {
  if(command!=='sudo')throw Error('Unexpected executable');
  const actual = args.slice(2); actual[6] = ${JSON.stringify(f.snapshots)};
  return spawn(args[1], [...actual, '--records', root, ...${JSON.stringify(options.refuse ? ['--refuse-signals'] : [])}], options);
 }
});
const signals = installBenchSignalHandlers(bench);
let failure, cleanup = 'completed', blocked = false;
try {
 await signals.run(async()=>{
  await bench.openTunnel('synthetic',33137,30137);
  ${options.closing ? "" : options.idle ? "writeFileSync(root+'/idle','ready'); await sleep(60000);" : "await bench.call('status',[],{allowFailure:true,timeout:60000});"}
 });
} catch(error) { failure=error.name; }
finally {
 try { await bench.close(); } catch { cleanup='incomplete'; }
 try { await bench.call('must-not-start'); } catch { blocked=true; }
 writeFileSync(root+'/parent-report.json',JSON.stringify({ failure,cleanup,blocked,signal:bench.interruption?.signal,remaining:bench.transportState() }));
 signals.dispose();
 process.exitCode=bench.interruption?.exitCode??1;
}
if(bench.interruption)process.exit(bench.interruption.exitCode);
`);
  return spawn(process.execPath, [pathToFileURL(parent).pathname], { stdio: ['ignore', 'pipe', 'pipe'] });
}

async function waitFile(path: string, child: ReturnType<typeof spawn>) {
  const deadline = Date.now() + 5000;
  while (!existsSync(path) && child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(10);
  assert.ok(existsSync(path), 'Synthetic process did not reach ' + path);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) test(`Bench parent ${signal} closes its owned controller and tunnel before reporting; reservation survives`, async (t) => {
  const f = fixture(t, lifecycleSource); const parent = lifecycleParent(f);
  const errors: Buffer[] = []; parent.stderr.on('data',(v)=>errors.push(v)); parent.stdout.resume();
  const exited = new Promise((resolve,reject)=>{parent.once('error',reject);parent.once('close',resolve);});
  t.after(()=>{ if(existsSync(f.root))writeFileSync(join(f.root,'stop'),'stop'); if(parent.exitCode===null && parent.signalCode===null)parent.kill('SIGKILL'); });
  await waitFile(join(f.root,'status.pid'),parent);
  assert.equal(parent.kill(signal),true);
  assert.equal(await exited,signal==='SIGINT'?130:143,Buffer.concat(errors).toString());
  const report=JSON.parse(readFileSync(join(f.root,'parent-report.json'),'utf8'));
  assert.deepEqual(report,{ failure:'BenchInterrupted',cleanup:'completed',blocked:true,signal,remaining:[] });
  assert.equal(readFileSync(join(f.root,'guest-forward.finally'),'utf8'),'closed');
  assert.equal(readFileSync(join(f.root,'status.finally'),'utf8'),'closed');
  assert.deepEqual(readdirSync(f.snapshots),[]);
  for(const name of ['guest-forward','status'])assert.throws(()=>process.kill(Number(readFileSync(join(f.root,name+'.pid'),'utf8')),0),{code:'ESRCH'});
  assert.equal(readFileSync(join(f.root,'reservation.json'),'utf8'),'{"consumer":"gthf","durable":true}\n');
});

test('a refusing owned controller cannot hold parent reporting open; closure stays explicitly unconfirmed', async (t) => {
  const f = fixture(t,lifecycleSource); const parent=lifecycleParent(f,{refuse:true});
  parent.stderr.resume(); parent.stdout.resume();
  const exited=new Promise((resolve,reject)=>{parent.once('error',reject);parent.once('close',resolve);});
  t.after(()=>{if(existsSync(f.root))writeFileSync(join(f.root,'stop'),'stop'); if(parent.exitCode===null && parent.signalCode===null)parent.kill('SIGKILL');});
  await waitFile(join(f.root,'status.pid'),parent); const interruptedAt=Date.now(); parent.kill('SIGTERM');
  assert.equal(await exited,143); assert.ok(Date.now()-interruptedAt<3000,'Parent cleanup must be bounded');
  const report=JSON.parse(readFileSync(join(f.root,'parent-report.json'),'utf8'));
  assert.equal(report.cleanup,'incomplete'); assert.equal(report.blocked,true);
  assert.equal(report.remaining.length,2); assert.ok(report.remaining.every((child:{status:string})=>child.status==='closure-unconfirmed'));
  assert.equal(readFileSync(join(f.root,'reservation.json'),'utf8'),'{"consumer":"gthf","durable":true}\n');
  // Only the synthetic children created here are asked to leave their loop.
  writeFileSync(join(f.root,'stop'),'stop');
  const deadline=Date.now()+3000; while(readdirSync(f.snapshots).length && Date.now()<deadline)await sleep(10);
  assert.deepEqual(readdirSync(f.snapshots),[]);
});

test('a parent interrupted between Bench calls still closes its tunnel and reports without waiting for an idle Journey', async (t) => {
  const f=fixture(t,lifecycleSource); const parent=lifecycleParent(f,{idle:true});
  parent.stderr.resume(); parent.stdout.resume();
  const exited=new Promise((resolve,reject)=>{parent.once('error',reject);parent.once('close',resolve);});
  t.after(()=>{if(existsSync(f.root))writeFileSync(join(f.root,'stop'),'stop');if(parent.exitCode===null && parent.signalCode===null)parent.kill('SIGKILL');});
  await waitFile(join(f.root,'idle'),parent); const interruptedAt=Date.now(); parent.kill('SIGINT');
  assert.equal(await exited,130);assert.ok(Date.now()-interruptedAt<3000);
  const report=JSON.parse(readFileSync(join(f.root,'parent-report.json'),'utf8'));
  assert.equal(report.cleanup,'completed');assert.equal(report.signal,'SIGINT');assert.deepEqual(report.remaining,[]);
  assert.equal(readFileSync(join(f.root,'guest-forward.finally'),'utf8'),'closed');assert.deepEqual(readdirSync(f.snapshots),[]);
});

test('Bench treats an elapsed deadline as failure even if its controller exits zero on SIGTERM', async (t) => {
  const f=fixture(t,`import signal,time
signal.signal(signal.SIGTERM,lambda *_:exit(0))
while True:time.sleep(.01)
`);
  const bench=new Bench({runId:'gthf-recovery-synthetic',vm:{uuid:'22222222-2222-4222-8222-222222222222'}},f.root,{
    controllerSource:f.checkout,lock:f.lock,shutdownTimeout:3000,
    launch(command:string,args:string[],options:object){
      assert.equal(command,'sudo');const actual=args.slice(2);actual[6]=f.snapshots;return spawn(args[1],actual,options);
    },
  });
  try {await assert.rejects(bench.call('status',[],{timeout:200,allowFailure:true}),/exceeded its deadline/);}
  finally {await bench.close();}
  assert.deepEqual(bench.transportState(),[]);assert.deepEqual(readdirSync(f.snapshots),[]);
  const events=readFileSync(join(f.root,'recovery-events.jsonl'),'utf8').trim().split('\n').map((line)=>JSON.parse(line));
  assert.equal(events[0].status,'timed-out');assert.equal(events[0].exitCode,0);
});

test('signal during normal final cleanup preserves the child finally and exits interrupted rather than zero', async (t) => {
  const f=fixture(t,lifecycleSource);const parent=lifecycleParent(f,{closing:true});
  parent.stderr.resume();parent.stdout.resume();
  const exited=new Promise((resolve,reject)=>{parent.once('error',reject);parent.once('close',resolve);});
  t.after(()=>{if(parent.exitCode===null && parent.signalCode===null)parent.kill('SIGKILL');});
  await waitFile(join(f.root,'guest-forward.closing'),parent);parent.kill('SIGTERM');
  assert.equal(await exited,143);
  const report=JSON.parse(readFileSync(join(f.root,'parent-report.json'),'utf8'));
  assert.equal(report.cleanup,'completed');assert.equal(report.signal,'SIGTERM');assert.deepEqual(report.remaining,[]);
  assert.equal(readFileSync(join(f.root,'guest-forward.finally'),'utf8'),'closed');assert.deepEqual(readdirSync(f.snapshots),[]);
});
