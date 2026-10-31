// The source artwork uses an affine longitude/latitude projection, not Web Mercator.
export function project({ lat, lng }, p) {
  if (![lat, lng].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new TypeError('A finite latitude and longitude are required.');
  }
  return { x: p.xOrigin + (lng - p.lngOrigin) * p.xScale,
    y: p.yOrigin + (p.latOrigin - lat) * p.yScale };
}

// Leaflet CRS.Simple uses north-up [y, x]; SVG has a downward-positive y axis.
export const mapPoint = ({ x, y }) => [-y, x];
export const mapBounds = ({ left, right, top, bottom }) => [[-bottom, left], [-top, right]];
