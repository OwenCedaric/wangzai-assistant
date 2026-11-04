function normalizeText(value) {
  return String(value ?? '').trim();
}

function normalizeCredentialRevision(value) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : 0;
}

function uniqueTexts(values = []) {
  return [...new Set(values.map(normalizeText).filter(Boolean))];
}

/**
 * Canonical renderer scope for one Ozon binding generation.  `shopId` is a
 * reusable local account slot, while incarnation + credential revision name
 * the concrete binding whose late callbacks may still be running.
 */
export function normalizeOzonShopGenerationScope(value = {}) {
  const source = Array.isArray(value)
    ? { identifiers: value }
    : value && typeof value === 'object'
      ? value
      : { ownerId: value };
  const suppliedIdentifiers = Array.isArray(source.identifiers) ? source.identifiers : [];
  const ownerId = normalizeText(source.ownerId || source.shopId || source.shop_id || source.id || suppliedIdentifiers[0]);
  const clientId = normalizeText(source.clientId || source.client_id || source.shopClientId || suppliedIdentifiers[1]);
  const shopIncarnation = normalizeText(
    source.shopIncarnation || source.shop_incarnation || source.formerShopIncarnation,
  );
  const credentialRevision = normalizeCredentialRevision(
    source.credentialRevision || source.credential_revision || source.finalCredentialRevision,
  );
  return Object.freeze({
    ownerId,
    clientId,
    shopIncarnation,
    credentialRevision,
    identifiers: Object.freeze(uniqueTexts([ownerId, clientId, ...suppliedIdentifiers])),
  });
}

export function hasCompleteOzonShopGeneration(value = {}) {
  const scope = normalizeOzonShopGenerationScope(value);
  return Boolean(scope.shopIncarnation && scope.credentialRevision > 0);
}

export function getOzonShopGenerationToken(value = {}) {
  const scope = normalizeOzonShopGenerationScope(value);
  if (!scope.shopIncarnation || scope.credentialRevision <= 0) return '';
  return `incarnation:${encodeURIComponent(scope.shopIncarnation)}:revision:${scope.credentialRevision}`;
}

export function getOzonUngeneratedShopSourceKey(shop = {}) {
  const scope = normalizeOzonShopGenerationScope(shop);
  const label = normalizeText(shop?.shopAlias || shop?.sellerName) || 'Ozon 店铺';
  if (scope.ownerId) return `ozon-shop:id:${scope.ownerId}`;
  if (scope.clientId) return `ozon-shop:client:${scope.clientId}`;
  return `ozon-shop:label:${label}`;
}

export function getOzonGenerationAwareShopSourceKey(shop = {}) {
  const base = getOzonUngeneratedShopSourceKey(shop);
  const generation = getOzonShopGenerationToken(shop);
  return generation ? `${base}:${generation}` : base;
}

/** Read-only migration key emitted by builds that preferred Client-Id over the canonical local owner id. */
export function getOzonLegacyClientGenerationAwareShopSourceKey(shop = {}) {
  const scope = normalizeOzonShopGenerationScope(shop);
  const base = scope.clientId
    ? `ozon-shop:client:${scope.clientId}`
    : getOzonUngeneratedShopSourceKey(shop);
  const generation = getOzonShopGenerationToken(shop);
  return generation ? `${base}:${generation}` : base;
}

export function serializeOzonShopGenerationScope(value = {}) {
  const scope = normalizeOzonShopGenerationScope(value);
  return encodeURIComponent(JSON.stringify({
    ownerId: scope.ownerId,
    clientId: scope.clientId,
    shopIncarnation: scope.shopIncarnation,
    credentialRevision: scope.credentialRevision,
    identifiers: scope.identifiers,
  }));
}

export function deserializeOzonShopGenerationScope(value = '') {
  try {
    return normalizeOzonShopGenerationScope(JSON.parse(decodeURIComponent(String(value || ''))));
  } catch {
    return normalizeOzonShopGenerationScope({});
  }
}

export function ozonCacheKeyBelongsToOwner(cacheKey, value = {}) {
  const text = String(cacheKey ?? '');
  const scope = normalizeOzonShopGenerationScope(value);
  const containsExactToken = (prefix, identifier) => {
    const needle = `${prefix}${identifier}`;
    let fromIndex = 0;
    while (fromIndex <= text.length) {
      const index = text.indexOf(needle, fromIndex);
      if (index < 0) return false;
      const next = text[index + needle.length] || '';
      if (!next || next === ':' || next === '|') return true;
      fromIndex = index + needle.length;
    }
    return false;
  };
  return scope.identifiers.some((identifier) => (
    containsExactToken('ozon-shop:id:', identifier)
    || containsExactToken('ozon-shop:client:', identifier)
  ));
}

/** Old-generation canonical keys and generation-less legacy keys are blocked. */
export function isOzonCacheKeyBlockedByGenerationFence(cacheKey, fenceValue = {}) {
  const text = String(cacheKey ?? '');
  const fence = normalizeOzonShopGenerationScope(fenceValue);
  if (!ozonCacheKeyBelongsToOwner(text, fence)) return false;
  const fenceToken = getOzonShopGenerationToken(fence);
  if (!fenceToken) return true;
  if (text.includes(`:${fenceToken}`)) return true;
  return !text.includes(':incarnation:');
}

function scopesReferToSameOwner(left, right) {
  if (left.ownerId && right.ownerId && left.ownerId === right.ownerId) return true;
  return left.identifiers.some((identifier) => right.identifiers.includes(identifier));
}

/**
 * A legacy callback without a generation is rejected conservatively.  A
 * complete, different incarnation/revision is a new binding and is allowed.
 */
export function isOzonShopGenerationFenced(candidateValue = {}, fenceValues = []) {
  const candidate = normalizeOzonShopGenerationScope(candidateValue);
  return (Array.isArray(fenceValues) ? fenceValues : [fenceValues]).some((value) => {
    const fence = normalizeOzonShopGenerationScope(value);
    if (!scopesReferToSameOwner(candidate, fence)) return false;
    if (hasCompleteOzonShopGeneration(candidate) && hasCompleteOzonShopGeneration(fence)) {
      return candidate.shopIncarnation === fence.shopIncarnation
        && candidate.credentialRevision === fence.credentialRevision;
    }
    return true;
  });
}
