const COLLECTION_PRICING_DRAFT_ROUTE = '/collection-pricing-draft-api';

function collectionPricingDraftUrl(scopeKey = '') {
  const scope = String(scopeKey || '').trim();
  return scope
    ? `${COLLECTION_PRICING_DRAFT_ROUTE}?scope=${encodeURIComponent(scope)}`
    : COLLECTION_PRICING_DRAFT_ROUTE;
}

export async function requestCollectionPricingDraft(method = 'GET', data, options = {}) {
  const response = await fetch(collectionPricingDraftUrl(options.scopeKey), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    const error = new Error('采集列表持久化失败。');
    error.code = String(payload?.code || 'COLLECTION_PRICING_DRAFT_REQUEST_FAILED');
    throw error;
  }
  return payload?.data && typeof payload.data === 'object' ? payload.data : {};
}
