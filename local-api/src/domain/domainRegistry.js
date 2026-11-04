import { createProductsService } from './products/productsService.js';
import { createOrdersService } from './orders/ordersService.js';
import { createProfitService } from './profit/profitService.js';
import { createFinanceService } from './finance/financeService.js';
import { createProfitReportService } from './profitReport/profitReportService.js';
import { createReturnsService } from './returns/returnsService.js';
import { createLogisticsService } from './logistics/logisticsService.js';
import { createImagesService } from './images/imagesService.js';
import { createReportsService } from './reports/reportsService.js';
import { createMarketingService } from './marketing/marketingService.js';
import { createCustomerServiceService } from './customerService/customerServiceService.js';
import { createCustomerMessageTranslationService } from './customerService/customerMessageTranslationService.js';
import { createDataAnalysisService } from './dataAnalysis/dataAnalysisService.js';
import { createDashboardBusinessShareService } from './dashboard/dashboardBusinessShareService.js';
import { createDashboardOverviewService } from './dashboard/dashboardOverviewService.js';
import { withDomainReadCache } from './domainReadCache.js';
import { createShopCacheCompatibilityStore } from '../cache/shopCacheCompatibilityStore.js';
import { createShopOrderStorage } from '../db/shopOrderStorage.js';
import { createShopOrderBackfillCoordinator } from '../db/shopOrderBackfillCoordinator.js';
import { createShopOrderReadRouter } from '../db/shopOrderReadRouter.js';
import { createShopProductStorage } from '../db/shopProductStorage.js';
import { createShopProductReadRouter } from '../db/shopProductReadRouter.js';
import { createShopOperationalStorage } from '../db/shopOperationalStorage.js';
import { createShopFederatedReadDatabase } from '../db/shopFederatedReadDatabase.js';
import { createShopProfitLedgerStorage } from '../db/shopProfitLedgerStorage.js';
import { createShopDomainStorageResolver } from '../db/shopDomainStorageResolver.js';

export function createDomainServiceRegistry({ db, ozonScheduler, ozonClient, shopRepository, shopDatabaseManager, shopDatabaseRouter, shopAggregateIndex, orderReadCanaryShopIds = [], orderReadAllReadyShops = false, orderDirectWriteAllShops = false, operationalDirectWriteAllShops = false, productReadCanaryShopIds = [], productDirectWriteShopIds = [], productDirectWriteAllShops = false, profitLedgerDirectShopIds = [], productImageAssetRepository, refreshProductImagePayloadUrls } = {}) {
  let dataAnalysisService = null;
  const messageTranslationService = createCustomerMessageTranslationService();
  let productsService = null;
  const shopCacheCompatibilityStore = shopDatabaseManager?.ensure
    ? createShopCacheCompatibilityStore({
        shopDatabaseManager,
        onCommitted: shopAggregateIndex?.record
          ? (contract) => {
              const indexed = shopAggregateIndex.record(contract);
              const row = indexed?.row;
              if (
                row?.scopeDigest !== contract.layout.scopeDigest
                || row?.contractKey !== contract.contractKey
                || row?.payloadHash !== contract.payloadHash
                || Number(row?.revision) !== Number(contract.revision)
              ) {
                const error = new Error('shop aggregate index readback mismatch');
                error.code = 'SHOP_AGGREGATE_INDEX_READBACK_MISMATCH';
                throw error;
              }
              return indexed;
            }
          : null,
        onInvalidated: shopAggregateIndex?.removeDomain
          ? (contract) => shopAggregateIndex.removeDomain(contract.layout, contract.domain)
          : null,
        verifyIndexed: shopAggregateIndex?.getScopeContract
          ? (contract) => {
              const row = shopAggregateIndex.getScopeContract(
                contract.layout,
                contract.contractKey,
              );
              return Boolean(
                row
                && row.scopeDigest === contract.layout.scopeDigest
                && row.shopId === contract.layout.shopId
                && row.shopIncarnation === contract.layout.shopIncarnation
                && row.domain === contract.domain
                && row.queryHash === contract.queryHash
                && row.contractKey === contract.contractKey
                && row.payloadHash === contract.payloadHash
                && Number(row.revision) === Number(contract.revision)
                && row.committedAt === contract.committedAt
              );
            }
          : null,
      })
    : null;
  const shopOrderStorage = shopDatabaseRouter?.open
    ? createShopOrderStorage({
        canonicalDb: db,
        shopDatabaseRouter,
        directWriteAllShops: orderDirectWriteAllShops === true,
      })
    : null;
  const shopOrderBackfillCoordinator = shopOrderStorage
      ? createShopOrderBackfillCoordinator({
        shopRepository,
        shopOrderStorage,
        onShopCompleted({ shopId }) {
          if (orderDirectWriteAllShops) shopOrderStorage.initializeDirectShop({ shopId });
        },
      })
    : null;
  const shopOrderReadRouter = shopOrderStorage
    ? createShopOrderReadRouter({
        canonicalDb: db,
        shopOrderStorage,
        canaryShopIds: orderReadCanaryShopIds,
        includeAllReadyShops: orderReadAllReadyShops,
      })
    : null;
  const shopProductStorage = shopDatabaseRouter?.open
    ? createShopProductStorage({
        canonicalDb: db,
        shopDatabaseRouter,
        enabledShopIds: productReadCanaryShopIds,
        directWriteShopIds: productDirectWriteShopIds,
        directWriteAllShops: productDirectWriteAllShops === true,
        onCommitted({ shopId }) {
          productsService?.invalidateOwnerHotCache?.(shopId);
        },
      })
    : null;
  const shopProductReadRouter = shopProductStorage
    ? createShopProductReadRouter({ canonicalDb: db, shopProductStorage })
    : null;
  const shopOperationalStorage = shopDatabaseRouter?.open
    ? createShopOperationalStorage({
        canonicalDb: db,
        shopDatabaseRouter,
        directWriteAllShops: operationalDirectWriteAllShops === true,
      })
    : null;
  const shopProfitLedgerStorage = profitLedgerDirectShopIds.length
    ? createShopProfitLedgerStorage({ canonicalDb: db, shopRepository, shopDatabaseRouter, directShopIds: profitLedgerDirectShopIds })
    : null;
  shopProfitLedgerStorage?.initialize();
  const shopFederatedReadDatabase = shopDatabaseRouter?.resolve
    ? createShopFederatedReadDatabase({ canonicalDb: db, shopRepository, shopDatabaseRouter, profitLedgerDirectShopIds,
        requiredShopIds: () => orderDirectWriteAllShops || operationalDirectWriteAllShops || productDirectWriteAllShops
          ? shopRepository.listShops().filter(shop => shop.status !== 'disabled').map(shop => shop.id)
          : [...productDirectWriteShopIds, ...profitLedgerDirectShopIds],
      })
    : null;
  const aggregateReadDb = shopFederatedReadDatabase?.db || db;
  const resolveShopDomainDatabase = createShopDomainStorageResolver({
    canonicalDb: db, shopProductStorage, shopOrderStorage, shopOperationalStorage,
  });
  const ordersService = createOrdersService({ db, ozonScheduler, shopOrderStorage, shopOrderReadRouter, shopRepository });
  dataAnalysisService = createDataAnalysisService({ db, sourceDb: aggregateReadDb });
  productsService = createProductsService({
    db,
    ozonScheduler,
    shopRepository,
    shopProductStorage,
    shopProductReadRouter,
    productImageAssetRepository,
    refreshProductImagePayloadUrls,
    onProductDataChanged(shopId) { services.get('products')?.invalidateOwnerHotCache?.(shopId); },
  });
  const cacheOptions = {
    profileId: shopRepository?.profileId || 'current',
    resolveActiveShopIds: () => shopRepository?.listShops?.().filter(shop => shop.status !== 'disabled').map(shop => shop.id) || [],
    shopCacheCompatibilityStore,
    resolveShopScopeToken: (shopId) => shopRepository.identityRepository.createScopeToken(
      shopId,
      shopRepository.profileId,
    ),
  };
  const services = new Map([
    ['products', withDomainReadCache('products', productsService, cacheOptions)],
    ['orders', withDomainReadCache('orders', ordersService, cacheOptions)],
    ['profit', withDomainReadCache('profit', createProfitService({ db, readDb: aggregateReadDb, ozonScheduler, shopOperationalStorage, shopProfitLedgerStorage }), cacheOptions)],
    ['finance', withDomainReadCache('finance', createFinanceService({ db, readDb: aggregateReadDb, ozonScheduler, shopOperationalStorage }), cacheOptions)],
    ['profit-report', withDomainReadCache('profit-report', createProfitReportService({ db, readDb: aggregateReadDb, ozonScheduler, shopOperationalStorage }), cacheOptions)],
    ['returns', withDomainReadCache('returns', createReturnsService({ db, readDb: aggregateReadDb, ozonScheduler, shopRepository, messageTranslationService, shopOperationalStorage }), cacheOptions)],
    ['logistics', withDomainReadCache('logistics', createLogisticsService({ db, ozonScheduler }), cacheOptions)],
    ['marketing', withDomainReadCache('marketing', createMarketingService({
      db,
      ozonScheduler,
      productRepository: productsService?.productRepository,
    }), cacheOptions)],
    ['customerService', withDomainReadCache('customerService', createCustomerServiceService({
      db,
      ozonScheduler,
      ozonClient,
      shopRepository,
      messageTranslationService,
      orderReadPort: ordersService.orderReadPort,
    }), cacheOptions)],
    ['images', withDomainReadCache('images', createImagesService({ ozonScheduler, productsService }), cacheOptions)],
    ['reports', withDomainReadCache('reports', createReportsService({ db, ozonScheduler }), cacheOptions)],
    ['data-analysis', dataAnalysisService],
    ['dashboard-business-share', createDashboardBusinessShareService({ db: aggregateReadDb })],
    ['dashboard-overview', withDomainReadCache('dashboard-overview', createDashboardOverviewService({ db: aggregateReadDb }), {
      ...cacheOptions,
      ttlMs: 5_000,
      maxEntries: 60,
    })],
  ]);
  return {
    resolveShopDomainDatabase,
    async quiesceOwnerStorage(shopId, options) {
      for (const service of services.values()) service.fenceOwnerCache?.(shopId);
      shopOrderBackfillCoordinator?.pauseOwner?.(shopId);
      await shopProductStorage?.quiesceOwner?.(shopId, options);
      return { products: shopProductStorage?.getOwnerStatus?.(shopId) || null,
        orderBackfill: shopOrderBackfillCoordinator?.getOwnerStatus?.(shopId) || null };
    },
    getOwnerStorageStatus(shopId) {
      return { products: shopProductStorage?.getOwnerStatus?.(shopId) || null,
        orderBackfill: shopOrderBackfillCoordinator?.getOwnerStatus?.(shopId) || null };
    },
    suspendReadConnections(owner) {
      const key = `${owner.ownerType}:${owner.ownerId}`;
      shopFederatedReadDatabase?.suspendReads?.(key);
      productsService?.productRepository?.suspendProductReadConnections?.(key);
      return { suspended: true };
    },
    releaseTransientResources(owner) {
      const key = `${owner.ownerType}:${owner.ownerId}`;
      shopFederatedReadDatabase?.resumeReads?.(key);
      productsService?.productRepository?.resumeProductReadConnections?.(key);
      return { released: true };
    },
    releaseOwnerStorage(shopId) {
      shopProductStorage?.releaseOwner?.(shopId);
      shopOrderBackfillCoordinator?.releaseOwner?.(shopId);
      for (const service of services.values()) service.releaseOwnerCacheFence?.(shopId);
      if (shopRepository?.getPublicShopById?.(shopId)?.status === 'active') {
        shopProductStorage?.enqueueShopSnapshot?.({ shopId });
        shopOrderBackfillCoordinator?.wake?.(shopId);
      }
      return { released: true };
    },
    completeOwnerStorageRemoval(shopId) {
      // Keep writer tombstones until an explicitly admitted rebind. Only let
      // aggregate reads resume after the deleted owner disappeared from shops.
      for (const service of services.values()) service.releaseOwnerCacheFence?.(shopId);
      return { completed: true };
    },
    get(domain) {
      return services.get(domain) || null;
    },
    list() {
      return [...services.keys()];
    },
    startBackgroundStorage() {
      const orderDirect = orderDirectWriteAllShops
        ? shopRepository?.listShops?.().map((shop) =>
            shopOrderStorage?.initializeDirectShop?.({ shopId: shop.id }) || null)
        : [];
      const order = shopOrderBackfillCoordinator?.start?.() || null;
      const operational = operationalDirectWriteAllShops
        ? shopRepository?.listShops?.().map((shop) =>
            shopOperationalStorage?.initializeDirectShop?.({ shopId: shop.id }) || null)
        : [];
      const productBootstrapIds = productDirectWriteAllShops
        ? shopRepository.listShops().filter(shop => shop.status !== 'disabled').map(shop => shop.id)
        : [...new Set([...productReadCanaryShopIds, ...productDirectWriteShopIds])];
      const products = productBootstrapIds.map((shopId) =>
        shopProductStorage?.enqueueShopSnapshot?.({ shopId }) || null,
      );
      const federated = shopFederatedReadDatabase?.refresh?.() || null;
      return Object.freeze({ order, orderDirect: Object.freeze(orderDirect || []), operational: Object.freeze(operational || []), products: Object.freeze(products), federated });
    },
    stopBackgroundStorage() {
      shopProductStorage?.stop?.();
      productsService?.productRepository?.closeProductReadConnections?.();
      const order = shopOrderBackfillCoordinator?.stop?.() || null;
      shopFederatedReadDatabase?.close?.();
      return order;
    },
    wakeOrderBackfill(shopId) {
      return shopOrderBackfillCoordinator?.wake?.(shopId) || null;
    },
    initializeNewShopOrderStorage(shopId, scopeToken) {
      const initialized = shopOrderStorage?.initializeEmptyShop?.({
        shopId,
        expectedScopeToken: scopeToken,
      }) || null;
      const direct = orderDirectWriteAllShops
        ? shopOrderStorage?.initializeDirectShop?.({ shopId, expectedScopeToken: scopeToken }) || null
        : null;
      return Object.freeze({ initialized, direct });
    },
    initializeNewShopProductStorage(shopId, scopeToken) {
      return shopProductStorage?.initializeDirectShop?.({
        shopId,
        expectedScopeToken: scopeToken,
      }) || null;
    },
    initializeNewShopOperationalStorage(shopId, scopeToken) {
      const initialized = shopOperationalStorage?.initializeDirectShop?.({
        shopId,
        expectedScopeToken: scopeToken,
      }) || null;
      shopFederatedReadDatabase?.refresh?.();
      return initialized;
    },
    countOwnerHotCache(shopId) {
      return [...services.values()].reduce(
        (total, service) => total + Number(service?.countOwnerHotCache?.(shopId) || 0),
        0,
      );
    },
    invalidateOwnerHotCache(shopId) {
      return [...services.values()].reduce((summary, service) => {
        const result = service?.invalidateOwnerHotCache?.(shopId);
        summary.removed += Number(result?.removed || 0);
        return summary;
      }, { ok: true, removed: 0 });
    },
    getHotCacheStatus() {
      return Object.fromEntries(
        [...services.entries()]
          .filter(([, service]) => typeof service?.getHotCacheStatus === 'function')
          .map(([domain, service]) => [domain, service.getHotCacheStatus()]),
      );
    },
    getShopCacheCompatibilityStatus() {
      const store = shopCacheCompatibilityStore?.getStatus?.() || null;
      return store
        ? Object.freeze({
            mode: store.mode,
            cutoverReady: store.cutoverReady,
            store,
            physicalStorage: shopDatabaseManager?.snapshot?.() || null,
            databaseRouter: shopDatabaseRouter?.snapshot?.() || null,
            orderStorage: shopOrderStorage?.snapshot?.() || null,
            orderBackfill: shopOrderBackfillCoordinator?.snapshot?.() || null,
            orderRead: shopOrderReadRouter?.snapshot?.() || null,
            productStorage: shopProductStorage?.snapshot?.() || null,
            productRead: shopProductReadRouter?.snapshot?.() || null,
            aggregateIndex: shopAggregateIndex?.snapshot?.() || null,
          })
        : null;
    },
  };
}
