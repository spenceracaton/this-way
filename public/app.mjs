import { createSubmission } from './submission.mjs';
import { initCommunityForms } from './community-forms.mjs';
import { initPhotoContribution } from './photo-contribution.mjs';
import { createNeighborhoodPicker } from './neighborhood-picker.mjs';
import { createDetail } from './detail.mjs';
import { createMap, createLocationPicker } from './map-view.mjs';
import { neighborhoodFor } from './neighborhoods.mjs';
import { loadService, api, toPin } from './service-client.mjs';
import { activeSeasonId, seasonFor } from './season-config.mjs';

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
  const requestedSeason = query.get('season');
  if (requestedSeason && !seasonFor(requestedSeason)) throw new Error(`Unknown season “${requestedSeason}”.`);
  // Do not expose illustrative sample counts while the service state is still
  // unknown; an enabled API failure must end in an error without sample data.
  $('#sample-count').textContent = 'Loading displays…';
  list.replaceChildren();
  $('#references-title').textContent = 'Displays';
  $('.references-heading > span').hidden = true;
  const service = await loadService();
  const demoSample = samplePins.some(pin => pin.id === query.get('sample'));
  const selectedSeasonId = requestedSeason || service?.season?.id || activeSeasonId;
  const selectedSeason = seasonFor(selectedSeasonId) || (!requestedSeason ? service?.season : null);
  if (!selectedSeason) throw new Error(`The listing service returned an unsupported season “${selectedSeasonId}”.`);
  if (requestedSeason && !service && !demoSample) throw new Error('Season listings are unavailable right now. Reload when the listing service is available.');
  const historical = Boolean(service && !demoSample && selectedSeasonId !== service.season.id);
  const seasonSelect = $('#season-select');
  if (![...seasonSelect.options].some(option => option.value === selectedSeasonId)) {
    const option = document.createElement('option');
    option.value = selectedSeasonId;
    option.textContent = `${selectedSeason.name} · Current`;
    seasonSelect.append(option);
  }
  seasonSelect.value = selectedSeasonId;
  seasonSelect.addEventListener('change', () => {
    const url = new URL(location.href);
    url.searchParams.set('season', seasonSelect.value);
    url.searchParams.delete('sample');
    url.searchParams.delete('listing');
    location.assign(url.pathname + url.search + url.hash);
  });
  if (historical) {
    $('#add-display').disabled = false;
    $('#add-display').setAttribute('aria-label', `Switch to ${service.season.name} to add a display`);
    $('#add-display').removeAttribute('aria-haspopup');
    $('#add-display').removeAttribute('aria-controls');
    $('#add-display').querySelector('[aria-hidden="true"]').hidden = true;
    $('#add-display-label').textContent = `Switch to ${service.season.name}`;
    $('#add-display').addEventListener('click', () => {
      const url = new URL(location.href);
      url.searchParams.set('season', service.season.id);
      url.searchParams.delete('sample');
      url.searchParams.delete('listing');
      location.assign(url.pathname + url.search + url.hash);
    });
  }
  let pins = samplePins;
  if (service && !demoSample) {
    const params = new URLSearchParams({ neighborhood: neighborhood.id, season: selectedSeasonId });
    const result = await api(`/api/listings?${params}`);
    if (!Array.isArray(result?.listings)) throw new Error('The listing service returned an invalid display list.');
    pins = result.listings.map((listing, index) => ({ ...toPin(listing, index), seasonId: selectedSeasonId, historical }));
  }
  document.title = service && !demoSample
    ? `This Way · ${neighborhood.name} · ${selectedSeason.name}${historical ? ' · Past season' : ''}`
    : `This Way · ${neighborhood.name}`;
  $('#map-title').textContent = neighborhood.name;
  createNeighborhoodPicker(neighborhood);
  $('#sample-count').textContent = service && !demoSample ? `${pins.length} ${historical ? `${selectedSeason.name} displays` : `live ${pins.length === 1 ? 'display' : 'displays'}`}` : (pins.length ? `${pins.length} sample addresses` : 'Map only');
  $('#map').setAttribute('aria-label', `Interactive ${neighborhood.name} map${pins.length ? ` with ${service && !demoSample ? historical ? 'past-season displays' : 'live displays' : 'sample addresses'}` : ''}. Arrow keys pan, plus and minus zoom, Home resets.`);
  if (service && !demoSample) {
    $('#references-title').textContent = historical ? `${selectedSeason.name} displays` : 'Live displays';
    $('.references-heading .eyebrow').textContent = 'COMMUNITY MAP';
    $('.references-heading > span').hidden = !historical;
    $('.references-heading > span').textContent = historical ? 'Past season' : '';
    $('.map-caption').textContent = 'Drag to explore the neighborhood';
    document.querySelector('footer > span').textContent = historical ? `Community map · past ${selectedSeason.name} displays` : 'Community map · live displays';
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
    $('#reference-list').textContent = service && !demoSample
      ? historical ? `No ${selectedSeason.name} displays in this neighborhood.` : 'No live displays here yet.'
      : 'No sample addresses here yet.';
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
      if (requestedSeason) params.set('season', selectedSeasonId);
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
  renderList(pins, service && !demoSample
    ? historical ? `No ${selectedSeason.name} displays in this neighborhood.` : 'No live displays here yet.'
    : 'No sample addresses here yet.');
  renderDetail = createDetail({ close: () => view.select(null), neighborhood: neighborhood.id, season: selectedSeason, historical });
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
      // Keep the marker in the open lane between the left zoom control and
      // bottom-right attribution, above the detail sheet.
      const credit = $('#map .leaflet-control-attribution')?.getBoundingClientRect();
      const creditCoversMap = credit && credit.top < card.top && credit.bottom > toolbar.bottom;
      return { left: zoom.right - map.left + 32, top: toolbar.bottom - map.top + 24,
        right: creditCoversMap ? map.right - credit.left + 32 : 32,
        bottom: map.bottom - card.top + 32 };
    },
    onAnchorChange: point => renderDetail.setAnchor(point),
    onViewChange({ zoom }) { $('#camera-status').textContent = `View ${zoom.toFixed(2)}`; }
  });
  const positionZoomControl = () => {
    const zoom = $('#map .leaflet-control-zoom');
    if (!zoom) return;
    if (matchMedia('(max-width:720px)').matches) {
      const map = $('#map').getBoundingClientRect();
      const toolbar = $('.map-toolbar').getBoundingClientRect();
      zoom.style.setProperty('margin-top', `${Math.ceil(toolbar.bottom - map.top + 12)}px`, 'important');
    } else zoom.style.removeProperty('margin-top');
    view.revealSelection();
  };
  positionZoomControl();
  const toolbarResize = new ResizeObserver(positionZoomControl);
  toolbarResize.observe($('.map-toolbar'));
  window.addEventListener('resize', positionZoomControl);
  matchMedia('(max-width:720px)').addEventListener('change', positionZoomControl);
  if (service && !demoSample && !historical) {
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
  } else if (!historical) createSubmission();
  initCommunityForms({ getSelected: () => selectedPin });
  $('[data-open-feedback]').disabled = false;
  initPhotoContribution({ getSelected: () => selectedPin, service: service && !demoSample ? service : null });
  if (!samplePins.length) {
    const credit = $('.leaflet-control-attribution');
    const creditResize = new ResizeObserver(() => $('.canvas').style.setProperty('--map-credit-height', credit.offsetHeight + 'px'));
    creditResize.observe(credit);
  }
  const referenceResize = new ResizeObserver(() => {
    $('.canvas').style.setProperty('--reference-height', $('.references').offsetHeight + 'px');
  });
  referenceResize.observe($('.references'));
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
  const link = document.createElement('a');
  link.href = './';
  link.textContent = 'Open the map home';
  $('#loading').replaceChildren(document.createTextNode(error.message + ' '), link);
  $('#loading').setAttribute('role', 'alert');
});
