export const emptyFilters = () => ({ themed: false, photos: false });
export const normalizeFilters = value => ({ themed: value?.themed === true, photos: value?.photos === true });
export function matchesFilters(pin, value) {
  const filters = normalizeFilters(value);
  return (!filters.themed || Boolean(String(pin.title ?? pin.theme ?? '').trim())) &&
    (!filters.photos || (Array.isArray(pin.photos) && pin.photos.length > 0));
}
export const filterPins = (pins, filters) => pins.filter(pin => matchesFilters(pin, filters));
export const filterStorageKey = seasonId => `this-way:display-filters:v1:${seasonId}`;

function validateCoverage(coverage) {
  if (coverage?.version !== 1 || !Array.isArray(coverage.neighborhoods) || !coverage.neighborhoods.length) throw new Error('Invalid neighborhood coverage.');
  const ids = new Set();
  for (const area of coverage.neighborhoods) {
    if (typeof area?.id !== 'string' || !/^[a-z0-9-]+$/.test(area.id) || ids.has(area.id) || typeof area.name !== 'string' || !Array.isArray(area.core) || area.core.length < 3 || area.core.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90)) throw new Error('Invalid neighborhood core.');
    ids.add(area.id);
  }
  return coverage;
}

// An accuracy circle must fit wholly inside one reviewed core. Artwork bounds
// and surrounding buffer geography cannot establish a visitor's neighborhood.
export function classifyLocation(position, coverage) {
  const { lat, lng, accuracy } = position || {};
  if (![lat, lng, accuracy].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || accuracy < 0 || accuracy > 150) return { kind: 'approximate' };
  validateCoverage(coverage);
  const matches = [], candidates = [];
  for (const area of coverage.neighborhoods) {
    const scaleX = 111320 * Math.cos(lat * Math.PI / 180), scaleY = 111320;
    const ring = area.core.map(([x, y]) => [(x - lng) * scaleX, (y - lat) * scaleY]);
    let inside = false, distance = Infinity;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[j], [bx, by] = ring[i];
      if ((ay > 0) !== (by > 0) && 0 < ax + (bx - ax) * -ay / (by - ay)) inside = !inside;
      const dx = bx - ax, dy = by - ay, length = dx * dx + dy * dy;
      const t = length ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length)) : 0;
      distance = Math.min(distance, Math.hypot(ax + t * dx, ay + t * dy));
    }
    // Three extra metres absorb coordinate rounding and projection tolerance.
    if (inside) candidates.push(area);
    if (inside && distance > accuracy + 3) matches.push(area);
  }
  return candidates.length > 1 ? { kind: 'ambiguous' } : matches.length === 1 ? { kind: 'inside', neighborhood: matches[0] } : { kind: candidates.length ? 'approximate' : 'outside' };
}

// This controller owns request lifetime only. It neither stores location nor
// sends it to a service. A dismissed attempt cannot affect a later interaction.
export function createNearMeController({ geolocation, fetchCoverage, neighborhoodId, onState, onLocate, onNeighborhood }) {
  let generation = 0, metadata, pendingMetadata, denied = false, destroyed = false;
  const emit = state => { if (!destroyed) onState(state); };
  const getCoverage = () => metadata ? Promise.resolve(metadata) : pendingMetadata ||= Promise.resolve().then(fetchCoverage)
    .then(value => { metadata = validateCoverage(value); return value; })
    .finally(() => { pendingMetadata = undefined; });
  function dismiss() { generation++; emit({ kind: 'idle' }); }
  async function start() {
    const request = ++generation;
    if (denied) { emit({ kind: 'denied' }); return; }
    if (!geolocation?.getCurrentPosition) { emit({ kind: 'unavailable' }); return; }
    emit({ kind: 'locating' });
    const native = new Promise((resolve, reject) => geolocation.getCurrentPosition(
      fix => resolve({ lat: fix?.coords?.latitude, lng: fix?.coords?.longitude, accuracy: fix?.coords?.accuracy }),
      error => reject({ nativeCode: error?.code }),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    ));
    try {
      const [position, coverage] = await Promise.all([native, getCoverage()]);
      if (destroyed || request !== generation) return;
      const result = classifyLocation(position, coverage);
      if (result.kind !== 'inside') { emit(result); return; }
      emit({ kind: 'idle' });
      if (result.neighborhood.id === neighborhoodId) onLocate(position);
      else onNeighborhood(result.neighborhood);
    } catch (error) {
      if (destroyed || request !== generation) return;
      if (error?.nativeCode === 1) denied = true;
      emit({ kind: error?.nativeCode === 1 ? 'denied' : error?.nativeCode === 3 ? 'timeout' : error?.nativeCode ? 'unavailable' : 'coverage-error' });
    }
  }
  return { start, dismiss, destroy() { destroyed = true; generation++; } };
}
