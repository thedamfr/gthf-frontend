"""Install the user-supplied GTHF S3 credentials into staging only."""
import base64
import json
import os
import pathlib
import socket
import subprocess

namespace = 'gthf-qualification'


def kube(*args, data=None):
    result = subprocess.run(['sudo', '-n', '/snap/bin/microk8s', 'kubectl', *args], input=data, capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError('Staging storage configuration failed')
    return result.stdout


if socket.gethostname() != 'game-prod-ovh-gra' or kube('config', 'current-context').decode().strip() != 'microk8s':
    raise RuntimeError('Unexpected deployment target')
source = pathlib.Path('/home/ubuntu/gthf-delivery/credentials/ovh-gthf.txt')
if source.is_symlink() or source.stat().st_uid != os.getuid() or source.stat().st_mode & 0o077:
    raise RuntimeError('The credential file must be private and owned by the operator')
credentials = json.loads(source.read_text())
values = {'AWS_ACCESS_KEY_ID': credentials['accessKey'], 'AWS_SECRET_ACCESS_KEY': credentials['secretKey']}
if any(not isinstance(value, str) or not value or len(value) > 4096 for value in values.values()):
    raise RuntimeError('Invalid S3 credentials')
current = json.loads(kube('-n', namespace, 'get', 'secret', 'gthf-secrets', '-o', 'json'))
changed = False
if any(current['data'].get(key) != base64.b64encode(value.encode()).decode() for key, value in values.items()):
    kube('-n', namespace, 'patch', 'secret', 'gthf-secrets', '--type=merge', '--patch-file=/dev/stdin', data=json.dumps({'stringData': values}).encode())
    changed = True
origin = 'https://gthf-staging-media-bis.s3.gra.io.cloud.ovh.net'
config = {
    'AWS_REGION': 'gra', 'AWS_ENDPOINT': 'https://s3.gra.io.cloud.ovh.net',
    'AWS_BUCKET': 'gthf-staging-media-bis', 'AWS_CDN_URL': origin,
    'MEDIA_ALLOWED_ORIGINS': origin, 'STRAPI_MEDIA_ORIGINS': origin,
}
current = json.loads(kube('-n', namespace, 'get', 'configmap', 'gthf-config', '-o', 'json'))
if any(current['data'].get(key) != value for key, value in config.items()):
    kube('-n', namespace, 'patch', 'configmap', 'gthf-config', '--type=merge', '--patch-file=/dev/stdin', data=json.dumps({'data': config}).encode())
    changed = True
print(json.dumps({'namespace': namespace, 'bucket': config['AWS_BUCKET'], 'changed': changed, 'productionModified': False}))
