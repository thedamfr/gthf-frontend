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
                'patch_component': lambda env, name, value: patches.append(value['image']),
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
