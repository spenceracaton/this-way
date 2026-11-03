import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadFtwSourceBundle } from '../scripts/lib/ftw-source-bundle.mjs';
import { sanitizeImage } from '../server/image.mjs';

const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const base = (path, bytes) => ({ schemaVersion: 1, provenance: { kind:'authenticated-content-export', sourceSystem:'fright-this-way', captureId:'capture-1', capturedAt:'2026-11-03T00:00:00Z', authoritativeSystem:'official-sites', exporterVersion:'1', timestampUnit:'milliseconds', complete:true, unavailableFields:[], scope:{seasons:[2026],neighborhoods:['old-northeast']} }, records:[{id:'listing-a',season_year:2026,status:'approved',created_at:100,address:'1 Main St',address_match:{neighborhoodId:'old-northeast',latitude:27.7,longitude:-82.6},photos:[{id:'photo-a',object_key:'original/key.png',status:'approved',created_at:101,position:0}]}], assetManifest:{assets:[{sourceKey:'original/key.png',path,originalContentHash:hash(bytes),mediaType:'image/png',width:1,height:1}]} });

test('validates scoped source bundle and sanitizes bytes into deterministic destination assets', async t => {
  const dir = await mkdtemp(join(tmpdir(),'ftw-bundle-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const bytes = await readFile(new URL('./fixtures/metadata-test.jpg', import.meta.url));
  await mkdir(join(dir,'assets')); await writeFile(join(dir,'assets/photo.jpg'),bytes);
  const bundle = base('assets/photo.jpg',bytes), decoded=sanitizeImage(bytes,'image/jpeg'); bundle.assetManifest.assets[0].mediaType='image/jpeg';
  bundle.assetManifest.assets[0].width=decoded.width; bundle.assetManifest.assets[0].height=decoded.height;
  await writeFile(join(dir,'bundle.json'),JSON.stringify(bundle));
  const loaded=await loadFtwSourceBundle(join(dir,'bundle.json'));
  assert.equal(loaded.input.records[0].status,'approved');
  assert.equal(loaded.input.timestampUnit,'milliseconds');
  assert.match(loaded.assets[0].objectKey,/^ftw-import\/[a-f0-9]{64}\/[a-f0-9]{64}\.jpg$/);
  assert.equal(loaded.assets[0].contentHash,hash(loaded.assets[0].bytes));
  assert.equal(loaded.reconciliation.photoCount,1);
});

test('rejects public rehearsal and missing actual statuses/years', async t => {
  const dir=await mkdtemp(join(tmpdir(),'ftw-bundle-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const bytes=await readFile(new URL('./fixtures/metadata-test.jpg',import.meta.url));
  await writeFile(join(dir,'photo.jpg'),bytes);
  const bundle=base('photo.jpg',bytes), decoded=sanitizeImage(bytes,'image/jpeg'); bundle.assetManifest.assets[0].mediaType='image/jpeg'; bundle.assetManifest.assets[0].width=decoded.width;bundle.assetManifest.assets[0].height=decoded.height;
  bundle.provenance.sourceSystem='ftw-public-pilot'; await writeFile(join(dir,'bundle.json'),JSON.stringify(bundle));
  await assert.rejects(loadFtwSourceBundle(join(dir,'bundle.json')),/not authenticated/);
  bundle.provenance.sourceSystem='fright-this-way'; delete bundle.records[0].status; await writeFile(join(dir,'bundle.json'),JSON.stringify(bundle));
  await assert.rejects(loadFtwSourceBundle(join(dir,'bundle.json')),/actual source status/);
});

test('rejects hash mismatches, missing referenced assets, and path traversal', async t => {
  const dir=await mkdtemp(join(tmpdir(),'ftw-bundle-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const bytes=await readFile(new URL('./fixtures/metadata-test.jpg',import.meta.url));
  await writeFile(join(dir,'photo.jpg'),bytes);
  const bundle=base('photo.jpg',bytes), decoded=sanitizeImage(bytes,'image/jpeg'); bundle.assetManifest.assets[0].mediaType='image/jpeg'; bundle.assetManifest.assets[0].width=decoded.width;bundle.assetManifest.assets[0].height=decoded.height;
  bundle.assetManifest.assets[0].originalContentHash=hash(Buffer.from('wrong')); await writeFile(join(dir,'bundle.json'),JSON.stringify(bundle));
  await assert.rejects(loadFtwSourceBundle(join(dir,'bundle.json')),/hash mismatch/);
  bundle.assetManifest.assets=[]; await writeFile(join(dir,'bundle.json'),JSON.stringify(bundle));
  await assert.rejects(loadFtwSourceBundle(join(dir,'bundle.json')),/missing photo bytes/);
  await symlink('/etc/hosts',join(dir,'escape'));
  bundle.assetManifest.assets=[{...base('escape',bytes).assetManifest.assets[0],mediaType:'image/jpeg',width:decoded.width,height:decoded.height}];
  await writeFile(join(dir,'bundle.json'),JSON.stringify(bundle));
  await assert.rejects(loadFtwSourceBundle(join(dir,'bundle.json')),/escapes bundle/);
});
