import {readFile, writeFile} from 'node:fs/promises';
import {neighborhoods} from '../public/neighborhoods.mjs';

const publicRoot = new URL('../public/', import.meta.url);
const atlas = JSON.parse(await readFile(new URL('prototypes/pinellas-atlas/atlas-data.json', publicRoot)));
const places = [];
for (const area of atlas.neighborhoods) {
  const config = JSON.parse(await readFile(new URL(neighborhoods[area.id].config, publicRoot)));
  const p = config.projection, b = config.bounds;
  places.push({id:area.id, name:area.name, lat:area.lat, lng:area.lng, bounds:[
    [p.latOrigin-(b.bottom-p.yOrigin)/p.yScale, p.lngOrigin+(b.left-p.xOrigin)/p.xScale],
    [p.latOrigin-(b.top-p.yOrigin)/p.yScale, p.lngOrigin+(b.right-p.xOrigin)/p.xScale]
  ]});
}
await writeFile(new URL('prototypes/discovery-map/data/places.json', publicRoot), JSON.stringify({
  note:'Neighborhood center references and camera extents from prepared maps. Extents are image frames, not official or service boundaries.', places
}));
