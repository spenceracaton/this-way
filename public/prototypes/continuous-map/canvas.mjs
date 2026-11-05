import { api } from '../../service-client.mjs';
import { seasonFor } from '../../season-config.mjs';
import { studyNeighborhoods, studyViews, mergePublicFeeds } from './canvas-model.mjs';

const $ = selector => document.querySelector(selector);
const L = window.L;
const query = new URLSearchParams(location.search);
const season = seasonFor(query.get('season') || 'halloween-2026');
let map, context, artEntries = [], records = [], selected = null;
let artRevision = 0, activeArt = [], pins = new Map(), feedRevision = 0;
let loadedBounds, loadingLayers = 0, peakDecodedBytes = 0;
let expandedPins = false;
const pendingImages = new Set();
const options = $('#study-options');
const artLayers = L.layerGroup();
const pinLayers = L.layerGroup();
const labelLayers = L.layerGroup();
const selectedCard = $('#pin-card');
const openOptions = $('#open-options');

function announce(message) { $('#map-announcement').textContent = message; }
async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Map data could not load (${response.status}).`);
  return response.json();
}
function textIcon(text, className) {
  const node = document.createElement('span'); node.textContent = text;
  return L.divIcon({ className, html: node.outerHTML, iconSize: [0, 0], iconAnchor: [0, 0] });
}
function goTo(view) {
  select(null);
  map.invalidateSize({ pan: false });
  map.stop();
  if (view.bounds) map.fitBounds(view.bounds, { paddingTopLeft: [24, 74], paddingBottomRight: [24, 120], animate: false, maxZoom: 16 });
  else {
    // The same crossing camera must show real coordinates on a narrow phone,
    // rather than starting between two offscreen groups of published pins.
    const zoom = view === studyViews.crossing ? Math.min(view.zoom, map.getSize().x < 370 ? 15 : map.getSize().x < 650 ? 15.25 : 16) : view.zoom;
    map.setView(view.center, zoom, { animate: false });
  }
}
function closeOptions() { options.close(); openOptions.focus({ preventScroll: true }); }
function select(id) {
  selected = records.find(record => record.id === id) || null;
  for (const [key, marker] of pins) {
    marker.getElement()?.querySelector('button')?.setAttribute('aria-pressed', String(key === selected?.id));
    marker.setZIndexOffset(key === selected?.id ? 1000 : 0);
  }
  selectedCard.hidden = !selected;
  if (!selected) return;
  $('#pin-neighborhood').textContent = selected.neighborhood;
  $('#pin-address').textContent = selected.address;
  $('#pin-season').textContent = `${season.name} · published display`;
  map.panInside([selected.lat, selected.lng], { paddingTopLeft: [48, 72], paddingBottomRight: [88, Math.min(230, map.getSize().y * .48)], animate: false });
  announce(`${selected.address}, ${selected.neighborhood}. Published ${season.name} display.`);
}
function renderPins() {
  pinLayers.clearLayers(); pins.clear();
  const list = $('#coordinate-list'); list.replaceChildren();
  records.forEach((record, index) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'display-pin'; button.dataset.id = record.id;
    button.setAttribute('aria-label', `Select ${record.address}, ${record.neighborhood}`);
    button.setAttribute('aria-pressed', String(record.id === selected?.id));
    const number = document.createElement('span'); number.textContent = String(index + 1); button.append(number);
    const marker = L.marker([record.lat, record.lng], {
      keyboard: false,
      icon: L.divIcon({ className: 'display-marker', html: button.outerHTML, iconSize: [44, 44], iconAnchor: [22, 22] })
    });
    marker.on('click', event => {
      // Touch targets stay 44px, but their transparent rectangles may overlap
      // at overview scale. Resolve the actual pointer to the closest true
      // anchor so an adjacent rectangle cannot steal a tap on a visible dot.
      const original = event.originalEvent;
      const pointer = original?.changedTouches?.[0] || original;
      if (!Number.isFinite(pointer?.clientX) || !Number.isFinite(pointer?.clientY)) { select(record.id); return; }
      const bounds = $('#map').getBoundingClientRect();
      const x = pointer.clientX - bounds.left, y = pointer.clientY - bounds.top;
      let closest = record, best = Infinity;
      for (const candidate of records) {
        const point = map.latLngToContainerPoint([candidate.lat, candidate.lng]);
        const distance = (point.x-x)**2 + (point.y-y)**2;
        if (distance < best) { closest = candidate; best = distance; }
      }
      select(closest.id);
    });
    marker.on('add', () => {
      const control = marker.getElement().querySelector('button');
      control.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); select(record.id); }
      });
      control.addEventListener('focus', () => {
        if (control.matches(':focus-visible')) map.panInside([record.lat, record.lng], { paddingTopLeft: [48,72], paddingBottomRight: [88, selected ? Math.min(230, map.getSize().y*.48) : 125], animate: false });
      });
    });
    marker.addTo(pinLayers); pins.set(record.id, marker);
    const choice = document.createElement('button'); choice.type = 'button';
    const address = document.createElement('span'); address.textContent = `${index + 1}. ${record.address}`;
    const area = document.createElement('small'); area.textContent = record.neighborhood;
    choice.append(address, area);
    choice.addEventListener('click', () => { closeOptions(); select(record.id); });
    list.append(choice);
  });
  if (!records.length) list.textContent = 'No coordinates loaded. See the display service status above.';
  $('#list-count').textContent = `(${records.length})`;
  if (selected && !records.some(record => record.id === selected.id)) select(null);
  document.body.dataset.pins = String(records.length);
}
async function loadPins() {
  const revision = ++feedRevision;
  $('#feed-status').textContent = `Loading ${season.name} displays…`;
  $('#retry-feeds').disabled = true;
  const results = await Promise.allSettled(studyNeighborhoods.map(async neighborhood => {
    const params = new URLSearchParams({ neighborhood: neighborhood.id, season: season.id });
    const payload = await api(`/api/listings?${params}`, { signal: AbortSignal.timeout(15000) });
    // Validate each feed before combining, so one bad response is an explicit
    // incomplete feed rather than a zero count or an illustrative fallback.
    mergePublicFeeds([{ neighborhood, listings: payload?.listings }]);
    return { neighborhood, listings: payload.listings };
  }));
  if (revision !== feedRevision) return;
  const loaded = results.filter(result => result.status === 'fulfilled').map(result => result.value);
  const failed = results.length - loaded.length;
  let conflict = false;
  try { records = mergePublicFeeds(loaded); }
  catch { records = []; conflict = true; }
  renderPins();
  const complete = !failed && !conflict;
  document.body.dataset.feeds = complete ? 'complete' : loaded.length && !conflict ? 'partial' : 'unavailable';
  $('#feed-status').textContent = complete
    ? `${season.name} · ${records.length} published ${records.length === 1 ? 'display' : 'displays'}`
    : `${season.name} · ${records.length ? `${records.length} loaded · incomplete` : 'displays unavailable'}`;
  $('#feed-error').hidden = complete;
  $('#feed-error-copy').textContent = conflict ? 'Display coordinates conflict. Counts are unavailable.'
    : loaded.length ? 'One neighborhood’s displays could not load. Counts are incomplete.' : 'Displays could not load. The map is still available.';
  $('#data-scope').textContent = `${season.name}; ${loaded.length} of 2 neighborhood feeds loaded. ${complete ? 'Counts cover these two areas only.' : 'Counts are unavailable or incomplete.'}`;
  $('#retry-feeds').disabled = false;
}
function image(entry, url) {
  return new Promise((resolve, reject) => {
    const layer = L.imageOverlay(new URL(url, location.href).pathname, entry.bounds, { pane: 'studyArt', interactive: false, opacity: 1, className: 'study-artwork' });
    const release = () => { clearTimeout(timeout); pendingImages.delete(cancel); layer.off('load error'); };
    const cancel = () => {
      release();
      const element = layer.getElement();
      if (element) element.removeAttribute('src');
      layer.remove(); reject(new DOMException('Artwork selection changed.', 'AbortError'));
    };
    const timeout = setTimeout(() => { release(); layer.remove(); reject(new Error(`${entry.name} artwork timed out.`)); }, 20000);
    pendingImages.add(cancel);
    layer.once('load', () => { release(); resolve(layer); });
    layer.once('error', () => { release(); layer.remove(); reject(new Error(`${entry.name} artwork could not load.`)); });
    layer.addTo(artLayers);
  });
}
async function updateArt() {
  const revision = ++artRevision;
  const mode = $('#art-mode').value, spotlight = $('#art-treatment').value === 'spotlight';
  for (const cancel of [...pendingImages]) cancel();
  artLayers.clearLayers(); activeArt = [];
  $('#art-error').hidden = true; $('#art-treatment').disabled = mode === 'base';
  document.body.dataset.art = mode;
  if (mode === 'base') { loadingLayers = 0; document.body.dataset.artLoaded = '0'; $('#art-status').textContent = 'Base geography only. Artwork images removed; geographic pins stay in place.'; renderLabels(); return; }
  const targets = artEntries.filter(entry => mode === 'both' || entry.id === mode);
  document.body.dataset.artLoaded = 'loading';
  loadingLayers = targets.length;
  $('#art-status').textContent = 'Loading artwork; geographic pins stay in place…';
  const results = await Promise.allSettled(targets.map(async entry => {
    const url = spotlight ? entry.spotlightUrl : entry.url;
    if (!url) throw new Error(`${entry.name} has no verified spotlight derivative.`);
    const layer = await image(entry, url);
    return { entry, layer };
  }));
  if (revision !== artRevision) { for (const result of results) if (result.status === 'fulfilled') result.value.layer.remove(); return; }
  loadingLayers = 0;
  activeArt = results.filter(result => result.status === 'fulfilled').map(result => result.value);
  const bytes = activeArt.reduce((sum, {entry}) => sum + entry.decodedBytes, 0);
  peakDecodedBytes = Math.max(peakDecodedBytes, bytes);
  $('#art-status').textContent = `${activeArt.length} artwork ${activeArt.length === 1 ? 'image' : 'images'} · ${(bytes / 1048576).toFixed(1)} MiB estimated RGBA; browser/GPU memory is additional.`;
  if (activeArt.length !== targets.length) {
    $('#art-error').hidden = false;
    $('#art-error-copy').textContent = 'Some artwork could not load. Geographic context and pins remain available.';
  }
  document.body.dataset.artLoaded = String(activeArt.length);
  renderLabels();
}
function renderLabels() {
  if (!map || !context) return;
  labelLayers.clearLayers();
  const groups = new Map();
  for (const feature of context.features) {
    if (feature.properties.kind !== 'road' || !feature.properties.name) continue;
    const coordinates = feature.geometry.type === 'LineString' ? feature.geometry.coordinates : feature.geometry.type === 'MultiLineString' ? feature.geometry.coordinates.flat() : [];
    if (!coordinates.length) continue;
    const key = feature.properties.name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(...coordinates);
  }
  const occupied = [];
  const candidates = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [name, coordinates] of candidates) {
    const inside = coordinates.filter(([lng, lat]) => map.getBounds().contains([lat, lng]));
    if (!inside.length) continue;
    const [lng, lat] = inside[Math.floor(inside.length / 2)];
    if (activeArt.some(({entry}) => L.latLngBounds(entry.bounds).contains([lat, lng]))) continue;
    const point = map.latLngToContainerPoint([lat, lng]);
    const width = Math.min(160, name.length * 6.5);
    const box = { x: point.x, y: point.y, width, height: 20 };
    if (point.x < 10 || point.y < 60 || point.x + width > map.getSize().x - 60 || point.y > map.getSize().y - 130) continue;
    if (occupied.some(other => box.x < other.x + other.width + 20 && box.x + box.width + 20 > other.x && box.y < other.y + 32 && box.y + 32 > other.y)) continue;
    occupied.push(box);
    L.marker([lat, lng], { icon: textIcon(name, 'base-label'), interactive: false, keyboard: false }).addTo(labelLayers);
    if (occupied.length >= 16) break;
  }
}
function cameraReadout() {
  const {lat, lng} = map.getCenter();
  $('#camera-readout').textContent = `Camera ${lat.toFixed(5)}, ${lng.toFixed(5)} · zoom ${map.getZoom().toFixed(2)}`;
  document.body.dataset.zoom = map.getZoom().toFixed(2);
  // At overview scale show accurate point anchors, not overlapping numbered
  // faces. Enter/exit at different settled zooms; selected records stay prominent.
  if (map.getZoom() >= 16) expandedPins = true;
  else if (map.getZoom() <= 15.5) expandedPins = false;
  document.body.dataset.pinStyle = expandedPins ? 'numbered' : 'points';
}
function renderCredits(notices) {
  const entries = notices.sources || notices.attributions || [];
  const target = $('#source-notices');
  const credits = [];
  for (const source of entries) {
    const name = source.label || source.name || source.source || 'Geography source';
    const url = source.url || source.serviceUrl;
    const paragraph = document.createElement('p');
    const link = document.createElement('a'); link.textContent = name;
    if (typeof url === 'string' && url.startsWith('https://')) { link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    paragraph.append(link);
    if (source.note) paragraph.append(document.createTextNode(` — ${source.note}`));
    target.append(paragraph);
    credits.push(link.outerHTML);
  }
  const osm = document.createElement('a'); osm.href = 'https://www.openstreetmap.org/copyright'; osm.textContent = '© OpenStreetMap contributors';
  credits.push(osm.outerHTML);
  map.attributionControl.setPrefix(false);
  map.attributionControl.addAttribution(credits.join(' · '));
}
async function start() {
  if (!season) throw new Error('Unknown display season. Use halloween-2026 or christmas-2026.');
  const [geography, artwork, notices] = await Promise.all([json('./data/context.geojson'), json('./data/artwork.json'), json('./data/source-notices.json')]);
  context = geography; artEntries = artwork;
  const bbox = context.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4) throw new Error('The context coverage bounds are missing.');
  loadedBounds = L.latLngBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]]);
  map = L.map($('#map'), {
    minZoom: 14, maxZoom: 18, zoomSnap: .25, zoomDelta: .5,
    zoomControl: false, zoomAnimation: false, markerZoomAnimation: false,
    attributionControl: true, keyboard: true, maxBounds: loadedBounds.pad(.05), maxBoundsViscosity: 1,
    preferCanvas: true
  });
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  map.createPane('studyArt');
  map.getPane('studyArt').style.zIndex = '450';
  L.rectangle(loadedBounds, { stroke: true, color: '#b9bfa6', weight: 1, dashArray: '4 5', fill: true, fillColor: '#f0efd9', fillOpacity: 1, interactive: false }).addTo(map);
  const renderer = L.canvas({ padding: .3 });
  L.geoJSON(context, {
    renderer,
    interactive: false,
    style: feature => feature.properties.kind === 'water'
      ? { stroke: true, color: '#bdcfca', weight: 1, fillColor: '#dce6e1', fillOpacity: 1 }
      : { color: '#c5c6ab', weight: 2, opacity: .9, lineCap: 'round', fill: false }
  }).addTo(map);
  artLayers.addTo(map); labelLayers.addTo(map); pinLayers.addTo(map);
  renderCredits(notices);
  map.on('moveend zoomend', () => { renderLabels(); cameraReadout(); });
  map.on('click', () => select(null));
  const resize = new ResizeObserver(() => map.invalidateSize({ pan: false })); resize.observe($('#map'));
  $('#map').addEventListener('keydown', event => {
    if (event.key === 'Home' && event.target === $('#map')) { event.preventDefault(); goTo(studyViews.crossing); }
    if (event.key === 'Escape') { select(null); }
  });
  openOptions.addEventListener('click', () => options.showModal());
  $('#close-options').addEventListener('click', closeOptions);
  options.addEventListener('click', event => { if (event.target === options) { const b = options.getBoundingClientRect(); if (event.clientX < b.left || event.clientX > b.right || event.clientY < b.top || event.clientY > b.bottom) closeOptions(); } });
  for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => { goTo(studyViews[button.dataset.view]); closeOptions(); });
  $('#art-mode').addEventListener('change', updateArt); $('#art-treatment').addEventListener('change', updateArt);
  $('#retry-art').addEventListener('click', updateArt); $('#retry-feeds').addEventListener('click', loadPins);
  $('#close-pin').addEventListener('click', () => { const id = selected?.id; select(null); pins.get(id)?.getElement()?.querySelector('button')?.focus({ preventScroll: true }); });
  goTo(studyViews[query.get('view')] || studyViews.crossing);
  $('#loading').hidden = true; $('#map').setAttribute('aria-busy', 'false');
  document.body.dataset.ready = 'true';
  // Read-only diagnostics for cloud/device acceptance; no private DTOs, photos,
  // secret config or state-changing service calls are exposed here.
  window.canvasStudy = {
    camera: () => ({ lat: map.getCenter().lat, lng: map.getCenter().lng, zoom: map.getZoom() }),
    project: point => { const p = map.latLngToContainerPoint(point); return { x: p.x, y: p.y }; },
    view: name => { if (studyViews[name]) goTo(studyViews[name]); },
    diagnostics: () => ({ activeArtwork: activeArt.length, loadingLayers, peakEstimatedRGBABytes: peakDecodedBytes, pins: records.length, feeds: document.body.dataset.feeds, bounds: loadedBounds.toBBoxString() })
  };
  await Promise.all([updateArt(), loadPins()]);
}
start().catch(error => {
  $('#loading').textContent = `${error.message} Reload to retry.`;
  $('#map').setAttribute('aria-busy', 'false'); document.body.dataset.ready = 'error';
  $('#feed-status').textContent = 'Study unavailable';
});
