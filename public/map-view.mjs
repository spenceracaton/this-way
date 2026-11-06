import { project, mapPoint, mapBounds } from './coordinates.mjs';

// A compact neighborhood-local pin picker used from the submission dialog.
// Its crosshair represents the map center, so keyboard panning and zooming
// work through Leaflet's normal accessible map controls.
export async function createLocationPicker({ leaflet: L, element, area, artwork }) {
  const bounds = L.latLngBounds(mapBounds(area.bounds));
  const map = L.map(element, { crs: L.CRS.Simple, minZoom: -3, maxZoom: 2, zoomSnap: 0.5,
    zoomControl: false, attributionControl: true, keyboard: true, maxBounds: bounds, maxBoundsViscosity: 1 });
  L.control.zoom({ position: 'topleft' }).addTo(map);
  const overlayArtwork = artwork.localName === 'svg' ? artwork.cloneNode(true) : artwork;
  (artwork.localName === 'svg' ? L.svgOverlay(overlayArtwork, bounds, { interactive: false }) : L.imageOverlay(overlayArtwork.src, bounds, { interactive: false })).addTo(map);
  const pickerCredits = [attributionLink(area.attribution) || attributionLink({ label: '© OpenStreetMap contributors', href: 'https://www.openstreetmap.org/copyright' }), attributionLink(area.license && area.licenseUrl ? { label: area.license, href: area.licenseUrl } : null), ...(Array.isArray(area.additionalAttributions) ? area.additionalAttributions.map(attributionLink) : [])].filter(Boolean);
  if (pickerCredits.length) map.attributionControl.addAttribution(pickerCredits.join(' · '));
  map.fitBounds(bounds, { padding: [14, 14], animate: false });
  const resize = new ResizeObserver(() => map.invalidateSize({ pan: false })); resize.observe(element);
  return {
    getPosition() {
      const center = map.getCenter();
      const x = center.lng, y = -center.lat, p = area.projection;
      return { lat: p.latOrigin - (y - p.yOrigin) / p.yScale, lng: p.lngOrigin + (x - p.xOrigin) / p.xScale };
    },
    destroy() { resize.disconnect(); map.remove(); }
  };
}

// The complete renderer boundary. No data fetching, forms, storage, or detail-card DOM.
export function createMap({ leaflet: L, element, area, pins: initialPins, artwork, onSelect, onViewChange, onAnchorChange, selectionInsets, overviewInsets, preferNearestPin = false, openingCamera }) {
  let pins = [...initialPins];
  const bounds = L.latLngBounds(mapBounds(area.bounds));
  const overviewBounds = area.overviewBounds ? L.latLngBounds(mapBounds(area.overviewBounds)) : bounds;
  const map = L.map(element, {
    crs: L.CRS.Simple, minZoom: -4, maxZoom: 4,
    zoomSnap: 0, zoomDelta: 0.5, zoomControl: false,
    // Leaflet discards new drags during its 250 ms zoom transition. Keep pinch
    // movement continuous, but finish zoom immediately so the next drag works.
    zoomAnimation: false, markerZoomAnimation: false,
    maxBounds: bounds.pad(0.3), maxBoundsViscosity: 0.7,
    attributionControl: true
  });
  L.control.zoom({ position: 'topright' }).addTo(map);
  const artworkOverlay = artwork.localName === 'svg'
    ? L.svgOverlay(artwork, bounds, { interactive: false })
    : L.imageOverlay(artwork, bounds, { interactive: false });
  artworkOverlay.addTo(map);
  // Attribution comes from a small, validated text/link structure in map
  // configuration; never insert configuration-provided HTML.
  const attribution = attributionLink(area.attribution) ||
    attributionLink({ label: '© OpenStreetMap contributors', href: 'https://www.openstreetmap.org/copyright' });
  const license = attributionLink(area.license && area.licenseUrl
    ? { label: area.license, href: area.licenseUrl }
    : null);
  const additional = (Array.isArray(area.additionalAttributions) ? area.additionalAttributions : []).map(attributionLink).filter(Boolean);
  map.attributionControl.addAttribution([attribution, ...additional, license].filter(Boolean).join(' · '));

  let selected = null;
  const markers = new Map();
  let sheetBounds = false;
  function select(id) {
    selected = id;
    for (const [key, marker] of markers) {
      const button = marker.getElement()?.querySelector('button');
      button?.classList.toggle('is-selected', key === id);
      button?.setAttribute('aria-pressed', String(key === id));
      marker.setZIndexOffset(key === id ? 1000 : 0);
    }
    onSelect(pins.find(pin => pin.id === id) || null);
    reportAnchor();
    revealSelection();
  }
  function revealSelection() {
    const marker = markers.get(selected);
    const insets = marker && selectionInsets?.();
    const needsSheetBounds = Boolean(insets);
    if (needsSheetBounds !== sheetBounds) {
      sheetBounds = needsSheetBounds;
      // At overview zoom the original bounds prevent a marker from moving into
      // the small map area above a photo sheet. Keep that camera space available
      // only while a mobile detail sheet is open.
      map.setMaxBounds(bounds.pad(sheetBounds ? 1 : 0.3));
    }
    if (!marker) return;
    map.panInside(marker.getLatLng(), {
      paddingTopLeft: [insets?.left ?? 40, insets?.top ?? 40],
      paddingBottomRight: [insets?.right ?? 40, insets?.bottom ?? 40],
      animate: false
    });
  }
  function addPin(pin) {
    // Build and serialize through the DOM so live address/title text is escaped.
    const button = document.createElement('button');
    button.className = 'map-pin'; button.type = 'button';
    button.setAttribute('aria-label', `Select ${pin.live ? 'display' : 'sample'} ${pin.label}: ${pin.name}`);
    button.setAttribute('aria-pressed', 'false'); button.dataset.pin = pin.id;
    button.textContent = pin.label;
    const icon = L.divIcon({ className: 'reference-marker', iconSize: [44, 44], iconAnchor: [22, 22], html: button.outerHTML });
    const marker = L.marker(mapPoint(project(pin, area.projection)), { icon, keyboard: false, title: pin.name })
      .on('click', event => {
        let id=pin.id;
        const original=event?.originalEvent, pointer=original?.changedTouches?.[0]||original;
        if(preferNearestPin && original?.detail!==0 && Number.isFinite(pointer?.clientX) && Number.isFinite(pointer?.clientY)) {
          const point=map.mouseEventToContainerPoint(pointer);let distance=32**2;
          for(const[key,candidate]of markers) {
            const anchor=map.latLngToContainerPoint(candidate.getLatLng()),d=(point.x-anchor.x)**2+(point.y-anchor.y)**2;
            if(d<distance){distance=d;id=key;}
          }
        }
        select(id);
      })
      .on('add', event => {
        event.target.getElement().querySelector('button').addEventListener('keydown', key => {
          if (key.key === 'Enter' || key.key === ' ') {
            key.preventDefault(); key.stopPropagation(); select(pin.id);
          }
        });
      }).addTo(map);
    markers.set(pin.id, marker);
  }
  pins.forEach(addPin);
  map.on('click', () => select(null));
  element.addEventListener('keydown', event => {
    if (event.key === 'Escape') { select(null); event.preventDefault(); }
    if (event.key === 'Home' && event.target === element) { reset(); event.preventDefault(); }
  });
  function reset() {
    map.stop();
    select(null);
    const insets = overviewInsets?.();
    map.fitBounds(overviewBounds, { paddingTopLeft: [insets?.left ?? 28, insets?.top ?? 28],
      paddingBottomRight: [insets?.right ?? 28, insets?.bottom ?? 28], animate: false, reset: true });
    const camera = openingCamera?.(element.clientWidth, element.clientHeight);
    if (camera) map.setView([-camera.y, camera.x], camera.zoom, { animate: false });
  }
  function reportView() {
    onViewChange?.({ zoom: map.getZoom(), selected });
  }
  function reportAnchor() {
    const marker = markers.get(selected);
    if (marker) onAnchorChange?.(map.latLngToContainerPoint(marker.getLatLng()));
  }
  map.on('move zoom resize', reportAnchor);
  map.on('moveend zoomend', reportView);
  const resize = new ResizeObserver(() => map.invalidateSize({ pan: false }));
  resize.observe(element);
  reset();
  return {
    reset,
    select,
    setPins(nextPins) {
      const selectedId = selected;
      for (const marker of markers.values()) marker.remove();
      markers.clear(); pins = [...nextPins]; pins.forEach(addPin);
      selected = null;
      if (selectedId && pins.some(pin => pin.id === selectedId)) select(selectedId);
      else onSelect(null);
    },
    revealSelection,
    destroy() { resize.disconnect(); map.remove(); }
  };
}

function attributionLink(value) {
  if (!value || typeof value !== 'object' || typeof value.label !== 'string') return '';
  const text = document.createElement('span');
  text.textContent = value.label;
  if (typeof value.href !== 'string') return text.outerHTML;
  let href;
  try {
    href = new URL(value.href);
  } catch {
    return text.outerHTML;
  }
  if (href.protocol !== 'https:') return text.outerHTML;
  const link = document.createElement('a');
  link.href = href.href;
  link.rel = 'noopener noreferrer';
  link.textContent = value.label;
  return link.outerHTML;
}
