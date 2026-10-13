import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const clever = process.env.CLEVER_BIN ?? 'clever';
const frontendApp = process.env.GTHF_FRONTEND_CLEVER_APP
  ?? 'app_daa50351-4554-4af2-903d-ccbd155b2c7b';
const sshHost = process.env.GTHF_DOCKER_SSH_HOST ?? 'qg-codex';
const context = process.env.GTHF_REMOTE_FRONTEND_CONTEXT
  ?? '/var/tmp/gthf-staging-20260909/frontend';
const targetName = process.argv[2] ?? 'staging';
const targets = {
  staging: {
    strapiUrl: 'https://staging-cms.gthf.fr',
    siteUrl: 'https://staging.gthf.fr',
  },
  production: {
    strapiUrl: 'https://cms.gthf.fr',
    siteUrl: 'https://gthf.fr',
  },
};
const target = targets[targetName];

if (!target) {
  throw new Error(`Unknown frontend build target: ${targetName}.`);
}

function environmentMap(value) {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value
        .map((entry) => [entry.name ?? entry.key, entry.value])
        .filter(([name, entryValue]) => name && entryValue !== undefined),
    );
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([name, entryValue]) => [
        name,
        entryValue && typeof entryValue === 'object' && 'value' in entryValue
          ? entryValue.value
          : entryValue,
      ]),
    );
  }
  return {};
}

const data = JSON.parse(
  execFileSync(clever, ['env', '--app', frontendApp, '--format', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }),
);
const environment = environmentMap(data.env ?? data);
const token = environment.STRAPI_API_TOKEN;
if (typeof token !== 'string' || token.length === 0 || /[\r\n]/.test(token)) {
  throw new Error('Missing or invalid STRAPI_API_TOKEN from Clever.');
}

const secretPath = `/var/tmp/gthf-strapi-api-token-${randomUUID()}`;
const install = spawnSync(
  'ssh',
  [
    '-o',
    'BatchMode=yes',
    sshHost,
    'install',
    '-m',
    '600',
    '/dev/stdin',
    secretPath,
  ],
  { input: token, encoding: 'utf8', stdio: ['pipe', 'ignore', 'inherit'] },
);

if (install.status !== 0) {
  throw new Error(`Unable to install the temporary build secret (exit ${install.status}).`);
}

try {
  execFileSync(
    'ssh',
    [
      '-o',
      'BatchMode=yes',
      sshHost,
      'docker',
      'build',
      '--progress=plain',
      '--secret',
      `id=strapi_api_token,src=${secretPath}`,
      '--build-arg',
      `NEXT_PUBLIC_STRAPI_URL=${target.strapiUrl}`,
      '--build-arg',
      `NEXT_PUBLIC_SITE_URL=${target.siteUrl}`,
      '--build-arg',
      'STRAPI_MEDIA_ORIGINS=https://cellar-c2.services.clever-cloud.com,https://gthdf-staging-media.s3.eu-west-par.io.cloud.ovh.net',
      '--build-arg',
      'NEXT_IMAGE_REMOTE_ORIGINS=https://cellar-c2.services.clever-cloud.com,https://gthdf-staging-media.s3.eu-west-par.io.cloud.ovh.net',
      '--tag',
      `gthf-frontend:${targetName}`,
      context,
    ],
    { stdio: 'inherit' },
  );
} finally {
  execFileSync(
    'ssh',
    ['-o', 'BatchMode=yes', sshHost, 'rm', '--', secretPath],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
}
