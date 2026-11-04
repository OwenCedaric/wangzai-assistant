import { createProductRepository } from './repositories/productRepository.js';
import { createProductFederatedQuery } from './productFederatedQuery.js';

const DIRECT_WRITE_METHODS = Object.freeze([
  'importLegacyProductMaterialProfiles', 'importLegacyProductSourceLinks',
  'markProductHydrationFacetChecked', 'mergeProductAttributeRows', 'mergeProductInfoRows',
  'mergeProductPictureRows', 'mergeProductPriceRows', 'mergeProductStockRows',
  'mergeProductWarehouseStockRows', 'reconcileVisibilitySnapshot',
  'recordProductHydrationFacetObservations', 'recordProductWarehouseStockObservations',
  'upsertProductImageHealth', 'upsertProductMaterialProfile', 'upsertProductSourceLinks', 'upsertProducts',
]);
const READ_METHODS = Object.freeze([
  'getProductHydrationCoverage', 'listProducts', 'listWarehousePickerProducts', 'getProductsByIds',
  'resolveOfferIdsForProducts', 'resolveProductModelNamesForOffers', 'listSkuFamily',
  'listProductMaterialProfiles', 'listProductMaterialProfilesPage', 'listProductSourceLinks',
  'listProductSourceLinksPage',
]);
const AGGREGATES = new Set(['all', '*', '__all__', 'all-shops', 'all_shops']);
const normalizeText = (value) => value == null ? '' : String(value).trim();
const resolveShopId = (input = {}) => normalizeText(input?.shopId ?? input?.shop_id);
const parseIds = (value) => [...new Set((Array.isArray(value) ? value : normalizeText(value).split(','))
  .map(normalizeText).filter(Boolean))];
function fail(code) { const error = new Error(code); error.code = code; throw error; }

export function createShopProductRepositoryRouter({
  canonicalRepository, canonicalDb, shopProductStorage, listShopIds = () => [], onWritten = () => {},
} = {}) {
  if (!canonicalRepository) throw new Error('SHOP_PRODUCT_REPOSITORY_CANONICAL_REQUIRED');
  if (!shopProductStorage?.resolveDirectWriteSession) throw new Error('SHOP_PRODUCT_REPOSITORY_STORAGE_REQUIRED');
  const repositories = new WeakMap();
  const federation = createProductFederatedQuery();
  const counters = { directWrites: 0, canonicalWrites: 0, failures: 0, lastShopId: '', lastMethod: '', lastErrorCode: '' };
  let transactionSequence = 0;

  function repositoryForSession(session) {
    let repository = repositories.get(session.db);
    if (!repository) {
      repository = createProductRepository(session.db, { allowCompatibilityRepairs: false });
      repositories.set(session.db, repository);
    }
    return repository;
  }
  function invokeWrite(method, args) {
    const legacyBatch = method.startsWith('importLegacy');
    const input = args[0];
    const inputIds = legacyBatch && Array.isArray(input) ? [...new Set(input.map(resolveShopId))] : [resolveShopId(input)];
    // Never silently route an array import or an aggregate write to the shared database.
    if (inputIds.length !== 1 || !inputIds[0] || AGGREGATES.has(inputIds[0].toLowerCase())) {
      if (shopProductStorage.snapshot?.().directWriteAllShops || inputIds.some((id) => shopProductStorage.isDirectWriteShop(id))) {
        return fail('SHOP_PRODUCT_DIRECT_WRITE_EXACT_SHOP_REQUIRED');
      }
      return canonicalRepository[method](...args);
    }
    const shopId = inputIds[0];
    counters.lastShopId = shopId;
    counters.lastMethod = method;
    if (!shopProductStorage.isDirectWriteShop(shopId)) {
      counters.canonicalWrites += 1;
      return canonicalRepository[method](...args);
    }
    const session = shopProductStorage.resolveDirectWriteSession({ shopId });
    const repository = repositoryForSession(session);
    const savepoint = 'product_write_' + (++transactionSequence);
    session.db.exec('SAVEPOINT ' + savepoint);
    try {
      const result = repository[method](...args);
      shopProductStorage.recordDirectWrite({ shopId, expectedScopeToken: session.route?.scopeToken });
      session.db.exec('RELEASE SAVEPOINT ' + savepoint);
      counters.directWrites += 1;
      counters.lastErrorCode = '';
      try { onWritten(shopId); } catch { /* cache observers cannot undo a committed write */ }
      return result;
    } catch (error) {
      session.db.exec('ROLLBACK TO SAVEPOINT ' + savepoint);
      session.db.exec('RELEASE SAVEPOINT ' + savepoint);
      counters.failures += 1;
      counters.lastErrorCode = normalizeText(error?.code || error?.message);
      throw error;
    }
  }
  function targetShopIds(query = {}) {
    const direct = resolveShopId(query);
    const requested = parseIds(query.shopIds ?? query.shop_ids).filter((id) => !AGGREGATES.has(id.toLowerCase()));
    if (direct && !AGGREGATES.has(direct.toLowerCase())) {
      if (requested.length && (requested.length !== 1 || requested[0] !== direct)) fail('SHOP_PRODUCT_QUERY_SCOPE_CONFLICT');
      return [direct];
    }
    return requested.length ? requested : parseIds(listShopIds());
  }
  function readSession(shopId) {
    if (shopProductStorage.isDirectWriteShop(shopId)) {
      return shopProductStorage.resolveDirectWriteSession({ shopId });
    }
    const verified = shopProductStorage.resolveVerifiedReadSession({ shopId });
    return verified.ready ? { db: verified.db, route: verified.route, shopId }
      : { db: canonicalDb, shopId };
  }
  function invokeRead(method, query = {}) {
    const ids = targetShopIds(query);
    if (!ids.some((id) => shopProductStorage.isDirectWriteShop(id))) {
      if (!ids.length && shopProductStorage.snapshot?.().directWriteAllShops) fail('SHOP_PRODUCT_READ_SCOPE_REQUIRED');
      return canonicalRepository[method](query);
    }
    if (ids.length === 1) {
      return repositoryForSession(readSession(ids[0]))[method]({
        ...query, shopId: ids[0], shop_id: ids[0], shopIds: [], shop_ids: [],
      });
    }
    const result = federation.invoke(method, ids.map(readSession), query);
    if (method === 'listProducts' || method === 'listWarehousePickerProducts') {
      return { ...result, source: 'shop-federated' };
    }
    return result;
  }
  const routed = { ...canonicalRepository };
  for (const method of DIRECT_WRITE_METHODS) routed[method] = (...args) => invokeWrite(method, args);
  for (const method of READ_METHODS) routed[method] = (query = {}) => invokeRead(method, query);
  Object.defineProperty(routed, 'closeProductReadConnections', { value: federation.close });
  Object.defineProperty(routed, 'suspendProductReadConnections', { value: federation.suspend });
  Object.defineProperty(routed, 'resumeProductReadConnections', { value: federation.resume });
  routed.snapshotDirectWrites = () => Object.freeze({ ...counters });
  return Object.freeze(routed);
}
export const shopProductRepositoryRouterInternals = Object.freeze({ DIRECT_WRITE_METHODS, READ_METHODS, resolveShopId });
