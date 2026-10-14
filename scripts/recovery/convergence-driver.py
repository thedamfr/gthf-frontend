"""Real isolated-VM rollout Journey using the candidate delivery verifier."""
import base64
import datetime
import hashlib
import http.client
import json
import pathlib
import re
import socket
import subprocess
import sys
import time
import threading
import types
import urllib.error

NAMESPACE = 'gthf-recovery'
OWNER = 'qualification.infra-sincere/'
NAMES = {'frontend': 'gthf-frontend', 'stale': 'gthf-convergence-stale', 'gateway': 'gthf-convergence-gateway'}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def socket_identity(value):
    return (value['localAddress'].removeprefix('::ffff:'), value['localPort'],
            value['remoteAddress'].removeprefix('::ffff:'), value['remotePort'])


def old_upstream_proof(service, pod, slices, events):
    # The client observes the Service address; kube-proxy DNAT is invisible to
    # getsockname/getpeername. Bind that tuple to the unique ready old endpoint.
    require(events, 'Gateway did not observe an upstream socket')
    last = events[-1]
    require(last['remoteAddress'].removeprefix('::ffff:') == service['spec']['clusterIP']
            and last['remotePort'] == 3000, 'Gateway socket does not target the frontend Service')
    endpoints = [endpoint for item in slices
                 for endpoint in item.get('endpoints', [])
                 if endpoint.get('conditions', {}).get('ready') is not False
                 and not endpoint.get('conditions', {}).get('terminating')]
    require(endpoints and all(endpoint.get('addresses') == [pod['status']['podIP']]
                             and endpoint.get('targetRef', {}).get('uid') == pod['metadata']['uid']
                             for endpoint in endpoints), 'The Service must target only the ready old Pod')
    require(all(any(owner.get('uid') == service['metadata']['uid'] and owner.get('kind') == 'Service'
                    for owner in item['metadata'].get('ownerReferences', [])) for item in slices),
            'EndpointSlice ownership differs')
    require(sum(socket_identity(value) == socket_identity(last) for value in events) >= 2,
            'Old upstream connection was not reused')
    return last


def failure_observations(result, *, previous_revision=None):
    observations = [observation for component in result['observations'] for observation in component['observations']]
    require(result['httpCalls'] > 0 and observations, 'The public failure needs actual HTTP evidence')
    completed = [value for value in observations if 'revision' in value or 'transportError' in value]
    # A final pod inventory may consume the last fraction of the real deadline.
    # Only that unattempted final sample can lack an HTTP result.
    require(completed and (observations == completed or observations[:-1] == completed),
            'Public observations are incomplete before the deadline')
    if previous_revision is not None:
        require(all(value.get('revision') == previous_revision and value.get('expectedRevision') is False
                    and 'transportError' not in value for value in completed),
                'Old-revision scenario did not continuously serve the old revision')
    else:
        require(all('transportError' in value and 'revision' not in value for value in completed),
                'Missing-endpoint scenario did not continuously fail HTTP')
    return completed


def main(config):
    require(socket.gethostname() == 'infra-qualification-vm', 'Isolated guest hostname required')
    identity = json.loads(pathlib.Path('/var/lib/gthf-recovery/identity.json').read_text())
    require(identity == {'uuid': config['uuid'], 'consumer': 'gthf', 'runId': config['runId']}, 'Guest identity differs')
    source = base64.b64decode(config['releaseSource'], validate=True)
    require(hashlib.sha256(source).hexdigest() == config['releaseSha256'], 'Delivery source hash differs')
    release = types.ModuleType('qualified_delivery')
    exec(compile(source, 'candidate/infrastructure/delivery/release.py', 'exec'), release.__dict__)
    results = []
    started = time.monotonic()

    def command(arguments, *, data=None, timeout=30):
        require(arguments[:3] == ['sudo', '-n', '/snap/bin/microk8s'], 'Only guest MicroK8s is allowed')
        require(arguments[3:6] == ['kubectl', '-n', NAMESPACE] or arguments[3:6] == ['ctr', 'content', 'get'], 'Unexpected delivery transport')
        completed = subprocess.run(arguments, input=data, capture_output=True, timeout=timeout)
        require(completed.returncode == 0, 'Guest command failed; no command output is public')
        return completed.stdout

    def kube(*args, data=None, timeout=30):
        return command(['sudo', '-n', '/snap/bin/microk8s', 'kubectl', '-n', NAMESPACE, *args], data=data, timeout=timeout)

    def get(kind, name):
        return json.loads(kube('get', kind, name, '-o', 'json'))

    def ownership(resource):
        require(resource['metadata']['namespace'] == NAMESPACE, 'Wrong resource namespace')
        for field in ('uuid', 'run-id', 'convergence-token'):
            require(resource['metadata']['labels'].get(OWNER + field) == config[{'uuid': 'uuid', 'run-id': 'runId', 'convergence-token': 'token'}[field]], 'Foreign resource')
        require(resource['metadata']['uid'] == config['resources'][resource['kind'] + '/' + resource['metadata']['name']], 'Resource was replaced')
        return resource

    def guard():
        namespace = get('namespace', NAMESPACE)
        require(namespace['metadata']['uid'] == config['namespaceUid'], 'Namespace was replaced')
        require(namespace['metadata']['labels'][OWNER + 'uuid'] == config['uuid'], 'Foreign namespace')
        require(namespace['metadata']['labels'][OWNER + 'run-id'] == config['runId'], 'Foreign campaign')

    def replace(resource):
        guard()
        ownership(resource)
        # resourceVersion and UID are carried unchanged, so a concurrent change
        # cannot be overwritten by a stale unconditioned patch.
        return json.loads(kube('replace', '-f', '-', '-o', 'json', data=json.dumps(resource).encode()))

    def wait_rollout(name):
        kube('rollout', 'status', 'deployment/' + name, '--timeout=120s', timeout=130)

    def set_images(runtime, initializer=None):
        deployment = ownership(get('deployment', NAMES['frontend']))
        spec = deployment['spec']['template']['spec']
        spec['containers'][0]['image'] = runtime
        spec['initContainers'][0]['image'] = initializer or runtime
        replace(deployment)

    def selector(component):
        service = ownership(get('service', NAMES['frontend']))
        service['spec']['selector']['app.kubernetes.io/component'] = component
        replace(service)

    gateway = ownership(get('service', NAMES['gateway']))
    address = gateway['spec']['clusterIP']
    require(re.fullmatch(r'10\.[0-9.]+', address) is not None, 'Guest ClusterIP required')
    connection = None
    http_calls = 0
    keep_warm = None
    warm_worker = None
    connection_lock = threading.Lock()
    authorization = 'Basic ' + base64.b64encode(('recette:' + config['password']).encode()).decode()

    def request(path, *, timeout=5, close=False):
        with connection_lock:
            return connected_request(path, timeout=timeout, close=close)

    def connected_request(path, *, timeout=5, close=False):
        nonlocal connection
        require(path.startswith('/') and not path.startswith('//'), 'Relative path required')
        if connection is None:
            connection = http.client.HTTPConnection(address, 3001, timeout=timeout)
        connection.timeout = timeout
        if connection.sock:
            connection.sock.settimeout(timeout)
        try:
            connection.request('GET', path, headers={'Host': 'staging.gthf.fr', 'Authorization': authorization,
                'Cache-Control': 'no-cache', 'Connection': 'close' if close else 'keep-alive'})
            response = connection.getresponse()
            status = response.status
            headers = dict((key.lower(), value) for key, value in response.getheaders())
            body = response.read(8 * 1024 * 1024 + 1)
            require(len(body) <= 8 * 1024 * 1024, 'Response exceeds qualification bound')
            if close:
                connection.close()
                connection = None
            return status, headers, body
        except BaseException:
            connection.close()
            connection = None
            raise

    def http_json(url, timeout=5):
        nonlocal http_calls
        if keep_warm is not None:
            keep_warm.set()
            warm_worker.join(timeout=6)
            require(not warm_worker.is_alive(), 'Warm-up request did not terminate')
        require(url.startswith('http://' + address + ':3001/'), 'Qualification HTTP origin required')
        http_calls += 1
        path = url.split(':3001', 1)[1]
        status, headers, body = request(path, timeout=timeout)
        if status != 200:
            raise urllib.error.HTTPError(url, status, 'Qualification upstream rejected request', None, None)
        require('no-store' in headers.get('cache-control', ''), 'Release proof can be cached')
        return json.loads(body)

    release.command = command
    release.NAMESPACES = {'qualification': NAMESPACE}
    release.HOSTS = {'qualification': {'frontend': 'http://' + address + ':3001'}, 'staging': {}}
    release.http_json = http_json
    candidate = {'image': config['candidate']['image'], 'revision': config['candidate']['revision']}

    def verify():
        evidence = []
        release.verify_components('qualification', {'frontend': candidate}, evidence)
        return evidence

    def sockets():
        raw = kube('logs', 'deployment/' + NAMES['gateway']).decode()
        return [value for line in raw.splitlines() if line.startswith('{')
                for value in [json.loads(line)] if value.get('event') == 'upstream-socket-free']

    def expected_failure(label, action, pattern, minimum, maximum, require_no_http=False, validate=None):
        before = http_calls
        begin = time.monotonic()
        evidence = []
        try:
            action(evidence)
        except RuntimeError as error:
            require(re.search(pattern, str(error)) is not None, 'Unexpected qualification failure type')
        else:
            raise RuntimeError(label + ' incorrectly succeeded')
        duration = time.monotonic() - begin
        require(minimum <= duration <= maximum, 'Failure did not respect its real deadline')
        if require_no_http:
            require(http_calls == before, 'Wrong image reached the public retry loop')
        result = {'name': label, 'status': 'passed', 'durationSeconds': duration, 'httpCalls': http_calls - before, 'observations': evidence}
        if validate:
            validate(result)
        results.append(result)
        print(json.dumps(result), flush=True)
        return result

    guard()
    for name in NAMES.values():
        ownership(get('deployment', name))
        wait_rollout(name)
    # Verify the real old runtime with the exact candidate verifier as well.
    # CRI can report an index alias for one image and a direct digest for the
    # next, depending on the ordering of its immutable repository references.
    baseline_evidence = []
    release.verify_components('qualification', {'frontend': config['previous']}, baseline_evidence)
    # A real old application is warmed through the actual staging gateway.
    for _ in range(2):
        require(http_json('http://' + address + ':3001/api/health')['revision'] == config['previous']['revision'], 'Old frontend is not publicly served')
    old_pods = json.loads(kube('get', 'pods', '-l', 'app.kubernetes.io/component=frontend', '-o', 'json'))['items']
    require(len(old_pods) == 1, 'Exactly one old application pod required')
    old_pod = old_pods[0]
    old_service = ownership(get('service', NAMES['frontend']))
    old_slices = json.loads(kube('get', 'endpointslices', '-l', 'kubernetes.io/service-name=' + NAMES['frontend'], '-o', 'json'))['items']
    old_socket = old_upstream_proof(old_service, old_pod, old_slices, sockets())
    keep_warm = threading.Event()
    def retain_connection():
        while not keep_warm.wait(1):
            try:
                request('/api/health')
            except (OSError, http.client.HTTPException):
                break
    warm_worker = threading.Thread(target=retain_connection, daemon=True)
    warm_worker.start()
    before_rollout = time.time()
    set_images(candidate['image'])
    evidence = verify()
    observations = evidence[0]['observations']
    require(any(value.get('revision') == config['previous']['revision'] and any(pod['uid'] == old_pod['metadata']['uid'] and pod['terminating'] for pod in value['oldPods']) for value in observations), 'Actual old revision during preStop was not observed')
    first_terminating = min(datetime.datetime.fromisoformat(value['checkedAt']).timestamp()
                            for value in observations if value.get('revision') == config['previous']['revision']
                            and any(pod['uid'] == old_pod['metadata']['uid'] and pod['terminating'] for pod in value['oldPods']))
    during = [value for value in sockets() if value['at'] >= max(before_rollout, first_terminating)
              and socket_identity(value) == socket_identity(old_socket)]
    require(during, 'The original upstream TCP connection did not survive into rollout')
    require(observations[-1]['expectedRevision'] and observations[-1]['dependenciesReady'] and not observations[-1]['oldPods'], 'Public convergence is incomplete')
    status, _, body = request('/article/recovery-published')
    require(status == 200 and config['articleTitle'].encode() in body, 'Published business content differs after rollout')
    status, _, _ = request('/api/preview?url=/article/recovery-published&status=draft&secret=invalid')
    require(status in (401, 403), 'Preview must remain protected')
    results.append({'name': 'Golden Journey: real frontend rollout drains an old keep-alive connection before accepting the candidate',
        'status': 'passed', 'oldPodUid': old_pod['metadata']['uid'], 'oldServiceUid': old_service['metadata']['uid'],
        'oldEndpointSlices': old_slices, 'oldSocket': old_socket, 'sameSocketDuringRollout': during,
        'baselineDeliveryEvidence': baseline_evidence,
        'deliveryEvidence': evidence, 'publishedArticleVerified': True, 'previewDenied': True})
    print(json.dumps(results[-1]), flush=True)

    request('/api/health', close=True)
    selector('convergence-stale')
    routing_deadline = time.monotonic() + 20
    while True:
        if http_json('http://' + address + ':3001/api/health')['revision'] == config['previous']['revision']:
            break
        require(time.monotonic() < routing_deadline, 'Persistent old public route not established')
        request('/api/health', close=True)
        time.sleep(.25)
    expected_failure('Golden Journey: a persistently old real public frontend fails after 90 seconds',
        lambda proof: release.verify_components('qualification', {'frontend': candidate}, proof), 'within 90 seconds', 89, 105,
        validate=lambda result: failure_observations(result, previous_revision=config['previous']['revision']))
    request('/api/health', close=True)
    selector('convergence-no-endpoints')
    endpoints_deadline = time.monotonic() + 20
    while True:
        slices = json.loads(kube('get', 'endpointslices', '-l', 'kubernetes.io/service-name=' + NAMES['frontend'], '-o', 'json'))['items']
        if not any(endpoint.get('addresses') for item in slices for endpoint in (item.get('endpoints') or [])):
            break
        require(time.monotonic() < endpoints_deadline, 'Gateway endpoints did not disappear')
        time.sleep(.25)
    expected_failure('Golden Journey: a real gateway without upstream endpoints fails after 90 seconds',
        lambda proof: release.verify_components('qualification', {'frontend': candidate}, proof), 'within 90 seconds', 89, 110,
        validate=failure_observations)
    selector('frontend')
    verify()
    for runtime, initializer, label in [
        (config['previous']['image'], config['previous']['image'], 'runtime image'),
        (candidate['image'], config['previous']['image'], 'initializer image'),
    ]:
        set_images(runtime, initializer)
        wait_rollout(NAMES['frontend'])
        expected_failure('Golden Journey: wrong real ' + label + ' is rejected before public retries',
            lambda proof: release.verify_components('qualification', {'frontend': candidate}, proof),
            'images do not match|expected digest', 0, 15, require_no_http=True)
        set_images(candidate['image'])
        wait_rollout(NAMES['frontend'])
    final = verify()
    return {'status': 'passed', 'suite': 'Golden Journeys', 'durationSeconds': time.monotonic() - started,
            'releaseSha256': config['releaseSha256'], 'results': results, 'finalDeliveryEvidence': final}


if __name__ == '__main__':
    try:
        result = main(json.load(sys.stdin))
        print(json.dumps(result))
    except BaseException as error:
        print(json.dumps({'status': 'failed', 'errorType': type(error).__name__, 'message': str(error)}))
        raise
