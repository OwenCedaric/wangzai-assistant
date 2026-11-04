import { createSharedCatalogService } from '../../domain/catalog/sharedCatalogService.js';

const CATEGORY_PATH_SEPARATOR = ' > ';
const DEFAULT_IDENTITY = Object.freeze({
  platform: 'ozon',
  marketplace: 'ozon',
  locale: 'ZH_HANS',
  contractVersion: 'ozon-description-category-v1',
});
const VERSION_CHECK_INTERVAL_MS = 1000;

let categoryIndexCache = null;
let sqliteCatalogReader = null;
let configuredIdentity = { ...DEFAULT_IDENTITY };
let nextVersionCheckAt = 0;

function normalizeId(value) {
  if (value === undefined || value === null || value === '') return '';
  return String(value).trim();
}

function normalizeIdentity(input = {}) {
  return {
    platform: normalizeId(input.platform) || DEFAULT_IDENTITY.platform,
    marketplace: normalizeId(input.marketplace) || DEFAULT_IDENTITY.marketplace,
    locale: (normalizeId(input.locale) || DEFAULT_IDENTITY.locale).toUpperCase(),
    contractVersion:
      normalizeId(input.contractVersion ?? input.contract_version)
      || DEFAULT_IDENTITY.contractVersion,
  };
}

function listCandidateCatalogs() {
  if (!sqliteCatalogReader?.listSharedCatalogs) return [];
  try {
    return sqliteCatalogReader.listSharedCatalogs({
      platform: configuredIdentity.platform,
      marketplace: configuredIdentity.marketplace,
      locale: configuredIdentity.locale,
      limit: 1000,
    });
  } catch {
    return [];
  }
}

function selectCatalog(catalogs = []) {
  const exact = catalogs.find((item) => item.contractVersion === configuredIdentity.contractVersion);
  if (exact) return exact;
  return [...catalogs].sort((left, right) => {
    const leftRemote = left.sourceKind === 'remote' ? 1 : 0;
    const rightRemote = right.sourceKind === 'remote' ? 1 : 0;
    if (leftRemote !== rightRemote) return rightRemote - leftRemote;
    return String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
  })[0] || null;
}

function catalogVersionSignature(catalog) {
  if (!catalog) return 'catalog:none';
  return [catalog.catalogId, catalog.contentHash, catalog.activeSnapshotId, catalog.updatedAt]
    .map((value) => normalizeId(value))
    .join(':');
}

function readCatalogEntities(catalogId) {
  if (!catalogId) return { categories: [], types: [] };
  try {
    return {
      categories: sqliteCatalogReader.listSharedCategoryNodes({ catalogId, limit: 10_000 }),
      types: sqliteCatalogReader.listSharedTypes({ catalogId, limit: 10_000 }),
    };
  } catch {
    return { categories: [], types: [] };
  }
}

function buildCategoryIndex() {
  const catalog = selectCatalog(listCandidateCatalogs());
  const { categories, types } = readCatalogEntities(catalog?.catalogId);
  const rawCategoryById = new Map();

  for (const category of categories) {
    const categoryId = normalizeId(category.categoryId);
    if (!categoryId) continue;
    rawCategoryById.set(categoryId, {
      categoryId,
      parentCategoryId: normalizeId(category.parentCategoryId),
      name: normalizeId(category.name),
    });
  }

  const buildPath = (categoryId, seen = new Set()) => {
    if (!categoryId || seen.has(categoryId)) return [];
    seen.add(categoryId);
    const category = rawCategoryById.get(categoryId);
    if (!category) return [];
    return [
      ...buildPath(category.parentCategoryId, seen),
      category.name,
    ].filter(Boolean);
  };

  const categoryById = new Map();
  for (const [categoryId, category] of rawCategoryById) {
    const path = buildPath(categoryId);
    categoryById.set(categoryId, {
      descriptionCategoryId: categoryId,
      name: category.name,
      path,
      pathText: path.join(CATEGORY_PATH_SEPARATOR),
      rootName: path[0] || category.name || '',
      source: 'sqlite-shared-catalog',
      catalogId: catalog?.catalogId || '',
    });
  }

  const typeById = new Map();
  for (const type of types) {
    const typeId = normalizeId(type.typeId);
    const categoryId = normalizeId(type.categoryId);
    const name = normalizeId(type.name);
    if (!typeId || !name) continue;
    const path = [...buildPath(categoryId), name].filter(Boolean);
    typeById.set(typeId, {
      typeId,
      descriptionCategoryId: categoryId,
      name,
      path,
      pathText: path.join(CATEGORY_PATH_SEPARATOR),
      rootName: path[0] || name,
      source: 'sqlite-shared-catalog',
      catalogId: catalog?.catalogId || '',
    });
  }

  return {
    loaded: Boolean(catalog && (categoryById.size > 0 || typeById.size > 0)),
    source: 'sqlite-shared-catalog',
    filePath: '',
    catalog,
    versionSignature: catalogVersionSignature(catalog),
    categoryById,
    typeById,
  };
}

function refreshIndexIfCatalogChanged() {
  if (!categoryIndexCache || Date.now() < nextVersionCheckAt) return;
  nextVersionCheckAt = Date.now() + VERSION_CHECK_INTERVAL_MS;
  const catalog = selectCatalog(listCandidateCatalogs());
  if (catalogVersionSignature(catalog) !== categoryIndexCache.versionSignature) {
    categoryIndexCache = buildCategoryIndex();
  }
}

export function configureSoftwareCategoryNameService({ service, db, identity } = {}) {
  if (service) {
    sqliteCatalogReader = service;
  } else if (db) {
    const sharedCatalogService = createSharedCatalogService(db);
    sqliteCatalogReader = {
      listSharedCatalogs: sharedCatalogService.listCatalogs,
      listSharedCategoryNodes: (input = {}) => (
        sharedCatalogService.listCategories(input.catalogId, input)
      ),
      listSharedTypes: (input = {}) => sharedCatalogService.listTypes(input.catalogId, input),
    };
  } else {
    sqliteCatalogReader = null;
  }
  configuredIdentity = normalizeIdentity(identity);
  categoryIndexCache = null;
  nextVersionCheckAt = 0;
  return getSoftwareCategoryIndexMeta();
}

export function getSoftwareCategoryIndexMeta() {
  const index = getSoftwareCategoryIndex();
  return {
    loaded: index.loaded,
    source: index.source,
    filePath: '',
    catalogId: index.catalog?.catalogId || null,
    contentHash: index.catalog?.contentHash || null,
    categoryCount: index.categoryById.size,
    typeCount: index.typeById.size,
  };
}

export function getSoftwareCategoryIndex() {
  if (!categoryIndexCache) categoryIndexCache = buildCategoryIndex();
  refreshIndexIfCatalogChanged();
  return categoryIndexCache;
}

export function resetSoftwareCategoryIndexForTests({ clearConfiguration = false } = {}) {
  categoryIndexCache = null;
  nextVersionCheckAt = 0;
  if (clearConfiguration) {
    sqliteCatalogReader = null;
    configuredIdentity = { ...DEFAULT_IDENTITY };
  }
}

export function getOzonSoftwareCategoryByIds({ typeId, descriptionCategoryId } = {}) {
  const index = getSoftwareCategoryIndex();
  const typeKey = normalizeId(typeId);
  if (typeKey) {
    const typeMatch = index.typeById.get(typeKey);
    if (typeMatch?.pathText) return typeMatch;
  }

  const categoryKey = normalizeId(descriptionCategoryId);
  if (categoryKey) {
    const categoryMatch = index.categoryById.get(categoryKey);
    if (categoryMatch?.pathText) return categoryMatch;
  }

  return null;
}
