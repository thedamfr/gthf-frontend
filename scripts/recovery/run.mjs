import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadManifest } from './manifest.mjs';
import { Bench, infrastructureLock } from './infra-client.mjs';
import { prepareVm, resumeFixtures, installCandidate, checkJournal } from './prepare-vm.mjs';
import { RecoveryJourneys } from './journeys.mjs';

const { values } = parseArgs({ options: { target: { type: 'string' }, manifest: { type: 'string' }, phase: { type: 'string', default: 'qualify' } }, strict: true });
assert.ok(['prepare', 'resume-prepare', 'resume-fixtures', 'journal', 'install', 'qualify'].includes(values.phase));
const { value: manifest, campaignRoot } = loadManifest(values.manifest, { target: values.target, infraRevision: infrastructureLock.revision });
process.umask(0o077);
const bench = new Bench(manifest, campaignRoot);
let journeys;
const started = new Date().toISOString();
const attempt = join(campaignRoot, values.phase + '-' + started.replaceAll(/[:.]/g, '-'));
mkdirSync(attempt, { mode: 0o700 });
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
let success = false;
try {
  assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' }).trim(), '', 'Commit the exact harness candidate before every campaign phase');
  assert.equal(sourceRevision, manifest.sourceRevisions.frontend, 'Harness and frontend candidate revisions differ');
  await bench.waitGuest();
  if (values.phase === 'prepare' || values.phase === 'resume-prepare') await prepareVm(bench, { resume: values.phase === 'resume-prepare' });
  else if (values.phase === 'resume-fixtures') await resumeFixtures(bench);
  else if (values.phase === 'install') await installCandidate(bench);
  else if (values.phase === 'journal') await checkJournal(bench);
  else {
    journeys = new RecoveryJourneys(bench);
    await journeys.run();
  }
  success = true;
} catch (error) {
  if (error.privateResult) writeFileSync(join(attempt, 'private-failure.log'), error.privateResult.stderr, { mode: 0o600 });
  console.error('Recovery ' + values.phase + ' failed: ' + error.message);
  process.exitCode = 1;
} finally {
  await bench.closeTunnels();
  const report = { suite: 'Golden Journeys', phase: values.phase, status: success ? 'passed' : 'failed', startedAt: started, completedAt: new Date().toISOString(), vmUuid: manifest.vm.uuid,
    sourceRevisions: manifest.sourceRevisions, harnessRevision: sourceRevision, images: manifest.images, businessPowerCuts: journeys?.cutCount ?? 0, results: journeys?.results ?? [],
    limits: ['Synthetic data and isolated MinIO qualify recovery semantics, not the production S3 provider infrastructure.', 'Catalogue fixtures represent an already validated calculation; this suite does not requalify route-generation algorithms.'],
  };
  writeFileSync(join(attempt, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  writeFileSync(join(attempt, 'REPORT.md'), '# Summary\n\n' + 'Campagne GTHF `' + values.phase + '` : **' + report.status + '**. Les résultats concernent exclusivement la VM identifiée et les révisions ci-dessous.\n\n## Synthèse\n\n' +
    'VM `' + report.vmUuid + '`. Début `' + started + '`, fin `' + report.completedAt + '`. Coupures métier réelles : ' + report.businessPowerCuts + '. ' +
    'CMS `' + manifest.sourceRevisions.cms + '`, frontend `' + manifest.sourceRevisions.frontend + '`, infra `' + manifest.sourceRevisions.infra + '`. ' +
    'Les scénarios échoués et les essais exploratoires restent conservés. Ce rapport ne prouve pas une livraison en production.\n\n## Annexes\n\n' +
    'Détails, digests et limites : [report.json](report.json). Événements chronométrés : [recovery-events.jsonl](../recovery-events.jsonl). Les données brutes restent privées.\n', { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, report: join(attempt, 'REPORT.md') }));
}
