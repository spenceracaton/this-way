// Public road vertices, not submitted houses or claims of seasonal participation.
// Expected artwork coordinates were retained independently from existing road geometry.
export const samplePins = [
  { id: 'a', label: 'A', name: '9th Avenue & Oak Street', lat: 27.781256, lng: -82.6315704,
    expected: [378.61, 824.39], osmWay: '11237875', note: 'Southern reference · road intersection' },
  { id: 'b', label: 'B', name: 'North Shore Drive', lat: 27.7849981, lng: -82.6250337,
    expected: [600.85, 680.32], osmWay: '83871993', note: 'Coastal reference · near the shoreline' },
  { id: 'c', label: 'C', name: 'Coffee Pot Boulevard', lat: 27.7924502, lng: -82.628787,
    expected: [473.24, 393.42], osmWay: '46691560', note: 'Northern reference · curved road' },
  { id: 'd', label: 'D', name: '18th Avenue & Locust Street', lat: 27.7889593, lng: -82.6302972,
    expected: [421.90, 527.82], osmWay: '11235187', note: 'Central reference · road intersection' }
];
