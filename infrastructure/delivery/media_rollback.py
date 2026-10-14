"""A rollback must retain the CMS worker that owns durable media intentions."""
import json
import re

TABLES_SQL = """BEGIN TRANSACTION READ ONLY;
SELECT json_build_object(
  'operations', to_regclass('public.gthf_media_operations') IS NOT NULL,
  'cleanup', to_regclass('public.gthf_media_cleanup') IS NOT NULL,
  'batches', to_regclass('public.gthf_media_batches') IS NOT NULL);
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
BATCH_COUNTS_SQL = """BEGIN TRANSACTION READ ONLY;
SELECT json_build_object(
  'pending', (SELECT count(*) FROM public.gthf_media_batches WHERE state = 'pending'),
  'committed', (SELECT count(*) FROM public.gthf_media_batches WHERE state = 'committed'),
  'failed', (SELECT count(*) FROM public.gthf_media_batches WHERE state = 'failed'),
  'unknown', (SELECT count(*) FROM public.gthf_media_batches WHERE state NOT IN ('pending', 'committed', 'failed') OR state IS NULL));
COMMIT;
"""
BATCH_COUNT_FIELDS = {'pending', 'committed', 'failed', 'unknown'}
COUNT_FIELDS = {'preparing', 'prepared', 'interrupted', 'cleanupPending', 'unknownOperations', 'unknownCleanup'}


def journal_state(environment, kubectl):
    def query(sql):
        # Historical database/user identities are deliberately preserved.
        return json.loads(kubectl(environment, 'exec', '-i', 'gthf-postgres-0', '--',
                                  'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'gthdf', '-d', 'gthdf',
                                  data=sql.encode(), timeout=20))
    tables = query(TABLES_SQL)
    if not isinstance(tables, dict) or set(tables) != {'operations', 'cleanup', 'batches'} or any(type(value) is not bool for value in tables.values()):
        raise RuntimeError('Media journal table state could not be verified')
    if not any(tables.values()):
        return {'tables': tables, 'counts': None, 'batchCounts': None}
    if not tables['operations'] or not tables['cleanup']:
        raise RuntimeError('Media journal tables are incomplete')
    counts = query(COUNTS_SQL)
    if not isinstance(counts, dict) or set(counts) != COUNT_FIELDS or any(type(value) is not int or value < 0 for value in counts.values()):
        raise RuntimeError('Media journal operation counts could not be verified')
    if counts['unknownOperations'] or counts['unknownCleanup']:
        raise RuntimeError('Media journal contains an unsupported state')
    batches = query(BATCH_COUNTS_SQL) if tables['batches'] else None
    if tables['batches']:
        if (not isinstance(batches, dict) or set(batches) != BATCH_COUNT_FIELDS
                or any(type(value) is not int or value < 0 for value in batches.values()) or batches['unknown']):
            raise RuntimeError('Media batch state could not be verified')
    return {'tables': tables, 'counts': counts, 'batchCounts': batches}


def target_capability(deployment, command, *, batch_required=False):
    if not deployment:
        raise RuntimeError('A CMS worker is required to retain media recovery')
    template = deployment['spec']['template']
    containers = template['spec']['containers'] + template['spec'].get('initContainers', [])
    images = {container['image'] for container in containers}
    if len(images) != 1:
        raise RuntimeError('CMS rollback images cannot be verified')
    image = images.pop()
    revision = template['metadata'].get('annotations', {}).get('gthf.fr/source-revision', '')
    capability = image_capability(image, revision, command)
    if capability['mediaRecoveryVersion'] != '2':
        raise RuntimeError('CMS rollback target does not attest media recovery version 2 at the expected revision')
    if batch_required and capability['mediaBatchRecoveryVersion'] != '1':
        raise RuntimeError('CMS rollback target cannot resume durable media batches')
    return capability


def image_capability(image, revision, command):
    """Read only the exact locally cached previous image; never guess its capability."""
    if not re.fullmatch(r'ghcr\.io/thedamfr/gthf-cms@sha256:[a-f0-9]{64}', image) or not re.fullmatch(r'[a-f0-9]{40}', revision):
        raise RuntimeError('CMS transition requires an immutable image and expected revision')
    manifest_digest = image.split('@')[1]
    manifest = json.loads(command(['sudo', '-n', '/snap/bin/microk8s', 'ctr', 'content', 'get', manifest_digest], timeout=20))
    config_digest = manifest.get('config', {}).get('digest', '')
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', config_digest):
        raise RuntimeError('CMS transition requires a single-platform image manifest')
    config = json.loads(command(['sudo', '-n', '/snap/bin/microk8s', 'ctr', 'content', 'get', config_digest], timeout=20))
    labels = config.get('config', {}).get('Labels', {})
    version = labels.get('io.gthf.media-recovery')
    if labels.get('org.opencontainers.image.revision') != revision or version not in (None, '1', '2'):
        raise RuntimeError('CMS transition image revision or media recovery capability is unsupported')
    batch_version = labels.get('io.gthf.media-batch-recovery')
    if batch_version not in (None, '1'):
        raise RuntimeError('CMS media batch recovery capability is unsupported')
    return {'image': image, 'revision': revision, 'mediaRecoveryVersion': version or '0',
            'mediaBatchRecoveryVersion': batch_version or '0'}


def require_media_rollback(environment, deployment, kubectl, command, evidence):
    evidence.update(environment=environment, status='blocked')
    try:
        state = journal_state(environment, kubectl)
        evidence.update(state)
        # Neither absent tables nor zero counts are a write barrier. A candidate
        # may commit its journal initialization after this read. Both rollback
        # callers can follow an attempted activation, so always retain the full
        # media/history and batch contract, even before its tables are visible.
        evidence['requiredCapabilities'] = {'mediaRecoveryVersion': '2', 'mediaBatchRecoveryVersion': '1'}
        evidence['target'] = target_capability(deployment, command, batch_required=True)
        evidence['reason'] = 'activation-may-have-started-requires-media2-batch1'
        evidence['status'] = 'allowed'
    except Exception as error:
        evidence['errorType'] = type(error).__name__
        evidence['requiredAction'] = 'repair-forward-with-compatible-worker'
        raise RuntimeError('CMS rollback blocked: durable media recovery compatibility could not be verified; repair forward with a compatible worker') from error
