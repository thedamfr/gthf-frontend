import { openSync, closeSync, fstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const source = process.argv[2];
if (!source || process.argv.length !== 3) {
  console.error('Usage : npm run infra:credentials:upload -- /chemin/identifiants-gthf.txt');
  process.exit(1);
}

const destination = '/home/ubuntu/gthf-delivery/credentials/ovh-gthf.txt';
// The secret travels only through SSH stdin, never through command arguments or logs.
const remote = `import os, pathlib, socket, sys, tempfile
if socket.gethostname() != 'game-prod-ovh-gra':
    raise SystemExit('Serveur inattendu')
directory = pathlib.Path('/home/ubuntu/gthf-delivery/credentials')
directory.mkdir(parents=True, exist_ok=True, mode=0o700)
if directory.is_symlink() or directory.stat().st_uid != os.getuid():
    raise SystemExit('Dossier prive inattendu')
directory.chmod(0o700)
payload = sys.stdin.buffer.read(1048577)
if not payload or len(payload) > 1048576:
    raise SystemExit('Le fichier doit contenir entre 1 octet et 1 Mio')
fd, temporary = tempfile.mkstemp(prefix='.ovh-gthf-', dir=directory)
try:
    with os.fdopen(fd, 'wb') as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, directory / 'ovh-gthf.txt')
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
`;
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
let descriptor;
let phase = 'file';
try {
  const sourcePath = source.startsWith('~/') ? resolve(homedir(), source.slice(2)) : resolve(source);
  descriptor = openSync(sourcePath, 'r');
  const stat = fstatSync(descriptor);
  if (!stat.isFile() || stat.size === 0 || stat.size > 1048576) throw new Error('Invalid input');
  phase = 'ssh';
  const transfer = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', 'penthouse', 'python3 -c ' + quote(remote)], {
    stdio: [descriptor, 'ignore', 'pipe'],
    timeout: 60000,
  });
  if (transfer.status !== 0) throw new Error('Transfer failed');
  console.log(`Fichier transféré vers penthouse:${destination} (dossier 700, fichier 600).`);
  console.log('Le fichier local est conservé. Aucune configuration applicative n’a été modifiée.');
} catch {
  console.error(phase === 'file'
    ? 'Fichier introuvable, inaccessible, vide ou supérieur à 1 Mio. Vérifier son chemin.'
    : 'Transfert SSH impossible. Vérifier la connexion : ssh penthouse');
  process.exitCode = 1;
} finally {
  if (descriptor !== undefined) closeSync(descriptor);
}
