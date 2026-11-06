import {test,expect} from '@playwright/test';
const atlas='/prototypes/neighborhood-atlas/index.html';
const display={id:'atlas-house',address:'143 17th Ave N',title:'Neighborhood lights',description:'A published display.',latitude:27.78878705,longitude:-82.63538294,tags:['Lights'],photos:[{url:'/api/photos/atlas-photo'}]};
async function service(page){
  await page.route('**/api/config',route=>route.fulfill({json:{available:true,season:{id:'christmas-2026',name:'Christmas 2026'},limits:{photos:3,maxPhotoBytes:2097152}}}));
  await page.route('**/api/listings?**',route=>route.fulfill({json:{listings:new URL(route.request().url()).searchParams.get('neighborhood')==='old-northeast'?[display]:[]}}));
  await page.route('**/api/photos/atlas-photo',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#c2b3d1"/></svg>'}));
}
async function open(page){await service(page);await page.goto(atlas);await expect(page.locator('body')).toHaveAttribute('data-ready','true');}
async function localReady(page,name){await expect(page.locator('#neighborhood-name')).toHaveText(name);await expect(page.locator('#map')).toHaveAttribute('aria-busy','false');}

test('overview presents two broad neighborhood areas with no address pins or preview panes',async({page})=>{
  await open(page);
  await expect(page.locator('.area-name')).toHaveCount(2);
  await expect(page.locator('.map-pin,.display-button,#place-card')).toHaveCount(0);
  for(const area of await page.locator('#atlas path.leaflet-interactive').all()){
    const box=await area.boundingBox();expect(box.width).toBeGreaterThan(44);expect(box.height).toBeGreaterThan(44);
  }
  await expect(page.locator('.scope')).toContainText('approximate');
});
test('one neighborhood tap opens the original local artwork with a clear return link',async({page})=>{
  await open(page);await page.getByRole('link',{name:'Explore Old Northeast illustrated map',exact:true}).click();await localReady(page,'Old Northeast');
  await expect(page.locator('#map img.leaflet-image-layer')).toHaveAttribute('src',/\/assets\/old-northeast\.webp$/);
  await expect(page.getByRole('link',{name:'← Explore nearby',exact:true})).toBeVisible();
  await expect(page.locator('.references')).toBeHidden();await expect(page.locator('footer')).toBeHidden();
  await expect(page.locator('#sample-count')).toHaveText('Past season · Halloween 2026');
  await expect(page.locator('#selection')).toBeHidden();
});
test('Explore nearby and browser Back restore the same atlas camera',async({page})=>{
  await open(page);await page.locator('#atlas').focus();await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(350);
  const camera=await page.evaluate(()=>neighborhoodAtlas.camera());
  await page.getByRole('link',{name:'Explore Old Northeast illustrated map',exact:true}).click();await localReady(page,'Old Northeast');
  await page.getByRole('link',{name:'← Explore nearby',exact:true}).click();await expect(page.locator('body')).toHaveAttribute('data-ready','true');
  const returned=await page.evaluate(()=>neighborhoodAtlas.camera());expect(returned.zoom).toBe(camera.zoom);expect(returned.lat).toBeCloseTo(camera.lat,5);expect(returned.lng).toBeCloseTo(camera.lng,5);
  await page.getByRole('link',{name:'Explore Crescent Lake illustrated map',exact:true}).click();await localReady(page,'Crescent Lake');
  await expect(page.locator('#map img.leaflet-image-layer')).toHaveAttribute('src',/\/assets\/crescent-lake\.webp$/);
  await page.goBack();await expect(page.locator('body')).toHaveAttribute('data-ready','true');
  expect((await page.evaluate(()=>neighborhoodAtlas.camera())).zoom).toBe(camera.zoom);
});
test('the existing display and approved photo card work inside the illustrated local map',async({page})=>{
  await open(page);await page.getByRole('link',{name:'Explore Old Northeast illustrated map',exact:true}).click();await localReady(page,'Old Northeast');
  await page.locator('[data-pin=atlas-house]').click();
  await expect(page.locator('#detail-title')).toHaveText('Neighborhood lights');await expect(page.locator('#display-photos img').first()).toHaveJSProperty('naturalWidth',600);
  await expect(page.getByRole('link',{name:'← Explore nearby',exact:true})).toBeVisible();
  await page.locator('#detail-close').click();await expect(page.locator('#selection')).toBeHidden();await expect(page.locator('#neighborhood-name')).toHaveText('Old Northeast');
});
test('overlapping display targets choose the nearest point and keyboard keeps its own identity',async({page})=>{
  await open(page);
  await page.unroute('**/api/listings?**');
  await page.route('**/api/listings?**',route=>route.fulfill({json:{listings:[display,{...display,id:'next-house',title:'Next house',latitude:27.78870254,longitude:-82.6340216},{...display,id:'third-house',title:'Third house',latitude:27.78922723,longitude:-82.63476693}]}}));
  await page.getByRole('link',{name:'Explore Old Northeast illustrated map',exact:true}).click();await localReady(page,'Old Northeast');
  const button=page.locator('[data-pin=atlas-house]'),point=await button.boundingBox();await page.mouse.click(point.x+point.width/2,point.y+point.height/2);
  await expect(page.locator('#detail-title')).toHaveText('Neighborhood lights');await page.locator('#detail-close').click();
  await page.locator('[data-pin=third-house]').focus();await page.keyboard.press('Enter');await expect(page.locator('#detail-title')).toHaveText('Third house');
});
test('phone local navigation and art stay visible without a below-map panel',async({page})=>{
  await page.setViewportSize({width:320,height:568});await open(page);await page.getByRole('link',{name:'Explore Crescent Lake illustrated map',exact:true}).click();await localReady(page,'Crescent Lake');
  await expect(page.getByRole('link',{name:'← Explore nearby',exact:true})).toBeInViewport({ratio:1});
  await expect(page.locator('#neighborhood-name')).toBeInViewport({ratio:1});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.body.scrollHeight<=innerHeight+1)).toBe(true);
});
test('atlas chrome is opt in and invalid return coordinates cannot change its destination',async({page})=>{
  await service(page);await page.goto('/?neighborhood=old-northeast&season=halloween-2026');await localReady(page,'Old Northeast');
  await expect(page.locator('body')).not.toHaveAttribute('data-atlas');await expect(page.locator('#add-display')).toBeHidden();
  await page.goto('/?neighborhood=old-northeast&season=halloween-2026&atlas=1&atlas_lat=bad&atlas_lng=-82.6&atlas_z=999');await localReady(page,'Old Northeast');
  await expect(page.getByRole('link',{name:'← Explore nearby',exact:true})).toHaveAttribute('href','/prototypes/neighborhood-atlas/index.html?season=halloween-2026');
});
