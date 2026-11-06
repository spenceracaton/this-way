import { neighborhoods } from './neighborhoods.mjs';
import { api } from './service-client.mjs';
import { activeSeasonId } from './season-config.mjs';
import { neighborhoodMatches } from './neighborhood-search.mjs';

// The QA reference's native dialog keeps desktop anchoring and phone sheets
// consistent without importing FTW's listings or application state.
export function createNeighborhoodPicker(current, { service = null, season = activeSeasonId, currentCount } = {}) {
  const trigger = document.getElementById('neighborhood-select');
  const dialog = document.getElementById('neighborhood-dialog');
  const title = document.getElementById('neighborhood-picker-title');
  const search = document.getElementById('neighborhood-search');
  const list = document.getElementById('neighborhood-options');
  const empty = document.getElementById('neighborhood-empty');
  const mobile = matchMedia('(max-width:720px)');
  let previousOverflow = '';
  document.getElementById('neighborhood-name').textContent = current.name;
  for (const [id, neighborhood] of Object.entries(neighborhoods).sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'neighborhood-option';
    row.dataset.neighborhood = id;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(id === current.id));
    const name = document.createElement('span');
    name.className = 'neighborhood-option-name';
    name.textContent = neighborhood.name;
    const count = document.createElement('span');
    count.className = 'neighborhood-count';
    count.textContent = service ? '' : neighborhood.pins.length ? `${neighborhood.pins.length} sample addresses` : 'Map only';
    if (service) count.setAttribute('aria-hidden', 'true');
    const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    check.setAttribute('viewBox', '0 0 24 24');
    check.setAttribute('aria-hidden', 'true');
    check.classList.add('neighborhood-check');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'm5 12 4 4L19 6');
    check.append(path);
    row.append(name, count, check);
    row.addEventListener('click', () => {
      dialog.close();
      if (id === current.id) return;
      const url = new URL(location.href);
      if (id === 'old-northeast') url.searchParams.delete('neighborhood');
      else url.searchParams.set('neighborhood', id);
      url.searchParams.delete('sample');
      url.searchParams.delete('listing');
      location.assign(url.pathname + url.search + url.hash);
    });
    list.append(row);
  }
  const rows = [...list.querySelectorAll('[role="option"]')];
  const visible = () => rows.filter(row => !row.hidden);
  function filter() {
    rows.forEach(row => { row.hidden = !neighborhoodMatches(row.dataset.neighborhood, neighborhoods[row.dataset.neighborhood].name, search.value); });
    empty.textContent = visible().length ? '' : 'No matching neighborhoods.';
  }
  const counts = new Map();
  function applyCounts(next) {
    for (const [id, count] of Object.entries(next)) counts.set(id, count);
    const focused = document.activeElement;
    rows.forEach(row => {
      const count = counts.get(row.dataset.neighborhood);
      const label = row.querySelector('.neighborhood-count');
      label.textContent = count === undefined ? '' : `${count.toLocaleString('en-US')} ${count === 1 ? 'display' : 'displays'}`;
      label.setAttribute('aria-hidden', String(count === undefined));
    });
    const rank = row => { const count = counts.get(row.dataset.neighborhood); return count > 0 ? 0 : count === 0 ? 2 : 1; };
    rows.sort((a, b) => rank(a) - rank(b) || neighborhoods[a.dataset.neighborhood].name.localeCompare(neighborhoods[b.dataset.neighborhood].name));
    rows.forEach(row => list.append(row));
    // Reordering the existing nodes can drop focus in native dialogs.
    if (rows.includes(focused) && !focused.hidden && (!document.activeElement || document.activeElement === document.body)) focused.focus({ preventScroll: true });
    filter();
  }
  if (service && Number.isSafeInteger(currentCount) && currentCount >= 0) applyCounts({ [current.id]: currentCount });
  let lastAttempt = -Infinity, pending = false;
  async function refreshCounts({ force = false } = {}) {
    if (!service || pending || (!force && Date.now() - lastAttempt < 30_000)) return;
    pending = true;
    lastAttempt = Date.now();
    try {
      const result = await api(`/api/neighborhood-counts?${new URLSearchParams({ season })}`);
      if (result?.season !== season || !result.counts || Object.keys(neighborhoods).some(id => !Number.isSafeInteger(result.counts[id]) || result.counts[id] < 0)) throw new Error('Invalid neighborhood totals');
      applyCounts(result.counts);
    } catch {
      // Keep known totals and unknown labels as they are. An unavailable count
      // never becomes zero or an illustrative sample count.
    } finally { pending = false; }
  }
  refreshCounts();
  window.addEventListener('focus', refreshCounts);
  function position() {
    if (!dialog.open) return;
    if (mobile.matches) {
      const viewport = window.visualViewport;
      const height = viewport?.height || innerHeight;
      dialog.style.left = '';
      dialog.style.top = '';
      dialog.style.width = '';
      dialog.style.height = Math.round(height * .82) + 'px';
      dialog.style.maxHeight = dialog.style.height;
      dialog.style.setProperty('--picker-bottom', Math.max(0, innerHeight - ((viewport?.offsetTop || 0) + height)) + 'px');
    } else {
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, 400), innerWidth - 24);
      const top = Math.max(12, Math.min(rect.bottom + 2, innerHeight - 180));
      dialog.style.height = '';
      dialog.style.left = Math.max(12, Math.min(rect.left, innerWidth - width - 12)) + 'px';
      dialog.style.top = top + 'px';
      dialog.style.width = width + 'px';
      dialog.style.maxHeight = Math.min(600, innerHeight - top - 12) + 'px';
    }
  }
  trigger.addEventListener('click', () => {
    refreshCounts();
    if (dialog.open) { dialog.close(); return; }
    search.value = '';
    filter();
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    trigger.setAttribute('aria-expanded', 'true');
    position();
    title.focus({ preventScroll: true });
  });
  dialog.addEventListener('close', () => {
    document.body.style.overflow = previousOverflow;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.focus({ preventScroll: true });
  });
  document.getElementById('neighborhood-picker-close').addEventListener('click', () => dialog.close());
  search.addEventListener('input', filter);
  dialog.addEventListener('keydown', event => {
    // Chromium search inputs otherwise consume the first Escape to clear text.
    // Dismiss only this dialog, leaving any selected display card intact.
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dialog.close();
      return;
    }
    const options = visible(), index = options.indexOf(document.activeElement);
    let next;
    if (event.target === search || event.target === title) {
      if (event.key === 'ArrowDown') next = 0;
      else if (event.key === 'ArrowUp') next = options.length - 1;
      else if (event.key === 'Enter' && search.value.trim()) {
        event.preventDefault(); options[0]?.click(); return;
      }
    } else if (index >= 0) {
      if (event.key === 'ArrowDown') next = (index + 1) % options.length;
      else if (event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = options.length - 1;
      else if (event.key === 'Backspace') { event.preventDefault(); search.focus(); return; }
    }
    if (next !== undefined) {
      event.preventDefault();
      options[next]?.focus({ preventScroll: true });
      options[next]?.scrollIntoView({ block: 'nearest' });
    }
  });
  window.addEventListener('resize', position);
  window.visualViewport?.addEventListener('resize', position);
  return { refreshCounts };
}
