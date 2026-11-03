#!/usr/bin/env python3
"""Fetch pinned, geography-only FTW QA inputs; requires existing GitHub read access."""
import argparse
import base64
import concurrent.futures
import hashlib
import json
import re
import subprocess
from pathlib import Path

REPOSITORY = 'spenceracaton/fright-this-way-qa'
REVISION = '00ba22299bdedd5bd7e3c2548b90e4e7e74d86d8'
PREFIX = 'release-source/current/'

def fetch(path, destination, prefix=PREFIX):
    endpoint = f'repos/{REPOSITORY}/contents/{prefix}{path}?ref={REVISION}'
    metadata = json.loads(subprocess.check_output(['gh', 'api', endpoint]))
    if metadata.get('content'):
        data = base64.b64decode(metadata['content'])
    else:
        data = subprocess.check_output(['gh', 'api', '-H', 'Accept: application/vnd.github.raw+json', endpoint])
    digest = hashlib.sha1(('blob ' + str(len(data)) + '\0').encode() + data).hexdigest()
    if digest != metadata['sha']:
        raise ValueError(f'Source blob checksum mismatch: {path}')
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)
    return {'sourcePath': prefix + path, 'gitBlobSha': digest, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}


def expansion(output, plan_path=None, selected_ids=None):
    plan_path = plan_path or Path(__file__).with_name('ftw-expansion-sources.json')
    plan = json.loads(plan_path.read_text())
    if plan['repository'] != REPOSITORY or plan['revision'] != REVISION:
        raise ValueError('Expansion source plan must use the pinned QA repository revision')
    reference, source = output / 'reference', output / 'source'
    selected = set(selected_ids) if selected_ids else set(plan['mapPrefixes'])
    unknown = selected - set(plan['mapPrefixes'])
    if unknown:
        raise ValueError('IDs absent from source plan: ' + ', '.join(sorted(unknown)))
    prefixes = {id: plan['mapPrefixes'][id] for id in plan['mapPrefixes'] if id in selected}
    maps, buffers, reference_sources = {}, {}, []
    snapshots = {}
    for prefix in sorted(set(prefixes.values())):
        prefix += '/'
        snapshots[prefix] = {}
        for filename in ['neighborhood-maps.json', 'neighborhood-buffer-config.json']:
            destination = reference / 'snapshots' / prefix.replace('/', '_') / filename
            record = fetch('lib/' + filename, destination, prefix)
            reference_sources.append({'prefix': prefix, 'file': filename, **record})
            snapshots[prefix][filename] = json.loads(destination.read_text())
    for id, prefix in prefixes.items():
        maps[id] = snapshots[prefix + '/']['neighborhood-maps.json'][id]
        buffers[id] = snapshots[prefix + '/']['neighborhood-buffer-config.json'][id]
        for key, metadata in [('expectedMapEntry', maps[id]), ('expectedBufferEntry', buffers[id])]:
            recorded = 'recordedSourceMetadataHashes' in plan
            expected = plan.get('recordedSourceMetadataHashes', plan.get('qaMetadataHashes', {})).get(id, {}).get(key)
            digest = hashlib.sha256(json.dumps(metadata, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            if expected and digest != expected:
                label = 'Recorded source metadata fingerprint' if recorded else 'Maintained QA metadata'
                raise ValueError(f'{label} mismatch: {id}/{key}')
    reference_files = {}
    for filename, data in [('neighborhood-maps.json', maps), ('neighborhood-buffer-config.json', buffers)]:
        payload = (json.dumps(data, indent=2) + '\n').encode()
        (reference / filename).write_bytes(payload)
        reference_files[filename] = {'sha256': hashlib.sha256(payload).hexdigest(), 'size': len(payload)}
    tasks = [(id, filename) for id in sorted(maps) for filename in
             ['review-map.svg', 'map-data.json', 'buffer.mjs', 'buffer-map-data.json', 'source-geography.geojson']]
    def download(item):
        id, filename = item
        path = ('lib/neighborhood-buffers/' + id + '.mjs') if filename == 'buffer.mjs' else ('public/neighborhoods/' + id + '/' + filename)
        record = fetch(path, source / id / filename, prefixes[id] + '/')
        recorded = 'recordedSourceAssetHashes' in plan
        expected = plan.get('recordedSourceAssetHashes', {}).get(id, {}).get(filename, {})
        expected_sha = expected.get('sha256') if isinstance(expected, dict) else expected
        expected_sha = expected_sha or plan.get('qaAssetHashes', {}).get(id, {}).get(filename)
        if expected_sha and expected_sha != record['sha256']:
            label = 'Recorded source asset fingerprint' if recorded else 'Maintained QA asset'
            raise ValueError(f'{label} mismatch: {id}/{filename}')
        return {'id': id, 'file': filename, **record}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        files = list(pool.map(download, tasks))
    for id in sorted(maps):
        wrapper = (source / id / 'buffer.mjs').read_text()
        match = re.search(r"from ['\"]\./([a-z0-9-]+\.json)['\"]", wrapper)
        if match:
            name = match[1]
            record = fetch('lib/neighborhood-buffers/' + name, source / id / name, prefixes[id] + '/')
            files.append({'id': id, 'file': name, **record})
    (source / 'manifest.json').write_text(json.dumps({
        'repository': REPOSITORY, 'revision': REVISION, 'normalizedSourceNotices': True,
        'sourcePrefixes': prefixes, 'referenceSources': reference_sources,
        'referenceFiles': reference_files, 'files': files,
    }, indent=2) + '\n')
    print(json.dumps({'maps': len(maps), 'files': len(files), 'output': str(output)}))

def run(output):
    reference, source = output / 'reference', output / 'source'
    for name in ['neighborhood-maps.json', 'neighborhood-buffer-config.json']:
        fetch('lib/' + name, reference / name)
    maps = json.loads((reference / 'neighborhood-maps.json').read_text())
    ids = sorted(set(maps) - {'old-northeast', 'crescent-lake'})
    if len(ids) != 57:
        raise ValueError('Pinned registry differs from the reviewed 57-map expansion')
    tasks = [(id, filename) for id in ids for filename in ['review-map.svg', 'map-data.json', 'buffer.mjs']]
    def download(item):
        id, filename = item
        path = ('lib/neighborhood-buffers/' + id + '.mjs') if filename == 'buffer.mjs' else ('public/neighborhoods/' + id + '/' + filename)
        entry = fetch(path, source / id / filename)
        return {'id': id, 'file': filename, **entry}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        files = list(pool.map(download, tasks))
    for id in ids:
        wrapper = (source / id / 'buffer.mjs').read_text()
        match = re.search(r"from ['\"]\./([a-z0-9-]+\.json)['\"]", wrapper)
        if match:
            name = match[1]
            entry = fetch('lib/neighborhood-buffers/' + name, source / id / name)
            files.append({'id': id, 'file': name, **entry})
    (source / 'manifest.json').write_text(json.dumps({'repository': REPOSITORY, 'revision': REVISION, 'files': files}, indent=2) + '\n')
    print(json.dumps({'maps': len(ids), 'files': len(files), 'output': str(output)}))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path('/tmp/this-way-ftw-geography'))
    parser.add_argument('--expansion', action='store_true', help='Fetch the reviewed additional-map source plan instead of the original 57-map bundle')
    parser.add_argument('--plan', type=Path, help='Fetch a specific checked-in geography source plan')
    parser.add_argument('--ids', nargs='+', help='Restrict --plan/--expansion to these map IDs')
    args = parser.parse_args()
    if args.plan and not args.expansion:
        expansion(args.output.resolve(), args.plan.resolve(), args.ids)
    elif args.expansion:
        expansion(args.output.resolve(), selected_ids=args.ids)
    elif args.ids:
        parser.error('--ids requires --plan or --expansion')
    else:
        run(args.output.resolve())
