import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadFtwSourceBundle } from './ftw-source-bundle.mjs';
import { assertPilotScope, OPERATOR_POLICY } from '../../operator/policy.mjs';
import { OperatorTransportError } from './ftw-operator-cloudflare.mjs';

export const payloadDigest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new OperatorTransportError(code); };

export function parseOperatorPayload(raw, expectedDigest) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 48 * 1024 || !/^[a-f0-9]{64}$/.test(expectedDigest || '') || payloadDigest(raw.trim()) !== expectedDigest) fail('pilot_payload_digest_mismatch');
  let payload;
  try { payload = JSON.parse(raw); } catch { fail('pilot_payload_invalid'); }
  if (payload?.version !== 1 || payload.bundle?.schemaVersion !== 1 || !Array.isArray(payload.bundle.records)
    || payload.bundle.records.length < 5 || payload.bundle.records.length > OPERATOR_POLICY.maxRecords) fail('pilot_payload_scope_invalid');
  return payload;
}

export async function limitedBytes(response, limit) {
  if (!response.ok || Number(response.headers.get('content-length') || 0) > limit) fail('remote_content_unavailable');
  const chunks = [], reader = response.body?.getReader();
  let size = 0;
  if (!reader) fail('remote_content_unavailable');
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); fail('remote_content_too_large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function sourceUrl(value, photoId) {
  let url;
  try { url = new URL(value); } catch { fail('source_photo_url_invalid'); }
  if (url.protocol !== 'https:' || url.hostname !== 'frightthisway.com' || url.port || url.username || url.password
    || url.search || url.hash || url.pathname !== `/api/photos/${photoId}` || !/^[a-zA-Z0-9_-]+$/.test(photoId)) fail('source_photo_url_invalid');
  return url;
}

const array = value => typeof value === 'string' ? JSON.parse(value || '[]') : value ?? [];
const bool = value => value === true || value === 1 || value === '1';

export async function verifyCurrentPublicSource(input, fetcher = fetch) {
  const byId = new Map();
  for (const area of new Set(Object.values(input.locationManifest || {}).map(row => row.neighborhoodId))) {
    if (!OPERATOR_POLICY.neighborhoods.includes(area)) fail('source_neighborhood_invalid');
    const response = await fetcher(`https://frightthisway.com/api/displays?neighborhood=${area}&year=2026`, {
      redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { 'cache-control': 'no-cache' }
    });
    const body = JSON.parse((await limitedBytes(response, 2 * 1024 * 1024)).toString('utf8'));
    if (!Array.isArray(body.displays)) fail('source_public_list_invalid');
    for (const row of body.displays) byId.set(row.id, row);
  }
  for (const record of input.records) {
    const current = byId.get(record.id);
    const location = input.locationManifest?.[`${record.id}:${record.season_year}`] ?? input.locationManifest?.[record.id];
    if (!current || !location || current.address !== record.address
      || current.destination?.lat !== location.latitude || current.destination?.lng !== location.longitude
      || (current.theme ?? '') !== (record.theme ?? record.title ?? '') || Number(current.level) !== Number(record.level)
      || JSON.stringify(array(current.tags)) !== JSON.stringify(array(record.tags))
      || JSON.stringify(array(current.customTags)) !== JSON.stringify(array(record.custom_tags ?? record.customTags))
      || bool(current.featured) !== bool(record.featured)) fail('source_changed_since_pilot_review');
  }
  return { publicListingsRevalidated: input.records.length };
}

export async function materializeOperatorPayload(payload, { directory, fetcher = fetch }) {
  const bundle = structuredClone(payload.bundle);
  const photoByKey = new Map(bundle.records.flatMap(record => (record.photos || []).map(photo => [photo.object_key, photo])));
  await mkdir(resolve(directory, 'assets'), { mode: 0o700 });
  const fetched = [];
  for (const asset of bundle.assetManifest?.assets || []) {
    const photo = photoByKey.get(asset.sourceKey);
    if (!photo || !/^assets\/[a-f0-9]{64}\.(jpg|png|webp)$/.test(asset.path || '')) fail('source_asset_manifest_invalid');
    const response = await fetcher(sourceUrl(asset.downloadUrl, photo.id), { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    const bytes = await limitedBytes(response, 2 * 1024 * 1024);
    if (`sha256:${payloadDigest(bytes)}` !== asset.originalContentHash) fail('source_photo_changed');
    const path = resolve(directory, asset.path);
    try { await writeFile(path, bytes, { mode: 0o600, flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST' || payloadDigest(await readFile(path)) !== payloadDigest(bytes)) throw error;
    }
    fetched.push({ photoId: photo.id, sha256: payloadDigest(bytes), bytes: bytes.byteLength });
    delete asset.downloadUrl;
  }
  const bundlePath = resolve(directory, 'bundle.json');
  await writeFile(bundlePath, JSON.stringify(bundle), { mode: 0o600, flag: 'wx' });
  const loaded = await loadFtwSourceBundle(bundlePath);
  assertPilotScope(loaded.input, { operatorContract: OPERATOR_POLICY.contract });
  const body = JSON.stringify({ assets: loaded.assets.map(asset => ({ objectKey: asset.objectKey, base64: Buffer.from(asset.bytes).toString('base64') })) });
  if (Buffer.byteLength(body) > OPERATOR_POLICY.maxRequestBytes || loaded.assets.reduce((n, asset) => n + asset.bytes.byteLength, 0) > OPERATOR_POLICY.maxAssetBytes) fail('pilot_transfer_exceeds_limit');
  const revalidated = await verifyCurrentPublicSource(loaded.input, fetcher);
  return { ...loaded, body, fetched, revalidated };
}
