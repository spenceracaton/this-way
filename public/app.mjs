import { createMap } from './map-view.mjs';
import { neighborhoodFor } from './neighborhoods.mjs';

const $ = selector => document.querySelector(selector);
const list = $('#reference-list');
let view;

function selectionChanged(pin) {
  for (const button of list.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.id === pin?.id));
  $('#selected-name').textContent = pin?.name || 'Choose a sample pin';
  $('#selected-note').textContent = pin?.note || 'Select a pin on the map or from the sample list.';
  $('#selected-label').textContent = pin?.label || '↗';
  $('#selection').dataset.selected = pin?.id || '';
}

async function start() {
  const query = new URLSearchParams(location.search);
  const neighborhood = neighborhoodFor(location.search);
  const samplePins = neighborhood.pins;
  document.title = `This Way · ${neighborhood.name}`;
  $('#map-title').textContent = neighborhood.name;
  $('#neighborhood-select').value = neighborhood.id;
  $('#sample-count').textContent = `${samplePins.length} sample locations`;
  $('#map').setAttribute('aria-label', `Interactive ${neighborhood.name} reference map. Arrow keys pan, plus and minus zoom, Home resets.`);
  $('#neighborhood-select').addEventListener('change', event => {
    const params = new URLSearchParams(location.search);
    params.set('neighborhood', event.target.value);
    location.search = params;
  });
  const diagnostic = query.get('diagnostic') === '1';
  const requestedMode = query.get('artwork');
  const artworkMode = diagnostic && ['full', 'raster', 'simple'].includes(requestedMode) ? requestedMode : 'raster';
  if (diagnostic) {
    $('#artwork-diagnostic').hidden = false;
    const labels = { full: 'Full SVG', raster: 'Rasterized artwork', simple: 'Plain rectangle' };
    $('#diagnostic-mode').textContent = labels[artworkMode];
    for (const link of document.querySelectorAll('#artwork-diagnostic a[data-mode]')) {
      const params = new URLSearchParams({ diagnostic: '1', artwork: link.dataset.mode });
      if (neighborhood.id !== 'old-northeast') params.set('neighborhood', neighborhood.id);
      link.href = `?${params}`;
      if (link.dataset.mode === artworkMode) link.setAttribute('aria-current', 'page');
    }
  }
  const response = await fetch(neighborhood.config);
  if (!response.ok) throw new Error('The neighborhood configuration could not load.');
  const area = await response.json();
  let artwork;
  if (artworkMode === 'raster') {
    artwork = document.createElement('img');
    artwork.id = 'neighborhood-artwork';
    artwork.alt = `Rasterized illustrated ${neighborhood.name} street map`;
    artwork.decoding = 'async';
    artwork.src = area.rasterArtwork;
    await artwork.decode();
  } else {
    const imageResponse = await fetch(area.artwork);
    if (!imageResponse.ok) throw new Error('The map artwork could not load.');
    artwork = new DOMParser().parseFromString(await imageResponse.text(), 'image/svg+xml').documentElement;
    if (artwork.localName !== 'svg' || artwork.querySelector('parsererror')) throw new Error('The map artwork is invalid.');
    // Isolate artwork cost without changing SVG-overlay sizing, map options,
    // geographic projection, bounds, markers, or input handlers.
    if (artworkMode === 'simple') {
      artwork.replaceChildren();
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', area.bounds.left);
      rect.setAttribute('y', area.bounds.top);
      rect.setAttribute('width', area.bounds.right - area.bounds.left);
      rect.setAttribute('height', area.bounds.bottom - area.bounds.top);
      rect.setAttribute('fill', '#dedbc0');
      artwork.append(rect);
      artwork.setAttribute('aria-label', 'Plain rectangle for artwork performance comparison');
    }
  }
  for (const pin of samplePins) {
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.id = pin.id; button.setAttribute('aria-pressed', 'false');
    const badge = document.createElement('span'); badge.className = 'reference-badge'; badge.textContent = pin.label;
    const name = document.createElement('span'); name.textContent = pin.name;
    button.append(badge, name); button.addEventListener('click', () => view.select(pin.id)); list.append(button);
  }
  view = createMap({ leaflet: window.L, element: $('#map'), area, pins: samplePins, artwork,
    onSelect: selectionChanged,
    onViewChange({ zoom }) { $('#camera-status').textContent = `View ${zoom.toFixed(2)}`; }
  });
  $('#reset').addEventListener('click', () => view.reset());
  $('#reset').disabled = false;
  $('#map').setAttribute('aria-busy', 'false');
  $('#loading').remove();
}
start().catch(error => {
  $('#loading').textContent = error.message + ' Start the included server and reload.';
  $('#loading').setAttribute('role', 'alert');
});
