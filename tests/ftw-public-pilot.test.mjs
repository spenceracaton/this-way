import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { publicPilotRecord, containedFile, loadPublicPilotSnapshot } from '../scripts/lib/ftw-public-pilot.mjs';
import { sanitizeImage } from '../server/image.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const display = { id:'fixture-display', address:'Synthetic test address', destination:{lat:27.7846,lng:-82.6336},
  x:2400,y:900,hasPhotos:false,level:2,tags:['Spooky'],customTags:['Custom tag'],featured:false,theme:'Synthetic title' };

test('public adapter preserves coordinates as provenance without inventing private fields or home membership', () => {
  const record = publicPilotRecord({display,query:'old-northeast',gallery:[],year:2026});
  assert.deepEqual(record.public_snapshot,display);
  assert.equal(record.x,2400); assert.equal(record.y,900);
  assert.equal(record.latitude,undefined); assert.equal(record.longitude,undefined);
  assert.equal(record.version,undefined); assert.equal(record.created_at,undefined);
  assert.equal(record.description,undefined); assert.equal(record.address_match,undefined);
  assert.equal(record.public_snapshot_scope.targetNeighborhoodIsSourceHome,false);
  assert.deepEqual(record.public_snapshot_scope.inferredFromSourceContract,['approved visibility','active Halloween year 2026','gallery order']);
  assert.equal(record.season_id,'halloween-2026');
  assert.deepEqual(record.tags,['Spooky']); assert.deepEqual(record.custom_tags,['Custom tag']);
  assert.throws(()=>publicPilotRecord({display:{...display,hasPhotos:true},query:'old-northeast',gallery:[],year:2026}),/inventory is missing/);
  assert.throws(()=>publicPilotRecord({display,query:'old-northeast',gallery:[{id:'bad',url:'https://other.example/photo'}],year:2026}),/Unrecognized public photo/);
});

test('snapshot validates original response/photo bytes and creates explicit, sanitized destination assets', async t => {
  const root=await mkdtemp(resolve(tmpdir(),'ftw-public-fixture-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(resolve(root,'canonical'));await mkdir(resolve(root,'raw-api'));await mkdir(resolve(root,'photos'));
  await mkdir(resolve(root,'raw-api/photo-galleries-round2'));
  const bytes=await readFile(new URL('../public/assets/samples/illustration-haunt.webp',import.meta.url));
  const image=sanitizeImage(bytes,'image/webp');
  const dto={...display,hasPhotos:true};const response=Buffer.from(JSON.stringify({displays:[dto]}));
  const gallery=[{id:'fixture-photo',url:'/api/photos/fixture-photo',width:image.width,height:image.height,fit:'contain'}];
  await writeFile(resolve(root,'raw-api/response.json'),response);
  await writeFile(resolve(root,'photos/source.webp'),bytes);
  const galleryBody=Buffer.from(JSON.stringify({photos:gallery}));
  const galleryUrl='https://frightthisway.com/api/displays/fixture-display/photos';
  await writeFile(resolve(root,'raw-api/photo-galleries-round2/fixture-display.json'),JSON.stringify({photos:gallery,sourceResponseUrl:galleryUrl,sourceResponseSha256:sha(galleryBody),sourceResponseBytes:galleryBody.length}));
  await writeFile(resolve(root,'evidence-v2.json'),JSON.stringify({capturedAtUtc:'2026-11-03T00:00:00Z',qaSourceHeadSha:'synthetic-fixture',apiRequests:[{url:galleryUrl,status:200,sha256:sha(galleryBody),byteLength:galleryBody.length}],areas:[{areaQuery:'old-northeast',rawResponsePath:'raw-api/response.json',rawResponseSha256:sha(response),fullReturnedDisplayCount:1}]}));
  await writeFile(resolve(root,'canonical/public-listing-sample.json'),JSON.stringify({publicStatusPolicy:{configuredActiveSeasonYearFromQASource:2026},records:[{id:dto.id,sourceMapQuery:'old-northeast',photoGallery:gallery}]}));
  const index={assets:[{photoId:'fixture-photo',sourceListingId:dto.id,path:'photos/source.webp',sha256:sha(bytes),mediaType:'image/webp',width:image.width,height:image.height,sourceUrl:'https://frightthisway.com/api/photos/fixture-photo'}]};
  await writeFile(resolve(root,'photo-assets-index.json'),JSON.stringify(index));
  const result=await loadPublicPilotSnapshot(root);
  assert.equal(result.sourceSystem,'ftw-public-pilot');
  assert.deepEqual(result.locationManifest[dto.id],{neighborhoodId:'old-northeast',latitude:dto.destination.lat,longitude:dto.destination.lng,provenance:{kind:'public-destination-coordinates',query:'old-northeast',originalHomeNeighborhood:'unavailable'}});
  assert.equal(result.assets[0].contentHash,`sha256:${sha(image.bytes)}`);
  assert.equal(result.assets[0].sourceSha256,sha(bytes));
  assert.equal(result.records[0].photos[0].object_key,'public-api/photos/fixture-photo');
  assert.equal(result.records[0].photos[0].position,0);assert.equal(result.records[0].photos[0].fit,'contain');
  const selectionPath=resolve(root,'canonical/public-listing-sample.json');
  const selection=JSON.parse(await readFile(selectionPath));
  selection.records[0].photoGallery[0].fit='cover';
  await writeFile(selectionPath,JSON.stringify(selection));
  await assert.rejects(loadPublicPilotSnapshot(root),/Canonical gallery differs/);
  selection.records[0].photoGallery[0].fit='contain';
  await writeFile(selectionPath,JSON.stringify(selection));
  await writeFile(resolve(root,'photos/source.webp'),Buffer.from('changed'));
  await assert.rejects(loadPublicPilotSnapshot(root),/photo checksum mismatch/);
  await writeFile(resolve(root,'photos/source.webp'),bytes);
  await writeFile(resolve(root,'raw-api/response.json'),Buffer.from('{"displays":[]}'));
  await assert.rejects(loadPublicPilotSnapshot(root),/response checksum mismatch/);
});

test('source paths reject traversal and symlink escapes',async t=>{
  const root=await mkdtemp(resolve(tmpdir(),'ftw-path-fixture-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(resolve(root,'snapshot'));await writeFile(resolve(root,'outside.txt'),'synthetic test sentinel');
  await symlink(resolve(root,'outside.txt'),resolve(root,'snapshot/link'));
  await assert.rejects(containedFile(resolve(root,'snapshot'),'../outside.txt'),/escapes/);
  await assert.rejects(containedFile(resolve(root,'snapshot'),'link'),/escapes/);
});
