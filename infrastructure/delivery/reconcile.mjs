// Penthouse pulls public release intent. GitHub runners never connect to it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, lstatSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { gitFingerprints } from './plan.mjs';
import { requirePublication, readBoundedJson } from './publication.mjs';
import { localCandidate, requireUnchangedRuntime, waitingState, requirePrivateState, reconcileNext } from './pull-policy.mjs';
import { runDeployment } from './deployment-process.mjs';

const root = '/home/ubuntu/gthf-delivery';
const python = '/home/ubuntu/.cache/infra-sincere/ansible-2.21.4/bin/python';
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const checkOnly = process.argv.includes('--check');
const invocationStarted = Date.now();
if (process.argv.slice(2).some(value => value !== '--check')) throw new Error('Unsupported reconciler option');
if (hostname() !== 'game-prod-ovh-gra') throw new Error('Unexpected deployment host');
requirePrivateState(lstatSync(root), process.getuid());
const read = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
function save(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(path + '.tmp', path);
}
function run(file, args, options = {}) {
  try {
    return execFileSync(file, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 4e6, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  } catch {
    throw new Error('Local operation failed; inspect the private delivery history');
  }
}
async function get(url, allowMissing = false) {
  const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'gthf-local-delivery' }, redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (allowMissing && response.status === 404) return null;
  if (!response.ok) throw new Error(`Public release metadata unavailable (${response.status})`);
  return readBoundedJson(response);
}
const github = (component, path) => get(`https://api.github.com/repos/thedamfr/gthf-${component}/${path}`);
function repository(component, revisions) {
  const path = join(root, 'repositories', `gthf-${component}.git`);
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    run('git', ['init', '--bare', path]);
    run('git', ['-C', path, 'remote', 'add', 'origin', `https://github.com/thedamfr/gthf-${component}.git`]);
  }
  if (run('git', ['-C', path, 'remote', 'get-url', 'origin']).trim() !== `https://github.com/thedamfr/gthf-${component}.git`) throw new Error('Unexpected source repository');
  for (const revision of new Set(revisions)) {
    if (!/^[a-f0-9]{40}$/.test(revision ?? '')) throw new Error('An exact source revision is required');
    run('git', ['-c', 'credential.helper=', '-C', path, 'fetch', '--depth=1', '--no-tags', 'origin', revision]);
  }
  return path;
}
async function reconcile(component) {
  const candidate = await get(`https://raw.githubusercontent.com/thedamfr/gthf-${component}/gthf-release/candidate.json?poll=${Date.now()}`, true);
  if (!candidate) return { component, status: 'no-publication' };
  const publication = candidate.publication;
  if (!publication || publication.component !== component || !Number.isSafeInteger(publication.runId) || !Number.isSafeInteger(publication.runAttempt)) throw new Error('Invalid release identity');
  const statePath = join(root, 'pull', component + '.json');
  const state = read(statePath);
  const same = state?.runId === publication.runId && state?.runAttempt === publication.runAttempt;
  const production = read(join(root, 'production.json'));
  if (!production || production.status !== 'success') throw new Error('Verified production is required');
  if (same && state.status === 'success' && production.components[component].processedRevision === publication.revision) {
    const deployment = JSON.parse(run('sudo', ['-n', '/snap/bin/microk8s', 'kubectl', '-n', 'gthf-staging', 'get', 'deployment', `gthf-${component}`, '-o', 'json']));
    requireUnchangedRuntime(deployment, production.components[component].image);
    return { component, status: 'unchanged' };
  }
  if (same && state.retryAfter > Date.now() && !checkOnly) return { component, status: 'backoff' };
  if (state?.runId > publication.runId) throw new Error('The publication pointer moved backwards');
  const reservation = read(join(root, 'staging-reservation.json'));
  if (reservation?.expires * 1000 > Date.now()) return { component, status: 'staging-reserved' };
  const identity = { runId: publication.runId, runAttempt: publication.runAttempt, revision: publication.revision };
  const waitForPublication = status => {
    if (!checkOnly) save(statePath, waitingState(identity, status, Date.now()));
    return { component, status };
  };
  try {
    const workflow = await github(component, `actions/runs/${publication.runId}`);
    if (workflow.status !== 'completed') return waitForPublication('ci-pending');
    requirePublication(publication, workflow, component);
    if ((await github(component, 'git/ref/heads/main')).object.sha !== publication.revision) return waitForPublication('superseded');
    const value = candidate.components?.[component];
    if (!value) throw new Error('Missing component');
    const source = repository(component, [value.processedRevision, value.revision]);
    const selected = localCandidate(candidate, production, gitFingerprints(source, value.processedRevision), gitFingerprints(source, value.revision));
    if (component === 'cms') {
      const paths = run('git', ['-C', source, 'ls-tree', '-r', '--name-only', '-z', value.processedRevision, 'src']).split('\0');
      const schemas = Object.fromEntries(paths.filter(path => path.endsWith('/schema.json') || (path.startsWith('src/components/') && path.endsWith('.json')))
        .map(path => [path, JSON.parse(run('git', ['-C', source, 'show', `${value.processedRevision}:${path}`]))]));
      if (!Object.keys(schemas).length || !isDeepStrictEqual(schemas, value.schemas)) throw new Error('CMS schema evidence does not match its source revision');
    }
    if (!/^[a-f0-9]{40}$/.test(candidate.deployerRevision ?? '')) throw new Error('Invalid deployer revision');
    // Only execute an immutable frontend revision which passed its own CI.
    const { workflow_runs: runs } = await github('frontend', `actions/workflows/delivery.yml/runs?head_sha=${candidate.deployerRevision}&status=success&per_page=20`);
    if (!runs.some(run => run.head_sha === candidate.deployerRevision && run.head_branch === 'main' && ['push', 'workflow_dispatch'].includes(run.event) && run.path === '.github/workflows/delivery.yml')) throw new Error('The exact deployer revision has not passed main CI');
    const deployerRepository = repository('frontend', [candidate.deployerRevision]);
    const archive = run('git', ['-C', deployerRepository, 'archive', '--format=tar', candidate.deployerRevision, 'infrastructure'], { encoding: 'buffer', maxBuffer: 20e6 });
    const directory = join(root, 'deployers', candidate.deployerRevision, `pull-${component}-${publication.runId}-${publication.runAttempt}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const archivePath = join(directory, 'source.tar');
    writeFileSync(archivePath, archive, { mode: 0o600 });
    run(python, [join(scriptDirectory, 'extract-source.py'), archivePath, directory]);
    const selectedPath = join(directory, 'candidate.json');
    save(selectedPath, selected);
    if (checkOnly) {
      run(python, [join(directory, 'infrastructure/delivery/release.py'), 'check', '--candidate', selectedPath], { timeout: 300000 });
      return { component, status: 'eligible', revision: publication.revision, image: selected.components[component].image, plan: selected.plan };
    }
    save(statePath, { ...identity, status: 'running', startedAt: new Date().toISOString() });
    const remaining = 50 * 60 * 1000 - (Date.now() - invocationStarted);
    if (remaining <= 0) throw new Error('Preflight exhausted the service budget before activation');
    await runDeployment(python, [join(directory, 'infrastructure/delivery/release.py'), 'deliver', '--candidate', selectedPath], { timeoutMs: remaining });
    const verified = read(join(root, 'production.json'));
    if (verified?.status !== 'success' || verified.components[component].processedRevision !== publication.revision) throw new Error('The candidate has no verified production result');
    const result = { ...identity, status: 'success', verifiedAt: verified.finishedAt, image: verified.components[component].image };
    save(statePath, result);
    return { component, ...result };
  } catch (error) {
    if (!checkOnly) save(statePath, { ...identity, status: 'failed', failedAt: new Date().toISOString(), retryAfter: Date.now() + 300000, error: error.message });
    throw error;
  }
}

async function report(component) {
  try { console.log(JSON.stringify(await reconcile(component))); }
  catch (error) { console.error(JSON.stringify({ component, status: 'failed', error: error.message })); process.exitCode = 1; }
}
if (checkOnly) {
  for (const component of ['frontend', 'cms']) await report(component);
} else {
  const cursorPath = join(root, 'pull', 'cursor.json');
  await reconcileNext(read(cursorPath), cursor => save(cursorPath, cursor), report);
}
