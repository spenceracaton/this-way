import { bindDialog } from './dialog.mjs';

const TAGS = ['Lights', 'Inflatables', 'Music', 'Animated display', 'Handmade decorations', 'Nativity', 'Santa', 'Winter wonderland'];
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const PHOTO_LIMIT = 10 * 1024 * 1024;

export function createSubmission() {
  const byId = id => document.getElementById(id);
  const dialog = byId('submission-dialog');
  const form = byId('submission-form');
  const title = byId('submission-title');
  const trigger = byId('add-display');
  const photos = [];
  let previewing = false, loadingPhotos = false, photoRevision = 0;
  const modal = bindDialog(dialog, { initialFocus: () => title });
  const fields = ['submission-address', 'submission-theme', 'submission-description'].map(byId);
  const node = (tag, text, className) => {
    const item = document.createElement(tag);
    if (text) item.textContent = text;
    if (className) item.className = className;
    return item;
  };
  for (const tag of TAGS) {
    const label = node('label', '', 'submission-tag');
    const input = document.createElement('input');
    input.type = 'checkbox'; input.name = 'tags'; input.value = tag;
    label.append(input, node('span', tag));
    byId('submission-tags').append(label);
  }
  function setError(field, message) {
    field.setAttribute('aria-invalid', String(Boolean(message)));
    byId(field.id + '-error').textContent = message;
  }
  function validate() {
    let first;
    for (const field of fields) {
      const max = field.maxLength;
      let message = '';
      if (field.required && !field.value.trim()) message = 'Enter a street address to preview your display.';
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
  }));
  function showForm() {
    previewing = false;
    title.textContent = 'Add a display';
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
    const pending = files.map(file => ({ url: URL.createObjectURL(file) }));
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
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (loadingPhotos || !validate()) return;
    renderPreview(); previewing = true;
    title.textContent = 'Preview display';
    form.hidden = true; byId('submission-preview').hidden = false;
    byId('submission-form-actions').hidden = true; byId('submission-preview-actions').hidden = false;
    byId('submission-scroll').scrollTop = 0; title.focus({ preventScroll: true });
  });
  byId('submission-edit').onclick = () => { showForm(); title.focus({ preventScroll: true }); };
  byId('submission-done').onclick = () => modal.close();
  byId('submission-close').onclick = () => modal.close();
  trigger.onclick = () => {
    if (dialog.open) return;
    showForm();
    modal.open(trigger);
  };
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
  });
  window.addEventListener('pagehide', event => {
    if (event.persisted) return;
    ++photoRevision;
    photos.forEach(photo => URL.revokeObjectURL(photo.url));
  });
}
