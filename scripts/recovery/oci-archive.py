#!/usr/bin/env python3
"""Preserve Docker's immutable OCI graph while exporting it for containerd."""
import argparse
import hashlib
import io
import json
import os
import re
import tarfile


def convert(source, destination, reference):
    if not re.fullmatch(r'[a-z0-9][a-z0-9./_-]*(?::[A-Za-z0-9_.-]+)?@sha256:[a-f0-9]{64}', reference):
        raise ValueError('An immutable image reference is required')
    repository, expected = reference.split('@')
    canonical = repository
    if '/' not in repository:
        canonical = 'docker.io/library/' + repository
    elif '.' not in repository.split('/')[0] and ':' not in repository.split('/')[0]:
        canonical = 'docker.io/' + repository
    canonical += '@' + expected
    os.umask(0o077)
    with tarfile.open(source, 'r:') as archive:
        members = archive.getmembers()
        if len({member.name for member in members}) != len(members):
            raise ValueError('Duplicate archive member')
        by_name = {member.name: member for member in members}

        def blob(descriptor):
            digest = descriptor['digest']
            if not re.fullmatch(r'sha256:[a-f0-9]{64}', digest):
                raise ValueError('Unsupported OCI digest')
            member = by_name['blobs/sha256/' + digest.split(':')[1]]
            if not member.isfile() or member.size > 16 * 1024 * 1024:
                raise ValueError('Unexpected OCI metadata')
            data = archive.extractfile(member).read()
            if len(data) != descriptor['size'] or hashlib.sha256(data).hexdigest() != digest.split(':')[1]:
                raise ValueError('OCI metadata digest mismatch')
            return json.loads(data)

        index_member = by_name['index.json']
        if not index_member.isfile() or index_member.size > 16 * 1024 * 1024:
            raise ValueError('Unexpected OCI index')
        exported = json.load(archive.extractfile(index_member))
        candidates = [item for item in exported['manifests'] if item['digest'] == expected]
        if len(candidates) != 1:
            raise ValueError('The requested image is not the archived OCI root')
        root = candidates[0]
        descriptor = root
        value = blob(descriptor)
        for _ in range(4):
            if 'manifests' not in value:
                break
            platforms = [item for item in value['manifests'] if item.get('platform', {}).get('os') == 'linux' and item.get('platform', {}).get('architecture') == 'amd64']
            if len(platforms) != 1:
                raise ValueError('A unique Linux amd64 runtime is required')
            descriptor = platforms[0]
            value = blob(descriptor)
        if 'config' not in value or 'layers' not in value:
            raise ValueError('Missing OCI image manifest')
        config = blob(value['config'])
        if config.get('os') != 'linux' or config.get('architecture') != 'amd64':
            raise ValueError('Incorrect runtime platform')
        result = {'canonicalRef': canonical, 'digest': expected, 'runtimeManifestDigest': descriptor['digest'], 'runtimeConfigDigest': value['config']['digest'], 'imageId': value['config']['digest']}
        index = {'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.index.v1+json', 'manifests': [{**root, 'annotations': {**root.get('annotations', {}), 'io.containerd.image.name': canonical}}]}

        with open(destination, 'xb') as raw:
            with tarfile.open(fileobj=raw, mode='w') as output:
                for name, data in [('oci-layout', b'{"imageLayoutVersion":"1.0.0"}'), ('index.json', json.dumps(index, separators=(',', ':')).encode())]:
                    info = tarfile.TarInfo(name)
                    info.size = len(data)
                    info.mode = 0o600
                    output.addfile(info, io.BytesIO(data))
                for member in members:
                    if not re.fullmatch(r'blobs/sha256/[a-f0-9]{64}', member.name):
                        continue
                    if not member.isfile():
                        raise ValueError('Non-regular OCI blob')
                    stream = archive.extractfile(member)
                    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
                    if digest != member.name.split('/')[-1]:
                        raise ValueError('OCI blob content does not match its digest')
                    stream.seek(0)
                    output.addfile(member, stream)
            raw.flush()
            os.fsync(raw.fileno())
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source')
    parser.add_argument('destination')
    parser.add_argument('reference')
    args = parser.parse_args()
    print(json.dumps(convert(args.source, args.destination, args.reference)))
