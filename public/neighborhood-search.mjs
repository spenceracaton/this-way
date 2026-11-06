// Search terms from FTW's public neighborhood directory. Regional terms help
// discovery; they do not change a map's identity or boundaries.
const searchTerms = {
  'old-northeast': ['Historic Old Northeast'],
  'thirteenth-street-heights': ['Thirteenth St Heights', '13th St Heights'],
  'crossroads-area': ['Crossroads', 'Tyrone'],
  'area-1d493c7d21df8142133da1a7': ['Edgemoor Estates']
};

export const normalizeNeighborhoodSearch = value => String(value || '').normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^a-z0-9]/g, '');

export function neighborhoodMatches(id, name, query) {
  return [name, ...(searchTerms[id] || [])].some(term => normalizeNeighborhoodSearch(term).includes(normalizeNeighborhoodSearch(query)));
}
