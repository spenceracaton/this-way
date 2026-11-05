import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {clusterPoints,searchPlaces,readCamera,startView,publishedRecords,approvedPhotos} from '../public/prototypes/discovery-map/discovery-model.mjs';

test('map clusters preserve each canonical identity once and separate remaining targets',()=>{
  const items=Array.from({length:94},(_,i)=>({id:String(i),x:(i%11)*21,y:Math.floor(i/11)*31}));
  const groups=clusterPoints(items,p=>p,60);
  assert.equal(groups.reduce((n,g)=>n+g.items.length,0),94);
  assert.equal(new Set(groups.flatMap(g=>g.items.map(p=>p.id))).size,94);
  for(let i=0;i<groups.length;i++)for(let j=i+1;j<groups.length;j++)assert.ok(Math.hypot(groups[i].x-groups[j].x,groups[i].y-groups[j].y)>=60);
});
test('city aliases and neighborhood names share search without an intermediate region',()=>{
  const places=[{id:'crescent-lake',name:'Crescent Lake'},{id:'old-northeast',name:'Old Northeast'},{id:'st-pete-heights',name:'St. Pete Heights'}];
  assert.equal(searchPlaces('St Pete',places)[0].id,'st-petersburg');
  assert.equal(searchPlaces('Saint Petersburg',places)[0].type,'city');
  assert.equal(searchPlaces('crescentlake',places)[0].id,'crescent-lake');
  assert.equal(searchPlaces('All Pinellas',places)[0].type,'county');
  assert.deepEqual(searchPlaces('?',places),[]);
});
test('shared camera accepts a county zoom and rejects malformed or out of area input',()=>{
  assert.deepEqual(readCamera(new URLSearchParams('lat=27.9&lng=-82.7&z=10.25')),{lat:27.9,lng:-82.7,zoom:10.25});
  for(const q of ['','lat=27.8&lng=-82.6','lat=27.8&lng=-82.6&z=NaN','lat=51&lng=0&z=15','lat=27.8&lng=-82.6&z=5'])assert.deepEqual(readCamera(new URLSearchParams(q)),startView);
});
test('only approved same origin public photo URLs reach the shared gallery',()=>{
  assert.deepEqual(approvedPhotos([{url:'/api/photos/photo_approved-a'},{url:'/api/photos/pending-a',status:'pending'},{url:'https://elsewhere.test/api/photos/x'},{url:'/api/admin/photos/x/content'},{url:'javascript:alert(1)'}],'https://example.test'),['/api/photos/photo_approved-a']);
});
test('record validation preserves distinct same-address displays and fails broken identity',()=>{
  const a={id:'a',address:'100 Main St',latitude:27.78,longitude:-82.64,tags:['Lights'],photos:[]};
  const place={id:'old-northeast',name:'Old Northeast'};
  const records=publishedRecords([a,{...a,id:'b'}],place,'https://example.test');
  assert.equal(records.length,2);assert.equal(records[0].neighborhoodId,place.id);
  assert.throws(()=>publishedRecords([a,a],place,'https://example.test'));
  assert.throws(()=>publishedRecords([{...a,latitude:Infinity}],place,'https://example.test'));
  assert.throws(()=>publishedRecords(null,place,'https://example.test'));
});
test('all prepared maps remain reachable with valid camera extents and no invented boundary',async()=>{
  const root=new URL('../public/prototypes/',import.meta.url);
  const data=JSON.parse(await readFile(new URL('discovery-map/data/places.json',root)));
  const atlas=JSON.parse(await readFile(new URL('pinellas-atlas/atlas-data.json',root)));
  assert.deepEqual(data.places.map(p=>p.id),atlas.neighborhoods.map(p=>p.id));
  for(const place of data.places){assert.ok(place.bounds[0][0]<place.bounds[1][0]);assert.ok(place.bounds[0][1]<place.bounds[1][1]);}
  assert.match(data.note,/not official/);
});
test('county street tiles match their manifest and partition the acquired road source',async()=>{
  const root=new URL('../public/prototypes/discovery-map/data/',import.meta.url);
  const manifest=JSON.parse(await readFile(new URL('context-tiles.json',root)));
  const context=JSON.parse(await readFile(new URL('context.geojson',root)));
  const notices=JSON.parse(await readFile(new URL('source-notices.json',root)));
  const regional=new Set(context.features.filter(f=>f.properties.tier==='regional').map(f=>f.properties.sourceId)),locals=new Set();
  for(const tile of manifest.tiles){
    const bytes=await readFile(new URL(tile.url.replace('./data/',''),root));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),tile.sha256);
    const data=JSON.parse(bytes);assert.equal(data.features.length,tile.featureCount);
    for(const feature of data.features){assert.ok(!regional.has(feature.properties.sourceId));locals.add(feature.properties.sourceId);}
  }
  assert.equal(locals.size,notices.featureCounts.localRoad);assert.equal(regional.size,notices.featureCounts.regionalRoad);
  assert.ok(manifest.tiles.some(t=>t.bounds[0][0]>28));assert.ok(manifest.tiles.some(t=>t.bounds[1][0]<27.8));
});
