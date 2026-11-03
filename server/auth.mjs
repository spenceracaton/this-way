const encoder = new TextEncoder();
export const cookieName = 'this_way_owner';
export const now = () => Date.now();
export const token = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
export async function hash(value) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
export function problem(status, code, message) { return Object.assign(new Error(message), { status, code }); }
const decode = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
export async function passwordMatches(password, verifier) {
  if (typeof password !== 'string' || password.length > 256 || typeof verifier !== 'string') return false;
  const [algorithm, rounds, salt, expected] = verifier.split('$');
  if (algorithm !== 'pbkdf2-sha256' || Number(rounds) !== 100000 || !salt || !expected) return false;
  try {
    const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    const result = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: decode(salt), iterations: 100000 }, key, 256));
    const wanted = decode(expected);
    let different = result.length ^ wanted.length;
    for (let i = 0; i < result.length; i++) different |= result[i] ^ (wanted[i] ?? 0);
    return different === 0;
  } catch { return false; }
}
export function sessionCookie(request, env, value, age = 8 * 3600) {
  const url = new URL(request.url);
  const local = env.LOCAL_DEVELOPMENT === '1' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${local ? '' : '; Secure'}`;
}
export function requestSession(request) {
  return request.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1) || '';
}
export async function ownerSession(request, env) {
  const value = requestSession(request);
  if (!/^[a-f0-9]{64}$/.test(value)) return null;
  return env.DB.prepare('SELECT token_hash FROM sessions WHERE token_hash = ? AND expires_at > ?').bind(await hash(value), now()).first();
}
export async function requireOwner(request, env) {
  if (!await ownerSession(request, env)) throw problem(401, 'sign_in_required', 'Sign in to review photos and manage displays.');
}
export function requireOrigin(request) {
  if (request.headers.get('origin') !== new URL(request.url).origin) throw problem(403, 'origin_required', 'Open This Way and try again.');
}
export async function rateLimit(request, env, scope, maximum, window = 3600000, identity) {
  const stamp = now();
  const source = identity || request.headers.get('cf-connecting-ip') || 'local';
  const key = await hash(`${env.SERVICE_SECRET}:${scope}:${source}`);
  const results = await env.DB.batch([
    env.DB.prepare('DELETE FROM request_limits WHERE window_start < ?').bind(stamp - 86400000),
    env.DB.prepare('INSERT INTO request_limits(key,window_start,attempts) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_start < ? THEN 1 ELSE attempts+1 END, window_start=CASE WHEN window_start < ? THEN excluded.window_start ELSE window_start END RETURNING attempts').bind(key, stamp, stamp - window, stamp - window)
  ]);
  if (results[1].results[0].attempts > maximum) throw problem(429, 'request_limit', 'Too many requests. Please try again later.');
}
export async function readBytes(request, limit) {
  if (Number(request.headers.get('content-length')) > limit) throw problem(413, 'too_large', 'This upload is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw problem(400, 'body_required', 'A request body is required.');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw problem(413, 'too_large', 'This upload is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
export async function readJson(request) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') throw problem(415, 'json_required', 'Send the form as JSON.');
  try {
    const value = JSON.parse(new TextDecoder().decode(await readBytes(request, 16384)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch (error) {
    if (error.status) throw error;
    throw problem(400, 'invalid_json', 'The submitted form could not be read.');
  }
}
