import importlib.util
import contextlib
import pathlib
import os
import stat
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('foundation', pathlib.Path(__file__).with_name('prepare-staging.py'))
foundation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(foundation)
spec = importlib.util.spec_from_file_location('release', pathlib.Path(__file__).with_name('release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class FoundationTests(unittest.TestCase):
    def test_foundation_holds_the_shared_staging_lock_and_releases_it_on_failure(self):
        events = []
        with patch('builtins.open', return_value=contextlib.nullcontext(object())), patch.object(foundation.fcntl, 'flock', side_effect=lambda handle, operation: events.append(operation)):
            with self.assertRaisesRegex(RuntimeError, 'fixture failure'):
                with foundation.staging_lock(pathlib.Path('/private-fixture')):
                    events.append('preparation')
                    raise RuntimeError('fixture failure')
        self.assertEqual(events, [foundation.fcntl.LOCK_EX | foundation.fcntl.LOCK_NB, 'preparation', foundation.fcntl.LOCK_UN])

    def test_failed_resource_inspection_is_not_treated_as_absence(self):
        with patch.object(foundation.subprocess, 'run', return_value=SimpleNamespace(returncode=1, stdout=b'')):
            with self.assertRaises(RuntimeError):
                foundation.read_optional('gthf-qualification', 'secret', 'gthf-secrets')

    def test_staging_configuration_does_not_inherit_production_endpoints(self):
        config = foundation.staging_configuration({'NODE_ENV': 'production', 'PRODUCTION_ONLY_ENDPOINT': 'https://production.example', 'DATABASE_URL': 'postgres://production', 'DATABASE_HOST': 'production-db'})
        self.assertNotIn('PRODUCTION_ONLY_ENDPOINT', config)
        self.assertNotIn('DATABASE_URL', config)
        self.assertEqual(config['DATABASE_HOST'], 'gthf-postgres')
        self.assertEqual(config['AWS_BUCKET'], 'gthf-staging-media-bis')

    def test_existing_target_volume_cannot_reference_production(self):
        foundation.require_distinct_volumes('production-volume', None)
        foundation.require_distinct_volumes('production-volume', 'staging-volume')
        for production, staging in [('production-volume', 'production-volume'), (None, 'staging-volume')]:
            with self.assertRaises(RuntimeError):
                foundation.require_distinct_volumes(production, staging)

    def test_existing_state_directory_must_be_private_owned_and_not_a_symlink(self):
        def directory(mode, owner=os.geteuid()):
            return SimpleNamespace(lstat=lambda: SimpleNamespace(st_mode=mode, st_uid=owner))
        for operation in [foundation.require_private_directory, release.require_private_directory]:
            operation(directory(stat.S_IFDIR | 0o700))
            for unsafe in [directory(stat.S_IFDIR | 0o755), directory(stat.S_IFDIR | 0o700, os.geteuid() + 1), directory(stat.S_IFLNK | 0o700), directory(stat.S_IFREG | 0o700)]:
                with self.assertRaises(RuntimeError):
                    operation(unsafe)

    def test_reused_application_credentials_are_rejected_before_preparing_data(self):
        keys = ['POSTGRES_PASSWORD', 'APP_KEYS', 'API_TOKEN_SALT', 'ADMIN_JWT_SECRET', 'TRANSFER_TOKEN_SALT', 'ENCRYPTION_KEY', 'JWT_SECRET', 'PREVIEW_SECRET', 'STRAPI_API_TOKEN']
        staging = {key: 'stage-fixture-' + key for key in keys}
        production = {key: 'prod-fixture-' + key for key in keys}
        foundation.require_secret_isolation(staging, production)
        for key in keys:
            for value in (None, production[key]):
                with self.subTest(key=key, missing=value is None):
                    with self.assertRaisesRegex(RuntimeError, '^Staging secret isolation failed: ' + key + '$'):
                        foundation.require_secret_isolation({**staging, key: value}, production)
