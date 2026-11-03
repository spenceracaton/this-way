import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const cli=resolve(root,'scripts/rehearse-ftw-import.mjs');

test('CLI rehearses only eligible synthetic records locally, replays without changes, and refuses output reuse or remote mode',async t=>{
  const dir=await mkdtemp(resolve(tmpdir(),'ftw-rehearsal-fixture-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const input=resolve(dir,'input.json'),output=resolve(dir,'private-run');
  await writeFile(input,JSON.stringify({
    sourceSystem:'synthetic-ftw-rehearsal-fixture',previewSeason:'halloween-2026',
    evidence:{scope:'synthetic-test-fixture'},assetManifest:{assets:[]},
    records:[{id:'inside',address:'Synthetic inside address',season_year:2026,status:'approved'},
      {id:'outside',address:'Synthetic outside address',season_year:2026,status:'approved'}],
    locationManifest:{inside:{neighborhoodId:'old-northeast',latitude:27.78464439,longitude:-82.63364857},
      outside:{neighborhoodId:'old-northeast',latitude:40.7,longitude:-74}}
  }));
  const run=()=>spawnSync(process.execPath,[cli,'--input',input,'--output',output],{cwd:root,encoding:'utf8',timeout:60000});
  const result=run();assert.equal(result.status,0,result.stderr);
  const reportBytes=await readFile(resolve(output,'report.json'));
  const report=JSON.parse(reportBytes);
  assert.equal(report.status,'passed');assert.equal(report.productionWrites,0);
  assert.equal(report.source.scope,'synthetic-test-fixture');
  assert.equal(report.sourceRecords,2);assert.equal(report.eligibleRecords,1);
  assert.equal(report.placementIssues[0].sourceId,'outside');
  assert.equal(report.firstApply.rowCounts.listings,1);assert.equal(report.replay.action,'skip');
  assert.deepEqual(report.afterFirst,report.afterReplay);assert.deepEqual(report.afterFirst,report.afterRestart);
  assert.equal(report.publicRoutes[0].publishedListings,1);
  assert.equal(report.publicRoutes[0].season,'halloween-2026');
  assert.notEqual(run().status,0);
  assert.deepEqual(await readFile(resolve(output,'report.json')),reportBytes);
  const remote=spawnSync(process.execPath,[cli,'--remote','--input',input,'--output',resolve(dir,'remote')],{cwd:root,encoding:'utf8'});
  assert.notEqual(remote.status,0);assert.match(remote.stderr,/Unknown option: --remote/);
});
