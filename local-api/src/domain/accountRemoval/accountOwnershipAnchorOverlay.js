// Bound to phase-b-b0-frozen-ledger-v2 and the immutable current Catalog source.
export const ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY_VERSION = 'phase-b-account-ownership-anchor-overlay-v21';
export const ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY_V2_LEDGER_SHA256 = 'EDFF68B271830BFEFE320D19774B3DE2B1FC61DF640FED1224D8C61D593B737C';
export const ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY_CATALOG_BASELINE_SHA256 = '2574361EF90FD4531060D8CF6EB8FEB09A53DEFD303C2966EBC21E0043F9D3B8';

const FROZEN_ANCHOR_IDENTITY_FIELDS = Object.freeze([
  'id',
  'sourceFile',
  'sourceSymbol',
  'line',
  'ownerBasis',
]);

export function frozenAccountOwnershipAnchorMatches(resource, frozenBaseline) {
  if (!resource || !frozenBaseline) return false;
  return FROZEN_ANCHOR_IDENTITY_FIELDS.every((field) => (
    resource[field] === frozenBaseline[field]
  ));
}

// An overlay is a migration aid for an immutable frozen fact, not a replacement
// for that fact. If a negative fixture (or accidental edit) changes any original
// anchor identity field, keep the changed resource visible so validation fails.
export function applyAccountOwnershipAnchorOverlay({
  resource,
  frozenBaseline,
  primaryAnchor,
  currentSourceAnchor,
} = {}) {
  if (!primaryAnchor && !currentSourceAnchor) return resource;
  if (!frozenAccountOwnershipAnchorMatches(resource, frozenBaseline)) return resource;
  return { ...resource, ...primaryAnchor, ...currentSourceAnchor };
}

// Versioned Catalog extensions did not exist in the B0 ledger. Their immutable
// source-evidence identity needs a separate, exact compatibility record; they
// must never be added to or substituted for the frozen 76-entry certificate.
export const ACCOUNT_OWNERSHIP_CURRENT_CATALOG_SOURCE_VERSION = 'account-ownership-current-catalog-source-v2';
export const ACCOUNT_OWNERSHIP_CURRENT_CATALOG_SOURCE_COMPATIBILITY = Object.freeze([
  ['browser:purchase-persistent-partition', 'the CEF profile directory is derived only from the HMAC owner reference'],
  ['browser:integration-persistent-partition', 'controller closes interactive and collector runtimes before removing the exact owner storage path'],
  ...[
    'browser:integration-cookies',
    'browser:integration-local-storage',
    'browser:integration-indexed-db',
    'browser:integration-cache-storage',
    'browser:integration-http-cache',
    'browser:integration-service-workers',
    'browser:integration-proxy-auth',
    'browser:integration-plugin-installation-state',
    'browser:integration-extension-storage',
    'browser:integration-downloads',
  ].map((id) => [id, 'controller removes and reads back the exact integration owner browser artifacts']),
].map(([id, ownerBasis]) => Object.freeze({
    id,
    baselineSourceEvidence: Object.freeze({
      sourceFile: 'desktop/src/purchaseBrowser/cefPurchaseBrowserController.js',
      sourceSymbol: 'async function purgeOperation(operationId) {',
      ownerBasis,
    }),
    currentSourceAnchor: Object.freeze({
      sourceFile: 'desktop/src/purchaseBrowser/cefPurchaseBrowserController.js',
      sourceSymbol: 'async function purgeOperation(operationId, update = () => undefined) {',
      // Current cleanup body re-reviewed at its exact location and owner guards.
      // See docs/CI_REPAIR_REVIEW.md; frozen Catalog identities stay unchanged.
      line: '4769-4837',
      ownerBasis,
    }),
    requiredSourceStatements: Object.freeze([
      'const prepared = await localApiClient.prepareAccountRemoval(operationId);',
      "if (prepared?.operationId !== operationId) fail('PURCHASE_BROWSER_ACCOUNT_REMOVAL_OPERATION_MISMATCH');",
      "if (!expectedResources || JSON.stringify(resourceIds) !== JSON.stringify(expectedResources)) fail('PURCHASE_BROWSER_ACCOUNT_REMOVAL_RESOURCE_MISMATCH');",
      'const receiptBinding = validatePurchaseRemovalReceiptBinding(prepared.receiptBinding, { operationId, binding });',
      'const ownerRef = profileStore.ownerRefFor(binding);',
      'const storagePath = path.join(ownedProfileRoot, ownerRef);',
      'await removeOwnedPathAfterRuntimeClose(storagePath, ownerRef);',
      'const proof = createRemovalProof({ ownerRef, resourceIds, storagePath, receiptBinding });',
      'await localApiClient.recordAccountRemovalReceipt(operationId, proof);',
    ]),
  })));

export function currentAccountOwnershipCatalogSourceCompatibility(entry) {
  const compatibility = ACCOUNT_OWNERSHIP_CURRENT_CATALOG_SOURCE_COMPATIBILITY.find((candidate) => candidate.id === entry?.id);
  if (!compatibility || !entry.sourceEvidence) return null;
  const fields = ['sourceFile', 'sourceSymbol', 'ownerBasis'];
  if (Object.keys(entry.sourceEvidence).sort().join(',') !== [...fields].sort().join(',')) return null;
  return fields.every((field) => entry.sourceEvidence[field] === compatibility.baselineSourceEvidence[field])
    ? compatibility : null;
}

// The 76 frozen primary identities are unchanged. A changed executable entry
// point needs its own exact baseline binding and owner-barrier evidence; a
// same-name function or a changed owner basis is not a compatible replacement.
export const ACCOUNT_OWNERSHIP_CURRENT_PRIMARY_SOURCE_VERSION = 'account-ownership-current-primary-source-v1';
export const ACCOUNT_OWNERSHIP_CURRENT_PRIMARY_SOURCE_COMPATIBILITY = Object.freeze([
  Object.freeze({
    id: 'logical:local-data-product-source-links-shop-records',
    baselinePrimaryAnchor: Object.freeze({
      sourceFile: 'frontend/src/services/productSourceLinkStore.js',
      sourceSymbol: 'export async function saveProductSourceLinkRecord({ key, record, product = {}, timeoutMs = 3000 } = {}) {',
      line: '131',
      ownerBasis: 'owner exists in key ${shopId}:${productKey}; value has no shopId; key selector unsupported',
    }),
    currentSourceAnchor: Object.freeze({
      sourceFile: 'frontend/src/services/productSourceLinkStore.js',
      sourceSymbol: 'export function saveProductSourceLinkRecord({ key, record, product = {}, timeoutMs = 3000 } = {}) {',
      line: '21-36,62-78,171-186',
      ownerBasis: 'owner exists in key ${shopId}:${productKey}; value has no shopId; key selector unsupported',
    }),
    requiredSourceStatements: Object.freeze([
      'const task = { excludedOwnerIds: new Set(productSourceLinkFencedShopIds), globalSnapshot, promise: null };',
      'productSourceLinkTasks.add(task);',
      '.then(() => work(task))',
      '.finally(() => productSourceLinkTasks.delete(task));',
      'const ownerId = normalizeProductSourceOwnerId(shopId);',
      'if (!productSourceLinkFencedShopIds.has(ownerId) && !task?.excludedOwnerIds.has(ownerId)) return;',
      "error.code = 'ACCOUNT_REMOVAL_OWNER_QUIESCED';",
      'throw error;',
      'const ownerId = normalizeProductSourceOwnerId(shopId);',
      'productSourceLinkFencedShopIds.add(ownerId);',
      'const pending = [...productSourceLinkTasks];',
      'pending.forEach((task) => task.excludedOwnerIds.add(ownerId));',
      'const drain = await settleOwnerWriteDrain([activeProductSourceLinkMigration, ...pending.map((task) => task.promise)]);',
      'return trackProductSourceTask(async (task) => {',
      'const payload = toProductSourcePayload(key, record, product, [], { allowDirectScope: true });',
      "if (!payload) throw new Error('PRODUCT_SOURCE_LINK_IDENTITY_REQUIRED');",
      'assertProductSourceOwnerWritable(payload.shopId, task);',
      'return retryTransientLocalApiWrite(async () => {',
      'assertProductSourceOwnerWritable(payload.shopId, task);',
      'const result = await saveProductSourceLinksToLocalApi(payload, { timeoutMs });',
      "if (!result?.ok) throw new Error('PRODUCT_SOURCE_LINK_SAVE_FAILED');",
    ]),
  }),
]);

export function currentAccountOwnershipPrimarySourceCompatibility(primaryAnchor, { resourceId } = {}) {
  const fields = ['sourceFile', 'sourceSymbol', 'line', 'ownerBasis'];
  if (!primaryAnchor || Object.keys(primaryAnchor).sort().join(',') !== [...fields].sort().join(',')) return null;
  return ACCOUNT_OWNERSHIP_CURRENT_PRIMARY_SOURCE_COMPATIBILITY.find((candidate) => (
    (resourceId === undefined || candidate.id === resourceId)
    && fields.every((field) => primaryAnchor[field] === candidate.baselinePrimaryAnchor[field])
  )) || null;
}

export function missingAccountOwnershipPrimarySourceStatements(compatibility, sourceWindow) {
  // Match concrete lines, not comments containing a retired signature or guard.
  // Count repeated statements: both the admission and each-retry owner checks
  // must survive, not merely one occurrence somewhere in the reviewed window.
  const concreteLines = sourceWindow.replace(/\/\*[\s\S]*?\*\//gu, '').split(/\r\n|\n|\r/u).map((line) => line.trim());
  const missing = [];
  for (const statement of [compatibility.currentSourceAnchor.sourceSymbol, ...compatibility.requiredSourceStatements]) {
    const index = concreteLines.indexOf(statement);
    if (index < 0) missing.push(statement);
    else concreteLines.splice(index, 1);
  }
  return missing;
}

// Post-B0 production work can move a declaration without changing the immutable
// ledger fact. These entries update only the source line window for resources that
// are not part of the 76-item certificate overlay.
export const ACCOUNT_OWNERSHIP_FROZEN_SOURCE_LINE_OVERLAY = Object.freeze([
  Object.freeze(["memory:static:frontend-src-services-browser-legacy-read-store:legacy-browser-audit-keys", Object.freeze({
    sourceFile: "frontend/src/audit/retiredBrowserStorageAudit.js",
    sourceSymbol: "auditKeysResource: 'memory:static:frontend-src-services-browser-legacy-read-store:legacy-browser-audit-keys-retired'",
    line: "14",
    ownerBasis: "the old browser key audit is retired and stores no runtime values",
  })]),
  Object.freeze(["runtime:renderer-legacy-browser-read-listeners", Object.freeze({
    sourceFile: "frontend/src/audit/retiredBrowserStorageAudit.js",
    sourceSymbol: "readListenerResource: 'runtime:renderer-legacy-browser-read-listeners-retired'",
    line: "13",
    ownerBasis: "the listener runtime has been removed and stores no owner state",
  })]),
  Object.freeze(["memory:renderer-local-data-read-cache-l0", "515"]),
  Object.freeze(["filesystem:retired-purchase-plugin-context", Object.freeze({
    sourceFile: "desktop/src/protocol/appProtocol.js",
    sourceSymbol: "RETIRED_PURCHASE_PLUGIN_CONTEXT_FILE",
    line: "44",
    ownerBasis: "retired context has no authoritative purchase owner",
  })]),
  Object.freeze(["filesystem:retired-marketing-activity-cache", Object.freeze({
    sourceFile: "desktop/src/protocol/appProtocol.js",
    sourceSymbol: "RETIRED_MARKETING_ACTIVITY_CACHE_FILE",
    line: "49",
    ownerBasis: "retired marketing cache may span shops",
  })]),
  Object.freeze(["memory:desktop-local-api-auth-token", Object.freeze({
    sourceFile: "desktop/src/runtime/serviceRuntime.js",
    sourceSymbol: "authToken",
    line: "178",
    ownerBasis: "process capability shared by local-api requests; no business-owner anchor",
  })]),
  Object.freeze(["runtime:desktop-app-protocol-file-write-queues", Object.freeze({
    sourceFile: "desktop/src/protocol/appProtocol.js",
    sourceSymbol: "const writeQueues = new Map();",
    line: "75",
    ownerBasis: "one file-path queue can carry mixed legacy JSON writes",
  })]),
  Object.freeze(["runtime:desktop-license-device-code-load-task", Object.freeze({
    sourceFile: "desktop/src/licensing/licenseSessionStore.js",
    sourceSymbol: "this.deviceCodePromise = null;",
    line: "99",
    ownerBasis: "device-code task is installation scoped",
  })]),
  Object.freeze(["browser:electron-default-session-unattributed", Object.freeze({
    sourceFile: "desktop/src/window/mainWindow.js",
    sourceSymbol: "const guardedSession = webContents.session;",
    line: "27",
    ownerBasis: "current BrowserWindow does not use a per-account partition",
  })]),
  Object.freeze(["browser:external-chrome-extension-profile-unattributed", Object.freeze({
    sourceFile: "frontend/src/audit/retiredBrowserStorageAudit.js",
    sourceSymbol: "profileResource: 'browser:external-chrome-extension-profile-unattributed'",
    line: "6",
    ownerBasis: "the old external Chrome profile has been retired and has no runtime owner state",
  })]),
  Object.freeze(["browser:external-chrome-extension-storage-unattributed", Object.freeze({
    sourceFile: "frontend/src/audit/retiredBrowserStorageAudit.js",
    sourceSymbol: "storageResource: 'browser:external-chrome-extension-storage-unattributed'",
    line: "7",
    ownerBasis: "the old external Chrome storage has been retired and has no runtime owner state",
  })]),
  Object.freeze(["filesystem:desktop-recovery-shell-sqlite-file", Object.freeze({
    sourceFile: "desktop/src/runtime/desktopPaths.js",
    sourceSymbol: "recoveryShellDatabasePath",
    line: "150",
    ownerBasis: "system/profile recovery shell; stop shell and checkpoint; no business-owner deletion",
  })]),
  Object.freeze(["filesystem:legacy-local-api-secret-key", Object.freeze({
    sourceFile: "desktop/src/runtime/dataLayout.js",
    sourceSymbol: "legacySecretPath: resolvedLocalApiRoot",
    line: "40",
    ownerBasis: "legacy key is installation/profile system scope",
  })]),
  Object.freeze(["filesystem:software-category-tree-static", Object.freeze({
    sourceFile: "local-api/src/domain/catalog/sharedCatalogService.js",
    sourceSymbol: "return resolve(currentDir, '../../../assets/ozonCategoryTree.zh.json');",
    line: "143",
    ownerBasis: "local-api packaged seed asset is immutable profile-independent system data",
  })]),
  Object.freeze(["logical:local-api-rate-limit-shop-state", Object.freeze({
    sourceFile: "local-api/src/ozon/rateLimitState.js",
    sourceSymbol: "function createRateLimitState",
    line: "73",
    ownerBasis: "state keys reject missing shop IDs",
  })]),
  Object.freeze(["logical:local-api-traffic-controller-shop-state", Object.freeze({
    sourceFile: "local-api/src/ozon/trafficController.js",
    sourceSymbol: "export function createTrafficController(options = {})",
    line: "103",
    ownerBasis: "all dynamic and fixed scopes are shop-prefixed",
  })]),
  Object.freeze(["logical:profile-settings-purchase-plugin-context", "14"]),
  Object.freeze(["memory:local-api-hot-cache-shop-tag", "139"]),
  Object.freeze(["memory:local-api-rate-limit-state-mixed-next-allowed", Object.freeze({
    sourceFile: "local-api/src/ozon/rateLimitState.js",
    sourceSymbol: "const nextAllowedAt = new Map();",
    line: "74",
    ownerBasis: "stateKey rejects requests without an exact shopId",
  })]),
  Object.freeze(["logical:local-data-ozon-shop-settings-shop-slices", Object.freeze({
    sourceFile: "frontend/src/services/ozonShopSettingsStore.js",
    sourceSymbol: "normalizeOzonShopSettingsStore",
    line: "114",
    ownerBasis: "shops[].id/defaultWarehouseIds[shopId]/activeShopId",
  })]),
  Object.freeze(["memory:catalog-cache-active-jobs", Object.freeze({
    sourceFile: "local-api/src/cache/catalog/catalogCacheService.js",
    sourceSymbol: "const jobs = new Map();",
    line: "209",
    ownerBasis: "job.shopId is an exact future quiesce selector",
  })]),
  Object.freeze(["memory:customer-message-translation-cache", Object.freeze({
    sourceFile: "local-api/src/domain/customerService/customerMessageTranslationService.js",
    sourceSymbol: "const memoryCache = new Map();",
    line: "48",
    ownerBasis: "text-derived cache key has no owner",
  })]),
  Object.freeze(["memory:local-api-products-hot-cache", Object.freeze({
    sourceFile: "local-api/src/domain/products/productCanonicalReadService.js",
    sourceSymbol: "productHotCache.set(cacheKey, { ...payload, source: \"memory\" }, {",
    line: "115",
    ownerBasis: "canonical product L1 entries carry every shop owner tag and expose exact owner count/invalidation",
  })]),
  Object.freeze(["memory:local-api-software-category-name-index", Object.freeze({
    sourceFile: "local-api/src/cache/catalog/softwareCategoryNameService.js",
    sourceSymbol: "let categoryIndexCache = null;",
    line: "12",
    ownerBasis: "versioned SQLite shared-catalog L0 projection is profile-shared system state",
  })]),
  Object.freeze(["memory:performance-access-token-cache", Object.freeze({
    sourceFile: "local-api/src/integrations/performanceApiClient.js",
    sourceSymbol: "const performanceTokenReuseByAccount = new Map();",
    line: "15",
    ownerBasis: "performanceTokenKeysByOwner binds reusable token keys to the exact performance account id",
  })]),
  Object.freeze(["memory:performance-inflight-request-cache", Object.freeze({
    sourceFile: "local-api/src/integrations/performanceApiClient.js",
    sourceSymbol: "const performanceOverviewInFlightReads = new Map();",
    line: "14",
    ownerBasis: "request key accepts multiple account/client forms",
  })]),
  Object.freeze(["memory:purchase-search-bridge-captures-unattributed", Object.freeze({
    sourceFile: "frontend/scripts/purchase-bridge/plugin-store.mjs",
    sourceSymbol: "let purchasePluginCaptures = [];",
    line: "291",
    ownerBasis: "bridge captures have no authoritative purchaseAccountId",
  })]),
  Object.freeze(["memory:purchase-search-bridge-context-unattributed", Object.freeze({
    sourceFile: "frontend/scripts/purchase-bridge/plugin-store.mjs",
    sourceSymbol: "let purchasePluginContext = {};",
    line: "290",
    ownerBasis: "bridge context has no purchaseAccountId",
  })]),
  Object.freeze(["memory:renderer-ozon-order-image-preload-cache-unattributed", Object.freeze({
    sourceFile: "frontend/src/services/ozonOrderExperience.js",
    sourceSymbol: "const imagePreloadCache = new Map();",
    line: "13",
    ownerBasis: "image URL alone has no account owner",
  })]),
  Object.freeze(["memory:renderer-ozon-shop-settings-unattributed", Object.freeze({
    sourceFile: "frontend/src/services/ozonShopSettingsStore.js",
    sourceSymbol: "export let ozonShopSettingsMemory = null;",
    line: "18",
    ownerBasis: "aggregate renderer memory can include multiple shops",
  })]),
  Object.freeze(["memory:renderer-ozon-snapshot-inflight-unattributed", Object.freeze({
    sourceFile: "frontend/src/shared/config/appConfigRuntime.jsx",
    sourceSymbol: "export const ozonSnapshotInFlight = new Map();",
    line: "417",
    ownerBasis: "in-flight snapshot key can aggregate sources",
  })]),
  Object.freeze(["memory:renderer-ozon-snapshot-manual-refresh-unattributed", Object.freeze({
    sourceFile: "frontend/src/shared/config/appConfigRuntime.jsx",
    sourceSymbol: "export const ozonSnapshotManualRefreshAt = new Map();",
    line: "419",
    ownerBasis: "manual refresh key has no owner contract",
  })]),
  Object.freeze(["memory:renderer-ozon-snapshot-memory-cache-unattributed", Object.freeze({
    sourceFile: "frontend/src/shared/config/appConfigRuntime.jsx",
    sourceSymbol: "export const ozonSnapshotMemoryCache = new Map();",
    line: "415",
    ownerBasis: "snapshot cache can aggregate sources",
  })]),
  Object.freeze(["memory:renderer-product-list-cursor-cache-unattributed", Object.freeze({
    sourceFile: "frontend/src/entities/product/productLocalData.jsx",
    sourceSymbol: "export const productListCursorMemoryCache = new Map();",
    line: "53",
    ownerBasis: "cursor keys allow non-authoritative shop fallback",
  })]),
  Object.freeze(["memory:renderer-product-list-memory-cache-unattributed", Object.freeze({
    sourceFile: "frontend/src/entities/product/productLocalData.jsx",
    sourceSymbol: "export const productListMemoryCache = new Map();",
    line: "49",
    ownerBasis: "cache keys allow client/id/label fallback",
  })]),
  Object.freeze(["memory:renderer-product-list-page-meta-cache-unattributed", Object.freeze({
    sourceFile: "frontend/src/entities/product/productLocalData.jsx",
    sourceSymbol: "export const productListPageMetaMemoryCache = new Map();",
    line: "51",
    ownerBasis: "page metadata keys allow non-authoritative shop fallback",
  })]),
  Object.freeze(["memory:renderer-profit-finance-operation-cache", Object.freeze({
    sourceFile: "frontend/src/entities/profit/profitFinanceEvidence.jsx",
    sourceSymbol: "export const profitFinanceOperationCache = new Map();",
    line: "587",
    ownerBasis: "future scope must resolve canonical Ozon shop/client id",
  })]),
  Object.freeze(["memory:renderer-profit-after-sales-snapshot-cache", Object.freeze({
    sourceFile: "frontend/src/entities/profit/profitFinanceEvidence.jsx",
    sourceSymbol: "export const profitAfterSalesSnapshotCache = new Map();",
    line: "926",
    ownerBasis: "future scope must resolve canonical Ozon shop/client id",
  })]),
  Object.freeze(["memory:renderer-prompt-library-store", Object.freeze({
    sourceFile: "frontend/src/features/promptLibrary/lib/promptLibraryStore.jsx",
    sourceSymbol: "export let promptLibraryStoreMemory = null;",
    line: "476",
    ownerBasis: "tool library is system/global configuration",
  })]),
  Object.freeze(["memory:renderer-purchase-order-local-overrides-unattributed", Object.freeze({
    sourceFile: "frontend/src/services/purchaseOrderRuntime.js",
    sourceSymbol: "export let purchaseOrderLocalOverridesMemory = null;",
    line: "698",
    ownerBasis: "legacy override keys do not prove one shop",
  })]),
  Object.freeze(["memory:renderer-purchase-order-override-local-api-hashes-unattributed", Object.freeze({
    sourceFile: "frontend/src/services/purchaseOrderRuntime.js",
    sourceSymbol: "export const purchaseOrderOverrideLocalApiHashes = new Map();",
    line: "700",
    ownerBasis: "dedupe hashes are keyed by non-authoritative order keys",
  })]),
  Object.freeze(["memory:renderer-purchase-plugin-source-context-unattributed", Object.freeze({
    sourceFile: "frontend/src/services/purchasePluginContextStore.js",
    sourceSymbol: "export let purchasePluginSourceContextMemory = null;",
    line: "64",
    ownerBasis: "context lacks an authoritative purchaseAccountId",
  })]),
  Object.freeze(["memory:renderer-watermark-settings", Object.freeze({
    sourceFile: "frontend/src/features/products/lib/productEditing.jsx",
    sourceSymbol: "export let watermarkSettingsMemory = null;",
    line: "94",
    ownerBasis: "watermark store is global profile configuration",
  })]),
  Object.freeze(["memory:static:desktop-src-licensing-license-config:loopback-hosts", "12"]),
  Object.freeze(["memory:static:desktop-src-licensing-license-config:modes", "11"]),
  Object.freeze(["memory:static:desktop-src-licensing-license-runtime:allowed-methods", "17"]),
  Object.freeze(["memory:static:desktop-src-licensing-license-runtime:entitlement-rejection-statuses", "21"]),
  Object.freeze(["memory:static:desktop-src-runtime-local-api-proxy:domain-permissions", "164"]),
  Object.freeze(["memory:static:desktop-src-runtime-local-api-proxy:legacy-import-post-paths", "28"]),
  Object.freeze(["memory:static:desktop-src-window-main-window:legacy-retirement-marketing-file-source-phases", Object.freeze({
    sourceFile: "desktop/src/window/mainWindow.js",
    sourceSymbol: "await import(\"../../test-support/legacyRetirementHarness.js\")",
    line: "934",
    ownerBasis: "retired marketing fixtures exist only in the explicit test harness",
  })]),
  Object.freeze(["memory:static:desktop-src-window-main-window:retired-legacy-retirement-fixture-ids", Object.freeze({
    sourceFile: "desktop/src/window/mainWindow.js",
    sourceSymbol: "await import(\"../../test-support/legacyRetirementHarness.js\")",
    line: "934",
    ownerBasis: "retired fixture ids exist only in the explicit test harness",
  })]),
  Object.freeze(["memory:static:frontend-src-api-local-api-client:order-sync-failed-statuses", "943"]),
  Object.freeze(["memory:static:frontend-src-api-local-api-client:order-sync-final-statuses", "933"]),
  Object.freeze(["memory:renderer-local-api-sync-jobs-unattributed", Object.freeze({
    sourceFile: "frontend/src/api/localApiClient.js",
    sourceSymbol: "localApiSyncJobs",
    line: "68,143-169",
    ownerBasis: "renderer normalization drops authoritative shop ownership from job-only keys",
  })]),
  Object.freeze(["runtime:renderer-local-api-request-listeners", "66,104,230,232"]),
  Object.freeze(["memory:static:frontend-src-entities-order-order-shop-scope:legacy-marketing-activity-fields", Object.freeze({ sourceFile: "frontend/src/entities/marketing/marketingActivityLegacyMigration.jsx", line: "31" })]),
  Object.freeze(["memory:static:frontend-src-entities-order-order-shop-scope:legacy-marketing-product-fields", Object.freeze({ sourceFile: "frontend/src/entities/marketing/marketingActivityLegacyMigration.jsx", line: "33" })]),
  Object.freeze(["memory:static:frontend-src-entities-order-order-shop-scope:legacy-marketing-product-status-aliases", Object.freeze({ sourceFile: "frontend/src/entities/marketing/marketingActivityLegacyMigration.jsx", line: "176" })]),
  Object.freeze(["memory:static:frontend-src-entities-order-order-shop-scope:legacy-marketing-snapshot-fields", Object.freeze({ sourceFile: "frontend/src/entities/marketing/marketingActivityLegacyMigration.jsx", line: "20" })]),
  Object.freeze(["memory:static:frontend-src-entities-order-order-shop-scope:legacy-marketing-source-type-aliases", Object.freeze({ sourceFile: "frontend/src/entities/marketing/marketingActivityLegacyMigration.jsx", line: "153" })]),
  Object.freeze(["memory:static:frontend-src-entities-order-order-shop-scope:legacy-marketing-summary-fields", Object.freeze({ sourceFile: "frontend/src/entities/marketing/marketingActivityLegacyMigration.jsx", line: "35" })]),
  Object.freeze(["memory:static:frontend-src-entities-product-product-attributes:product-attribute-id-name-map", "324"]),
  Object.freeze(["memory:static:frontend-src-entities-product-product-attributes:product-attribute-value-map", "460"]),
  Object.freeze(["memory:static:frontend-src-features-licensing-services-license-center-client:entitlement-rejection-statuses", Object.freeze({
    sourceFile: "desktop/src/licensing/licenseRuntime.js",
    sourceSymbol: "ENTITLEMENT_REJECTION_STATUSES",
    line: "21",
    ownerBasis: "the packaged Electron license runtime now owns the shared entitlement rejection status enum",
  })]),
  Object.freeze(["memory:static:frontend-src-features-products-lib-product-bus-material-sync:product-bus-material-write-failed-statuses", Object.freeze({
    sourceFile: "frontend/src/features/products/lib/productBusMaterialSync.js",
    sourceSymbol: "humanConfirmed: false,",
    line: "63",
    ownerBasis: "the retired renderer status Set is replaced by a typed preview result that is explicitly not human-confirmed",
  })]),
  Object.freeze(["memory:static:frontend-src-features-products-model-use-product-batch-state:product-batch-write-failed-statuses", Object.freeze({
    sourceFile: "frontend/src/features/products/model/useProductBatchState.jsx",
    sourceSymbol: "isProductWriteReadbackComplete,",
    line: "22",
    ownerBasis: "the retired renderer failure Set is replaced by the typed local-api readback completion classifier",
  })]),
  Object.freeze(["memory:static:frontend-src-features-products-model-use-product-sync-state:product-refresh-final-statuses", "36"]),
  Object.freeze(["memory:static:frontend-src-features-products-model-use-product-write-state:product-archive-write-failed-statuses", Object.freeze({
    sourceFile: "frontend/src/features/products/model/useProductWriteState.jsx",
    sourceSymbol: "isProductWriteReadbackComplete,",
    line: "20",
    ownerBasis: "the retired archive failure Set is replaced by the typed local-api readback completion classifier",
  })]),
  Object.freeze(["memory:static:frontend-src-features-products-model-use-product-write-state:product-archive-write-success-statuses", Object.freeze({
    sourceFile: "frontend/src/features/products/model/useProductWriteState.jsx",
    sourceSymbol: "isProductWriteReadbackComplete,",
    line: "20",
    ownerBasis: "the retired archive success Set is replaced by the typed local-api readback completion classifier",
  })]),
  Object.freeze(["memory:static:frontend-src-services-after-sales-reason-translate:after-sales-logistics-translations", "124"]),
  Object.freeze(["memory:static:frontend-src-services-after-sales-reason-translate:after-sales-reason-translations", "22"]),
  Object.freeze(["memory:static:frontend-src-services-ozon-order-experience:after-sales-classification-values", "113"]),
  Object.freeze(["memory:static:frontend-src-services-ozon-order-experience:after-sales-reason-field-keys", "120"]),
  Object.freeze(["memory:static:frontend-src-services-ozon-order-experience:ozon-after-sales-reason-id-translations", "175"]),
  Object.freeze(["memory:static:frontend-src-services-ozon-order-experience:ozon-after-sales-reason-translations", Object.freeze({
    sourceFile: "frontend/src/services/afterSalesReasonTranslate.js",
    sourceSymbol: "AFTER_SALES_REASON_TRANSLATIONS",
    line: "22",
    ownerBasis: "the deterministic Ozon after-sales translation table moved into the shared after-sales translation service",
  })]),
  Object.freeze(["memory:static:frontend-src-services-ozon-order-experience:product-picture-lookup-sources", "14"]),
  Object.freeze(["memory:static:frontend-src-services-product-material-profile-store:material-profile-known-legacy-fields", "282"]),
  Object.freeze(["memory:static:frontend-src-services-product-material-profile-store:material-profile-transient-fields", "281"]),
  Object.freeze(["memory:static:frontend-src-services-profit-ledger-service:placeholder-values", "28"]),
  Object.freeze(["memory:static:frontend-src-services-profit-ledger-service:profit-ledger-hash-volatile-keys", "1308"]),
  Object.freeze(["memory:static:frontend-src-services-purchase-order-runtime:purchase-empty-order-no-values", "624"]),
  Object.freeze(["memory:static:frontend-src-services-purchase-order-runtime:purchase-empty-platform-values", "626"]),
  Object.freeze(["memory:static:frontend-src-services-purchase-order-runtime:purchase-empty-price-values", "628"]),
  Object.freeze(["memory:static:frontend-src-services-purchase-order-runtime:purchase-override-protected-fields", Object.freeze({ sourceFile: "frontend/src/services/purchaseOrderOverrideRules.js", line: "38" })]),
  Object.freeze(["memory:static:frontend-src-services-purchase-plugin-context-store:purchase-plugin-context-envelope-fields", "50"]),
  Object.freeze(["memory:static:frontend-src-services-purchase-plugin-context-store:purchase-plugin-context-fields", "45"]),
  Object.freeze(["memory:static:frontend-src-shared-config-app-config-core:cross-border-legacy-empty-text", "547"]),
  Object.freeze(["memory:static:frontend-src-shared-config-app-config-core:purchase-direct-image-search-platforms", "545"]),
  Object.freeze(["memory:static:local-api-src-backup-recovery-importer:marketing-source-type-aliases", "52"]),
  Object.freeze(["memory:static:local-api-src-data-data-domain-registry:by-domain", "185"]),
  Object.freeze(["memory:static:local-api-src-data-data-domain-registry:by-table", "186"]),
  Object.freeze(["memory:static:local-api-src-db-repositories-product-repository:legacy-product-material-fields", Object.freeze({
    sourceFile: "local-api/src/db/repositories/productSupportModel.js",
    sourceSymbol: "LEGACY_PRODUCT_MATERIAL_FIELDS",
    line: "263",
    ownerBasis: "legacy material import field allowlist moved into the isolated support migration model",
  })]),
  Object.freeze(["memory:static:local-api-src-db-repositories-product-repository:sellable-product-visibilities", Object.freeze({
    sourceFile: "local-api/src/db/repositories/productCanonicalDto.js",
    sourceSymbol: "SELLABLE_PRODUCT_VISIBILITIES",
    line: "83",
    ownerBasis: "canonical product visibility enum moved into the shared DTO module",
  })]),
  Object.freeze(["memory:static:local-api-src-db-repositories-product-repository:strong-product-visibilities", Object.freeze({
    sourceFile: "local-api/src/db/repositories/productCanonicalDto.js",
    sourceSymbol: "STRONG_PRODUCT_VISIBILITIES",
    line: "76",
    ownerBasis: "canonical strong visibility enum moved into the shared DTO module",
  })]),
  Object.freeze(["memory:static:local-api-src-db-repositories-product-repository:weak-inferred-product-visibilities", Object.freeze({
    sourceFile: "local-api/src/db/repositories/productCanonicalDto.js",
    sourceSymbol: "WEAK_INFERRED_PRODUCT_VISIBILITIES",
    line: "82",
    ownerBasis: "canonical weak visibility enum moved into the shared DTO module",
  })]),
  Object.freeze(["memory:static:local-api-src-db-repositories-profile-settings-repository:profile-setting-namespace-set", "11"]),
  Object.freeze(["memory:static:local-api-src-db-repositories-profile-settings-repository:purchase-plugin-context-top-level-keys", "33"]),
  Object.freeze(["memory:static:local-api-src-ozon-traffic-controller:known-profiles", "33"]),
  Object.freeze(["memory:static:local-api-src-domain-products-products-service:product-hydration-modes", Object.freeze({
    sourceFile: "local-api/src/domain/products/productSyncService.js",
    sourceSymbol: "PRODUCT_HYDRATION_MODES",
    line: "27",
    ownerBasis: "product hydration mode enum moved into the isolated sync service",
  })]),
  Object.freeze(["runtime:continuous-sync-owner-state", Object.freeze({
    sourceFile: "local-api/src/sync/continuousSyncService.js",
    sourceSymbol: "const taskStatuses = new Map();",
    line: "87",
    ownerBasis: "task lifecycle is keyed by exact shopId",
  })]),
  Object.freeze(["runtime:local-api-performance-request-queue", Object.freeze({
    sourceFile: "local-api/src/integrations/performanceApiClient.js",
    sourceSymbol: "const performanceQueueStatesByOwner = new Map();",
    line: "13",
    ownerBasis: "queue, active, token, and in-flight indexes use the exact performance account id",
  })]),
  Object.freeze(["runtime:local-api-traffic-controller-mixed-state", Object.freeze({
    sourceFile: "local-api/src/ozon/trafficController.js",
    sourceSymbol: "const nextAllowedAt = new Map();",
    line: "106",
    ownerBasis: "all traffic keys begin with an exact shop scope",
  })]),
  Object.freeze(["runtime:local-api-ozon-client-endpoint-limiter", Object.freeze({
    sourceFile: "local-api/src/ozon/ozonClient.js",
    sourceSymbol: "const key = `${clientId}::${bucket}`;",
    line: "141",
    ownerBasis: "credential-scoped endpoint limiter",
  })]),
  Object.freeze(["runtime:ozon-request-queue", Object.freeze({
    sourceFile: "local-api/src/ozon/requestQueue.js",
    sourceSymbol: "const active = new Map();",
    line: "68",
    ownerBasis: "queue item carries exact shopId",
  })]),
  Object.freeze(["runtime:renderer-cross-border-settings-write-queue", Object.freeze({
    sourceFile: "frontend/src/shared/ozon/ozonRuntime.jsx",
    sourceSymbol: "let crossBorderSettingsWriteQueue = Promise.resolve();",
    line: "290",
    ownerBasis: "shared cross-border preference queue needs a future fence",
  })]),
  Object.freeze(["runtime:desktop-main-lifecycle-state", Object.freeze({
    sourceFile: "desktop/src/main.js",
    sourceSymbol: "runtimeInfo/desktopLicenseRuntime/isQuitting/profileLock/shutdownPromise/runtimeLifecycle",
    line: "35,177-182,708",
    ownerBasis: "desktop lifecycle system state; fence bootstrap/restart/shutdown",
  })]),
  Object.freeze(["runtime:desktop-profile-lock-handle", Object.freeze({
    sourceFile: "desktop/src/main.js",
    sourceSymbol: "profileLock",
    line: "181",
    ownerBasis: "profile-global active handle",
  })]),
  Object.freeze(["runtime:desktop-service-local-api-runtime", Object.freeze({
    sourceFile: "desktop/src/runtime/serviceRuntime.js",
    sourceSymbol: "localApiRuntime",
    line: "134",
    ownerBasis: "profile/process system runtime containing DB path/token/port/recoveryMode",
  })]),
  Object.freeze(["runtime:ozon-scheduler-active-queue", Object.freeze({
    sourceFile: "local-api/src/ozon/ozonScheduler.js",
    sourceSymbol: "const inFlight = new Map();",
    line: "433",
    ownerBasis: "job request carries exact shopId",
  })]),
  Object.freeze(["runtime:renderer-browser-local-storage-mirror", Object.freeze({
    sourceFile: "frontend/src/audit/retiredBrowserStorageAudit.js",
    sourceSymbol: "mirrorResource: 'memory:renderer-browser-local-storage-mirror-retired'",
    line: "11",
    ownerBasis: "the mirror runtime has been removed and stores no owner state",
  })]),
  Object.freeze(["runtime:renderer-legacy-browser-read-telemetry", Object.freeze({
    sourceFile: "frontend/src/audit/retiredBrowserStorageAudit.js",
    sourceSymbol: "telemetryResource: 'runtime:renderer-legacy-browser-read-telemetry-retired'",
    line: "12",
    ownerBasis: "the telemetry runtime has been removed and stores no owner state",
  })]),
  Object.freeze(["runtime:renderer-local-mirror-file-write-queues-unattributed", Object.freeze({
    sourceFile: "frontend/src/entities/product/productLocalData.jsx",
    sourceSymbol: "export let localMirrorReadLogWriteQueue",
    line: "382",
    ownerBasis: "legacy mirror queues have no owner key",
  })]),
  Object.freeze(["runtime:renderer-ozon-local-data-file-write-queues-unattributed", Object.freeze({
    sourceFile: "frontend/src/entities/product/productLocalData.jsx",
    sourceSymbol: "export const ozonLocalDataWriteQueues = new Map();",
    line: "394",
    ownerBasis: "file-key queue has no owner key",
  })]),
  Object.freeze(["runtime:renderer-profit-finance-cooldown-unattributed", Object.freeze({
    sourceFile: "frontend/src/shared/config/appConfigRuntime.jsx",
    sourceSymbol: "export const profitFinanceCooldown",
    line: "479",
    ownerBasis: "cooldown state has no one-owner selector",
  })]),
  Object.freeze(["runtime:renderer-prompt-library-write-queue", Object.freeze({
    sourceFile: "frontend/src/features/promptLibrary/lib/promptLibraryStore.jsx",
    sourceSymbol: "let promptLibraryWriteQueue = Promise.resolve();",
    line: "477",
    ownerBasis: "tool configuration queue is global",
  })]),
  Object.freeze(["runtime:renderer-purchase-order-override-local-api-write-queue", Object.freeze({
    sourceFile: "frontend/src/services/purchaseOrderRuntime.js",
    sourceSymbol: "export let purchaseOrderOverrideLocalApiWriteQueue = Promise.resolve();",
    line: "702",
    ownerBasis: "shared override write pipeline can backwrite multiple shops",
  })]),
  Object.freeze(["runtime:renderer-purchase-order-override-migration-task", Object.freeze({
    sourceFile: "frontend/src/services/purchaseOrderRuntime.js",
    sourceSymbol: "let activePurchaseOrderOverrideMigration = null;",
    line: "703",
    ownerBasis: "migration consumes legacy aggregate override state",
  })]),
  Object.freeze(["runtime:renderer-purchase-plugin-context-last-operation", Object.freeze({
    sourceFile: "frontend/src/services/purchasePluginContextStore.js",
    sourceSymbol: "let lastPurchasePluginContextOperation = Promise.resolve();",
    line: "60",
    ownerBasis: "shared completion promise can race context persistence",
  })]),
  Object.freeze(["runtime:renderer-purchase-plugin-context-migration-task", Object.freeze({
    sourceFile: "frontend/src/services/purchasePluginContextStore.js",
    sourceSymbol: "let activePurchasePluginSourceContextMigration = null;",
    line: "61",
    ownerBasis: "migration can republish legacy context",
  })]),
  Object.freeze(["runtime:renderer-purchase-plugin-context-write-queue", Object.freeze({
    sourceFile: "frontend/src/services/purchasePluginContextStore.js",
    sourceSymbol: "let purchasePluginContextWriteQueue = Promise.resolve();",
    line: "59",
    ownerBasis: "shared context write queue must be fenced before future removal",
  })]),
  Object.freeze(["runtime:renderer-purchase-supplement-cooldown-unattributed", Object.freeze({
    sourceFile: "frontend/src/shared/config/appConfigRuntime.jsx",
    sourceSymbol: "export const purchaseSupplementCooldown",
    line: "474",
    ownerBasis: "cooldown state has no one-owner selector",
  })]),
  Object.freeze(["runtime:renderer-sales-orders-page-load", Object.freeze({
    sourceFile: "frontend/src/appLazyRoutes.jsx",
    sourceSymbol: "let salesOrdersPageLoadPromise = null;",
    line: "48",
    ownerBasis: "lazy page load is global renderer runtime",
  })]),
  Object.freeze(["runtime:renderer-sales-supplement-cooldown-unattributed", Object.freeze({
    sourceFile: "frontend/src/shared/config/appConfigRuntime.jsx",
    sourceSymbol: "export const salesSupplementCooldown",
    line: "469",
    ownerBasis: "cooldown state has no one-owner selector",
  })]),
  Object.freeze(["runtime:renderer-watermark-settings-load-task", Object.freeze({
    sourceFile: "frontend/src/features/products/lib/productEditing.jsx",
    sourceSymbol: "let watermarkSettingsLoadPromise = null;",
    line: "96",
    ownerBasis: "watermark load task is global",
  })]),
  Object.freeze(["runtime:renderer-watermark-settings-write-queue", Object.freeze({
    sourceFile: "frontend/src/features/products/lib/productEditing.jsx",
    sourceSymbol: "let watermarkSettingsWriteQueue = Promise.resolve();",
    line: "95",
    ownerBasis: "watermark write queue is global",
  })]),
  Object.freeze(["runtime:renderer-workspace-performance", Object.freeze({
    sourceFile: "frontend/src/app/performance/workspacePerformanceRuntime.js",
    sourceSymbol: "export const workspacePerformanceRuntime = createWorkspacePerformanceRuntime();",
    line: "183",
    ownerBasis: "workspace performance runtime is global UI telemetry",
  })]),
]);

const EMPTY_SECONDARY_ANCHORS = Object.freeze([]);

function anchor(id, sourceFile, sourceSymbol, line, ownerBasis) {
  return Object.freeze({
    id,
    primaryAnchor: Object.freeze({ sourceFile, sourceSymbol, line, ownerBasis }),
    secondaryAnchors: EMPTY_SECONDARY_ANCHORS,
  });
}

export const ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY = Object.freeze([
  anchor("filesystem:desktop-local-api-sqlite-sidecars", "desktop/src/runtime/recoveryDatabaseActivator.js", "function databaseFamily(databasePath) {", "14", "profile database family; shared system state"),
  anchor("filesystem:desktop-process-supervisor-logs", "desktop/src/runtime/processSupervisor.js", "const logPath = path.join(getLogDirectory(), `${name}.log`);", "77", "supervisor logs are shared diagnostic output"),
  anchor("filesystem:desktop-recovery-shell-sqlite-sidecars", "desktop/src/runtime/desktopPaths.js", "function recoveryShellDatabasePath(activeDatabasePath = localApiDatabasePath()) {", "155", "recovery-shell.sqlite-wal/-shm; profile system state"),
  anchor("filesystem:legacy-classification-cache-root", "desktop/src/protocol/appProtocol.js", "const LOCAL_DATA_FILES = {", "18", "legacy local-data root can hold mixed/unclassified records"),
  anchor("filesystem:local-api-secret-key", "desktop/src/runtime/dataLayout.js", "secretPath: path.join(localApiDataRoot, \"local-api-secret.key\"),", "35", "profile 全局 key"),
  anchor("logical:local-data-product-material-profiles-shop-records", "frontend/src/services/productMaterialProfileStore.js", "export function saveProductMaterialProfiles(profiles) {", "210", "root is {[recordKey]: profile}; no profiles[] selector; record-map selector unsupported"),
  anchor("logical:local-data-product-source-links-shop-records", "frontend/src/services/productSourceLinkStore.js", "export async function saveProductSourceLinkRecord({ key, record, product = {}, timeoutMs = 3000 } = {}) {", "131", "owner exists in key ${shopId}:${productKey}; value has no shopId; key selector unsupported"),
  anchor("logical:local-data-purchase-order-overrides-shop-records", "frontend/src/services/purchaseOrderRuntime.js", "export function savePurchaseOrderOverridesToLocalApi(overrides = {}) {", "1406", "root is {[orderKey]: override}; no overrides[] selector; record-map selector unsupported"),
  anchor("logical:local-data-purchase-source-links-shop-records", "frontend/src/services/purchaseSourceLinkStore.js", "function mapPurchaseSourceRows(rows = []) {", "82", "owner exists in key ${shopId}:${orderKey}; value has no shopId; key selector unsupported"),
  anchor("logical:local-data-sales-source-links-shop-records", "frontend/src/services/salesSourceLinkStore.js", "function mapSalesSourceRows(rows = []) {", "74", "owner exists in key ${shopId}:${orderKey}; value has no shopId; key selector unsupported"),
  anchor("logical:profile-settings-purchase-plugin-context", "local-api/src/db/repositories/profileSettingsRepository.js", "const PURCHASE_PLUGIN_CONTEXT_NAMESPACE = \"purchase-plugin-context\";", "14", "无 `purchaseAccountId`"),
  anchor("logical:renderer-cross-border-settings-account-slice", "frontend/src/shared/ozon/crossBorderAuthorization.js", "export function getCrossBorderLocalApiAccountId(settings = {}) {", "10", "crossBorderAccountId/accountId"),
  anchor("logical:renderer-purchase-order-overrides-shop-records", "frontend/src/services/purchaseOrderRuntime.js", "export let purchaseOrderLocalOverridesMemory = null;", "698", "future resolver must inspect canonical row shopId rather than legacy order key"),
  anchor("memory:external-chrome-content-snapshots", "frontend/src/audit/retiredBrowserStorageAudit.js", "contentSnapshotResource: 'memory:external-chrome-content-snapshots'", "8", "the old content snapshot runtime is retired and stores no account data"),
  anchor("memory:external-chrome-popup-snapshots", "frontend/src/audit/retiredBrowserStorageAudit.js", "popupSnapshotResource: 'memory:external-chrome-popup-snapshots'", "10", "the old popup runtime is retired and stores no account state"),
  anchor("memory:local-api-hot-cache-shop-tag", "local-api/src/cache/cacheReadService.js", "tags: [", "139", "shop:${ownerId}"),
  anchor("memory:renderer-ozon-api-performance-counter", "frontend/src/shared/config/appConfigRuntime.jsx", "export const ozonApiPerformanceCounter = { count: 0 };", "413", "global performance counter; no business-owner anchor"),
  anchor("registry:analytics-daily", "local-api/src/data/dataDomainRegistry.js", "domain: 'analytics-daily'", "88", "DataDomainRegistry domain analytics-daily"),
  anchor("registry:catalog-attribute-values", "local-api/src/data/dataDomainRegistry.js", "domain: 'catalog-attribute-values'", "94", "DataDomainRegistry domain catalog-attribute-values"),
  anchor("registry:catalog-attributes", "local-api/src/data/dataDomainRegistry.js", "domain: 'catalog-attributes'", "93", "DataDomainRegistry domain catalog-attributes"),
  anchor("registry:catalog-cache-key-registry", "local-api/src/data/dataDomainRegistry.js", "domain: 'catalog-cache-key-registry'", "106", "DataDomainRegistry domain catalog-cache-key-registry"),
  anchor("registry:catalog-cache-keys", "local-api/src/data/dataDomainRegistry.js", "domain: 'catalog-cache-keys'", "105", "DataDomainRegistry domain catalog-cache-keys"),
  anchor("registry:catalog-cache-sync-state", "local-api/src/data/dataDomainRegistry.js", "domain: 'catalog-cache-sync-state'", "107", "DataDomainRegistry domain catalog-cache-sync-state"),
  anchor("registry:catalog-category-mappings", "local-api/src/data/dataDomainRegistry.js", "domain: 'catalog-category-mappings'", "92", "DataDomainRegistry domain catalog-category-mappings"),
  anchor("registry:catalog-category-nodes", "local-api/src/data/dataDomainRegistry.js", "domain: 'catalog-category-nodes'", "91", "DataDomainRegistry domain catalog-category-nodes"),
  anchor("registry:circuit-breakers", "local-api/src/data/dataDomainRegistry.js", "domain: 'circuit-breakers'", "116", "DataDomainRegistry domain circuit-breakers"),
  anchor("registry:cross-border-accounts", "local-api/src/data/dataDomainRegistry.js", "domain: 'cross-border-accounts'", "29", "DataDomainRegistry domain cross-border-accounts"),
  anchor("registry:cross-border-order-records", "local-api/src/data/dataDomainRegistry.js", "domain: 'cross-border-order-records'", "89", "DataDomainRegistry domain cross-border-order-records"),
  anchor("registry:data-analysis-snapshots", "local-api/src/data/dataDomainRegistry.js", "domain: 'data-analysis-snapshots'", "96", "DataDomainRegistry domain data-analysis-snapshots"),
  anchor("registry:data-analysis-sync-state", "local-api/src/data/dataDomainRegistry.js", "domain: 'data-analysis-sync-state'", "108", "DataDomainRegistry domain data-analysis-sync-state"),
  anchor("registry:exchange-rate-cache", "local-api/src/data/dataDomainRegistry.js", "domain: 'exchange-rate-cache'", "98", "DataDomainRegistry domain exchange-rate-cache"),
  anchor("registry:finance-transactions", "local-api/src/data/dataDomainRegistry.js", "domain: 'finance-transactions'", "47", "DataDomainRegistry domain finance-transactions"),
  anchor("registry:integration-profiles", "local-api/src/data/dataDomainRegistry.js", "domain: 'integration-profiles'", "33", "DataDomainRegistry domain integration-profiles"),
  anchor("registry:legacy-browser-observation-batches", "local-api/src/data/dataDomainRegistry.js", "domain: 'legacy-browser-observation-batches'", "126", "DataDomainRegistry domain legacy-browser-observation-batches"),
  anchor("registry:legacy-browser-observation-days", "local-api/src/data/dataDomainRegistry.js", "domain: 'legacy-browser-observation-days'", "123", "DataDomainRegistry domain legacy-browser-observation-days"),
  anchor("registry:legacy-browser-observation-sessions", "local-api/src/data/dataDomainRegistry.js", "domain: 'legacy-browser-observation-sessions'", "125", "DataDomainRegistry domain legacy-browser-observation-sessions"),
  anchor("registry:legacy-browser-read-key-days", "local-api/src/data/dataDomainRegistry.js", "domain: 'legacy-browser-read-key-days'", "124", "DataDomainRegistry domain legacy-browser-read-key-days"),
  anchor("registry:legacy-sync-state", "local-api/src/data/dataDomainRegistry.js", "domain: 'legacy-sync-state'", "122", "DataDomainRegistry domain legacy-sync-state"),
  anchor("registry:marketing-activities", "local-api/src/data/dataDomainRegistry.js", "domain: 'marketing-activities'", "50", "DataDomainRegistry domain marketing-activities"),
  anchor("registry:marketing-activity-products", "local-api/src/data/dataDomainRegistry.js", "domain: 'marketing-activity-products'", "62", "DataDomainRegistry domain marketing-activity-products"),
  anchor("registry:marketing-view-state", "local-api/src/data/dataDomainRegistry.js", "domain: 'marketing-view-state'", "77", "DataDomainRegistry domain marketing-view-state"),
  anchor("registry:model-api-accounts", "local-api/src/data/dataDomainRegistry.js", "domain: 'model-api-accounts'", "32", "DataDomainRegistry domain model-api-accounts"),
  anchor("registry:notification-events", "local-api/src/data/dataDomainRegistry.js", "domain: 'notification-events'", "119", "DataDomainRegistry domain notification-events"),
  anchor("registry:notification-settings", "local-api/src/data/dataDomainRegistry.js", "domain: 'notification-settings'", "43", "DataDomainRegistry domain notification-settings"),
  anchor("registry:order-split-relations", "local-api/src/data/dataDomainRegistry.js", "domain: 'order-split-relations'", "42", "DataDomainRegistry domain order-split-relations"),
  anchor("registry:orders", "local-api/src/data/dataDomainRegistry.js", "domain: 'orders'", "46", "DataDomainRegistry domain orders"),
  anchor("registry:performance-accounts", "local-api/src/data/dataDomainRegistry.js", "domain: 'performance-accounts'", "30", "DataDomainRegistry domain performance-accounts"),
  anchor("registry:product-image-health", "local-api/src/data/dataDomainRegistry.js", "domain: 'product-image-health'", "95", "DataDomainRegistry domain product-image-health"),
  anchor("registry:product-material-profiles", "local-api/src/data/dataDomainRegistry.js", "domain: 'product-material-profiles'", "41", "DataDomainRegistry domain product-material-profiles"),
  anchor("registry:product-source-links", "local-api/src/data/dataDomainRegistry.js", "domain: 'product-source-links'", "40", "DataDomainRegistry domain product-source-links"),
  anchor("registry:products", "local-api/src/data/dataDomainRegistry.js", "domain: 'products'", "45", "DataDomainRegistry domain products"),
  anchor("registry:profile-assets", "local-api/src/data/dataDomainRegistry.js", "domain: 'profile-assets'", "36", "DataDomainRegistry domain profile-assets"),
  anchor("registry:profile-settings", "local-api/src/data/dataDomainRegistry.js", "domain: 'profile-settings'", "35", "DataDomainRegistry domain profile-settings"),
  anchor("registry:profit-ledger-snapshots", "local-api/src/data/dataDomainRegistry.js", "domain: 'profit-ledger-snapshots'", "97", "DataDomainRegistry domain profit-ledger-snapshots"),
  anchor("registry:purchase-accounts", "local-api/src/data/dataDomainRegistry.js", "domain: 'purchase-accounts'", "31", "DataDomainRegistry domain purchase-accounts"),
  anchor("registry:purchase-overrides", "local-api/src/data/dataDomainRegistry.js", "domain: 'purchase-overrides'", "37", "DataDomainRegistry domain purchase-overrides"),
  anchor("registry:purchase-source-links", "local-api/src/data/dataDomainRegistry.js", "domain: 'purchase-source-links'", "38", "DataDomainRegistry domain purchase-source-links"),
  anchor("registry:rate-limit-state", "local-api/src/data/dataDomainRegistry.js", "domain: 'rate-limit-state'", "117", "DataDomainRegistry domain rate-limit-state"),
  anchor("registry:rating-penalties", "local-api/src/data/dataDomainRegistry.js", "domain: 'rating-penalties'", "87", "DataDomainRegistry domain rating-penalties"),
  anchor("registry:recovery-keyset", "local-api/src/data/dataDomainRegistry.js", "domain: 'recovery-keyset'", "28", "DataDomainRegistry domain recovery-keyset"),
  anchor("registry:recovery-reconcile-state", "local-api/src/data/dataDomainRegistry.js", "domain: 'recovery-reconcile-state'", "103", "DataDomainRegistry domain recovery-reconcile-state"),
  anchor("registry:request-jobs", "local-api/src/data/dataDomainRegistry.js", "domain: 'request-jobs'", "110", "DataDomainRegistry domain request-jobs"),
  anchor("registry:response-cache", "local-api/src/data/dataDomainRegistry.js", "domain: 'response-cache'", "104", "DataDomainRegistry domain response-cache"),
  anchor("registry:returns", "local-api/src/data/dataDomainRegistry.js", "domain: 'returns'", "48", "DataDomainRegistry domain returns"),
  anchor("registry:sales-source-links", "local-api/src/data/dataDomainRegistry.js", "domain: 'sales-source-links'", "39", "DataDomainRegistry domain sales-source-links"),
  anchor("registry:schema-migrations", "local-api/src/data/dataDomainRegistry.js", "domain: 'schema-migrations'", "127", "DataDomainRegistry domain schema-migrations"),
  anchor("registry:shop-credentials", "local-api/src/data/dataDomainRegistry.js", "domain: 'shop-credentials'", "26", "DataDomainRegistry domain shop-credentials"),
  anchor("registry:shop-runtime-state", "local-api/src/data/dataDomainRegistry.js", "domain: 'shop-runtime-state'", "118", "DataDomainRegistry domain shop-runtime-state"),
  anchor("registry:shops", "local-api/src/data/dataDomainRegistry.js", "domain: 'shops'", "25", "DataDomainRegistry domain shops"),
  anchor("registry:sync-jobs", "local-api/src/data/dataDomainRegistry.js", "domain: 'sync-jobs'", "121", "DataDomainRegistry domain sync-jobs"),
  anchor("registry:sync-locks", "local-api/src/data/dataDomainRegistry.js", "domain: 'sync-locks'", "113", "DataDomainRegistry domain sync-locks"),
  anchor("registry:sync-snapshots", "local-api/src/data/dataDomainRegistry.js", "domain: 'sync-snapshots'", "114", "DataDomainRegistry domain sync-snapshots"),
  anchor("registry:sync-state-runtime", "local-api/src/data/dataDomainRegistry.js", "domain: 'sync-state-runtime'", "102", "DataDomainRegistry domain sync-state-runtime"),
  anchor("registry:write-audit-log", "local-api/src/data/dataDomainRegistry.js", "domain: 'write-audit-log'", "120", "DataDomainRegistry domain write-audit-log"),
  anchor("runtime:desktop-license-runtime-promises", "desktop/src/licensing/licenseRuntime.js", "let deviceCodePromise;", "177", "安装/license 级"),
  anchor("runtime:external-chrome-content-pollers", "frontend/src/audit/retiredBrowserStorageAudit.js", "contentPollerResource: 'runtime:external-chrome-content-pollers'", "9", "the old content poller runtime is retired and cannot retain account work"),
]);
