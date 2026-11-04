import { createHash, randomBytes } from 'node:crypto';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => encodeURIComponent(value);
const safeScript = value => /^this-way-ftw-op-[a-f0-9]{32}$/.test(value);
const controlBucket = 'this-way-operator-private';

export class OperatorTransportError extends Error {
  constructor(code) { super(code); this.name = 'OperatorTransportError'; this.code = code; }
}

export class FtwOperatorCloudflare {
  constructor({ accountId, token, fetcher = fetch, onClaimed = async () => {} }) {
    if (!/^[a-f0-9]{32}$/.test(accountId || '') || typeof token !== 'string' || !token) throw new OperatorTransportError('cloudflare_credentials_missing');
    this.accountId = accountId;
    this.token = token;
    this.fetcher = fetcher;
    this.onClaimed = onClaimed;
    this.claimedScripts = new Set();
    this.ownershipMarkers = new Map();
  }

  async request(path, init = {}, allowed = [200]) {
    const response = await this.fetcher(`https://api.cloudflare.com/client/v4/accounts/${this.accountId}${path}`, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(45_000),
      headers: { ...init.headers, authorization: `Bearer ${this.token}` }
    });
    if (!allowed.includes(response.status)) {
      await response.body?.cancel();
      throw new OperatorTransportError(`cloudflare_http_${response.status}`);
    }
    return response;
  }

  async json(path, init = {}, allowed) {
    const headers = init.body instanceof FormData ? { ...init.headers } : { 'content-type': 'application/json', ...init.headers };
    const response = await this.request(path, { ...init, headers }, allowed);
    const body = await response.json();
    if (body.success !== true) throw new OperatorTransportError('cloudflare_operation_failed');
    return body.result;
  }

  async target() {
    const matches = [];
    for (let page = 1; page <= 20; page++) {
      const rows = await this.json(`/d1/database?name=this-way-listings&per_page=100&page=${page}`);
      if (!Array.isArray(rows)) throw new OperatorTransportError('destination_database_lookup_invalid');
      matches.push(...rows.filter(row => row.name === 'this-way-listings'));
      if (rows.length < 100) break;
      if (page === 20) throw new OperatorTransportError('destination_database_lookup_incomplete');
    }
    if (matches.length !== 1) throw new OperatorTransportError('destination_database_ambiguous');
    const id = matches[0].uuid || matches[0].id;
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id || '')) throw new OperatorTransportError('destination_database_id_invalid');
    const database = await this.json(`/d1/database/${id}`);
    const bucket = await this.json('/r2/buckets/this-way-photos');
    const subdomain = await this.json('/workers/subdomain');
    if (database?.name !== 'this-way-listings' || (database.uuid || database.id) !== id
      || bucket?.name !== 'this-way-photos' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(subdomain?.subdomain || '')) {
      throw new OperatorTransportError('destination_identity_mismatch');
    }
    const existing = await this.request(`/r2/buckets/${controlBucket}`, {}, [200, 404]);
    const missing = existing.status === 404;
    if (missing) await existing.body?.cancel();
    else {
      const result = await existing.json();
      if (result.success !== true || result.result?.name !== controlBucket) throw new OperatorTransportError('control_bucket_identity_mismatch');
    }
    if (missing) {
      const created = await this.json('/r2/buckets', { method: 'POST', body: JSON.stringify({ name: controlBucket }) });
      if (created?.name !== controlBucket) throw new OperatorTransportError('control_bucket_identity_mismatch');
    }
    await this.assertPrivateControlBucket();
    return { accountId: this.accountId, databaseId: database.uuid || database.id, databaseName: database.name,
      bucketName: bucket.name, controlBucketName: controlBucket, subdomain: subdomain.subdomain };
  }

  async assertPrivateControlBucket() {
    const managed = await this.json(`/r2/buckets/${controlBucket}/domains/managed`);
    const custom = await this.json(`/r2/buckets/${controlBucket}/domains/custom`);
    if (managed?.enabled !== false || !Array.isArray(custom?.domains) || custom.domains.some(domain => domain.enabled !== false)) {
      throw new OperatorTransportError('control_storage_not_private');
    }
  }

  async privateObject(key, bytes) {
    if (!/^ftw-operator\/[a-f0-9]{32}\/(command|receipt|exchange)\.json$/.test(key)) throw new OperatorTransportError('invalid_private_object_key');
    await this.assertPrivateControlBucket();
    const path = `/r2/buckets/${controlBucket}/objects/${key.split('/').map(encode).join('/')}`;
    const response = await this.request(path, { method: 'PUT', headers: {
      'content-type': 'application/json', 'cache-control': 'private, no-store', 'if-none-match': '*'
    }, body: bytes }, [200, 201]);
    await response.body?.cancel();
    const stored = await this.request(path);
    const actual = new Uint8Array(await stored.arrayBuffer());
    if (sha(actual) !== sha(bytes)) throw new OperatorTransportError('private_object_verification_failed');
  }

  async readPrivateExchange(exchangeId) {
    if (!/^[a-f0-9]{32}$/.test(exchangeId || '')) throw new OperatorTransportError('invalid_exchange_id');
    await this.assertPrivateControlBucket();
    const path = `/r2/buckets/${controlBucket}/objects/ftw-operator/${exchangeId}/exchange.json`;
    const response = await this.request(path, {}, [200, 404]);
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.body || Number(response.headers.get('content-length') || 0) > 16 * 1024) {
      await response.body?.cancel();
      throw new OperatorTransportError('private_exchange_invalid');
    }
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16 * 1024) { await reader.cancel(); throw new OperatorTransportError('private_exchange_invalid'); }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new OperatorTransportError('private_exchange_invalid'); }
  }

  async deletePrivateExchange(exchangeId) {
    if (!/^[a-f0-9]{32}$/.test(exchangeId || '')) throw new OperatorTransportError('invalid_exchange_id');
    await this.assertPrivateControlBucket();
    const path = `/r2/buckets/${controlBucket}/objects/ftw-operator/${exchangeId}/exchange.json`;
    const removed = await this.request(path, { method: 'DELETE' }, [200, 204, 404]);
    await removed.body?.cancel();
    const check = await this.request(path, {}, [200, 404]);
    const verified = check.status === 404;
    await check.body?.cancel();
    if (!verified) throw new OperatorTransportError('exchange_revocation_unverified');
    return { verified: true };
  }

  async deploy({ scriptName, source, target, command, commandKey, commandBytes }) {
    if (!safeScript(scriptName)) throw new OperatorTransportError('invalid_temporary_worker_name');
    if (target?.accountId !== this.accountId || target.bucketName !== 'this-way-photos' || target.controlBucketName !== controlBucket
      || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(target.databaseId || '')) throw new OperatorTransportError('destination_identity_mismatch');
    const scriptPath = `/workers/scripts/${scriptName}`;
    const before = await this.request(scriptPath, {}, [200, 404]);
    const exists = before.status === 200;
    await before.body?.cancel();
    if (exists) throw new OperatorTransportError('temporary_worker_already_exists');
    await this.privateObject(commandKey, commandBytes);
    const token = randomBytes(32).toString('base64url');
    const ownershipMarker = randomBytes(32).toString('hex');
    const metadata = {
      main_module: 'operator.mjs', compatibility_date: '2026-10-30', compatibility_flags: ['nodejs_compat'],
      logpush: false, observability: { enabled: false },
      bindings: [
        { type: 'd1', name: 'DB', id: target.databaseId },
        { type: 'r2_bucket', name: 'PHOTOS', bucket_name: target.bucketName },
        { type: 'r2_bucket', name: 'CONTROL', bucket_name: target.controlBucketName },
        ...Object.entries({ OPERATOR_OWNER_MARKER: ownershipMarker, COMMAND_KEY: commandKey, COMMAND_SHA256: sha(commandBytes), RUN_ID: command.runId,
          EXPIRES_AT: String(command.expiresAt), ACCOUNT_ID: target.accountId, EXPECTED_ACCOUNT_ID: this.accountId })
          .map(([name, text]) => ({ type: 'plain_text', name, text }))
      ]
    };
    const form = new FormData();
    form.set('metadata', JSON.stringify(metadata));
    form.set('operator.mjs', new File([source], 'operator.mjs', { type: 'application/javascript+module' }));
    // Preserve a candidate marker before an upload whose response might be lost.
    // Cleanup verifies that exact marker through the account API before deleting.
    this.claimedScripts.add(scriptName);
    this.ownershipMarkers.set(scriptName, ownershipMarker);
    await this.onClaimed(scriptName, ownershipMarker);
    await this.json(scriptPath, { method: 'PUT', headers: {}, body: form });
    await this.json(`${scriptPath}/subdomain`, { method: 'POST', body: JSON.stringify({ enabled: false, previews_enabled: false }) });
    await this.json(`${scriptPath}/secrets`, { method: 'PUT', body: JSON.stringify({ name: 'OPERATOR_TOKEN', type: 'secret_text', text: token }) });
    await this.json(`${scriptPath}/subdomain`, { method: 'POST', body: JSON.stringify({ enabled: true, previews_enabled: false }) });
    return { url: `https://${scriptName}.${target.subdomain}.workers.dev/execute`, token };
  }

  async cleanup(scriptName) {
    if (!safeScript(scriptName) || !this.claimedScripts.has(scriptName)) return { verified: false };
    const path = `/workers/scripts/${scriptName}`;
    try {
      const settingsResponse = await this.request(`${path}/settings`, {}, [200, 404]);
      if (settingsResponse.status === 404) { await settingsResponse.body?.cancel(); return { verified: true }; }
      const settings = await settingsResponse.json();
      const marker = settings.result?.bindings?.find(binding => binding.type === 'plain_text' && binding.name === 'OPERATOR_OWNER_MARKER')?.text;
      if (settings.success !== true || !this.ownershipMarkers.get(scriptName) || marker !== this.ownershipMarkers.get(scriptName)) return { verified: false, ownershipMismatch: true };
      const disabled = await this.request(`${path}/subdomain`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false, previews_enabled: false }) }, [200, 404]);
      await disabled.body?.cancel();
      const removed = await this.request(path, { method: 'DELETE' }, [200, 404]);
      await removed.body?.cancel();
      const check = await this.request(path, {}, [200, 404]);
      const verified = check.status === 404;
      await check.body?.cancel();
      return { verified };
    } catch { return { verified: false }; }
  }
}

export async function executeOperatorRpc({ endpoint, body, fetcher = fetch, expiresAt, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const url = new URL(endpoint.url);
  if (url.protocol !== 'https:' || !/^this-way-ftw-op-[a-f0-9]{32}\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname)
    || url.pathname !== '/execute' || url.search || url.hash || url.username || url.password) throw new OperatorTransportError('invalid_operator_endpoint');
  for (let attempt = 0; attempt < 8; attempt++) {
    if (Date.now() >= expiresAt) throw new OperatorTransportError('operator_expired');
    try {
      const response = await fetcher(endpoint.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90_000),
        headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' }, body });
      if (response.status === 404 || response.status === 503) {
        await response.body?.cancel();
        if (attempt < 7) { await wait(3000); continue; }
        throw new OperatorTransportError('operator_not_ready');
      }
      // RPC errors can contain private source/SQL details. Return them only to the
      // runner's private receipt; never use them as public CLI error messages.
      const data = await response.json();
      return { status: response.status, data };
    } catch (error) {
      if (error instanceof OperatorTransportError) throw error;
      if (attempt === 7) throw new OperatorTransportError('operator_outcome_unknown');
      await wait(3000);
    }
  }
  throw new OperatorTransportError('operator_outcome_unknown');
}
