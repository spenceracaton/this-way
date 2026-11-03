import { createSubmission } from './submission.mjs';
import { initCommunityForms } from './community-forms.mjs';
import { initPhotoContribution } from './photo-contribution.mjs';
import { createNeighborhoodPicker } from './neighborhood-picker.mjs';
import { createDetail } from './detail.mjs';
import { createMap, createLocationPicker } from './map-view.mjs';
import { neighborhoodFor } from './neighborhoods.mjs';
import { loadService, api, toPin } from './service-client.mjs';

const $ = selector => document.querySelector(selector);
const list = $('#reference-list');
let view, renderDetail, selectedPin = null;

function selectionChanged(pin) {
  selectedPin = pin;
  for (const button of list.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.id === pin?.id));
  renderDetail.select(pin, document.activeElement?.closest('[data-id], [data-pin]'));
}

async function start() {
  const query = new URLSearchParams(location.search);
  const neighborhood = neighborhoodFor(location.search);
  const samplePins = neighborhood.pins;
  // Do not expose illustrative sample counts while the service state is still
  // unknown; an enabled API failure must end in an error without sample data.
  $('#sample-count').textContent = 'Loading displays…';
  list.replaceChildren();
  $('#references-title').textContent = 'Displays';
  $('.references-heading > span').hidden = true;
  const service = await loadService();
  const demoSample = samplePins.some(pin => pin.id === query.get('sample'));
  let pins = samplePins;
  if (service && !demoSample) {
    const params = new URLSearchParams({ neighborhood: neighborhood.id, season: service.season.id });
    const result = await api(`/api/listings?${params}`);
    if (!Array.isArray(result?.listings)) throw new Error('The listing service returned an invalid display list.');
    pins = result.listings.map(toPin);
  }
  document.title = `This Way · ${neighborhood.name}`;
  $('#map-title').textContent = neighborhood.name;
  createNeighborhoodPicker(neighborhood);
  $('#sample-count').textContent = service && !demoSample ? `${pins.length} live ${pins.length === 1 ? 'display' : 'displays'}` : (pins.length ? `${pins.length} sample addresses` : 'Map only');
  $('#map').setAttribute('aria-label', `Interactive ${neighborhood.name} map${pins.length ? ` with ${service && !demoSample ? 'live displays' : 'sample addresses'}` : ''}. Arrow keys pan, plus and minus zoom, Home resets.`);
  if (service && !demoSample) {
    $('#references-title').textContent = 'Live displays';
    $('.references-heading .eyebrow').textContent = 'COMMUNITY MAP';
    $('.references-heading > span').hidden = true;
    $('.map-caption').textContent = 'Drag to explore the neighborhood';
    document.querySelector('footer > span').textContent = 'Community map · live displays';
    document.querySelector('footer .footer-tools a').textContent = 'Review photos';
  }
  if (!pins.length) {
    $('.canvas').classList.add('map-only');
    // Keep the empty state outside the canvas so mobile can reserve a row
    // below the map, including after the visitor zooms.
    $('.canvas').after($('.references'));
    $('#references-title').textContent = 'Explore the map';
    $('.references-heading .eyebrow').textContent = 'NEIGHBORHOOD MAP';
    $('.references-heading > span').hidden = true;
    $('#reference-list').textContent = service && !demoSample ? 'No live displays here yet.' : 'No sample addresses here yet.';
    $('.map-caption').textContent = 'Drag to explore the neighborhood';
  }
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
    artwork.id = 'neighborhood-artwork';
    artwork.setAttribute('role', 'img');
    artwork.setAttribute('aria-label', `Illustrated ${neighborhood.name} street map`);
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
  const renderList = (items, emptyText = '') => {
    list.replaceChildren();
    if (!items.length) { list.textContent = emptyText; return; }
    for (const pin of items) {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.id = pin.id; button.setAttribute('aria-pressed', 'false');
      const badge = document.createElement('span'); badge.className = 'reference-badge'; badge.textContent = pin.label;
      const name = document.createElement('span'); name.textContent = pin.name;
      button.append(badge, name); button.addEventListener('click', () => view.select(pin.id)); list.append(button);
    }
  };
  renderList(pins, service && !demoSample ? 'No live displays here yet.' : 'No sample addresses here yet.');
  renderDetail = createDetail({ close: () => view.select(null), neighborhood: neighborhood.id });
  view = createMap({ leaflet: window.L, element: $('#map'), area, pins, artwork,
    onSelect: selectionChanged,
    overviewInsets() {
      if (!matchMedia('(max-width:720px)').matches || !$('.canvas').classList.contains('map-only')) return;
      const map = $('#map').getBoundingClientRect();
      const toolbar = $('.map-toolbar').getBoundingClientRect();
      const credit = $('.leaflet-control-attribution')?.getBoundingClientRect();
      return { left: 28, right: 28, top: Math.max(28, toolbar.bottom - map.top + 12),
        bottom: Math.max(28, (credit?.height || 0) + 20) };
    },
    selectionInsets() {
      const sheet = $('#selection');
      if (!matchMedia('(max-width:720px)').matches || sheet.hidden) return;
      const map = $('#map').getBoundingClientRect();
      const card = sheet.getBoundingClientRect();
      const toolbar = $('.map-toolbar').getBoundingClientRect();
      const zoom = $('.leaflet-control-zoom').getBoundingClientRect();
      // Wide, short screens use a side sheet to preserve useful map space.
      if (card.left > map.left + 1) return { left: 32,
        top: Math.max(toolbar.bottom, zoom.bottom) - map.top + 32,
        right: map.right - card.left + 32, bottom: 32 };
      // Leave a full marker and breathing room above the card, away from controls.
      return { left: 32, top: toolbar.bottom - map.top + 32,
        right: map.right - zoom.left + 32, bottom: map.bottom - card.top + 32 };
    },
    onAnchorChange: point => renderDetail.setAnchor(point),
    onViewChange({ zoom }) { $('#camera-status').textContent = `View ${zoom.toFixed(2)}`; }
  });
  if (service && !demoSample) {
    createSubmission({ service, neighborhood, chooseLocation: element => createLocationPicker({ leaflet: window.L, element, area, artwork }),
      onPublished(listing) {
        const pin = toPin(listing, pins.length);
        pins = [...pins, pin]; view.setPins(pins); renderList(pins);
        if (pins.length === 1) {
          $('.canvas').insertBefore($('.references'), $('#selection'));
          $('.canvas').classList.remove('map-only');
          $('#references-title').textContent = 'Live displays';
          $('.references-heading .eyebrow').textContent = 'COMMUNITY MAP';
          $('.references-heading > span').hidden = true;
          $('#map').setAttribute('aria-label', `Interactive ${neighborhood.name} map with live displays. Arrow keys pan, plus and minus zoom, Home resets.`);
        }
        $('#sample-count').textContent = `${pins.length} live ${pins.length === 1 ? 'display' : 'displays'}`;
        view.select(pin.id);
      }
    });
  } else createSubmission();
  initCommunityForms({ getSelected: () => selectedPin });
  $('[data-open-feedback]').disabled = false;
  initPhotoContribution({ getSelected: () => selectedPin, service: service && !demoSample ? service : null });
  if (!samplePins.length) {
    const credit = $('.leaflet-control-attribution');
    const creditResize = new ResizeObserver(() => $('.canvas').style.setProperty('--map-credit-height', credit.offsetHeight + 'px'));
    creditResize.observe(credit);
  }
  // A card can grow after fonts/images load or after viewport rotation. Only
  // layout changes reveal it again; ordinary user pan/zoom remains untouched.
  const sheetResize = new ResizeObserver(() => view.revealSelection());
  sheetResize.observe($('#selection'));
  sheetResize.observe($('#map'));
  matchMedia('(max-width:720px)').addEventListener('change', () => view.revealSelection());
  if (pins.some(pin => pin.id === query.get('sample') || pin.id === query.get('listing'))) view.select(query.get('listing') || query.get('sample'));
  $('#reset').addEventListener('click', () => view.reset());
  $('#reset').disabled = false;
  $('#map').setAttribute('aria-busy', 'false');
  $('#loading').remove();
}
start().catch(error => {
  $('#loading').textContent = error.message + ' Start the included server and reload.';
  $('#loading').setAttribute('role', 'alert');
});
