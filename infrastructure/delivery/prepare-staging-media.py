"""Run the one-off CMS data preparation in staging using the current local CMS image."""
import base64
import copy
import hashlib
import importlib.util
import json
import pathlib
import secrets
import time

directory = pathlib.Path(__file__).parent
spec = importlib.util.spec_from_file_location('release', directory / 'release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
root = pathlib.Path('/home/ubuntu/gthf-delivery')


def apply(value):
    release.kubectl('staging', 'apply', '-f', '-', data=json.dumps(value).encode())


def main():
    release.require_host()
    with release.environment_lock(root, 'staging', 'operator'):
        if not (root / 'staging-data.json').exists():
            raise RuntimeError('Editorial data must be copied without production identities first')
        if (root / 'staging-media.json').exists():
            print(json.dumps({'status': 'already prepared; no changes'}))
            return
        access_file = root / 'staging-access.json'
        access = release.load_json(access_file)
        if not access:
            access = {'email': 'recette@gthf.invalid', 'password': secrets.token_urlsafe(36), 'gatewayPassword': secrets.token_urlsafe(36), 'sessionKey': secrets.token_hex(32)}
            release.save_json(access_file, access)
        secret = {'apiVersion': 'v1', 'kind': 'Secret', 'metadata': {'namespace': 'gthf-qualification', 'name': 'gthf-staging-access'}, 'type': 'Opaque', 'data': {key: base64.b64encode(value.encode()).decode() for key, value in {'password': access['gatewayPassword'], 'session-key': access['sessionKey'], 'admin-password': access['password']}.items()}}
        # Use create/patch stdin so credential data never enters process arguments.
        current = release.kubectl('staging', 'get', 'secret', 'gthf-staging-access', '--ignore-not-found', '-o', 'json')
        if current:
            release.kubectl('staging', 'patch', 'secret', 'gthf-staging-access', '--type=merge', '--patch-file=/dev/stdin', data=json.dumps({'data': secret['data']}).encode())
        else:
            release.kubectl('staging', 'create', '-f', '-', data=json.dumps(secret).encode())
        policy = json.loads(release.kubectl('production', 'get', 'networkpolicy', 'allow-cms-egress', '-o', 'json'))
        apply({'apiVersion': policy['apiVersion'], 'kind': policy['kind'], 'metadata': {'namespace': 'gthf-qualification', 'name': policy['metadata']['name']}, 'spec': policy['spec']})
        source = 'docker.io/library/gthf-cms:staging'
        rows = release.command(['sudo', '-n', '/snap/bin/microk8s', 'ctr', 'images', 'ls']).decode().splitlines()
        row = next((row.split() for row in rows if row.startswith(source + ' ')), None)
        if not row:
            raise RuntimeError('The known local CMS image is unavailable')
        digest = row[2]
        alias = 'docker.io/library/gthf-cms:qualified-' + digest.split(':')[1]
        previous_alias = next((row.split() for row in rows if row.startswith(alias + ' ')), None)
        if previous_alias and previous_alias[2] != digest:
            raise RuntimeError('The local immutable CMS alias differs')
        if not previous_alias:
            release.command(['sudo', '-n', '/snap/bin/microk8s', 'ctr', 'images', 'tag', source, alias])
        script = (directory / 'prepare-delivery-staging.mjs').read_text()
        script_hash = hashlib.sha256(script.encode()).hexdigest()
        script_name = 'gthf-staging-data-script-' + script_hash[:12]
        apply({'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': {'namespace': 'gthf-qualification', 'name': script_name}, 'immutable': True, 'data': {'prepare-delivery-staging.mjs': script}})
        source_deployment = json.loads(release.kubectl('production', 'get', 'deployment', 'gthf-cms', '-o', 'json'))
        template = copy.deepcopy(source_deployment['spec']['template'])
        template['metadata'].pop('annotations', None)
        pod = template['spec']
        if any('persistentVolumeClaim' in volume for volume in pod.get('volumes', [])):
            raise RuntimeError('The CMS preparation must not mount persistent application volumes')
        pod['restartPolicy'] = 'Never'
        pod.pop('initContainers', None)
        container = pod['containers'][0]
        container['image'] = alias
        container['imagePullPolicy'] = 'Never'
        container['command'] = ['node', 'scripts/prepare-delivery-staging.mjs']
        container.pop('args', None)
        for probe in ('startupProbe', 'readinessProbe', 'livenessProbe', 'lifecycle'):
            container.pop(probe, None)
        container.setdefault('env', []).extend([
            {'name': 'GTHF_NAMESPACE', 'valueFrom': {'fieldRef': {'fieldPath': 'metadata.namespace'}}},
            {'name': 'STRAPI_API_TOKEN', 'valueFrom': {'secretKeyRef': {'name': 'gthf-secrets', 'key': 'STRAPI_API_TOKEN'}}},
            {'name': 'STAGING_ADMIN_PASSWORD', 'valueFrom': {'secretKeyRef': {'name': 'gthf-staging-access', 'key': 'admin-password'}}},
        ])
        container.setdefault('volumeMounts', []).append({'name': 'data-script', 'mountPath': '/app/scripts/prepare-delivery-staging.mjs', 'subPath': 'prepare-delivery-staging.mjs', 'readOnly': True})
        pod.setdefault('volumes', []).append({'name': 'data-script', 'configMap': {'name': script_name}})
        name = 'gthf-staging-data-' + str(int(time.time()))
        apply({'apiVersion': 'batch/v1', 'kind': 'Job', 'metadata': {'namespace': 'gthf-qualification', 'name': name}, 'spec': {'backoffLimit': 0, 'activeDeadlineSeconds': 1200, 'ttlSecondsAfterFinished': 86400, 'template': template}})
        deadline = time.monotonic() + 1260
        while time.monotonic() < deadline:
            state = json.loads(release.kubectl('staging', 'get', 'job', name, '-o', 'json'))['status']
            if state.get('failed'):
                raise RuntimeError('Staging media preparation failed; inspect only this job: ' + name)
            if state.get('succeeded'):
                proof = {'status': 'media and private access prepared', 'job': name, 'cmsManifest': digest, 'scriptSha256': script_hash, 'productionWrites': 0}
                release.save_json(root / 'staging-media.json', proof)
                print(json.dumps(proof))
                return
            time.sleep(3)
        raise RuntimeError('Staging media preparation timed out: ' + name)


if __name__ == '__main__':
    main()
