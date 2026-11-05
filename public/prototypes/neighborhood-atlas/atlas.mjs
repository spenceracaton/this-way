import {seasonFor} from '/season-config.mjs';
import {countyBounds, minimumOverviewZoom, cities} from '../discovery-map/discovery-model.mjs';

const query=new URLSearchParams(location.search);
const season=seasonFor(query.get('season')||'halloween-2026');
const $=selector=>document.querySelector(selector);
const links=[],areas=L.layerGroup(),labels=L.layerGroup();
let map;

async function json(url){const response=await fetch(url,{signal:AbortSignal.timeout(20000)});if(!response.ok)throw new Error('The atlas could not load. Reload to try again.');return response.json();}
function localLink(id){
  const center=map.getCenter();
  return '/?'+new URLSearchParams({neighborhood:id,season:season.id,atlas:'1',atlas_lat:center.lat.toFixed(6),atlas_lng:center.lng.toFixed(6),atlas_z:String(map.getZoom())});
}
function enter(id){location.assign(localLink(id));}
function cityView(){map.setView([27.789,-82.637],13.75,{animate:false});}
function countyView(){map.fitBounds(countyBounds,{paddingTopLeft:[24,110],paddingBottomRight:[65,65],maxZoom:11.5,animate:false});}
function render(){
  const near=map.getZoom()>=13;
  for(const layer of [areas,labels]){if(near&&!map.hasLayer(layer))layer.addTo(map);else if(!near&&map.hasLayer(layer))map.removeLayer(layer);}
  const center=map.getCenter();
  const nearest=[...cities].sort((a,b)=>map.distance(center,[a.lat,a.lng])-map.distance(center,[b.lat,b.lng]))[0];
  $('#view-title').textContent=near?nearest.name:'Pinellas County';
  $('#view-help').textContent=near?'Choose a neighborhood to explore its illustrated map.':'Return to St. Pete to try the two illustrated neighborhoods.';
  $('#change-view').textContent=near?'Pinellas':'St. Pete';
  for(const {id,node}of links)node.href=localLink(id);
  const url=new URL(location.href);
  url.searchParams.set('lat',center.lat.toFixed(6));url.searchParams.set('lng',center.lng.toFixed(6));url.searchParams.set('z',String(map.getZoom()));url.searchParams.set('season',season.id);
  history.replaceState(null,'',url.pathname+url.search);
  document.body.dataset.zoom=String(map.getZoom());
}
async function start(){
  if(!season)throw new Error('This season is not available.');
  const[geography,artAreas]=await Promise.all([json('../discovery-map/data/context.geojson'),json('./areas.geojson')]);
  map=L.map('atlas',{center:[27.789,-82.636],zoom:13.5,minZoom:minimumOverviewZoom(innerHeight),maxZoom:15,zoomSnap:.25,zoomDelta:.5,zoomControl:false,attributionControl:false,zoomAnimation:false,markerZoomAnimation:false,maxBounds:[[27.4,-83.1],[28.4,-82.35]],maxBoundsViscosity:.8});
  L.control.zoom({position:'bottomright'}).addTo(map);
  L.control.attribution({position:'bottomleft',prefix:false}).addAttribution('<a href="../discovery-map/data/source-notices.json">Census · Pinellas GIS · USGS</a> · <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>').addTo(map);
  const renderer=L.canvas({padding:.2});
  L.geoJSON(geography,{renderer,interactive:false,filter:f=>f.properties.kind==='county'||f.properties.kind==='water',style:f=>f.properties.kind==='county'?{color:'#b5b79f',weight:1.3,fillColor:'#f3edda',fillOpacity:1}:{color:'#b6acbe',weight:1,fillColor:'#d4cddd',fillOpacity:1}}).addTo(map);
  L.geoJSON(geography,{renderer,interactive:false,filter:f=>f.properties.kind==='road'&&/Interstate|Highway|Arterial/.test(f.properties.class||''),style:{color:'#c4b4bf',weight:1.3,opacity:.6}}).addTo(map);
  areas.addTo(map);labels.addTo(map);
  L.geoJSON(artAreas,{style:f=>({stroke:false,fillColor:f.properties.id==='old-northeast'?'#c1cb9c':'#c2b3d1',fillOpacity:.75}),onEachFeature:(feature,layer)=>{layer.on('click',()=>enter(feature.properties.id));}}).addTo(areas);
  for(const feature of artAreas.features){
    const{id,name,label}=feature.properties;
    const anchor=document.createElement('a');anchor.className='area-name';anchor.dataset.neighborhood=id;anchor.setAttribute('aria-label',`Explore ${name} illustrated map`);
    const words=name.split(' ');anchor.append(document.createTextNode(words[0]),document.createElement('br'),document.createTextNode(words.slice(1).join(' ')));
    const host=document.createElement('div');host.append(anchor);
    const marker=L.marker(label,{keyboard:false,icon:L.divIcon({className:'area-label',html:host.innerHTML,iconSize:[130,55],iconAnchor:[65,27]})}).addTo(labels);
    const node=marker.getElement().querySelector('a');L.DomEvent.disableClickPropagation(node);links.push({id,node});
  }
  for(const city of cities)L.marker([city.lat,city.lng],{keyboard:false,interactive:false,icon:L.divIcon({className:'city-label',html:`<span class="city-name">${city.name}</span>`,iconSize:[0,0]})}).addTo(map);
  const lat=Number(query.get('lat')),lng=Number(query.get('lng')),z=Number(query.get('z'));
  if(['lat','lng','z'].every(k=>query.has(k))&&Number.isFinite(lat)&&lat>=27.4&&lat<=28.4&&Number.isFinite(lng)&&lng>=-83.1&&lng<=-82.35&&Number.isFinite(z)&&z>=9.75&&z<=15)map.setView([lat,lng],z,{animate:false});else cityView();
  map.on('moveend zoomend',render);render();
  $('#change-view').onclick=()=>map.getZoom()>=13?countyView():cityView();
  new ResizeObserver(()=>{map.invalidateSize({pan:false});map.setMinZoom(minimumOverviewZoom(innerHeight));render();}).observe(document.querySelector('main'));
  $('#loading').hidden=true;document.body.dataset.ready='true';
  window.neighborhoodAtlas={camera:()=>({lat:map.getCenter().lat,lng:map.getCenter().lng,zoom:map.getZoom()})};
}
start().catch(error=>{$('#loading').textContent=error.message;document.body.dataset.ready='error';});
