import { getSeerfarCategoryTree } from '../../../api/localApiClient.js';

const categoryOptionCache = new Map();
const MAX_CACHE_ENTRIES = 120;

function cacheKey(options = {}) {
  return [
    String(options.query || '').trim().toLocaleLowerCase(),
    String(options.parentId || '0').trim(),
    Number(options.limit) || 80,
  ].join('|');
}

export function loadSmartToolSeerfarCategoryOptions(options = {}) {
  const key = cacheKey(options);
  if (!options.forceRefresh && categoryOptionCache.has(key)) {
    return categoryOptionCache.get(key);
  }
  const request = getSeerfarCategoryTree({
    query: String(options.query || '').trim(),
    parentId: String(options.parentId || '0').trim(),
    limit: Math.min(120, Math.max(1, Number(options.limit) || 80)),
    timeoutMs: options.timeoutMs || 30000,
    signal: options.signal,
    forceRefresh: options.forceRefresh === true,
  }).catch((error) => {
    categoryOptionCache.delete(key);
    throw error;
  });
  categoryOptionCache.set(key, request);
  if (categoryOptionCache.size > MAX_CACHE_ENTRIES) {
    categoryOptionCache.delete(categoryOptionCache.keys().next().value);
  }
  return request;
}
