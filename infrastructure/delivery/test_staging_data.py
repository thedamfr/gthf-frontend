import importlib.util
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('staging_data', pathlib.Path(__file__).with_name('staging-data.py'))
staging_data = importlib.util.module_from_spec(spec)
spec.loader.exec_module(staging_data)


class ArchiveTests(unittest.TestCase):
    def test_remote_archive_is_removed_after_copy_or_restore_failure(self):
        for failed_copy in (True, False):
            calls = []
            def kube(*args):
                calls.append(args)
                if failed_copy and args[1] == 'cp':
                    raise RuntimeError('partial copy failure')
            with patch.object(staging_data.release, 'kubectl', kube):
                with self.assertRaises(RuntimeError):
                    with staging_data.staged_archive(pathlib.Path('/private/editorial-test.dump')):
                        raise RuntimeError('restore failure')
            self.assertEqual(calls[-1], ('staging', 'exec', 'gthf-postgres-0', '--', 'rm', '-f', '/tmp/editorial-test.dump'))
