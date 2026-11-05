import {test,expect} from '@playwright/test';
const path='/prototypes/discovery-map/index.html';
const one={id:'listing-a',address:'100 Main St',title:'A lantern-lit porch',description:'A published display description.',latitude:27.7885,longitude:-82.6396,tags:['Lights'],photos:[]};
const two={...one,id:'listing-b',address:'200 Main St',latitude:27.7898,longitude:-82.644};
async function feeds(page,callback){await page.route('**/api/listings?**',async route=>{
  const url=new URL(route.request().url()),id=url.searchParams.get('neighborhood'),season=url.searchParams.get('season');
  const response=await callback?.(id,season);
  if(response?.status){await route.fulfill({status:response.status,json:{error:{message:'Unavailable'}}});return;}
  await route.fulfill({json:{listings:response?.listings||(season==='halloween-2026'?(id==='old-northeast'?[one]:id==='crescent-lake'?[two]:[]):[])}});
});}
async function open(page,query=''){await page.goto(path+query);await expect(page.locator('body')).toHaveAttribute('data-ready','true');}
async function settled(page){await expect(page.locator('body')).toHaveAttribute('data-feeds','ready');}
async function search(page,value){await page.locator('#open-search').click();await page.locator('#search-input').fill(value);}

test('St Pete opens as a full screen map and zooms out to the entire county',async({page})=>{
  await feeds(page);await open(page);await settled(page);
  const initial=await page.evaluate(()=>discoveryMap.camera());expect(initial.zoom).toBeGreaterThan(13);
  await page.locator('#all-pinellas').click();
  await expect.poll(()=>page.evaluate(()=>discoveryMap.camera().zoom)).toBeLessThan(12);
  await expect(page.locator('#coverage-text')).toHaveText('94 neighborhood maps · zoom in for displays');
  expect(await page.locator('#map').evaluate(node=>node.clientHeight===innerHeight)).toBe(true);
  await page.locator('#map').focus();await page.keyboard.press('-');
  await expect.poll(()=>page.evaluate(()=>discoveryMap.camera().zoom)).toBeLessThan(initial.zoom-1);
});
test('county city and neighborhood search retain a continuous camera and expose an honest empty feed',async({page})=>{
  await feeds(page);await open(page);
  await search(page,'All Pinellas');
  await page.locator('[data-result=county]').click();
  await search(page,'Greenbriar');await page.locator('[data-result=greenbriar-cdp]').click();
  await expect(page.locator('#place-title')).toHaveText('Greenbriar');
  await expect(page.locator('#place-status')).toContainText('No published Halloween 2026 displays');
  await expect(page.locator('#place-art')).toHaveAttribute('href','/?neighborhood=greenbriar-cdp&season=halloween-2026');
  await page.locator('#close-place').click();
  await search(page,'St Pete');await page.locator('#search-input').press('Enter');
  await expect.poll(()=>page.evaluate(()=>discoveryMap.camera().lat)).toBeCloseTo(27.773,2);
  expect(await page.locator('#map').count()).toBe(1);
});
test('a selected display has full content and closes without moving the camera',async({page})=>{
  await feeds(page);await open(page,'?neighborhood=old-northeast&listing=listing-a');
  await expect(page.locator('#selection')).toBeVisible();
  await expect(page.locator('#detail-title')).toHaveText(one.title);await expect(page.locator('#detail-address')).toHaveText(one.address);
  await expect(page.locator('#detail-season')).toHaveText('Past season · Halloween 2026');
  await expect(page.locator('#selected-note')).toHaveText(one.description);
  await expect(page.locator('#existing-detail')).toHaveAttribute('href','/?neighborhood=old-northeast&season=halloween-2026&listing=listing-a');
  const selected=await page.evaluate(()=>discoveryMap.camera());await page.locator('#detail-close').click();
  await expect(page.locator('#selection')).toBeHidden();
  const closed=await page.evaluate(()=>discoveryMap.camera());expect(closed).toEqual(selected);
  await expect(page).not.toHaveURL(/listing=/);
});
test('coincident display clusters expose each record at the closest zoom',async({page})=>{
  await feeds(page,id=>id==='old-northeast'?{listings:Array.from({length:7},(_,i)=>({...one,id:'coincident-'+i,title:'House '+i}))}:{listings:[]});
  await open(page,'?lat=27.7885&lng=-82.6396&z=17.5');await settled(page);
  await page.getByRole('button',{name:'7 published displays. Explore displays here'}).click();
  await expect(page.locator('#search-title')).toHaveText('Displays at this spot');await expect(page.locator('.search-result')).toHaveCount(7);
  await page.getByRole('button',{name:/House 6/}).click();
  await expect(page.locator('#detail-title')).toHaveText('House 6');
  await expect(page).toHaveURL(/listing=coincident-6/);
});
test('unavailable feeds remain unknown and retry recovers actual records',async({page})=>{
  let failed=true;await feeds(page,id=>id==='old-northeast'?(failed?{status:503}:{listings:[one]}):{listings:[]});
  await open(page);await expect(page.locator('body')).toHaveAttribute('data-feeds','partial');
  await expect(page.locator('#coverage-text')).toContainText('some areas unavailable');
  failed=false;await page.locator('#coverage').click();await page.locator('#retry-feeds').click();await page.locator('#close-about').click();await settled(page);
  expect(await page.evaluate(()=>discoveryMap.diagnostics().records.some(r=>r.id==='listing-a'))).toBe(true);
});
test('season changes cannot retain historical records or a selected card',async({page})=>{
  await feeds(page);await open(page,'?neighborhood=old-northeast&listing=listing-a');await expect(page.locator('#selection')).toBeVisible();
  await page.locator('#detail-close').click();await page.locator('#coverage').click();await page.locator('#season-select').selectOption('christmas-2026');await settled(page);
  await expect(page.locator('#selection')).toBeHidden();expect(await page.evaluate(()=>discoveryMap.diagnostics().records.length)).toBe(0);
  await expect(page.locator('#coverage-text')).toContainText('Christmas 2026');await expect(page).toHaveURL(/season=christmas-2026/);
});
for(const viewport of [{width:390,height:650},{width:320,height:568},{width:667,height:375}])test(`mobile map and selected display stay reachable at ${viewport.width}×${viewport.height}`,async({page})=>{
  await page.setViewportSize(viewport);await feeds(page);await open(page,'?neighborhood=old-northeast&listing=listing-a');
  await expect(page.locator('#selection')).toBeVisible();
  for(const selector of ['#detail-close','#directions','#detail-share','#existing-detail','#open-search'])await expect(page.locator(selector)).toBeInViewport({ratio:1});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await expect.poll(()=>page.locator('.display-button.is-selected').evaluateAll(nodes=>nodes.some(node=>{
    const r=node.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return node.contains(hit);
  }))).toBe(true);
  await page.locator('#detail-close').click();await page.locator('#all-pinellas').click();
  await expect(page.locator('#coverage-text')).toContainText('94 neighborhood maps');
  await search(page,'Crescent');await expect(page.locator('[data-result=crescent-lake]')).toBeInViewport({ratio:1});
});
test('search history restores county then closes selection without inventing camera steps',async({page})=>{
  await feeds(page);await open(page);await page.locator('#all-pinellas').click();
  await search(page,'Old Northeast');await page.locator('[data-result=old-northeast]').click();
  await expect(page.locator('#place-card')).toBeVisible();await page.goBack();
  await expect(page.locator('#place-card')).toBeHidden();await expect.poll(()=>page.evaluate(()=>discoveryMap.camera().zoom)).toBeLessThan(12);
});
test('the county fits inside short landscape and normal phone viewports',async({page})=>{
  await feeds(page);
  for(const viewport of [{width:390,height:650},{width:320,height:568},{width:667,height:375}]){
    await page.setViewportSize(viewport);await open(page);await page.locator('#all-pinellas').click();
    const corners=await page.evaluate(()=>discoveryMap.diagnostics().countyCorners);
    for(const p of corners){expect(p.x).toBeGreaterThanOrEqual(0);expect(p.x).toBeLessThanOrEqual(viewport.width);expect(p.y).toBeGreaterThanOrEqual(65);expect(p.y).toBeLessThanOrEqual(viewport.height-20);}
  }
});
test('published photo IDs with underscores work and pending or remote photos never load',async({page})=>{
  const requested=[];page.on('request',request=>{if(request.url().includes('/api/photos/'))requested.push(new URL(request.url()).pathname);});
  await page.route('**/api/photos/**',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#614c73"/></svg>'}));
  await feeds(page,id=>({listings:id==='old-northeast'?[{...one,photos:[{url:'/api/photos/photo_approved_1'},{url:'/api/photos/photo_approved_2'},{url:'/api/photos/photo_pending',status:'pending'},{url:'https://other.test/api/photos/photo_remote'}]}]:[]}));
  await open(page,'?neighborhood=old-northeast&listing=listing-a');
  await expect(page.locator('#display-photos img').first()).toHaveJSProperty('naturalWidth',600);
  await expect(page.locator('#display-photos .photo-count')).toHaveText('Photo 1 of 2');
  const count=await page.locator('#display-photos .photo-count').boundingBox(),close=await page.locator('#detail-close').boundingBox();
  expect(Math.max(0,Math.min(count.x+count.width,close.x+close.width)-Math.max(count.x,close.x))*Math.max(0,Math.min(count.y+count.height,close.y+close.height)-Math.max(count.y,close.y))).toBe(0);
  await page.getByRole('button',{name:'Next photo',exact:true}).click();await expect(page.locator('#display-photos .photo-count')).toHaveText('Photo 2 of 2');
  expect(requested.some(path=>path.includes('pending')||path.includes('remote'))).toBe(false);
});
test('leaving a pending display deep link cannot reopen the old record after navigation',async({page})=>{
  let release;const wait=new Promise(resolve=>{release=resolve;});
  await feeds(page,async id=>{if(id==='old-northeast'){await wait;return {listings:[one]};}return {listings:[]};});
  await open(page,'?neighborhood=old-northeast&listing=listing-a');
  await page.locator('#all-pinellas').click();release();
  await expect(page.locator('#selection')).toBeHidden();
  await page.waitForTimeout(160);await expect(page.locator('#selection')).toBeHidden();await expect(page).not.toHaveURL(/listing=/);
});
