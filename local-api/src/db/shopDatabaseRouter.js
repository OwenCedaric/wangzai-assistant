const AGGREGATE_SHOP_IDS = new Set(['*', 'all', '__all__', 'all-shops', 'all_shops']);

export class ShopDatabaseRouteError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ShopDatabaseRouteError';
    this.code = code;
  }
}

function fail(code) {
  throw new ShopDatabaseRouteError(code);
}

function normalizeShopId(value) {
  if (typeof value !== 'string') fail('SHOP_DATABASE_ROUTE_SHOP_ID_INVALID');
  const shopId = value.trim();
  if (!shopId || shopId.length > 500 || /[\u0000-\u001f\u007f]/u.test(shopId)) {
    fail('SHOP_DATABASE_ROUTE_SHOP_ID_INVALID');
  }
  if (
    AGGREGATE_SHOP_IDS.has(shopId.toLocaleLowerCase('en-US'))
    || shopId.includes(',')
    || shopId.includes('，')
  ) {
    fail('SHOP_DATABASE_ROUTE_AGGREGATE_FORBIDDEN');
  }
  return shopId;
}

function assertRouteMatchesHandle(route, handle) {
  if (
    !handle?.db
    || handle.layout?.profileId !== route.profileId
    || handle.layout?.shopId !== route.shopId
    || handle.layout?.shopIncarnation !== route.shopIncarnation
    || handle.layout?.scopeDigest !== route.scopeDigest
    || handle.metadata?.profileId !== route.profileId
    || handle.metadata?.shopId !== route.shopId
    || handle.metadata?.shopIncarnation !== route.shopIncarnation
    || handle.metadata?.scopeDigest !== route.scopeDigest
  ) {
    fail('SHOP_DATABASE_ROUTE_READBACK_MISMATCH');
  }
}

/**
 * Resolves every future shop-owned repository through the canonical shop
 * identity. Callers provide only an internal shop id; they cannot choose a
 * profile, incarnation, filesystem path, or aggregate database themselves.
 */
export function createShopDatabaseRouter({ shopRepository, shopDatabaseManager } = {}) {
  if (
    !shopRepository?.identityRepository?.createScopeToken
    || !shopRepository?.identityRepository?.assertCurrentScopeToken
    || !shopRepository?.getPublicShopById
  ) {
    throw new Error('SHOP_DATABASE_ROUTE_REPOSITORY_REQUIRED');
  }
  if (
    !shopDatabaseManager?.resolve
    || !shopDatabaseManager?.ensure
    || !shopDatabaseManager?.openExisting
    || !shopDatabaseManager?.has
  ) {
    throw new Error('SHOP_DATABASE_ROUTE_MANAGER_REQUIRED');
  }

  const identityRepository = shopRepository.identityRepository;
  const profileId = String(shopRepository.profileId || '').trim();
  if (!profileId || identityRepository.profileId !== profileId) {
    throw new Error('SHOP_DATABASE_ROUTE_PROFILE_MISMATCH');
  }

  const counters = {
    resolved: 0,
    opened: 0,
    created: 0,
    failures: 0,
    lastErrorCode: '',
  };

  function recordFailure(error) {
    counters.failures += 1;
    counters.lastErrorCode = String(error?.code || error?.message || 'SHOP_DATABASE_ROUTE_FAILED');
  }

  function resolveRoute(shopIdInput, options = {}) {
    try {
      const shopId = normalizeShopId(shopIdInput);
      const expectedScopeToken = options.expectedScopeToken || null;
      if (
        expectedScopeToken
        && (
          expectedScopeToken.profileId !== profileId
          || expectedScopeToken.shopId !== shopId
        )
      ) {
        fail('SHOP_DATABASE_ROUTE_EXPECTED_SCOPE_MISMATCH');
      }
      const scopeToken = expectedScopeToken
        ? Object.freeze({ ...expectedScopeToken })
        : identityRepository.createScopeToken(shopId, profileId);
      const identity = identityRepository.assertCurrentScopeToken(scopeToken);
      const shop = shopRepository.getPublicShopById(shopId);
      if (
        !shop
        || identity.profileId !== profileId
        || identity.shopId !== shopId
        || scopeToken.profileId !== profileId
        || scopeToken.shopId !== shopId
      ) {
        fail('SHOP_DATABASE_ROUTE_IDENTITY_MISMATCH');
      }
      const layout = shopDatabaseManager.resolve(scopeToken);
      if (
        layout.profileId !== profileId
        || layout.shopId !== shopId
        || layout.shopIncarnation !== scopeToken.shopIncarnation
      ) {
        fail('SHOP_DATABASE_ROUTE_LAYOUT_MISMATCH');
      }
      counters.resolved += 1;
      return Object.freeze({
        profileId,
        shopId,
        shopIncarnation: scopeToken.shopIncarnation,
        credentialRevision: scopeToken.credentialRevision,
        scopeDigest: layout.scopeDigest,
        databasePath: layout.databasePath,
        shopDirectory: layout.shopDirectory,
        scopeDirectory: layout.scopeDirectory,
        scopeToken: Object.freeze({ ...scopeToken }),
        displayIdentity: Object.freeze({
          displayName: String(shop.name || '').trim(),
          alias: String(shop.alias || '').trim(),
        }),
      });
    } catch (error) {
      recordFailure(error);
      throw error;
    }
  }

  function open(shopId, options = {}) {
    const route = resolveRoute(shopId, options);
    try {
      const createIfMissing = options.createIfMissing !== false;
      const existedBeforeOpen = shopDatabaseManager.has(route.scopeToken);
      const handle = createIfMissing
        ? shopDatabaseManager.ensure(route.scopeToken, route.displayIdentity)
        : shopDatabaseManager.openExisting(route.scopeToken, route.displayIdentity);
      assertRouteMatchesHandle(route, handle);
      const created = !existedBeforeOpen && Boolean(handle.created);
      counters.opened += 1;
      if (created) counters.created += 1;
      return Object.freeze({
        route,
        db: handle.db,
        created,
        migrated: Boolean(handle.migrated),
      });
    } catch (error) {
      recordFailure(error);
      throw error;
    }
  }

  function has(shopId, options = {}) {
    const route = resolveRoute(shopId, options);
    try {
      return shopDatabaseManager.has(route.scopeToken);
    } catch (error) {
      recordFailure(error);
      throw error;
    }
  }

  function withShopDatabase(shopId, callback, options = {}) {
    if (typeof callback !== 'function') {
      const error = new ShopDatabaseRouteError('SHOP_DATABASE_ROUTE_CALLBACK_REQUIRED');
      recordFailure(error);
      throw error;
    }
    return callback(open(shopId, options));
  }

  function snapshot() {
    return Object.freeze({
      mode: 'canonical-shop-id-to-independent-database',
      profileId,
      ...counters,
    });
  }

  return Object.freeze({
    profileId,
    resolve: resolveRoute,
    open,
    has,
    withShopDatabase,
    snapshot,
  });
}
