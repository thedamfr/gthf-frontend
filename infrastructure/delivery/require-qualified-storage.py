"""Refuse a legacy overlay deployment unless the renamed production storage is qualified."""
import argparse
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate_storage(proof, namespace_object, pvc, pv, namespace):
    require(namespace == 'gthf-staging', 'Only renamed production is supported')
    require(proof.get('schemaVersion') == 1 and proof.get('status') == 'qualified'
            and proof.get('namespace') == namespace and proof.get('qualifiedAt'),
            'A completed production migration qualification is required')
    require(proof.get('namespaceUid')
            and namespace_object.get('metadata', {}).get('name') == namespace
            and namespace_object.get('metadata', {}).get('uid') == proof['namespaceUid']
            and namespace_object.get('status', {}).get('phase') == 'Active',
            'The production namespace differs from the qualified migration')
    require(proof.get('goldenJourneys') == {'staging': 'passed', 'production': 'passed'},
            'Both real Golden Journeys must have passed')
    revisions = proof.get('runtimeRevisions', {})
    require(all(re.fullmatch('[a-f0-9]{40}', revisions.get(name, '')) for name in ('frontend', 'cms')),
            'The qualified runtime revisions must be recorded')
    storage = proof.get('storage', {})
    expected_volume = namespace + '-postgres-preserved'
    require(storage.get('pvc') == 'gthf-postgres' and storage.get('pv') == expected_volume
            and storage.get('pvcUid') and storage.get('pvUid') and storage.get('hostPath'),
            'The preserved production volume identity must be recorded')
    require(pvc.get('metadata', {}).get('namespace') == namespace
            and pvc.get('metadata', {}).get('name') == storage['pvc']
            and pvc.get('metadata', {}).get('uid') == storage['pvcUid']
            and pvc.get('status', {}).get('phase') == 'Bound'
            and pvc.get('spec', {}).get('volumeName') == expected_volume,
            'The renamed PVC is absent, unbound or differs from qualified storage')
    claim = pv.get('spec', {}).get('claimRef', {})
    require(pv.get('metadata', {}).get('name') == expected_volume
            and pv.get('metadata', {}).get('uid') == storage['pvUid']
            and pv.get('status', {}).get('phase') == 'Bound'
            and pv.get('spec', {}).get('persistentVolumeReclaimPolicy') == 'Retain'
            and pv.get('spec', {}).get('hostPath', {}).get('path') == storage['hostPath']
            and pv.get('spec', {}).get('nodeAffinity')
            and claim.get('namespace') == namespace and claim.get('name') == storage['pvc']
            and claim.get('uid') == storage['pvcUid'],
            'The PV binding or data path differs from the qualified production volume')


def read_proof(path):
    metadata = path.lstat()
    require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == os.getuid()
            and stat.S_IMODE(metadata.st_mode) & 0o077 == 0,
            'Qualification evidence must be a private regular file owned by the operator')
    return json.loads(path.read_text())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--namespace', required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    try:
        require(socket.gethostname() == 'game-prod-ovh-gra', 'Unexpected deployment host')
        proof = read_proof(args.evidence)
        def kube(*arguments):
            return subprocess.run(['sudo', '-n', '/snap/bin/microk8s', 'kubectl', *arguments],
                                  check=True, capture_output=True, text=True, timeout=30).stdout
        require(kube('config', 'current-context').strip() == 'microk8s', 'Unexpected Kubernetes context')
        namespace = json.loads(kube('get', 'namespace', args.namespace, '-o', 'json'))
        pvc = json.loads(kube('-n', args.namespace, 'get', 'pvc', 'gthf-postgres', '-o', 'json'))
        pv = json.loads(kube('get', 'pv', args.namespace + '-postgres-preserved', '-o', 'json'))
        validate_storage(proof, namespace, pvc, pv, args.namespace)
    except (ValueError, TypeError, AttributeError, OSError, subprocess.SubprocessError):
        # No secrets or raw Kubernetes errors enter Ansible output.
        raise SystemExit('Refusing deployment: qualified preserved production storage could not be verified')
    print('Qualified production PVC, PV and retained data path verified; no storage was created')


if __name__ == '__main__':
    main()
