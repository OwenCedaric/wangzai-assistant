import { createServer } from "node:http";
import { readFinancePostingBatch } from "../domain/finance/financePostingBatchRead.js";
import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { createCatalogCacheService } from "../cache/catalog/catalogCacheService.js";
import { configureSoftwareCategoryNameService } from "../cache/catalog/softwareCategoryNameService.js";
import { createCatalogRoutes } from "../domain/catalog/catalogRoutes.js";
import { createProtectedComputeService } from "../domain/protectedCompute/protectedComputeService.js";
import {
  createPaidCapabilityAccess,
  paidCapabilityContextFromRequest,
} from "../domain/paidCapabilities/paidCapabilityAccess.js";
import { createProductsRoutes } from "../domain/products/productsRoutes.js";
import { createHistoricalDimensionSyncService } from "../domain/products/historicalDimensionSyncService.js";
import { createProductImageAssetService } from "../domain/productImages/productImageAssetService.js";
import { createProductImageAssetRoutes } from "../domain/productImages/productImageAssetRoutes.js";
import { createImageProvenanceFileRepository } from "../domain/imageProvenance/imageProvenanceFileRepository.js";
import { createImageProvenanceService } from "../domain/imageProvenance/imageProvenanceService.js";
import { createImageProvenanceRoutes } from "../domain/imageProvenance/imageProvenanceRoutes.js";
import { createProductDescriptionService } from "../domain/productDescriptions/productDescriptionService.js";
import { createProductDescriptionRoutes } from "../domain/productDescriptions/productDescriptionRoutes.js";
import { createImagePromptPlanService } from "../domain/imagePromptPlans/imagePromptPlanService.js";
import { createImagePromptPlanRoutes } from "../domain/imagePromptPlans/imagePromptPlanRoutes.js";
import { createDataAnalysisInsightService } from "../domain/dataAnalysis/dataAnalysisInsightService.js";
import { createDataAnalysisInsightRoutes } from "../domain/dataAnalysis/dataAnalysisInsightRoutes.js";
import { createFollowSellerDefenseService } from "../domain/followSellerDefense/followSellerDefenseService.js";
import { createFollowSellerDefenseRoutes } from "../domain/followSellerDefense/followSellerDefenseRoutes.js";
import { createFollowSellerEvidenceBundleService } from "../domain/followSellerDefense/followSellerEvidenceBundleService.js";
import { createFollowSellerQuickComplaintService } from "../domain/followSellerDefense/followSellerQuickComplaintService.js";
import { createExternalDataInsightService } from "../domain/externalDataInsights/externalDataInsightService.js";
import { createExternalDataInsightRoutes } from "../domain/externalDataInsights/externalDataInsightRoutes.js";
import { createSkillInstallSourceService } from "../domain/promptLibrary/skillInstallSourceService.js";
import { createSkillInstallSourceRoutes } from "../domain/promptLibrary/skillInstallSourceRoutes.js";
import { createModelApiDiscoveryService } from "../domain/modelApi/modelApiDiscoveryService.js";
import { createCrossBorderClient } from "../cross-border/crossBorderClient.js";
import { createPerformanceAccountRepository } from "../db/repositories/performanceAccountRepository.js";
import { createAccountRemovalOperationRepository } from "../db/repositories/accountRemovalOperationRepository.js";
import { createPurchaseAccountRepository } from "../db/repositories/purchaseAccountRepository.js";
import { createSalesSourceLinkRepository } from "../db/repositories/salesSourceLinkRepository.js";
import { createExchangeRateCacheRepository } from "../db/repositories/exchangeRateCacheRepository.js";
import { createIntegrationProfileRepository } from "../db/repositories/integrationProfileRepository.js";
import { createIntegrationCredentialRepository } from "../db/repositories/integrationCredentialRepository.js";
import { createModelApiAccountRepository } from "../db/repositories/modelApiAccountRepository.js";
import { createProfileSettingsRepository } from "../db/repositories/profileSettingsRepository.js";
import { createProfileAssetRepository } from "../db/repositories/profileAssetRepository.js";
import { createProductImageAssetRepository } from "../db/repositories/productImageAssetRepository.js";
import { createFollowSellerDefenseRepository } from "../db/repositories/followSellerDefenseRepository.js";
import { createProductSyncRunRepository } from "../db/repositories/productSyncRunRepository.js";
import { createProductImageUploadCoordinator } from "../domain/productImages/productImageUploadCoordinator.js";
import { createProductImageLifecycleScheduler } from "../domain/productImages/productImageLifecycleScheduler.js";
import { createShopRepository } from "../db/repositories/shopRepository.js";
import { createShopLifecycleRepository } from "../db/repositories/shopLifecycleRepository.js";
import { createShopIdentityLifecycleService } from "../domain/shops/shopIdentityLifecycleService.js";
import { createShopDatabaseRouter } from "../db/shopDatabaseRouter.js";
import {
  createDefaultShopBootstrapTaskDriver,
  createShopBootstrapCoordinator,
} from "../domain/shops/shopBootstrapCoordinator.js";
import { createCrossBorderAccountService } from "../domain/logistics/crossBorderAccountService.js";
import { createCrossBorderOrderService } from "../domain/logistics/crossBorderOrderService.js";
import { createCrossBorderReadService } from "../domain/logistics/crossBorderReadService.js";
import { createCrossBorderChargeService } from "../domain/logistics/crossBorderChargeService.js";
import {
  createCrossBorderConfirmedWriteExecutor,
  createCrossBorderWriteGuardService,
} from "../domain/logistics/crossBorderWriteGuardService.js";
import { createPurchaseService } from "../domain/purchase/purchaseService.js";
import { createExchangeRateService } from "../domain/exchange/exchangeRateService.js";
import { createDomainServiceRegistry } from "../domain/domainRegistry.js";
import { createCustomerChatFileRoutes } from "../domain/customerService/customerChatFileRoutes.js";
import { createCustomerServiceRealtimeHub } from "../domain/customerService/customerServiceRealtimeHub.js";
import { createCustomerServiceRealtimeRoutes } from "../domain/customerService/customerServiceRealtimeRoutes.js";
import { createLocalSmartReplyRuntime } from "../domain/smartReply/localSmartReplyRuntime.js";
import {
  clearPerformanceAccountRuntime,
  getPerformanceAccountRemovalStatus,
  quiescePerformanceAccount,
  releasePerformanceAccountFence,
} from "../integrations/performanceApiClient.js";
import { createSeerfarCategoryTreeService } from "../integrations/seerfarCategoryTreeService.js";
import { createOzonClient } from "../ozon/ozonClient.js";
import {
  findOzonEndpointByPath,
  getOzonEndpoint,
} from "../ozon/ozonEndpointRegistry.js";
import { createOzonScheduler } from "../ozon/ozonScheduler.js";
import { createSyncSnapshotService } from "../sync/syncSnapshotService.js";
import {
  createOzonPushNotificationService,
  OZON_PUSH_SIGNATURE_HEADER,
  OZON_PUSH_SINK_PATH,
} from "../domain/notifications/ozonPushNotificationService.js";
import { createOzonPushDomainRefreshCoordinator } from "../domain/notifications/ozonPushDomainRefreshCoordinator.js";
import { createOzonPushRealtimeHub } from "../domain/notifications/ozonPushRealtimeHub.js";
import { createOzonPushRealtimeRoutes } from "../domain/notifications/ozonPushRealtimeRoutes.js";
import { createHealthPayload } from "../routes/health.js";
import { createStorageAuditService } from "../maintenance/storageAuditService.js";
import { createDatabaseCompactionService } from "../maintenance/databaseCompactionService.js";
import { createMaintenanceStatusService } from "../maintenance/maintenanceStatusService.js";
import { createDataConsistencyAuditService } from "../maintenance/dataConsistencyAuditService.js";
import { createShopScopeRepairPreviewService } from "../maintenance/shopScopeRepairPreview.js";
import { createTechnicalRetentionPreviewService } from "../maintenance/technicalRetentionPreview.js";
import { createTechnicalRetentionRunner } from "../maintenance/technicalRetentionRunner.js";
import { createAutomaticMaintenanceScheduler } from "../maintenance/automaticMaintenanceScheduler.js";
import { createTechnicalArchiveService } from "../maintenance/technicalArchiveService.js";
import { createProfileMaintenanceCommandService } from "../maintenance/profileMaintenanceCommandService.js";
import { createProfileMaintenanceTrustedRebuildSourceAdapters } from "../maintenance/profileMaintenanceTrustedRebuildSourceAdapters.js";
import { createContinuousSyncService } from "../sync/continuousSyncService.js";
import { createRecoveryBackupPlanner } from "../backup/recoveryBackupPlanner.js";
import { createRecoveryStorageAdapter } from "../backup/recoveryStorageAdapter.js";
import { createRecoveryBackupOrchestrator } from "../backup/recoveryBackupOrchestrator.js";
import { createRecoveryKeysetStore } from "../backup/recoveryKeysetStore.js";
import { createRecoveryStagingService } from "../backup/recoveryStagingService.js";
import { createRecoveryReconcileState } from "../backup/recoveryReconcileState.js";
import { createDataBackupService } from "../backup/dataBackupService.js";
import { createDataBackupImportService } from "../backup/dataBackupImportService.js";
import { createHistoricalProductImportService } from "../backup/historicalProductImportService.js";
import { createHistoricalOrderImportService } from "../backup/historicalOrderImportService.js";
import { decryptSecret, encryptSecret } from "../security/secretCrypto.js";
import { handleTestSplitSimulationRoute } from "../routes/testSplitSimulation.js";
import {
  createCorsHeaders,
  createJsonResponse,
  createTextResponse,
  readJsonRequestBody,
} from "../utils/http.js";
import { createWriteGuardService } from "../security/writeGuardService.js";
import {
  localApiRequestIsAuthorized,
  localApiUnauthorizedPayload,
} from "../security/localApiAccess.js";
import { LEGACY_BULK_IMPORT_MAX_BODY_BYTES } from "./legacyBulkImportLimits.js";
import { createAccountRemovalPlanner } from "../domain/accountRemoval/accountRemovalPlanner.js";
import { createAccountRemovalRuntimeCoordinator } from "../domain/accountRemoval/accountRemovalRuntimeCoordinator.js";
import { createAccountRemovalSqliteExecutor } from "../domain/accountRemoval/accountRemovalSqliteExecutor.js";
import { createAccountRemovalProductImageCleanup } from "../domain/accountRemoval/accountRemovalProductImageCleanup.js";
import { createAccountRemovalVerifier } from "../domain/accountRemoval/accountRemovalVerifier.js";
import { createAccountRemovalOrchestrator } from "../domain/accountRemoval/accountRemovalOrchestrator.js";
import { createAccountRemovalRoute } from "./accountRemovalRoute.js";
import { createProtectedComputeRoute } from "./protectedComputeRoute.js";
import { createProfileMaintenanceRoute } from "./profileMaintenanceRoute.js";
import { createShopIdentityLifecycleRoute } from "./shopIdentityLifecycleRoute.js";
import { createPurchaseBrowserTaskService } from "../domain/purchaseBrowser/purchaseBrowserTaskService.js";
import { createPurchaseBrowserCaptureService } from "../domain/purchaseBrowser/purchaseBrowserCaptureService.js";
import {
  createBadJsonPayload,
  createQueryObject,
  createPerformanceCredentialResolver,
  createPerformanceAccountsPayload,
  normalizeText,
  normalizeOzonRequestMethod,
  getLegacyOzonShopInput,
  getLegacyOzonPayload,
  createRealWritePolicy,
} from "./createAppRouteHelpers.js";
import { createAppMaintenanceRoute } from "./appMaintenanceRoute.js";
import { createPurchaseBrowserRoute } from "./purchaseBrowserRoute.js";
import { createIntegrationAccountRoute } from "./integrationAccountRoute.js";
import { createSourceLinkRoute } from "./sourceLinkRoute.js";
import { createCrossBorderLogisticsRoute } from "./crossBorderLogisticsRoute.js";
import { createOzonOperationsRoute } from "./ozonOperationsRoute.js";
import { createCacheSyncRoute } from "./cacheSyncRoute.js";
import { createCustomerServiceRoute } from "./customerServiceRoute.js";
import { createCatalogCacheRoute } from "./catalogCacheRoute.js";
import { createShopRoute } from "./shopRoute.js";
import { createExchangeRateRoute } from "./exchangeRateRoute.js";

























function constantTimeTokenMatches(expectedValue, actualValue) {
  if (!expectedValue || !actualValue) return false;
  const expected = createHash("sha256").update(String(expectedValue)).digest();
  const actual = createHash("sha256").update(String(actualValue)).digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}





// This bounds one renderer-to-local-api legacy JSON request only. It is not a
// SQLite cache, recovery-generation, or per-shop storage quota; oversized old
// files remain untouched rather than being partially migrated.
const MARKETING_LEGACY_IMPORT_MAX_BYTES = 8 * 1024 * 1024;
const PROFIT_LEDGER_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;











/**
 * The old browser cache was a map keyed by a UI scope that could be either a
 * shop id or an older client-id-shaped key.  Never infer that scope on the API
 * boundary: a batch import must provide an explicit shop mapping.
 */










function isSchedulerSuccess(result) {
  return Boolean(
    result?.ok &&
    !["failed", "blocked", "canceled", "rate_limited", "circuit_open"].includes(
      result?.status,
    ),
  );
}









function resolveLegacyOzonEndpoint(body = {}) {
  const endpointKey = normalizeText(body.endpointKey || body.endpoint_key);
  if (endpointKey) {
    const endpoint = getOzonEndpoint(endpointKey);
    return { endpoint, endpointKey: endpoint.key };
  }

  const endpointPath = normalizeText(body.endpoint || body.path || body.url);
  const access = normalizeText(body.access || body.risk).toLowerCase();
  const risk =
    access === "write" ? "write" : access === "read" ? "read" : undefined;
  const endpoint = findOzonEndpointByPath(endpointPath, {
    method: normalizeOzonRequestMethod(body.method),
    risk,
  });
  if (!endpoint) {
    const error = new Error(
      `Ozon endpoint 尚未在 local-api 注册：${endpointPath || endpointKey || "unknown"}`,
    );
    error.code = "OZON_ENDPOINT_NOT_REGISTERED";
    error.endpoint = endpointPath || endpointKey || "";
    throw error;
  }
  return { endpoint, endpointKey: endpoint.key };
}



function ensureLegacyOzonShopSaved(shopRepository, body = {}) {
  const shopInput = getLegacyOzonShopInput(body);
  if (!shopInput.id) {
    const error = new Error("Ozon 请求缺少 shopId。");
    error.code = "OZON_SHOP_ID_REQUIRED";
    throw error;
  }
  if (shopInput.clientId && shopInput.apiKey) {
    shopRepository.saveShop(shopInput);
  }
  return shopInput.id;
}







async function executeLegacyOzonRequest({
  body = {},
  shopRepository,
  ozonScheduler,
}) {
  const { endpoint, endpointKey } = resolveLegacyOzonEndpoint(body);
  const requestedAccess = normalizeText(body.access).toLowerCase();
  if (requestedAccess === "write" && endpoint.risk !== "write") {
    const error = new Error(
      `Ozon endpoint ${endpoint.path} 是读取接口，不能走写入通道。`,
    );
    error.code = "OZON_ENDPOINT_ACCESS_MISMATCH";
    throw error;
  }
  if (requestedAccess === "read" && endpoint.risk !== "read") {
    const error = new Error(
      `Ozon endpoint ${endpoint.path} 是写入接口，不能走读取通道。`,
    );
    error.code = "OZON_ENDPOINT_ACCESS_MISMATCH";
    throw error;
  }
  if (endpoint.risk === "write") {
    const error = new Error(
      "旧 /api/ozon/request 写入口已禁止执行 Ozon 写入；请改走 /api/write/:domain/preview -> /api/write/:domain/confirm 安全门。",
    );
    error.code = "LEGACY_OZON_WRITE_FORBIDDEN";
    error.endpoint = endpoint.path;
    throw error;
  }

  const shopId = body.postingNumbers !== undefined
    ? getLegacyOzonShopInput(body).id
    : ensureLegacyOzonShopSaved(shopRepository, body);
  const params = getLegacyOzonPayload(body);
  const requestedBy =
    normalizeText(body.requestedBy || body.requested_by) ||
    "legacy-ozon-request";
  if (body.postingNumbers !== undefined) {
    if (endpointKey !== "finance.transactionList" || requestedAccess !== "read") {
      const error = new Error("批量单号仅用于财务只读核验。");
      error.code = "FINANCE_POSTING_BATCH_INVALID";
      throw error;
    }
    const data = await readFinancePostingBatch({ shopId, postingNumbers: body.postingNumbers, scheduler: ozonScheduler, requestedBy });
    return { ok: true, access: "read", endpointKey, endpoint: endpoint.path, data };
  }
  const idempotencyKey = normalizeText(
    body.idempotencyKey || body.idempotency_key,
  );

  const result = await ozonScheduler.executeReadOnly({
    shopId,
    domain: endpoint.domain,
    endpointKey,
    action: normalizeText(body.action) || `legacy-read:${endpointKey}`,
    params,
    requestedBy,
    idempotencyKey:
      idempotencyKey || `legacy-read:${shopId}:${endpointKey}:${Date.now()}`,
    forceRefresh: body.forceRefresh !== false,
    allowStale: body.allowStale === true,
    waitForResult: true,
  });

  return {
    ok: result?.ok === true,
    access: "read",
    endpointKey,
    endpoint: endpoint.path,
    data: result?.data ?? null,
    schedulerResult: result,
  };
}

async function runShopConnectionCheck({ shop, ozonScheduler }) {
  const common = {
    shopId: shop.id,
    domain: "shop",
    action: "test-connection",
    priority: "P0",
    requestedBy: "shop-settings-connection-test",
    allowStale: false,
    forceRefresh: true,
    dedupeTtlMs: 5_000,
    lockTtlMs: 45_000,
  };

  const rolesResult = await ozonScheduler.executeReadOnly({
    ...common,
    endpointKey: "shop.roles",
    params: {},
    cacheKey: `shop:test:${shop.id}:roles`,
    idempotencyKey: `shop-test:${shop.id}:roles:${Math.floor(Date.now() / 5_000)}`,
  });
  if (!isSchedulerSuccess(rolesResult)) {
    return { ok: false, step: "roles", result: rolesResult };
  }

  const sellerInfoResult = await ozonScheduler.executeReadOnly({
    ...common,
    endpointKey: "shop.sellerInfo",
    params: {},
    cacheKey: `shop:test:${shop.id}:seller-info`,
    idempotencyKey: `shop-test:${shop.id}:seller-info:${Math.floor(Date.now() / 5_000)}`,
  });
  if (!isSchedulerSuccess(sellerInfoResult)) {
    return { ok: false, step: "seller/info", result: sellerInfoResult };
  }

  return {
    ok: true,
    roles: rolesResult.data || null,
    sellerInfo: sellerInfoResult.data || null,
    jobs: [rolesResult, sellerInfoResult],
  };
}

const OZON_SELLER_IDENTITY_KEYS = new Set([
  "seller_id",
  "sellerId",
  "company_id",
  "companyId",
  "client_id",
  "clientId",
]);

function collectOzonSellerIdentityIds(value, output = new Set(), depth = 0) {
  if (depth > 6 || value == null) return output;
  if (Array.isArray(value)) {
    value.forEach((entry) =>
      collectOzonSellerIdentityIds(entry, output, depth + 1),
    );
    return output;
  }
  if (typeof value !== "object") return output;
  Object.entries(value).forEach(([key, entry]) => {
    if (OZON_SELLER_IDENTITY_KEYS.has(key)) {
      const candidate = normalizeText(entry);
      if (candidate && /^[A-Za-z0-9_-]{2,200}$/u.test(candidate))
        output.add(candidate);
    }
    if (entry && typeof entry === "object") {
      collectOzonSellerIdentityIds(entry, output, depth + 1);
    }
  });
  return output;
}

function getVerifiedOzonSellerIdentityIds(shop, connectionResult) {
  const identities = new Set();
  const configuredClientId = normalizeText(shop?.clientId);
  // A successful roles + seller/info read proves that this exact Client ID and
  // encrypted API key pair belongs to the selected shop. Keep it first so the
  // browser company id can be compared to the stable API-side identity.
  if (configuredClientId) identities.add(configuredClientId);
  [
    connectionResult?.sellerInfo?.id,
    connectionResult?.sellerInfo?.result?.id,
    connectionResult?.sellerInfo?.company?.id,
    connectionResult?.sellerInfo?.result?.company?.id,
    connectionResult?.sellerInfo?.seller?.id,
    connectionResult?.sellerInfo?.result?.seller?.id,
  ]
    .map(normalizeText)
    .filter(Boolean)
    .forEach((identity) => identities.add(identity));
  collectOzonSellerIdentityIds(connectionResult?.sellerInfo, identities);
  collectOzonSellerIdentityIds(connectionResult?.roles, identities);
  return [...identities];
}

export function createApp({
  db,
  config,
  getDatabaseStatus,
  listAppliedMigrations,
  startedAt,
  migrationsApplied = [],
  ozonClient = createOzonClient({ retry: { maxAttempts: 1 } }),
  ozonScheduler: providedOzonScheduler,
  continuousSyncService: providedContinuousSyncService,
  crossBorderClient = createCrossBorderClient(),
  catalogSyncBackgroundRunner,
  sharedCatalogBootstrap = {},
  protectedComputeRuntime = null,
  technicalRetentionRunner: providedTechnicalRetentionRunner,
  profileMaintenanceCommandService: providedProfileMaintenanceCommandService,
  requestShutdown = () => undefined,
  recoveryFetchImpl = fetch,
  accountRemovalProtectionService: providedAccountRemovalProtectionService,
  shopBootstrapTaskDriver: providedShopBootstrapTaskDriver,
  shopBootstrapCoordinator: providedShopBootstrapCoordinator,
  shopBootstrapPollIntervalMs,
  modelApiDiscoveryService: providedModelApiDiscoveryService,
  productImageObjectStorage = null,
  productImageRequestContextResolver = null,
  shopLicenseGrantRegistry = null,
  crossBorderChargeService: providedCrossBorderChargeService,
  externalIntegrationFetchImpl = fetch,
  deferContinuousSync = process.env.LOCAL_API_DEFER_CONTINUOUS_SYNC === "1",
  continuousSyncStartDelayMs = process.env
    .LOCAL_API_CONTINUOUS_SYNC_START_DELAY_MS,
  automaticMaintenanceEnabled = false,
  automaticMaintenanceOptions = {},
  customerServiceRealtimeHub: providedCustomerServiceRealtimeHub,
  ozonPushRealtimeHub: providedOzonPushRealtimeHub,
  shopDatabaseManager = null,
  shopAggregateIndex = null,
  shopDatabaseLifecycle = null,
}) {
  const shopRepository = createShopRepository(db, {
    profileId: config?.runtime?.profileId,
    tenantId: config?.runtime?.tenantId || config?.runtime?.appId,
    userId: config?.runtime?.userId || config?.runtime?.profileId,
  });
  const shopDatabaseRouter = shopDatabaseManager?.ensure
    ? createShopDatabaseRouter({ shopRepository, shopDatabaseManager })
    : null;
  const localSmartReplyRuntime = createLocalSmartReplyRuntime({
    db,
    shopRepository,
    fallbackScopeId: `local-${shopRepository.profileId || "profile"}`,
  });
  const shopLifecycleRepository = createShopLifecycleRepository(db, {
    profileId: shopRepository.profileId,
    identityRepository: shopRepository.identityRepository,
  });
  let domainServices = null;
  const shopIdentityLifecycleService = createShopIdentityLifecycleService({
    shopRepository,
    lifecycleRepository: shopLifecycleRepository,
    shopDatabaseManager,
    shopDatabaseLifecycle,
    onNewShopDatabaseProvisioned({ scopeToken }) {
      domainServices?.initializeNewShopOrderStorage?.(scopeToken.shopId, scopeToken);
      domainServices?.initializeNewShopProductStorage?.(scopeToken.shopId, scopeToken);
      domainServices?.initializeNewShopOperationalStorage?.(scopeToken.shopId, scopeToken);
    },
  });
  const seerfarCategoryTreeService = createSeerfarCategoryTreeService({
    fetchImpl: externalIntegrationFetchImpl,
  });
  const storageAuditService = createStorageAuditService(db);
  const dataConsistencyAuditService = createDataConsistencyAuditService(db);
  const databaseCompactionService = createDatabaseCompactionService(db, {
    databasePath: config?.database?.path || null,
  });
  const shopScopeRepairPreviewService = createShopScopeRepairPreviewService(db);
  const technicalRetentionPreviewService =
    createTechnicalRetentionPreviewService(db);
  const technicalArchiveDatabasePath = String(
    config?.database?.path || "",
  ).trim();
  const technicalArchiveEnabled = Boolean(
    technicalArchiveDatabasePath && technicalArchiveDatabasePath !== ":memory:",
  );
  const technicalArchiveService = createTechnicalArchiveService({
    db,
    enabled: technicalArchiveEnabled,
    archiveDirectory: technicalArchiveEnabled
      ? path.join(
          path.dirname(technicalArchiveDatabasePath),
          "technical-archives",
        )
      : null,
  });
  const maintenanceStatusService = createMaintenanceStatusService({
    storageAuditService,
    shopScopeRepairPreviewService,
    technicalRetentionPreviewService,
    databaseCompactionService,
  });
  const technicalRetentionRunner =
    providedTechnicalRetentionRunner ||
    createTechnicalRetentionRunner({
      service: technicalRetentionPreviewService,
    });
  const productSyncStageCompactor = createProductSyncRunRepository(db);
  const automaticMaintenanceScheduler = createAutomaticMaintenanceScheduler({
    db,
    databasePath: config?.database?.path || null,
    retentionService: technicalRetentionPreviewService,
    retentionRunner: technicalRetentionRunner,
    archiveService: technicalArchiveService,
    stageCompactor: productSyncStageCompactor,
    enabled: automaticMaintenanceEnabled === true,
    ...(automaticMaintenanceOptions || {}),
  });
  const profileMaintenanceCommandService =
    providedProfileMaintenanceCommandService ||
    createProfileMaintenanceCommandService({
      db,
      resolveShopDomainDatabase: (input) => domainServices.resolveShopDomainDatabase(input),
      trustedRebuildSourceAdapters:
        createProfileMaintenanceTrustedRebuildSourceAdapters({ db }),
    });
  const recoveryStorageAdapter = createRecoveryStorageAdapter({
    db,
    resolveShopDomainDatabase: (input) => domainServices.resolveShopDomainDatabase(input),
  });
  const recoveryBackupPlanner = createRecoveryBackupPlanner({ db, storageAdapter: recoveryStorageAdapter });
  const recoveryKeysetStore = createRecoveryKeysetStore({ db });
  const dataBackupStagingDirectory = path.join(
    path.dirname(String(config?.database?.path || ".")),
    "data-backup-staging",
  );
  const dataBackupService = createDataBackupService({
    db,
    storageAdapter: recoveryStorageAdapter,
    keysetStore: recoveryKeysetStore,
    decryptShopSecret: decryptSecret,
    stagingDirectory: dataBackupStagingDirectory,
  });
  const dataBackupImportService = createDataBackupImportService({
    db,
    storageAdapter: recoveryStorageAdapter,
    dataBackupService,
    profileId: shopRepository.profileId,
    encryptShopSecret: encryptSecret,
    decryptShopSecret: decryptSecret,
    stagingDirectory: dataBackupStagingDirectory,
    invalidateProductCache: (shopId) => {
      domainServices.invalidateOwnerHotCache(shopId);
    },
  });
  const hasPendingAccountRemoval = () =>
    Boolean(
      db
        .prepare(
          `
    SELECT 1
    FROM account_removal_operations
    WHERE completed_at IS NULL
    LIMIT 1
  `,
        )
        .get(),
    );
  const recoveryBackupOrchestrator = createRecoveryBackupOrchestrator({
    db,
    storageAdapter: recoveryStorageAdapter,
    keysetStore: recoveryKeysetStore,
    decryptShopSecret: decryptSecret,
    hasPendingAccountRemoval,
  });
  const databaseList = db.prepare("PRAGMA database_list;").all();
  const recoveryActiveDatabasePath = String(
    config?.database?.path ||
      databaseList.find((entry) => String(entry.name || "") === "main")?.file ||
      "",
  ).trim();
  let recoveryStagingService = null;
  let inMemoryRecoveryStagingFenced = false;
  const getRecoveryStagingService = () => {
    if (!recoveryActiveDatabasePath)
      throw new Error("RECOVERY_STAGING_DATABASE_PATH_REQUIRED");
    recoveryStagingService ||= createRecoveryStagingService({
      config: {
        ...config,
        database: { ...config?.database, path: recoveryActiveDatabasePath },
      },
      hasPendingAccountRemoval,
    });
    return recoveryStagingService;
  };
  const recoveryStagingRuntime = {
    getAccountRemovalStatus() {
      return (
        recoveryStagingService?.getAccountRemovalStatus?.() || {
          fenced: inMemoryRecoveryStagingFenced || hasPendingAccountRemoval(),
          active: 0,
        }
      );
    },
    async quiesceAccountRemoval(owner, options) {
      if (recoveryActiveDatabasePath)
        return getRecoveryStagingService().quiesceAccountRemoval(
          owner,
          options,
        );
      inMemoryRecoveryStagingFenced = true;
      return { ok: true, fenced: true, active: 0 };
    },
    releaseAccountRemovalFence() {
      if (recoveryStagingService)
        return recoveryStagingService.releaseAccountRemovalFence();
      const released = inMemoryRecoveryStagingFenced;
      inMemoryRecoveryStagingFenced = false;
      return {
        ok: true,
        released,
        ...recoveryStagingRuntime.getAccountRemovalStatus(),
      };
    },
  };
  const performanceAccountRepository = createPerformanceAccountRepository(db);
  const purchaseAccountRepository = createPurchaseAccountRepository(db);
  const purchaseBrowserTaskService = createPurchaseBrowserTaskService(db);
  const purchaseBrowserCaptureService = createPurchaseBrowserCaptureService(db);
  const integrationProfileRepository = createIntegrationProfileRepository(db);
  const integrationCredentialRepository =
    createIntegrationCredentialRepository(db);
  const modelApiAccountRepository = createModelApiAccountRepository(db);
  const paidCapabilityAccess = createPaidCapabilityAccess({
    runtime: protectedComputeRuntime,
  });
  const modelApiDiscoveryService =
    providedModelApiDiscoveryService || createModelApiDiscoveryService();
  const profileSettingsRepository = createProfileSettingsRepository(db);
  const profileAssetRepository = createProfileAssetRepository(db);
  const productImageAssetRepository = createProductImageAssetRepository(db, {
    tenantId: shopRepository.tenantId,
    userId: shopRepository.userId,
  });
  const productImageUploadCoordinator = createProductImageUploadCoordinator({
    repository: productImageAssetRepository,
    config: config?.imageAssets?.upload || {},
  });
  const productImageAssetService = createProductImageAssetService({
    profileAssetRepository,
    productImageAssetRepository,
    modelApiAccountRepository,
    objectStorage: productImageObjectStorage,
    uploadCoordinator: productImageUploadCoordinator,
    config,
    paidCapabilityAccess,
  });
  const productImageLifecycleScheduler = createProductImageLifecycleScheduler({
    service: productImageAssetService,
    config: config?.imageAssets?.lifecycle || {},
  });
  productImageAssetService.setLifecycleStatusProvider(() =>
    productImageLifecycleScheduler.getStatus(),
  );
  const resolveProductImageRequestContext = async ({
    req,
    requestUrl,
    body,
  }) => {
    if (typeof productImageRequestContextResolver === "function") {
      return productImageRequestContextResolver({
        req,
        requestUrl,
        body,
        shopRepository,
      });
    }
    const requestedShopId = String(
      body?.shopId ||
        body?.shop_id ||
        requestUrl?.searchParams?.get("shopId") ||
        requestUrl?.searchParams?.get("shop_id") ||
        req?.headers?.["x-wangzai-shop-id"] ||
        req?.headers?.["x-shop-id"] ||
        "",
    ).trim();
    const context = {
      tenantId: shopRepository.tenantId,
      userId: shopRepository.userId,
      shopId: requestedShopId || "shop-unbound",
      ...paidCapabilityContextFromRequest(req),
    };
    if (requestedShopId && requestedShopId !== "shop-unbound") {
      const allowed = shopRepository
        .listShopsForContext(context)
        .some((shop) => shop.id === requestedShopId);
      if (!allowed) {
        const error = new Error("当前用户无权访问该店铺。");
        error.code = "PRODUCT_IMAGE_SCOPE_FORBIDDEN";
        error.statusCode = 403;
        throw error;
      }
    }
    return context;
  };
  const productImageAssetRoutes = createProductImageAssetRoutes({
    service: productImageAssetService,
    resolveRequestContext: resolveProductImageRequestContext,
  });
  const imageProvenanceConfig = {
    enabled: false,
    mode: "upload-enforced",
    evidenceRoot: path.resolve(
      config?.root || process.cwd(),
      ".runtime",
      "image-provenance",
    ),
    ...(config?.imageProvenance || {}),
  };
  const imageProvenanceRepository = createImageProvenanceFileRepository({
    root: imageProvenanceConfig.evidenceRoot,
  });
  const imageProvenanceService = createImageProvenanceService({
    repository: imageProvenanceRepository,
    productImageAssetService,
    config: imageProvenanceConfig,
  });
  productImageAssetService.setProvenanceProtector((input, context) =>
    imageProvenanceService.protectAsset(input, context),
  );
  const imageProvenanceRoutes = createImageProvenanceRoutes({
    service: imageProvenanceService,
    resolveRequestContext: resolveProductImageRequestContext,
  });
  const productDescriptionService = createProductDescriptionService({
    modelApiAccountRepository,
    paidCapabilityAccess,
  });
  const productDescriptionRoutes = createProductDescriptionRoutes({
    service: productDescriptionService,
  });
  const imagePromptPlanService = createImagePromptPlanService({
    modelApiAccountRepository,
    profileAssetRepository,
    readLocalImageAsset: (assetId, context) => productImageAssetService.readLocalAsset(assetId, context),
    paidCapabilityAccess,
  });
  const imagePromptPlanRoutes = createImagePromptPlanRoutes({
    service: imagePromptPlanService,
    resolveRequestContext: resolveProductImageRequestContext,
  });
  const performanceCredentialResolver = createPerformanceCredentialResolver(
    performanceAccountRepository,
  );
  const crossBorderAccountService = createCrossBorderAccountService({
    db,
    crossBorderClient,
    profileId: shopRepository.profileId,
    tenantId: shopRepository.tenantId,
    userId: shopRepository.userId,
  });
  const crossBorderOrderService = createCrossBorderOrderService({ db });
  const crossBorderReadService = createCrossBorderReadService({
    db,
    crossBorderClient,
    profileId: shopRepository.profileId,
    tenantId: shopRepository.tenantId,
    userId: shopRepository.userId,
  });
  const crossBorderChargeService =
    providedCrossBorderChargeService ||
    createCrossBorderChargeService({
      db,
      shopRepository,
      crossBorderAccountService,
      profileSettingsRepository,
      profileId: shopRepository.profileId,
    });
  const purchaseService = createPurchaseService({ db });
  const salesSourceLinkRepository = createSalesSourceLinkRepository(db);
  const exchangeRateCacheRepository = createExchangeRateCacheRepository(db);
  const exchangeRateService = createExchangeRateService();
  const syncSnapshotService = createSyncSnapshotService(db);
  const ozonScheduler =
    providedOzonScheduler ||
    createOzonScheduler({
      db,
      shopRepository,
      ozonClient,
      technicalArchiveService,
      allowRealWrite: config?.ozon?.enableRealWrite === true,
    });
  domainServices = createDomainServiceRegistry({
    db,
    ozonScheduler,
    ozonClient,
    shopRepository,
    shopDatabaseManager,
    shopDatabaseRouter,
    shopAggregateIndex,
    orderReadCanaryShopIds: config?.storage?.orderReadCanaryShopIds || [],
    orderReadAllReadyShops: config?.storage?.orderReadAllReadyShops === true,
    orderDirectWriteAllShops: config?.storage?.orderDirectWriteAllShops === true,
    operationalDirectWriteAllShops: config?.storage?.operationalDirectWriteAllShops === true,
    profitLedgerDirectShopIds: config?.storage?.profitLedgerDirectShopIds || [],
    productReadCanaryShopIds: config?.storage?.productReadCanaryShopIds || [],
    productDirectWriteShopIds: config?.storage?.productDirectWriteShopIds || [],
    productDirectWriteAllShops: config?.storage?.productDirectWriteAllShops === true,
    productImageAssetRepository,
    refreshProductImagePayloadUrls:
      productImageAssetService.refreshProductWritePayloadUrls,
  });
  const customerServiceRealtimeHub =
    providedCustomerServiceRealtimeHub || createCustomerServiceRealtimeHub();
  const ozonPushRealtimeHub =
    providedOzonPushRealtimeHub || createOzonPushRealtimeHub();
  const ozonPushDomainRefreshCoordinator = createOzonPushDomainRefreshCoordinator({
    ...(config?.sync?.ozonPushDomainRefresh || config?.sync?.ozonPushOrderSync || {}),
    refreshOrders: (input) =>
      domainServices.get("orders")?.refreshOrdersByPostingNumbers?.(input),
    refreshProducts: (input) =>
      domainServices.get("products")?.refreshProductsByRefs?.(input),
    refreshCustomerService: async ({
      shopId,
      chatIds = [],
      includeChatList = false,
      priority,
      requestedBy,
      requestCycle,
    } = {}) => {
      const customerService = domainServices.get("customerService");
      const failedChatIds = new Set();
      for (const chatId of chatIds) {
        const result = await customerService?.probeRead?.({
          shopId,
          endpointKey: "chat.history",
          chatId,
          limit: 50,
          params: {
            chat_id: chatId,
            limit: 50,
            direction: "Backward",
          },
          priority,
          requestedBy,
          idempotencyKey: `ozon-push-chat-history:${shopId}:${chatId}:${requestCycle}`,
          forceRefresh: true,
          allowStale: false,
        });
        if (!result?.ok) failedChatIds.add(chatId);
      }
      if (includeChatList || chatIds.length > 0) {
        const result = await customerService?.probeRead?.({
          shopId,
          endpointKey: "chat.list",
          limit: 100,
          params: { limit: 100, offset: 0 },
          priority,
          requestedBy,
          idempotencyKey: `ozon-push-chat-list:${shopId}:${requestCycle}`,
          forceRefresh: true,
          allowStale: false,
        });
        if (!result?.ok) {
          (chatIds.length ? chatIds : ["__chat_list__"]).forEach((chatId) => failedChatIds.add(chatId));
        }
      }
      return { ok: failedChatIds.size === 0, failedChatIds: [...failedChatIds] };
    },
    invalidateDomainHotCache: (domain, shopId) =>
      domainServices.get(domain)?.invalidateOwnerHotCache?.(shopId),
    onDomainRefreshed: ({ domain, shopId, entries }) => {
      ozonPushRealtimeHub.publish({
        shopId,
        stage: "refreshed",
        domain,
        remoteIds: entries.flatMap((entry) => [...(entry.remoteIds || [])]),
        eventTypes: entries.map((entry) => entry.messageType),
        messageTypes: entries.map((entry) => entry.messageType),
        postingNumbers: entries.map((entry) => entry.postingNumber),
        productRefs: entries.flatMap((entry) => entry.refs || []),
        chatIds: entries.map((entry) => entry.chatId),
      });
      if (domain === "customerService") {
        customerServiceRealtimeHub.publish({
          shopId,
          chatIds: entries.map((entry) => entry.chatId).filter(Boolean),
          messageTypes: entries.map((entry) => entry.messageType).filter(Boolean),
        });
      }
    },
  });
  const ozonPushNotificationService = createOzonPushNotificationService({
    db,
    shopRepository,
    notificationService: syncSnapshotService,
    secret: config?.security?.ozonPushSinkSecret,
    onAcceptedEvent: ({ remoteId, normalized }) => {
      ozonPushRealtimeHub.publish({
        shopId: normalized.shopId,
        stage: "accepted",
        domain: normalized.domain,
        remoteIds: [remoteId],
        eventTypes: [normalized.eventType],
        messageTypes: [normalized.newValue?.messageType],
        postingNumbers: [normalized.postingNumber],
        productRefs: normalized.productRefs,
        chatIds: [normalized.chatId],
      });
      void localSmartReplyRuntime.acceptNotificationsForActiveScopes([{
        id: remoteId,
        shopId: normalized.shopId,
        postingNumber: normalized.postingNumber,
        eventType: normalized.newValue?.messageType,
        createdAt: new Date().toISOString(),
      }]).catch((error) => {
        console.error("[local-api][smart-reply] notification hint failed", error);
      });
      return ozonPushDomainRefreshCoordinator.enqueue({
        remoteId,
        shopId: normalized.shopId,
        postingNumber: normalized.postingNumber,
        productId: normalized.productId,
        offerId: normalized.offerId,
        sku: normalized.newValue?.sku,
        productRefs: normalized.productRefs,
        chatId: normalized.chatId,
        messageType: normalized.newValue?.messageType,
      });
    },
  });
  const customerChatFileRoutes = createCustomerChatFileRoutes({
    service: domainServices.get("customerService"),
  });
  const customerServiceRealtimeRoutes = createCustomerServiceRealtimeRoutes({
    hub: customerServiceRealtimeHub,
  });
  const ozonPushRealtimeRoutes = createOzonPushRealtimeRoutes({
    hub: ozonPushRealtimeHub,
  });
  const dataAnalysisInsightService = createDataAnalysisInsightService({
    dataAnalysisService: domainServices.get("data-analysis"),
    modelApiAccountRepository,
    paidCapabilityAccess,
  });
  const dataAnalysisInsightRoutes = createDataAnalysisInsightRoutes({
    service: dataAnalysisInsightService,
  });
  const externalDataInsightService = createExternalDataInsightService({
    modelApiAccountRepository,
    paidCapabilityAccess,
  });
  const externalDataInsightRoutes = createExternalDataInsightRoutes({
    service: externalDataInsightService,
  });
  const skillInstallSourceService = createSkillInstallSourceService();
  const skillInstallSourceRoutes = createSkillInstallSourceRoutes({
    service: skillInstallSourceService,
  });
  const writeGuardService = createWriteGuardService(db, {
    realWritePolicy: createRealWritePolicy(config),
    executors: {
      products: (context) =>
        domainServices.get("products")?.executeConfirmedWrite?.(context),
      orders: (context) =>
        domainServices.get("orders")?.executeConfirmedWrite?.(context),
      marketing: (context) =>
        domainServices.get("marketing")?.executeConfirmedWrite?.(context),
      logistics: (context) =>
        domainServices.get("logistics")?.executeConfirmedWrite?.(context),
      returns: (context) =>
        domainServices.get("returns")?.executeConfirmedWrite?.(context),
      customerService: (context) =>
        domainServices.get("customerService")?.executeConfirmedWrite?.(context),
      "cross-border": createCrossBorderConfirmedWriteExecutor({
        db,
        crossBorderClient,
        profileId: shopRepository.profileId,
        tenantId: shopRepository.tenantId,
        userId: shopRepository.userId,
      }),
    },
  });
  const crossBorderWriteGuardService = createCrossBorderWriteGuardService({
    writeGuardService,
    writeConnected: Boolean(crossBorderClient?.requestWrite),
  });
  const catalogCacheService = createCatalogCacheService(db, {
    shopRepository,
    ozonClient,
    ozonScheduler,
    backgroundRunner: catalogSyncBackgroundRunner,
  });
  const catalogRoutes = createCatalogRoutes({ service: catalogCacheService });
  const protectedComputeService = createProtectedComputeService({
    client: protectedComputeRuntime?.client || null,
    runtimeStatus:
      typeof protectedComputeRuntime?.getStatus === "function"
        ? () => protectedComputeRuntime.getStatus()
        : protectedComputeRuntime?.status || null,
  });
  const shouldBootstrapSharedCatalog = sharedCatalogBootstrap.enabled === true;
  if (shouldBootstrapSharedCatalog) {
    catalogRoutes.bootstrapProfileCatalog(sharedCatalogBootstrap);
  }
  configureSoftwareCategoryNameService({
    service: catalogCacheService,
    identity: sharedCatalogBootstrap.identity || sharedCatalogBootstrap,
  });
  const recoveryReconcileState = createRecoveryReconcileState({ db });
  const continuousSyncService =
    providedContinuousSyncService ||
    createContinuousSyncService({
      shopRepository,
      domainServices,
      intervalMs: Number(config.sync?.continuousIntervalMs) || 300000,
      recoveryReconcileState,
      getSyncJob: (jobId) => ozonScheduler.getJob(jobId),
    });
  const bootstrapTaskDriver =
    providedShopBootstrapTaskDriver ||
    createDefaultShopBootstrapTaskDriver({
      continuousSyncService,
      catalogCacheService,
      ozonScheduler,
    });
  const shopBootstrap =
    providedShopBootstrapCoordinator ||
    createShopBootstrapCoordinator({
      lifecycleService: shopIdentityLifecycleService,
      lifecycleRepository: shopLifecycleRepository,
      taskDriver: bootstrapTaskDriver,
      pollIntervalMs:
        shopBootstrapPollIntervalMs ?? config.sync?.bootstrapPollIntervalMs,
    });
  const continuousSyncEnabled = config.sync?.continuousEnabled === true;
  const parsedContinuousSyncStartDelayMs = Number.parseInt(
    String(continuousSyncStartDelayMs ?? ""),
    10,
  );
  const deferredContinuousSyncDelayMs = Number.isFinite(
    parsedContinuousSyncStartDelayMs,
  )
    ? Math.min(Math.max(parsedContinuousSyncStartDelayMs, 500), 60_000)
    : 5_000;
  let continuousSyncStartTimer = null;
  let backgroundServicesStarted = false;
  const startBackgroundServices = () => {
    if (!continuousSyncEnabled || backgroundServicesStarted) return;
    backgroundServicesStarted = true;
    continuousSyncService.start();
    shopBootstrap.start?.();
  };
  if (continuousSyncEnabled && !deferContinuousSync) {
    startBackgroundServices();
  }
  const accountRemovalRuntimeCoordinator =
    createAccountRemovalRuntimeCoordinator({
      writeGuardService,
      ozonScheduler,
      catalogCacheService,
      continuousSyncService,
      domainServices,
      recoveryBackupRuntime: recoveryBackupOrchestrator,
      recoveryStagingRuntime,
      performanceRuntime: {
        clearPerformanceAccountRuntime,
        getPerformanceAccountRemovalStatus,
        quiescePerformanceAccount,
        releasePerformanceAccountFence,
      },
      purchaseBrowserRuntime: purchaseBrowserTaskService,
    });
  const accountRemovalOperationRepository =
    createAccountRemovalOperationRepository(db);
  const accountRemovalPlanner = createAccountRemovalPlanner({
    db,
    runtimeCoordinator: accountRemovalRuntimeCoordinator,
    shopStorageLifecycle: shopDatabaseLifecycle,
  });
  const accountRemovalSqliteExecutor = createAccountRemovalSqliteExecutor({
    db,
  });
  const accountRemovalProductImageCleanup =
    createAccountRemovalProductImageCleanup({
      db,
      objectStorage: productImageObjectStorage,
      concurrency: config?.imageAssets?.upload?.maxConcurrent,
      maxAttempts: config?.imageAssets?.upload?.maxAttempts,
    });
  const accountRemovalVerifier = createAccountRemovalVerifier({
    db,
    runtimeCoordinator: accountRemovalRuntimeCoordinator,
    shopStorageLifecycle: shopDatabaseLifecycle,
  });
  const accountRemovalOrchestrator = createAccountRemovalOrchestrator({
    planner: accountRemovalPlanner,
    operationRepository: accountRemovalOperationRepository,
    sqliteExecutor: accountRemovalSqliteExecutor,
    verifier: accountRemovalVerifier,
    runtimeCoordinator: accountRemovalRuntimeCoordinator,
    dataBackupService,
    serverResourceCleanup: accountRemovalProductImageCleanup,
    shopStorageLifecycle: shopDatabaseLifecycle,
  });
  const assertAccountOwnerWritable = (ownerType, ownerId, options = {}) => {
    const normalizedOwnerId = String(ownerId ?? "").trim();
    if (!normalizedOwnerId) return;
    return accountRemovalOrchestrator.assertOwnerWritable(
      { ownerType, ownerId: normalizedOwnerId },
      options,
    );
  };
  const prepareAccountOwnerSave = (ownerType, ownerId, payload = {}) => {
    const normalizedOwnerId = String(ownerId ?? "").trim();
    if (!normalizedOwnerId) return null;
    return accountRemovalOrchestrator.assertOwnerAccountSave(
      { ownerType, ownerId: normalizedOwnerId },
      { allowRebind: payload?.accountRemovalRebind === true },
    );
  };
  const finishAccountOwnerSave = (admission) => {
    if (admission?.rebind)
      accountRemovalOrchestrator.releaseOwnerFence(admission.owner);
  };
  const assertExplicitShopScopedPayloadWritable = (value, seen = new Set()) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((entry) =>
        assertExplicitShopScopedPayloadWritable(entry, seen),
      );
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (key === "shopId" || key === "shop_id") {
        assertAccountOwnerWritable("ozon_shop", entry);
      } else {
        assertExplicitShopScopedPayloadWritable(entry, seen);
      }
    }
  };
  const assertProfileSettingOwnersWritable = (namespace, value) => {
    if (namespace === "ozon-shop-preferences") {
      const source =
        value && typeof value === "object" && !Array.isArray(value)
          ? value
          : {};
      const ownerIds = new Set(
        [
          ...(Array.isArray(source.shops)
            ? source.shops.map((shop) => shop?.id)
            : []),
          ...Object.keys(
            source.defaultWarehouseIds &&
              typeof source.defaultWarehouseIds === "object"
              ? source.defaultWarehouseIds
              : {},
          ),
          source.activeShopId,
        ]
          .map((ownerId) => String(ownerId ?? "").trim())
          .filter(Boolean),
      );
      ownerIds.forEach((ownerId) =>
        assertAccountOwnerWritable("ozon_shop", ownerId),
      );
    }
    if (namespace === "cross-border-preferences") {
      const ownerId = value?.crossBorderAccountId ?? value?.accountId;
      assertAccountOwnerWritable("cross_border_bus", ownerId);
    }
  };
  const readOwnerWritableJsonRequestBody = (req, options) =>
    readJsonRequestBody(req, options).then((body) => {
      assertExplicitShopScopedPayloadWritable(body);
      return body;
    });
  const historicalProductImportService = createHistoricalProductImportService({
    db,
    storageAdapter: recoveryStorageAdapter,
    profileId: config?.runtime?.profileId,
    assertShopWritable: (shopId) =>
      assertAccountOwnerWritable("ozon_shop", shopId),
    invalidateProductCache: (shopId) => {
      domainServices.invalidateOwnerHotCache(shopId);
    },
  });
  const historicalOrderImportService = createHistoricalOrderImportService({
    db,
    storageAdapter: recoveryStorageAdapter,
    profileId: config?.runtime?.profileId,
    assertShopWritable: (shopId) =>
      assertAccountOwnerWritable("ozon_shop", shopId),
    invalidateOrderCache: (shopId) => {
      domainServices.invalidateOwnerHotCache?.(shopId);
    },
    refreshOrdersByPostingNumbers: (input) =>
      domainServices.get("orders")?.refreshOrdersByPostingNumbers?.(input),
  });
  const historicalDimensionSyncService = createHistoricalDimensionSyncService({
    db,
    writeGuardService,
    profileId: config?.runtime?.profileId,
    assertShopWritable: (shopId) =>
      assertAccountOwnerWritable("ozon_shop", shopId),
  });
  const followSellerDefenseRepository = createFollowSellerDefenseRepository(db);
  const followSellerEvidenceBundleService =
    createFollowSellerEvidenceBundleService({
      provenanceRepository: imageProvenanceRepository,
      root: path.resolve(
        config?.root || process.cwd(),
        ".runtime",
        "follow-seller-evidence",
      ),
    });
  const followSellerQuickComplaintService =
    createFollowSellerQuickComplaintService({
      repository: followSellerDefenseRepository,
      root: path.resolve(
        config?.root || process.cwd(),
        ".runtime",
        "follow-seller-evidence",
      ),
    });
  const followSellerDefenseService = createFollowSellerDefenseService({
    repository: followSellerDefenseRepository,
    evidenceBundleService: followSellerEvidenceBundleService,
    quickComplaintService: followSellerQuickComplaintService,
    // 客服投诉必须由独立浏览器提交器接管。未接入时服务 fail-closed，
    // 绝不能退回到修改商品属性的旧方案。
    complaintSubmitter: null,
  });
  const followSellerDefenseRoutes = createFollowSellerDefenseRoutes({
    service: followSellerDefenseService,
    readRequestBody: readOwnerWritableJsonRequestBody,
    resolveRequestContext: resolveProductImageRequestContext,
  });
  const productsRoutes = createProductsRoutes({
    service: domainServices.get("products"),
    writeGuardService,
    historicalDimensionSyncService,
    readRequestBody: readOwnerWritableJsonRequestBody,
    legacyBulkImportMaxBodyBytes: LEGACY_BULK_IMPORT_MAX_BODY_BYTES,
  });
  const handleAccountRemovalRoute = createAccountRemovalRoute({
    orchestrator: accountRemovalOrchestrator,
  });
  const handleProtectedComputeRoute = createProtectedComputeRoute({
    service: protectedComputeService,
  });
  const handleProfileMaintenanceRoute = createProfileMaintenanceRoute({
    service: profileMaintenanceCommandService,
  });
  const handleShopIdentityLifecycleRoute = createShopIdentityLifecycleRoute({
    coordinator: shopBootstrap,
    assertWritable: assertAccountOwnerWritable,
    prepareSave: prepareAccountOwnerSave,
    finishSave: finishAccountOwnerSave,
    enqueueOnBinding: config.sync?.continuousEnabled === true,
  });
  const handleAppMaintenanceRoute = createAppMaintenanceRoute({
    accountRemovalOperationRepository,
    assertAccountOwnerWritable,
    automaticMaintenanceScheduler,
    config,
    continuousSyncService,
    dataBackupImportService,
    dataBackupService,
    dataConsistencyAuditService,
    databaseCompactionService,
    domainServices,
    getDatabaseStatus,
    getRecoveryStagingService,
    historicalOrderImportService,
    historicalProductImportService,
    listAppliedMigrations,
    maintenanceStatusService,
    migrationsApplied,
    providedAccountRemovalProtectionService,
    readOwnerWritableJsonRequestBody,
    recoveryBackupOrchestrator,
    recoveryBackupPlanner,
    recoveryFetchImpl,
    recoveryKeysetStore,
    recoveryReconcileState,
    shopScopeRepairPreviewService,
    startedAt,
    storageAuditService,
    technicalArchiveService,
    technicalRetentionPreviewService,
    technicalRetentionRunner,
  });
  const handlePurchaseBrowserRoute = createPurchaseBrowserRoute({
    accountRemovalOperationRepository,
    assertAccountOwnerWritable,
    config,
    constantTimeTokenMatches,
    finishAccountOwnerSave,
    integrationProfileRepository,
    prepareAccountOwnerSave,
    purchaseAccountRepository,
    purchaseBrowserCaptureService,
    purchaseBrowserTaskService,
    readOwnerWritableJsonRequestBody,
    shopLicenseGrantRegistry,
    shopRepository,
  });
  const handleIntegrationAccountRoute = createIntegrationAccountRoute({
    assertProfileSettingOwnersWritable,
    config,
    crossBorderChargeService,
    db,
    externalIntegrationFetchImpl,
    finishAccountOwnerSave,
    getVerifiedOzonSellerIdentityIds,
    integrationCredentialRepository,
    integrationProfileRepository,
    modelApiAccountRepository,
    modelApiDiscoveryService,
    ozonScheduler,
    paidCapabilityAccess,
    performanceAccountRepository,
    performanceCredentialResolver,
    prepareAccountOwnerSave,
    profileAssetRepository,
    profileSettingsRepository,
    readOwnerWritableJsonRequestBody,
    runShopConnectionCheck,
    seerfarCategoryTreeService,
    shopRepository,
    syncSnapshotService,
  });
  const handleSourceLinkRoute = createSourceLinkRoute({
    purchaseService,
    readOwnerWritableJsonRequestBody,
    salesSourceLinkRepository,
  });
  const handleCrossBorderLogisticsRoute = createCrossBorderLogisticsRoute({
    config,
    crossBorderAccountService,
    crossBorderChargeService,
    crossBorderOrderService,
    crossBorderReadService,
    crossBorderWriteGuardService,
    finishAccountOwnerSave,
    prepareAccountOwnerSave,
    readOwnerWritableJsonRequestBody,
  });
  const handleOzonOperationsRoute = createOzonOperationsRoute({
    executeLegacyOzonRequest,
    ozonScheduler,
    readOwnerWritableJsonRequestBody,
    shopRepository,
    syncSnapshotService,
    writeGuardService,
  });
  const handleCacheSyncRoute = createCacheSyncRoute({
    catalogCacheService,
    db,
    domainServices,
    ozonScheduler,
    readOwnerWritableJsonRequestBody,
  });
  const handleCustomerServiceRoute = createCustomerServiceRoute({
    domainServices,
    readOwnerWritableJsonRequestBody,
  });
  const handleCatalogCacheRoute = createCatalogCacheRoute({
    catalogCacheService,
    readOwnerWritableJsonRequestBody,
  });
  const handleShopRoute = createShopRoute({
    assertAccountOwnerWritable,
    config,
    finishAccountOwnerSave,
    ozonScheduler,
    prepareAccountOwnerSave,
    readOwnerWritableJsonRequestBody,
    runShopConnectionCheck,
    shopBootstrap,
    shopRepository,
  });
  const handleExchangeRateRoute = createExchangeRateRoute({
    exchangeRateCacheRepository,
    exchangeRateService,
    readOwnerWritableJsonRequestBody,
  });

  const server = createServer((req, res) => {
    const corsHeaders = createCorsHeaders(config, req);

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    const requestUrl = new URL(
      req.url || "/",
      `http://${req.headers.host || "127.0.0.1"}`,
    );
    if (
      requestUrl.pathname.startsWith("/public/product-images/") &&
      productImageAssetRoutes.handleRequest({
        req,
        res,
        requestUrl,
        corsHeaders,
      })
    )
      return;
    if (
      req.method === "POST" &&
      requestUrl.pathname === OZON_PUSH_SINK_PATH
    ) {
      readJsonRequestBody(req, { maxBytes: 512 * 1024 })
        .then((body) => {
          const result = ozonPushNotificationService.ingestEnvelope(
            body,
            req.headers[OZON_PUSH_SIGNATURE_HEADER],
          );
          createJsonResponse(
            res,
            result.statusCode || (result.ok ? 200 : 400),
            result,
            corsHeaders,
          );
        })
        .catch((error) =>
          createJsonResponse(
            res,
            400,
            {
              ok: false,
              error: {
                code: "OZON_PUSH_BODY_INVALID",
                message: error instanceof Error ? error.message : "Ozon 推送内容无效。",
              },
            },
            corsHeaders,
          ),
        );
      return;
    }
    if (!localApiRequestIsAuthorized(config, req, requestUrl.pathname)) {
      createJsonResponse(res, 401, localApiUnauthorizedPayload(), corsHeaders);
      return;
    }
    if (
      customerServiceRealtimeRoutes.handleRequest({
        req,
        res,
        requestUrl,
        corsHeaders,
      })
    )
      return;
    if (
      ozonPushRealtimeRoutes.handleRequest({
        req,
        res,
        requestUrl,
        corsHeaders,
      })
    )
      return;
    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/internal/model-api-credentials/get"
    ) {
      if (!config?.security?.authToken) {
        createJsonResponse(
          res,
          403,
          {
            ok: false,
            error: {
              code: "LOCAL_API_INTERNAL_ONLY",
              message: "该接口仅供桌面端主进程调用。",
            },
          },
          corsHeaders,
        );
        return;
      }
      readJsonRequestBody(req, { maxBytes: 16 * 1024 })
        .then((body) => {
          const accountId = String(
            body?.accountId || body?.account_id || "",
          ).trim();
          const account =
            modelApiAccountRepository.getAccountForInternalUse(accountId);
          if (!account) {
            createJsonResponse(
              res,
              404,
              {
                ok: false,
                error: {
                  code: "MODEL_API_ACCOUNT_NOT_FOUND",
                  message: "没有找到可用的自有模型接口。",
                },
              },
              corsHeaders,
            );
            return;
          }
          const credentials =
            modelApiAccountRepository.getCredentialsForInternalUse(account.id);
          const publicAccount = { ...account };
          delete publicAccount.apiKey;
          delete publicAccount.loginPassword;
          createJsonResponse(
            res,
            200,
            {
              ok: true,
              account: publicAccount,
              credentials: {
                loginAccount: credentials?.loginAccount || "",
                loginPassword: credentials?.loginPassword || "",
                apiKey: credentials?.apiKey || "",
              },
            },
            corsHeaders,
          );
        })
        .catch((error) =>
          createJsonResponse(
            res,
            400,
            createBadJsonPayload(error),
            corsHeaders,
          ),
        );
      return;
    }
    if (
      customerChatFileRoutes.handleRequest({
        req,
        res,
        requestUrl,
        corsHeaders,
      })
    )
      return;
    if (
      productImageAssetRoutes.handleRequest({
        req,
        res,
        requestUrl,
        corsHeaders,
      })
    )
      return;
    if (
      imageProvenanceRoutes.handleRequest({ req, res, requestUrl, corsHeaders })
    )
      return;
    if (
      productDescriptionRoutes.handleRequest({
        req,
        res,
        requestUrl,
        corsHeaders,
      })
    )
      return;
    if (
      imagePromptPlanRoutes.handleRequest({ req, res, requestUrl, corsHeaders })
    )
      return;
    if (
      dataAnalysisInsightRoutes.handleRequest({
        req,
        res,
        requestUrl,
        corsHeaders,
      })
    )
      return;
    if (
      externalDataInsightRoutes.handleRequest({
        req,
        res,
        requestUrl,
        corsHeaders,
      })
    )
      return;
    if (
      skillInstallSourceRoutes.handleRequest({
        req,
        res,
        requestUrl,
        corsHeaders,
      })
    )
      return;
    if (
      localSmartReplyRuntime.handleRequest({
        req,
        res,
        requestUrl,
        corsHeaders,
      })
    )
      return;
    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/internal/shutdown"
    ) {
      if (!config.security.authToken) {
        createJsonResponse(
          res,
          403,
          {
            ok: false,
            error: {
              code: "LOCAL_API_INTERNAL_ONLY",
              message: "该接口仅供桌面端运行时使用。",
            },
          },
          corsHeaders,
        );
        return;
      }
      createJsonResponse(
        res,
        202,
        { ok: true, status: "draining" },
        corsHeaders,
      );
      setImmediate(() => requestShutdown());
      return;
    }
    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/internal/shop-license-grants"
    ) {
      if (!config.security.authToken || !shopLicenseGrantRegistry?.replace) {
        createJsonResponse(
          res,
          403,
          {
            ok: false,
            error: {
              code: "LOCAL_API_INTERNAL_ONLY",
              message: "该接口仅供桌面端授权运行时使用。",
            },
          },
          corsHeaders,
        );
        return;
      }
      readJsonRequestBody(req, { maxBytes: 1024 * 1024 })
        .then(async (body) => {
          try {
            const replaced = shopLicenseGrantRegistry.replace(body?.grants);
            await localSmartReplyRuntime.replaceEntitlements({
              scopeId: req.headers["x-wangzai-cache-scope"],
              grants: body?.grants,
            });
            createJsonResponse(
              res,
              200,
              replaced,
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              400,
              {
                ok: false,
                error: {
                  code: error?.code || "SHOP_LICENSE_GRANTS_INVALID",
                  message: error?.message || "店铺授权清单无效。",
                },
              },
              corsHeaders,
            );
          }
        })
        .catch((error) =>
          createJsonResponse(
            res,
            400,
            createBadJsonPayload(error),
            corsHeaders,
          ),
        );
      return;
    }
    const query = createQueryObject(requestUrl);
    const databaseStatus = getDatabaseStatus();

    if (handleAccountRemovalRoute({ req, res, requestUrl, corsHeaders }))
      return;
    if (handleProtectedComputeRoute({ req, res, requestUrl, corsHeaders }))
      return;
    if (handleProfileMaintenanceRoute({ req, res, requestUrl, corsHeaders }))
      return;
    if (handleShopIdentityLifecycleRoute({ req, res, requestUrl, corsHeaders }))
      return;
    if (
      followSellerDefenseRoutes.handleRequest({
        req,
        res,
        requestUrl,
        corsHeaders,
      })
    )
      return;
    if (
      productsRoutes.handleRequest({ req, res, requestUrl, query, corsHeaders })
    )
      return;

    if (req.method === "GET" && requestUrl.pathname === "/health") {
      createJsonResponse(
        res,
        200,
        createHealthPayload({ config, databaseStatus, migrationsApplied }),
        corsHeaders,
      );
      return;
    }

    if (req.method === "GET") {
      const catalogRouteResult = catalogRoutes.handleGet(
        requestUrl.pathname,
        query,
      );
      if (catalogRouteResult) {
        createJsonResponse(
          res,
          catalogRouteResult.status,
          catalogRouteResult.payload,
          corsHeaders,
        );
        return;
      }
    }

    if (handleAppMaintenanceRoute({ corsHeaders, query, req, requestUrl, res })) return;

    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/exchange-rate/rub-cny/cache"
    ) {
      createJsonResponse(
        res,
        200,
        exchangeRateCacheRepository.listRecords({ limit: query.limit }),
        corsHeaders,
      );
      return;
    }

    if (handleExchangeRateRoute({ corsHeaders, query, req, requestUrl, res })) return;

    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/performance/accounts"
    ) {
      try {
        const payload = createPerformanceAccountsPayload(
          performanceAccountRepository.listAccounts(),
        );
        createJsonResponse(res, 200, payload, corsHeaders);
      } catch (error) {
        createJsonResponse(res, 400, createBadJsonPayload(error), corsHeaders);
      }
      return;
    }

    if (handlePurchaseBrowserRoute({ corsHeaders, query, req, requestUrl, res })) return;

    if (handleIntegrationAccountRoute({ corsHeaders, query, req, requestUrl, res })) return;

    if (handleShopRoute({ corsHeaders, query, req, requestUrl, res })) return;

    if (handleCatalogCacheRoute({ corsHeaders, query, req, requestUrl, res })) return;

    if (handleCrossBorderLogisticsRoute({ corsHeaders, query, req, requestUrl, res })) return;

    if (handleSourceLinkRoute({ corsHeaders, query, req, requestUrl, res })) return;

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/orders/test-split-simulation"
    ) {
      handleTestSplitSimulationRoute({ req, res, domainServices, corsHeaders });
      return;
    }

    if (handleCustomerServiceRoute({ corsHeaders, query, req, requestUrl, res })) return;

    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/profit/ledger-snapshot"
    ) {
      const profitService = domainServices.get("profit");
      const payload = profitService?.readLedgerSnapshot?.(query) || {
        ok: false,
        error: {
          code: "PROFIT_LEDGER_CACHE_NOT_CONNECTED",
          message: "profit ledger SQLite cache is not connected.",
        },
      };
      createJsonResponse(res, payload.ok ? 200 : 503, payload, corsHeaders);
      return;
    }

    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/profit/order-review"
    ) {
      const profitService = domainServices.get("profit");
      const payload = profitService?.readOrderReview?.(query) || {
        ok: false,
        error: {
          code: "PROFIT_REVIEW_NOT_CONNECTED",
          message: "profit order review reader is not connected.",
        },
      };
      const status = payload.ok
        ? 200
        : payload.error?.code === "PROFIT_REVIEW_ORDER_NUMBER_REQUIRED"
          ? 400
          : 503;
      createJsonResponse(res, status, payload, corsHeaders);
      return;
    }

    if (
      req.method === "PUT" &&
      requestUrl.pathname === "/api/profit/ledger-snapshot"
    ) {
      readOwnerWritableJsonRequestBody(req, {
        maxBytes: PROFIT_LEDGER_SNAPSHOT_MAX_BYTES,
      })
        .then((body) => {
          try {
            const profitService = domainServices.get("profit");
            const payload = profitService?.saveLedgerSnapshot?.(body) || {
              ok: false,
              error: {
                code: "PROFIT_LEDGER_CACHE_NOT_CONNECTED",
                message: "profit ledger SQLite cache is not connected.",
              },
            };
            createJsonResponse(
              res,
              payload.ok ? 200 : 400,
              payload,
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              400,
              createBadJsonPayload(error),
              corsHeaders,
            );
          }
        })
        .catch((error) => {
          createJsonResponse(
            res,
            400,
            createBadJsonPayload(error),
            corsHeaders,
          );
        });
      return;
    }

    if (
      req.method === "DELETE" &&
      requestUrl.pathname === "/api/profit/ledger-snapshot"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then((body) => {
          try {
            const profitService = domainServices.get("profit");
            const payload = profitService?.clearLedgerSnapshots?.({
              ...query,
              ...body,
            }) || {
              ok: false,
              error: {
                code: "PROFIT_LEDGER_CACHE_NOT_CONNECTED",
                message: "profit ledger SQLite cache is not connected.",
              },
            };
            createJsonResponse(
              res,
              payload.ok ? 200 : 400,
              payload,
              corsHeaders,
            );
          } catch (error) {
            createJsonResponse(
              res,
              400,
              createBadJsonPayload(error),
              corsHeaders,
            );
          }
        })
        .catch((error) => {
          createJsonResponse(
            res,
            400,
            createBadJsonPayload(error),
            corsHeaders,
          );
        });
      return;
    }

    if (handleCacheSyncRoute({ corsHeaders, query, req, requestUrl, res })) return;

    if (handleOzonOperationsRoute({ corsHeaders, query, req, requestUrl, res })) return;

    if (req.method === "GET" && requestUrl.pathname === "/") {
      createTextResponse(
        res,
        200,
        "旺崽助手 local-api 已启动。请访问 /health 或 /api/app/status。",
        corsHeaders,
      );
      return;
    }

    createJsonResponse(
      res,
      404,
      {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message:
            "local-api 当前提供 /health、/api/app/status、/api/shops、/api/cache/catalog/*、统一 /api/cache/:domain、/api/sync/*、/api/ozon/* 和受阻断的 /api/ozon/request。",
        },
      },
      corsHeaders,
    );
  });
  if (continuousSyncEnabled && deferContinuousSync) {
    server.once("listening", () => {
      continuousSyncStartTimer = setTimeout(() => {
        continuousSyncStartTimer = null;
        try {
          startBackgroundServices();
        } catch (error) {
          console.error(
            "[local-api][startup] deferred background services failed",
            error,
          );
        }
      }, deferredContinuousSyncDelayMs);
      continuousSyncStartTimer.unref?.();
    });
  }
  if (automaticMaintenanceEnabled === true) {
    server.once("listening", () => automaticMaintenanceScheduler.start());
  }
  server.once("listening", () => productImageLifecycleScheduler.start());
  server.once("listening", () => localSmartReplyRuntime.start());
  server.once("listening", () => domainServices.startBackgroundStorage?.());
  server.once("listening", () => {
    void imageProvenanceService.start().catch((error) => {
      console.error(
        "[local-api][image-provenance] startup recovery failed",
        error,
      );
    });
  });
  server.once("close", () => {
    domainServices.stopBackgroundStorage?.();
    if (continuousSyncStartTimer) clearTimeout(continuousSyncStartTimer);
    continuousSyncStartTimer = null;
    if (backgroundServicesStarted) continuousSyncService.stop?.();
    ozonPushDomainRefreshCoordinator.stop();
    customerServiceRealtimeHub.close();
    ozonPushRealtimeHub.close();
    shopBootstrap.stop?.();
    automaticMaintenanceScheduler.stop();
    productImageLifecycleScheduler.stop();
    imageProvenanceService.stop();
    void localSmartReplyRuntime.stop();
  });
  return server;
}
