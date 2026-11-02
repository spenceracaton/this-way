import { project, mapPoint, mapBounds } from './coordinates.mjs';

// The complete renderer boundary. No data fetching, forms, storage, or detail-card DOM.
export function createMap({ leaflet: L, element, area, pins, artwork, onSelect, onViewChange, onAnchorChange, selectionInsets }) {
  const bounds = L.latLngBounds(mapBounds(area.bounds));
  const overviewBounds = area.overviewBounds ? L.latLngBounds(mapBounds(area.overviewBounds)) : bounds;
  const map = L.map(element, {
    crs: L.CRS.Simple, minZoom: -4, maxZoom: 2,
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
  for (const pin of pins) {
    const icon = L.divIcon({ className: 'reference-marker', iconSize: [44, 44], iconAnchor: [22, 22],
      html: `<button class="map-pin" type="button" aria-label="Select sample ${pin.label}: ${pin.name}" aria-pressed="false" data-pin="${pin.id}">${pin.label}</button>` });
    const marker = L.marker(mapPoint(project(pin, area.projection)), { icon, keyboard: false, title: pin.name })
      .on('click', () => select(pin.id))
      .on('add', event => {
        event.target.getElement().querySelector('button').addEventListener('keydown', key => {
          if (key.key === 'Enter' || key.key === ' ') {
            key.preventDefault(); key.stopPropagation(); select(pin.id);
          }
        });
      }).addTo(map);
    markers.set(pin.id, marker);
  }
  map.on('click', () => select(null));
  element.addEventListener('keydown', event => {
    if (event.key === 'Escape') { select(null); event.preventDefault(); }
    if (event.key === 'Home' && event.target === element) { reset(); event.preventDefault(); }
  });
  function reset() {
    map.stop();
    select(null);
    map.fitBounds(overviewBounds, { padding: [28, 28], animate: false, reset: true });
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
