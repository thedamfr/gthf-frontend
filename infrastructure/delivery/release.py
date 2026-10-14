"""GTHF delivery policy; the operator and CI use the same guarded activation."""
import argparse
import base64
import contextlib
import datetime
import fcntl
import fnmatch
import hashlib
import json
import os
import pathlib
import re
import signal
import socket
import stat
import subprocess
import tempfile
import time
import urllib.request

NAMESPACES = {'production': 'gthf-staging', 'staging': 'gthf-qualification'}
HOSTS = {
    'production': {'frontend': 'https://gthf.fr', 'cms': 'https://cms.gthf.fr'},
    'staging': {'frontend': 'https://staging.gthf.fr', 'cms': 'https://staging-cms.gthf.fr'},
}


def validate_component(name, component):
    if name not in ('cms', 'frontend'):
        raise ValueError('Unsupported component')
    if not re.fullmatch(r'ghcr\.io/thedamfr/gthf-' + name + r'@sha256:[a-f0-9]{64}', component.get('image', '')):
        raise ValueError('An immutable GTHF image digest is required')
    if not re.fullmatch(r'[a-f0-9]{40}', component.get('revision', '')):
        raise ValueError('An exact Git revision is required')


def promote(activate, verify=None):
    if verify:
        verify()
    activate('staging')
    activate('production')


def require_isolated_staging_routes(ingresses, alternate_routes=()):
    hosts = {'staging.gthf.fr', 'staging-cms.gthf.fr'}
    found = set()
    for ingress in ingresses:
        if ingress.get('spec', {}).get('defaultBackend'):
            raise RuntimeError('A default Ingress backend requires routing review before staging delivery')
        for rule in ingress.get('spec', {}).get('rules', []):
            pattern = rule.get('host') or '*'
            if not any(fnmatch.fnmatchcase(host, pattern) for host in hosts):
                continue
            if pattern not in hosts:
                raise RuntimeError('A wildcard or hostless Ingress may bypass the staging gateway')
            services = [path.get('backend', {}).get('service', {}) for path in rule.get('http', {}).get('paths', [])]
            if (ingress['metadata'].get('namespace') != NAMESPACES['staging'] or not services
                    or any(service.get('name') != 'gthf-staging-gateway' or service.get('port') not in ({'number': 3001}, {'name': 'http'}) for service in services)):
                raise RuntimeError('Conflicting staging Ingress: complete the reviewed gateway cutover before delivery')
            tls = ingress.get('spec', {}).get('tls', [])
            middlewares = ingress['metadata'].get('annotations', {}).get('traefik.ingress.kubernetes.io/router.middlewares', '')
            if (not any(pattern in entry.get('hosts', []) and entry.get('secretName') for entry in tls)
                    or 'gthf-qualification-https-redirect@kubernetescrd' not in middlewares.split(',')):
                raise RuntimeError('Staging routes must retain TLS and the reviewed HTTPS redirect')
            found.add(rule['host'])
    if found != hosts:
        raise RuntimeError('Both staging hosts must be routed through the qualification gateway before delivery')
    for route in alternate_routes:
        if route['kind'] in ('HTTPRoute', 'GRPCRoute'):
            patterns = route.get('spec', {}).get('hostnames') or ['*']
            if not any(fnmatch.fnmatchcase(host, pattern) for host in hosts for pattern in patterns):
                continue
        elif route['kind'] in ('IngressRoute', 'IngressRouteTCP'):
            matches = [rule.get('match', '') for rule in route.get('spec', {}).get('routes', [])]
            # Only provably unrelated literal hosts are accepted. Regex/catch-all
            # routing requires platform review rather than guessing precedence.
            parsed = [re.fullmatch(r'Host(?:SNI)?\(`([a-zA-Z0-9.-]+)`\)(?:\s*&&\s*PathPrefix\(`[^`]+`\))*', match) for match in matches]
            if matches and all(match and match[1].lower() not in hosts for match in parsed):
                continue
        raise RuntimeError('An alternate route may reach staging; review its routing boundary before delivery')


def require_compatible_schema(previous, candidate):
    """Only optional additive attributes can be synchronized during a rolling update."""
    for path, old in previous.items():
        new = candidate.get(path)
        if not new:
            raise ValueError('Removed CMS schema requires a separate migration plan')
        for key, value in old.items():
            if key != 'attributes' and new.get(key) != value:
                raise ValueError('Changed CMS schema configuration requires review')
        for attribute, value in old.get('attributes', {}).items():
            if new.get('attributes', {}).get(attribute) != value:
                raise ValueError('Changed CMS attribute requires a separate migration plan')
    for path, new in candidate.items():
        old_attributes = previous.get(path, {}).get('attributes', {})
        for attribute, value in new.get('attributes', {}).items():
            if attribute not in old_attributes and (value.get('required') or value.get('unique')):
                raise ValueError('Constrained new attributes require a separate migration plan')


def command(arguments, *, data=None, timeout=600):
    result = subprocess.run(arguments, input=data, capture_output=True, timeout=timeout)
    if result.returncode:
        # Do not echo subprocess output: callers may pass private backup or environment data.
        raise RuntimeError('Command failed: ' + ' '.join(arguments[:4]))
    return result.stdout


def kubectl(environment, *arguments, data=None, timeout=600):
    return command(['sudo', '-n', '/snap/bin/microk8s', 'kubectl', '-n', NAMESPACES[environment], *arguments], data=data, timeout=timeout)


def save_json(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    with open(temporary, 'w', opener=lambda p, flags: os.open(p, flags, 0o600)) as stream:
        json.dump(value, stream, sort_keys=True, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def load_json(path, default=None):
    return json.loads(path.read_text()) if path.exists() else default


def require_private_directory(directory):
    metadata = directory.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o700 or metadata.st_uid != os.geteuid():
        raise RuntimeError('The delivery state directory must be private and owned by the operator')


@contextlib.contextmanager
def environment_lock(root, environment, owner):
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    require_private_directory(root)
    with open(root / (environment + '.lock'), 'a') as stream:
        deadline = time.monotonic() + 1800
        while True:
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                reservation = load_json(root / 'staging-reservation.json', {})
                if environment == 'staging' and reservation.get('expires', 0) > time.time() and reservation.get('owner') != owner:
                    fcntl.flock(stream, fcntl.LOCK_UN)
                    if time.monotonic() > deadline:
                        raise RuntimeError('Staging remains reserved for a demonstration')
                    time.sleep(5)
                    continue
                break
            except BlockingIOError:
                if time.monotonic() > deadline:
                    raise RuntimeError('Environment is already being deployed')
                time.sleep(5)
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def require_host():
    if socket.gethostname() != 'game-prod-ovh-gra':
        raise RuntimeError('Unexpected deployment host')
    context = command(['sudo', '-n', '/snap/bin/microk8s', 'kubectl', 'config', 'current-context']).decode().strip()
    if context != 'microk8s':
        raise RuntimeError('Unexpected Kubernetes context')


def current_main(component):
    url = f'https://api.github.com/repos/thedamfr/gthf-{component}/git/ref/heads/main'
    request = urllib.request.Request(url, headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'gthf-delivery'})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)['object']['sha']


def require_current(candidate):
    for name, value in candidate['components'].items():
        validate_component(name, value)
        if current_main(name) != value['processedRevision']:
            raise RuntimeError('Candidate is no longer the current main revision')


def require_candidate_images(components, reference, verify_source=None):
    for name, value in components.items():
        previous = reference[name]
        if value['image'] == previous['image']:
            runtime = value.get('fingerprints', {}).get('runtime')
            if (value['revision'] != previous['revision'] or not runtime
                    or runtime != previous.get('fingerprints', {}).get('runtime')):
                raise ValueError('Reused images must preserve the verified revision and runtime fingerprint')
        elif value['revision'] != value['processedRevision'] and (verify_source is None or not verify_source(name, value)):
            raise ValueError('New images must identify the processed Git revision')


def source_equivalent(root, name, value):
    repository = root / 'repositories' / ('gthf-' + name + '.git')
    planner = pathlib.Path(__file__).with_name('plan.mjs')
    def inputs(revision):
        return json.loads(command(['node', str(planner), str(repository), revision]))['fingerprints']['runtime']
    return inputs(value['revision']) == inputs(value['processedRevision']) == value['fingerprints']['runtime']


def require_image_revision(config, revision, component=None):
    if config.get('config', {}).get('Labels', {}).get('org.opencontainers.image.revision') != revision:
        raise ValueError('Image revision does not match its immutable OCI label')
    if component == 'cms' and config.get('config', {}).get('Labels', {}).get('io.gthf.media-recovery') != '2':
        raise ValueError('Candidate CMS requires media recovery version 2 to preserve referenced history')
    if component == 'cms' and config.get('config', {}).get('Labels', {}).get('io.gthf.media-batch-recovery') != '1':
        raise ValueError('Candidate CMS requires durable media batch recovery version 1')


def verify_registry_components(root, components):
    # Use the existing read-only GHCR credential without placing it in argv or logs.
    secret = json.loads(kubectl('staging', 'get', 'secret', 'gthf-ghcr', '-o', 'json'))
    config = base64.b64decode(secret['data']['.dockerconfigjson'])
    with tempfile.TemporaryDirectory(prefix='registry-', dir=root) as directory:
        config_file = pathlib.Path(directory) / 'config.json'
        with open(config_file, 'wb', opener=lambda path, flags: os.open(path, flags, 0o600)) as stream:
            stream.write(config)
        for name, value in components.items():
            validate_component(name, value)
            image = json.loads(command(['docker', '--config', directory, 'buildx', 'imagetools', 'inspect', value['image'], '--format', '{{json .Image}}'], timeout=120))
            require_image_revision(image, value['revision'], name)


class NoReleaseRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        response.close()
        raise RuntimeError('Release proof cannot redirect to another endpoint')


def http_json(url, timeout=30):
    headers = {'Cache-Control': 'no-cache', 'User-Agent': 'gthf-delivery'}
    if any(url.startswith(origin + '/') for origin in HOSTS['staging'].values()):
        credentials = load_json(pathlib.Path('/home/ubuntu/gthf-delivery/staging-access.json'))
        headers['Authorization'] = 'Basic ' + base64.b64encode(('recette:' + credentials['gatewayPassword']).encode()).decode()
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.build_opener(NoReleaseRedirect()).open(request, timeout=timeout) as response:
        if 'no-store' not in response.headers.get('Cache-Control', ''):
            raise RuntimeError('Release proof can be cached')
        return json.load(response)


def serving_deployment_pods(pods):
    return [pod for pod in pods if not pod['metadata'].get('deletionTimestamp')
            and pod.get('status', {}).get('phase') not in ('Succeeded', 'Failed')
            and any(owner.get('kind') == 'ReplicaSet' for owner in pod['metadata'].get('ownerReferences', []))]


def verify_public_revision(environment, name, value, evidence):
    """Allow draining old processes/connections to converge, never advance on a stale proof."""
    deadline = time.monotonic() + 90
    path = '/api/health' if name == 'frontend' else '/api/release'
    while time.monotonic() < deadline:
        pods = json.loads(kubectl(environment, 'get', 'pods', '-l', 'app.kubernetes.io/component=' + name, '-o', 'json', timeout=min(5, deadline - time.monotonic())))['items']
        old = [pod for pod in pods if pod.get('status', {}).get('phase') not in ('Succeeded', 'Failed')
               and any(owner.get('kind') == 'ReplicaSet' for owner in pod['metadata'].get('ownerReferences', []))
               and any(container['image'] != value['image'] for container in pod['spec']['containers'] + pod['spec'].get('initContainers', []))]
        observation = {'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                       'oldPods': [{'uid': pod['metadata'].get('uid'), 'terminating': bool(pod['metadata'].get('deletionTimestamp'))} for pod in old]}
        evidence.append(observation)
        # An unexpected live workload is not a normal rolling-update drain.
        if any(not pod['metadata'].get('deletionTimestamp') for pod in old):
            raise RuntimeError('An unexpected old workload remains active after rollout')
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            proof = http_json(HOSTS[environment][name] + path + '?release=' + value['revision'], timeout=min(5, remaining))
            revision = proof.get('revision')
            observation['revision'] = revision if isinstance(revision, str) and re.fullmatch(r'[a-f0-9]{40}', revision) else 'invalid'
            observation['expectedRevision'] = proof.get('status') == 'ok' and revision == value['revision']
            if observation['expectedRevision'] and not old:
                # Routing admission can remain green on a warm cache during a CMS
                # outage. A delivery still requires an uncached dependency proof.
                if name == 'frontend':
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    readiness = http_json(HOSTS[environment][name] + '/api/ready', timeout=min(5, remaining))
                    observation['dependenciesReady'] = readiness.get('status') == 'ready'
                    if not observation['dependenciesReady']:
                        raise RuntimeError('Frontend dependencies are not ready for delivery')
                return
        except (OSError, ValueError) as error:
            # Keep only the exception type, never URLs/credentials or response bodies.
            observation['transportError'] = type(error).__name__
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(1, remaining))
    raise RuntimeError('Public endpoint did not converge to the expected release within 90 seconds')


def runtime_image_proof(image_id, manifest_digest, config_digest, revision, cache=None):
    """Resolve CRI's alternate RepoDigest by the exact executable OCI graph."""
    cache = {} if cache is None else cache
    maximum = 16 * 1024 * 1024
    indexes = {'application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'}
    manifests = {'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'}
    configs = {'application/vnd.oci.image.config.v1+json', 'application/vnd.docker.container.image.v1+json'}

    def require(condition, message):
        if not condition:
            raise RuntimeError('Runtime image digest is not the expected digest: ' + message)

    def digest(value):
        require(isinstance(value, str) and re.fullmatch(r'sha256:[a-f0-9]{64}', value), 'SHA256 required')

    digest(manifest_digest)
    digest(config_digest)
    matched = re.search(r'(?:^|@|://)(sha256:[a-f0-9]{64})$', image_id) if isinstance(image_id, str) else None
    require(matched is not None, 'Malformed runtime image ID')
    observed = matched[1]
    if observed in (manifest_digest, config_digest):
        return {'kind': 'pinned-digest', 'observedDigest': observed}

    def descriptor(value):
        require(isinstance(value, dict), 'OCI descriptor required')
        digest(value.get('digest'))
        require(type(value.get('size')) is int and 0 < value['size'] <= maximum, 'Bounded OCI metadata descriptor required')

    def metadata(value, size=None):
        digest(value)
        if value not in cache:
            data = command(['sudo', '-n', '/snap/bin/microk8s', 'ctr', 'content', 'get', value], timeout=5)
            require(isinstance(data, bytes) and 0 < len(data) <= maximum, 'Bounded OCI metadata bytes required')
            require('sha256:' + hashlib.sha256(data).hexdigest() == value, 'OCI metadata SHA256 mismatch')
            try:
                document = json.loads(data)
            except (ValueError, UnicodeError):
                raise RuntimeError('Runtime image digest is not the expected digest: Invalid OCI JSON') from None
            require(isinstance(document, dict), 'OCI metadata object required')
            cache[value] = (data, document)
        data, document = cache[value]
        if size is not None:
            require(len(data) == size, 'OCI descriptor size mismatch')
        return document

    index = metadata(observed)
    require(index.get('schemaVersion') == 2 and index.get('mediaType') in indexes
            and isinstance(index.get('manifests'), list), 'Unknown image ID must be an OCI index')
    candidates = [item for item in index['manifests'] if isinstance(item, dict)
                  and isinstance(item.get('platform'), dict) and item['platform'].get('os') == 'linux'
                  and item['platform'].get('architecture') == 'amd64']
    require(len(candidates) == 1, 'Exactly one Linux amd64 runtime required')
    runtime = candidates[0]
    descriptor(runtime)
    require(runtime.get('mediaType') in manifests and runtime['digest'] == manifest_digest,
            'Alias must point to the exact runtime manifest')
    manifest = metadata(runtime['digest'], runtime['size'])
    require(manifest.get('schemaVersion') == 2 and manifest.get('mediaType') == runtime['mediaType']
            and isinstance(manifest.get('layers'), list), 'Executable OCI manifest required')
    descriptor(manifest.get('config'))
    require(manifest['config'].get('mediaType') in configs and manifest['config']['digest'] == config_digest,
            'Alias must point to the exact runtime configuration')
    config = metadata(config_digest, manifest['config']['size'])
    require(config.get('os') == 'linux' and config.get('architecture') == 'amd64', 'Runtime platform differs')
    require_image_revision(config, revision)
    rootfs = config.get('rootfs', {})
    require(isinstance(rootfs, dict) and rootfs.get('type') == 'layers' and isinstance(rootfs.get('diff_ids'), list)
            and len(rootfs['diff_ids']) == len(manifest['layers']), 'Runtime layer identity differs')
    for value in rootfs['diff_ids']:
        digest(value)
    for layer in manifest['layers']:
        require(isinstance(layer, dict), 'Layer descriptor required')
        digest(layer.get('digest'))
        require(type(layer.get('size')) is int and layer['size'] >= 0, 'Layer size required')
    return {'kind': 'verified-runtime-index-alias', 'observedDigest': observed,
            'runtimeManifestDigest': manifest_digest, 'runtimeConfigDigest': config_digest,
            'platform': 'linux/amd64', 'revision': revision,
            'layerDigests': [layer['digest'] for layer in manifest['layers']]}


def verify_components(environment, components, evidence=None):
    if evidence is None:
        evidence = []
    for name, value in components.items():
        verification = {'component': name, 'revision': value['revision'], 'observations': []}
        evidence.append(verification)
        kubectl(environment, 'rollout', 'status', 'deployment/' + deployment_name(name), '--timeout=300s')
        pods = json.loads(kubectl(environment, 'get', 'pods', '-l', 'app.kubernetes.io/component=' + name, '-o', 'json'))
        running = serving_deployment_pods(pods['items'])
        if not running:
            raise RuntimeError('No serving pod')
        manifest_digest = value['image'].split('@')[1]
        manifest = json.loads(command(['sudo', '-n', '/snap/bin/microk8s', 'ctr', 'content', 'get', manifest_digest]))
        config_digest = manifest.get('config', {}).get('digest')
        if not config_digest:
            raise RuntimeError('The release must reference a single-platform manifest')
        config = json.loads(command(['sudo', '-n', '/snap/bin/microk8s', 'ctr', 'content', 'get', config_digest]))
        require_image_revision(config, value['revision'])
        runtime_metadata = {}
        for pod in running:
            containers = pod['spec']['containers'] + pod['spec'].get('initContainers', [])
            if any(container['image'] != value['image'] for container in containers):
                raise RuntimeError('Runtime and init-container images do not match the release')
            statuses = pod['status'].get('containerStatuses', [])
            if not statuses or any(not state.get('ready') for state in statuses):
                raise RuntimeError('Running image digest is not the expected digest or the container is not ready')
            proof = {'podUid': pod['metadata'].get('uid'), 'containers': [], 'initContainers': []}
            verification.setdefault('runtimeImages', []).append(proof)
            for state in statuses:
                identity = {'name': state.get('name'), 'imageID': state.get('imageID')}
                proof['containers'].append(identity)
                identity.update(runtime_image_proof(state.get('imageID'), manifest_digest, config_digest, value['revision'], runtime_metadata))
            for state in pod['status'].get('initContainerStatuses', []):
                if state.get('state', {}).get('terminated', {}).get('exitCode') != 0:
                    raise RuntimeError('The init-container did not complete with the expected image')
                identity = {'name': state.get('name'), 'imageID': state.get('imageID')}
                proof['initContainers'].append(identity)
                identity.update(runtime_image_proof(state.get('imageID'), manifest_digest, config_digest, value['revision'], runtime_metadata))
        if name == 'gateway':
            continue
        verify_public_revision(environment, name, value, verification['observations'])
    return evidence


def deployment_name(name):
    return 'gthf-staging-gateway' if name == 'gateway' else 'gthf-' + name


def changed_workloads(environment, previous, candidate):
    changed = {name: value for name, value in candidate.items() if value['image'] != previous[name]['image']}
    if environment == 'staging' and 'frontend' in changed:
        changed['gateway'] = changed['frontend']
    return changed


def snapshot_components(environment, names):
    return {name: json.loads(kubectl(environment, 'get', 'deployment', deployment_name(name), '-o', 'json')) for name in names}


def cms_rollout_policy(previous, deployment):
    from media_rollback import image_capability
    template = deployment['spec']['template']
    containers = template['spec']['containers'] + template['spec'].get('initContainers', [])
    if (not containers or any(item['image'] != previous['image'] for item in containers)
            or template['metadata'].get('annotations', {}).get('gthf.fr/source-revision') != previous['revision']):
        raise RuntimeError('Current CMS deployment does not match the previous verified release')
    proof = image_capability(previous['image'], previous['revision'], command)
    return {**proof, 'strategy': 'RollingUpdate' if proof['mediaRecoveryVersion'] == '2' and proof['mediaBatchRecoveryVersion'] == '1' else 'Recreate'}


def configure_cms_strategy(spec, strategy):
    if strategy not in ('Recreate', 'RollingUpdate'):
        raise ValueError('Unsupported CMS rollout strategy')
    # JSON merge patches must explicitly remove the old rollingUpdate object.
    spec['strategy'] = {'type': strategy, 'rollingUpdate': None if strategy == 'Recreate' else {'maxSurge': 1, 'maxUnavailable': 0}}


@contextlib.contextmanager
def observe_cms_transition(monitor, strategy, environment):
    if strategy == 'Recreate':
        # The previous frontend cannot survive this deliberate CMS outage.
        # Admit the cache-capable frontend before stopping the legacy CMS.
        admission = http_json(HOSTS[environment]['frontend'] + '/api/serving')
        if admission.get('status') != 'serving':
            raise RuntimeError('Initial media recovery requires an admitted recovery-capable frontend')
        if monitor is not None:
            monitor.warm_frontend()
    expected = monitor is not None and strategy == 'Recreate'
    if expected:
        monitor.begin_cms_transition(maximum_seconds=390)
    try:
        yield
    finally:
        if expected:
            monitor.end_cms_transition()


def patch_component(environment, name, value, cms_strategy='RollingUpdate'):
    deployment = json.loads(kubectl(environment, 'get', 'deployment', deployment_name(name), '-o', 'json'))
    spec = deployment['spec']
    if name == 'cms':
        configure_cms_strategy(spec, cms_strategy)
    else:
        spec['strategy'] = {'type': 'RollingUpdate', 'rollingUpdate': {'maxSurge': 1, 'maxUnavailable': 0}}
    pod = spec['template']['spec']
    for container in pod['containers'] + pod.get('initContainers', []):
        container['image'] = value['image']
        container['imagePullPolicy'] = 'IfNotPresent'
    pod['imagePullSecrets'] = [{'name': 'gthf-ghcr'}]
    container = pod['containers'][0]
    container['lifecycle'] = {'preStop': {'exec': {'command': ['node', '-e', 'setTimeout(()=>{},10000)']}}}
    container['readinessProbe']['httpGet']['path'] = {'frontend': '/api/serving', 'cms': '/api/release', 'gateway': '/_gateway/health'}[name]
    container['readinessProbe']['timeoutSeconds'] = 5
    annotations = spec['template']['metadata'].setdefault('annotations', {})
    annotations['gthf.fr/source-revision'] = value['revision']
    kubectl(environment, 'patch', 'deployment', deployment_name(name), '--type=merge', '-p', json.dumps({'spec': spec}))


def backup_database(root):
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    path = root / 'backups' / (stamp + '.dump')
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    payload = kubectl('production', 'exec', 'gthf-postgres-0', '--', 'pg_dump', '-U', 'gthdf', '-d', 'gthdf', '-Fc')
    if not payload.startswith(b'PGDMP'):
        raise RuntimeError('PostgreSQL backup is not a custom archive')
    with open(path, 'wb', opener=lambda p, flags: os.open(p, flags, 0o600)) as stream:
        stream.write(payload)
    if len(payload) > 100 * 1024 * 1024:
        raise RuntimeError('Backup saved; a larger verification workspace must be provisioned before promotion')
    remote_path = '/tmp/gthf-backup-' + stamp + '.dump'
    try:
        # Partial archive reads can leave kubectl stdin blocked; validate a complete file.
        kubectl('production', 'cp', str(path), 'gthf-postgres-0:' + remote_path)
        listing = kubectl('production', 'exec', 'gthf-postgres-0', '--', 'pg_restore', '--list', remote_path)
        if b'TABLE DATA' not in listing:
            raise RuntimeError('PostgreSQL backup does not contain table data')
    finally:
        kubectl('production', 'exec', 'gthf-postgres-0', '--', 'rm', '-f', remote_path)
    return str(path)


def reconcile_infrastructure(environment, components, cms_strategy='RollingUpdate', monitor=None, evidence=None):
    import yaml
    overlay = pathlib.Path(__file__).parent.parent / 'kubernetes' / 'overlays' / ('production' if environment == 'production' else 'qualification')
    rendered = command(['sudo', '-n', '/snap/bin/microk8s', 'kubectl', 'kustomize', str(overlay)])
    resources = [value for value in yaml.safe_load_all(rendered) if value]
    config = next(value['data'] for value in resources if value['kind'] == 'ConfigMap' and value['metadata']['name'] == 'gthf-config')
    previous = []
    allowed = {'ConfigMap', 'Deployment', 'Service', 'NetworkPolicy', 'ResourceQuota', 'LimitRange', 'ServiceAccount', 'Ingress', 'Certificate', 'Issuer', 'Middleware'}
    for resource in resources:
        if resource['kind'] in ('Namespace', 'PersistentVolumeClaim', 'StatefulSet'):
            continue
        if resource['kind'] not in allowed or resource['metadata'].get('namespace') != NAMESPACES[environment]:
            raise RuntimeError('Infrastructure crosses the application boundary')
        if resource['kind'] == 'Deployment':
            name = resource['metadata']['name']
            component = {'gthf-cms': 'cms', 'gthf-frontend': 'frontend', 'gthf-staging-gateway': 'frontend'}.get(name)
            if not component:
                raise RuntimeError('Unexpected application deployment')
            if name == 'gthf-cms':
                configure_cms_strategy(resource['spec'], cms_strategy)
            pod = resource['spec']['template']['spec']
            for container in pod['containers'] + pod.get('initContainers', []):
                container['image'] = components[component]['image']
                container['imagePullPolicy'] = 'IfNotPresent'
            pod['imagePullSecrets'] = [{'name': 'gthf-ghcr'}]
            relevant = {key: value for key, value in config.items() if (
                (component == 'frontend' and key in ('NODE_ENV', 'STRAPI_URL', 'PUBLIC_STRAPI_URL', 'SITE_URL', 'STRAPI_MEDIA_ORIGINS', 'ITINERARY_BASEMAP_ENABLED'))
                or (component == 'cms' and key not in ('STRAPI_URL', 'PUBLIC_STRAPI_URL', 'SITE_URL', 'STRAPI_MEDIA_ORIGINS', 'ITINERARY_BASEMAP_ENABLED'))
            )}
            annotations = resource['spec']['template']['metadata'].setdefault('annotations', {})
            annotations['gthf.fr/config-revision'] = hashlib.sha256(json.dumps(relevant, sort_keys=True).encode()).hexdigest()
            annotations['gthf.fr/source-revision'] = components[component]['revision']
            pod['containers'][0]['lifecycle'] = {'preStop': {'exec': {'command': ['node', '-e', 'setTimeout(()=>{},10000)']}}}
            if name != 'gthf-staging-gateway':
                pod['containers'][0]['readinessProbe']['httpGet']['path'] = '/api/serving' if component == 'frontend' else '/api/release'
                pod['containers'][0]['readinessProbe']['timeoutSeconds'] = 5
        old = kubectl(environment, 'get', resource['kind'], resource['metadata']['name'], '--ignore-not-found', '-o', 'json')
        previous.append((resource['kind'], resource['metadata']['name'], json.loads(old) if old else None))
    try:
        for resource in resources:
            if resource['kind'] in allowed and resource['kind'] != 'Deployment':
                kubectl(environment, 'apply', '-f', '-', data=json.dumps(resource).encode())
        names = ('gthf-frontend', 'gthf-cms', 'gthf-staging-gateway') if cms_strategy == 'Recreate' else ('gthf-cms', 'gthf-frontend', 'gthf-staging-gateway')
        for name in names:
            resource = next((value for value in resources if value['kind'] == 'Deployment' and value['metadata']['name'] == name), None)
            if resource:
                with observe_cms_transition(monitor if name == 'gthf-cms' else None, cms_strategy if name == 'gthf-cms' else 'RollingUpdate', environment):
                    kubectl(environment, 'apply', '-f', '-', data=json.dumps(resource).encode())
                    kubectl(environment, 'rollout', 'status', 'deployment/' + name, '--timeout=300s')
                    if name != 'gthf-staging-gateway':
                        component = 'cms' if name == 'gthf-cms' else 'frontend'
                        verify_components(environment, {component: components[component]}, evidence=evidence)
    except Exception:
        restore_infrastructure(environment, previous)
        raise
    return previous


def restore_infrastructure(environment, resources, evidence=None):
    for kind, name, previous in resources:
        if kind == 'Deployment' and name == 'gthf-cms':
            require_cms_rollback(environment, previous, evidence=evidence)
    for kind, name, previous in reversed(resources):
        if previous is None:
            kubectl(environment, 'delete', kind, name, '--ignore-not-found')
        else:
            previous.pop('status', None)
            for key in ('resourceVersion', 'uid', 'creationTimestamp', 'managedFields', 'generation'):
                previous['metadata'].pop(key, None)
            kubectl(environment, 'apply', '-f', '-', data=json.dumps(previous).encode())


def require_cms_rollback(environment, deployment, evidence=None):
    from media_rollback import require_media_rollback
    proof = evidence if evidence is not None else {}
    try:
        require_media_rollback(environment, deployment, kubectl, command, proof)
    except Exception as error:
        error.media_rollback = proof
        raise
    return proof


def activate(root, environment, candidate, recipe):
    with environment_lock(root, environment, candidate['owner']):
        require_current(candidate)
        previous = load_json(root / (environment + '.json'))
        if not previous or set(previous.get('components', {})) != {'frontend', 'cms'}:
            raise RuntimeError('A reviewed bootstrap release is required before automatic delivery')
        reference = load_json(root / 'production.json') if environment == 'staging' else previous
        if candidate.get('publication'):
            plan = {key: any(value['fingerprints'][group] != reference['components'][name]['fingerprints'][group]
                             for name, value in candidate['components'].items())
                    for key, group in (('build', 'runtime'), ('infrastructure', 'infrastructure'), ('postgres', 'postgres'))}
            if plan['postgres']:
                raise RuntimeError('PostgreSQL changes require a separate reviewed delivery')
            candidate = {**candidate, 'plan': plan}
        require_candidate_images(candidate['components'], reference['components'], verify_source=lambda name, value: source_equivalent(root, name, value))
        combined = {**reference['components'], **candidate['components']}
        if combined['cms']['image'] != previous['components']['cms']['image']:
            require_compatible_schema(previous['components']['cms']['schemas'], combined['cms']['schemas'])
        if environment == 'staging':
            ingresses = json.loads(kubectl('staging', 'get', 'ingress', '--all-namespaces', '-o', 'json'))
            alternate = json.loads(kubectl('staging', 'get', 'ingressroutes.traefik.io,ingressroutetcps.traefik.io,ingressrouteudps.traefik.io,httproutes.gateway.networking.k8s.io,grpcroutes.gateway.networking.k8s.io', '--all-namespaces', '-o', 'json'))
            require_isolated_staging_routes(ingresses['items'], alternate['items'])
        changed = changed_workloads(environment, previous['components'], combined)
        snapshots = snapshot_components(environment, changed)
        cms_policy = cms_rollout_policy(previous['components']['cms'], snapshots['cms']) if 'cms' in changed else None
        cms_strategy = cms_policy['strategy'] if cms_policy else 'RollingUpdate'
        infrastructure_snapshot = []
        report = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'environment': environment, 'components': combined, 'deployerRevision': candidate['deployerRevision']}
        if cms_policy:
            report['cmsTransition'] = cms_policy
        monitor = None
        if environment == 'production' and 'cms' in changed:
            report['backup'] = backup_database(root)
        try:
            if environment == 'production' and candidate.get('publication'):
                from observation import OriginMonitor, prometheus_proof
                report['monitoringBefore'] = prometheus_proof()
                secret = json.loads(kubectl('production', 'get', 'secret', 'gthf-secrets', '-o', 'json'))
                monitor = OriginMonitor(base64.b64decode(secret['data']['STRAPI_API_TOKEN']).decode())
                monitor.thread.start()
                time.sleep(10)
                monitor.require_available()
            if candidate.get('plan', {}).get('infrastructure'):
                infrastructure_snapshot = reconcile_infrastructure(environment, combined, cms_strategy=cms_strategy, monitor=monitor,
                                                                   evidence=report.setdefault('componentVerification', []))
            names = ('frontend', 'cms', 'gateway') if cms_strategy == 'Recreate' else ('cms', 'frontend', 'gateway')
            for name in names:
                if name in changed:
                    with observe_cms_transition(monitor if name == 'cms' and not infrastructure_snapshot else None, cms_strategy if name == 'cms' and not infrastructure_snapshot else 'RollingUpdate', environment):
                        if not infrastructure_snapshot:
                            if name == 'cms':
                                patch_component(environment, name, changed[name], cms_strategy=cms_strategy)
                            else:
                                patch_component(environment, name, changed[name])
                        verify_components(environment, {name: changed[name]}, evidence=report.setdefault('componentVerification', []))
            verify_components(environment, combined, evidence=report.setdefault('componentVerification', []))
            if environment == 'staging':
                verify_components(environment, {'gateway': combined['frontend']})
            command(['node', str(recipe), environment], timeout=600)
            if monitor:
                monitor.wait_for_continuous_health(seconds=60)
                report['monitoringAfter'] = prometheus_proof()
                monitor.require_available()
                monitor.stop.set()
                monitor.thread.join(timeout=5)
                if monitor.thread.is_alive() or monitor.expired or monitor.errors or monitor.samples < 3:
                    raise RuntimeError('Origin observation did not finish healthy')
                report['originObservation'] = monitor.proof()
            report.update(status='success', finishedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
            save_json(root / (environment + '.json'), report)
        except Exception as error:
            report['status'] = 'failed'
            if hasattr(error, 'media_rollback'):
                report['mediaRollback'] = error.media_rollback
            if 'cms' in snapshots:
                report['mediaRollback'] = {}
                require_cms_rollback(environment, snapshots['cms'], evidence=report['mediaRollback'])
            if infrastructure_snapshot:
                restore_infrastructure(environment, infrastructure_snapshot, evidence=report.setdefault('mediaRollback', {}))
            # The schema compatibility check permits keeping additive columns during rollback.
            for name in reversed(('cms', 'frontend', 'gateway')):
                if name in snapshots:
                    kubectl(environment, 'patch', 'deployment', deployment_name(name), '--type=merge', '-p', json.dumps({'spec': snapshots[name]['spec']}))
            verify_components(environment, previous['components'])
            if environment == 'staging':
                verify_components(environment, {'gateway': previous['components']['frontend']})
            report['rollback'] = 'verified'
            raise
        finally:
            if monitor:
                monitor.stop.set()
                monitor.thread.join(timeout=5)
                report['originObservation'] = monitor.proof()
                save_json(root / 'history' / (str(time.time_ns()) + '-origin-samples.json'), monitor.records)
            save_json(root / 'history' / (str(time.time_ns()) + '-' + environment + '.json'), report)


def interrupt_delivery(_signal, _frame):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    raise RuntimeError('Delivery interrupted; finish the active rollback before stopping')


def main():
    signal.signal(signal.SIGTERM, interrupt_delivery)
    signal.signal(signal.SIGINT, interrupt_delivery)
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=['deliver', 'check', 'status', 'reserve', 'release'])
    parser.add_argument('--state-dir', default='/home/ubuntu/gthf-delivery')
    parser.add_argument('--candidate')
    parser.add_argument('--owner', default='operator')
    parser.add_argument('--minutes', type=int, default=60)
    args = parser.parse_args()
    root = pathlib.Path(args.state_dir)
    require_host()
    if args.operation == 'status':
        print(json.dumps({name: load_json(root / (name + '.json')) for name in NAMESPACES}))
        return
    if args.operation in ('reserve', 'release'):
        if not 1 <= args.minutes <= 240:
            raise ValueError('Reservations must last 1 to 240 minutes')
        with environment_lock(root, 'staging', args.owner):
            save_json(root / 'staging-reservation.json', {'owner': args.owner, 'expires': time.time() + args.minutes * 60 if args.operation == 'reserve' else 0})
        return
    candidate = load_json(pathlib.Path(args.candidate))
    if not candidate or not candidate.get('components') or not re.fullmatch(r'[a-f0-9]{40}', candidate.get('deployerRevision', '')):
        raise ValueError('A complete candidate release is required')
    for name, value in candidate['components'].items():
        validate_component(name, value)
    if args.operation == 'check':
        require_private_directory(root)
        require_current(candidate)
        verify_registry_components(root, candidate['components'])
        return
    recipe = pathlib.Path(__file__).with_name('recipe.mjs')
    with environment_lock(root, 'delivery', candidate['owner']):
        with environment_lock(root, 'staging', candidate['owner']):
            old_reservation = load_json(root / 'staging-reservation.json', {})
            save_json(root / 'staging-reservation.json', {'owner': candidate['owner'], 'expires': time.time() + 3600})
        try:
            promote(lambda environment: activate(root, environment, candidate, recipe),
                    verify=lambda: verify_registry_components(root, candidate['components']))
        finally:
            with environment_lock(root, 'staging', candidate['owner']):
                save_json(root / 'staging-reservation.json', old_reservation)


if __name__ == '__main__':
    main()
