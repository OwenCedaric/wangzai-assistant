import { createProductCanonicalReadService } from "./productCanonicalReadService.js";
import { createProductLegacyMigrationService } from "./productLegacyMigrationService.js";
import { createProductServiceContext } from "./productServiceContext.js";
import { createProductSupportService } from "./productSupportService.js";
import { createProductSummaryHydrationService } from "./productSummaryHydrationService.js";
import { createProductPushRefreshService } from "./productPushRefreshService.js";
import { createProductSyncService } from "./productSyncService.js";
import { createProductWriteReadbackService } from "./productWriteReadbackService.js";

export {
  PRODUCT_FULL_SYNC_VISIBILITIES,
  buildProductHydrationCacheKey,
} from "./productSyncService.js";

export function createProductsService({
  db,
  ozonScheduler,
  shopRepository,
  backgroundRunner = (task) => setImmediate(task),
  hotCache,
  shopProductStorage,
  shopProductReadRouter,
  productImageAssetRepository,
  refreshProductImagePayloadUrls,
  onProductDataChanged,
} = {}) {
  const context = createProductServiceContext({
    db,
    ozonScheduler,
    hotCache,
    shopProductStorage,
    shopProductReadRouter,
    shopRepository,
    productImageAssetRepository,
    refreshProductImagePayloadUrls,
    onProductDataChanged,
  });
  const canonicalRead = createProductCanonicalReadService(context);
  const summaryHydration = createProductSummaryHydrationService({
    ...context,
    ozonScheduler,
    readSummary: canonicalRead.readSummary,
  });
  const pushRefresh = createProductPushRefreshService({
    ...context,
    ozonScheduler,
  });
  const support = createProductSupportService(context);
  const legacyMigration = createProductLegacyMigrationService({
    ...context,
    normalSupportService: support,
  });
  const writeReadback = createProductWriteReadbackService(context);
  const sync = createProductSyncService({
    ...context,
    ozonScheduler,
    shopRepository,
    backgroundRunner,
    warmProductReadCache: canonicalRead.warmProductReadCache,
  });

  const service = {
    domain: "products",
    readCache: canonicalRead.readCache,
    startSync: sync.startSync,
    runProductsSyncJob: sync.runProductsSyncJob,
    readSummary: canonicalRead.readSummary,
    readSkuFamily: canonicalRead.readSkuFamily,
    hydrateSummary: summaryHydration.hydrateSummary,
    refreshProductsByRefs: pushRefresh.refreshProductsByRefs,
    cleanupProductCache: canonicalRead.cleanupProductCache,
    readSupport: support.readSupport,
    listMaterialProfiles: legacyMigration.listMaterialProfiles,
    saveMaterialProfile: support.saveMaterialProfile,
    importLegacyMaterialProfiles: legacyMigration.importLegacyMaterialProfiles,
    saveSourceLinks: support.saveSourceLinks,
    listSourceLinks: support.listSourceLinks,
    importLegacySourceLinks: legacyMigration.importLegacySourceLinks,
    saveImageHealth: support.saveImageHealth,
    executeConfirmedWrite: writeReadback.executeConfirmedWrite,
    countOwnerHotCache: canonicalRead.countOwnerHotCache,
    invalidateOwnerHotCache: canonicalRead.invalidateOwnerHotCache,
  };
  Object.defineProperty(service, 'productRepository', { value: context.repository });
  return service;
}
