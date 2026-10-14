import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadManifest } from './manifest.mjs';
import { Bench, infrastructureLock, installBenchSignalHandlers } from './infra-client.mjs';
import { prepareVm, resumeFixtures, installCandidate, checkJournal } from './prepare-vm.mjs';
import { RecoveryJourneys } from './journeys.mjs';
import { PublicConvergenceJourney } from './convergence.mjs';

const { values } = parseArgs({ options: { target: { type: 'string' }, manifest: { type: 'string' }, 'previous-manifest': { type: 'string' }, phase: { type: 'string', default: 'qualify' } }, strict: true });
assert.equal(Boolean(values['previous-manifest']), values.phase === 'convergence', 'Only convergence requires a previous manifest');
assert.ok(['prepare', 'resume-prepare', 'resume-fixtures', 'journal', 'install', 'qualify', 'convergence'].includes(values.phase));
const { value: manifest, campaignRoot } = loadManifest(values.manifest, { target: values.target, infraRevision: infrastructureLock.revision });
process.umask(0o077);
const bench = new Bench(manifest, campaignRoot);
let journeys;
const started = new Date().toISOString();
const attempt = join(campaignRoot, values.phase + '-' + started.replaceAll(/[:.]/g, '-'));
mkdirSync(attempt, { mode: 0o700 });
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
let success = false;
const signals = installBenchSignalHandlers(bench);
try {
  await signals.run(async () => {
    assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' }).trim(), '', 'Commit the exact harness candidate before every campaign phase');
    assert.equal(sourceRevision, manifest.sourceRevisions.frontend, 'Harness and frontend candidate revisions differ');
    await bench.waitGuest();
    if (values.phase === 'prepare' || values.phase === 'resume-prepare') await prepareVm(bench, { resume: values.phase === 'resume-prepare' });
    else if (values.phase === 'resume-fixtures') await resumeFixtures(bench);
    else if (values.phase === 'install') await installCandidate(bench);
    else if (values.phase === 'journal') await checkJournal(bench);
    else if (values.phase === 'convergence') {
      journeys = new PublicConvergenceJourney(bench, values['previous-manifest'], attempt);
      await journeys.run();
    }
    else {
      journeys = new RecoveryJourneys(bench);
      await journeys.run();
    }
    success = true;
  });
} catch (error) {
  writeFileSync(join(attempt, 'private-error.log'), String(error.stack ?? error), { mode: 0o600 });
  if (error.privateResult) writeFileSync(join(attempt, 'private-failure.log'), error.privateResult.stderr, { mode: 0o600 });
  console.error('Recovery ' + values.phase + ' failed: ' + error.message);
  process.exitCode = bench.interruption?.exitCode ?? 1;
} finally {
  let transportCleanup = 'completed';
  try { await bench.close(); }
  catch (error) {
    transportCleanup = 'incomplete'; success = false;
    process.exitCode = bench.interruption?.exitCode ?? 1;
    writeFileSync(join(attempt, 'private-cleanup-error.log'), String(error.stack ?? error), { mode: 0o600 });
  }
  const report = { suite: 'Golden Journeys', phase: values.phase, status: bench.interruption ? 'interrupted' : success ? 'passed' : 'failed', signal: bench.interruption?.signal, transportCleanup, remainingOwnedTransports: bench.transportState(), reservationRetained: true, startedAt: started, completedAt: new Date().toISOString(), vmUuid: manifest.vm.uuid,
    sourceRevisions: manifest.sourceRevisions, harnessRevision: sourceRevision, images: manifest.images, businessPowerCuts: journeys?.cutCount ?? 0, results: journeys?.results ?? [],
    limits: ['Synthetic data and isolated MinIO qualify recovery semantics, not the production S3 provider infrastructure.', 'Catalogue fixtures represent an already validated calculation; this suite does not requalify route-generation algorithms.'],
  };
  writeFileSync(join(attempt, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  writeFileSync(join(attempt, 'REPORT.md'), '# Summary\n\n' + 'Campagne GTHF `' + values.phase + '` : **' + report.status + '**. Les résultats concernent exclusivement la VM identifiée et les révisions ci-dessous.\n\n## Synthèse\n\n' +
    'VM `' + report.vmUuid + '`. Début `' + started + '`, fin `' + report.completedAt + '`. Coupures métier réelles : ' + report.businessPowerCuts + '. ' +
    'CMS `' + manifest.sourceRevisions.cms + '`, frontend `' + manifest.sourceRevisions.frontend + '`, infra `' + manifest.sourceRevisions.infra + '`. ' +
    'La réservation reste conservée ; une interruption interdit de nouvelles actions VM, les ressources temporaires déjà créées nécessitent donc une inspection avant reprise. Fermeture des transports : ' + transportCleanup + '. Les scénarios échoués et les essais exploratoires restent conservés. Ce rapport ne prouve pas une livraison en production.\n\n## Annexes\n\n' +
    'Détails, digests et limites : [report.json](report.json). Événements chronométrés : [recovery-events.jsonl](../recovery-events.jsonl). Les données brutes restent privées.\n', { mode: 0o600 });
  signals.dispose();
  console.log(JSON.stringify({ status: report.status, report: join(attempt, 'REPORT.md') }));
}

// After owned transports and synchronous reports are handled, do not wait for
// an interrupted Journey's unrelated sleep or HTTP timeout. No further VM
// operation can start, and the reservation remains available for inspection.
if (bench.interruption) process.exit(bench.interruption.exitCode);
