import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { gitFingerprints, planDelivery } from './plan.mjs';
import { requireImageRevision } from './image-proof.mjs';
import { publishCandidate, validatedBaseline } from './publication.mjs';

function run(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
  if (result.status !== 0) throw new Error(`${file} ${args[0]} failed`);
  return result.stdout;
}

const [component, repository, deployer] = process.argv.slice(2);
if (!['frontend', 'cms'].includes(component)) throw new Error('Invalid component');
const revision = process.env.GITHUB_SHA;
if (!/^[a-f0-9]{40}$/.test(revision ?? '') || process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Only the exact main revision may be published');
if (run('git', ['-C', repository, 'rev-parse', 'HEAD']).trim() !== revision) throw new Error('Checkout does not match the event');
const deployerRevision = run('git', ['-C', deployer, 'rev-parse', 'HEAD']).trim();
const output = resolve(process.env.RUNNER_TEMP ?? '.', 'gthf-release');
mkdirSync(output, { recursive: true });
const githubRepository = `thedamfr/gthf-${component}`;
async function github(path, { method = 'GET', body, allowMissing = false } = {}) {
  const response = await fetch(`https://api.github.com/repos/${githubRepository}/${path}`, {
    method, headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GH_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' },
    ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  if (allowMissing && response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub publication request failed (${response.status})`);
  return response.json();
}
let baseline;
const previousFile = await github('contents/candidate.json?ref=gthf-release', { allowMissing: true });
if (previousFile) {
  if (previousFile.size > 262144 || previousFile.encoding !== 'base64') throw new Error('Invalid publication baseline');
  const published = JSON.parse(Buffer.from(previousFile.content, 'base64').toString('utf8'));
  const previousRun = await github(`actions/runs/${published.publication?.runId}`, { allowMissing: true });
  baseline = validatedBaseline(published, previousRun, component);
}
const previous = baseline?.components?.[component];
const fingerprints = gitFingerprints(repository, revision);
const plan = planDelivery(fingerprints, previous?.fingerprints);
const imageName = `ghcr.io/thedamfr/gthf-${component}`;
const tag = `${imageName}:sha-${revision}`;
let image = previous?.image;
let imageRevision = previous?.revision;
const startedAt = new Date().toISOString();
if (plan.build) {
  const existing = spawnSync('docker', ['buildx', 'imagetools', 'inspect', tag, '--format', '{{json .Manifest}}'], { encoding: 'utf8' });
  let digest;
  if (existing.status === 0) {
    digest = JSON.parse(existing.stdout).digest;
  } else {
    const metadata = join(output, 'build.json');
    run('docker', ['buildx', 'build', repository, '--file', join(repository, 'Dockerfile'), '--platform', 'linux/amd64', '--provenance=false', '--sbom=false', '--push', '--tag', tag, '--build-arg', `GTHF_REVISION=${revision}`, '--metadata-file', metadata], { stdio: 'inherit' });
    digest = JSON.parse(readFileSync(metadata, 'utf8'))['containerimage.digest'];
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? '')) throw new Error('Missing immutable build digest');
  // Inspect the resolved digest, not the tag which may move between requests.
  const imageConfig = JSON.parse(run('docker', ['buildx', 'imagetools', 'inspect', `${imageName}@${digest}`, '--format', '{{json .Image}}']));
  requireImageRevision(imageConfig, revision);
  image = `${imageName}@${digest}`;
  imageRevision = revision;
} else {
  if (!new RegExp(`^${imageName}@sha256:[a-f0-9]{64}$`).test(image ?? '') || !/^[a-f0-9]{40}$/.test(imageRevision ?? '')) throw new Error('Invalid reusable image');
  const sourceInputs = gitFingerprints(repository, imageRevision);
  if (sourceInputs.runtime !== fingerprints.runtime) throw new Error('Reusable image sources are not equivalent');
  requireImageRevision(JSON.parse(run('docker', ['buildx', 'imagetools', 'inspect', image, '--format', '{{json .Image}}'])), imageRevision);
}
const schemas = {};
if (component === 'cms') {
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === 'schema.json' || (path.includes('/src/components/') && entry.name.endsWith('.json'))) schemas[path.slice(resolve(repository).length + 1)] = JSON.parse(readFileSync(path, 'utf8'));
    }
  };
  walk(join(resolve(repository), 'src'));
}
const candidate = {
  publication: { component, repository: githubRepository, revision, runId: Number(process.env.GITHUB_RUN_ID), runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT) },
  owner: `github-${component}-${process.env.GITHUB_RUN_ID}`,
  startedAt,
  deployerRevision,
  plan,
  components: { [component]: { image, revision: imageRevision, processedRevision: revision, fingerprints, ...(component === 'cms' ? { schemas } : {}) } },
};
const candidateFile = join(output, 'candidate.json');
writeFileSync(candidateFile, JSON.stringify(candidate, null, 2));
const published = await publishCandidate(github, candidate);
const summary = `GTHF ${component}\n\nSource: ${revision}\nImage: ${image}\nBuild: ${plan.build}\nPublication: ${published ? 'candidate published; local qualification pending' : 'superseded by a newer main revision'}\nProduction status is recorded by the local reconciler after its recipes.\n`;
writeFileSync(join(output, 'summary.txt'), summary);
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' });
