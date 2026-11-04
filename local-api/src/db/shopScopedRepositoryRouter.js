import { normalizeShopQueryScope, resolveShopQueryIds } from './shopQueryScope.js';

function normalizeText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function resolveShopId(input = {}) {
  return normalizeText(input?.shopId ?? input?.shop_id);
}

export function createShopScopedRepositoryRouter({
  canonicalRepository,
  createRepository,
  storage,
  aggregateRepository = null,
  writeMethods = [],
  readMethods = [],
} = {}) {
  if (!canonicalRepository || typeof createRepository !== 'function') throw new Error('SHOP_SCOPED_REPOSITORY_REQUIRED');
  if (!storage?.resolveDirectWriteSession) throw new Error('SHOP_SCOPED_STORAGE_REQUIRED');
  const repositories = new WeakMap();
  const counters = { directWrites: 0, canonicalWrites: 0, directReads: 0, canonicalReads: 0, failures: 0 };
  const repositoryFor = (session) => {
    let repository = repositories.get(session.db);
    if (!repository) {
      repository = createRepository(session.db);
      repositories.set(session.db, repository);
    }
    return repository;
  };
  const routed = { ...canonicalRepository };
  for (const method of readMethods) {
    routed[method] = (input = {}) => {
      const selected = resolveShopQueryIds(input);
      const query = normalizeShopQueryScope(input);
      const shopId = selected.length === 1 ? selected[0] : '';
      if (!shopId && aggregateRepository) {
        return aggregateRepository[method](query);
      }
      if (!shopId && storage.snapshot?.().directWriteAllShops === true) {
        const error = new Error('SHOP_SCOPED_AGGREGATE_READ_REQUIRED');
        error.code = 'SHOP_SCOPED_AGGREGATE_READ_REQUIRED';
        throw error;
      }
      if (!storage.isDirectWriteShop(shopId)) {
        counters.canonicalReads += 1;
        return canonicalRepository[method](query);
      }
      const session = storage.resolveDirectWriteSession({ shopId });
      counters.directReads += 1;
      return repositoryFor(session)[method](query);
    };
  }
  for (const method of writeMethods) {
    routed[method] = (input = {}) => {
      const shopId = resolveShopId(input);
      if (!shopId && storage.snapshot?.().directWriteAllShops === true) {
        const error = new Error('SHOP_SCOPED_DIRECT_WRITE_SHOP_ID_REQUIRED');
        error.code = 'SHOP_SCOPED_DIRECT_WRITE_SHOP_ID_REQUIRED';
        throw error;
      }
      if (!storage.isDirectWriteShop(shopId)) {
        counters.canonicalWrites += 1;
        return canonicalRepository[method](input);
      }
      try {
        const session = storage.resolveDirectWriteSession({ shopId });
        const result = repositoryFor(session)[method](input);
        storage.recordDirectWrite({ shopId, expectedScopeToken: session.route?.scopeToken });
        counters.directWrites += 1;
        return result;
      } catch (error) {
        counters.failures += 1;
        throw error;
      }
    };
  }
  routed.snapshotDirectWrites = () => Object.freeze({ ...counters });
  return Object.freeze(routed);
}
