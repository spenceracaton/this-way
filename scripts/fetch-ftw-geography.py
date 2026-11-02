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

def fetch(path, destination):
    endpoint = f'repos/{REPOSITORY}/contents/{PREFIX}{path}?ref={REVISION}'
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
    return {'sourcePath': PREFIX + path, 'gitBlobSha': digest, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}

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
    args = parser.parse_args()
    run(args.output.resolve())
