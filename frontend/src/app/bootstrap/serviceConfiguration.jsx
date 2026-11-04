import { getOzonShopClientId } from '../../entities/order/orderShopScope.jsx';
import {
  canUseCrossBorderOrderOutInfoRead,
  normalizeCrossBorderLocalOrderRecord,
  readLocalCrossBorderOrderRecords,
  requestCrossBorderReadOnly,
} from '../../entities/order/crossBorderOrderApi.jsx';
import { getCrossBorderOrderId } from '../../entities/order/orderSourceLinkFields.jsx';
import {
  createEmptyProductStatusCounts,
  hasProductStatusCountValues,
  mapProductCacheCountsToStatusLabels,
  readLocalDataFile,
  recordLocalMirrorRetryTask,
  writeLocalDataFile,
} from '../../entities/product/productLocalData.jsx';
import { readLocalApiProductPage } from '../../entities/product/productLocalMirror.jsx';
import { getProductRowShopScopeKey } from '../../entities/product/productWriteHelpers.jsx';
import { getPurchaseOrderVolumeItems } from '../../features/orders/purchase/lib/purchaseImageRules.jsx';
import { getProductRowCacheKey } from '../../features/products/lib/productEditing.jsx';
import { configureProductBusMaterialService } from '../../services/productBusMaterialService';
import { configureProductMaterialProfileStore } from '../../services/productMaterialProfileStore';
import {
  importLegacyProductMaterialProfilesToLocalApi,
  readProductMaterialProfilesFromLocalApi,
  readProductMaterialProfilesPageFromLocalApi,
  saveProductMaterialProfileToLocalApi,
} from '../../services/productModuleClient';
import { configureProductSearchFallbackService } from '../../services/productSearchFallbackService';
import { productStatusTabs } from '../../shared/ozon/ozonRuntime.jsx';

configureProductMaterialProfileStore({
  readLocalDataFile,
  writeLocalDataFile,
  readProfilesFromLocalApi: readProductMaterialProfilesFromLocalApi,
  readProfilesPageFromLocalApi: readProductMaterialProfilesPageFromLocalApi,
  saveProfileToLocalApi: saveProductMaterialProfileToLocalApi,
  importProfilesToLocalApi: importLegacyProductMaterialProfilesToLocalApi,
});

configureProductBusMaterialService({
  readLocalCrossBorderOrderRecords,
  normalizeCrossBorderLocalOrderRecord,
  requestCrossBorderReadOnly,
  canUseCrossBorderOrderOutInfoRead,
  getCrossBorderOrderId,
  getPurchaseOrderVolumeItems,
  getOzonShopClientId,
});

configureProductSearchFallbackService({
  readLocalApiProductPage,
  recordLocalMirrorRetryTask,
  productStatusTabs,
  mapProductCacheCountsToStatusLabels,
  createEmptyProductStatusCounts,
  hasProductStatusCountValues,
  getProductRowShopScopeKey,
  getProductRowCacheKey,
  getShopEntityKey: (shop) => shop?.id || shop?.clientId || shop?.name || 'unknown',
});
