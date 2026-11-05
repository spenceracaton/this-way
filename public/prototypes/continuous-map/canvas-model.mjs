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

export function imageBoundsFromConfig({ bounds: b, projection: p }) {
  return [
    [p.latOrigin - (b.bottom - p.yOrigin) / p.yScale, p.lngOrigin + (b.left - p.xOrigin) / p.xScale],
    [p.latOrigin - (b.top - p.yOrigin) / p.yScale, p.lngOrigin + (b.right - p.xOrigin) / p.xScale]
  ];
}
