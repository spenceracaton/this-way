// Small shared configuration; listing/photo storage does not depend on a theme.
export const seasons = {
  'christmas-2026': {
    id: 'christmas-2026', kind: 'christmas', year: 2026, name: 'Christmas 2026',
    submissionTitle: 'Add a display', themePlaceholder: 'For example: A winter wonderland',
    tags: ['Lights', 'Inflatables', 'Music', 'Animated display', 'Handmade decorations', 'Nativity', 'Santa', 'Winter wonderland']
  },
  'halloween-2026': {
    id: 'halloween-2026', kind: 'halloween', year: 2026, name: 'Halloween 2026',
    submissionTitle: 'Add a display', themePlaceholder: 'For example: A haunted garden',
    tags: ['Family friendly', 'Spooky', 'Scary', 'Lights', 'Animatronics', 'Music', 'Handmade decorations']
  }
};
export const activeSeasonId = 'christmas-2026';
export function seasonFor(id = activeSeasonId) { return seasons[id] || null; }
