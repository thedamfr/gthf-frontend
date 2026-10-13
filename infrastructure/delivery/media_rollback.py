"""A rollback must retain the CMS worker that owns durable media intentions."""
import json
import re

TABLES_SQL = """BEGIN TRANSACTION READ ONLY;
SELECT json_build_object(
  'operations', to_regclass('public.gthf_media_operations') IS NOT NULL,
  'cleanup', to_regclass('public.gthf_media_cleanup') IS NOT NULL);
COMMIT;
"""
COUNTS_SQL = """BEGIN TRANSACTION READ ONLY;
SELECT json_build_object(
  'preparing', (SELECT count(*) FROM public.gthf_media_operations WHERE state = 'preparing'),
  'prepared', (SELECT count(*) FROM public.gthf_media_operations WHERE state = 'prepared'),
  'interrupted', (SELECT count(*) FROM public.gthf_media_operations WHERE state = 'interrupted'),
  'cleanupPending', (SELECT count(*) FROM public.gthf_media_cleanup WHERE state = 'pending'),
  'unknownOperations', (SELECT count(*) FROM public.gthf_media_operations WHERE state NOT IN ('preparing', 'prepared', 'interrupted', 'committed', 'failed') OR state IS NULL),
  'unknownCleanup', (SELECT count(*) FROM public.gthf_media_cleanup WHERE state NOT IN ('pending', 'done') OR state IS NULL));
COMMIT;
"""
COUNT_FIELDS = {'preparing', 'prepared', 'interrupted', 'cleanupPending', 'unknownOperations', 'unknownCleanup'}


def journal_state(environment, kubectl):
    def query(sql):
        # Historical database/user identities are deliberately preserved.
        return json.loads(kubectl(environment, 'exec', '-i', 'gthf-postgres-0', '--',
                                  'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'gthdf', '-d', 'gthdf',
                                  data=sql.encode(), timeout=20))
    tables = query(TABLES_SQL)
    if not isinstance(tables, dict) or set(tables) != {'operations', 'cleanup'} or any(type(value) is not bool for value in tables.values()):
        raise RuntimeError('Media journal table state could not be verified')
    if not any(tables.values()):
        return {'tables': tables, 'counts': None}
    if not all(tables.values()):
        raise RuntimeError('Media journal tables are incomplete')
    counts = query(COUNTS_SQL)
    if not isinstance(counts, dict) or set(counts) != COUNT_FIELDS or any(type(value) is not int or value < 0 for value in counts.values()):
        raise RuntimeError('Media journal operation counts could not be verified')
    if counts['unknownOperations'] or counts['unknownCleanup']:
        raise RuntimeError('Media journal contains an unsupported state')
    return {'tables': tables, 'counts': counts}


def target_capability(deployment, command):
    if not deployment:
        raise RuntimeError('A CMS worker is required to retain media recovery')
    template = deployment['spec']['template']
    containers = template['spec']['containers'] + template['spec'].get('initContainers', [])
    images = {container['image'] for container in containers}
    if len(images) != 1:
        raise RuntimeError('CMS rollback images cannot be verified')
    image = images.pop()
    revision = template['metadata'].get('annotations', {}).get('gthf.fr/source-revision', '')
    if not re.fullmatch(r'ghcr\.io/thedamfr/gthf-cms@sha256:[a-f0-9]{64}', image) or not re.fullmatch(r'[a-f0-9]{40}', revision):
        raise RuntimeError('CMS rollback requires an immutable image and expected revision')
    manifest_digest = image.split('@')[1]
    manifest = json.loads(command(['sudo', '-n', '/snap/bin/microk8s', 'ctr', 'content', 'get', manifest_digest], timeout=20))
    config_digest = manifest.get('config', {}).get('digest', '')
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', config_digest):
        raise RuntimeError('CMS rollback requires a single-platform image manifest')
    config = json.loads(command(['sudo', '-n', '/snap/bin/microk8s', 'ctr', 'content', 'get', config_digest], timeout=20))
    labels = config.get('config', {}).get('Labels', {})
    if labels.get('org.opencontainers.image.revision') != revision or labels.get('io.gthf.media-recovery') != '1':
        raise RuntimeError('CMS rollback target does not attest media recovery version 1 at the expected revision')
    return {'image': image, 'revision': revision, 'mediaRecoveryVersion': '1'}


def require_media_rollback(environment, deployment, kubectl, command, evidence):
    evidence.update(environment=environment, status='blocked')
    try:
        state = journal_state(environment, kubectl)
        evidence.update(state)
        if any(state['tables'].values()):
            # A zero count is not a write barrier: a new intent may arrive before
            # the image changes. Existing tables always require a compatible worker.
            evidence['target'] = target_capability(deployment, command)
            evidence['reason'] = 'existing-journal-requires-compatible-worker-even-when-empty'
        else:
            evidence['reason'] = 'journal-tables-absent'
        evidence['status'] = 'allowed'
    except Exception as error:
        evidence['errorType'] = type(error).__name__
        raise RuntimeError('CMS rollback blocked: durable media recovery compatibility could not be verified') from error
