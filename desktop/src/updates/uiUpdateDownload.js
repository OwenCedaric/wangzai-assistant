import { UI_UPDATE_MAX_BYTES, verifyUiBundle } from './signedUiBundle.js';

const MAX_WIRE_BYTES = Math.ceil(UI_UPDATE_MAX_BYTES * 4 / 3) + 2 * 1024 * 1024;
const fail = code => { throw Object.assign(new Error(code), { code }); };

// Caller supplies a short-lived app entitlement token from main process only.
// The signed payload contains no download URLs: redirects and remote-controlled
// credentials forwarding are never part of the update protocol.
export async function downloadUiUpdate({ baseUrl, token, signal, timeoutMs = 30_000,
  trust, fetchImpl = fetch } = {}) {
  let url;
  try { url = new URL(baseUrl); } catch { fail('UI_UPDATE_URL_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || !/^[A-Za-z0-9_-]{1,40}$/u.test(trust?.channel || '')) fail('UI_UPDATE_URL_INVALID');
  if (typeof token !== 'string' || !token || /\s/u.test(token)) fail('UI_UPDATE_AUTH_REQUIRED');
  if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) fail('UI_UPDATE_TIMEOUT_INVALID');
  url.pathname = `${url.pathname.replace(/\/$/u, '')}/${trust.channel}/latest`;
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('UI_UPDATE_DOWNLOAD_TIMEOUT')), timeoutMs);
  try {
    const response = await fetchImpl(url.toString(), { method: 'GET', redirect: 'error',
      signal: controller.signal, headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
    if (response.status === 204) return { available: false };
    if (response.status === 401 || response.status === 403) throw Object.assign(new Error('UI_UPDATE_UNAUTHORIZED'), { code: 'UI_UPDATE_UNAUTHORIZED', status: response.status });
    if (!response.ok) fail('UI_UPDATE_SERVER_FAILED');
    if (!(response.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) fail('UI_UPDATE_CONTENT_TYPE_INVALID');
    const declaredBytes = response.headers.get('content-length');
    if (declaredBytes !== null && (!/^\d+$/u.test(declaredBytes) || Number(declaredBytes) > MAX_WIRE_BYTES)) fail('UI_UPDATE_DOWNLOAD_TOO_LARGE');
    if (!response.body) fail('UI_UPDATE_BODY_MISSING');
    const chunks = []; let total = 0;
    for await (const chunk of response.body) {
      if (controller.signal.aborted) throw controller.signal.reason;
      total += chunk.length;
      if (total > MAX_WIRE_BYTES) { controller.abort(); fail('UI_UPDATE_DOWNLOAD_TOO_LARGE'); }
      chunks.push(Buffer.from(chunk));
    }
    if (controller.signal.aborted) throw controller.signal.reason;
    let bundle;
    try { bundle = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('UI_UPDATE_JSON_INVALID'); }
    const verified = verifyUiBundle(bundle, trust);
    return { available: true, bundle, id: verified.id, sequence: verified.manifest.sequence };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
