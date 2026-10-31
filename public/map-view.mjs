import { project, mapPoint, mapBounds } from './coordinates.mjs';

// The complete renderer boundary. No data fetching, forms, storage, or detail-card DOM.
export function createMap({ leaflet: L, element, area, pins, artwork, onSelect, onViewChange }) {
  const bounds = L.latLngBounds(mapBounds(area.bounds));
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
  map.attributionControl.addAttribution('© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>');

  let selected = null;
  const markers = new Map();
  function select(id) {
    selected = id;
    for (const [key, marker] of markers) {
      const button = marker.getElement()?.querySelector('button');
      button?.classList.toggle('is-selected', key === id);
      button?.setAttribute('aria-pressed', String(key === id));
      marker.setZIndexOffset(key === id ? 1000 : 0);
    }
    onSelect(pins.find(pin => pin.id === id) || null);
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
    map.fitBounds(bounds, { padding: [28, 28], animate: false, reset: true });
  }
  function reportView() {
    onViewChange?.({ zoom: map.getZoom(), selected });
  }
  map.on('moveend zoomend', reportView);
  const resize = new ResizeObserver(() => map.invalidateSize({ pan: false }));
  resize.observe(element);
  reset();
  return {
    reset,
    select(id) {
      select(id);
      const marker = markers.get(id);
      if (marker) map.panInside(marker.getLatLng(), { padding: [40, 40], animate: false });
    },
    destroy() { resize.disconnect(); map.remove(); }
  };
}
