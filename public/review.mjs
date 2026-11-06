import { loadService, api } from './service-client.mjs';
import { activeSeasonId } from './season-config.mjs';
import { importedNeighborhoods } from './neighborhood-catalog.mjs';

const main = document.querySelector('main.workspace');
let service = null;
let authenticated = false;
let section = 'photos';
let photoFilter = 'pending';
let listingFilter = 'published';
let photos = [];
let listings = [];
let selectedPhotoId = null;
let selectedListingId = null;
let busy = false;
let notice = '';
let failure = '';
let reports = [];
let reportFilter = 'open';
let selectedReportId = null;
let reportCursors = { open: null, dismissed: null };

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const neighborhoodNames = new Map(importedNeighborhoods.map(item => [item.id, item.name]));
const neighborhoodName = id => neighborhoodNames.get(id) || String(id || 'Neighborhood not listed');
const photoFor = id => photos.find(item => item.id === id);
const listingFor = id => listings.find(item => item.id === id);
const photoStatus = item => item.status || item.photo?.status || 'pending';
const listingStatus = item => item.status || 'pending';
const photoListing = item => item.listing || {};
const photoImageUrl = item => `/api/admin/photos/${encodeURIComponent(item.id)}/content`;
const reportReasonNames = new Map([['incorrect-address', 'Incorrect address'], ['not-displayed', 'No longer on display'], ['inappropriate', 'Inappropriate display'], ['other', 'Something else']]);

function baseMarkup() {
  return `<div class="page-heading"><div><p class="eyebrow">OWNER REVIEW</p><h1>Review workspace</h1><p class="lede">Photos wait for approval. Text displays publish independently.</p></div><div class="owner-tools"><span class="owner-badge">Private owner view</span><button class="quiet-button" type="button" data-action="logout" ${busy ? 'disabled' : ''}>Log out</button></div></div>
    <div id="service-alert" class="service-alert" role="status" aria-live="polite" ${failure || notice ? '' : 'hidden'}>${failure ? `<strong>Something needs attention.</strong> ${escape(failure)} <button type="button" data-action="retry">Retry</button>` : escape(notice)}</div>
    <div class="service-tabs" role="tablist" aria-label="Review type"><button type="button" role="tab" data-section="photos" aria-selected="${section === 'photos'}">Photos <span>${photos.length}</span></button><button type="button" role="tab" data-section="listings" aria-selected="${section === 'listings'}">Text displays <span>${listings.length}</span></button><button type="button" role="tab" data-section="inbox" aria-selected="${section === 'inbox'}">Reports & feedback <span>${reports.filter(item => item.status === 'open').length}${reportCursors.open ? '+' : ''}</span></button></div>
    ${section === 'photos' ? photosMarkup() : section === 'listings' ? listingsMarkup() : '<div id="owner-inbox" class="service-review-layout"></div>'}`;
}

function inboxNode(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value != null) element.textContent = value;
  return element;
}

function renderInbox() {
  const root = document.getElementById('owner-inbox');
  if (!root) return;
  const queue = inboxNode('section', 'queue'); queue.setAttribute('aria-label', 'Community inbox');
  queue.append(inboxNode('h2', 'queue-heading', 'Reports & feedback'));
  const filters = inboxNode('div', 'filters'); filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', 'Filter messages');
  for (const status of ['open', 'dismissed']) {
    const button = inboxNode('button', '', status === 'open' ? 'Open' : 'Dismissed');
    button.type = 'button'; button.dataset.reportFilter = status; button.setAttribute('aria-pressed', String(status === reportFilter)); filters.append(button);
  }
  queue.append(filters);
  const shown = reports.filter(item => item.status === reportFilter);
  const list = inboxNode('ul', 'record-list');
  for (const item of shown) {
    const li = inboxNode('li'), button = inboxNode('button', `record-button${item.id === selectedReportId ? ' is-selected' : ''}`);
    button.type = 'button'; button.dataset.report = item.id; button.setAttribute('aria-pressed', String(item.id === selectedReportId));
    button.append(inboxNode('span', 'record-address', item.kind === 'report' ? item.listing?.address || 'Display report' : 'Visitor feedback'), inboxNode('span', 'record-theme', item.message || item.reason), inboxNode('span', 'record-meta', formatDate(item.createdAt)));
    li.append(button); list.append(li);
  }
  queue.append(list);
  if (!shown.length) queue.append(inboxNode('p', 'empty-state', reportFilter === 'open' ? 'You’re all caught up. No open messages.' : 'No dismissed messages.'));
  if (reportCursors[reportFilter]) {
    const more = inboxNode('button', 'quiet-button', 'Load more messages'); more.type = 'button'; more.dataset.action = 'more-reports'; more.disabled = busy; queue.append(more);
  }
  root.append(queue);
  const item = shown.find(row => row.id === selectedReportId);
  if (!item) { root.append(inboxNode('p', 'select-prompt', 'Choose a message to review it.')); return; }
  const detail = inboxNode('section', 'detail-panel has-record service-detail inbox-detail'); detail.setAttribute('aria-labelledby', 'detail-title');
  const back = inboxNode('button', 'back-button', '← All messages'); back.type = 'button'; back.dataset.action = 'back'; detail.append(back);
  const copy = inboxNode('div', 'detail-copy');
  copy.append(inboxNode('span', 'status-pill', item.status));
  const heading = inboxNode('h2', '', item.kind === 'report' ? 'Display report' : 'Visitor feedback'); heading.id = 'detail-title'; copy.append(heading);
  if (item.listing) copy.append(inboxNode('p', 'detail-neighborhood', item.listing.address), inboxNode('p', '', `Display visibility: ${item.listing.status}`));
  copy.append(inboxNode('p', 'record-meta', `${item.seasonId} · ${formatDate(item.createdAt)}`));
  if (item.reason) copy.append(inboxNode('p', '', `Reason: ${reportReasonNames.get(item.reason) || item.reason}`));
  copy.append(inboxNode('p', 'inbox-message', item.message || 'No additional details.'));
  if (item.email) copy.append(inboxNode('p', 'inbox-message', `Contact email: ${item.email}`));
  const actions = inboxNode('div', 'review-actions'), button = inboxNode('button', 'approve-button', item.status === 'open' ? 'Dismiss message' : 'Reopen message');
  button.type = 'button'; button.dataset.action = 'decide-report'; button.disabled = busy; actions.append(button); copy.append(actions, inboxNode('p', 'service-footnote', 'Dismissing or reopening a message does not change the display or its photos.'));
  detail.append(copy); root.append(detail);
}

function photosMarkup() {
  const shown = photos.filter(item => photoStatus(item) === photoFilter);
  const current = photoFor(selectedPhotoId);
  return `<div class="service-review-layout"><section class="queue" aria-label="Photo queue"><div class="queue-heading"><h2>Photos</h2><span class="count">${photos.length} total</span></div><div class="filters" role="group" aria-label="Filter photos">${['pending', 'approved', 'rejected'].map(status => `<button type="button" data-photo-filter="${status}" aria-pressed="${photoFilter === status}">${status[0].toUpperCase()}${status.slice(1)} <span>${photos.filter(item => photoStatus(item) === status).length}</span></button>`).join('')}</div><ul class="record-list">${shown.map(item => { const listing = photoListing(item); return `<li><button class="record-button${item.id === selectedPhotoId ? ' is-selected' : ''}" type="button" data-photo="${escape(item.id)}" aria-pressed="${item.id === selectedPhotoId}"><span class="record-topline"><span class="record-address">${escape(listing.address || 'Address not provided')}</span><span class="status-dot status-dot-${escape(photoStatus(item))}" aria-hidden="true"></span></span><span class="record-theme">${escape(listing.title || 'Photo submission')}</span><span class="record-meta">${escape(neighborhoodName(listing.neighborhoodId))} · ${escape(formatDate(item.createdAt))}</span></button></li>`; }).join('')}</ul>${shown.length ? '' : `<p class="empty-state">${photoFilter === 'pending' ? 'You’re all caught up. No photos are waiting.' : `No ${photoFilter} photos yet.`}</p>`}</section>${current ? photoDetail(current) : `<p class="select-prompt">Choose a photo to review it.</p>`}</div>`;
}

function photoDetail(item) {
  const listing = photoListing(item);
  const status = photoStatus(item);
  const actions = status === 'pending'
    ? `<div class="review-actions"><button class="approve-button" type="button" data-action="approve-photo" ${busy ? 'disabled' : ''}>Approve photo <span aria-hidden="true">✓</span></button><button class="reject-button" type="button" data-action="reject-photo" ${busy ? 'disabled' : ''}>Reject photo</button></div><p class="service-footnote">Approving a photo does not change this display’s visibility.</p>`
    : `<div class="decision-bar"><span>Photo ${escape(status)}. Text display: ${escape(listing.status || 'published')}.</span><button class="undo-button" type="button" data-action="undo-photo" ${busy ? 'disabled' : ''}>Return to pending</button></div>`;
  return `<section class="detail-panel has-record service-detail" aria-labelledby="detail-title"><button class="back-button" type="button" data-action="back">← All photos</button><div class="detail-image private-photo"><img src="${escape(photoImageUrl(item))}" alt="Private photo submitted for a community display"></div><div class="detail-copy"><div class="detail-kicker"><span class="status-pill status-${escape(status)}">${escape(status)}</span><span>${escape(formatDate(item.createdAt))}</span></div><h2 id="detail-title">${escape(listing.address || 'Address not provided')}</h2><p class="detail-neighborhood">${escape(neighborhoodName(listing.neighborhoodId))}</p><div class="detail-section"><h3>Display details</h3><p class="theme-name">${escape(listing.title || 'Untitled display')}</p><p>${escape(listing.description || 'No description provided.')}</p></div>${tagsMarkup(listing)}${actions}</div></section>`;
}

function listingsMarkup() {
  const shown = listings.filter(item => listingStatus(item) === listingFilter);
  const current = listingFor(selectedListingId);
  return `<div class="service-review-layout"><section class="queue" aria-label="Text display list"><div class="queue-heading"><h2>Text displays</h2><span class="count">${listings.length} total</span></div><div class="filters" role="group" aria-label="Filter text displays">${['published', 'hidden', 'pending'].map(status => `<button type="button" data-listing-filter="${status}" aria-pressed="${listingFilter === status}">${status[0].toUpperCase()}${status.slice(1)} <span>${listings.filter(item => listingStatus(item) === status).length}</span></button>`).join('')}</div><ul class="record-list">${shown.map(item => `<li><button class="record-button${item.id === selectedListingId ? ' is-selected' : ''}" type="button" data-listing="${escape(item.id)}" aria-pressed="${item.id === selectedListingId}"><span class="record-topline"><span class="record-address">${escape(item.address || 'Address not provided')}</span><span class="status-dot status-dot-${escape(listingStatus(item))}" aria-hidden="true"></span></span><span class="record-theme">${escape(item.title || 'Untitled display')}</span><span class="record-meta">${escape(neighborhoodName(item.neighborhoodId))} · ${escape(formatDate(item.createdAt))}</span></button></li>`).join('')}</ul>${shown.length ? '' : `<p class="empty-state">No ${listingFilter} text displays.</p>`}</section>${current ? listingDetail(current) : `<p class="select-prompt">Choose a text display to review its visibility.</p>`}</div>`;
}

function listingDetail(item) {
  const status = listingStatus(item);
  const action = status === 'hidden' ? 'restore-listing' : status === 'published' ? 'hide-listing' : 'publish-listing';
  const label = status === 'hidden' ? 'Restore to map' : status === 'published' ? 'Hide from map' : 'Publish to map';
  return `<section class="detail-panel has-record service-detail" aria-labelledby="detail-title"><button class="back-button" type="button" data-action="back">← All text displays</button><div class="detail-copy"><div class="detail-kicker"><span class="status-pill status-${escape(status)}">${escape(status)}</span><span>${escape(formatDate(item.createdAt))}</span></div><h2 id="detail-title">${escape(item.address || 'Address not provided')}</h2><p class="detail-neighborhood">${escape(neighborhoodName(item.neighborhoodId))}</p><div class="detail-section"><h3>Display details</h3><p class="theme-name">${escape(item.title || 'Untitled display')}</p><p>${escape(item.description || 'No description provided.')}</p></div>${tagsMarkup(item)}<div class="review-actions"><button class="${status === 'published' ? 'reject-button' : 'approve-button'}" type="button" data-action="${action}" ${busy ? 'disabled' : ''}>${label}</button></div></div></section>`;
}

function tagsMarkup(item) {
  const tags = [...(Array.isArray(item.tags) ? item.tags : []), ...(Array.isArray(item.customTags) ? item.customTags : [])];
  if (!tags.length) return '';
  return `<div class="detail-section"><h3>Tags</h3><ul class="tag-list">${tags.map(tag => `<li>${escape(tag)}</li>`).join('')}</ul></div>`;
}

function formatDate(value) {
  if (!value) return 'Recently submitted';
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? 'Recently submitted' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function loginMarkup() {
  return `<div class="page-heading"><div><p class="eyebrow">OWNER REVIEW</p><h1>Review workspace</h1><p class="lede">Sign in to review private photo submissions and display visibility.</p></div></div><section class="login-card"><form id="owner-login"><label for="owner-password">Owner passphrase</label><input id="owner-password" name="password" type="password" autocomplete="current-password" required><button class="approve-button" type="submit" ${busy ? 'disabled' : ''}>Sign in</button><p id="login-error" class="form-error" role="alert">${escape(failure)}</p></form></section>`;
}

function render() {
  main.removeAttribute('data-review-loading');
  main.innerHTML = authenticated ? baseMarkup() : loginMarkup();
  if (authenticated && section === 'inbox') renderInbox();
}

async function fetchQueues() {
  failure = '';
  const [pendingData, approvedData, rejectedData, listingData, openData, dismissedData] = await Promise.all([
    api('/api/admin/photos?status=pending'),
    api('/api/admin/photos?status=approved'),
    api('/api/admin/photos?status=rejected'),
    api(`/api/admin/listings?season=${encodeURIComponent(service?.season?.id || activeSeasonId)}`),
    api('/api/admin/reports?status=open'), api('/api/admin/reports?status=dismissed')
  ]);
  if (![pendingData, approvedData, rejectedData].every(data => Array.isArray(data?.photos)) || !Array.isArray(listingData?.listings)) throw new Error('The review service returned an incomplete queue. Please try again.');
  photos = [...pendingData.photos, ...approvedData.photos, ...rejectedData.photos];
  listings = listingData.listings;
  if (![openData, dismissedData].every(data => Array.isArray(data?.reports))) throw new Error('The inbox could not be loaded. Please try again.');
  reports = [...openData.reports, ...dismissedData.reports];
  reportCursors = { open: openData.nextCursor, dismissed: dismissedData.nextCursor };
  const shownReports = reports.filter(item => item.status === reportFilter);
  if (!shownReports.some(item => item.id === selectedReportId)) selectedReportId = shownReports[0]?.id ?? null;
  if (!photos.some(item => item.id === selectedPhotoId)) selectedPhotoId = photos[0]?.id ?? null;
  const shownListings = listings.filter(item => listingStatus(item) === listingFilter);
  if (!shownListings.some(item => item.id === selectedListingId)) selectedListingId = shownListings[0]?.id ?? null;
}

async function refresh() {
  try {
    await fetchQueues();
  } catch (error) {
    if (error.status === 401) { authenticated = false; photos = []; listings = []; reports = []; }
    failure = error.status === 409 ? 'This item changed while you were reviewing it. The latest queue has been loaded.' : (error.message || 'The queue could not be loaded. Please try again.');
    // A conflict is a signal to reload authoritative state; a failed reload remains an error.
    if (error.status === 409) {
      try { await fetchQueues(); } catch (refreshError) { failure = refreshError.message || 'The latest queue could not be loaded. Please try again.'; }
    }
  }
  render();
}

async function withBusy(action) {
  if (busy) return;
  busy = true; failure = ''; notice = ''; render();
  try {
    await action();
    await fetchQueues();
  } catch (error) {
    if (error.status === 401) {
      authenticated = false; photos = []; listings = []; reports = [];
      failure = 'Your session expired. Sign in again to continue reviewing.';
      return;
    }
    const message = error.status === 409 ? 'This item changed in another review. The latest version is shown; please review it again.' : (error.message || 'The action could not be completed. Please try again.');
    failure = message;
    try { await fetchQueues(); } catch (refreshError) { failure = `${message} ${refreshError.message || ''}`; }
    // fetchQueues clears stale notices as part of a successful reload.
    if (!failure) failure = message;
  } finally { busy = false; render(); }
}

async function boot() {
  try {
    service = await loadService();
    if (!service) {
      main.querySelector('.review-bootstrap')?.remove();
      main.removeAttribute('data-review-loading');
      await import('./review-demo.mjs');
      return;
    }
  } catch (error) {
    // Enabled service errors stay on the service path; never show fictional records.
    failure = error.message || 'The listing service could not be reached. Please try again.';
    authenticated = false;
    main.removeAttribute('data-review-loading');
    main.innerHTML = `<section class="service-alert" role="alert"><h1>Review is unavailable</h1><p>${escape(failure)}</p><button type="button" data-action="retry">Retry</button></section>`;
    return;
  }
  try {
    const session = await api('/api/session');
    authenticated = session?.authenticated === true;
    if (authenticated) {
      try { await fetchQueues(); }
      catch (error) { failure = error.message || 'The queue could not be loaded. Please try again.'; }
    }
  } catch (error) {
    failure = error.message || 'The owner session could not be checked. Please try again.';
    authenticated = false;
  }
  render();
}

main.addEventListener('submit', async event => {
  if (event.target.id !== 'owner-login') return;
  event.preventDefault();
  const password = new FormData(event.target).get('password');
  busy = true; failure = ''; render();
  try {
    const result = await api('/api/session', { method: 'POST', body: { password } });
    authenticated = result?.authenticated === true;
    if (!authenticated) throw new Error('The owner passphrase was not accepted.');
    await fetchQueues();
  } catch (error) { failure = error.message || 'Sign in failed. Please try again.'; authenticated = false; }
  finally { busy = false; render(); }
});

main.addEventListener('click', async event => {
  const target = event.target.closest('button');
  if (!target) return;
  if (target.dataset.section) { section = target.dataset.section; render(); return; }
  if (target.dataset.photoFilter) { photoFilter = target.dataset.photoFilter; selectedPhotoId = null; await refresh(); return; }
  if (target.dataset.listingFilter) { listingFilter = target.dataset.listingFilter; selectedListingId = null; render(); return; }
  if (target.dataset.photo) { selectedPhotoId = target.dataset.photo; render(); return; }
  if (target.dataset.listing) { selectedListingId = target.dataset.listing; render(); return; }
  if (target.dataset.reportFilter) { reportFilter = target.dataset.reportFilter; selectedReportId = reports.find(item => item.status === reportFilter)?.id ?? null; render(); return; }
  if (target.dataset.report) { selectedReportId = target.dataset.report; render(); return; }
  switch (target.dataset.action) {
    case 'retry': if (!service) { await boot(); } else { await refresh(); } break;
    case 'back': if (section === 'photos') selectedPhotoId = null; else if (section === 'inbox') selectedReportId = null; else selectedListingId = null; render(); break;
    case 'logout':
      busy = true; render();
      try { await api('/api/session', { method: 'DELETE' }); authenticated = false; photos = []; listings = []; reports = []; notice = ''; failure = ''; }
      catch (error) { failure = error.message || 'Could not sign out. Please try again.'; }
      finally { busy = false; render(); }
      break;
    case 'decide-report': {
      const item = reports.find(item => item.id === selectedReportId); if (!item) return;
      const status = item.status === 'open' ? 'dismissed' : 'open';
      await withBusy(async () => {
        await api(`/api/admin/reports/${encodeURIComponent(item.id)}/decision`, { method: 'POST', body: { status, expectedVersion: item.version } });
        reportFilter = status; selectedReportId = item.id; notice = status === 'open' ? 'Message reopened.' : 'Message dismissed.';
      });
      break;
    }
    case 'more-reports': {
      if (busy) return;
      const requestedFilter = reportFilter;
      const cursor = reportCursors[requestedFilter];
      if (!cursor) return;
      busy = true; render();
      try {
        const data = await api(`/api/admin/reports?status=${requestedFilter}&before=${encodeURIComponent(cursor)}`);
        if (!Array.isArray(data?.reports)) throw new Error('The inbox could not be loaded.');
        const ids = new Set(reports.map(item => item.id)); reports.push(...data.reports.filter(item => !ids.has(item.id))); reportCursors[requestedFilter] = data.nextCursor;
      } catch (error) {
        if (error.status === 401) { authenticated = false; reports = []; photos = []; listings = []; }
        failure = error.message || 'More messages could not be loaded. Please try again.';
      } finally { busy = false; render(); }
      break;
    }
    case 'approve-photo': case 'reject-photo': case 'undo-photo': {
      const item = photoFor(selectedPhotoId); if (!item) return;
      const decision = target.dataset.action === 'approve-photo' ? 'approved' : target.dataset.action === 'reject-photo' ? 'rejected' : 'pending';
      await withBusy(async () => {
        await api(`/api/admin/photos/${encodeURIComponent(item.id)}/decision`, { method: 'POST', body: { decision, expectedVersion: item.version } });
        photoFilter = decision; selectedPhotoId = item.id; notice = decision === 'pending' ? 'Photo returned to the pending queue.' : `Photo ${decision}. The display remains on the map.`;
      });
      break;
    }
    case 'hide-listing': case 'restore-listing': case 'publish-listing': {
      const item = listingFor(selectedListingId); if (!item) return;
      const status = target.dataset.action === 'hide-listing' ? 'hidden' : 'published';
      await withBusy(async () => {
        await api(`/api/admin/listings/${encodeURIComponent(item.id)}/visibility`, { method: 'POST', body: { status, expectedVersion: item.version } });
        listingFilter = status; selectedListingId = item.id; notice = status === 'hidden' ? 'Text display hidden from the map.' : 'Text display is published on the map.';
      });
      break;
    }
  }
});

void boot();
