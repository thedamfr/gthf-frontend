import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream, rmSync, statSync } from 'node:fs';

const clever = process.env.CLEVER_BIN ?? 'clever';
const cmsApp = process.env.GTHF_CMS_CLEVER_APP
  ?? 'app_67466113-4135-4892-b3f5-2a8d5a3623f2';
const sshHost = process.env.GTHF_DOCKER_SSH_HOST ?? 'qg-codex';
const timestamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, '');
const dumpPath = process.env.GTHF_DUMP_PATH
  ?? `/private/tmp/gthf-clever-${timestamp}.dump`;
const postgresImage = 'postgres:17.11-alpine3.24@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73';

if (!/^\/private\/tmp\/gthf-clever-[A-Za-z0-9._-]+\.dump$/.test(dumpPath)) {
  throw new Error('GTHF_DUMP_PATH must be a gthf-clever-*.dump file under /private/tmp.');
}

function environmentMap(value) {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value
        .map((entry) => [entry.name ?? entry.key, entry.value])
        .filter(([name, entryValue]) => name && entryValue !== undefined),
    );
  }
  return value && typeof value === 'object' ? value : {};
}

const data = JSON.parse(
  execFileSync(clever, ['env', '--app', cmsApp, '--format', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }),
);
const environment = environmentMap(data.env);
for (const addon of data.fromAddons ?? []) {
  Object.assign(environment, environmentMap(addon.env));
}

function requireValue(name, pattern) {
  const value = environment[name];
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`Missing or invalid Clever value: ${name}`);
  }
  return value;
}

const host = requireValue('POSTGRESQL_ADDON_DIRECT_HOST', /^[A-Za-z0-9.-]+$/);
const port = requireValue('POSTGRESQL_ADDON_DIRECT_PORT', /^\d{2,5}$/);
const database = requireValue('POSTGRESQL_ADDON_DB', /^[A-Za-z0-9_.-]+$/);
const user = requireValue('POSTGRESQL_ADDON_USER', /^[A-Za-z0-9_.-]+$/);
const password = requireValue('POSTGRESQL_ADDON_PASSWORD', /^[^\r\n]+$/);

rmSync(dumpPath, { force: true });
const output = createWriteStream(dumpPath, { mode: 0o600 });
const outputClosed = once(output, 'close');
const child = spawn(
  'ssh',
  [
    '-o',
    'BatchMode=yes',
    sshHost,
    'docker',
    'run',
    '--rm',
    '--env-file',
    '/dev/stdin',
    postgresImage,
    'pg_dump',
    `--host=${host}`,
    `--port=${port}`,
    `--username=${user}`,
    `--dbname=${database}`,
    '--format=custom',
    '--compress=6',
    '--no-owner',
    '--no-privileges',
  ],
  { stdio: ['pipe', 'pipe', 'inherit'] },
);

child.stdout.pipe(output);
child.stdin.end(`PGPASSWORD=${password}\nPGSSLMODE=require\n`);
const [exitCode] = await once(child, 'close');
await outputClosed;

if (exitCode !== 0) {
  rmSync(dumpPath, { force: true });
  throw new Error(`pg_dump failed with exit ${exitCode}.`);
}

const size = statSync(dumpPath).size;
if (size < 1024 * 1024) {
  rmSync(dumpPath, { force: true });
  throw new Error(`The PostgreSQL dump is unexpectedly small (${size} bytes).`);
}

console.log(JSON.stringify({ dumpPath, bytes: size, mode: '0600' }));
