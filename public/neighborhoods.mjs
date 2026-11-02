import { samplePins } from './sample-pins.mjs';
import { importedNeighborhoods } from './neighborhood-catalog.mjs';

// An explicit pair of map studies, not a generalized seasonal framework.
export const neighborhoods = {
  'old-northeast': {
    name: 'Old Northeast',
    config: './data/neighborhood.json',
    pins: samplePins
  },
  'crescent-lake': {
    name: 'Crescent Lake',
    config: './data/crescent-lake/neighborhood.json',
    pins: [
      { id: 'a', label: 'A', name: '861 19th Ave N', lat: 27.78985779639244, lng: -82.64588325010975,
        expected: [212.664369, 345.589749], sourceUrl: 'https://frightthisway.com/?house=dec75b56-a804-46c1-91ab-e31e55324899',
        note: 'Sample address · not a live Christmas listing' },
      { id: 'b', label: 'B', name: '1930 Crescent Lake Dr N', lat: 27.79036137860495, lng: -82.6428892320334,
        expected: [477.209655, 295.294091], sourceUrl: 'https://frightthisway.com/?house=e7c96315-a4f0-4cf7-bc05-1137405c6363',
        note: 'Sample address · not a live Christmas listing' },
      { id: 'c', label: 'C', name: '500 12th Ave N', lat: 27.784168804832053, lng: -82.64074047276368,
        expected: [667.069610, 913.782129], sourceUrl: 'https://frightthisway.com/?house=db33e2de-0649-4eee-9277-ec27c0e7989a',
        note: 'Sample address · not a live Christmas listing' },
      { id: 'd', label: 'D', name: '811 14th Ave N', lat: 27.785936094198807, lng: -82.64453639959595,
        expected: [331.669314, 737.272753], sourceUrl: 'https://frightthisway.com/?house=9f6cbdf8-cb34-4ee3-b53f-5bfe4e8a2066',
        note: 'Sample address · not a live Christmas listing' }
    ]
  }
};

for (const neighborhood of importedNeighborhoods) {
  neighborhoods[neighborhood.id] = neighborhood;
}

export function neighborhoodFor(search) {
  const id = new URLSearchParams(search).get('neighborhood') || 'old-northeast';
  if (!Object.hasOwn(neighborhoods, id)) throw new Error('Unknown neighborhood. Choose one of the maps above.');
  return { id, ...neighborhoods[id] };
}
