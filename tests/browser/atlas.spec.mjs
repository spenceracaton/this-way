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
 await expect(page.locator('#atlas-results [data-place]')).toHaveCount(2);
});
test('narrow county choices and map tools do not overlap and have touch targets',async({page})=>{
 await page.setViewportSize({width:320,height:568});await open(page);
 await expect.poll(async()=>{
  const boxes=await page.locator('#map-markers .region-marker').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};}));
  let overlap=0;for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){const a=boxes[i],b=boxes[j];overlap+=Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));}
  return overlap;
 }).toBe(0);
 for(const button of await page.locator('.map-tools button').all()){const rect=await button.boundingBox();expect(rect.width).toBeGreaterThanOrEqual(44);expect(rect.height).toBeGreaterThanOrEqual(44);}
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
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
