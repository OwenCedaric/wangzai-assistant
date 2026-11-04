const SHARED_CATALOG_ROUTE_PREFIXES = Object.freeze([
  '/api/catalog/shared',
  '/api/cache/catalog/shared',
]);
const DEFAULT_SHARED_CATALOG_IDENTITY = Object.freeze({
  platform: 'ozon',
  marketplace: 'ozon',
  locale: 'ZH_HANS',
  contractVersion: 'ozon-description-category-v1',
});

function normalizeText(value) {
  return String(value ?? '').trim();
}

function normalizeLimit(value, fallback = 1000, maximum = 10_000) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.trunc(numeric), 1), maximum);
}

function normalizeIdentity(input = {}) {
  return {
    platform: normalizeText(input.platform) || DEFAULT_SHARED_CATALOG_IDENTITY.platform,
    marketplace: normalizeText(input.marketplace) || DEFAULT_SHARED_CATALOG_IDENTITY.marketplace,
    locale: (normalizeText(input.locale) || DEFAULT_SHARED_CATALOG_IDENTITY.locale).toUpperCase(),
    contractVersion:
      normalizeText(input.contractVersion ?? input.contract_version)
      || DEFAULT_SHARED_CATALOG_IDENTITY.contractVersion,
  };
}

function selectCatalog(service, input = {}) {
  const explicitCatalogId = normalizeText(input.catalogId ?? input.catalog_id);
  const identity = normalizeIdentity(input);
  const catalogs = service.listSharedCatalogs({
    platform: explicitCatalogId ? undefined : identity.platform,
    marketplace: explicitCatalogId ? undefined : identity.marketplace,
    locale: explicitCatalogId ? undefined : identity.locale,
    limit: 1000,
  });
  if (explicitCatalogId) {
    return catalogs.find((item) => item.catalogId === explicitCatalogId) || null;
  }

  const exact = catalogs.find((item) => item.contractVersion === identity.contractVersion);
  if (exact) return exact;

  return [...catalogs].sort((left, right) => {
    const leftRemote = left.sourceKind === 'remote' ? 1 : 0;
    const rightRemote = right.sourceKind === 'remote' ? 1 : 0;
    if (leftRemote !== rightRemote) return rightRemote - leftRemote;
    return String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
  })[0] || null;
}

function categoryToNode(category) {
  return {
    nodeKind: 'category',
    catalogId: category.catalogId,
    categoryId: category.categoryId,
    typeId: '',
    parentCategoryId: category.parentCategoryId || '',
    title: category.name,
    level: category.level,
    isDisabled: Boolean(category.isDisabled),
    contentHash: category.contentHash,
    updatedAt: category.lastSeenAt,
  };
}

function typeToNode(type, categoryById) {
  const parent = categoryById.get(type.categoryId);
  return {
    nodeKind: 'type',
    catalogId: type.catalogId,
    categoryId: type.categoryId,
    typeId: type.typeId,
    parentCategoryId: type.categoryId,
    title: type.name,
    level: Math.max(0, Number(parent?.level) || 0) + 1,
    isDisabled: Boolean(type.isDisabled),
    contentHash: type.contentHash,
    updatedAt: type.lastSeenAt,
  };
}

function createUnavailablePayload() {
  return {
    ok: false,
    error: {
      code: 'SHARED_CATALOG_MIGRATION_REQUIRED',
      message: '共享类目 SQLite 表尚未就绪。',
    },
  };
}

export function createCatalogRoutes({ service } = {}) {
  const isAvailable = () => Boolean(
    service?.isSharedCatalogAvailable?.()
      ?? service?.listSharedCatalogs,
  );

  function requireAvailable() {
    if (!isAvailable()) {
      const error = new Error('Shared catalog SQLite schema is not available.');
      error.code = 'SHARED_CATALOG_MIGRATION_REQUIRED';
      throw error;
    }
  }

  function readCatalogs(query = {}) {
    requireAvailable();
    const contractVersion = normalizeText(query.contractVersion ?? query.contract_version);
    const catalogs = service.listSharedCatalogs({
      platform: normalizeText(query.platform) || undefined,
      marketplace: normalizeText(query.marketplace) || undefined,
      locale: normalizeText(query.locale) || undefined,
      limit: normalizeLimit(query.limit, 100, 1000),
    }).filter((item) => !contractVersion || item.contractVersion === contractVersion);
    return { ok: true, source: 'sqlite-shared-catalog', count: catalogs.length, catalogs };
  }

  function readCategoryTree(query = {}) {
    requireAvailable();
    const catalog = selectCatalog(service, query);
    if (!catalog) {
      return {
        ok: true,
        source: 'sqlite-shared-catalog',
        catalog: null,
        count: 0,
        nodes: [],
      };
    }

    const limit = normalizeLimit(query.limit, 10_000, 10_000);
    const categories = service.listSharedCategoryNodes({ catalogId: catalog.catalogId, limit });
    const categoryById = new Map(categories.map((item) => [item.categoryId, item]));
    const types = service.listSharedTypes({ catalogId: catalog.catalogId, limit });
    const nodes = [
      ...categories.map(categoryToNode),
      ...types.map((item) => typeToNode(item, categoryById)),
    ];
    return {
      ok: true,
      source: 'sqlite-shared-catalog',
      catalog,
      count: nodes.length,
      categoryCount: categories.length,
      typeCount: types.length,
      nodes,
    };
  }

  function readEntityList(entityKind, query = {}) {
    requireAvailable();
    const catalog = selectCatalog(service, query);
    if (!catalog) {
      return { ok: true, source: 'sqlite-shared-catalog', catalog: null, count: 0, items: [] };
    }
    const input = {
      ...query,
      catalogId: catalog.catalogId,
      limit: normalizeLimit(query.limit, 1000, 10_000),
    };
    const readers = {
      categories: service.listSharedCategoryNodes,
      types: service.listSharedTypes,
      attributes: service.listSharedAttributes,
      values: service.listSharedAttributeValues,
    };
    const items = readers[entityKind](input);
    return {
      ok: true,
      source: 'sqlite-shared-catalog',
      catalog,
      count: items.length,
      items,
    };
  }

  function readPath(query = {}) {
    requireAvailable();
    const catalog = selectCatalog(service, query);
    const resolved = catalog
      ? service.resolveSharedCatalogPath({
          catalogId: catalog.catalogId,
          descriptionCategoryId: query.descriptionCategoryId ?? query.categoryId,
          typeId: query.typeId,
        })
      : null;
    return {
      ok: true,
      source: 'sqlite-shared-catalog',
      catalog,
      resolved,
      path: resolved?.path || [],
      pathText: resolved?.pathText || '',
    };
  }

  function bootstrapProfileCatalog(input = {}) {
    if (!isAvailable()) {
      return { ok: true, skipped: true, reason: 'migration-not-available', seed: null, legacy: null };
    }

    const identity = normalizeIdentity(input);
    const catalogsBefore = service.listSharedCatalogs({
      platform: identity.platform,
      marketplace: identity.marketplace,
      locale: identity.locale,
      limit: 1000,
    });
    const seededCatalog = catalogsBefore.find((item) => (
      item.contractVersion === identity.contractVersion
      && Boolean(item.contentHash || item.activeSnapshotId)
    ));
    const seed = seededCatalog
      ? { ok: true, skipped: true, reason: 'canonical-catalog-already-present', catalog: seededCatalog }
      : service.seedSharedCatalogFromPackagedJson({
          ...identity,
          filePath: input.filePath,
        });

    const legacy = service.migrateLegacyShopCatalogs({
      platform: identity.platform,
      marketplace: identity.marketplace,
      contractVersion: normalizeText(input.legacyContractVersion) || 'legacy-catalog-cache-v1',
    });

    return { ok: true, skipped: false, seed, legacy };
  }

  function handleGet(pathname, query = {}) {
    const routePrefix = SHARED_CATALOG_ROUTE_PREFIXES.find((prefix) => (
      pathname === prefix || pathname.startsWith(`${prefix}/`)
    ));
    if (!routePrefix) return null;
    try {
      const suffix = pathname.slice(routePrefix.length) || '/tree';
      const readers = {
        '/catalogs': () => readCatalogs(query),
        '/tree': () => readCategoryTree(query),
        '/path': () => readPath(query),
        '/categories': () => readEntityList('categories', query),
        '/types': () => readEntityList('types', query),
        '/attributes': () => readEntityList('attributes', query),
        '/values': () => readEntityList('values', query),
      };
      const reader = readers[suffix];
      if (!reader) {
        return {
          status: 404,
          payload: {
            ok: false,
            error: { code: 'SHARED_CATALOG_ROUTE_NOT_FOUND', message: '共享类目读取接口不存在。' },
          },
        };
      }
      return { status: 200, payload: reader() };
    } catch (error) {
      const unavailable = error?.code === 'SHARED_CATALOG_MIGRATION_REQUIRED';
      return {
        status: unavailable ? 503 : 400,
        payload: unavailable
          ? createUnavailablePayload()
          : {
              ok: false,
              error: {
                code: error?.code || 'SHARED_CATALOG_QUERY_INVALID',
                message: error instanceof Error ? error.message : String(error),
              },
            },
      };
    }
  }

  return {
    domain: 'catalog',
    service,
    connected: isAvailable(),
    bootstrapProfileCatalog,
    readCatalogs,
    readCategoryTree,
    readPath,
    handleGet,
  };
}
