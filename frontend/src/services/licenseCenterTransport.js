/**
 * Thin renderer transport for the browser-only licensing fallback.
 * Desktop builds normally route this traffic through the preload license bridge.
 */
export async function requestLicenseCenterJson(
  url,
  { method = 'GET', headers = {}, body, fetchImpl = globalThis.fetch } = {}
) {
  if (typeof fetchImpl !== 'function') return { response: null, payload: {} };
  const response = await fetchImpl(url, {
    method,
    headers,
    body,
  }).catch(() => null);
  if (!response) return { response: null, payload: {} };
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}
