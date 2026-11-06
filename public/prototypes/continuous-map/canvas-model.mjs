export const studyNeighborhoods = [
  { id: 'old-northeast', name: 'Old Northeast' },
  { id: 'crescent-lake', name: 'Crescent Lake' }
];

export const studyViews = {
  crossing: { center: [27.7888, -82.6397], zoom: 16 },
  gap: { center: [27.7996, -82.6488], zoom: 16 },
  pair: { bounds: [[27.774825, -82.648064], [27.802279, -82.618147]] }
};

// Record identity is independent of artwork ownership. Preserve distinct records
// at one address, and reject contradictory coordinates for the same record ID.
export function mergePublicFeeds(feeds) {
  const records = new Map();
  for (const { neighborhood, listings } of feeds) {
    if (!Array.isArray(listings)) throw new Error('The display service returned an invalid list.');
    for (const listing of listings) {
      if (!listing || typeof listing.id !== 'string' || !listing.id ||
          typeof listing.address !== 'string' || !listing.address ||
          !Number.isFinite(listing.latitude) || Math.abs(listing.latitude) > 90 ||
          !Number.isFinite(listing.longitude) || Math.abs(listing.longitude) > 180) {
        throw new Error('A published display has invalid coordinates or identity.');
      }
      const prior = records.get(listing.id);
      if (prior && (prior.lat !== listing.latitude || prior.lng !== listing.longitude)) {
        throw new Error('A display has conflicting coordinates across the loaded areas.');
      }
      if (!prior) records.set(listing.id, {
        id: listing.id, address: listing.address, lat: listing.latitude, lng: listing.longitude,
        neighborhood: neighborhood.name, neighborhoodId: neighborhood.id
      });
    }
  }
  return [...records.values()];
}

export function imageBoundsFromConfig({ bounds, artworkBounds, projection: p }) {
  const b = artworkBounds || bounds;
  return [
    [p.latOrigin - (b.bottom - p.yOrigin) / p.yScale, p.lngOrigin + (b.left - p.xOrigin) / p.xScale],
    [p.latOrigin - (b.top - p.yOrigin) / p.yScale, p.lngOrigin + (b.right - p.xOrigin) / p.xScale]
  ];
}

// Keep a marker's actual anchor visible without reserving a whole strip for a
// small card/control. Prefer the smallest camera adjustment around real UI boxes.
export function unobscuredPoint(point, size, obstacles, radius = 25) {
  const clamp = (value, limit) => Math.max(radius, Math.min(limit - radius, value));
  const xs = [clamp(point.x, size.x)], ys = [clamp(point.y, size.y)];
  for (const box of obstacles) {
    xs.push(box.left - radius - 2, box.right + radius + 2);
    ys.push(box.top - radius - 2, box.bottom + radius + 2);
  }
  let best = null, distance = Infinity;
  for (const x of xs) for (const y of ys) {
    if (x < radius || x > size.x - radius || y < radius || y > size.y - radius) continue;
    if (obstacles.some(box => x + radius > box.left && x - radius < box.right && y + radius > box.top && y - radius < box.bottom)) continue;
    const next = (x-point.x)**2 + (y-point.y)**2;
    if (next < distance) { best = {x,y}; distance = next; }
  }
  return best || {x:clamp(point.x,size.x), y:clamp(point.y,size.y)};
}
