import { createProductReadDatabaseSelector } from './productReadDatabaseSelector.js';
import { createProductCanonicalQueryRepository } from "./productCanonicalQueryRepository.js";
import { createProductHydrationMarkerRepository } from "./productHydrationMarkerRepository.js";
import { createProductLegacyMigrationRepository } from "./productLegacyMigrationRepository.js";
import { createProductRepositoryContext } from "./productRepositoryContext.js";
import { createProductSupportRepository } from "./productSupportRepository.js";
import { createProductSyncStagingRepository } from "./productSyncStagingRepository.js";
import { createProductWriteReadbackRepository } from "./productWriteReadbackRepository.js";
export { PRODUCT_FACET_OBSERVATION_STATUS } from "./productCanonicalDto.js";
export function createProductRepository(db, options = {}) {
  if (!db) throw new Error("createProductRepository requires db.");

  const { canonicalFactsAvailable, canonicalFacts } =
    createProductRepositoryContext(db, options);

  const hydrationMarker = createProductHydrationMarkerRepository(db);
  const support = createProductSupportRepository(db, hydrationMarker);
  const staging = createProductSyncStagingRepository(db, {
    canonicalFacts,
    refreshProductHydratedAt: hydrationMarker.refreshProductHydratedAt,
    syncOzonMaterialProjection: support.syncOzonMaterialProjection,
  });
  const canonicalQuery = createProductCanonicalQueryRepository(db, {
    canonicalFactsAvailable,
    attachProductSupport: support.attachProductSupport,
    allowCompatibilityRepairs: options.allowCompatibilityRepairs !== false,
  });
  const routedRead = createProductReadDatabaseSelector(db, canonicalQuery, options);
  const legacyMigration = createProductLegacyMigrationRepository(support);
  const writeReadback = createProductWriteReadbackRepository(staging);

  return {
    ...writeReadback,
    recordProductHydrationFacetObservations:
      staging.recordProductHydrationFacetObservations,
    markProductHydrationFacetChecked: staging.markProductHydrationFacetChecked,
    getProductHydrationCoverage: staging.getProductHydrationCoverage,
    listProducts: (query) => routedRead("listProducts", query),
    listWarehousePickerProducts: (query) => routedRead("listWarehousePickerProducts", query),
    getProductsByIds: (query) => routedRead("getProductsByIds", query),
    resolveOfferIdsForProducts: (query) => routedRead("resolveOfferIdsForProducts", query),
    resolveProductModelNamesForOffers: (query) => routedRead("resolveProductModelNamesForOffers", query),
    listSkuFamily: (query) => routedRead("listSkuFamily", query),
    upsertProductMaterialProfile: support.upsertProductMaterialProfile,
    importLegacyProductMaterialProfiles:
      legacyMigration.importLegacyProductMaterialProfiles,
    listProductMaterialProfiles: support.listProductMaterialProfiles,
    listProductMaterialProfilesPage:
      legacyMigration.listProductMaterialProfilesPage,
    upsertProductSourceLinks: support.upsertProductSourceLinks,
    importLegacyProductSourceLinks: legacyMigration.importLegacyProductSourceLinks,
    listProductSourceLinks: support.listProductSourceLinks,
    listProductSourceLinksPage: legacyMigration.listProductSourceLinksPage,
    upsertProductImageHealth: support.upsertProductImageHealth,
  };
}
