import { createDemoReviewRepository } from './review-data.mjs';
import { bindDialog } from './dialog.mjs';

const repository = createDemoReviewRepository();
const list = document.querySelector('#record-list');
const content = document.querySelector('#detail-content');
const detail = document.querySelector('#detail-panel');
const prompt = document.querySelector('#select-prompt');
const empty = document.querySelector('#queue-empty');
const announcement = document.querySelector('#announcement');
const rejectDialog = document.querySelector('#reject-dialog');
const rejectForm = document.querySelector('#reject-form');
const rejectReason = document.querySelector('#reject-reason');
const rejectNote = document.querySelector('#reject-note');
const rejectError = document.querySelector('#reject-error');
const dialog = bindDialog(rejectDialog, { initialFocus: () => document.querySelector('#reject-title') });
let records = await repository.list();
let filter = 'pending';
let selectedId = null;

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const activeRecords = () => records.filter(record => record.status === filter);

function render() {
  for (const status of ['pending', 'approved', 'rejected']) {
    document.querySelector(`#${status}-count`).textContent = records.filter(record => record.status === status).length;
  }
  document.querySelector('#queue-total').textContent = `${records.length} total`;
  list.replaceChildren();
  const shown = activeRecords();
  empty.hidden = shown.length > 0;
  empty.textContent = filter === 'pending' ? 'You’re all caught up. No submissions are waiting.' : `No ${filter} demo decisions yet.`;
  for (const record of shown) {
    const item = document.createElement('li');
    item.innerHTML = `<button class="record-button${record.id === selectedId ? ' is-selected' : ''}" type="button" data-record="${escape(record.id)}" aria-pressed="${record.id === selectedId}"><span class="record-topline"><span class="record-address">${escape(record.address)}</span><span class="status-dot" aria-hidden="true"></span></span><span class="record-theme">${escape(record.theme)}</span><span class="record-meta">${escape(record.neighborhood)} <span aria-hidden="true">·</span> ${escape(record.submitted)}</span></button>`;
    list.append(item);
  }
  if (selectedId && !shown.some(item => item.id === selectedId)) selectedId = null;
  document.querySelectorAll('[data-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === filter)));
  if (selectedId) renderDetail(); else { content.replaceChildren(); detail.classList.remove('has-record'); prompt.hidden = false; }
}

async function refreshRecords() {
  records = await repository.list();
}

function renderDetail() {
  const record = records.find(item => item.id === selectedId);
  if (!record) return;
  prompt.hidden = true;
  detail.classList.add('has-record');
  const reason = record.reason ? `<div class="decision-note"><strong>Demo decision reason</strong><p>${escape(record.reason)}</p></div>` : '';
  const actions = record.status === 'pending'
    ? '<div class="review-actions"><button class="approve-button" type="button" data-action="approve">Approve in demo <span aria-hidden="true">✓</span></button><button class="reject-button" type="button" data-action="reject">Reject…</button><button class="next-button" type="button" data-action="next">Review next →</button></div>'
    : '<div class="decision-bar"><span>Demo decision — no map changes</span><button type="button" class="undo-button" data-action="undo">Undo decision</button></div>';
  content.innerHTML = `<div class="detail-image"><img src="${escape(record.image)}" alt="Illustrative artwork for fictional demo record"></div><div class="detail-copy"><div class="detail-kicker"><span class="status-pill status-${escape(record.status)}">${escape(record.status)}${record.status !== 'pending' ? ' · demo' : ''}</span><span>${escape(record.submitted)}</span></div><h2 id="detail-title">${escape(record.address)}</h2><p class="detail-neighborhood">${escape(record.neighborhood)} · fictional sample address</p><div class="detail-section"><h3>Display details</h3><p class="theme-name">${escape(record.theme)}</p><p>${escape(record.description)}</p></div><div class="detail-section"><h3>Tags</h3><ul class="tag-list">${record.tags.map(tag => `<li>${escape(tag)}</li>`).join('')}</ul></div>${reason}${actions}<p class="demo-footnote">Sample record · no contact details or private listing data</p></div>`;
  document.querySelector('#detail-title').tabIndex = -1;
}

list.addEventListener('click', event => {
  const button = event.target.closest('[data-record]');
  if (!button) return;
  selectedId = button.dataset.record;
  render();
  document.querySelector('#detail-title')?.focus({ preventScroll: true });
  if (matchMedia('(max-width: 760px)').matches) detail.scrollIntoView({ block: 'start', behavior: 'smooth' });
});
document.querySelector('.filters').addEventListener('click', event => {
  const button = event.target.closest('[data-filter]');
  if (!button) return;
  filter = button.dataset.filter;
  if (selectedId && records.find(item => item.id === selectedId)?.status !== filter) selectedId = null;
  render();
});
document.querySelector('#back-to-queue').addEventListener('click', () => {
  selectedId = null;
  render();
  document.querySelector('.queue').scrollIntoView({ block: 'start', behavior: 'smooth' });
  document.querySelector('[data-record]')?.focus();
});
content.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button || !selectedId) return;
  if (button.dataset.action === 'reject') {
    rejectReason.value = '';
    rejectNote.value = '';
    rejectError.textContent = '';
    dialog.open(button);
    return;
  }
  if (button.dataset.action === 'approve') {
    await repository.decide(selectedId, 'approved', 'Approved in demo');
    await refreshRecords();
    filter = 'approved'; render(); document.querySelector('[data-action="undo"]')?.focus(); announcement.textContent = 'Approved in demo. No map changes.';
  }
  if (button.dataset.action === 'undo') {
    await repository.undo(selectedId);
    await refreshRecords();
    filter = 'pending'; render(); document.querySelector('[data-action="approve"]')?.focus(); announcement.textContent = 'Demo decision undone.';
  }
  if (button.dataset.action === 'next') {
    const next = activeRecords().find(item => item.id !== selectedId);
    selectedId = next?.id ?? selectedId;
    render(); document.querySelector('[data-action="approve"]')?.focus();
  }
});
rejectForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!rejectReason.value) {
    rejectError.textContent = 'Choose a reason to continue.';
    rejectReason.setAttribute('aria-invalid', 'true');
    rejectReason.focus();
    return;
  }
  rejectError.textContent = '';
  rejectReason.removeAttribute('aria-invalid');
  const reason = rejectNote.value.trim() ? `${rejectReason.value} — ${rejectNote.value.trim()}` : rejectReason.value;
  await repository.decide(selectedId, 'rejected', reason);
  dialog.close();
  await refreshRecords();
  filter = 'rejected'; render(); document.querySelector('[data-action="undo"]')?.focus(); announcement.textContent = 'Rejected in demo. No map changes.';
});
rejectReason.addEventListener('change', () => {
  if (rejectReason.value) {
    rejectError.textContent = '';
    rejectReason.removeAttribute('aria-invalid');
  }
});
rejectDialog.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => dialog.close()));
render();
