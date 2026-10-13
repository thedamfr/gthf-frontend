"""Prepare only the isolated database foundation; never switch public routing."""
import json
import contextlib
import fcntl
import os
import pathlib
import secrets
import stat
import socket
import subprocess

namespace = 'gthf-qualification'
state = pathlib.Path('/home/ubuntu/gthf-delivery')
namespace_labels = {
    'app.kubernetes.io/name': 'gthf', 'gthf.fr/environment': 'staging',
    'pod-security.kubernetes.io/audit': 'restricted',
    'pod-security.kubernetes.io/enforce': 'restricted',
    'pod-security.kubernetes.io/warn': 'restricted',
}


def kube(*args, data=None):
    result = subprocess.run(['sudo', '-n', '/snap/bin/microk8s', 'kubectl', *args], input=data, capture_output=True, timeout=360)
    if result.returncode:
        raise RuntimeError('Kubernetes foundation operation failed: ' + ' '.join(args[:3]))
    return result.stdout


def read(ns, kind, name):
    return json.loads(kube('-n', ns, 'get', kind, name, '-o', 'json'))


def read_optional(ns, kind, name):
    payload = kube('-n', ns, 'get', kind, name, '--ignore-not-found', '-o', 'json')
    return json.loads(payload) if payload.strip() else None


def apply(value):
    kube('apply', '-f', '-', data=json.dumps(value).encode())


def transplant(resource):
    return {
        'apiVersion': resource['apiVersion'], 'kind': resource['kind'],
        'metadata': {'name': resource['metadata']['name'], 'namespace': namespace, 'labels': resource['metadata'].get('labels', {})},
        **{key: resource[key] for key in ('spec', 'data') if key in resource},
    }


def require_secret_isolation(staging, production):
    for key in ['POSTGRES_PASSWORD', 'APP_KEYS', 'API_TOKEN_SALT', 'ADMIN_JWT_SECRET', 'TRANSFER_TOKEN_SALT', 'ENCRYPTION_KEY', 'JWT_SECRET', 'PREVIEW_SECRET', 'STRAPI_API_TOKEN']:
        if not staging.get(key) or not production.get(key) or staging[key] == production[key]:
            raise RuntimeError('Staging secret isolation failed: ' + key)


def require_private_directory(directory):
    metadata = directory.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o700 or metadata.st_uid != os.geteuid():
        raise RuntimeError('The delivery state directory must be private and owned by the operator')


def staging_configuration(source):
    shared_keys = ('NODE_ENV', 'XDG_CONFIG_HOME', 'STRAPI_TELEMETRY_DISABLED', 'HOST', 'PORT', 'PROXY_KOA', 'DATABASE_POOL_MIN', 'DATABASE_POOL_MAX')
    config = {key: source[key] for key in shared_keys if key in source}
    config.update({
        'DATABASE_CLIENT': 'postgres', 'DATABASE_HOST': 'gthf-postgres', 'DATABASE_PORT': '5432',
        'DATABASE_NAME': 'gthdf', 'DATABASE_USERNAME': 'gthdf', 'DATABASE_SSL': 'false',
        'PUBLIC_URL': 'https://staging-cms.gthf.fr', 'CLIENT_URL': 'https://staging.gthf.fr',
        'PREVIEW_ALLOWED_ORIGINS': 'https://staging.gthf.fr', 'STRAPI_URL': 'http://gthf-cms:1337',
        'PUBLIC_STRAPI_URL': 'https://staging-cms.gthf.fr', 'SITE_URL': 'https://staging.gthf.fr',
        'NEXT_PUBLIC_STRAPI_URL': 'https://staging-cms.gthf.fr', 'NEXT_PUBLIC_SITE_URL': 'https://staging.gthf.fr',
        'AWS_REGION': 'gra', 'AWS_ENDPOINT': 'https://s3.gra.io.cloud.ovh.net',
        'AWS_BUCKET': 'gthf-staging-media-bis', 'AWS_CDN_URL': 'https://gthf-staging-media-bis.s3.gra.io.cloud.ovh.net',
        'MEDIA_ALLOWED_ORIGINS': 'https://gthf-staging-media-bis.s3.gra.io.cloud.ovh.net',
        'STRAPI_MEDIA_ORIGINS': 'https://gthf-staging-media-bis.s3.gra.io.cloud.ovh.net',
        'DATABASE_FORCE_MIGRATION': 'false',
    })
    return config


def require_distinct_volumes(production, staging):
    if not production or production == staging:
        raise RuntimeError('Database volumes are not isolated')


@contextlib.contextmanager
def staging_lock(directory):
    with open(directory / 'staging.lock', 'a') as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Staging is already being prepared or deployed') from None
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def main():
    if socket.gethostname() != 'game-prod-ovh-gra' or kube('config', 'current-context').decode().strip() != 'microk8s':
        raise RuntimeError('Unexpected deployment target')
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    require_private_directory(state)
    with staging_lock(state):
        prepare()


def prepare():
    source_volume = read('gthf-staging', 'pvc', 'gthf-postgres')
    existing_volume = read_optional(namespace, 'pvc', 'gthf-postgres')
    staging_volume = existing_volume['spec'].get('volumeName') if existing_volume else None
    require_distinct_volumes(source_volume['spec'].get('volumeName'), staging_volume)
    checkpoint = state / 'staging-foundation.json'
    if checkpoint.exists():
        require_secret_isolation(read(namespace, 'secret', 'gthf-secrets')['data'], read('gthf-staging', 'secret', 'gthf-secrets')['data'])
        kube('-n', namespace, 'rollout', 'status', 'statefulset/gthf-postgres', '--timeout=60s')
        expected = json.loads(checkpoint.read_text())
        if read(namespace, 'pvc', 'gthf-postgres')['spec']['volumeName'] != expected['stagingVolume']:
            raise RuntimeError('The staging volume has changed since the recorded preparation')
        current_labels = json.loads(kube('get', 'namespace', namespace, '-o', 'json'))['metadata'].get('labels', {})
        changed = any(current_labels.get(key) != value for key, value in namespace_labels.items())
        if changed:
            kube('label', 'namespace', namespace, '--overwrite', *[key + '=' + value for key, value in namespace_labels.items()])
        print(json.dumps({'namespace': namespace, 'status': 'namespace security aligned; database preserved' if changed else 'already prepared; no changes'}))
        raise SystemExit(0)
    # Require the source to be healthy before taking its non-secret resource definitions.
    kube('-n', 'gthf-staging', 'rollout', 'status', 'statefulset/gthf-postgres', '--timeout=60s')
    apply({'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': {'name': namespace, 'labels': namespace_labels}})
    existing = read_optional(namespace, 'secret', 'gthf-secrets')
    if existing is not None:
        if existing['metadata'].get('labels', {}).get('gthf.fr/provisioner') != 'continuous-delivery':
            raise RuntimeError('Existing staging credentials require inspection; refusing to replace them')
        require_secret_isolation(existing['data'], read('gthf-staging', 'secret', 'gthf-secrets')['data'])
    else:
        values = {key: secrets.token_hex(48) for key in ['POSTGRES_PASSWORD', 'APP_KEYS', 'API_TOKEN_SALT', 'ADMIN_JWT_SECRET', 'TRANSFER_TOKEN_SALT', 'ENCRYPTION_KEY', 'JWT_SECRET', 'PREVIEW_SECRET', 'STRAPI_API_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']}
        values['APP_KEYS'] = ','.join(secrets.token_hex(32) for _ in range(4))
        apply({'apiVersion': 'v1', 'kind': 'Secret', 'metadata': {'name': 'gthf-secrets', 'namespace': namespace, 'labels': {'gthf.fr/provisioner': 'continuous-delivery'}}, 'type': 'Opaque', 'stringData': values})
    for kind, name in [('serviceaccount', 'gthf'), ('limitrange', 'gthf-defaults'), ('networkpolicy', 'default-deny'), ('networkpolicy', 'allow-postgres-from-cms')]:
        apply(transplant(read('gthf-staging', kind, name)))
    quota = transplant(read('gthf-staging', 'resourcequota', 'gthf-budget'))
    quota['spec']['hard'].update({'requests.cpu': '2', 'requests.memory': '3Gi', 'limits.cpu': '8', 'limits.memory': '8Gi'})
    apply(quota)
    config = transplant(read('gthf-staging', 'configmap', 'gthf-config'))
    config['data'] = staging_configuration(config['data'])
    apply(config)
    volume = transplant(source_volume)
    volume['spec'].pop('volumeName', None)
    apply(volume)
    service = transplant(read('gthf-staging', 'service', 'gthf-postgres'))
    for key in ['clusterIP', 'clusterIPs', 'ipFamilies', 'ipFamilyPolicy']:
        service['spec'].pop(key, None)
    apply(service)
    postgres = transplant(read('gthf-staging', 'statefulset', 'gthf-postgres'))
    source_pod = read('gthf-staging', 'pod', 'gthf-postgres-0')
    source_image = 'docker.io/library/gthf-postgres:staging'
    image_rows = subprocess.check_output(['sudo', '-n', '/snap/bin/microk8s', 'ctr', 'images', 'ls'], text=True).splitlines()
    source_row = next((row.split() for row in image_rows if row.startswith(source_image + ' ')), None)
    if not source_row or not source_row[2].startswith('sha256:'):
        raise RuntimeError('The current PostgreSQL image cannot be resolved locally')
    manifest_digest = source_row[2]
    image_id = 'docker.io/library/gthf-postgres:qualified-' + manifest_digest.split(':')[1]
    existing_alias = next((row.split() for row in image_rows if row.startswith(image_id + ' ')), None)
    if existing_alias and existing_alias[2] != manifest_digest:
        raise RuntimeError('The immutable database alias already has a different digest')
    if not existing_alias:
        subprocess.run(['sudo', '-n', '/snap/bin/microk8s', 'ctr', 'images', 'tag', source_image, image_id], check=True, capture_output=True)
    postgres['spec']['template']['spec']['containers'][0]['image'] = image_id
    postgres['spec']['template']['spec']['containers'][0]['imagePullPolicy'] = 'Never'
    apply(postgres)
    kube('-n', namespace, 'rollout', 'status', 'statefulset/gthf-postgres', '--timeout=300s')
    source_volume = read('gthf-staging', 'pvc', 'gthf-postgres')
    destination_volume = read(namespace, 'pvc', 'gthf-postgres')
    if source_volume['spec']['volumeName'] == destination_volume['spec']['volumeName']:
        raise RuntimeError('Database volumes are not isolated')
    stage_pod = read(namespace, 'pod', 'gthf-postgres-0')
    if stage_pod['status']['containerStatuses'][0]['imageID'] != source_pod['status']['containerStatuses'][0]['imageID']:
        raise RuntimeError('The staging database does not run the same PostgreSQL image')
    proof = {'namespace': namespace, 'postgresImage': image_id, 'postgresManifest': manifest_digest, 'productionVolume': source_volume['spec']['volumeName'], 'stagingVolume': destination_volume['spec']['volumeName'], 'status': 'empty database ready; public routing unchanged'}
    with open(checkpoint, 'w', opener=lambda p, flags: os.open(p, flags, 0o600)) as stream:
        json.dump(proof, stream, indent=2)
    print(json.dumps(proof))


if __name__ == '__main__':
    main()
