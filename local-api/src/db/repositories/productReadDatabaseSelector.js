import { createProductCanonicalQueryRepository } from './productCanonicalQueryRepository.js';
import { createProductHydrationMarkerRepository } from './productHydrationMarkerRepository.js';
import { createProductSupportRepository } from './productSupportRepository.js';

export function createProductReadDatabaseSelector(db, canonicalQuery, options = {}) {
  const localQueries = new WeakMap();
  function queryFor(readDb) {
    if (!readDb || readDb === db) return canonicalQuery;
    if (!localQueries.has(readDb)) {
      const marker = createProductHydrationMarkerRepository(readDb);
      const support = createProductSupportRepository(readDb, marker);
      localQueries.set(readDb, createProductCanonicalQueryRepository(readDb, {
        canonicalFactsAvailable: true,
        attachProductSupport: support.attachProductSupport,
        allowCompatibilityRepairs: false,
      }));
    }
    return localQueries.get(readDb);
  }
  return function routedRead(method, query = {}) {
    if (typeof options.resolveProductReadDatabase !== 'function') return canonicalQuery[method](query);
    let selection = null;
    try {
      selection = options.resolveProductReadDatabase(query) || null;
      return queryFor(selection?.db)[method](query);
    } catch (error) {
      if (!selection?.db || selection.db === db) throw error;
      try {
        options.onProductReadDatabaseError?.(error, {
          phase: 'query', method, shopId: selection.shopId || query.shopId || query.shop_id || '',
        });
      } catch { /* diagnostic observer only */ }
      if (selection.allowCanonicalFallback === false) throw error;
      return canonicalQuery[method](query);
    }
  };
}
