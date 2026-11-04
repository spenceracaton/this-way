import {test,expect} from '@playwright/test';
const atlas='/prototypes/pinellas-atlas/index.html';
const open=async(page,query='')=>{await page.goto(atlas+query);await expect(page.locator('body')).toHaveAttribute('data-ready','true');};
test('county regions drill down to real neighborhood maps and retain browser history',async({page})=>{
 await open(page);
 await expect(page.locator('#map-markers .region-marker')).toHaveCount(4);
 await page.locator('#map-markers [data-region="south"]').click();
 await expect(page.locator('#panel-title')).toHaveText('St. Petersburg & South');
 await page.locator('#atlas-search').fill('Old Northeast');
 await page.locator('#atlas-results [data-place="old-northeast"]').click();
 await expect(page.locator('#panel-title')).toHaveText('Old Northeast');
 await expect(page.locator('.preview-image img')).toHaveAttribute('src','/assets/old-northeast.webp');
 await expect(page.locator('.preview-credit')).toContainText('OpenStreetMap');
 await expect(page.locator('.open-map')).toHaveAttribute('href','/?neighborhood=old-northeast&season=halloween-2026');
 await expect(page.locator('.open-map')).toHaveAttribute('target','_blank');
 await page.goBack();await expect(page.locator('#panel-title')).toHaveText('St. Petersburg & South');
 await page.goBack();await expect(page.locator('#map-markers .region-marker')).toHaveCount(4);
});
test('county search spans regions and unknown places safely open the overview',async({page})=>{
 await open(page,'?region=constructor&place=not-a-map');
 await expect(page.locator('#map-markers .region-marker')).toHaveCount(4);
 await page.locator('#atlas-search').fill('Belleair Beach');
 await page.locator('#atlas-results [data-place="belleair-beach-place"]').click();
 await expect(page.locator('#panel-title')).toHaveText('Belleair Beach');
 await expect(page).toHaveURL(/region=coast/);
 await page.locator('#panel-back').click();
 await expect(page.locator('#atlas-search')).toHaveValue('Belleair Beach');
 await expect(page.locator('#atlas-results [data-place]')).toHaveCount(1);
 await page.locator('.clear-search').click();
 await expect(page.locator('.region-row')).toHaveCount(4);
});
for(const viewport of [{width:390,height:650},{width:375,height:600},{width:320,height:568}]){
test(`mobile discovery fits the first ${viewport.width}x${viewport.height} screen`,async({page})=>{
 await page.setViewportSize(viewport);await open(page);
 const search=page.locator('#atlas-search');
 await expect(search).toBeInViewport({ratio:1});
 const map=await page.locator('.map-surface').boundingBox();
 const searchBox=await search.boundingBox();
 expect(searchBox.y+searchBox.height).toBeLessThan(map.y);
 for(const choice of await page.locator('.region-row').all()){
  await expect(choice).toBeInViewport({ratio:1});
  const box=await choice.boundingBox();expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.y+box.height).toBeLessThanOrEqual(viewport.height-12);
 }
 await expect.poll(async()=>{
  const boxes=await page.locator('#map-markers .region-marker').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};}));
  let overlap=0;for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){const a=boxes[i],b=boxes[j];overlap+=Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));}
  return overlap;
 }).toBe(0);
 let covered=0;
 for(const button of await page.locator('.region-marker').all()){
  const rect=await button.boundingBox();expect(rect.width).toBeGreaterThanOrEqual(44);expect(rect.height).toBeGreaterThanOrEqual(44);covered+=rect.width*rect.height;
 }
 expect(covered/(map.width*map.height)).toBeLessThan(.18);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
}
test('mobile search and preview actions stay visible and back restores the query',async({page})=>{
 await page.setViewportSize({width:320,height:568});await open(page);
 await page.locator('#atlas-search').fill('Old Northeast');
 await expect(page.locator('.map-stage')).toBeHidden();
 const result=page.locator('#atlas-results [data-place="old-northeast"]');
 await expect(result).toBeInViewport({ratio:1});await result.click();
 await expect(page.locator('.map-stage')).toBeHidden();
 await expect(page.locator('.open-map')).toBeInViewport({ratio:1});
 await page.locator('#panel-back').click();
 await expect(page.locator('#atlas-search')).toHaveValue('Old Northeast');
 await expect(result).toBeInViewport({ratio:1});
 await page.locator('.clear-search').click();await expect(page.locator('.map-stage')).toBeVisible();
});
test('every mobile region exposes its prepared maps as tappable pins',async({page})=>{
 await page.setViewportSize({width:320,height:568});
 const data=await (await page.request.get('/prototypes/pinellas-atlas/atlas-data.json')).json();
 for(const region of ['north','central','south','coast']){
  await open(page,'?region='+region);
  const markers=page.locator('#map-markers .place-marker');
  await expect.poll(()=>markers.count()).toBeGreaterThan(0);
  const expected=data.neighborhoods.filter(place=>place.region===region).length;
  await expect.poll(()=>markers.evaluateAll(nodes=>nodes.reduce((sum,node)=>sum+Number(node.getAttribute('aria-label').match(/^(\d+) nearby/)?.[1]||1),0))).toBe(expected);
  for(const marker of await markers.all())await expect(marker).toBeInViewport({ratio:1});
  const first=markers.first();let id=await first.getAttribute('data-place');await first.click();
  if(!id){const result=page.locator('.neighborhood-row').first();id=await result.getAttribute('data-place');await result.click();}
  await expect(page.locator('body')).toHaveAttribute('data-view','preview');
  await expect(page.locator('.open-map')).toHaveAttribute('href','/?neighborhood='+id+'&season=halloween-2026');
  await expect.poll(()=>page.locator('.preview-image img').evaluate(img=>img.naturalWidth)).toBeGreaterThan(0);
  await page.locator('#panel-back').click();await expect(page.locator('body')).toHaveAttribute('data-view','region');
 }
});
test('mobile region list uses page scrolling and explicitly reveals more maps',async({page})=>{
 await page.setViewportSize({width:390,height:844});await open(page,'?region=south');
 await expect(page.locator('.neighborhood-row')).toHaveCount(6);
 expect(await page.locator('.neighborhood-list').evaluate(node=>getComputedStyle(node).overflowY)).toBe('visible');
 await page.getByRole('button',{name:/Show 6 more neighborhoods/}).click();
 await expect(page.locator('.neighborhood-row')).toHaveCount(12);
 await page.locator('#atlas-search').fill('Crescent Lake');
 await page.locator('#atlas-results [data-place="crescent-lake"]').click();
 await expect(page.locator('#panel-title')).toHaveText('Crescent Lake');
 await expect(page.locator('.open-map')).toHaveAttribute('href',/neighborhood=crescent-lake/);
});
test('unavailable counts remain unknown instead of inventing an empty neighborhood',async({page})=>{
 await page.route('**/api/listings?**',route=>route.fulfill({status:503,body:'Unavailable'}));
 await open(page,'?place=old-northeast');
 await expect(page.locator('#preview-count')).toHaveText('Prepared neighborhood map');
});

test('city and St Pete search phrases suggest their regions while exact neighborhood Enter still wins',async({page})=>{
 await page.setViewportSize({width:390,height:650});await open(page);
 const search=page.getByRole('searchbox',{name:'Find a city or neighborhood'});
 await search.fill('Not a real Pinellas place');await search.press('Enter');
 await expect(page.locator('.list-empty')).toContainText('No city or neighborhood');
 await expect(page.locator('body')).toHaveAttribute('data-view','county');
 for(const [phrase,region] of [['Dunedin','north'],['St. Petersburg','south'],['SaintPetersburg','south'],['StPete','south']]){
  await search.fill(phrase);
  const suggestion=page.locator(`#region-suggestions [data-region="${region}"]`);
  await expect(suggestion).toBeVisible();
  await expect(suggestion).toContainText(region==='north'?'North Pinellas':'St. Petersburg & South');
  await search.press('Enter');
  await expect(page.locator('body')).toHaveAttribute('data-view','region');
  await expect(page).toHaveURL(new RegExp(`[?&]region=${region}(?:&|$)`));
  await expect(page.locator('#panel-title')).toHaveText(region==='north'?'North Pinellas':'St. Petersburg & South');
  await page.locator('#panel-back').click();
 }
 await search.fill('Old Northeast');
 await expect(page.locator('#atlas-results [data-place="old-northeast"]')).toBeVisible();
 await search.press('Enter');
 await expect(page.locator('body')).toHaveAttribute('data-view','preview');
 await expect(page.locator('#panel-title')).toHaveText('Old Northeast');
 await page.locator('#panel-back').click();
 await search.fill('Belleair Beach');
 await expect(page.locator('#region-suggestions [data-region="coast"]')).toBeVisible();
 await search.press('Enter');
 await expect(page.locator('#panel-title')).toHaveText('Belleair Beach');
 await expect(page.locator('body')).toHaveAttribute('data-view','preview');
 await page.locator('#panel-back').click();
 await search.fill('Pinellas');await search.press('Enter');
 await expect(page.locator('#region-suggestions [data-region]')).toHaveCount(4);
 await expect(page.locator('#region-suggestions [data-region]').first()).toBeFocused();
 await expect(page.locator('body')).toHaveAttribute('data-view','county');
});

test('every final mobile Show more batch keeps keyboard focus and announces the actual result total',async({page})=>{
 await page.setViewportSize({width:390,height:650});await open(page,'?region=south');
 await expect(page.locator('.list-heading')).toContainText('77 maps');
 let shown=6;
 while(shown<77){
  const more=page.locator('#atlas-more');
  await expect(more).toBeVisible();
  await more.focus();await page.keyboard.press('Enter');
  const previous=shown;shown=Math.min(shown+6,77);
  const firstNew=page.locator('.neighborhood-row').nth(previous);
  await expect(firstNew).toBeFocused();
  await expect(page.locator('.neighborhood-row')).toHaveCount(shown);
  if(shown<77)await expect(page.locator('#atlas-more')).toContainText(`${shown} of 77 shown`);
 }
 await expect(page.locator('#atlas-more')).toHaveCount(0);
 await expect(page.locator('#view-status')).toContainText('77');
 await expect(page.locator('#view-status')).not.toContainText('78');
 await expect(page.locator('body')).not.toBeFocused();
});

for(const viewport of [{width:390,height:650},{width:375,height:600},{width:320,height:568}]){
test(`mobile overview city labels remain legible and clear of region pins at ${viewport.width}x${viewport.height}`,async({page})=>{
 await page.setViewportSize(viewport);await open(page);
 await page.evaluate(()=>document.fonts.ready);
 await page.evaluate(()=>document.fonts.ready);
 const measurements=await page.locator('#city-labels text').evaluateAll(nodes=>{
  const map=document.querySelector('#map-surface').getBoundingClientRect();
  const pins=[...document.querySelectorAll('#map-markers .region-marker')].map(node=>node.getBoundingClientRect());
  return nodes.map(node=>{
   const r=node.getBBox(),m=node.getScreenCTM();
   const corners=[[r.x,r.y],[r.x+r.width,r.y],[r.x,r.y+r.height],[r.x+r.width,r.y+r.height]].map(([x,y])=>new DOMPoint(x,y).matrixTransform(m));
   const box={left:Math.min(...corners.map(p=>p.x)),right:Math.max(...corners.map(p=>p.x)),top:Math.min(...corners.map(p=>p.y)),bottom:Math.max(...corners.map(p=>p.y))};
   return {text:node.textContent,height:box.bottom-box.top,inside:box.left>=map.left&&box.right<=map.right&&box.top>=map.top&&box.bottom<=map.bottom,clear:pins.every(pin=>box.right<=pin.left||box.left>=pin.right||box.bottom<=pin.top||box.top>=pin.bottom)};
  });
 });
 expect(measurements.length).toBeGreaterThanOrEqual(3);
 for(const label of measurements){expect(label.height,`${label.text} glyph height`).toBeGreaterThanOrEqual(12);expect(label.inside,`${label.text} inside map`).toBe(true);expect(label.clear,`${label.text} overlaps a region marker`).toBe(true);}
});
}

test('desktop neighborhood preview retains its parent region extent and selected pin',async({page,isMobile})=>{
 test.skip(isMobile,'desktop map framing is checked in the desktop project');
 await open(page,'?region=south');
 const map=page.locator('#atlas-map');
 const parent=await map.getAttribute('viewBox');
 const [, ,width,height]=parent.split(/\s+/).map(Number);
 await page.locator('#atlas-search').fill('Old Northeast');
 await page.locator('#atlas-results [data-place="old-northeast"]').click();
 await expect(page.locator('#panel-title')).toHaveText('Old Northeast');
 await expect(page.locator('.open-map')).toHaveAttribute('href','/?neighborhood=old-northeast&season=halloween-2026');
 await page.waitForTimeout(500);
 const preview=await map.getAttribute('viewBox');
 const [, ,pwidth,pheight]=preview.split(/\s+/).map(Number);
 expect(pwidth/width).toBeGreaterThan(0.7);expect(pwidth/width).toBeLessThan(1.3);
 expect(pheight/height).toBeGreaterThan(0.7);expect(pheight/height).toBeLessThan(1.3);
 const marker=page.locator('#map-markers .place-marker.selected');
 await expect(marker).toBeVisible();
 const mapBox=await page.locator('#map-surface').boundingBox(),pinBox=await marker.boundingBox();
 expect(pinBox.x).toBeGreaterThanOrEqual(mapBox.x);expect(pinBox.y).toBeGreaterThanOrEqual(mapBox.y);
 expect(pinBox.x+pinBox.width).toBeLessThanOrEqual(mapBox.x+mapBox.width);expect(pinBox.y+pinBox.height).toBeLessThanOrEqual(mapBox.y+mapBox.height);
 await expect(page.locator('#city-labels text')).toContainText(['St. Petersburg']);
});

test('North Pinellas keeps a singular neighborhood-map announcement',async({page})=>{
 await open(page,'?region=north');
 await expect(page.locator('#view-status')).toHaveText('North Pinellas — 1 neighborhood map.');
 const status=await page.locator('#view-status').evaluate(node=>({position:getComputedStyle(node).position,clip:getComputedStyle(node).clip,width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height}));
 expect(status.position).toBe('absolute');expect(status.width).toBeLessThanOrEqual(1);expect(status.height).toBeLessThanOrEqual(1);expect(status.clip).not.toBe('auto');
});
