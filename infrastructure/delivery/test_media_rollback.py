import contextlib
import importlib.util
import json
import pathlib
import unittest
from unittest.mock import Mock, patch

import media_rollback

spec = importlib.util.spec_from_file_location('release', pathlib.Path(__file__).with_name('release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

REVISION = 'a' * 40
MANIFEST = 'sha256:' + 'b' * 64
CONFIG = 'sha256:' + 'c' * 64
COUNTS = {name: 0 for name in media_rollback.COUNT_FIELDS}
DEPLOYMENT = {'spec': {'template': {'metadata': {'annotations': {'gthf.fr/source-revision': REVISION}},
    'spec': {'containers': [{'image': 'ghcr.io/thedamfr/gthf-cms@' + MANIFEST}]}}}}


class MediaRollbackTests(unittest.TestCase):
    def database(self, tables=None, counts=None):
        return Mock(side_effect=[json.dumps({'operations': True, 'cleanup': True} if tables is None else tables),
                                 json.dumps(COUNTS if counts is None else counts)])

    def image(self, label='1', revision=REVISION):
        return Mock(side_effect=[json.dumps({'config': {'digest': CONFIG}}),
            json.dumps({'config': {'Labels': {'io.gthf.media-recovery': label, 'org.opencontainers.image.revision': revision}}})])

    def test_absent_tables_allow_legacy_without_touching_oci_or_database_data(self):
        database = self.database({'operations': False, 'cleanup': False})
        image = Mock(side_effect=AssertionError('No image capability required before journal exists'))
        proof = {}
        media_rollback.require_media_rollback('production', DEPLOYMENT, database, image, proof)
        self.assertEqual(proof['status'], 'allowed')
        self.assertEqual(proof['reason'], 'journal-tables-absent')
        self.assertEqual(database.call_count, 1)
        self.assertIn('BEGIN TRANSACTION READ ONLY', database.call_args.kwargs['data'].decode())
        self.assertIn('ON_ERROR_STOP=1', database.call_args.args)

    def test_pending_operations_and_cleanups_require_exact_compatible_image_and_revision(self):
        counts = {**COUNTS, 'preparing': 2, 'prepared': 3, 'interrupted': 5, 'cleanupPending': 7}
        proof = {}
        image = self.image()
        media_rollback.require_media_rollback('staging', DEPLOYMENT, self.database(counts=counts), image, proof)
        self.assertEqual(proof['counts'], counts)
        self.assertEqual(proof['target']['mediaRecoveryVersion'], '1')
        self.assertEqual(image.call_args_list[0].args[0][-1], MANIFEST)
        self.assertEqual(image.call_args_list[1].args[0][-1], CONFIG)

    def test_even_an_empty_existing_journal_blocks_legacy_target(self):
        proof = {}
        with self.assertRaisesRegex(RuntimeError, 'CMS rollback blocked'):
            media_rollback.require_media_rollback('production', DEPLOYMENT, self.database(), self.image(label=None), proof)
        self.assertEqual(proof['status'], 'blocked')
        self.assertEqual(proof['counts']['prepared'], 0)

    def test_missing_database_partial_schema_invalid_counts_and_wrong_revision_fail_closed(self):
        cases = [
            (Mock(side_effect=RuntimeError('database unavailable')), self.image()),
            (self.database({'operations': True, 'cleanup': False}), self.image()),
            (self.database(counts={**COUNTS, 'prepared': True}), self.image()),
            (self.database(counts={**COUNTS, 'cleanupPending': -1}), self.image()),
            (self.database(counts={**COUNTS, 'unknownOperations': 1}), self.image()),
            (self.database(), self.image(revision='d' * 40)),
        ]
        for database, image in cases:
            with self.subTest(database=database), self.assertRaisesRegex(RuntimeError, 'CMS rollback blocked'):
                media_rollback.require_media_rollback('production', DEPLOYMENT, database, image, {})

    def test_first_cms_activation_attests_previous_image_before_selecting_recreate(self):
        previous = {'image': DEPLOYMENT['spec']['template']['spec']['containers'][0]['image'], 'revision': REVISION}
        for label, strategy in [(None, 'Recreate'), ('1', 'RollingUpdate')]:
            with self.subTest(label=label), patch.object(release, 'command', self.image(label=label)):
                self.assertEqual(release.cms_rollout_policy(previous, DEPLOYMENT)['strategy'], strategy)
        with patch.object(release, 'command', side_effect=RuntimeError('cached manifest missing')):
            with self.assertRaisesRegex(RuntimeError, 'cached manifest missing'):
                release.cms_rollout_policy(previous, DEPLOYMENT)
        with patch.object(release, 'command') as command:
            with self.assertRaisesRegex(RuntimeError, 'previous verified release'):
                release.cms_rollout_policy({**previous, 'image': 'another-image'}, DEPLOYMENT)
            command.assert_not_called()

    def test_cms_image_patch_clears_rolling_update_before_new_worker_can_start(self):
        import copy
        deployment = copy.deepcopy(DEPLOYMENT)
        deployment['spec']['strategy'] = {'type': 'RollingUpdate', 'rollingUpdate': {'maxSurge': 1}}
        deployment['spec']['template']['spec']['containers'][0]['readinessProbe'] = {'httpGet': {'path': '/_health'}}
        with patch.object(release, 'kubectl', side_effect=[json.dumps(deployment), b'']) as kube:
            release.patch_component('staging', 'cms', {'image': 'new-image', 'revision': REVISION}, cms_strategy='Recreate')
        patch_payload = json.loads(kube.call_args.args[-1])
        self.assertEqual(patch_payload['spec']['strategy'], {'type': 'Recreate', 'rollingUpdate': None})
        self.assertEqual(patch_payload['spec']['template']['spec']['containers'][0]['image'], 'new-image')

    def test_infrastructure_render_sets_initial_strategy_before_applying_cms(self):
        import copy
        import yaml
        deployment = copy.deepcopy(DEPLOYMENT)
        deployment.update(kind='Deployment', metadata={'name': 'gthf-cms', 'namespace': 'gthf-qualification'})
        deployment['spec']['strategy'] = {'type': 'RollingUpdate', 'rollingUpdate': {'maxSurge': 1}}
        deployment['spec']['template']['spec']['containers'][0]['readinessProbe'] = {'httpGet': {'path': '/_health'}}
        config = {'kind': 'ConfigMap', 'metadata': {'name': 'gthf-config', 'namespace': 'gthf-qualification'}, 'data': {}}
        frontend = copy.deepcopy(deployment)
        frontend['metadata']['name'] = 'gthf-frontend'
        events = []
        monitor = Mock()
        monitor.begin_cms_transition.side_effect = lambda **kwargs: events.append('window-open')
        monitor.end_cms_transition.side_effect = lambda: events.append('window-closed')
        def kubectl(environment, *args, **kwargs):
            if args[0] == 'get':
                return json.dumps(deployment if args[1] == 'Deployment' else config)
            if args[0] == 'apply':
                resource = json.loads(kwargs['data'])
                if resource['kind'] == 'Deployment':
                    if resource['metadata']['name'] == 'gthf-cms':
                        self.assertEqual(resource['spec']['strategy'], {'type': 'Recreate', 'rollingUpdate': None})
                        events.append('apply-new-cms')
                    else:
                        self.assertEqual(resource['spec']['strategy']['type'], 'RollingUpdate')
                        events.append('apply-new-frontend')
            return b''
        with patch.object(release, 'command', return_value=yaml.safe_dump_all([config, deployment, frontend]).encode()), \
                patch.object(release, 'kubectl', side_effect=kubectl), \
                patch.object(release, 'verify_components', side_effect=lambda *_: events.append('verified')), \
                patch.object(release, 'http_json', return_value={'status': 'serving'}):
            release.reconcile_infrastructure('staging', {name: {'image': 'new-image', 'revision': REVISION} for name in ('cms', 'frontend')}, cms_strategy='Recreate', monitor=monitor)
        self.assertEqual(events, ['apply-new-frontend', 'verified', 'window-open', 'apply-new-cms', 'verified', 'window-closed'])

    def test_initial_cms_replacement_requires_recovery_capable_frontend_before_mutation(self):
        entered = []
        with patch.object(release, 'http_json', return_value={'status': 'missing'}):
            with self.assertRaisesRegex(RuntimeError, 'recovery-capable frontend'):
                with release.observe_cms_transition(None, 'Recreate', 'staging'):
                    entered.append(True)
        self.assertEqual(entered, [])
        monitor = Mock()
        events = []
        monitor.warm_frontend.side_effect = lambda: events.append('warm-frontend')
        monitor.begin_cms_transition.side_effect = lambda **kwargs: events.append('open-window')
        monitor.end_cms_transition.side_effect = lambda: events.append('close-window')
        with patch.object(release, 'http_json', return_value={'status': 'serving'}):
            with release.observe_cms_transition(monitor, 'Recreate', 'production'):
                events.append('replace-cms')
        self.assertEqual(events, ['warm-frontend', 'open-window', 'replace-cms', 'close-window'])

    def test_infrastructure_rollback_checks_cms_before_any_resource_mutation(self):
        resources = [('Deployment', 'gthf-cms', DEPLOYMENT), ('Service', 'fixture', None)]
        with patch.object(release, 'require_cms_rollback', side_effect=RuntimeError('blocked')), patch.object(release, 'kubectl') as kube:
            with self.assertRaisesRegex(RuntimeError, 'blocked'):
                release.restore_infrastructure('production', resources)
            kube.assert_not_called()

    def test_activation_refuses_old_cms_and_preserves_blocked_rollback_evidence(self):
        previous = {'components': {'cms': {'image': 'old', 'schemas': {}}, 'frontend': {'image': 'front'}}}
        candidate = {'owner': 'fixture', 'deployerRevision': REVISION,
                     'components': {'cms': {'image': 'new', 'revision': REVISION, 'processedRevision': REVISION, 'schemas': {}}}}
        patches = []
        reports = []
        def guard(_environment, _deployment, evidence):
            evidence.update(status='blocked', reason='existing-journal-requires-compatible-worker')
            raise RuntimeError('CMS rollback blocked')
        with contextlib.ExitStack() as stack:
            for name, replacement in {
                'environment_lock': lambda *_: contextlib.nullcontext(), 'require_current': lambda *_: None,
                'load_json': lambda *_: previous, 'backup_database': lambda *_: 'private-backup',
                'snapshot_components': lambda *_: {'cms': DEPLOYMENT},
                'patch_component': lambda env, name, value, **kwargs: patches.append(value['image']),
                'cms_rollout_policy': lambda *_: {'strategy': 'Recreate'},
                'http_json': lambda *_: {'status': 'serving'},
                'verify_components': Mock(side_effect=RuntimeError('qualification failed')),
                'require_cms_rollback': guard,
                'kubectl': Mock(side_effect=AssertionError('Old image must not be patched')),
                'save_json': lambda path, value: reports.append(value.copy()),
            }.items():
                stack.enter_context(patch.object(release, name, replacement))
            with self.assertRaisesRegex(RuntimeError, 'CMS rollback blocked'):
                release.activate(pathlib.Path('/unused'), 'production', candidate, pathlib.Path('/unused/recipe'))
        self.assertEqual(patches, ['new'])
        self.assertEqual(reports[-1]['status'], 'failed')
        self.assertEqual(reports[-1]['mediaRollback']['status'], 'blocked')
        self.assertNotIn('rollback', reports[-1])


if __name__ == '__main__':
    unittest.main()
