"""Exact OCI graph proofs for CRI RepoDigest aliases; all transports are synthetic."""
import copy
import hashlib
import importlib.util
import json
import pathlib
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release_alias', pathlib.Path(__file__).with_name('release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
REVISION = 'a' * 40
INDEX = 'application/vnd.oci.image.index.v1+json'
MANIFEST = 'application/vnd.oci.image.manifest.v1+json'
CONFIG = 'application/vnd.oci.image.config.v1+json'


class Graph:
    def __init__(self, config_change=None, manifest_change=None, index_change=None):
        self.blobs = {}
        config = {'os': 'linux', 'architecture': 'amd64', 'config': {'Labels': {'org.opencontainers.image.revision': REVISION}},
                  'rootfs': {'type': 'layers', 'diff_ids': ['sha256:' + '1' * 64]}}
        if config_change: config_change(config)
        self.config = self.put(config, CONFIG)
        manifest = {'schemaVersion': 2, 'mediaType': MANIFEST, 'config': self.config,
                    'layers': [{'mediaType': 'application/vnd.oci.image.layer.v1.tar+gzip', 'digest': 'sha256:' + '2' * 64, 'size': 123}]}
        if manifest_change: manifest_change(manifest)
        self.runtime = self.put(manifest, MANIFEST)
        index = {'schemaVersion': 2, 'mediaType': INDEX,
                 'manifests': [{**self.runtime, 'platform': {'os': 'linux', 'architecture': 'amd64'}}]}
        if index_change: index_change(index)
        self.index = self.put(index, INDEX)
        self.image_id = 'docker.io/library/gthf-frontend@' + self.index['digest']

    def put(self, value, media_type):
        data = json.dumps(value, separators=(',', ':')).encode()
        digest = 'sha256:' + hashlib.sha256(data).hexdigest()
        self.blobs[digest] = data
        return {'mediaType': media_type, 'digest': digest, 'size': len(data)}

    def read(self, arguments, *, timeout):
        assert arguments[:6] == ['sudo', '-n', '/snap/bin/microk8s', 'ctr', 'content', 'get']
        assert timeout == 5
        return self.blobs[arguments[6]]

    def prove(self):
        with patch.object(release, 'command', side_effect=self.read):
            return release.runtime_image_proof(self.image_id, self.runtime['digest'], self.config['digest'], REVISION)


class RuntimeAliasTests(unittest.TestCase):
    def test_exact_index_graph_is_proved_and_cached_for_runtime_and_initializer(self):
        graph = Graph()
        with patch.object(release, 'command', side_effect=graph.read) as command:
            cache = {}
            proofs = [release.runtime_image_proof(graph.image_id, graph.runtime['digest'], graph.config['digest'], REVISION, cache)
                      for _ in range(2)]
        self.assertEqual(command.call_count, 3)
        self.assertEqual(proofs[0], proofs[1])
        self.assertEqual(proofs[0]['kind'], 'verified-runtime-index-alias')
        self.assertEqual(proofs[0]['runtimeManifestDigest'], graph.runtime['digest'])
        self.assertEqual(proofs[0]['runtimeConfigDigest'], graph.config['digest'])
        self.assertEqual(proofs[0]['observedDigest'], graph.index['digest'])
        json.dumps(proofs)

    def test_direct_runtime_and_config_ids_remain_valid_without_alias_resolution(self):
        graph = Graph()
        with patch.object(release, 'command') as command:
            for prefix in ['', 'containerd://', 'fixture@']:
                for digest in [graph.runtime['digest'], graph.config['digest']]:
                    proof = release.runtime_image_proof(prefix + digest, graph.runtime['digest'], graph.config['digest'], REVISION)
                    self.assertEqual(proof['kind'], 'pinned-digest')
            command.assert_not_called()

    def test_every_alias_graph_blob_is_hashed(self):
        for key in ['index', 'runtime', 'config']:
            with self.subTest(key=key):
                graph = Graph(); digest = getattr(graph, key)['digest']; graph.blobs[digest] += b'\n'
                with self.assertRaisesRegex(RuntimeError, 'SHA256 mismatch'):
                    graph.prove()

    def test_metadata_descriptor_sizes_are_checked_including_boolean_or_unbounded_sizes(self):
        changes = [lambda x: x['manifests'][0].update(size=x['manifests'][0]['size'] + 1),
                   lambda x: x['manifests'][0].update(size=True),
                   lambda x: x['manifests'][0].update(size=16 * 1024 * 1024 + 1)]
        for change in changes:
            with self.subTest(change=change), self.assertRaisesRegex(RuntimeError, 'descriptor'):
                Graph(index_change=change).prove()
        with self.assertRaisesRegex(RuntimeError, 'size mismatch'):
            Graph(manifest_change=lambda x: x['config'].update(size=x['config']['size'] + 1)).prove()

    def test_unknown_or_ambiguous_indexes_and_wrong_platforms_are_refused(self):
        for change in [lambda x: x.update(mediaType=MANIFEST),
                       lambda x: x['manifests'].append(copy.deepcopy(x['manifests'][0])),
                       lambda x: x['manifests'][0]['platform'].update(architecture='arm64')]:
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                Graph(index_change=change).prove()
        with self.assertRaisesRegex(RuntimeError, 'platform'):
            Graph(config_change=lambda x: x.update(architecture='arm64')).prove()

    def test_an_alternate_manifest_with_the_same_config_is_not_enough(self):
        graph = Graph()
        different = graph.put({'schemaVersion': 2, 'mediaType': MANIFEST, 'config': graph.config, 'layers': []}, MANIFEST)
        alternate = graph.put({'schemaVersion': 2, 'mediaType': INDEX, 'manifests': [
            {**different, 'platform': {'os': 'linux', 'architecture': 'amd64'}}]}, INDEX)
        graph.image_id = 'fixture@' + alternate['digest']
        with self.assertRaisesRegex(RuntimeError, 'exact runtime manifest'): graph.prove()
        graph.image_id = 'fixture@' + different['digest']
        with self.assertRaisesRegex(RuntimeError, 'must be an OCI index'): graph.prove()

    def test_config_link_revision_and_layer_identity_are_required(self):
        graph = Graph()
        with patch.object(release, 'command', side_effect=graph.read), self.assertRaisesRegex(RuntimeError, 'exact runtime configuration'):
            release.runtime_image_proof(graph.image_id, graph.runtime['digest'], 'sha256:' + '9' * 64, REVISION)
        with self.assertRaisesRegex(ValueError, 'revision'):
            Graph(config_change=lambda x: x['config']['Labels'].update({'org.opencontainers.image.revision': 'b' * 40})).prove()
        with self.assertRaisesRegex(RuntimeError, 'layer identity'):
            Graph(config_change=lambda x: x['rootfs'].update(diff_ids=[])).prove()

    def test_malformed_ids_oversized_blobs_and_metadata_timeout_fail_closed(self):
        graph = Graph()
        for value in ['', None, 'wrong-digest', 'prefix-sha256:' + '1' * 64]:
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, 'Malformed'):
                release.runtime_image_proof(value, graph.runtime['digest'], graph.config['digest'], REVISION)
        with patch.object(release, 'command', return_value=b'x' * (16 * 1024 * 1024 + 1)), self.assertRaisesRegex(RuntimeError, 'Bounded'):
            graph_id = graph.image_id
            release.runtime_image_proof(graph_id, graph.runtime['digest'], graph.config['digest'], REVISION)
        with patch.object(release, 'command', side_effect=subprocess.TimeoutExpired('metadata', 5)), self.assertRaises(subprocess.TimeoutExpired):
            release.runtime_image_proof(graph.image_id, graph.runtime['digest'], graph.config['digest'], REVISION)

    def integration(self, mutate=None):
        graph = Graph(); image = 'docker.io/library/gthf-frontend@' + graph.runtime['digest']
        pod = {'metadata': {'uid': 'pod-fixture', 'ownerReferences': [{'kind': 'ReplicaSet'}]},
               'spec': {'containers': [{'name': 'frontend', 'image': image}], 'initContainers': [{'name': 'seed', 'image': image}]},
               'status': {'phase': 'Running', 'containerStatuses': [{'name': 'frontend', 'ready': True, 'imageID': graph.image_id}],
                          'initContainerStatuses': [{'name': 'seed', 'imageID': graph.image_id, 'state': {'terminated': {'exitCode': 0}}}]}}
        if mutate: mutate(graph, pod)
        def command(args, **kwargs):
            if kwargs: self.assertEqual(kwargs, {'timeout': 5})
            return graph.blobs[args[-1]]
        return graph, image, pod, command

    def test_real_delivery_verifier_records_both_alias_proofs_before_public_verification(self):
        graph, image, pod, command = self.integration(); evidence = []
        with patch.object(release, 'kubectl', return_value=json.dumps({'items': [pod]})), \
                patch.object(release, 'command', side_effect=command), patch.object(release, 'verify_public_revision') as public:
            release.verify_components('staging', {'frontend': {'image': image, 'revision': REVISION}}, evidence)
        public.assert_called_once()
        proof = evidence[0]['runtimeImages'][0]
        self.assertEqual(proof['podUid'], 'pod-fixture')
        for field in ['containers', 'initContainers']:
            self.assertEqual(proof[field][0]['kind'], 'verified-runtime-index-alias')
            self.assertEqual(proof[field][0]['observedDigest'], graph.index['digest'])
        json.dumps(evidence)

    def test_rejected_runtime_or_initializer_identity_remains_in_failure_evidence(self):
        for field, state_field in [('containers', 'containerStatuses'), ('initContainers', 'initContainerStatuses')]:
            graph, image, pod, command = self.integration()
            pod['status'][state_field][0]['imageID'] = 'wrong-digest'
            evidence = []
            with self.subTest(field=field), patch.object(release, 'kubectl', return_value=json.dumps({'items': [pod]})), \
                    patch.object(release, 'command', side_effect=command), patch.object(release, 'verify_public_revision') as public:
                with self.assertRaises(RuntimeError):
                    release.verify_components('staging', {'frontend': {'image': image, 'revision': REVISION}}, evidence)
                public.assert_not_called()
            proof = evidence[0]['runtimeImages'][0][field][0]
            self.assertEqual(proof, {'name': 'frontend' if field == 'containers' else 'seed', 'imageID': 'wrong-digest'})
            json.dumps(evidence)

    def test_wrong_spec_digest_readiness_or_initializer_failure_never_reaches_http(self):
        changes = [lambda g, p: p['spec']['containers'][0].update(image='other@' + g.runtime['digest']),
                   lambda g, p: p['spec']['initContainers'][0].update(image='other@' + g.runtime['digest']),
                   lambda g, p: p['status']['containerStatuses'][0].update(imageID='wrong-digest'),
                   lambda g, p: p['status']['containerStatuses'][0].update(ready=False),
                   lambda g, p: p['status']['initContainerStatuses'][0]['state']['terminated'].update(exitCode=1),
                   lambda g, p: g.blobs.update({g.index['digest']: b'{}'})]
        for change in changes:
            graph, image, pod, command = self.integration(change)
            with self.subTest(change=change), patch.object(release, 'kubectl', return_value=json.dumps({'items': [pod]})), \
                    patch.object(release, 'command', side_effect=command), patch.object(release, 'verify_public_revision') as public:
                with self.assertRaises(RuntimeError):
                    release.verify_components('staging', {'frontend': {'image': image, 'revision': REVISION}})
                public.assert_not_called()


if __name__ == '__main__':
    unittest.main()
