import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('guard', Path(__file__).with_name('require-qualified-storage.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class QualifiedStorageTests(unittest.TestCase):
    def setUp(self):
        self.proof = {
            'schemaVersion': 1, 'status': 'qualified', 'namespace': 'gthf-staging',
            'namespaceUid': 'qualified-namespace',
            'qualifiedAt': '2026-10-13T22:00:00Z',
            'goldenJourneys': {'staging': 'passed', 'production': 'passed'},
            'runtimeRevisions': {'frontend': 'a' * 40, 'cms': 'b' * 40},
            'storage': {'pvc': 'gthf-postgres', 'pvcUid': 'preserved-claim',
                        'pv': 'gthf-staging-postgres-preserved', 'pvUid': 'preserved-volume',
                        'hostPath': '/data/existing-production-postgres'},
        }
        self.namespace = {'metadata': {'name': 'gthf-staging', 'uid': 'qualified-namespace'},
                          'status': {'phase': 'Active'}}
        self.pvc = {
            'metadata': {'namespace': 'gthf-staging', 'name': 'gthf-postgres', 'uid': 'preserved-claim'},
            'status': {'phase': 'Bound'}, 'spec': {'volumeName': 'gthf-staging-postgres-preserved'},
        }
        self.pv = {
            'metadata': {'name': 'gthf-staging-postgres-preserved', 'uid': 'preserved-volume'},
            'status': {'phase': 'Bound'},
            'spec': {'persistentVolumeReclaimPolicy': 'Retain', 'nodeAffinity': {'required': {}},
                     'hostPath': {'path': '/data/existing-production-postgres'},
                     'claimRef': {'namespace': 'gthf-staging', 'name': 'gthf-postgres', 'uid': 'preserved-claim'}},
        }

    def verify(self, proof=None, pvc=None, pv=None):
        return guard.validate_storage(self.proof if proof is None else proof,
                                      self.namespace,
                                      self.pvc if pvc is None else pvc,
                                      self.pv if pv is None else pv, 'gthf-staging')

    def test_only_the_qualified_bound_storage_is_accepted(self):
        self.verify()

    def test_a_recreated_or_terminating_namespace_is_rejected(self):
        for namespace in [{}, {**self.namespace, 'metadata': {'name': 'gthf-staging', 'uid': 'recreated'}},
                          {**self.namespace, 'status': {'phase': 'Terminating'}}]:
            with self.subTest(namespace=namespace), self.assertRaises(ValueError):
                guard.validate_storage(self.proof, namespace, self.pvc, self.pv, 'gthf-staging')

    def test_absent_or_freshly_provisioned_storage_is_rejected(self):
        for pvc in [{}, {**self.pvc, 'spec': {}},
                    {**self.pvc, 'status': {'phase': 'Pending'}},
                    {**self.pvc, 'spec': {'volumeName': 'pvc-new-empty-database'}},
                    {**self.pvc, 'metadata': {**self.pvc['metadata'], 'uid': 'recreated-claim'}}]:
            with self.subTest(pvc=pvc), self.assertRaises(ValueError):
                self.verify(pvc=pvc)

    def test_volume_rebinding_or_a_different_data_directory_is_rejected(self):
        for field, value in [('persistentVolumeReclaimPolicy', 'Delete'),
                             ('hostPath', {'path': '/data/new-empty-postgres'}),
                             ('claimRef', {**self.pv['spec']['claimRef'], 'uid': 'another-claim'}),
                             ('nodeAffinity', {})]:
            changed = copy.deepcopy(self.pv)
            changed['spec'][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.verify(pv=changed)

    def test_a_prepared_migration_or_missing_journeys_cannot_authorize_deployment(self):
        for proof in [{}, {**self.proof, 'status': 'prepared'},
                      {**self.proof, 'goldenJourneys': {'staging': 'passed', 'production': 'pending'}},
                      {**self.proof, 'runtimeRevisions': {}},
                      {**self.proof, 'storage': {**self.proof['storage'], 'pvUid': 'another-volume'}}]:
            with self.subTest(proof=proof), self.assertRaises(ValueError):
                self.verify(proof=proof)

    def test_playbook_checks_storage_before_its_first_mutation(self):
        playbook = Path(__file__).parents[1] / 'ansible/playbooks/deploy.yml'
        source = playbook.read_text()
        self.assertLess(source.index('require-qualified-storage.py'), source.index('Create the GTHF staging namespace'))
        self.assertLess(source.index('require-qualified-storage.py'), source.index('kubectl, apply, -k'))
