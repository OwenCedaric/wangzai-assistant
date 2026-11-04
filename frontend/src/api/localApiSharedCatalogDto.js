import { LocalApiError } from "./localApiError.js";

export function normalizeSharedCatalogDto(catalog) {
  if (!catalog || typeof catalog !== 'object') return null;
  return {
    catalogId: String(catalog.catalogId || ''),
    platform: String(catalog.platform || ''),
    marketplace: String(catalog.marketplace || ''),
    locale: String(catalog.locale || ''),
    contractVersion: String(catalog.contractVersion || ''),
    mapperVersion: String(catalog.mapperVersion || ''),
    sourceKind: String(catalog.sourceKind || ''),
    contentHash: catalog.contentHash || null,
    activeSnapshotId: catalog.activeSnapshotId || null,
    lastSeededAt: catalog.lastSeededAt || null,
    lastSyncedAt: catalog.lastSyncedAt || null,
    updatedAt: catalog.updatedAt || null,
  };
}

export function normalizeSharedCatalogNodeDto(node) {
  if (!node || typeof node !== 'object') return null;
  const categoryId = String(node.categoryId ?? '').trim();
  const typeId = String(node.typeId ?? '').trim();
  const title = String(node.title ?? node.name ?? '').trim();
  if (!title || (!categoryId && !typeId)) return null;
  return {
    nodeKind: node.nodeKind === 'type' ? 'type' : 'category',
    catalogId: String(node.catalogId || ''),
    categoryId,
    typeId,
    parentCategoryId: String(node.parentCategoryId ?? '').trim(),
    title,
    level: Number.isFinite(Number(node.level)) ? Number(node.level) : 0,
    isDisabled: Boolean(node.isDisabled),
    contentHash: node.contentHash || null,
    updatedAt: node.updatedAt || null,
  };
}

export function normalizeSharedCatalogTreePayload(payload) {
  if (!payload || payload.ok !== true || !Array.isArray(payload.nodes)) {
    throw new LocalApiError('共享类目接口返回了无效数据。', {
      code: 'SHARED_CATALOG_DTO_INVALID',
      payload,
    });
  }
  const nodes = payload.nodes.map(normalizeSharedCatalogNodeDto).filter(Boolean);
  return {
    ok: true,
    source: 'sqlite-shared-catalog',
    catalog: normalizeSharedCatalogDto(payload.catalog),
    count: nodes.length,
    categoryCount: Number(payload.categoryCount) || 0,
    typeCount: Number(payload.typeCount) || 0,
    nodes,
  };
}

export function createSharedCatalogQuery(options = {}) {
  return {
    catalogId: options.catalogId,
    platform: options.platform || 'ozon',
    marketplace: options.marketplace || 'ozon',
    locale: options.locale || 'ZH_HANS',
    contractVersion: options.contractVersion || 'ozon-description-category-v1',
    limit: options.limit,
  };
}
