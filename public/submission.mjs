import { bindDialog } from './dialog.mjs';
import { api, defaultSeasonId, newRequestId, preparePhoto } from './service-client.mjs';
import { seasonFor } from './season-config.mjs';

const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const PHOTO_LIMIT = 10 * 1024 * 1024;

export function createSubmission({ service = null, neighborhood = null, onPublished = () => {}, chooseLocation = null } = {}) {
  const byId = id => document.getElementById(id);
  const dialog = byId('submission-dialog');
  const form = byId('submission-form');
  const title = byId('submission-title');
  const trigger = byId('add-display');
  const photos = [];
  let previewing = false, loadingPhotos = false, photoRevision = 0;
  let chosenPosition = null, picker = null, requestId = null, savedListing = null, uploadToken = null, publishedOnMap = false;
  const modal = bindDialog(dialog, { initialFocus: () => title });
  const fields = ['submission-address', 'submission-theme', 'submission-description'].map(byId);
  const season = seasonFor(service?.season?.id || defaultSeasonId);
  const submissionTitle = service?.season?.submissionTitle || season?.submissionTitle || 'Add a display';
  const node = (tag, text, className) => {
    const item = document.createElement(tag);
    if (text) item.textContent = text;
    if (className) item.className = className;
    return item;
  };
  const availableTags = service?.season?.tags || season?.tags || [];
  for (const tag of availableTags) {
    const label = node('label', '', 'submission-tag');
    const input = document.createElement('input');
    input.type = 'checkbox'; input.name = 'tags'; input.value = tag;
    label.append(input, node('span', tag));
    byId('submission-tags').append(label);
  }
  title.textContent = submissionTitle;
  byId('submission-theme').placeholder = service?.season?.themePlaceholder || season?.themePlaceholder || '';
  function setError(field, message) {
    field.setAttribute('aria-invalid', String(Boolean(message)));
    byId(field.id + '-error').textContent = message;
  }
  function validate() {
    let first;
    for (const field of fields) {
      const max = field.maxLength;
      let message = '';
      if (field.required && !field.value.trim()) message = service ? 'Enter a street address to add your display to the map.' : 'Enter a street address to preview your display.';
      else if (field.value.length > max) message = `Use ${max} characters or fewer.`;
      setError(field, message);
      if (message && !first) first = field;
    }
    first?.focus();
    return !first;
  }
  fields.forEach(field => field.addEventListener('input', () => {
    if (field.getAttribute('aria-invalid') === 'true') setError(field, '');
    byId('submission-description-count').textContent = `${byId('submission-description').value.length}/500`;
    if (field.id === 'submission-address' && service) setPosition(null);
  }));
  function showForm() {
    previewing = false;
    title.textContent = submissionTitle;
    form.hidden = false;
    byId('submission-preview').hidden = true;
    byId('submission-form-actions').hidden = false;
    byId('submission-preview-actions').hidden = true;
    byId('submission-scroll').scrollTop = 0;
  }
  function image(photo, index) {
    const img = node('img');
    img.src = photo.url; img.alt = `Selected display photo ${index + 1}`;
    return img;
  }
  function renderPhotos() {
    const host = byId('submission-photo-previews');
    host.replaceChildren();
    photos.forEach((photo, index) => {
      const item = node('div', '', 'submission-photo-item');
      const remove = node('button', '×', 'submission-photo-remove');
      remove.type = 'button'; remove.setAttribute('aria-label', `Remove photo ${index + 1}`);
      remove.onclick = () => {
        photos.splice(index, 1); URL.revokeObjectURL(photo.url);
        byId('submission-photos-error').textContent = '';
        renderPhotos();
        (host.querySelector('button') || byId('submission-photos')).focus();
      };
      item.append(image(photo, index), remove); host.append(item);
    });
  }
  byId('submission-photos').addEventListener('change', async event => {
    const files = [...event.target.files];
    event.target.value = '';
    const status = byId('submission-photos-error');
    status.textContent = '';
    if (!files.length) return;
    if (photos.length + files.length > 3) { status.textContent = 'Choose up to 3 photos. Remove one before adding more.'; return; }
    if (files.some(file => !PHOTO_TYPES.has(file.type) || file.size > PHOTO_LIMIT || !file.size)) {
      status.textContent = 'Choose JPEG, PNG or WebP photos, up to 10 MB each.'; return;
    }
    const revision = ++photoRevision;
    loadingPhotos = true; byId('submission-preview-button').disabled = true;
    const pending = files.map(file => ({ file, url: URL.createObjectURL(file), uploaded: false, requestId: null }));
    try {
      await Promise.all(pending.map(async photo => {
        const img = new Image(); img.src = photo.url; await img.decode();
        if (!img.naturalWidth) throw new Error('Invalid photo');
      }));
      if (revision !== photoRevision) { pending.forEach(photo => URL.revokeObjectURL(photo.url)); return; }
      photos.push(...pending); renderPhotos();
    } catch {
      pending.forEach(photo => URL.revokeObjectURL(photo.url));
      if (revision === photoRevision) status.textContent = 'That photo couldn’t be opened. Try another JPEG, PNG or WebP image.';
    } finally {
      if (revision === photoRevision) { loadingPhotos = false; byId('submission-preview-button').disabled = false; }
    }
  });
  function renderPreview() {
    const host = byId('submission-preview-card');
    host.replaceChildren();
    if (photos.length) {
      const media = node('div', '', 'submission-preview-photos');
      photos.forEach((photo, i) => media.append(image(photo, i)));
      host.append(media);
    }
    const address = byId('submission-address').value.trim();
    const theme = byId('submission-theme').value.trim();
    host.append(node('h3', theme || address));
    if (theme) host.append(node('p', address, 'submission-preview-address'));
    const description = byId('submission-description').value.trim();
    if (description) host.append(node('p', description, 'submission-preview-description'));
    const selected = [...form.querySelectorAll('[name="tags"]:checked')];
    if (selected.length) {
      const tags = node('ul', '', 'submission-preview-tags');
      selected.forEach(input => tags.append(node('li', input.value)));
      host.append(tags);
    }
  }
  function setPosition(position) {
    chosenPosition = position;
    const match = byId('submission-location-match');
    match.checked = false;
    byId('submission-location-match-label').hidden = !position;
    const status = byId('submission-location-status');
    status.textContent = position ? `Pin position selected for ${byId('submission-address').value.trim()}. Confirm below that it matches the address.` : 'Choose a pin position on the neighborhood map.';
    status.dataset.selected = String(Boolean(position));
  }
  if (service) {
    byId('submission-preview-notice').textContent = 'Details appear now. Photos wait for approval.';
    byId('submission-preview-button').textContent = 'Add to map';
    byId('submission-photos-help').textContent = 'Up to 3 JPEG, PNG or WebP photos, 10 MB each. Photos are private until approved.';
    byId('submission-location-picker').hidden = false;
    byId('submission-location-button').addEventListener('click', async () => {
      byId('submission-location-map-wrap').hidden = false;
      byId('submission-location-button').hidden = true;
      byId('submission-location-address').textContent = byId('submission-address').value.trim();
      dialog.dataset.placing = 'true';
      try {
        if (!picker && chooseLocation) picker = await chooseLocation(byId('submission-location-map'));
        byId('submission-location-map').focus({ preventScroll: true });
        byId('submission-location-map-wrap').scrollIntoView({ block: 'start' });
      } catch (error) {
        byId('submission-location-status').textContent = error.message || 'The neighborhood pin map could not load.';
        dialog.dataset.placing = 'false';
        byId('submission-location-button').hidden = false;
      }
    });
    byId('submission-location-confirm').addEventListener('click', () => {
      if (!picker) return;
      const position = picker.getPosition();
      setPosition(position);
      dialog.dataset.placing = 'false';
      byId('submission-location-map-wrap').hidden = true;
      byId('submission-location-button').hidden = false;
      byId('submission-location-button').textContent = 'Adjust pin position';
      byId('submission-location-status').focus();
    });
  }
  async function publish() {
    const address = byId('submission-address').value.trim();
    const theme = byId('submission-theme').value.trim();
    const description = byId('submission-description').value.trim();
    const tags = [...form.querySelectorAll('[name="tags"]:checked')].map(input => input.value);
    if (!savedListing && !chosenPosition) {
      byId('submission-location-status').textContent = 'Choose and confirm where the pin belongs on the map before publishing.';
      byId('submission-location-button').focus(); return;
    }
    if (!savedListing && !byId('submission-location-match').checked) {
      byId('submission-location-status').textContent = 'Confirm that the pin position matches the entered address.';
      byId('submission-location-match').focus(); return;
    }
    const button = byId('submission-preview-button');
    button.disabled = true; loadingPhotos = true;
    byId('submission-service-error').textContent = '';
    try {
      if (!savedListing) {
        const payload = {
          seasonId: service.season.id || defaultSeasonId,
          neighborhoodId: neighborhood.id, address, title: theme, description, tags,
          latitude: chosenPosition.lat, longitude: chosenPosition.lng
        };
        requestId ||= newRequestId();
        const result = await api('/api/listings', { method: 'POST', body: { clientRequestId: requestId, ...payload } });
        if (!result?.listing?.id || !result.uploadToken) throw new Error('The listing service did not confirm the published display. Retry this submission.');
        savedListing = result.listing; uploadToken = result.uploadToken;
      }
      let failures = 0;
      if (!publishedOnMap) { onPublished(savedListing); publishedOnMap = true; }
      if (photos.some(photo => !photo.uploaded) && !uploadToken) {
        const grant = await api(`/api/listings/${encodeURIComponent(savedListing.id)}/photo-upload-token`, {
          method: 'POST', body: { clientRequestId: requestId }
        });
        uploadToken = grant.uploadToken;
      }
      for (const photo of photos) {
        if (photo.uploaded) continue;
        try {
          photo.prepared ||= await preparePhoto(photo.file);
          photo.requestId ||= newRequestId();
          await api(`/api/listings/${encodeURIComponent(savedListing.id)}/photos`, { method: 'POST', headers: {
            'Authorization': `Bearer ${uploadToken}`, 'X-Photo-Request-Id': photo.requestId,
            'Content-Type': photo.prepared.type
          }, body: photo.prepared });
          photo.uploaded = true;
        } catch (error) { failures++; photo.error = error.message; }
      }
      if (failures) uploadToken = null;
      showReceipt(failures);
    } catch (error) {
      byId('submission-service-error').textContent = error.message || 'The display could not be published. Please try again.';
    } finally { loadingPhotos = false; button.disabled = false; }
  }
  function showReceipt(failures = 0) {
    form.hidden = true; byId('submission-preview').hidden = true; byId('submission-receipt').hidden = false;
    byId('submission-receipt-title').textContent = 'Your display is on the map';
    byId('submission-receipt-copy').textContent = 'Your address and display details are public now.';
    const uploaded = photos.filter(photo => photo.uploaded).length;
    const pending = photos.length - uploaded;
    byId('submission-photo-receipt').textContent = !photos.length ? 'No photos were added.' : [
      uploaded ? `${uploaded} ${uploaded === 1 ? 'photo was sent privately and is' : 'photos were sent privately and are'} waiting for owner review.` : '',
      pending ? (pending === 1 ? '1 photo could not be uploaded and remains on this device.' : `${pending} photos could not be uploaded and remain on this device.`) + (failures ? ' Retry the upload when your connection is ready.' : '') : ''
    ].filter(Boolean).join(' ');
    byId('submission-photo-retry').hidden = !pending;
    byId('submission-form-actions').hidden = true; byId('submission-preview-actions').hidden = true;
    byId('submission-receipt-actions').hidden = false;
    byId('submission-scroll').scrollTop = 0;
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (loadingPhotos || !validate()) return;
    if (service) { publish(); return; }
    renderPreview(); previewing = true;
    title.textContent = 'Preview display';
    form.hidden = true; byId('submission-preview').hidden = false;
    byId('submission-form-actions').hidden = true; byId('submission-preview-actions').hidden = false;
    byId('submission-scroll').scrollTop = 0; title.focus({ preventScroll: true });
  });
  byId('submission-edit').onclick = () => { showForm(); title.focus({ preventScroll: true }); };
  byId('submission-done').onclick = () => modal.close();
  byId('submission-receipt-done').onclick = () => {
    if (savedListing && photos.every(photo => photo.uploaded)) { form.reset(); showForm(); }
    modal.close();
  };
  byId('submission-photo-retry').onclick = publish;
  byId('submission-close').onclick = () => modal.close();
  trigger.onclick = () => {
    if (dialog.open) return;
    if (savedListing) showReceipt(); else showForm();
    modal.open(trigger);
  };
  trigger.disabled = false;
  dialog.addEventListener('close', () => {
    if (previewing) showForm();
  });
  form.addEventListener('reset', () => {
    ++photoRevision; loadingPhotos = false;
    byId('submission-preview-button').disabled = false;
    photos.splice(0).forEach(photo => URL.revokeObjectURL(photo.url)); renderPhotos();
    fields.forEach(field => setError(field, ''));
    byId('submission-photos-error').textContent = '';
    byId('submission-description-count').textContent = '0/500';
    picker?.destroy(); picker = null; byId('submission-location-map-wrap').hidden = true; byId('submission-location-match-label').hidden = true;
    chosenPosition = null; savedListing = null; publishedOnMap = false; uploadToken = null; requestId = null; setPosition(null);
    dialog.dataset.placing = 'false';
    byId('submission-location-button').hidden = false;
    byId('submission-location-button').textContent = 'Choose pin position';
    byId('submission-receipt').hidden = true; byId('submission-receipt-actions').hidden = true;
    byId('submission-form-actions').hidden = false; byId('submission-service-error').textContent = '';
  });
  window.addEventListener('pagehide', event => {
    if (event.persisted) return;
    ++photoRevision;
    photos.forEach(photo => URL.revokeObjectURL(photo.url));
  });
}
