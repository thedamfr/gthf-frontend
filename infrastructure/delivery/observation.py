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

        self.thread = threading.Thread(target=self.run, daemon=True)

    def request(self, host, path, kind):
        connection = OriginConnection(host, timeout=2)
        started = time.monotonic()
        status = None
        error_type = None
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
            return {'host': host, 'path': path, 'error': type(error).__name__}
        finally:
            connection.close()
            self.records.append({'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'host': host, 'path': path, 'status': status, 'durationMs': round((time.monotonic()-started)*1000, 1), 'valid': error_type is None})

    def run(self):
        targets = [('gthf.fr', '/chapitres/soissons-a-beauvais', 'page'), ('cms.gthf.fr', '/_health', 'health'), ('cms.gthf.fr', '/api/chapters?pagination[pageSize]=1', 'content')]
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            while not self.stop.is_set():
                if time.monotonic() >= self.deadline:
                    self.expired = True
                    return
                results = list(pool.map(lambda target: self.request(*target), targets))
                self.samples += len(results)
                self.errors.extend(result for result in results if result)
                self.stop.wait(1)

    def require_available(self):
        if self.expired or not self.thread.is_alive():
            raise RuntimeError('Origin observation is incomplete')
        if self.errors:
            raise RuntimeError('Origin monitoring reported an availability failure')
