"""Bounded origin observation and fresh platform evidence for production delivery."""
import concurrent.futures
import datetime
import http.client
import json
import pathlib
import socket
import ssl
import threading
import time
import urllib.parse
import urllib.request


def require_monitoring(success, ages, alerts):
    expected = {'gthf-frontend', 'gthf-cms'}
    if any(len(values) != 2 or {item['metric']['application'] for item in values} != expected for values in (success, ages)):
        raise RuntimeError('Missing production Prometheus probes')
    if any(float(item['value'][1]) != 1 for item in success) or any(not 0 <= float(item['value'][1]) <= 60 for item in ages):
        raise RuntimeError('Unhealthy or stale production Prometheus probes')
    if any(item['metric'].get('severity') in ('warning', 'critical') and (item['metric'].get('namespace') in ('gthf-staging', 'gthf-qualification') or item['metric'].get('application') in expected or item['metric'].get('node') == 'game-prod-ovh-gra') for item in alerts):
        raise RuntimeError('An active GTHF or host alert requires review')


def prometheus_proof():
    address = json.loads(pathlib.Path('/home/ubuntu/.local/state/infra-sincere/telegram-chat/config.json').read_text())['prometheus_cluster_ip']
    def query(expression):
        with urllib.request.urlopen('http://' + address + ':9090/api/v1/query?' + urllib.parse.urlencode({'query': expression}), timeout=15) as response:
            return json.load(response)['data']['result']
    selector = 'probe_success{job="production-http",environment="production",application=~"gthf-frontend|gthf-cms"}'
    success = query(selector)
    ages = query('time() - timestamp(' + selector + ')')
    alerts = query('ALERTS{alertstate="firing"}')
    require_monitoring(success, ages, alerts)
    return {'success': success, 'ageSeconds': ages, 'relevantAlerts': []}


class OriginConnection(http.client.HTTPSConnection):
    def connect(self):
        self.sock = ssl.create_default_context().wrap_socket(socket.create_connection(('127.0.0.1', 443), timeout=2), server_hostname=self.host)


class OriginMonitor:
    def __init__(self, token):
        self.token = token
        self.stop = threading.Event()
        self.samples = 0
        self.errors = []
        self.records = []
        self.started = time.monotonic()
        self.deadline = self.started + 600
        self.expired = False
        self.lock = threading.Lock()
        self.cms_transition = None
        self.expected_errors = []
        self.interruptions = []
        self.active_interruptions = {}
        self.healthy_since = None
        self.last_cycle_at = None
        self.continuous_health_seconds = 0

        self.thread = threading.Thread(target=self.run, daemon=True)

    def request(self, host, path, kind):
        connection = OriginConnection(host, timeout=2)
        started = time.monotonic()
        status = None
        error_type = None
        with self.lock:
            transition = self.cms_transition if self.cms_transition and self.cms_transition['closedAt'] is None else None
        failure = None
        try:
            headers = {'User-Agent': 'gthf-delivery', 'Cache-Control': 'no-cache'}
            if kind == 'content':
                headers['Authorization'] = 'Bearer ' + self.token
            connection.request('GET', path, headers=headers)
            response = connection.getresponse()
            status = response.status
            body = response.read(2 * 1024 * 1024)
            if response.status != (204 if path == '/_health' else 200):
                raise RuntimeError('HTTP ' + str(response.status))
            if kind == 'content' and not json.loads(body).get('data'):
                raise RuntimeError('Missing CMS content')
            if kind == 'page' and b'<h1' not in body:
                raise RuntimeError('Missing rendered page')
            return None
        except Exception as error:
            error_type = type(error).__name__
            failure = {'host': host, 'path': path, 'error': type(error).__name__}
            return failure
        finally:
            connection.close()
            finished = time.monotonic()
            expected = bool(failure and host == 'cms.gthf.fr' and transition
                            and finished <= transition['deadline'])
            if failure is not None:
                failure['expected'] = expected
            self.record_result(host, path, status, started, finished, error_type, expected)

    def run(self):
        targets = [('gthf.fr', '/chapitres/soissons-a-beauvais', 'page'), ('cms.gthf.fr', '/_health', 'health'), ('cms.gthf.fr', '/api/chapters?pagination[pageSize]=1', 'content')]
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            while not self.stop.is_set():
                if time.monotonic() >= self.deadline:
                    self.expired = True
                    return
                results = list(pool.map(lambda target: self.request(*target), targets))
                self.record_cycle(results)
                self.stop.wait(1)

    def record_cycle(self, results):
        with self.lock:
            self.samples += len(results)
            self.errors.extend(result for result in results if result and not result['expected'])
            self.expected_errors.extend(result for result in results if result and result['expected'])
            self.last_cycle_at = time.monotonic()
            if any(results):
                self.healthy_since = None
            elif self.healthy_since is None:
                self.healthy_since = self.last_cycle_at

    def record_result(self, host, path, status, started, finished, error_type, expected):
        at = datetime.datetime.now(datetime.timezone.utc).isoformat()
        key = (host, path)
        with self.lock:
            self.records.append({'at': at, 'host': host, 'path': path, 'status': status,
                                 'durationMs': round((finished - started) * 1000, 1),
                                 'valid': error_type is None, 'expectedInterruption': expected})
            if error_type is not None:
                if key not in self.active_interruptions:
                    entry = {'host': host, 'path': path, 'firstFailureAt': at, 'lastFailureAt': at,
                             'recoveredAt': None, 'durationMs': None, 'expected': expected, '_started': started}
                    self.interruptions.append(entry)
                    self.active_interruptions[key] = entry
                entry = self.active_interruptions[key]
                entry['lastFailureAt'] = at
                entry['expected'] = entry['expected'] and expected
            elif key in self.active_interruptions:
                entry = self.active_interruptions.pop(key)
                entry['recoveredAt'] = at
                entry['durationMs'] = round((finished - entry['_started']) * 1000, 1)

    def warm_frontend(self):
        result = self.request('gthf.fr', '/chapitres/soissons-a-beauvais', 'page')
        self.record_cycle([result])
        self.require_available()

    def begin_cms_transition(self, maximum_seconds):
        self.require_available()
        if not 1 <= maximum_seconds <= 390:
            raise ValueError('CMS transition must be bounded to at most 390 seconds')
        with self.lock:
            if self.cms_transition is not None:
                raise RuntimeError('Only one initial CMS transition is allowed per observation')
            now = time.monotonic()
            self.cms_transition = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                                   'closedAt': None, 'maximumSeconds': maximum_seconds,
                                   'durationSeconds': None, '_started': now,
                                   'deadline': min(self.deadline, now + maximum_seconds)}

    def end_cms_transition(self):
        with self.lock:
            if self.cms_transition is None or self.cms_transition['closedAt'] is not None:
                raise RuntimeError('No initial CMS transition is active')
            self.cms_transition['closedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            self.cms_transition['durationSeconds'] = round(time.monotonic() - self.cms_transition['_started'], 3)
            # Never count the transition itself towards the final healthy interval.
            self.healthy_since = None
            if time.monotonic() > self.cms_transition['deadline']:
                raise RuntimeError('Initial CMS transition exceeded its observation window')

    def require_available(self):
        with self.lock:
            if time.monotonic() >= self.deadline:
                self.expired = True
            if self.expired or not self.thread.is_alive():
                raise RuntimeError('Origin observation is incomplete')
            if self.cms_transition and self.cms_transition['closedAt'] is None and time.monotonic() > self.cms_transition['deadline']:
                raise RuntimeError('Initial CMS transition exceeded its observation window')
            if self.errors:
                raise RuntimeError('Origin monitoring reported an availability failure')

    def wait_for_continuous_health(self, seconds=60):
        started = time.monotonic()
        while True:
            self.require_available()
            with self.lock:
                now = time.monotonic()
                if self.cms_transition and self.cms_transition['closedAt'] is None:
                    raise RuntimeError('CMS transition must close before final health observation')
                if (self.healthy_since is not None and self.last_cycle_at is not None
                        and now - self.last_cycle_at <= 5
                        and now - max(started, self.healthy_since) >= seconds):
                    self.continuous_health_seconds = seconds
                    return
            time.sleep(1)

    def proof(self):
        with self.lock:
            return {'samples': self.samples, 'errors': list(self.errors), 'expired': self.expired,
                    'expectedErrors': list(self.expected_errors),
                    'continuousHealthSeconds': self.continuous_health_seconds,
                    'cmsTransition': {key: value for key, value in self.cms_transition.items()
                                      if not key.startswith('_') and key != 'deadline'} if self.cms_transition else None,
                    'interruptions': [{key: value for key, value in entry.items() if not key.startswith('_')}
                                      for entry in self.interruptions]}
