#!/usr/bin/env node
// Isolated local rehearsal only. No remote database, bucket or credential path.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { dirname, resolve, relative, extname, isAbsolute, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { planFtwImport } from '../server/import-ftw.mjs';
import { normalizeListing } from '../server/index.mjs';
import { seasonFor } from '../public/season-config.mjs';
import { createTestService } from '../tests/helpers/service-runtime.mjs';
import { readFtwPilotTarget, applyFtwPilotPlan } from './lib/ftw-pilot-store.mjs';
import { containedFile, loadPublicPilotSnapshot } from './lib/ftw-public-pilot.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const privateJson = (path, value) => writeFile(path, json(value), { mode: 0o600 });
const under = (base, path) => { const rel = relative(base, path); return rel === '' || !rel.startsWith('../') && rel !== '..' && !isAbsolute(rel); };

async function loadBundle(path) {
  const file = await realpath(path), bytes = await readFile(file), input = JSON.parse(bytes);
  if (!Array.isArray(input.records) || !Array.isArray(input.assetManifest?.assets)) throw new TypeError('Input requires records and explicit assetManifest.assets');
  const assets = [];
  for (const asset of input.assetManifest.assets) {
    assets.push({ ...asset, bytes: new Uint8Array(await readFile(await containedFile(dirname(file), asset.path))) });
  }
  return { ...input, assets, evidence: { ...(input.evidence || {}), inputSha256: hash(bytes), scope: input.evidence?.scope || 'operator-supplied-bundle' } };
}

function locationFor(record, manifest) {
  const entry = manifest?.[`${record.id}:${record.season_year}`] ?? manifest?.[record.id] ?? {};
  const match = typeof record.address_match === 'string' ? JSON.parse(record.address_match) : record.address_match ?? record.addressMatch ?? {};
  return { neighborhoodId: entry.neighborhoodId ?? entry.neighborhood_id ?? match.neighborhoodId ?? match.neighborhood_id,
    latitude: entry.latitude ?? record.latitude ?? match.latitude,
    longitude: entry.longitude ?? record.longitude ?? match.longitude };
}

function checkLocation(record, manifest, previewSeason) {
  if (!['approved', 'published'].includes(String(record.status).toLowerCase())) return null;
  try {
    const location = locationFor(record, manifest);
    // Reuse the service's exact bounds/core test with otherwise valid neutral
    // fields; this is a placement check, not a new submission or a season retag.
    normalizeListing({ ...location, seasonId: previewSeason, address: 'Rehearsal coverage check',
      clientRequestId: 'ftw-rehearsal-coverage-check' }, { ACTIVE_SEASON: previewSeason });
    return null;
  } catch (error) {
    return { sourceId: record.id, reason: error.code || 'invalid_location', message: error.message,
      candidateNeighborhood: locationFor(record, manifest).neighborhoodId ?? null };
  }
}

async function counts(service) {
  const tables = ['seasons', 'locations', 'listings', 'photos', 'source_mappings', 'review_events'];
  const result = {};
  for (const table of tables) result[table] = (await service.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
  result.objects = (await service.bucket.list({ limit: 1000 })).objects.length;
  return result;
}

async function verifyPublic(service, plan) {
  const locations = new Map(plan.locations.map(row => [row.id, row]));
  const queries = new Map();
  for (const listing of plan.listings) {
    const location = locations.get(listing.location_id);
    if (location?.neighborhood_id) queries.set(`${listing.season_id}\u001f${location.neighborhood_id}`, { season: listing.season_id, neighborhood: location.neighborhood_id });
  }
  const routes = [];
  for (const [key, query] of queries) {
    const response = await service.request(`/api/listings?${new URLSearchParams(query)}`);
    if (!response.ok) throw new Error(`Local listing route failed: ${response.status}`);
    const { listings } = await response.json();
    const expected = plan.listings.filter(row => row.season_id === query.season && locations.get(row.location_id)?.neighborhood_id === query.neighborhood && row.status === 'published');
    if (listings.length !== expected.length || expected.some(row => !listings.some(item => item.id === row.id))) throw new Error('Local public visibility differs from imported source status');
    for (const listing of listings) {
      const approved = plan.photos.filter(photo => photo.listing_id === listing.id && photo.status === 'approved').sort((a,b) => a.position - b.position || a.id.localeCompare(b.id));
      if (JSON.stringify(listing.photos.map(photo => photo.id)) !== JSON.stringify(approved.map(photo => photo.id))) throw new Error('Local gallery visibility/order differs from plan');
      for (const photo of listing.photos) {
        const expectedPhoto = approved.find(item => item.id === photo.id);
        const image = await service.request(photo.url);
        if (!image.ok || `sha256:${hash(new Uint8Array(await image.arrayBuffer()))}` !== expectedPhoto.content_hash) throw new Error('Local public photo bytes differ from imported asset');
      }
    }
    routes.push({ ...query, publishedListings: listings.length });
  }
  for (const photo of plan.photos.filter(row => row.status !== 'approved' || !plan.listings.some(listing => listing.id === row.listing_id && listing.status === 'published'))) {
    if ((await service.request(`/api/photos/${photo.id}`)).status !== 404) throw new Error('Nonpublic imported photo leaked');
  }
  return routes;
}

async function previewServer(service) {
  const types = { '.html':'text/html', '.mjs':'text/javascript', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.json':'application/json', '.webp':'image/webp', '.woff2':'font/woff2' };
  let origin;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, origin);
      if (url.pathname.startsWith('/api/')) {
        const parts = []; let size = 0;
        for await (const part of request) { size += part.length; if (size > 3 * 1024 * 1024) throw new Error('Local request too large'); parts.push(part); }
        const result = await service.request(url.pathname + url.search, { method: request.method, headers: request.headers,
          ...(parts.length ? { body: Buffer.concat(parts) } : {}), url: origin });
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(Buffer.from(await result.arrayBuffer()));
        return;
      }
      const file = resolve(root, 'public', '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!under(resolve(root, 'public'), file)) { response.writeHead(403).end(); return; }
      response.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control':'no-store' });
      response.end(await readFile(file));
    } catch { if (!response.headersSent) response.writeHead(404); response.end(); }
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin };
}

async function inspectDensePins(page, listings, locations, path) {
  if (listings.length < 2) return null;
  let pair, distance = Infinity;
  for (let i=0;i<listings.length;i++) for (let j=i+1;j<listings.length;j++) {
    const a=locations.get(listings[i].location_id),b=locations.get(listings[j].location_id);
    const d=Math.hypot((a.longitude-b.longitude)*Math.cos(a.latitude*Math.PI/180),a.latitude-b.latitude);
    if (d<distance) {distance=d;pair=[listings[i],listings[j]];}
  }
  const boxes=async()=>Promise.all(pair.map(row=>page.locator(`.map-pin[data-pin="${row.id}"]`).boundingBox()));
  const separated = ([a,b]) => Math.max(Math.abs(a.x-b.x),Math.abs(a.y-b.y)) >= 48;
  const map=await page.locator('#map').boundingBox();
  const centerPair=async target=>{
    for(let i=0;i<8;i++){
      const [a,b]=await boxes();
      const dx=Math.max(-80,Math.min(80,target.x-(a.x+b.x+a.width)/2));
      const dy=Math.max(-80,Math.min(80,target.y-(a.y+b.y+a.height)/2));
      if(Math.abs(dx)<3&&Math.abs(dy)<3)break;
      await page.mouse.move(map.x+map.width/2,map.y+map.height/2);await page.mouse.down();
      await page.mouse.move(map.x+map.width/2+dx,map.y+map.height/2+dy,{steps:12});
      await page.waitForTimeout(140);await page.mouse.up();await page.waitForTimeout(150);
    }
  };
  let steps=0;
  while (!separated(await boxes()) && steps<16) {
    const zoom=page.getByRole('button',{name:'Zoom in',exact:true});
    if (await zoom.evaluate(el=>el.classList.contains('leaflet-disabled'))) break;
    await zoom.click();steps++;
    await centerPair({x:map.x+map.width/2,y:map.y+map.height/2});
  }
  if (!separated(await boxes())) throw new Error('Closest imported pins remain overlapped at maximum zoom; manual review required');
  const toolbar=await page.locator('.map-toolbar').boundingBox();
  const references=await page.locator('.references').boundingBox();
  const target={x:map.x+map.width*.45,y:(toolbar.y+toolbar.height+references.y)/2};
  await centerPair(target);
  await page.screenshot({path});
  for(const row of pair){
    await page.locator(`.map-pin[data-pin="${row.id}"]`).click();
    if(await page.locator('#selected-name').textContent()!==locations.get(row.location_id).address)throw new Error('Zoomed pin selected a different imported address');
    await page.locator('#detail-close').click();
  }
  await page.getByRole('button',{name:'Reset view',exact:true}).click();
  return {canonicalIds:pair.map(row=>row.id),zoomSteps:steps,individuallySelected:true};
}

async function capture(service, plan, output, origin) {
  const { chromium, webkit } = await import('@playwright/test');
  const dir = resolve(output, 'renders'); await mkdir(dir, { mode:0o700 });
  const locations = new Map(plan.locations.map(row => [row.id, row]));
  const areas = [...new Set(plan.locations.map(row => row.neighborhood_id).filter(Boolean))];
  const results = [];
  for (const [name, browserType, width, height] of [['desktop',chromium,1280,900],['phone',webkit,390,664]]) {
    const browser = await browserType.launch(name === 'desktop' && process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath:process.env.CHROMIUM_EXECUTABLE_PATH } : {});
    try {
      const page = await browser.newPage({ viewport:{width,height}, ...(name === 'phone' ? { isMobile:true, hasTouch:true } : {}) });
      await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      for (const area of areas) {
        await page.goto(`${origin}/?neighborhood=${encodeURIComponent(area)}`);
        await page.locator('#map[aria-busy=false]').waitFor();
        const expected = plan.listings.filter(row => row.status === 'published' && locations.get(row.location_id)?.neighborhood_id === area);
        if (await page.locator('.map-pin').count() !== expected.length) throw new Error('Rendered pin count differs from imported rows');
        await page.screenshot({ path:resolve(dir,`${name}-${area}-map.png`) });
        const clusterInspection = name === 'phone' ? await inspectDensePins(page,expected,locations,resolve(dir,`${name}-${area}-zoom.png`)) : null;
        const photoListing = expected.find(row => plan.photos.some(photo => photo.listing_id === row.id && photo.status === 'approved'));
        const noPhoto = expected.find(row => !plan.photos.some(photo => photo.listing_id === row.id && photo.status === 'approved'));
        for (const [kind, listing] of [['photo',photoListing],['address',noPhoto]]) {
          if (!listing) continue;
          const button = page.locator(`.map-pin[data-pin="${listing.id}"]`);
          // A reference-list selection is a normal UI path even for a pin
          // initially outside the camera; avoid bypassing card rendering.
          const reference = page.locator(`#reference-list button[data-id="${listing.id}"]`);
          if (await reference.count()) await reference.click(); else await button.click();
          await page.locator('#selection:not([hidden])').waitFor();
          const title = await page.locator('#detail-title').textContent();
          if (title !== (listing.title || locations.get(listing.location_id).address)) throw new Error('Imported detail title differs from planned content');
          if (kind === 'photo') await page.waitForFunction(() => {
            const layer = document.querySelector('#display-photos .photo-layer:not([aria-hidden=true])');
            const image = layer?.querySelector('img');
            return image?.complete && image.naturalWidth > 0 && getComputedStyle(layer).opacity === '1';
          });
          await page.screenshot({ path:resolve(dir,`${name}-${area}-${kind}.png`) });
          if (kind === 'photo' && firstApprovedPhotos(plan, listing.id).length > 1) {
            await page.getByRole('button',{name:'Next photo',exact:true}).click();
            await page.waitForFunction(() => {
              const host = document.querySelector('#display-photos');
              const layer = host.querySelector('.photo-layer:not([aria-hidden=true])');
              return host.getAttribute('aria-busy') === 'false' && host.textContent.includes('Photo 2 of') && layer && getComputedStyle(layer).opacity === '1';
            });
            await page.screenshot({path:resolve(dir,`${name}-${area}-photo-next.png`)});
          }
          await page.locator('#detail-close').click();
          await page.locator('#selection[hidden]').waitFor({state:'attached'});
        }
        results.push({ browser:name, neighborhood:area, pins:expected.length,clusterInspection });
      }
    } finally { await browser.close(); }
  }
  return results;
}

function firstApprovedPhotos(plan, listingId) {
  return plan.photos.filter(photo => photo.listing_id === listingId && photo.status === 'approved');
}

export async function rehearse({ input, publicSnapshot, output, captures = false, serve = false }) {
  output = resolve(output);
  if (under(root, output)) throw new TypeError('Private rehearsal output must be outside the repository');
  await mkdir(dirname(output), { recursive:true, mode:0o700 });
  output = resolve(await realpath(dirname(output)), basename(output));
  if (under(root, output)) throw new TypeError('Private rehearsal output must not resolve into the repository');
  await mkdir(output, { mode:0o700 }); // Refuse to overwrite or reuse a run.
  let service, preview;
  const report = { status:'preflight', mode:'isolated-local', productionWrites:0, startedAtUtc:new Date().toISOString() };
  try {
    const bundle = publicSnapshot ? await loadPublicPilotSnapshot(publicSnapshot) : await loadBundle(input);
    if (!Array.isArray(bundle.records) || bundle.records.length < 1 || bundle.records.length > 50 || !seasonFor(bundle.previewSeason) || !bundle.sourceSystem) throw new TypeError('Pilot requires 1–50 records, explicit sourceSystem, and a supported previewSeason');
    const assetManifest = { assets:bundle.assets.map(({bytes, ...asset}) => asset) };
    const options = { sourceSystem:bundle.sourceSystem, assetManifest, locationManifest:bundle.locationManifest || {},
      timestampUnit:bundle.timestampUnit || 'milliseconds', seasonMappings:bundle.seasonMappings || {}, now:Date.now() };
    report.source = bundle.evidence;
    report.previewSeason = bundle.previewSeason;
    report.sourceRecords = bundle.records.length;
    report.sourcePhotoAssets = bundle.assets.length;
    report.placementIssues = bundle.records.map(record => checkLocation(record, options.locationManifest, bundle.previewSeason)).filter(Boolean);
    const blocked = new Set(report.placementIssues.map(issue => issue.sourceId));
    const eligible = bundle.records.filter(record => !blocked.has(record.id));
    report.eligibleRecords = eligible.length;
    report.eligibleSourceIds = eligible.map(record => record.id);
    if (!eligible.length) throw new TypeError('No records have eligible target placement');
    const fullPlan = planFtwImport({ ...options, records:bundle.records });
    await privateJson(resolve(output,'full-dry-run.json'), {kind:'dry-run-only',placementIssues:report.placementIssues,
      fullSelectionApprovedForApply:report.placementIssues.length===0 && fullPlan.conflicts.length===0,plan:fullPlan});
    if (fullPlan.conflicts.length) throw new TypeError('Source planning conflicts require review before selecting a pilot');
    const first = planFtwImport({ ...options, records:eligible });
    if (first.listings.some(row => row.season_id !== bundle.previewSeason)) throw new TypeError('Pilot must preserve a single explicit preview season');
    await privateJson(resolve(output,'eligible-plan.json'), first);
    await privateJson(resolve(output,'source-evidence.json'), bundle.evidence);
    await privateJson(resolve(output,'location-manifest.json'), options.locationManifest);
    const usedKeys = new Set(first.photos.map(photo => photo.object_key));
    const assets = bundle.assets.filter(asset => usedKeys.has(asset.objectKey));
    const assetDir = resolve(output,'assets'); await mkdir(assetDir,{mode:0o700});
    for (const asset of assets) await writeFile(resolve(assetDir,`${hash(asset.bytes)}.image`),asset.bytes,{mode:0o600});
    await privateJson(resolve(output,'asset-manifest.json'),{assets:assets.map(({bytes,...asset})=>({...asset,localFile:`assets/${hash(bytes)}.image`}))});
    service = await createTestService({ persistPath:resolve(output,'local-state'), activeSeason:bundle.previewSeason });
    report.before = await counts(service);
    report.firstApply = await applyFtwPilotPlan({mode:'isolated-local',db:service.db,bucket:service.bucket,plan:first,assets:assets.map(asset=>({objectKey:asset.objectKey,bytes:asset.bytes}))});
    report.afterFirst = await counts(service);
    report.publicRoutes = await verifyPublic(service,first);
    const target = await readFtwPilotTarget(service.db);
    const replay = planFtwImport({...options,records:eligible,...target});
    await privateJson(resolve(output,'replay-plan.json'),replay);
    report.replay = await applyFtwPilotPlan({mode:'isolated-local',db:service.db,bucket:service.bucket,plan:replay,assets:[]});
    report.afterReplay = await counts(service);
    if (report.replay.action !== 'skip' || JSON.stringify(report.afterFirst)!==JSON.stringify(report.afterReplay)) throw new Error('Rehearsal rerun changed target data');
    await service.dispose(); service = null;
    service = await createTestService({ persistPath:resolve(output,'local-state'), activeSeason:bundle.previewSeason });
    report.afterRestart = await counts(service);
    if (JSON.stringify(report.afterFirst)!==JSON.stringify(report.afterRestart)) throw new Error('Imported data did not survive local runtime restart');
    await verifyPublic(service,first);
    if (captures || serve) { preview = await previewServer(service); report.privatePreviewOrigin = preview.origin; }
    if (captures) report.browserChecks = await capture(service,first,output,preview.origin);
    report.status = 'passed'; report.finishedAtUtc = new Date().toISOString();
    await privateJson(resolve(output,'report.json'),report);
    await writeFile(resolve(output,'report.md'),`# Isolated FTW migration rehearsal\n\nStatus: ${report.status}. Production writes: 0.\n\n${report.sourceRecords} real source records inspected; ${report.eligibleRecords} imported into local D1. ${report.placementIssues.length} placement issues retained for review. ${assets.length} photos copied into private local R2. Exact replay: ${report.replay.action}; counts unchanged after runtime restart.\n\nSource scope: ${bundle.evidence.scope}. ${bundle.evidence.limitation || ''}\n\nPreview season: ${bundle.previewSeason}. The source season was not changed to Christmas.\n\nDetailed source IDs, exceptions, plans, manifests and render evidence remain private in this output directory.\n`,{mode:0o600});
    console.log(json({ status:report.status,output,sourceRecords:report.sourceRecords,importedRecords:report.eligibleRecords,placementIssues:report.placementIssues.length,photos:assets.length,replay:report.replay.action,persistedAfterRestart:true,productionWrites:0,...(serve?{preview:preview.origin}:{}) }).trim());
    if (serve) { await new Promise(accept => { process.once('SIGINT',accept); process.once('SIGTERM',accept); }); }
    return report;
  } catch (error) {
    report.status = 'failed'; report.error = error.message;
    await privateJson(resolve(output,'report.json'),report);
    throw error;
  } finally {
    if (preview) await new Promise(accept=>preview.server.close(accept));
    if (service) await service.dispose();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), options = {};
  for (let i=0;i<args.length;i++) {
    if (args[i] === '--capture') options.captures = true;
    else if (args[i] === '--serve') options.serve = true;
    else if (['--input','--public-snapshot','--output'].includes(args[i])) {
      const key = {'--input':'input','--public-snapshot':'publicSnapshot','--output':'output'}[args[i]];
      options[key] = args[++i];
    } else throw new TypeError(`Unknown option: ${args[i]}`);
  }
  if (!options.output || Boolean(options.input) === Boolean(options.publicSnapshot)) throw new TypeError('Usage: node scripts/rehearse-ftw-import.mjs (--input BUNDLE.json | --public-snapshot DIRECTORY) --output NEW_PRIVATE_DIRECTORY [--capture] [--serve]');
  try { await rehearse(options); } catch (error) { console.error(error.message); process.exitCode=1; }
}
