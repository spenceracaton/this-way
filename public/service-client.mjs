import { activeSeasonId } from './season-config.mjs';

export class ServiceError extends Error {
  constructor(message, status = 0, code = '') { super(message); this.name = 'ServiceError'; this.status = status; this.code = code; }
}

export async function api(path, options = {}) {
  const method = options.method || 'GET';
  const headers = new Headers(options.headers || {});
  const body = options.body;
  if (body && typeof body === 'object' && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
    headers.set('Content-Type', 'application/json');
    options = { ...options, body: JSON.stringify(body) };
  }
  let response;
  try { response = await fetch(path, { credentials: 'same-origin', ...options, method, headers }); }
  catch { throw new ServiceError('The listing service could not be reached. Please try again.'); }
  if (!response.ok) {
    let body; try { body = await response.json(); } catch {}
    throw new ServiceError(body?.error?.message || `The listing service returned an error (${response.status}).`, response.status, body?.error?.code || '');
  }
  if (response.status === 204) return null;
  if (/json/i.test(response.headers.get('Content-Type') || '')) return response.json();
  return response.blob();
}

export async function loadService() {
  let response;
  try { response = await fetch('/api/config', { credentials: 'same-origin' }); }
  catch { throw new ServiceError('The listing service could not be reached. Please reload and try again.'); }
  if (response.status === 404) return null;
  let config;
  try { config = await response.json(); } catch { throw new ServiceError('The listing service returned an invalid configuration.'); }
  if (!response.ok) throw new ServiceError(config?.error?.message || `The listing service returned an error (${response.status}).`, response.status, config?.error?.code || '');
  if (config?.available === false) return null;
  if (config?.available !== true || !config.season?.id) throw new ServiceError('The listing service returned an invalid configuration.');
  return config;
}

export function toPin(listing, index = 0) {
  return {
    id: listing.id, label: String(index + 1), name: listing.address,
    lat: listing.latitude, lng: listing.longitude, title: listing.title,
    description: listing.description, tags: [...(listing.tags || []), ...(listing.customTags || [])],
    photos: (listing.photos || []).filter(photo => photo.status === undefined || photo.status === 'approved').map(photo => photo.url),
    live: true
  };
}

export function newRequestId() {
  return crypto.randomUUID();
}

export async function preparePhoto(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('The photo could not be prepared.')), 'image/jpeg', 0.85));
    if (blob.size > 2 * 1024 * 1024) throw new Error('This photo is still larger than 2 MB after resizing.');
    return blob;
  } finally { bitmap.close?.(); }
}

export const defaultSeasonId = activeSeasonId;
