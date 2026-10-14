import contextlib
import importlib.util
import json
import copy
import types
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release', pathlib.Path(__file__).with_name('release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

REVISION = 'a' * 40
OLD_REVISION = 'b' * 40
MANIFEST = 'sha256:' + 'c' * 64
CONFIG = 'sha256:' + 'd' * 64
VALUE = {'revision': REVISION, 'image': 'ghcr.io/thedamfr/gthf-frontend@' + MANIFEST}


def pod(image=VALUE['image'], terminating=False):
    return {'metadata': {'uid': 'fixture', 'ownerReferences': [{'kind': 'ReplicaSet'}],
                         **({'deletionTimestamp': 'now'} if terminating else {})},
            'spec': {'containers': [{'image': image}]},
            'status': {'phase': 'Running', 'containerStatuses': [{'ready': True, 'imageID': 'containerd://' + CONFIG}]}}


class PublicConvergenceTests(unittest.TestCase):
    def fixture(self, pods, http):
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        clock = [0]
        stack.enter_context(patch.object(release.time, 'monotonic', lambda: clock[0]))
        stack.enter_context(patch.object(release.time, 'sleep', lambda delay: clock.__setitem__(0, clock[0] + delay)))
        stack.enter_context(patch.object(release, 'kubectl', lambda *args, **kwargs: json.dumps({'items': pods(clock[0])})))
        stack.enter_context(patch.object(release, 'http_json', lambda url, **kwargs: http(url, clock[0])))
        return clock

    def test_waits_for_terminating_process_and_old_public_connection_then_checks_dependencies(self):
        ready = []
        def http(url, clock):
            if '/api/ready' in url:
                ready.append(clock)
                return {'status': 'ready'}
            return {'status': 'ok', 'revision': OLD_REVISION if clock < 2 else REVISION}
        self.fixture(lambda clock: [pod(), pod('old-image', True)] if clock < 1 else [pod()], http)
        evidence = []
        release.verify_public_revision('staging', 'frontend', VALUE, evidence)
        self.assertEqual(ready, [2])
        self.assertEqual([value['revision'] for value in evidence], [OLD_REVISION, OLD_REVISION, REVISION])
        self.assertTrue(evidence[0]['oldPods'][0]['terminating'])
        self.assertTrue(evidence[-1]['dependenciesReady'])

    def test_even_expected_public_revision_waits_for_old_process_exit(self):
        clock = self.fixture(lambda now: [pod(), pod('old', True)] if now < 3 else [pod()],
                             lambda url, now: {'status': 'ready'} if '/api/ready' in url else {'status': 'ok', 'revision': REVISION})
        release.verify_public_revision('production', 'frontend', VALUE, [])
        self.assertEqual(clock[0], 3)

    def test_a_persistent_wrong_revision_fails_at_90_seconds(self):
        clock = self.fixture(lambda _: [pod()], lambda *_: {'status': 'ok', 'revision': OLD_REVISION})
        evidence = []
        with self.assertRaisesRegex(RuntimeError, 'within 90 seconds'):
            release.verify_public_revision('production', 'frontend', VALUE, evidence)
        self.assertEqual(clock[0], 90)
        self.assertEqual(len(evidence), 90)

    def test_routing_admission_never_replaces_strict_dependency_proof(self):
        self.fixture(lambda _: [pod()], lambda url, _: {'status': 'unavailable'} if '/api/ready' in url else {'status': 'ok', 'revision': REVISION})
        with self.assertRaisesRegex(RuntimeError, 'dependencies are not ready'):
            release.verify_public_revision('production', 'frontend', VALUE, [])

    def test_unexpected_nondeleting_old_workload_fails_immediately(self):
        clock = self.fixture(lambda _: [pod(), pod('old')], lambda *_: self.fail('HTTP should not run'))
        with self.assertRaisesRegex(RuntimeError, 'unexpected old workload'):
            release.verify_public_revision('staging', 'frontend', VALUE, [])
        self.assertEqual(clock[0], 0)

    def test_wrong_runtime_digest_blocks_before_any_public_retry(self):
        running = pod()
        running['status']['containerStatuses'][0]['imageID'] = 'wrong-digest'
        with patch.object(release, 'kubectl', return_value=json.dumps({'items': [running]})), \
                patch.object(release, 'command', side_effect=[json.dumps({'config': {'digest': CONFIG}}), json.dumps({'config': {'Labels': {'org.opencontainers.image.revision': REVISION}}})]), \
                patch.object(release, 'verify_public_revision') as public:
            with self.assertRaisesRegex(RuntimeError, 'expected digest'):
                release.verify_components('staging', {'frontend': VALUE})
            public.assert_not_called()


class InfrastructureConvergenceEvidenceTests(unittest.TestCase):
    def activate_fixture(self, persistent_old_revision):
        previous = {'components': {'frontend': {**VALUE, 'revision': OLD_REVISION, 'image': 'previous'}, 'cms': {'image': 'cms'}}}
        candidate = {'owner': 'test', 'deployerRevision': REVISION, 'plan': {'infrastructure': True},
                     'components': {'frontend': {**VALUE, 'processedRevision': REVISION}}}
        resources = [
            {'kind': 'ConfigMap', 'metadata': {'name': 'gthf-config', 'namespace': 'gthf-staging'}, 'data': {}},
            {'kind': 'Deployment', 'metadata': {'name': 'gthf-frontend', 'namespace': 'gthf-staging'},
             'spec': {'template': {'metadata': {}, 'spec': {'containers': [{'name': 'frontend', 'image': 'previous',
                       'readinessProbe': {'httpGet': {'path': '/api/ready'}}}]}}}},
        ]
        clock = [0]
        saved = []
        restored = []
        actual_verify = release.verify_components

        def verify(environment, components, evidence=None):
            if components.get('frontend', {}).get('image') == VALUE['image']:
                return actual_verify(environment, {'frontend': components['frontend']}, evidence=evidence)
            return evidence if evidence is not None else []

        def kube(environment, *arguments, **kwargs):
            if arguments[:2] == ('get', 'pods'):
                running = pod()
                running['status']['containerStatuses'][0]['imageID'] = 'fixture@' + CONFIG
                return json.dumps({'items': [running]})
            return b''

        def command(arguments, **kwargs):
            if arguments[3:5] == ['kubectl', 'kustomize']:
                return b'rendered test resources'
            if arguments[3:6] == ['ctr', 'content', 'get']:
                return json.dumps({'config': {'digest': CONFIG}} if arguments[-1] == MANIFEST
                                  else {'config': {'Labels': {'org.opencontainers.image.revision': REVISION}}})
            if arguments[0] == 'node':
                return b'recipe passed'
            raise AssertionError('Unexpected command in synthetic transport')

        def http(url, **kwargs):
            if '/api/ready' in url:
                return {'status': 'ready'}
            return {'status': 'ok', 'revision': OLD_REVISION if persistent_old_revision or clock[0] < 2 else REVISION}

        with contextlib.ExitStack() as mocks:
            # Only infrastructure I/O and time are synthetic; activate,
            # reconcile and both delivery verification functions are real.
            mocks.enter_context(patch.dict('sys.modules', {'yaml': types.SimpleNamespace(safe_load_all=lambda _: copy.deepcopy(resources))}))
            for name, replacement in {
                'environment_lock': lambda *args: contextlib.nullcontext(),
                'require_current': lambda *args: None,
                'load_json': lambda path: copy.deepcopy(previous),
                'snapshot_components': lambda *args: {'frontend': {'spec': {'proof': 'previous'}}},
                'command': command, 'kubectl': kube, 'http_json': http, 'verify_components': verify,
                'restore_infrastructure': lambda *args, **kwargs: restored.append(args),
                'save_json': lambda path, value: saved.append((path, copy.deepcopy(value))),
            }.items():
                mocks.enter_context(patch.object(release, name, replacement))
            mocks.enter_context(patch.object(release.time, 'monotonic', lambda: clock[0]))
            mocks.enter_context(patch.object(release.time, 'sleep', lambda delay: clock.__setitem__(0, clock[0] + delay)))
            if persistent_old_revision:
                with self.assertRaisesRegex(RuntimeError, 'within 90 seconds'):
                    release.activate(pathlib.Path('/unused'), 'production', candidate, pathlib.Path('/unused/recipe'))
            else:
                release.activate(pathlib.Path('/unused'), 'production', candidate, pathlib.Path('/unused/recipe'))
        return saved, restored, clock[0]

    def test_infrastructure_success_preserves_intermediate_old_revisions_in_saved_report(self):
        saved, restored, elapsed = self.activate_fixture(False)
        reports = [value for path, value in saved if path.name == 'production.json']
        self.assertEqual(len(reports), 1)
        observations = reports[0]['componentVerification'][0]['observations']
        self.assertEqual([value['revision'] for value in observations], [OLD_REVISION, OLD_REVISION, REVISION])
        self.assertTrue(observations[-1]['dependenciesReady'])
        self.assertEqual(elapsed, 2)
        self.assertEqual(restored, [])

    def test_infrastructure_failure_retains_all_90_seconds_before_rollback_and_never_advances(self):
        saved, restored, elapsed = self.activate_fixture(True)
        self.assertFalse(any(path.name == 'production.json' for path, value in saved))
        report = saved[-1][1]
        self.assertEqual(report['status'], 'failed')
        self.assertEqual(report['rollback'], 'verified')
        self.assertEqual(len(restored), 1)
        observations = report['componentVerification'][0]['observations']
        self.assertEqual(len(observations), 90)
        self.assertTrue(all(value['revision'] == OLD_REVISION for value in observations))
        self.assertEqual(elapsed, 90)


if __name__ == '__main__':
    unittest.main()
