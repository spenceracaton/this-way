const $ = selector => document.querySelector(selector);
const svgNS = 'http://www.w3.org/2000/svg';
const colors = { north: '#78856a', central: '#a5804d', south: '#745c7d', coast: '#607e87' };
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
 return '<div class="search-wrap">'+searchIcon+'<input id="atlas-search" type="search" autocomplete="off" placeholder="Find a neighborhood" aria-label="Find a neighborhood" value="'+esc(state.search)+'"><button class="clear-search" type="button" aria-label="Clear neighborhood search" '+(!state.search?'hidden':'')+'>×</button></div>';
}
function regionRow(region, index) {
 const count = data.neighborhoods.filter(place => place.region === region.id).length;
 return '<button type="button" class="region-row" data-region="'+region.id+'" style="--region-color:'+colors[region.id]+'"><span class="region-symbol" aria-hidden="true"><svg viewBox="0 0 26 26">'+icons[region.id]+'</svg></span><span><span class="row-name">'+esc(region.name)+'</span><span class="row-meta">'+count+' neighborhood '+(count===1?'map':'maps')+'</span></span>'+arrow+'</button>';
}
function neighborhoodRow(place) {
 return '<button type="button" class="neighborhood-row" data-place="'+esc(place.id)+'" style="--region-color:'+colors[place.region]+'"><span class="ready-dot" aria-hidden="true"></span><span><span class="row-name">'+esc(place.name)+'</span><span class="row-meta">'+esc(regions.get(place.region).name)+'</span></span>'+arrow+'</button>';
}
function availablePlaces() {
 const query = state.search.trim().toLocaleLowerCase();
 if (query) return data.neighborhoods.filter(place => place.name.toLocaleLowerCase().includes(query));
 if (!state.region) return [];
 return data.neighborhoods.filter(place => place.region === state.region && (!state.focusIds || state.focusIds.includes(place.id)));
}
function renderResults() {
 const host = $('#atlas-results');
 if (!host) return;
 const isSearch = Boolean(state.search.trim());
 if (!state.region && !isSearch) {
  host.innerHTML = '<div class="list-heading"><span>Start somewhere</span><span>'+data.neighborhoods.length+' maps to explore</span></div><div class="region-list">'+data.regions.map(regionRow).join('')+'</div>';
 } else {
  const shown = availablePlaces().sort((a,b) => a.name.localeCompare(b.name));
  const visible=matchMedia('(max-width:720px)').matches?shown.slice(0,state.limit||6):shown;
  host.innerHTML = '<div class="list-heading"><span>'+(isSearch?'Across Pinellas':state.focusIds?'A little closer':'Neighborhoods')+'</span><span>'+shown.length+' '+(shown.length===1?'map':'maps')+'</span></div>'+(shown.length?'<div class="neighborhood-list">'+visible.map(neighborhoodRow).join('')+'</div>'+(visible.length<shown.length?'<button type="button" class="more-neighborhoods" id="atlas-more">Show '+Math.min(6,shown.length-visible.length)+' more neighborhoods <span>'+visible.length+' of '+shown.length+' shown</span></button>':''):'<div class="list-empty">'+(isSearch?'No neighborhood by that name. Try another name or explore a region.':'We’re still drawing this part of the atlas. There are more maps nearby.<br><button type="button" data-region="central">Explore Clearwater & Largo →</button>')+'</div>');
 }
 host.querySelectorAll('[data-region]').forEach(button => button.addEventListener('click', () => navigate({region:button.dataset.region,place:null,focusIds:null,search:'',limit:6},false)));
 host.querySelectorAll('[data-place]').forEach(button => button.addEventListener('click', () => choosePlace(button.dataset.place)));
 $('#atlas-more')?.addEventListener('click',()=>{state.limit=(state.limit||6)+6;history.replaceState({atlas:{...state}},'',location.href);renderResults();$('#atlas-more')?.focus({preventScroll:true});$('#view-status').textContent=state.limit+' neighborhood maps shown.';});
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
  markup = '<button class="back-link" type="button" id="panel-back">'+back+(state.focusIds?'All '+esc(region.name):'All Pinellas')+'</button><p class="eyebrow">'+esc(region.kicker)+'</p><h1 id="panel-title" class="region-name" tabindex="-1">'+esc(region.name)+'</h1><p class="intro">'+regionCopy[region.id]+'</p>'+searchMarkup()+'<div id="atlas-results"></div><p class="browse-note">Select a dot or a name for a closer look.</p>';
 } else {
  markup = '<p class="eyebrow">An illustrated field guide</p><h1 id="panel-title" tabindex="-1">Find your corner of Pinellas.</h1><p class="intro">Start with a region. Find a neighborhood. See where the little streets lead.</p>'+searchMarkup()+'<div id="atlas-results"></div>';
 }
 $('#panel-content').innerHTML = markup;
 if (place) loadCount(place.id);
 else {
  renderResults();
  const input = $('#atlas-search');
  input.addEventListener('input', () => { state.search=input.value;state.limit=6;renderResults(); });
  input.addEventListener('keydown', event => {
   if (event.key==='Escape') {state.search='';input.value='';renderResults();}
   if (event.key==='Enter') { const first=$('#atlas-results [data-place]'); if(first){event.preventDefault();choosePlace(first.dataset.place);} }
  });
  $('.clear-search').addEventListener('click', () => { state.search='';input.value='';renderResults();input.focus(); });
 }
 $('#panel-back')?.addEventListener('click', () => {
  if (state.place) navigate({place:null,search:''},true);
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
 if(record)writeHistory();
 renderPanel();
 const region=regions.get(state.region), place=places.get(state.place);
 $('#map-view-label').textContent=place?.name || region?.name || 'Choose a region';
 $('#map-hint').textContent=place?'A whole neighborhood awaits.':region?'Tap a group, or scroll for neighborhood names.':'Four regions. Plenty of little places.';
 surface.classList.toggle('is-regional',Boolean(region));
 $('#view-status').textContent=place?place.name+' preview opened.':region?region.name+' — '+availablePlaces().length+' neighborhood maps.':'Pinellas overview. Choose one of four regions.';
 fitView();
 if (record) $('#panel-title').focus({preventScroll:true});
 if (matchMedia('(max-width:720px)').matches) {
  if(scroll) $('.side-panel').scrollIntoView({behavior:reduced.matches?'auto':'smooth',block:'start'});
  else if(!state.place) window.scrollTo({top:0,behavior:reduced.matches?'auto':'smooth'});
 }
}
function choosePlace(id) {
 const place=places.get(id);if(!place)return;
 navigate({region:place.region,place:id,focusIds:state.region===place.region&&state.focusIds?.includes(place.id)?state.focusIds:null,search:''},true);
}
function projectBounds(bounds) {
 const [west,south,east,north]=bounds, a=point([west,north]),b=point([east,south]);
 return {x:a.x,y:a.y,w:b.x-a.x,h:b.y-a.y};
}
function shapeBounds() {
 if(state.place){const p=point([places.get(state.place).lng,places.get(state.place).lat]);return{x:p.x-90,y:p.y-90,w:180,h:180};}
 if(state.focusIds){const points=state.focusIds.map(id=>places.get(id)).filter(Boolean).map(p=>point([p.lng,p.lat]));const xs=points.map(p=>p.x),ys=points.map(p=>p.y);return{x:Math.min(...xs)-30,y:Math.min(...ys)-30,w:Math.max(60,Math.max(...xs)-Math.min(...xs)+60),h:Math.max(60,Math.max(...ys)-Math.min(...ys)+60)};}
 const bounds={north:[-82.88,27.98,-82.60,28.20],central:[-82.90,27.83,-82.58,28.04],south:[-82.81,27.68,-82.52,27.89],coast:[-82.91,27.59,-82.68,28.04]};
 return state.region?projectBounds(bounds[state.region]):projectBounds([-82.94,27.57,-82.50,28.21]);
}
function matchAspect(box) {
 const aspect=surface.clientWidth/surface.clientHeight,center={x:box.x+box.w/2,y:box.y+box.h/2};let {w,h}=box;
 if(w/h>aspect)h=w/aspect;else w=h*aspect;
 return{x:center.x-w/2,y:center.y-h/2,w,h};
}
function applyView(next){view=next;$('#atlas-map').setAttribute('viewBox',[view.x,view.y,view.w,view.h].join(' '));renderMarkers();renderCities();}
function animateTo(target){
 cancelAnimationFrame(animation);
 if(!view||reduced.matches){applyView(target);return;}
 const start={...view},time=performance.now();
 function step(now){const t=Math.min(1,(now-time)/430),ease=1-Math.pow(1-t,3);applyView(Object.fromEntries(['x','y','w','h'].map(key=>[key,start[key]+(target[key]-start[key])*ease])));if(t<1)animation=requestAnimationFrame(step);}
 animation=requestAnimationFrame(step);
}
function fitView(){animateTo(matchAspect(shapeBounds()));}
function screenPoint(place){const p=point([place.lng,place.lat]);return{x:(p.x-view.x)/view.w*surface.clientWidth,y:(p.y-view.y)/view.h*surface.clientHeight};}
function makeMarker(x,y,content,className,label,color){
 const button=document.createElement('button');button.type='button';button.className=className;button.style.left=x+'px';button.style.top=y+'px';button.style.setProperty('--region-color',color);button.setAttribute('aria-label',label);button.innerHTML=content;return button;
}
function renderMarkers(){
 if(!view||!data)return;
 const fragment=document.createDocumentFragment(),width=surface.clientWidth,height=surface.clientHeight;
 if(!state.region){
  data.regions.forEach((region,index)=>{
   const anchor=region.id==='south'?[-82.66,27.70]:region.id==='coast'?[-82.86,27.825]:region.anchor;
   const p=screenPoint({lng:anchor[0],lat:anchor[1]});const count=data.neighborhoods.filter(place=>place.region===region.id).length;
   const button=makeMarker(Math.max(80,Math.min(width-80,p.x)),Math.max(85,Math.min(height-65,p.y)),'<span class="region-number">0'+(index+1)+'</span><span><span class="region-marker-name">'+esc(region.name)+'</span><span class="region-marker-count">'+count+' '+(count===1?'map':'maps')+'</span></span>','region-marker',region.name+', '+count+' maps',colors[region.id]);
   button.dataset.region=region.id;button.addEventListener('click',()=>navigate({region:region.id,place:null,focusIds:null,search:'',limit:6},false));fragment.append(button);
  });
 } else if(state.place){
  const place=places.get(state.place),p=screenPoint(place);
  const button=makeMarker(p.x,p.y,'<span class="place-label">'+esc(place.name)+'</span>','place-marker selected',place.name+' selected',colors[place.region]);
  button.addEventListener('click',()=>$('#panel-title').focus({preventScroll:true}));fragment.append(button);
 } else {
  const shown=availablePlaces().filter(place=>!state.search || place.region===state.region).sort((a,b)=>a.name.localeCompare(b.name));
  const groups=[];
  for(const place of shown){const p=screenPoint(place);if(p.x<23||p.x>width-23||p.y<65||p.y>height-45)continue;let group=groups.find(g=>Math.hypot(p.x-g.x,p.y-g.y)<38);if(!group){group={x:p.x,y:p.y,items:[]};groups.push(group);}group.items.push(place);}
  for(const group of groups){const many=group.items.length>1,place=group.items[0];
   const button=makeMarker(group.x,group.y,many?String(group.items.length):'<span class="place-label">'+esc(place.name)+'</span>','place-marker'+(many?' cluster':''),many?group.items.length+' nearby neighborhood maps':place.name,colors[state.region]);
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
 const cities=[['Tarpon Springs',-82.755,28.148],['Dunedin',-82.774,28.025],['Clearwater',-82.795,27.98],['Largo',-82.79,27.91],['St. Petersburg',-82.635,27.75]];
 const group=$('#city-labels');group.replaceChildren();
 if(state.place)return;
 const scale=view.h/surface.clientHeight;
 for(const [name,lng,lat] of cities){const p=point([lng,lat]);const circle=document.createElementNS(svgNS,'circle');circle.setAttribute('cx',p.x);circle.setAttribute('cy',p.y);circle.setAttribute('r',2*scale);const text=document.createElementNS(svgNS,'text');text.setAttribute('x',p.x+6*scale);text.setAttribute('y',p.y+4*scale);text.setAttribute('font-size',Math.min(24,10*scale));text.textContent=name;group.append(circle,text);}
}
function zoom(factor){if(!view)return;cancelAnimationFrame(animation);const w=view.w*factor,h=view.h*factor;animateTo({x:view.x+(view.w-w)/2,y:view.y+(view.h-h)/2,w,h});}
async function boot(){
 const response=await fetch('./atlas-data.json');if(!response.ok)throw Error('The atlas could not load.');data=await response.json();
 places=new Map(data.neighborhoods.map(place=>[place.id,place]));regions=new Map(data.regions.map(region=>[region.id,region]));
 state=readState();drawCounty();writeHistory(true);navigate({},false,false);
 $('#county-button').addEventListener('click',()=>navigate({region:null,place:null,focusIds:null,search:''}));
 $('#zoom-in').addEventListener('click',()=>zoom(.7));$('#zoom-out').addEventListener('click',()=>zoom(1.4));$('#fit-map').addEventListener('click',fitView);
 window.addEventListener('popstate',event=>{const saved=event.state?.atlas;state=saved&&(!saved.region||regions.has(saved.region))&&(!saved.place||places.has(saved.place))?saved:readState();navigate({},false,false);});
 new ResizeObserver(()=>{cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(()=>{cancelAnimationFrame(animation);applyView(matchAspect(shapeBounds()));});}).observe(surface);
 matchMedia('(max-width:720px)').addEventListener('change',renderResults);
 document.body.dataset.ready='true';
}
boot().catch(error=>{$('#panel-content').innerHTML='<h1>The atlas couldn’t load.</h1><p>'+esc(error.message)+'</p><p><a href="/?season=halloween-2026">Open the neighborhood maps</a></p>';$('#view-status').textContent='The atlas could not load.';});
