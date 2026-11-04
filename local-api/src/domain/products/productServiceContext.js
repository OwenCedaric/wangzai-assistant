import { createCacheCleanupService } from "../../cache/cacheCleanupService.js";
import { createHotCacheService } from "../../cache/hotCacheService.js";
import { createProductRepository } from "../../db/repositories/productRepository.js";
import { createShopProductRepositoryRouter } from "../../db/shopProductRepositoryRouter.js";
import { createProductSyncRunRepository } from "../../db/repositories/productSyncRunRepository.js";
import { createSyncJobService } from "../../sync/syncJobService.js";
import { createSyncSnapshotService } from "../../sync/syncSnapshotService.js";
import { createSyncStateService } from "../../sync/syncStateService.js";
import { createProductSummaryService } from "./productSummaryService.js";
import { createProductWriteService } from "./productWriteService.js";

function hasSqliteTable(db, tableName) {
  if (!db || !String(tableName || "").trim()) return false;
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(String(tableName).trim()),
  );
}

export function createProductServiceContext({ db, ozonScheduler, hotCache, shopProductStorage, shopProductReadRouter, shopRepository, productImageAssetRepository, refreshProductImagePayloadUrls, onProductDataChanged } = {}) {
  const canonicalRepository = hasSqliteTable(db, "ozon_products")
    ? createProductRepository(db, {
        allowCompatibilityRepairs: !shopProductStorage?.snapshot?.().directWriteAllShops,
        resolveProductReadDatabase: shopProductReadRouter?.resolve,
        onProductReadDatabaseError(error, context) {
          shopProductReadRouter?.recordQueryFallback?.({
            shopId: context?.shopId,
            errorCode: error?.code || error?.message,
          });
        },
      })
    : null;
  const repository = canonicalRepository && shopProductStorage?.resolveDirectWriteSession
    ? createShopProductRepositoryRouter({
        canonicalRepository,
        shopProductStorage,
        canonicalDb: db,
        onWritten: (shopId) => clearProductReadCache(shopId),
        listShopIds: () => shopRepository?.listShops?.()
          ?.filter((shop) => shop?.status !== 'disabled')
          .map((shop) => shop.id) || [],
      })
    : canonicalRepository;
  const jobService = db ? createSyncJobService(db) : null;
  const snapshotService = db ? createSyncSnapshotService(db) : null;
  const stateService = db ? createSyncStateService(db) : null;
  const cleanupService = db ? createCacheCleanupService(db) : null;
  const atomicRunRepository = hasSqliteTable(db, "product_sync_runs")
    ? createProductSyncRunRepository(db)
    : null;
  const summaryService = repository
    ? createProductSummaryService(db, { repository })
    : null;
  const productHotCache = hotCache || createHotCacheService({
    maxEntries: 1000,
    ttlMs: 30_000,
    maxPayloadBytes: 2 * 1024 * 1024,
  });
  const clearProductReadCache = (shopId = '') => {
    const ownerId = String(shopId || '').trim();
    const result = ownerId
      ? productHotCache.invalidate({ tags: [`shop:${ownerId}`] })
      : productHotCache.clear();
    if (
      ownerId
      && shopProductStorage?.isEnabledShop?.(ownerId)
      && !shopProductStorage?.isDirectWriteShop?.(ownerId)
    ) {
      shopProductStorage.enqueueShopSnapshot({ shopId: ownerId });
    }
    if (ownerId) onProductDataChanged?.(ownerId);
    return result;
  };
  const productWriteService = repository
    ? createProductWriteService({
        repository,
        productImageAssetRepository,
        refreshProductImagePayloadUrls,
        ozonScheduler,
        clearProductReadCache,
      })
    : null;

  return {
    db,
    repository,
    jobService,
    snapshotService,
    stateService,
    cleanupService,
    atomicRunRepository,
    summaryService,
    productWriteService,
    productHotCache,
    clearProductReadCache,
    shopProductStorage,
  };
}
