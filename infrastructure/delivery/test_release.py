import contextlib
import importlib.util
import io
from email.message import Message
import pathlib
import unittest
import urllib.request
import urllib.response
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release', pathlib.Path(__file__).with_name('release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class DeliveryTests(unittest.TestCase):
    def test_shutdown_enters_rollback_and_ignores_further_stop_signals(self):
        with patch.object(release.signal, 'signal') as configure:
            with self.assertRaisesRegex(RuntimeError, 'interrupted'):
                release.interrupt_delivery(release.signal.SIGTERM, None)
            self.assertIn(unittest.mock.call(release.signal.SIGTERM, release.signal.SIG_IGN), configure.call_args_list)

    def test_no_environment_is_activated_when_registry_proof_fails(self):
        activated = []
        def verify():
            raise ValueError('Wrong immutable image revision')
        with self.assertRaises(ValueError):
            release.promote(activated.append, verify=verify)
        self.assertEqual(activated, [])

    def test_a_previously_built_image_can_catch_up_after_a_documentation_commit(self):
        previous = {'image': 'old-image', 'revision': 'old-revision', 'fingerprints': {'runtime': 'old-runtime'}}
        candidate = {'image': 'new-image', 'revision': 'built-revision', 'processedRevision': 'docs-revision', 'fingerprints': {'runtime': 'new-runtime'}}
        calls = []

        def verify_source(name, value):
            calls.append((name, value['revision'], value['processedRevision']))
            return True

        release.require_candidate_images({'cms': candidate}, {'cms': previous}, verify_source=verify_source)
        self.assertEqual(calls, [('cms', 'built-revision', 'docs-revision')])
        with self.assertRaises(ValueError):
            release.require_candidate_images({'cms': candidate}, {'cms': previous}, verify_source=lambda *_: False)

    def test_image_revision_must_match_its_immutable_oci_label(self):
        release.require_image_revision({'config': {'Labels': {'org.opencontainers.image.revision': 'expected-revision'}}}, 'expected-revision')
        for config in [{}, {'config': {'Labels': {}}}, {'config': {'Labels': {'org.opencontainers.image.revision': 'other-revision'}}}]:
            with self.assertRaises(ValueError):
                release.require_image_revision(config, 'expected-revision')

    def test_candidate_cms_image_requires_capability_two_without_rejecting_historical_inspection(self):
        def config(version):
            return {'config': {'Labels': {'org.opencontainers.image.revision': 'expected', 'io.gthf.media-recovery': version, 'io.gthf.media-batch-recovery': '1'}}}
        release.require_image_revision(config('2'), 'expected', 'cms')
        for missing in (None, '0', '2'):
            legacy = config('2'); legacy['config']['Labels']['io.gthf.media-batch-recovery'] = missing
            with self.subTest(batch=missing), self.assertRaises(ValueError):
                release.require_image_revision(legacy, 'expected', 'cms')
        release.require_image_revision(config(None), 'expected')
        for version in (None, '0', '1', '3'):
            with self.subTest(version=version), self.assertRaises(ValueError):
                release.require_image_revision(config(version), 'expected', 'cms')

    def test_candidate_images_bind_the_processed_revision_or_verified_reuse(self):
        previous = {'image': 'previous-image', 'revision': 'previous-revision', 'fingerprints': {'runtime': 'previous-runtime'}}
        current = {'image': 'new-image', 'revision': 'current-revision', 'processedRevision': 'current-revision', 'fingerprints': {'runtime': 'new-runtime'}}
        reused = {**previous, 'processedRevision': 'current-revision'}
        reference = {'cms': previous}
        release.require_candidate_images({'cms': current}, reference)
        release.require_candidate_images({'cms': reused}, reference)
        for invalid in [{**current, 'revision': 'previous-revision'}, {**reused, 'revision': 'current-revision'}, {**reused, 'fingerprints': {'runtime': 'new-runtime'}}, {**reused, 'fingerprints': {}}]:
            with self.assertRaises(ValueError):
                release.require_candidate_images({'cms': invalid}, reference)

    def test_release_proof_does_not_follow_redirects_or_forward_credentials(self):
        visited = []

        class Transport(urllib.request.BaseHandler):
            handler_order = 100

            def https_open(self, request):
                visited.append(request.full_url)
                headers = Message()
                headers['Location'] = 'https://other.example/api/release'
                response = urllib.response.addinfourl(io.BytesIO(b'{}'), headers, request.full_url, 302 if len(visited) == 1 else 200)
                response.msg = 'Found' if len(visited) == 1 else 'OK'
                return response

        opener = urllib.request.build_opener(release.NoReleaseRedirect(), Transport())
        request = urllib.request.Request('https://staging-cms.gthf.fr/api/release', headers={'Authorization': 'Basic test-fixture'})
        with self.assertRaisesRegex(RuntimeError, 'Release proof cannot redirect'):
            with opener.open(request):
                pass
        self.assertEqual(visited, ['https://staging-cms.gthf.fr/api/release'])

    def test_staging_routes_reject_historical_and_unauthenticated_backends(self):
        def ingress(namespace, service, host='staging.gthf.fr'):
            return {'metadata': {'namespace': namespace, 'annotations': {'traefik.ingress.kubernetes.io/router.middlewares': 'gthf-qualification-https-redirect@kubernetescrd'}}, 'spec': {'tls': [{'hosts': [host], 'secretName': 'qualification-tls'}], 'rules': [
                {'host': host, 'http': {'paths': [{'backend': {'service': {'name': service, 'port': {'name': 'http'}}}}]}}
            ]}}
        gateway = ingress('gthf-qualification', 'gthf-staging-gateway')
        cms_gateway = ingress('gthf-qualification', 'gthf-staging-gateway', 'staging-cms.gthf.fr')
        production = ingress('gthf-staging', 'gthf-frontend', 'gthf.fr')
        release.require_isolated_staging_routes([gateway, cms_gateway, production])
        for insecure in [
            {**gateway, 'spec': {**gateway['spec'], 'tls': []}},
            {**gateway, 'spec': {**gateway['spec'], 'tls': [{'hosts': ['other.gthf.fr'], 'secretName': 'qualification-tls'}]}},
            {**gateway, 'metadata': {'namespace': 'gthf-qualification'}},
        ]:
            with self.assertRaises(RuntimeError):
                release.require_isolated_staging_routes([insecure, cms_gateway])
        for conflict in [ingress('gthf-staging', 'gthf-frontend'), ingress('gthf-qualification', 'gthf-cms', 'staging-cms.gthf.fr')]:
            with self.assertRaises(RuntimeError):
                release.require_isolated_staging_routes([gateway, cms_gateway, conflict])
        for incomplete in [[], [gateway], [cms_gateway]]:
            with self.assertRaises(RuntimeError):
                release.require_isolated_staging_routes(incomplete)
        for catch_all in [ingress('foreign', 'public', '*.gthf.fr'), ingress('foreign', 'public', None),
                          {'spec': {'defaultBackend': {'service': {'name': 'public'}}}}]:
            with self.assertRaises(RuntimeError):
                release.require_isolated_staging_routes([gateway, cms_gateway, catch_all])
        dashboard = {'kind': 'IngressRoute', 'spec': {'routes': [{'match': 'Host(`dashboard.localhost`)'}]}}
        release.require_isolated_staging_routes([gateway, cms_gateway], [dashboard])
        for alternate in [
            {'kind': 'IngressRoute', 'spec': {'routes': [{'match': 'Host(`staging.gthf.fr`)'}]}},
            {'kind': 'IngressRoute', 'spec': {'routes': [{'match': 'PathPrefix(`/`)'}]}},
            {'kind': 'HTTPRoute', 'spec': {'hostnames': ['*.gthf.fr']}},
            {'kind': 'HTTPRoute', 'spec': {}},
            {'kind': 'GRPCRoute', 'spec': {'hostnames': ['staging-cms.gthf.fr']}},
            {'kind': 'IngressRouteTCP', 'spec': {'routes': [{'match': 'HostSNI(`*`)'}]}},
        ]:
            with self.assertRaises(RuntimeError):
                release.require_isolated_staging_routes([gateway, cms_gateway], [alternate])

    def test_frontend_only_qualification_checks_a_cms_inherited_from_production(self):
        old_cms = {'image': 'cms-old', 'schemas': {'article': {'attributes': {'title': {'type': 'string'}}}}}
        new_cms = {'image': 'cms-new', 'schemas': {'article': {'attributes': {'title': {'type': 'integer'}}}}}
        staging = {'components': {'cms': old_cms, 'frontend': {'image': 'frontend-old'}}}
        production = {'components': {'cms': new_cms, 'frontend': {'image': 'frontend-old'}}}
        candidate = {'owner': 'test', 'components': {'frontend': {'image': 'frontend-new', 'revision': 'new', 'processedRevision': 'new'}}}
        with contextlib.ExitStack() as mocks:
            mocks.enter_context(patch.object(release, 'environment_lock', lambda *args: contextlib.nullcontext()))
            mocks.enter_context(patch.object(release, 'require_current', lambda *args: None))
            mocks.enter_context(patch.object(release, 'load_json', lambda path: staging if path.name == 'staging.json' else production))
            snapshot = mocks.enter_context(patch.object(release, 'snapshot_components', side_effect=AssertionError('Mutation preparation reached before schema validation')))
            with self.assertRaises(ValueError):
                release.activate(pathlib.Path('/unused'), 'staging', candidate, pathlib.Path('/unused/recipe'))
            snapshot.assert_not_called()

    def test_completed_preparation_jobs_are_not_serving_application_pods(self):
        application = {'metadata': {'ownerReferences': [{'kind': 'ReplicaSet'}]}}
        completed_job = {'metadata': {'ownerReferences': [{'kind': 'Job'}]}, 'status': {'phase': 'Succeeded'}}
        terminating = {'metadata': {'ownerReferences': [{'kind': 'ReplicaSet'}], 'deletionTimestamp': 'now'}}
        self.assertEqual(release.serving_deployment_pods([application, completed_job, terminating]), [application])

    def test_frontend_release_also_updates_staging_access_gateway(self):
        old = {'cms': {'image': 'cms-old'}, 'frontend': {'image': 'frontend-old'}}
        new = {**old, 'frontend': {'image': 'frontend-new'}}
        self.assertEqual(set(release.changed_workloads('staging', old, new)), {'frontend', 'gateway'})
        self.assertEqual(set(release.changed_workloads('production', old, new)), {'frontend'})
        self.assertEqual(release.changed_workloads('staging', old, old), {})

    def test_schema_contract_accepts_optional_additions_but_rejects_removal(self):
        previous = {'article': {'attributes': {'title': {'type': 'string'}}}}
        added = {'article': {'attributes': {'title': {'type': 'string'}, 'summary': {'type': 'text'}}}}
        release.require_compatible_schema(previous, added)
        release.require_compatible_schema(previous, {**previous, 'new-type': {'attributes': {'summary': {'type': 'text'}}}})
        for constraint in ('required', 'unique'):
            with self.assertRaises(ValueError):
                release.require_compatible_schema(previous, {**previous, 'new-type': {'attributes': {'title': {'type': 'string', constraint: True}}}})
        with self.assertRaises(ValueError):
            release.require_compatible_schema(previous, {'article': {'attributes': {}}})
        with self.assertRaises(ValueError):
            release.require_compatible_schema(previous, {'article': {'attributes': {'title': {'type': 'integer'}}}})

    def test_failed_activation_restores_real_deployment_and_does_not_advance_release(self):
        previous = {'components': {'frontend': {'image': 'previous'}, 'cms': {'image': 'cms'}}}
        candidate = {'owner': 'test', 'deployerRevision': 'a' * 40, 'components': {'frontend': {'image': 'candidate', 'revision': 'new', 'processedRevision': 'new'}}}
        calls = []
        saved = []

        def verify(environment, components, evidence=None):
            if 'frontend' in components:
                calls.append(('verify', components['frontend']['image']))
                if components['frontend']['image'] == 'candidate':
                    raise RuntimeError('wrong public revision')

        def kube(environment, *args, **kwargs):
            self.assertEqual(args[:3], ('patch', 'deployment', 'gthf-frontend'))
            self.assertIn('previous-spec', args[-1])
            calls.append(('restore', 'previous'))

        with contextlib.ExitStack() as mocks:
            for name, replacement in {
                'environment_lock': lambda *args: contextlib.nullcontext(),
                'require_current': lambda value: None,
                'load_json': lambda path: previous,
                'snapshot_components': lambda *args: {'frontend': {'spec': {'proof': 'previous-spec'}}},
                'patch_component': lambda env, name, value: calls.append(('apply', value['image'])),
                'verify_components': verify,
                'kubectl': kube,
                'save_json': lambda path, value: saved.append((path, value.copy())),
            }.items():
                mocks.enter_context(patch.object(release, name, replacement))
            with self.assertRaises(RuntimeError):
                release.activate(pathlib.Path('/unused'), 'production', candidate, pathlib.Path('/unused/recipe'))
        self.assertEqual(calls, [('apply', 'candidate'), ('verify', 'candidate'), ('restore', 'previous'), ('verify', 'previous')])
        self.assertEqual(len(saved), 1)
        self.assertEqual(saved[0][0].parent.name, 'history')
        self.assertEqual(saved[0][1]['status'], 'failed')
        self.assertEqual(saved[0][1]['rollback'], 'verified')

    def test_mutable_images_or_foreign_repositories_are_rejected(self):
        for image in ['ghcr.io/thedamfr/gthf-cms:latest', 'ghcr.io/other/cms@sha256:' + 'a' * 64]:
            with self.assertRaises(ValueError):
                release.validate_component('cms', {'image': image, 'revision': 'a' * 40})

    def test_failed_qualification_never_activates_production(self):
        calls = []

        def activate(environment):
            calls.append(environment)
            if environment == 'staging':
                raise RuntimeError('functional recipe failed')

        with self.assertRaises(RuntimeError):
            release.promote(activate)
        self.assertEqual(calls, ['staging'])


if __name__ == '__main__':
    unittest.main()
