#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { createConnection } from 'node:net';
import process from 'node:process';

const kubeconfig =
  process.env.GTHF_OVH_KUBECONFIG ??
  `${homedir()}/.kube/gthf-ovh-readonly.yaml`;
const sshHost =
  process.env.GTHF_OVH_SSH_HOST ?? 'production@game-prod-ovh-gra';
const localPort = Number(process.env.GTHF_OVH_KUBE_PORT ?? '16443');

if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535) {
  throw new Error('GTHF_OVH_KUBE_PORT must be an unprivileged TCP port.');
}

if (!existsSync(kubeconfig)) {
  throw new Error(`Missing read-only kubeconfig: ${kubeconfig}`);
}

if (spawnSync('k9s', ['version'], { stdio: 'ignore' }).error) {
  throw new Error('k9s is not installed or is not available in PATH.');
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(250);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    const rejectConnection = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once('error', rejectConnection);
    socket.once('timeout', rejectConnection);
  });
}

async function waitForTunnel(tunnel) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (tunnel.exitCode !== null) {
      throw new Error('The SSH tunnel exited before becoming ready.');
    }
    if (await canConnect(localPort)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the SSH tunnel.');
}

const tunnel = spawn(
  'ssh',
  [
    '-N',
    '-L',
    `127.0.0.1:${localPort}:127.0.0.1:16443`,
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=30',
    sshHost,
  ],
  { stdio: ['ignore', 'inherit', 'inherit'] },
);

function stopTunnel() {
  if (tunnel.exitCode === null) {
    tunnel.kill('SIGTERM');
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    stopTunnel();
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
  });
}

try {
  await waitForTunnel(tunnel);
  const k9s = spawn(
    'k9s',
    [
      '--readonly',
      '--all-namespaces',
      '--kubeconfig',
      kubeconfig,
      '--context',
      'gthf-ovh-readonly',
    ],
    { stdio: 'inherit' },
  );
  const exitCode = await new Promise((resolve, reject) => {
    k9s.once('error', reject);
    k9s.once('exit', (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
} finally {
  stopTunnel();
}
