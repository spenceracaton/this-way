import { samplePins } from './sample-pins.mjs';

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
      { id: 'a', label: 'A', name: '21st Avenue North', lat: 27.7912981, lng: -82.6461788,
        expected: [186.55, 201.74], osmWay: '11247855', note: 'Northwest reference · road vertex' },
      { id: 'b', label: 'B', name: '18th Avenue & 5th Street', lat: 27.7887945, lng: -82.6400818,
        expected: [725.27, 451.79], osmWay: '11230466', note: 'Eastern reference · beside the lake park' },
      { id: 'c', label: 'C', name: '7th Street & 12th Avenue', lat: 27.7843828, lng: -82.6426216,
        expected: [500.86, 892.41], osmWay: '11224662', note: 'Southern reference · road intersection' },
      { id: 'd', label: 'D', name: 'Highland Street North', lat: 27.7866351, lng: -82.645669,
        expected: [231.60, 667.46], osmWay: '11233813', note: 'Western reference · road vertex' }
    ]
  }
};

export function neighborhoodFor(search) {
  const id = new URLSearchParams(search).get('neighborhood') || 'old-northeast';
  if (!Object.hasOwn(neighborhoods, id)) throw new Error('Unknown neighborhood. Choose one of the maps above.');
  return { id, ...neighborhoods[id] };
}
