export function createCatalogCacheKeyRulePayload(rule) {
  return {
    ok: true,
    rule,
  };
}

export function createCatalogCacheKeysPayload(keys) {
  return {
    ok: true,
    count: keys.length,
    keys,
  };
}

export function createCatalogCacheKeySavedPayload(result) {
  return {
    ok: true,
    cacheKey: result.cacheKey,
    rule: result.rule,
  };
}

export function createCatalogCategoryNodesPayload(nodes) {
  return {
    ok: true,
    count: nodes.length,
    nodes,
  };
}

export function createCatalogCacheStatusPayload(states, rule) {
  return {
    ok: true,
    count: states.length,
    states,
    rule,
  };
}

export function createCatalogCacheValidationErrorPayload(message) {
  return {
    ok: false,
    error: {
      code: 'CATALOG_CACHE_VALIDATION_ERROR',
      message,
    },
  };
}
