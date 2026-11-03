import { bindDialog } from './dialog.mjs';
import { api, newRequestId, preparePhoto } from './service-client.mjs';

const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_SIZE = 10 * 1024 * 1024;

function verifyImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      if (image.naturalWidth > 0 && image.naturalHeight > 0) resolve();
      else reject(new Error('That file does not contain a readable image.'));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file does not contain a readable image. Choose a valid JPEG, PNG or WebP photo.'));
    };
    image.src = url;
  });
}

export function initPhotoContribution({ getSelected, service = null }) {
  const trigger = document.querySelector('#detail-add-photos');
  if (!trigger) return { clear() {} };

  const dialog = document.createElement('dialog');
  dialog.className = 'photo-contribution-dialog';
  dialog.setAttribute('aria-labelledby', 'photo-contribution-title');
  dialog.innerHTML = `
    <div class="photo-contribution-topbar"><h2 id="photo-contribution-title" tabindex="-1">Add photos</h2><button type="button" class="photo-contribution-close" aria-label="Close Add photos">×</button></div>
    <div class="photo-contribution-scroll">
      <section class="photo-contribution-edit" aria-labelledby="photo-contribution-title">
        <p class="photo-contribution-address"></p>
        <p class="photo-contribution-help" id="photo-contribution-help">Choose up to 3 JPEG, PNG or WebP photos. Each photo can be up to 10 MB.</p>
        <label class="photo-contribution-picker">＋ Choose photos<input class="photo-contribution-input" type="file" accept="image/jpeg,image/png,image/webp" multiple aria-describedby="photo-contribution-help photo-contribution-error"></label>
        <p class="photo-contribution-help photo-contribution-privacy">Photos stay on this device and are only shown in this preview.</p>
        <div class="photo-contribution-previews"></div>
        <p class="photo-contribution-error" id="photo-contribution-error" role="status" aria-live="polite" tabindex="-1"></p>
        <label class="photo-contribution-rights"><input type="checkbox"> I have permission to use these photos in this preview.</label>
        <button type="button" class="photo-contribution-next" disabled>Preview photos</button>
      </section>
      <section class="photo-contribution-preview" hidden aria-labelledby="photo-contribution-preview-title">
        <h3 id="photo-contribution-preview-title">Preview photos</h3><p class="photo-contribution-address"></p><p class="photo-contribution-only">Preview only. Not uploaded.</p><div class="photo-contribution-preview-images"></div>
        <p class="photo-contribution-send-status" role="status" aria-live="polite"></p>
        <div class="photo-contribution-actions"><button type="button" class="photo-contribution-back">Back to editing</button><button type="button" class="photo-contribution-send" hidden>Send photos for review</button><button type="button" class="photo-contribution-done">Done</button></div>
      </section>
    </div>`;
  document.body.append(dialog);

  const $ = selector => dialog.querySelector(selector);
  const input = $('.photo-contribution-input');
  const previews = $('.photo-contribution-previews');
  const err = $('.photo-contribution-error');
  const rights = $('.photo-contribution-rights input');
  const next = $('.photo-contribution-next');
  const edit = $('.photo-contribution-edit');
  const preview = $('.photo-contribution-preview');
  const urls = new Set();
  let files = [];
  let validationGeneration = 0;
  let selectedId = null;
  let selectedName = '';
  let contributionId = null, uploadToken = null;
  const controller = bindDialog(dialog, { initialFocus: () => $('#photo-contribution-title') });

  function showError(message) {
    err.textContent = message;
    input.setAttribute('aria-invalid', 'true');
    input.focus({ preventScroll: false });
  }
  function clearError() {
    err.textContent = '';
    input.removeAttribute('aria-invalid');
  }

  function clearFiles() {
    validationGeneration++;
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear(); files = []; previews.replaceChildren(); $('.photo-contribution-preview-images').replaceChildren();
    input.value = ''; input.removeAttribute('aria-invalid'); rights.checked = false; next.disabled = true; err.textContent = '';
    contributionId = null; uploadToken = null; $('.photo-contribution-send-status').textContent = '';
    edit.hidden = false; preview.hidden = true;
  }
  function clear() { clearFiles(); selectedId = null; selectedName = ''; contributionId = null; uploadToken = null; }
  function syncAddress() {
    const selected = getSelected?.() || null;
    const id = selected?.id ?? null;
    if (id !== selectedId) clearFiles();
    selectedId = id;
    selectedName = selected?.name || selected?.address || '';
    dialog.querySelectorAll('.photo-contribution-address').forEach(node => { node.textContent = selectedName; });
    const live = Boolean(selected?.live && service);
    $('.photo-contribution-privacy').textContent = live
      ? 'Photos are sent privately and stay hidden until the owner approves them.'
      : 'Photos stay on this device and are only shown in this preview.';
    $('.photo-contribution-only').textContent = live ? 'Review these photos before sending them privately to the owner.' : 'Preview only. Not uploaded.';
    $('.photo-contribution-send').hidden = !live;
    $('.photo-contribution-rights').lastChild.textContent = live
      ? ' I have permission to submit these photos for display review.'
      : ' I have permission to use these photos in this preview.';
    return Boolean(selected);
  }
  function validate() { next.disabled = !files.length || !rights.checked; }
  function paint() {
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
    previews.replaceChildren();
    files.forEach((file, index) => {
      const url = URL.createObjectURL(file); urls.add(url);
      const row = document.createElement('div'); row.className = 'photo-contribution-thumb';
      const img = document.createElement('img'); img.src = url; img.alt = `Photo ${index + 1} preview`;
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove photo ${index + 1}`);
      remove.addEventListener('click', () => { URL.revokeObjectURL(url); urls.delete(url); files.splice(index, 1); paint(); validate(); });
      row.append(img, remove); previews.append(row);
    });
  }
  input.addEventListener('change', async () => {
    clearError();
    const incoming = Array.from(input.files || []); input.value = '';
    if (!incoming.length) return;
    if (files.length + incoming.length > 3) {
      showError('Choose up to 3 photos total. No photos from this selection were added.');
      return;
    }
    const generation = ++validationGeneration;
    input.disabled = true;
    try {
      for (const file of incoming) {
        if (!TYPES.has(file.type)) throw new Error('Choose JPEG, PNG or WebP photos.');
        if (file.size > MAX_SIZE) throw new Error('Each photo must be 10 MB or smaller.');
      }
      for (const file of incoming) await verifyImage(file);
      if (generation !== validationGeneration) return;
      files.push(...incoming);
    } catch (error) {
      if (generation === validationGeneration) showError((error?.message || 'One or more files could not be opened as an image.') + ' No photos from this selection were added.');
    } finally {
      if (generation === validationGeneration) input.disabled = false;
    }
    if (generation === validationGeneration) { paint(); validate(); }
  });
  rights.addEventListener('change', validate);
  next.addEventListener('click', () => {
    if (!files.length || !rights.checked) { err.textContent = 'Choose at least one photo and confirm you have permission to share it.'; err.focus(); return; }
    const container = $('.photo-contribution-preview-images'); container.replaceChildren();
    files.forEach((file, i) => { const figure = document.createElement('figure'); const image = document.createElement('img'); image.src = Array.from(urls)[i]; image.alt = `Selected photo ${i + 1}`; figure.append(image); container.append(figure); });
    edit.hidden = true; preview.hidden = false; $('.photo-contribution-done').focus();
  });
  $('.photo-contribution-send').addEventListener('click', async () => {
    const selected = getSelected?.();
    if (!selected?.live || !service) return;
    const send = $('.photo-contribution-send');
    const status = $('.photo-contribution-send-status');
    send.disabled = true; status.textContent = 'Sending photos privately…';
    try {
      contributionId ||= newRequestId();
      if (!uploadToken) {
        const grant = await api(`/api/listings/${encodeURIComponent(selected.id)}/photo-upload-token`, { method: 'POST', body: { clientRequestId: contributionId } });
        uploadToken = grant.uploadToken;
      }
      for (const file of files) {
        if (file.uploaded) continue;
        file.prepared ||= await preparePhoto(file);
        file.requestId ||= newRequestId();
        await api(`/api/listings/${encodeURIComponent(selected.id)}/photos`, { method: 'POST', headers: {
          'Authorization': `Bearer ${uploadToken}`, 'X-Photo-Request-Id': file.requestId, 'Content-Type': file.prepared.type
        }, body: file.prepared });
        file.uploaded = true;
      }
      status.textContent = 'Your photos were sent privately. They will appear only if the owner approves them.';
      send.hidden = true;
    } catch (error) {
      uploadToken = null;
      status.textContent = `${error.message || 'The photos could not be sent.'} Try again when your connection is ready.`;
    } finally { send.disabled = false; }
  });
  $('.photo-contribution-back').addEventListener('click', () => { preview.hidden = true; edit.hidden = false; next.focus(); });
  $('.photo-contribution-done').addEventListener('click', () => { clearFiles(); controller.close(); });
  $('.photo-contribution-close').addEventListener('click', () => { clearFiles(); controller.close(); });
  dialog.addEventListener('close', clearFiles);
  trigger.addEventListener('click', () => { if (syncAddress()) controller.open(trigger); });
  window.addEventListener('pagehide', clearFiles, { once: true });
  return { clear, syncAddress };
}
