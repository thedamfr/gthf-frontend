import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { accessSync } from 'node:fs';

const standalone = resolve('.next/standalone');
accessSync(resolve(standalone, 'server.js'));
const revision = '9'.repeat(40);
let cmsAvailable = false;
const cms = createServer((request, response) => {
  if (request.headers.authorization !== 'Bearer runtime-test-fixture') {
    response.writeHead(401).end(); return;
  }
  if (!cmsAvailable) { response.writeHead(503).end(); return; }
  const pathname = new URL(request.url, 'http://fixture.local').pathname;
  const data = pathname === '/api/global'
    ? { siteName: 'Runtime fixture' }
    : pathname === '/api/chapters'
      ? [{ id: 1, documentId: 'runtime-chapter', slug: 'runtime-chapter', title: 'Chapitre de recette runtime', distance: 42, startStation: 'Départ', endStation: 'Arrivée' }]
      : null;
  response.writeHead(data ? 200 : 404, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ data }));
});
cms.listen(0, '127.0.0.1');
await once(cms, 'listening');
const portReservation = createServer();
portReservation.listen(0, '127.0.0.1');
await once(portReservation, 'listening');
const port = portReservation.address().port;
await new Promise((resolve) => portReservation.close(resolve));
const child = spawn(process.execPath, ['server.js'], {
  cwd: standalone,
  env: {
    PATH: process.env.PATH, NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: String(port),
    GTHF_REVISION: revision, NEXT_TELEMETRY_DISABLED: '1',
    STRAPI_URL: 'http://127.0.0.1:' + cms.address().port,
    STRAPI_API_TOKEN: 'runtime-test-fixture',
    PUBLIC_STRAPI_URL: 'https://cms.runtime-test.invalid', SITE_URL: 'https://runtime-test.invalid',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = once(child, 'exit');
let output = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output = (output + chunk).slice(-4000); });
try {
  const origin = 'http://127.0.0.1:' + port;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(1000) });
      ready = response.ok && (await response.json()).revision === revision;
      if (ready) break;
    } catch { /* Wait for this test's standalone process to bind its port. */ }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'The built standalone server must start with runtime configuration');
  assert.equal((await fetch(origin + '/api/serving')).status, 503, 'Cold admission must require the CMS');
  assert.equal((await fetch(origin + '/api/ready')).status, 503, 'Strict readiness cannot succeed without the CMS');
  cmsAvailable = true;
  assert.equal((await fetch(origin + '/api/serving')).status, 200);
  assert.equal((await fetch(origin + '/api/ready')).status, 200);
  const response = await fetch(origin + '/chapitres/runtime-chapter', { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, 'A chapter absent at build time must render on its first request');
  assert.match(await response.text(), /<h1[^>]*>Chapitre de recette runtime<\/h1>/);
  cmsAvailable = false;
  assert.equal((await fetch(origin + '/api/serving')).status, 200, 'An admitted process remains routed during the outage');
  assert.equal((await fetch(origin + '/api/ready')).status, 503, 'Warm content must never validate a delivery');
  const warm = await fetch(origin + '/chapitres/runtime-chapter', { signal: AbortSignal.timeout(15000) });
  assert.equal(warm.status, 200);
  assert.match(await warm.text(), /<h1[^>]*>Chapitre de recette runtime<\/h1>/);
  const cold = await fetch(origin + '/chapitres/not-warmed', { signal: AbortSignal.timeout(15000) });
  assert.ok(cold.status >= 500, 'Uncached content is temporarily unavailable, never falsely not-found');
  cmsAvailable = true;
  assert.equal((await fetch(origin + '/api/ready')).status, 200, 'Strict readiness recovers on a real dependency check');
  console.log('Standalone runtime chapter, warm/cold outage and admission/readiness recovery: passed');
} catch (error) {
  console.error(output);
  throw error;
} finally {
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 5000);
  force.unref();
  await exited;
  clearTimeout(force);
  cms.closeAllConnections();
  await new Promise((resolve) => cms.close(resolve));
}
