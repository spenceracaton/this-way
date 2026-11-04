const $ = selector => document.querySelector(selector);
const svgNS = 'http://www.w3.org/2000/svg';
const colors = { north: '#5d704f', central: '#8b632d', south: '#745c7d', coast: '#476b76' };
const arrow = '<svg class="row-arrow" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11m-5-5 5 5-5 5"/></svg>';
const back = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m11 5-5 5 5 5M6 10h10"/></svg>';
const searchIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/></svg>';
const icons = {
 north: '<path d="M12 23V6m0 0-6 7m6-7 6 7M5 23h14"/>',
 central: '<path d="M4 20h17M7 20V9l6-5 6 5v11M10 20v-6h6v6"/>',
 south: '<path d="M4 21h18M7 21V9h5v12m3 0V4h5v17M9 12h1m7-4h1m-1 4h1m-1 4h1"/>',
 coast: '<path d="M3 13q4-4 8 0t8 0m-16 5q4-4 8 0t8 0M7 7h11m-9-3 7 0"/>'
};
const regionCopy = {
 north: 'Take the long way north, through quiet streets and Gulf-side towns.',
 central: 'Explore the little pockets between Clearwater, Largo, and the coast.',
 south: 'Porches, lake loops, and a whole lot of neighborhood character.',
 coast: 'Find a place along the water. A little island time is welcome here.'
};
const neighborhoodCopy = {
 'old-northeast': 'Tree-lined streets, front porches, and a neighborhood made for wandering.',
 'crescent-lake': 'A lake at the heart of it, and plenty of little streets to explore around it.',
 'greenbriar-cdp': 'A quieter corner of north county, ready for a closer look.',
 'belleair-beach-place': 'Cross over to the Gulf side and find your way along the coast.'
};
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const point = ([lng, lat]) => ({ x: 520 + (lng + 82.73) * 1700 * Math.cos(27.9 * Math.PI / 180), y: 590 + (27.91 - lat) * 1700 });
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const mobileMapInset = 24;
const cities = [
 {name:'Tarpon Springs',lng:-82.755,lat:28.148},
 {name:'Dunedin',lng:-82.774,lat:28.025},
 {name:'Clearwater',lng:-82.795,lat:27.98},
 {name:'Largo',lng:-82.79,lat:27.91},
 {name:'St. Petersburg',lng:-82.635,lat:27.75}
];
const regionAliases = {
 north:['North Pinellas','Tarpon Springs','Dunedin'],
 central:['Central Pinellas','Clearwater','Largo'],
 south:['South Pinellas','St. Petersburg','Saint Petersburg','St Pete'],
 coast:['Pinellas beaches','Beaches','Islands','Gulf beaches','Tierra Verde','Belleair Beach']
};
const normalize = value => value.normalize('NFKD').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const searchKey = value => normalize(value).replaceAll(' ','');
const mapCount = count => count+' neighborhood '+(count===1?'map':'maps');
let data, places, regions, state, view, animation = 0, resizeFrame;
const counts = new Map();
const countPending = new Set();
const surface = $('#map-surface');

function readState() {
 const query = new URLSearchParams(location.search);
 const place = places.get(query.get('place'));
 return { region: place?.region || (regions.has(query.get('region')) ? query.get('region') : null), place: place?.id || null, focusIds: null, search: '', limit: 6 };
}
function searchMarkup() {
 return '<div class="search-wrap">'+searchIcon+'<input id="atlas-search" type="search" autocomplete="off" placeholder="Find a city or neighborhood" aria-label="Find a city or neighborhood" value="'+esc(state.search)+'"><button class="clear-search" type="button" aria-label="Clear neighborhood search" '+(!state.search?'hidden':'')+'>×</button></div>';
}
function regionRow(region, index) {
 const count = data.neighborhoods.filter(place => place.region === region.id).length;
 return '<button type="button" class="region-row" data-region="'+region.id+'" style="--region-color:'+colors[region.id]+'"><span class="region-symbol" aria-hidden="true"><span class="region-index">0'+(index+1)+'</span><svg viewBox="0 0 26 26">'+icons[region.id]+'</svg></span><span><span class="row-name">'+esc(region.name)+'</span><span class="row-meta">'+count+' '+(count===1?'map':'maps')+'</span></span>'+arrow+'</button>';
}
function neighborhoodRow(place) {
 return '<button type="button" class="neighborhood-row" data-place="'+esc(place.id)+'" style="--region-color:'+colors[place.region]+'"><span class="ready-dot" aria-hidden="true"></span><span><span class="row-name">'+esc(place.name)+'</span><span class="row-meta">'+esc(regions.get(place.region).name)+'</span></span>'+arrow+'</button>';
}
function availablePlaces() {
 const query = searchKey(state.search);
 if (state.search.trim()) return query?data.neighborhoods.filter(place => searchKey(place.name).includes(query)):[];
 if (!state.region) return [];
 return data.neighborhoods.filter(place => place.region === state.region && (!state.focusIds || state.focusIds.includes(place.id)));
}
function matchingRegions(){
 const query=searchKey(state.search);
 return query.length<3?[]:data.regions.filter(region=>[region.name,...regionAliases[region.id]].some(alias=>searchKey(alias).includes(query)));
}
function areaLabel(items){
 const center={lng:items.reduce((sum,p)=>sum+p.lng,0)/items.length,lat:items.reduce((sum,p)=>sum+p.lat,0)/items.length};
 const nearest=[...cities].sort((a,b)=>Math.hypot((a.lng-center.lng)*.88,a.lat-center.lat)-Math.hypot((b.lng-center.lng)*.88,b.lat-center.lat))[0];
 const dx=(center.lng-nearest.lng)*.88,dy=center.lat-nearest.lat;
 if(Math.hypot(dx,dy)<.018)return 'Near '+nearest.name;
 const vertical=Math.abs(dy)>.45*Math.abs(dx)?(dy>0?'North':'South'):'';
 const horizontal=Math.abs(dx)>.45*Math.abs(dy)?(dx>0?'east':'west'):'';
 const direction=vertical?vertical+horizontal:horizontal[0].toUpperCase()+horizontal.slice(1);
 return direction+' of '+nearest.name;
}
function focusLabel(){return areaLabel(state.focusIds.map(id=>places.get(id)));}
function highlightPlace(id){
 $('#map-markers').querySelectorAll('button').forEach(button=>button.classList.toggle('is-linked',Boolean(id)&&(button.dataset.place===id||button.dataset.members?.split(' ').includes(id))));
}
function renderResults() {
 const host = $('#atlas-results');
 if (!host) return;
 const isSearch = Boolean(state.search.trim());
 document.body.dataset.search = String(isSearch);
 if (!state.region && !isSearch) {
  host.innerHTML = '<div class="list-heading"><span>Choose a region</span><span>'+data.neighborhoods.length+' neighborhood maps</span></div><div class="region-list">'+data.regions.map(regionRow).join('')+'</div>';
 } else {
  const queryKey=searchKey(state.search);
  const shown = availablePlaces().sort((a,b) => Number(searchKey(b.name)===queryKey)-Number(searchKey(a.name)===queryKey)||a.name.localeCompare(b.name));
  const visible=matchMedia('(max-width:720px)').matches?shown.slice(0,state.limit||6):shown;
  const suggestions=isSearch?matchingRegions():[];
  host.innerHTML = (suggestions.length?'<div id="region-suggestions"><div class="list-heading"><span>Explore a region</span></div><div class="region-list">'+suggestions.map(region=>regionRow(region,data.regions.indexOf(region))).join('')+'</div></div>':'')+(shown.length?'<div class="list-heading"><span>'+(isSearch?'Neighborhood matches':state.focusIds?esc(focusLabel()):'Neighborhoods')+'</span><span>'+shown.length+' '+(shown.length===1?'map':'maps')+'</span></div><div class="neighborhood-list">'+visible.map(neighborhoodRow).join('')+'</div>'+(visible.length<shown.length?'<button type="button" class="more-neighborhoods" id="atlas-more">Show '+Math.min(6,shown.length-visible.length)+' more neighborhoods <span>'+visible.length+' of '+shown.length+' shown</span></button>':''):suggestions.length?'':'<div class="list-empty">'+(isSearch?'No city or neighborhood by that name. Try another name or clear your search to explore a region.':'We’re still drawing this part of the atlas. There are more maps nearby.<br><button type="button" data-region="central">Explore Clearwater & Largo →</button>')+'</div>');
 }
 host.querySelectorAll('[data-region]').forEach(button => button.addEventListener('click', () => navigate({region:button.dataset.region,place:null,focusIds:null,search:'',limit:6},false)));
 host.querySelectorAll('[data-place]').forEach(button => {
  button.addEventListener('click', () => choosePlace(button.dataset.place));
  for(const event of ['pointerenter','focus'])button.addEventListener(event,()=>highlightPlace(button.dataset.place));
  for(const event of ['pointerleave','blur'])button.addEventListener(event,()=>highlightPlace(null));
 });
 $('#atlas-more')?.addEventListener('click',()=>{
  const total=availablePlaces().length,previous=Math.min(state.limit||6,total);
  state.limit=Math.min(previous+6,total);writeHistory(true);renderResults();
  const next=host.querySelectorAll('.neighborhood-row')[previous];
  next?.focus({preventScroll:true});next?.scrollIntoView({block:'nearest',behavior:'instant'});
  $('#view-status').textContent=state.limit===total?'All '+mapCount(total)+' shown.':state.limit+' of '+mapCount(total)+' shown.';
 });
 const clear = $('.clear-search');
 if (clear) clear.hidden = !state.search;
}
function statText(id) {
 if (!counts.has(id)) return 'Prepared neighborhood map';
 const count = counts.get(id);
 return count ? count+' '+(count===1?'display':'displays')+' · Halloween 2026' : 'No Halloween 2026 displays';
}
async function loadCount(id) {
 if (counts.has(id) || countPending.has(id)) return;
 countPending.add(id);
 try {
  const response = await fetch('/api/listings?neighborhood='+encodeURIComponent(id)+'&season=halloween-2026', {signal:AbortSignal.timeout(10000)});
  if (!response.ok) return;
  const result = await response.json();
  if (!Array.isArray(result.listings)) return;
  counts.set(id,result.listings.length);
  if (state.place === id && $('#preview-count')) $('#preview-count').textContent = statText(id);
 } catch { /* Map availability stays useful when counts cannot load. */ }
 finally { countPending.delete(id); }
}
function renderPanel() {
 const region = regions.get(state.region), place = places.get(state.place);
 let markup;
 if (place) {
  markup = '<button class="back-link" type="button" id="panel-back">'+back+'Neighborhoods</button><div class="preview-image"><img src="'+esc(place.artwork)+'" alt="Illustrated street map of '+esc(place.name)+'"><span class="preview-stamp">A closer look</span></div><p class="preview-credit">'+(place.credits||[]).map(credit=>'<a href="'+esc(credit.href)+'" target="_blank" rel="noopener">'+esc(credit.label)+'</a>').join(' · ')+'</p><span class="preview-region-chip" style="--region-color:'+colors[place.region]+'">'+esc(region.name)+'</span><h1 id="panel-title" class="preview-title" tabindex="-1">'+esc(place.name)+'</h1><p class="preview-copy">'+esc(neighborhoodCopy[place.id] || 'A neighborhood of its own, with an illustrated map to help you find your way.')+'</p><p class="preview-stat"><i aria-hidden="true"></i><span id="preview-count">'+statText(place.id)+'</span></p><a class="open-map" target="_blank" rel="noopener" href="/?neighborhood='+encodeURIComponent(place.id)+'&season=halloween-2026">Open neighborhood map <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 15 15 5M6 5h9v9"/></svg></a><p class="preview-footnote">Opens in a new tab, so your place in the atlas stays here.</p>';
 } else if (region) {
  markup = '<div class="panel-heading"><button class="back-link" type="button" id="panel-back">'+back+(state.focusIds?'All '+esc(region.name):'All Pinellas')+'</button><p class="eyebrow">'+esc(region.kicker)+'</p><h1 id="panel-title" class="region-name" tabindex="-1">'+esc(region.name)+'</h1><p class="intro">'+regionCopy[region.id]+'</p>'+searchMarkup()+'</div><div id="atlas-results"></div><p class="browse-note">Select a dot or a name for a closer look.</p>';
 } else {
  markup = '<div class="panel-heading"><p class="eyebrow">An illustrated field guide</p><h1 id="panel-title" tabindex="-1"><span class="desktop-title">Find your corner of Pinellas.</span><span class="mobile-title">Explore Pinellas</span></h1><p class="intro">Start with a region. Find a neighborhood. See where the little streets lead.</p>'+searchMarkup()+'</div><div id="atlas-results"></div>';
 }
 $('#panel-content').innerHTML = markup;
 if (place) loadCount(place.id);
 else {
  renderResults();
  const input = $('#atlas-search');
  input.addEventListener('input', () => { state.search=input.value;state.limit=6;writeHistory(true);renderResults(); });
  input.addEventListener('keydown', event => {
   if (event.key==='Escape') {state.search='';input.value='';writeHistory(true);renderResults();}
   if (event.key==='Enter') {
    const matches=[...$('#atlas-results').querySelectorAll('[data-place]')];
    const exact=matches.find(button=>searchKey(places.get(button.dataset.place).name)===searchKey(state.search));
    const suggestions=[...($('#region-suggestions')?.querySelectorAll('[data-region]')||[])];
    const first=exact||(suggestions.length===1?suggestions[0]:suggestions.length?null:matches[0]);
    if(first){event.preventDefault();first.click();}
    else if(suggestions.length){event.preventDefault();suggestions[0].focus();}
   }
  });
  $('.clear-search').addEventListener('click', () => { state.search='';input.value='';writeHistory(true);renderResults();input.focus(); });
 }
 $('#panel-back')?.addEventListener('click', () => {
  if (state.place) navigate({...state.returnBrowse,place:null,returnBrowse:null,search:state.returnBrowse?.search||''},true);
  else if (state.focusIds) navigate({focusIds:null,search:''},true);
  else navigate({region:null,place:null,focusIds:null,search:''},false);
 });
}
function writeHistory(replace=false) {
 const url = new URL(location.href);
 for (const key of ['region','place']) { if(state[key])url.searchParams.set(key,state[key]);else url.searchParams.delete(key); }
 history[replace?'replaceState':'pushState']({atlas:{...state}},'',url.pathname+url.search);
}
function navigate(next, scroll=false, record=true) {
 state={...state,...next};
 document.body.dataset.view=state.place?'preview':state.region?'region':'county';
 document.body.dataset.search=String(Boolean(state.search.trim()));
 if(record)writeHistory();
 renderPanel();
 const region=regions.get(state.region), place=places.get(state.place);
 $('#map-view-label').textContent=place?.name || (state.focusIds?focusLabel():region?.name) || 'Choose a region';
 $('#map-hint').textContent=place?'Selected in '+region.name:state.focusIds?focusLabel():region?'Tap a group, or choose a neighborhood.':'Four regions. Choose a number or a region.';
 $('#map-instruction').textContent=region?'Tap a dot or group':'Tap a number';
 surface.classList.toggle('is-regional',Boolean(region));
 $('#view-status').textContent=place?place.name+' preview opened.':region?(state.focusIds?focusLabel():region.name)+' — '+mapCount(availablePlaces().length)+'.':'Pinellas overview. Choose one of four regions.';
 fitView();
 if (record) $('#panel-title').focus({preventScroll:true});
 if (matchMedia('(max-width:720px)').matches) {
  window.scrollTo({top:0,behavior:'instant'});
 }
}
function choosePlace(id) {
 const place=places.get(id);if(!place)return;
 const returnBrowse={region:state.region,focusIds:state.focusIds,search:state.search,limit:state.limit};
 navigate({region:place.region,place:id,focusIds:state.region===place.region&&state.focusIds?.includes(place.id)?state.focusIds:null,search:'',returnBrowse},true);
}
function projectBounds(bounds) {
 const [west,south,east,north]=bounds, a=point([west,north]),b=point([east,south]);
 return {x:a.x,y:a.y,w:b.x-a.x,h:b.y-a.y};
}
function shapeBounds() {
 if(state.focusIds&&!state.place){const points=state.focusIds.map(id=>places.get(id)).filter(Boolean).map(p=>point([p.lng,p.lat]));const xs=points.map(p=>p.x),ys=points.map(p=>p.y);return{x:Math.min(...xs)-30,y:Math.min(...ys)-30,w:Math.max(60,Math.max(...xs)-Math.min(...xs)+60),h:Math.max(60,Math.max(...ys)-Math.min(...ys)+60)};}
 const bounds={north:[-82.88,27.98,-82.60,28.20],central:[-82.90,27.83,-82.58,28.04],south:[-82.81,27.68,-82.52,27.89],coast:[-82.91,27.59,-82.68,28.04]};
 return state.region?projectBounds(bounds[state.region]):projectBounds([-82.94,27.57,-82.50,28.21]);
}
function matchAspect(box) {
 const aspect=surface.clientWidth/surface.clientHeight,center={x:box.x+box.w/2,y:box.y+box.h/2};let {w,h}=box;
 if(w/h>aspect)h=w/aspect;else w=h*aspect;
 return{x:center.x-w/2,y:center.y-h/2,w,h};
}
function fittedBounds(){
 const box=matchAspect(shapeBounds());
 if(!state.region||state.place||!matchMedia('(max-width:720px)').matches)return box;
 const factor=surface.clientHeight/(surface.clientHeight-2*mobileMapInset);
 return{x:box.x-box.w*(factor-1)/2,y:box.y-box.h*(factor-1)/2,w:box.w*factor,h:box.h*factor};
}
function applyView(next){if(!surface.clientWidth||!surface.clientHeight)return;view=next;$('#atlas-map').setAttribute('viewBox',[view.x,view.y,view.w,view.h].join(' '));renderMarkers();renderCities();}
function animateTo(target){
 cancelAnimationFrame(animation);
 if(!view||reduced.matches){applyView(target);return;}
 const start={...view},time=performance.now();
 function step(now){const t=Math.min(1,(now-time)/430),ease=1-Math.pow(1-t,3);applyView(Object.fromEntries(['x','y','w','h'].map(key=>[key,start[key]+(target[key]-start[key])*ease])));if(t<1)animation=requestAnimationFrame(step);}
 animation=requestAnimationFrame(step);
}
function fitView(){if(surface.clientWidth&&surface.clientHeight)animateTo(fittedBounds());}
function screenPoint(place){const p=point([place.lng,place.lat]);return{x:(p.x-view.x)/view.w*surface.clientWidth,y:(p.y-view.y)/view.h*surface.clientHeight};}
function makeMarker(x,y,content,className,label,color){
 const button=document.createElement('button');button.type='button';button.className=className;button.style.left=x+'px';button.style.top=y+'px';button.style.setProperty('--region-color',color);button.setAttribute('aria-label',label);button.title=label;button.innerHTML=content;return button;
}
function renderMarkers(){
 if(!view||!data)return;
 const fragment=document.createDocumentFragment(),width=surface.clientWidth,height=surface.clientHeight;
 if(!state.region){
  data.regions.forEach((region,index)=>{
   const anchor=region.id==='south'?[-82.66,27.70]:region.id==='coast'?[-82.86,27.825]:region.anchor;
   const p=screenPoint({lng:anchor[0],lat:anchor[1]});const count=data.neighborhoods.filter(place=>place.region===region.id).length;
   const compact=matchMedia('(max-width:720px)').matches;
   const positions={north:[.60,.18],central:[.36,.42],south:[.55,.81],coast:[.22,.70]};
   const [x,y]=compact?[width*positions[region.id][0],height*positions[region.id][1]]:[Math.max(80,Math.min(width-80,p.x)),Math.max(85,Math.min(height-65,p.y))];
   const button=makeMarker(x,y,'<span class="region-number">0'+(index+1)+'</span><span><span class="region-marker-name">'+esc(region.name)+'</span><span class="region-marker-count">'+count+' '+(count===1?'map':'maps')+'</span></span>','region-marker',region.name+', '+count+' maps',colors[region.id]);
   button.dataset.region=region.id;button.addEventListener('click',()=>navigate({region:region.id,place:null,focusIds:null,search:'',limit:6},false));fragment.append(button);
  });
 } else if(state.place){
  const place=places.get(state.place),p=screenPoint(place);
  const button=makeMarker(p.x,p.y,'<span class="place-label">'+esc(place.name)+'</span>','place-marker selected',place.name+' selected',colors[place.region]);
  button.addEventListener('click',()=>$('#panel-title').focus({preventScroll:true}));fragment.append(button);
 } else {
  const shown=availablePlaces().filter(place=>!state.search || place.region===state.region).sort((a,b)=>a.name.localeCompare(b.name));
  const groups=[];
  const compact=matchMedia('(max-width:720px)').matches;
  const insetTop=compact?mobileMapInset:65,insetBottom=compact?mobileMapInset:45;
  for(const place of shown){const p=screenPoint(place);if(p.x<23||p.x>width-23||p.y<insetTop||p.y>height-insetBottom)continue;let group=groups.find(g=>Math.hypot(p.x-g.x,p.y-g.y)<38);if(!group){group={x:p.x,y:p.y,items:[]};groups.push(group);}group.items.push(place);}
  for(const group of groups){const many=group.items.length>1,place=group.items[0];
   const button=makeMarker(group.x,group.y,many?String(group.items.length):'<span class="place-label">'+esc(place.name)+'</span>','place-marker'+(many?' cluster':''),many?group.items.length+' nearby neighborhood maps, '+areaLabel(group.items):place.name,colors[state.region]);
   button.dataset.members=group.items.map(item=>item.id).join(' ');
   if(many)button.dataset.cluster=String(group.items.length);else button.dataset.place=place.id;
   button.addEventListener('click',()=>many?navigate({focusIds:group.items.map(p=>p.id),place:null,search:'',limit:6},false):choosePlace(place.id));fragment.append(button);
  }
 }
 $('#map-markers').replaceChildren(fragment);
}
function drawCounty(){
 const rings=data.county.coordinates.map(polygon=>polygon.map(ring=>ring.map((coord,index)=>{const p=point(coord);return(index?'L':'M')+p.x.toFixed(2)+','+p.y.toFixed(2);}).join('')+'Z').join(''));
 for(const host of ['#county-shadow','#county-land']){
  $(host).replaceChildren(...rings.map(path=>{const node=document.createElementNS(svgNS,'path');node.setAttribute('d',path);node.setAttribute('fill-rule','evenodd');return node;}));
 }
 const clip=document.createElementNS(svgNS,'clipPath');clip.id='county-outline';
 for(const d of rings){const path=document.createElementNS(svgNS,'path');path.setAttribute('d',d);path.setAttribute('fill-rule','evenodd');clip.append(path);}
 $('#atlas-map defs').append(clip);const wash=$('#county-wash');wash.setAttribute('clip-path','url(#county-outline)');wash.setAttribute('opacity','.27');
 const northEdge=point([-82.7,28]).y,southEdge=point([-82.7,27.84]).y;
 for(const [id,y,height] of [['north',-5000,northEdge+5000],['central',northEdge,southEdge-northEdge],['south',southEdge,5000]]){const rect=document.createElementNS(svgNS,'rect');for(const [name,value]of Object.entries({x:-5000,y,width:10000,height,fill:colors[id]}))rect.setAttribute(name,value);wash.append(rect);}
 for(const place of data.neighborhoods.filter(place=>place.region==='coast')){const p=point([place.lng,place.lat]),circle=document.createElementNS(svgNS,'ellipse');for(const [name,value]of Object.entries({cx:p.x,cy:p.y,rx:50,ry:85,fill:colors.coast}))circle.setAttribute(name,value);wash.append(circle);}
 $('#roads').replaceChildren();
}
function renderCities(){
 const group=$('#city-labels');group.replaceChildren();
 if(!surface.clientWidth||!surface.clientHeight)return;
 const scale=view.h/surface.clientHeight;
 const shown=matchMedia('(max-width:720px)').matches&&!state.region?cities.filter((_,index)=>[0,2,4].includes(index)):cities;
 const frame=surface.getBoundingClientRect(),width=surface.clientWidth,height=surface.clientHeight;
 const blocked=[...surface.parentElement.querySelectorAll('.map-markers button,.place-label,.map-tools,.north-arrow,.map-topline,.water-word')].filter(node=>{
  const style=getComputedStyle(node);return style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)>0;
 }).map(node=>{const r=node.getBoundingClientRect();return{x:r.x-frame.x-3,y:r.y-frame.y-3,w:r.width+6,h:r.height+6};});
 const overlaps=(a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
 for(const city of shown){
  const p=point([city.lng,city.lat]),screen=screenPoint(city);
  if(screen.x<8||screen.x>width-8||screen.y<8||screen.y>height-8)continue;
  const text=document.createElementNS(svgNS,'text');text.setAttribute('font-size',11*scale);text.setAttribute('stroke-width',3*scale);text.setAttribute('letter-spacing',.2*scale);text.textContent=city.name;group.append(text);
  const metrics=text.getBBox(),w=metrics.width/scale,h=metrics.height/scale;
  const candidates=[];
  for(const gap of [8,32,56,80]){
   for(const dy of [-h/2,-h-10,10,-h-28,28]){
    for(const side of [1,-1]){
     const candidate={x:screen.x+(side===1?gap:-gap-w),y:screen.y+dy,w,h};
     if(candidate.x>=10&&candidate.x+w<=width-10&&candidate.y>=10&&candidate.y+h<=height-10&&!blocked.some(rect=>overlaps(candidate,rect)))candidates.push({...candidate,cost:Math.hypot(gap,dy+h/2)+Math.abs(dy+h/2)*.5});
    }
   }
  }
  const label=candidates.sort((a,b)=>a.cost-b.cost)[0];
  if(!label){text.remove();continue;}
  text.setAttribute('x',view.x+label.x*scale-metrics.x);text.setAttribute('y',view.y+label.y*scale-metrics.y);
  const end={x:Math.max(label.x,Math.min(screen.x,label.x+w)),y:Math.max(label.y,Math.min(screen.y,label.y+h))};
  if(Math.hypot(end.x-screen.x,end.y-screen.y)>12){
   const line=document.createElementNS(svgNS,'line');line.setAttribute('x1',p.x);line.setAttribute('y1',p.y);line.setAttribute('x2',view.x+end.x*scale);line.setAttribute('y2',view.y+end.y*scale);line.setAttribute('stroke-width',scale);group.insertBefore(line,text);
  }
  const circle=document.createElementNS(svgNS,'circle');circle.setAttribute('cx',p.x);circle.setAttribute('cy',p.y);circle.setAttribute('r',2*scale);group.insertBefore(circle,text);
  blocked.push({x:label.x-3,y:label.y-3,w:w+6,h:h+6});
 }
}
function zoom(factor){if(!view)return;cancelAnimationFrame(animation);const w=view.w*factor,h=view.h*factor;animateTo({x:view.x+(view.w-w)/2,y:view.y+(view.h-h)/2,w,h});}
async function boot(){
 const response=await fetch('./atlas-data.json');if(!response.ok)throw Error('The atlas could not load.');data=await response.json();
 places=new Map(data.neighborhoods.map(place=>[place.id,place]));regions=new Map(data.regions.map(region=>[region.id,region]));
 state=readState();drawCounty();writeHistory(true);navigate({},false,false);
 $('#county-button').addEventListener('click',()=>navigate({region:null,place:null,focusIds:null,search:''}));
 $('#zoom-in').addEventListener('click',()=>zoom(.7));$('#zoom-out').addEventListener('click',()=>zoom(1.4));$('#fit-map').addEventListener('click',fitView);
 window.addEventListener('popstate',event=>{const saved=event.state?.atlas;state=saved&&(!saved.region||regions.has(saved.region))&&(!saved.place||places.has(saved.place))?saved:readState();navigate({},false,false);});
 new ResizeObserver(()=>{cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(()=>{cancelAnimationFrame(animation);if(surface.clientWidth&&surface.clientHeight)applyView(fittedBounds());});}).observe(surface);
 matchMedia('(max-width:720px)').addEventListener('change',renderResults);
 document.body.dataset.ready='true';
 document.fonts.ready.then(()=>{if(surface.clientWidth&&surface.clientHeight)renderCities();});
}
boot().catch(error=>{$('#panel-content').innerHTML='<h1>The atlas couldn’t load.</h1><p>'+esc(error.message)+'</p><p><a href="/?season=halloween-2026">Open the neighborhood maps</a></p>';$('#view-status').textContent='The atlas could not load.';});
