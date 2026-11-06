import { emptyFilters, normalizeFilters, filterPins, matchesFilters, filterStorageKey, createNearMeController } from './map-tools-state.mjs';
import { bindDialog } from './dialog.mjs';

export function createMapTools({ mount, neighborhood, seasonId, getPins, onFilterChange, onChooseNeighborhood, onLocate, sharedListingId, onFilterOpen, navigate = url => location.assign(url) }) {
  const abort = new AbortController(), { signal } = abort;
  const listen = (node, type, handler) => node.addEventListener(type, handler, { signal });
  const node = (tag, attrs = {}, value) => {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
    if (value !== undefined) element.textContent = value;
    return element;
  };
  const button = (id, label, className = '') => node('button', { type: 'button', id, class: className }, label);
  let pins = [...getPins()], filters = emptyFilters(), draft, storage;
  try { storage = localStorage; filters = normalizeFilters(JSON.parse(storage.getItem(filterStorageKey(seasonId)) || '{}')); } catch {}
  const save = () => { try { storage?.setItem(filterStorageKey(seasonId), JSON.stringify(filters)); } catch {} };
  const root = node('div', { class: 'map-tools', 'aria-label': 'Explore displays' });
  const filterToggle = button('display-filters-toggle', '', 'map-tools-button map-filter-toggle');
  const icon = node('span', { 'aria-hidden': 'true', class: 'map-tools-icon' });
  icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="var(--paper-strong,#faf3e3)"/><circle cx="15" cy="17" r="3" fill="var(--paper-strong,#faf3e3)"/></svg>';
  const filterLabel = node('span', { id: 'display-filters-label' }, 'Filters');
  const filterBadge = node('span', { class: 'map-filter-badge', 'aria-hidden': 'true', hidden: '' });
  filterToggle.append(icon, filterLabel, filterBadge);
  filterToggle.setAttribute('aria-haspopup', 'dialog');
  filterToggle.setAttribute('aria-controls', 'display-filters-dialog');
  filterToggle.setAttribute('aria-expanded', 'false');
  const near = button('near-me', '', 'map-tools-button near-me-button');
  near.setAttribute('aria-label', 'Near me'); near.title = 'Near me';
  const locateIcon = node('span', { 'aria-hidden': 'true', class: 'map-tools-icon' });
  locateIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M12 1v4m0 14v4M1 12h4m14 0h4"/></svg>';
  near.append(locateIcon, node('span', { class: 'near-me-label' }, 'Near me'));
  root.append(filterToggle, near); mount.append(root);
  const empty = node('div', { class: 'map-filter-empty', hidden: '' });
  const emptyStatus = node('span', { role: 'status' }, 'No displays match.');
  const emptyReset = button('display-filters-empty-reset', 'Reset filters');
  empty.append(emptyStatus, emptyReset); root.append(empty);
  document.body.classList.add('map-tools-enabled');

  const filterDialog = node('dialog', { id: 'display-filters-dialog', class: 'map-tools-dialog', 'aria-labelledby': 'display-filters-title' });
  const filterTitle = node('h2', { id: 'display-filters-title', tabindex: '-1' }, 'Find your kind of display');
  const closeFilters = button('display-filters-close', '×', 'map-tools-close'); closeFilters.setAttribute('aria-label', 'Close filters');
  const filterIntro = node('p', {}, 'Choose one or both.');
  const themed = button('display-filter-themed', 'Themed display', 'display-filter-option');
  const photos = button('display-filter-photos', 'With photos', 'display-filter-option');
  const reset = button('display-filters-reset', 'Reset', 'map-tools-secondary');
  const apply = button('display-filters-apply', 'Show displays', 'map-tools-primary');
  const actions = node('div', { class: 'map-tools-actions' }); actions.append(reset, apply);
  filterDialog.append(filterTitle, closeFilters, filterIntro, themed, photos, actions);

  const feedback = node('dialog', { id: 'near-me-feedback', class: 'map-tools-dialog near-me-feedback', 'aria-labelledby': 'near-me-title' });
  const nearTitle = node('h2', { id: 'near-me-title', tabindex: '-1' }, 'Near me');
  const closeNear = button('near-me-close', '×', 'map-tools-close'); closeNear.setAttribute('aria-label', 'Close Near me');
  const status = node('p', { id: 'near-me-status', role: 'status', 'aria-live': 'polite' });
  const privacy = node('p', { class: 'near-me-privacy' }, 'Your location stays in this browser.');
  const choose = button('near-me-choose', 'Choose a neighborhood', 'map-tools-primary');
  const keep = button('near-me-keep', 'Keep exploring', 'map-tools-secondary');
  const recoveryActions = node('div', { class: 'map-tools-actions' }); recoveryActions.append(choose, keep);
  feedback.append(nearTitle, closeNear, status, privacy, recoveryActions);
  document.body.append(filterDialog, feedback);
  const filterLifecycle = bindDialog(filterDialog, { initialFocus: () => filterTitle });
  const feedbackLifecycle = bindDialog(feedback, { initialFocus: () => nearTitle });

  function announceFilters() {
    const count = Number(filters.themed) + Number(filters.photos), label = count ? `Filters · ${count}` : 'Filters';
    filterLabel.textContent = label; filterToggle.setAttribute('aria-label', label); filterToggle.title = label;
    filterBadge.hidden = count === 0; filterBadge.textContent = String(count);
    const shown = filterPins(pins, filters);
    empty.hidden = !pins.length || shown.length > 0;
    onFilterChange(shown, { ...filters });
  }
  function revealSharedListing(id) {
    const latest = [...getPins()], pin = latest.find(pin => pin.id === id);
    if (pin && !matchesFilters(pin, filters)) { pins = latest; filters = emptyFilters(); save(); announceFilters(); }
  }
  if (sharedListingId && pins.some(pin => pin.id === sharedListingId && !matchesFilters(pin, filters))) { filters = emptyFilters(); save(); }
  function updateDraft() { themed.setAttribute('aria-pressed', String(draft.themed)); photos.setAttribute('aria-pressed', String(draft.photos)); }
  listen(filterToggle, 'click', () => {
    onFilterOpen?.();
    draft = { ...filters }; updateDraft();
    filterLifecycle.open(filterToggle); filterToggle.setAttribute('aria-expanded', 'true');
  });
  listen(closeFilters, 'click', () => filterLifecycle.close());
  listen(filterDialog, 'close', () => filterToggle.setAttribute('aria-expanded', 'false'));
  listen(themed, 'click', () => { draft.themed = !draft.themed; updateDraft(); });
  listen(photos, 'click', () => { draft.photos = !draft.photos; updateDraft(); });
  listen(reset, 'click', () => { draft = emptyFilters(); updateDraft(); });
  listen(apply, 'click', () => { filters = { ...draft }; save(); announceFilters(); filterLifecycle.close(); });
  listen(emptyReset, 'click', () => { filters = emptyFilters(); save(); announceFilters(); filterToggle.focus({ preventScroll: true }); });

  const messages = {
    locating: 'Finding your neighborhood…',
    denied: 'Location access is off. Choose a neighborhood to keep exploring.',
    timeout: 'Finding your location took too long. Try Near me again or choose a neighborhood.',
    unavailable: 'Your location is unavailable. Choose a neighborhood to keep exploring.',
    'coverage-error': 'Neighborhood coverage couldn’t load. Try Near me again or choose a neighborhood.',
    approximate: 'Your location is too approximate to choose a neighborhood. Choose a neighborhood to keep exploring.',
    outside: 'We can’t confidently place you in a mapped neighborhood. Choose a neighborhood to keep exploring.',
    ambiguous: 'Your location is close to more than one neighborhood. Choose a neighborhood to keep exploring.'
  };
  const controller = createNearMeController({
    geolocation: navigator.geolocation, neighborhoodId: neighborhood.id,
    fetchCoverage: async () => {
      const response = await fetch('/data/neighborhood-coverage.json', { credentials: 'same-origin' });
      if (!response.ok) throw new Error('Neighborhood coverage could not load.');
      return response.json();
    },
    onState(state) {
      near.disabled = state.kind === 'locating'; near.setAttribute('aria-busy', String(near.disabled));
      if (state.kind === 'idle') { feedbackLifecycle.close(); return; }
      status.textContent = messages[state.kind];
      feedback.dataset.state = state.kind;
      feedbackLifecycle.open(near);
    },
    onLocate,
    onNeighborhood(area) {
      const url = new URL(location.href);
      if (area.id === 'old-northeast') url.searchParams.delete('neighborhood'); else url.searchParams.set('neighborhood', area.id);
      url.searchParams.delete('listing'); url.searchParams.delete('sample');
      navigate(url.pathname + url.search + url.hash);
    }
  });
  listen(near, 'click', () => { void controller.start(); });
  listen(closeNear, 'click', () => controller.dismiss());
  listen(keep, 'click', () => controller.dismiss());
  let choosePending = false;
  listen(choose, 'click', () => { choosePending = true; controller.dismiss(); });
  listen(feedback, 'cancel', event => { event.preventDefault(); controller.dismiss(); });
  listen(feedback, 'keydown', event => { if (event.key === 'Escape') controller.dismiss(); });
  listen(feedback, 'close', () => {
    controller.dismiss();
    if (choosePending) { choosePending = false; onChooseNeighborhood(); }
  });
  announceFilters();
  return {
    refresh() { pins = [...getPins()]; announceFilters(); },
    setPins(nextPins) { pins = [...nextPins]; announceFilters(); },
    getFilters: () => ({ ...filters }),
    revealSharedListing,
    destroy() { controller.destroy(); filterLifecycle.close(); feedbackLifecycle.close(); abort.abort(); filterDialog.remove(); feedback.remove(); root.remove(); document.body.classList.remove('map-tools-enabled'); }
  };
}
