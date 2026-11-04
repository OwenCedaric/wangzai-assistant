import { requestCollectionPricingDraft } from '../../../services/collectionPricingDraftClient.js';

const COLLECTION_PRICING_DRAFT_SCHEMA_VERSION = 2;
export const COLLECTION_PRICING_DRAFT_LIMIT = 500;
const COLLECTION_PRICING_DRAFT_LOCK = 'wangzai:collection-pricing-draft-write';

function normalizeScopeKey(scopeKey = '') {
  const value = String(scopeKey || '').trim();
  return value || 'local-default';
}

export async function loadCollectionPricingDraft(scopeKey = '') {
  const normalizedScopeKey = normalizeScopeKey(scopeKey);
  const data = await requestCollectionPricingDraft('GET', undefined, { scopeKey: normalizedScopeKey });
  if (data.schemaVersion !== COLLECTION_PRICING_DRAFT_SCHEMA_VERSION || !Array.isArray(data.items)) return [];
  return data.items.filter((item) => item && typeof item === 'object' && !Array.isArray(item)).slice(0, COLLECTION_PRICING_DRAFT_LIMIT);
}

export async function saveCollectionPricingDraft(items = [], scopeKey = '') {
  const normalizedScopeKey = normalizeScopeKey(scopeKey);
  const payload = {
    schemaVersion: COLLECTION_PRICING_DRAFT_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    items: (Array.isArray(items) ? items : []).slice(0, COLLECTION_PRICING_DRAFT_LIMIT),
  };
  const writeDraft = () => requestCollectionPricingDraft('PUT', payload, { scopeKey: normalizedScopeKey });
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request(`${COLLECTION_PRICING_DRAFT_LOCK}:${normalizedScopeKey}`, writeDraft);
  }
  return writeDraft();
}
