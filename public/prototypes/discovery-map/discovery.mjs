import {seasonFor} from '/season-config.mjs';
import {mountGallery} from '/gallery.mjs';
import {unobscuredPoint} from '../continuous-map/canvas-model.mjs';
import {countyBounds, cities, searchPlaces, clusterPoints, readCamera, publishedRecords, minimumOverviewZoom, streetDetailZoom} from './discovery-model.mjs';

const $=selector=>document.querySelector(selector);
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const query=new URLSearchParams(location.search);
let season=seasonFor(query.get('season')||'halloween-2026');
let map, places=[], sourceContext, tileManifest, selected=null, focused=null, gallery=null, locationLayer=null;
let activeFeeds=0, activeTiles=0, visibleAreas=[], feedOverflow=false, restore=false, noticeTimer, redrawTimer, selectionRequest=0;
const feeds=new Map(), tileStates=new Map();
const geographicLayers=[], neighborhoodLayers=L.layerGroup(), displayLayers=L.layerGroup(), labelLayers=L.layerGroup();
let geographyRenderer, localRoadLayer, tiledRoadLayer, visibleTileKey='';

async function json(path) {
  const response=await fetch(path,{signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error('Map resource unavailable');
  return response.json();
}
function notice(message) {
  clearTimeout(noticeTimer);$('#notice').textContent=message;$('#notice').hidden=false;
  noticeTimer=setTimeout(()=>{$('#notice').hidden=true;},6500);
}
const feedKey=id=>season.id+':'+id;
function records() {
  const result=new Map();
  for(const [key,feed] of feeds)if(key.startsWith(season.id+':')&&feed.state==='ready') {
    for(const record of feed.records)if(!result.has(record.id))result.set(record.id,record);
  }
  return [...result.values()];
}
function viewUrl() {
  const url=new URL(location.href), c=map.getCenter();
  url.searchParams.set('lat',c.lat.toFixed(5));url.searchParams.set('lng',c.lng.toFixed(5));url.searchParams.set('z',map.getZoom().toFixed(2));
  url.searchParams.set('season',season.id);
  if(selected){url.searchParams.set('listing',selected.id);url.searchParams.set('neighborhood',selected.neighborhoodId);}
  else if(focused){url.searchParams.delete('listing');url.searchParams.set('neighborhood',focused.id);}
  else{url.searchParams.delete('listing');url.searchParams.delete('neighborhood');}
  return url;
}
function writeUrl(push=false) {
  if(restore||!map)return;
  const url=viewUrl();history[push?'pushState':'replaceState'](null,'',url.pathname+url.search);
}
function existingUrl(place,listing) {
  const params=new URLSearchParams({neighborhood:place.id,season:season.id});
  if(listing)params.set('listing',listing.id);
  return '/?'+params;
}
function frameCounty(push=true) {
  dismiss(false);focused=null;
  const short=map.getSize().y<480;
  map.fitBounds(countyBounds,{paddingTopLeft:short?[24,75]:[24,125],paddingBottomRight:short?[55,30]:[55,65],maxZoom:11.75,animate:false});
  if(push)writeUrl(true);
}
function focusPlace(place,push=true) {
  dismiss(false);focused=place;
  const short=map.getSize().y<480;
  map.fitBounds(place.bounds,{paddingTopLeft:short?[24,80]:[30,115],paddingBottomRight:[60,75],maxZoom:15.75,animate:false});
  ensureFeed(place,true);if(push)writeUrl(true);settle();
  $('#map').focus({preventScroll:true});
}
function dismiss(update=true) {
  selectionRequest++;
  const prior=selected;
  selected=null;focused=null;gallery?.destroy();gallery=null;
  $('#selection').hidden=true;$('#display-photos').replaceChildren();
  delete document.body.dataset.card;document.documentElement.style.setProperty('--card-height','0px');
  if(update){renderMarkers();renderLabels();writeUrl();}
  return prior;
}
function selectRecord(record,update=true) {
  const hadSelection=Boolean(selected);
  dismiss(false);selected=record;
  $('#selection').hidden=false;document.body.dataset.card='display';
  $('#detail-area').textContent=record.neighborhood;
  $('#detail-title').textContent=record.title||record.address;
  $('#detail-address').textContent=record.title?record.address:'';
  $('#detail-season').textContent=(season.id==='halloween-2026'?'Past season · ':'')+season.name;
  $('#selected-note').textContent=record.description||'';
  $('#detail-tags').replaceChildren(...record.tags.map(tag=>{const li=document.createElement('li');li.textContent=tag;return li;}));
  $('#detail-tags').hidden=!record.tags.length;
  $('#directions').href='https://www.google.com/maps/dir/?api=1&destination='+encodeURIComponent(record.lat+','+record.lng);
  $('#existing-detail').href=existingUrl({id:record.neighborhoodId},record);
  $('#share-url').hidden=true;
  const host=$('#display-photos');host.hidden=!record.photos.length;
  if(record.photos.length)gallery=mountGallery(host,record.photos.map(url=>({url})),record.address);
  $('.house-body').scrollTop=0;
  renderMarkers();$('#detail-title').focus({preventScroll:true});
  requestAnimationFrame(()=>{revealSelected();if(update)writeUrl(!hadSelection);});
}
function obstacles() {
  return [...document.querySelectorAll('.topbar,.view-caption,.map-actions,.map-status,.leaflet-control-zoom,.leaflet-control-attribution,#selection')]
    .filter(el=>!el.hidden&&getComputedStyle(el).visibility!=='hidden')
    .map(el=>el.getBoundingClientRect()).filter(r=>r.width&&r.height);
}
function revealSelected() {
  if(!selected||!map)return;
  document.documentElement.style.setProperty('--card-height',$('#selection').offsetHeight+'px');
  const point=map.latLngToContainerPoint([selected.lat,selected.lng]);
  const clear=unobscuredPoint(point,map.getSize(),obstacles(),28);
  if(Math.hypot(clear.x-point.x,clear.y-point.y)>1)map.panBy([point.x-clear.x,point.y-clear.y],{animate:false});
  renderLabels();
}

function ensureFeed(place,priority=false,retry=false) {
  const key=feedKey(place.id), prior=feeds.get(key);
  if(prior&&!(retry&&prior.state==='error'))return;
  feeds.set(key,{state:'queued',place,season:season.id,priority});
  pumpFeeds();
}
function pumpFeeds() {
  const queue=[...feeds.entries()].filter(([key,f])=>f.state==='queued'&&key.startsWith(season.id+':'))
    .sort((a,b)=>Number(b[1].priority)-Number(a[1].priority));
  while(activeFeeds<4&&queue.length) {
    const [key,feed]=queue.shift();feed.state='loading';activeFeeds++;
    const params=new URLSearchParams({neighborhood:feed.place.id,season:feed.season});
    json('/api/listings?'+params).then(result=>{
      feed.records=publishedRecords(result.listings,feed.place,location.origin);feed.state='ready';
      if(key.startsWith(season.id+':')){
        if(selected?.neighborhoodId===feed.place.id){const next=feed.records.find(r=>r.id===selected.id);if(next)selectRecord(next,false);else dismiss();}
      }
    }).catch(()=>{feed.state='error';}).finally(()=>{
      activeFeeds--;pumpFeeds();renderMarkers();updateStatus();
    });
  }
  updateStatus();
}
function loadVisibleFeeds() {
  visibleAreas=[];feedOverflow=false;
  if(map.getZoom()<13){updateStatus();return;}
  const bounds=map.getBounds().pad(.12), center=map.getCenter();
  const areas=places.filter(place=>bounds.intersects(place.bounds))
    .sort((a,b)=>map.distance(center,[a.lat,a.lng])-map.distance(center,[b.lat,b.lng]));
  feedOverflow=areas.length>18;visibleAreas=areas.slice(0,18);
  if(focused&&!visibleAreas.some(p=>p.id===focused.id))visibleAreas.unshift(focused);
  for(const place of visibleAreas)ensureFeed(place);
  updateStatus();
}
function updateStatus() {
  if(!map||!season)return;
  const inView=records().filter(record=>map.getBounds().contains([record.lat,record.lng]));
  const checked=visibleAreas.filter(place=>feeds.get(feedKey(place.id))?.state==='ready').length;
  const failed=visibleAreas.filter(place=>feeds.get(feedKey(place.id))?.state==='error').length;
  const busy=visibleAreas.some(place=>['queued','loading'].includes(feeds.get(feedKey(place.id))?.state));
  const past=season.id==='halloween-2026'?'Past Halloween 2026':season.name;
  let text;
  if(map.getZoom()<13)text=`${places.length} neighborhood maps · zoom in for displays`;
  else if(busy)text=`${past} · checking nearby displays…`;
  else if(failed)text=`${past} · some areas unavailable · retry`;
  else text=`${past} · ${inView.length} ${inView.length===1?'display':'displays'} loaded`;
  $('#coverage-text').textContent=text;
  $('#map-status').dataset.state=failed?'partial':busy?'loading':'ready';
  $('#feed-detail').textContent=`${checked} of ${visibleAreas.length} nearby neighborhood feeds checked for ${season.name}. ${failed?`${failed} unavailable. `:''}${feedOverflow?'More areas enter view than this preview checks at once; zoom in to check the rest. ':''}These are not county-wide display totals.`;
  $('#retry-feeds').hidden=!failed&&!([...tileStates.values()].some(t=>t.state==='error'));
  document.body.dataset.feeds=busy?'loading':failed?'partial':'ready';
  document.body.dataset.displayCount=String(inView.length);
}

function point(item){return map.latLngToContainerPoint([item.lat,item.lng]);}
function addButton(group,layer,className,html,label,onClick) {
  const position=map.containerPointToLatLng([group.x,group.y]);
  const marker=L.marker(position,{keyboard:false,icon:L.divIcon({className,html,iconSize:className==='display-marker'?[44,44]:[0,0],iconAnchor:className==='display-marker'?[22,22]:[0,0]})}).addTo(layer);
  const button=marker.getElement().querySelector('button');button.setAttribute('aria-label',label);
  L.DomEvent.disableClickPropagation(button);L.DomEvent.disableScrollPropagation(button);
  button.addEventListener('click',event=>{event.stopPropagation();onClick(button);});
}
function openDisplayChoices(items) {
  $('#search-title').textContent='Displays at this spot';$('#search-input').hidden=true;
  $('#search-results').replaceChildren();
  for(const record of items){const button=document.createElement('button');button.type='button';button.className='search-result';
    button.innerHTML=`<span><strong>${esc(record.title||record.address)}</strong><small>${esc(record.address)} · ${esc(record.neighborhood)}</small></span><span aria-hidden="true">↗</span>`;
    button.onclick=()=>{$('#search-dialog').close();selectRecord(record);};$('#search-results').append(button);
  }
  $('#search-dialog').showModal();
}
function renderMarkers() {
  if(!map)return;
  const active=document.activeElement?.dataset.record;
  neighborhoodLayers.clearLayers();displayLayers.clearLayers();
  const zoom=map.getZoom(), viewport=map.getBounds().pad(.2);
  const available=zoom<streetDetailZoom?places.filter(p=>viewport.contains([p.lat,p.lng])):[];
  const inView=zoom>=13?records().filter(r=>viewport.contains([r.lat,r.lng])):[];
  const displayGroups=clusterPoints(inView,point,46);
  const preferredIds=new Set(zoom>=13&&zoom<15.5?inView.map(record=>record.neighborhoodId):[]);
  const preferred=available.filter(place=>preferredIds.has(place.id));
  const neighbors=clusterPoints(available.filter(place=>!preferredIds.has(place.id)),point,zoom<12.5?72:zoom<14?85:65);
  const blocks=obstacles();
  for(const pin of displayGroups)blocks.push({left:pin.x-27,right:pin.x+27,top:pin.y-27,bottom:pin.y+27});
  if(zoom<14)for(const city of cities){const p=point(city);blocks.push({left:p.x-city.name.length*4.2-5,right:p.x+city.name.length*4.2+5,top:p.y-15,bottom:p.y+15});}
  function placeGroup(group,width,height,move=false){
    const size=map.getSize(),offsets=move?[[0,0],[0,40],[0,-40],[42,0],[-42,0],[0,65],[0,-65]]:[[0,0]];
    for(const [dx,dy] of offsets){const x=group.x+dx,y=group.y+dy,box={left:x-width/2,right:x+width/2,top:y-height/2,bottom:y+height/2};
      if(box.left<6||box.right>size.x-6||box.top<6||box.bottom>size.y-6)continue;
      if(blocks.some(r=>box.left<r.right+5&&box.right>r.left-5&&box.top<r.bottom+5&&box.bottom>r.top-5))continue;
      blocks.push(box);return {...group,x,y};
    }
    return null;
  }
  for(const place of preferred){
    const p=point(place),placement=placeGroup({...p,items:[place]},100,46,true);if(!placement)continue;
    addButton(placement,neighborhoodLayers,'neighborhood-marker',`<button class="neighborhood-button single featured" type="button" data-place="${esc(place.id)}">${esc(place.name)}</button>`,`${place.name}, neighborhood map`,()=>focusPlace(place));
  }
  const countCap=zoom>=13?Math.max(3,Math.min(8,Math.floor(map.getSize().x*map.getSize().y/95000))):Infinity;
  let countBadges=0;
  const center=map.getSize().divideBy(2);
  neighbors.sort((a,b)=>Math.hypot(a.x-center.x,a.y-center.y)-Math.hypot(b.x-center.x,b.y-center.y));
  for(const group of neighbors){
    if(displayGroups.some(pin=>Math.hypot(pin.x-group.x,pin.y-group.y)<64))continue;
    if(group.items.length===1){const place=group.items[0],placement=placeGroup(group,Math.min(155,Math.max(65,place.name.length*5.6+12)),48);
      if(!placement)continue;
      addButton(placement,neighborhoodLayers,'neighborhood-marker',`<button class="neighborhood-button single" type="button" data-place="${esc(place.id)}">${esc(place.name)}</button>`,`${place.name}, neighborhood map`,()=>focusPlace(place));
    }else{
      if(countBadges>=countCap)continue;
      const placement=placeGroup(group,85,46,true);if(!placement)continue;
      countBadges++;
      addButton(placement,neighborhoodLayers,'neighborhood-marker',`<button class="neighborhood-button" type="button"><strong>${group.items.length}</strong><small>neighborhoods</small></button>`,`${group.items.length} neighborhood maps. Zoom in to explore`,()=>{
        dismiss(false);map.fitBounds(group.items.map(p=>[p.lat,p.lng]),{paddingTopLeft:[30,135],paddingBottomRight:[65,90],maxZoom:Math.max(zoom+1,15.5),animate:false});writeUrl(true);
      });
    }
  }
  for(const group of displayGroups){
    const chosen=group.items.find(record=>record.id===selected?.id), record=chosen||group.items[0];
    const multiple=group.items.length>1;
    addButton(group,displayLayers,'display-marker',`<button class="display-button ${multiple?'cluster':''} ${chosen?'is-selected':''}" type="button" data-record="${esc(record.id)}"><span>${multiple?group.items.length:'●'}</span></button>`,multiple?`${group.items.length} published displays. Explore displays here`:`${record.title?record.title+', ':''}${record.address}, ${record.neighborhood}`,()=>{
      if(!multiple){selectRecord(record);return;}
      if(zoom>=17){openDisplayChoices(group.items);return;}
      dismiss(false);map.fitBounds(group.items.map(r=>[r.lat,r.lng]),{paddingTopLeft:[35,135],paddingBottomRight:[70,90],maxZoom:17.5,animate:false});writeUrl();
    });
  }
  // Source markers keep exact coordinates after grouping is no longer needed.
  if(selected&&displayGroups.some(group=>group.items.length>1&&group.items.some(r=>r.id===selected.id))){
    const p=point(selected);
    addButton({x:p.x,y:p.y},displayLayers,'display-marker',`<button class="display-button is-selected" type="button" data-record="${esc(selected.id)}"><span>●</span></button>`,`Selected display at ${selected.address}`,()=>selectRecord(selected,false));
  }
  if(active){document.querySelector(`.display-button[data-record="${CSS.escape(active)}"]`)?.focus({preventScroll:true});}
  renderLabels();
}

function styleRoad(feature) {
  const cls=feature.properties.class||'', zoom=map.getZoom();
  const major=/Interstate|Expressway|Highway|Freeway/.test(cls);
  return {color:major?'#b69eac':'#cbc3b4',weight:major?(zoom<12?2.2:3.7):zoom<13?1:2.2,opacity:major?.9:.8,lineCap:'round',lineJoin:'round'};
}
function renderRoads() {
  const zoom=map.getZoom();
  for(const {layer,minimum} of geographicLayers){if(zoom>=minimum){if(!map.hasLayer(layer))layer.addTo(map);layer.setStyle(styleRoad);}else if(map.hasLayer(layer))map.removeLayer(layer);}
  if(localRoadLayer){if(zoom>=13.25){if(!map.hasLayer(localRoadLayer))localRoadLayer.addTo(map);}else if(map.hasLayer(localRoadLayer))map.removeLayer(localRoadLayer);}
  const tiles=zoom>=13.25?[...tileStates.entries()].filter(([,entry])=>entry.state==='ready'&&map.getBounds().pad(.15).intersects(entry.tile.bounds)):[];
  const key=tiles.map(([url])=>url).sort().join('|');
  if(key!==visibleTileKey){
    if(tiledRoadLayer)map.removeLayer(tiledRoadLayer);visibleTileKey=key;
    const unique=new Map();for(const [,entry] of tiles)for(const feature of entry.features)unique.set(feature.properties.sourceId,feature);
    tiledRoadLayer=L.geoJSON({type:'FeatureCollection',features:[...unique.values()]},{filter:f=>f.properties.class!=='Railroad',renderer:geographyRenderer,interactive:false,style:f=>({color:'#d8d2c2',weight:1.2,opacity:.8,dashArray:f.properties.class==='Trail'?'3 3':null})});
    if(tiles.length)tiledRoadLayer.addTo(map);
  }
}
function addLabel(lat,lng,text,className,occupied,skipCollision=false) {
  const p=map.latLngToContainerPoint([lat,lng]), water=className==='water-label', width=water?80:Math.min(190,text.length*(className==='road-label'?5.5:8)+10), height=water?42:className==='road-label'?15:23;
  const box={left:p.x-width/2,right:p.x+width/2,top:p.y-height/2,bottom:p.y+height/2};
  const size=map.getSize();if(box.left<6||box.right>size.x-6||box.top<6||box.bottom>size.y-6)return;
  if(!skipCollision&&occupied.some(r=>box.left<r.right+7&&box.right>r.left-7&&box.top<r.bottom+5&&box.bottom>r.top-5))return;
  L.marker([lat,lng],{interactive:false,keyboard:false,icon:L.divIcon({className:'',html:`<span class="map-label ${className}">${water?esc(text).replace(' of ',' of<br>'):esc(text)}</span>`,iconSize:[0,0],iconAnchor:[0,0]})}).addTo(labelLayers);occupied.push(box);
}
function renderLabels() {
  if(!map||!sourceContext)return;labelLayers.clearLayers();
  const occupied=obstacles();
  for(const node of document.querySelectorAll('.neighborhood-button,.display-button'))occupied.push(node.getBoundingClientRect());
  const zoom=map.getZoom();
  if(zoom<14)for(const city of cities)addLabel(city.lat,city.lng,city.name,'city-label',occupied);
  if(zoom<12&&map.getBounds().getWest()<=countyBounds[0][1]&&map.getBounds().getEast()>=countyBounds[1][1]
    &&map.getBounds().getSouth()<27.85&&map.getBounds().getNorth()>27.95){
    const size=map.getSize(), west=point({lat:27.91,lng:countyBounds[0][1]}).x, east=point({lat:27.85,lng:countyBounds[1][1]}).x;
    const gulf=map.containerPointToLatLng([Math.max(50,Math.min(size.x*.25,west-60)),size.y*.55]);
    const bay=map.containerPointToLatLng([Math.min(size.x-50,Math.max(size.x*.75,east+60)),size.y*.68]);
    addLabel(gulf.lat,gulf.lng,'Gulf of Mexico','water-label',occupied);addLabel(bay.lat,bay.lng,'Tampa Bay','water-label',occupied);
  }
  if(zoom<14.5)return;
  const context=[...sourceContext.features,...[...tileStates.values()].filter(t=>t.state==='ready').flatMap(t=>t.features)];
  const seen=new Set();let count=0;
  for(const feature of context){
    if(feature.properties.kind!=='road'||feature.properties.class==='Railroad'||!feature.properties.name||seen.has(feature.properties.name))continue;
    const paths=feature.geometry.type==='LineString'?[feature.geometry.coordinates]:feature.geometry.coordinates;
    for(const path of paths){
      if(path.length<2)continue;const mid=path[Math.floor(path.length/2)];
      if(!map.getBounds().contains([mid[1],mid[0]]))continue;
      const before=occupied.length;addLabel(mid[1],mid[0],feature.properties.name,'road-label',occupied);
      if(occupied.length>before){seen.add(feature.properties.name);count++;break;}
    }
    if(count>=(zoom<16?22:32))break;
  }
}
function loadVisibleTiles() {
  if(!tileManifest)return;
  const bounds=map.getBounds().pad(.15);
  for(const [url,entry] of tileStates)if(entry.state==='queued'&&(map.getZoom()<13.25||!bounds.intersects(entry.tile.bounds)))tileStates.delete(url);
  if(map.getZoom()<13.25)return;
  for(const [url,entry] of tileStates)if(entry.state==='ready'&&bounds.intersects(entry.tile.bounds))entry.used=Date.now();
  for(const tile of tileManifest.tiles)if(bounds.intersects(tile.bounds)&&!tileStates.has(tile.url))tileStates.set(tile.url,{state:'queued',tile});
  pumpTiles();
}
function pumpTiles() {
  const bounds=map.getBounds().pad(.2);
  const queue=[...tileStates.entries()].filter(([,entry])=>entry.state==='queued'&&bounds.intersects(entry.tile.bounds));
  while(activeTiles<3&&queue.length){
    const [url,entry]=queue.shift();entry.state='loading';activeTiles++;
    json(url).then(data=>{
      if(!Array.isArray(data.features))throw new Error('Invalid street tile');
      entry.features=data.features;entry.state='ready';
      entry.used=Date.now();
      const current=map.getBounds().pad(.2);
      const cached=[...tileStates.entries()].filter(([,item])=>item.state==='ready').sort((a,b)=>(a[1].used||0)-(b[1].used||0));
      while(cached.length>12){const index=cached.findIndex(([,item])=>!current.intersects(item.tile.bounds));if(index<0)break;const [url]=cached.splice(index,1)[0];tileStates.delete(url);}
      renderRoads();renderLabels();
    }).catch(()=>{entry.state='error';notice('Some local streets couldn’t load. The map and available displays still work.');})
      .finally(()=>{activeTiles--;pumpTiles();updateStatus();});
  }
}
function settle() {
  if(!map)return;
  const c=map.getCenter(), zoom=map.getZoom();document.body.dataset.zoom=zoom.toFixed(2);
  const nearest=[...cities].sort((a,b)=>map.distance(c,[a.lat,a.lng])-map.distance(c,[b.lat,b.lng]))[0];
  $('.view-caption').hidden=zoom>=streetDetailZoom;
  $('#view-name').textContent=zoom<12?'Pinellas County':nearest.name;
  $('#view-hint').textContent=zoom<12?'Pan north or south to explore the county.':zoom<14?'Pan to wander. Zoom to explore.':'Neighborhood streets. Displays worth a detour.';
  clearTimeout(redrawTimer);redrawTimer=setTimeout(()=>{renderRoads();renderMarkers();loadVisibleFeeds();loadVisibleTiles();writeUrl();},50);
}

function resultButton(name,meta,action,id='') {
  const button=document.createElement('button');button.type='button';button.className='search-result';if(id)button.dataset.result=id;
  button.innerHTML=`<span><strong>${esc(name)}</strong><small>${esc(meta)}</small></span><span aria-hidden="true">↗</span>`;
  button.onclick=()=>{$('#search-dialog').close();action();};return button;
}
function renderSearch() {
  const host=$('#search-results');host.replaceChildren();
  const search=$('#search-input').value.trim();
  if(!search){
    host.append(resultButton('All Pinellas',`${places.length} prepared neighborhood maps`,()=>frameCounty(),'county'));
    const title=document.createElement('p');title.className='search-group';title.textContent='Start somewhere';host.append(title);
    for(const city of [cities[0],cities[1],cities[4]])host.append(resultButton(city.name,'City view',()=>goCity(city),city.id));
    for(const id of ['old-northeast','crescent-lake']){const place=places.find(p=>p.id===id);if(place)host.append(resultButton(place.name,'Neighborhood map',()=>focusPlace(place),id));}
  }else{
    const results=searchPlaces(search,places);
    for(const place of results)host.append(resultButton(place.name,place.type==='county'?'County view':place.type==='city'?'City view':'Neighborhood map',()=>place.type==='county'?frameCounty():place.type==='city'?goCity(place):focusPlace(place),place.id));
    if(!results.length){const p=document.createElement('p');p.className='no-results';p.textContent='No city or neighborhood by that name. Try another name, or clear your search to explore Pinellas.';host.append(p);}
    $('#search-count').textContent=`${results.length} ${results.length===1?'result':'results'}`;
  }
}
function goCity(city) {dismiss(false);map.setView([city.lat,city.lng],city.zoom,{animate:false});writeUrl(true);settle();}
function openSearch() {$('#search-title').textContent='Find your corner.';$('#search-input').hidden=false;renderSearch();$('#search-dialog').showModal();$('#search-input').focus();}
async function restoreUrl() {
  restore=true;dismiss(false);const params=new URLSearchParams(location.search);
  const nextSeason=seasonFor(params.get('season')||'halloween-2026');
  if(nextSeason)season=nextSeason;$('#season-select').value=season.id;
  const camera=readCamera(params);map.setView([camera.lat,camera.lng],camera.zoom,{animate:false});
  const place=places.find(p=>p.id===params.get('neighborhood'));
  if(place){
    if(params.has('listing')){
      const id=params.get('listing'), request=selectionRequest, requestedSeason=season.id;ensureFeed(place,true);
      const check=()=>{if(request!==selectionRequest||requestedSeason!==season.id)return;const feed=feeds.get(requestedSeason+':'+place.id);if(['queued','loading'].includes(feed?.state)){setTimeout(check,80);return;}const record=feed?.records?.find(record=>record.id===id);if(record)selectRecord(record,false);else notice('This display is unavailable in the selected neighborhood and season.');};check();
    }else{
      focused=place;ensureFeed(place,true);
      if(!['lat','lng','z'].every(key=>params.has(key)))focusPlace(place,false);
    }
  }
  restore=false;settle();
}
function bindEvents() {
  $('#open-search').onclick=openSearch;$('#close-search').onclick=()=>$('#search-dialog').close();
  $('#search-input').oninput=renderSearch;$('#search-input').onkeydown=event=>{if(event.key==='Enter'){$('#search-results .search-result')?.click();event.preventDefault();}};
  $('#coverage').onclick=()=>{$('#about-dialog').showModal();};$('#close-about').onclick=()=>$('#about-dialog').close();
  $('#all-pinellas').onclick=()=>frameCounty();
  $('#detail-close').onclick=()=>{const prior=dismiss();(document.querySelector(`[data-record="${CSS.escape(prior?.id||'')}"]`)||$('#map')).focus({preventScroll:true});};
  $('#retry-feeds').onclick=()=>{
    for(const place of visibleAreas)ensureFeed(place,false,true);
    for(const entry of tileStates.values())if(entry.state==='error')entry.state='queued';pumpTiles();
  };
  $('#season-select').onchange=()=>{
    dismiss(false);season=seasonFor($('#season-select').value);visibleAreas=[];renderMarkers();loadVisibleFeeds();writeUrl(true);$('#about-dialog').close();
  };
  $('#detail-share').onclick=async()=>{
    const record=selected;if(!record)return;const url=viewUrl().href;
    try{if(navigator.share)await navigator.share({title:record.title||record.address,url});else await navigator.clipboard.writeText(url);notice('Display link ready to share.');}
    catch(error){if(error.name==='AbortError'||selected!==record)return;const field=$('#share-url');field.value=url;field.hidden=false;field.focus();field.select();}
  };
  $('#locate').onclick=()=>{
    if(!navigator.geolocation){notice('Location is unavailable in this browser. You can search for a city or neighborhood.');return;}
    $('#locate').setAttribute('aria-busy','true');
    navigator.geolocation.getCurrentPosition(position=>{
      $('#locate').removeAttribute('aria-busy');const {latitude:lat,longitude:lng}=position.coords;
      if(!L.latLngBounds(countyBounds).pad(.08).contains([lat,lng])){notice('You’re outside Pinellas. Search for a neighborhood or explore the county map.');return;}
      dismiss(false);if(locationLayer)map.removeLayer(locationLayer);
      locationLayer=L.marker([lat,lng],{interactive:false,keyboard:false,icon:L.divIcon({className:'location-dot',iconSize:[16,16],iconAnchor:[8,8]})}).addTo(map);
      map.setView([lat,lng],14.5,{animate:false});writeUrl(true);
    },()=>{$('#locate').removeAttribute('aria-busy');notice('Location wasn’t available. Search for a city or neighborhood instead.');},{timeout:10000,maximumAge:60000,enableHighAccuracy:false});
  };
  document.addEventListener('keydown',event=>{
    if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();if(!document.querySelector('dialog[open]'))openSearch();}
    if(event.key==='Escape'&&!document.querySelector('dialog[open]')&&(selected||focused)){dismiss();$('#map').focus({preventScroll:true});}
    if(event.key==='Home'&&event.target===$('#map')){event.preventDefault();frameCounty();}
  });
  addEventListener('popstate',restoreUrl);
  const observer=new ResizeObserver(()=>{
    map.invalidateSize({pan:false});
    const minimum=minimumOverviewZoom(map.getSize().y);
    if(map.getMinZoom()!==minimum)map.setMinZoom(minimum);
    revealSelected();settle();
  });observer.observe($('.map-app'));observer.observe($('#selection'));
}

async function start() {
  if(!season)throw new Error('Unsupported season');
  const [geography,catalog,tiles,notices]=await Promise.all([json('./data/context.geojson'),json('./data/places.json'),json('./data/context-tiles.json'),json('./data/source-notices.json')]);
  sourceContext=geography;places=catalog.places;tileManifest=tiles;
  map=L.map('map',{minZoom:minimumOverviewZoom($('#map').clientHeight),maxZoom:18,zoomSnap:.25,zoomDelta:.5,zoomControl:false,attributionControl:false,zoomAnimation:false,markerZoomAnimation:false,preferCanvas:true,
    maxBounds:[[27.4,-83.1],[28.4,-82.35]],maxBoundsViscosity:.8});
  L.control.zoom({position:'bottomright'}).addTo(map);
  L.control.attribution({position:'bottomleft',prefix:false}).addAttribution('<a href="https://www.census.gov/geographies/mapping-files/time-series/geo/carto-boundary-file.html" target="_blank" rel="noopener">U.S. Census</a> · <a href="https://services.arcgis.com/f5HgUpxURgEzTccH/ArcGIS/rest/services/Pinellas_RoadCenterline_view/FeatureServer/0" target="_blank" rel="noopener">Pinellas GIS</a> · USGS').addTo(map);
  geographyRenderer=L.canvas({padding:.3});
  L.geoJSON(geography,{filter:f=>f.properties.kind==='county',renderer:geographyRenderer,interactive:false,style:{color:'#bac1ae',weight:2,fill:true,fillColor:'#f0eddb',fillOpacity:1}}).addTo(map);
  L.geoJSON(geography,{filter:f=>f.properties.kind==='water',renderer:geographyRenderer,interactive:false,style:{color:'#acbfb2',weight:1,fill:true,fillColor:'#dce5df',fillOpacity:1}}).addTo(map);
  for(const [minimum,test] of [[9,cls=>/Interstate|Expressway|Highway|Freeway/.test(cls)],[10,cls=>/Arterial|Ramp|Bridge/.test(cls)],[12.5,cls=>cls==='Collector']]){
    const layer=L.geoJSON(geography,{filter:f=>f.properties.kind==='road'&&f.properties.tier==='regional'&&test(f.properties.class||''),renderer:geographyRenderer,interactive:false,style:{color:'#ccc3b4',weight:2}});
    geographicLayers.push({minimum,layer});
  }
  localRoadLayer=L.geoJSON(geography,{filter:f=>f.properties.kind==='road'&&f.properties.tier==='local',renderer:geographyRenderer,interactive:false,style:{color:'#d3cdbc',weight:1.5,opacity:.85}});
  neighborhoodLayers.addTo(map);displayLayers.addTo(map);labelLayers.addTo(map);
  $('#source-credits').textContent='Base geography: U.S. Census Bureau 2024 cartographic county outline; Pinellas County GIS road centerlines; USGS water in the retained St. Petersburg study area. County outline is generalized. Reference map only; not a routing or survey product.';
  const sourceLink=document.createElement('a');sourceLink.href='./data/source-notices.json';sourceLink.textContent=' Source details.';$('#source-credits').append(sourceLink);
  map.on('moveend zoomend',settle);map.on('click',()=>{if(selected||focused)dismiss();});
  bindEvents();await restoreUrl();renderRoads();renderMarkers();loadVisibleFeeds();loadVisibleTiles();
  document.body.dataset.ready='true';$('#map').setAttribute('aria-label','Explore Pinellas and '+places.length+' neighborhood maps. Arrow keys pan, plus and minus zoom. Home shows all Pinellas.');
  window.discoveryMap={camera:()=>({lat:map.getCenter().lat,lng:map.getCenter().lng,zoom:map.getZoom()}),
    county:()=>frameCounty(false),city:id=>{const city=cities.find(c=>c.id===id);if(city)goCity(city);},
    neighborhood:id=>{const place=places.find(p=>p.id===id);if(place)focusPlace(place);},
    diagnostics:()=>({places:places.length,feeds:[...feeds.values()].filter(f=>f.season===season.id).map(f=>({id:f.place.id,state:f.state,records:f.records?.length})),tiles:[...tileStates.values()].map(t=>({state:t.state})),records:records().map(r=>({id:r.id,address:r.address,lat:r.lat,lng:r.lng})),selected:selected?.id||null,countyCorners:countyBounds.map(p=>{const point=map.latLngToContainerPoint(p);return {x:point.x,y:point.y};})}),
    setView:(lat,lng,zoom)=>map.setView([lat,lng],zoom,{animate:false})};
}
start().catch(error=>{document.body.dataset.ready='error';$('#fatal').hidden=false;console.error(error.message);});
