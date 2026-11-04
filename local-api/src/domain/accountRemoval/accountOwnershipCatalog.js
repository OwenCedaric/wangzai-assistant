import { DATA_DOMAIN_REGISTRY } from '../../data/dataDomainRegistry.js';
import { ACCOUNT_OWNERSHIP_V8_EXTERNAL_INPUTS } from './accountOwnershipCatalogV8Extensions.js';
import { ACCOUNT_OWNERSHIP_V9_EXTERNAL_INPUTS } from './accountOwnershipCatalogV9Extensions.js';
export const ACCOUNT_OWNERSHIP_CATALOG_VERSION = 'account-ownership-catalog-v9';
export const ACCOUNT_OWNER_TYPES = Object.freeze([
  'system',
  'ozon_shop',
  'cross_border_bus',
  'promotion_account',
  'purchase_account',
  'model_api_account',
  'integration_profile',
  'unknown',
]);

const VALID_STORAGE_KINDS = new Set([
  'sqlite',
  'secret-vault',
  'filesystem',
  'memory',
  'runtime',
  'backup-remote',
  'browser-profile',
  'browser-storage',
  'browser-extension',
  'browser-download',
]);

const VALID_AVAILABILITY = new Set(['current', 'future-contract']);
const VALID_SCOPE_TYPES = new Set(['shop', 'profile', 'system', 'external']);
const VALID_VERIFY_QUERY_TYPES = new Set([
  'browser-artifact-absence',
  'browser-partition-unavailable',
  'browser-profile-absence',
  'diagnostic-log-owner-absence',
  'fail-closed',
  'json-file-owner-reference-absence',
  'json-record-map-owner-absence',
  'json-owner-reference-absence',
  'memory-owner-absence',
  'memory-tag-absence',
  'preserve',
  'protection-owner-absence',
  'remote-owner-absence',
  'runtime-owner-count',
  'runtime-owner-state',
  'secret-vault-absence',
  'shop-storage-scope-absence',
  'sqlite-account-row-absence',
  'sqlite-count',
]);

// Catalog IDs are persisted into previews/fingerprints.  Keep their namespace
// and token grammar closed so a malformed ID cannot silently become a new
// execution target when Phase C eventually supplies primitives.
const CATALOG_ID_PATTERN = /^(?:registry|logical|filesystem|memory|runtime|browser|backup):[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)*$/u;
const SQL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const RUNTIME_OWNER_STATE_EXPECTED = new Set([
  'paused-and-absent',
  'stopped-or-owner-write-fenced',
]);
const OWNER_RESOLVER_ALLOWLIST = new Set([
  'collection-listing-category-template-shop-slice',
  'cross-border-settings-account-slice',
  'diagnostic-log-owner',
  'local-api-products-hot-cache-shop-scope',
  'model-api-interface-id',
  'ozon-endpoint-limiter-shop-key',
  'ozon-shop-client-id',
  'ozon-shop-settings-shop-slice',
  'product-material-profile-shop-slice',
  'local-data-shop-record-map',
  'purchase-bridge-shop-context',
  'purchase-plugin-shop-context',
  'renderer-ozon-snapshot-owner-cache',
  'renderer-product-list-owner-cache',
  'purchase-override-shop-record',
  'rate-limit-shop-state',
  'recovery-owner-ref',
  'recovery-protection-owner',
  'shop-aggregate-index-scope',
  'shop-database-scope',
  'purchase-browser-owner-ref',
  'purchase-browser-task-runtime',
  'performance-account-runtime',
  'traffic-controller-shop-state',
]);
const JSON_PATH_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\[\]|\[[A-Za-z_$][A-Za-z0-9_$]*\])|(?:\.[A-Za-z_$][A-Za-z0-9_$]*(?:\[\]|\[[A-Za-z_$][A-Za-z0-9_$]*\])?))*$/u;
const PROPERTY_PATH_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/u;
const SOURCE_FILE_PATTERN = /^(?:frontend|local-api|desktop)\/[A-Za-z0-9_./-]+\.(?:[cm]?js|jsx|json)$/u;
const CATALOG_ENTRY_FIELDS = new Set([
  'id',
  'storageKind',
  'resource',
  'scopeType',
  'ownerType',
  'ownerField',
  'deletePrimitive',
  'verifyQuery',
  'preserveRule',
  'backupRule',
  'risk',
  'removable',
  'availability',
  'executionGroup',
  'sourceRegistryDomain',
  'sourceProtocolKey',
  'directory',
  'fileName',
  'relativePath',
  'sourceEvidence',
  'coverageAudit',
]);

// The verifier vocabulary is not interchangeable.  This matrix prevents a
// browser or runtime verifier from being attached to a SQLite resource merely
// because its fields happen to type-check.
const STORAGE_VERIFY_MATRIX = Object.freeze({
  sqlite: Object.freeze(['fail-closed', 'json-owner-reference-absence', 'preserve', 'sqlite-count']),
  'secret-vault': Object.freeze(['fail-closed', 'preserve', 'secret-vault-absence', 'sqlite-account-row-absence']),
  filesystem: Object.freeze(['diagnostic-log-owner-absence', 'fail-closed', 'json-file-owner-reference-absence', 'json-record-map-owner-absence', 'preserve', 'protection-owner-absence', 'shop-storage-scope-absence']),
  memory: Object.freeze(['fail-closed', 'memory-owner-absence', 'memory-tag-absence', 'preserve']),
  runtime: Object.freeze(['fail-closed', 'preserve', 'runtime-owner-count', 'runtime-owner-state']),
  'backup-remote': Object.freeze(['fail-closed', 'preserve', 'remote-owner-absence']),
  'browser-profile': Object.freeze(['browser-partition-unavailable', 'browser-profile-absence', 'fail-closed', 'preserve']),
  'browser-storage': Object.freeze(['browser-artifact-absence', 'fail-closed', 'preserve']),
  'browser-extension': Object.freeze(['browser-artifact-absence', 'fail-closed', 'preserve']),
  'browser-download': Object.freeze(['browser-artifact-absence', 'fail-closed', 'preserve']),
});

// The catalog may describe a resource only when its declared owner and scope
// agree.  Selector grammar is checked separately and is mandatory for every
// current resource that can enter a plan.
const OWNER_SCOPE_MATRIX = Object.freeze({
  system: Object.freeze({
    system: Object.freeze({}),
    profile: Object.freeze({}),
  }),
  unknown: Object.freeze({
    external: Object.freeze({}),
    profile: Object.freeze({}),
  }),
  ozon_shop: Object.freeze({
    shop: Object.freeze({}),
    profile: Object.freeze({}),
    external: Object.freeze({}),
  }),
  cross_border_bus: Object.freeze({
    profile: Object.freeze({}),
    external: Object.freeze({}),
  }),
  promotion_account: Object.freeze({
    profile: Object.freeze({}),
    external: Object.freeze({}),
  }),
  purchase_account: Object.freeze({
    profile: Object.freeze({}),
    external: Object.freeze({}),
  }),
  model_api_account: Object.freeze({
    profile: Object.freeze({}),
    external: Object.freeze({}),
  }),
  integration_profile: Object.freeze({
    profile: Object.freeze({}),
    external: Object.freeze({}),
  }),
});

const PROFILE_OWNER_ADAPTERS = Object.freeze({
  shops: { ownerType: 'ozon_shop', ownerField: 'sqlite-column:id', removable: true },
  'shop-credentials': { ownerType: 'ozon_shop', ownerField: 'sqlite-column:shop_id', removable: true },
  'cross-border-accounts': { ownerType: 'cross_border_bus', ownerField: 'sqlite-column:id', removable: true },
  'performance-accounts': { ownerType: 'promotion_account', ownerField: 'sqlite-column:id', removable: true },
  'purchase-accounts': { ownerType: 'purchase_account', ownerField: 'sqlite-column:id', removable: true },
  'purchase-browser-tasks': { ownerType: 'purchase_account', ownerField: 'sqlite-column:owner_id', removable: true },
  'purchase-browser-receipts': { ownerType: 'purchase_account', ownerField: 'sqlite-column:owner_id', removable: true },
  'purchase-browser-plugin-state': { ownerType: 'purchase_account', ownerField: 'sqlite-column:owner_id', removable: true },
  'model-api-accounts': { ownerType: 'model_api_account', ownerField: 'sqlite-column:id', removable: true },
  'integration-profiles': { ownerType: 'integration_profile', ownerField: 'sqlite-column:id', removable: true },
  'integration-credentials': { ownerType: 'integration_profile', ownerField: 'sqlite-column:profile_id', removable: true },
});

function exactShopTechnicalTableAdapter(table) {
  return Object.freeze({
    ownerType: 'ozon_shop',
    ownerField: 'sqlite-column:shop_id',
    scopeType: 'shop',
    removable: true,
    verifyQuery: Object.freeze({
      type: 'sqlite-count',
      table,
      ownerField: 'shop_id',
      ownerPredicate: 'shop_id = :ownerId',
      expected: 'zero',
    }),
    preserveRule: 'only rows whose non-empty shop_id exactly equals ownerId are eligible; NULL/global diagnostic rows and every other shop are preserved',
    risk: 'technical table has nullable shop_id; a future primitive must use an exact shop_id predicate and must never delete NULL/global rows',
  });
}

// DataDomainRegistry correctly marks these as rebuildable technical data, but
// their physical rows still carry an exact optional shop_id.  Phase B models
// that row scope explicitly instead of treating a whole system table as safe
// to remove or silently guessing ownership for its NULL rows.
const REGISTRY_OWNER_ADAPTERS = Object.freeze({
  shops: Object.freeze({
    ownerType: 'ozon_shop',
    ownerField: 'sqlite-column:id',
    removable: true,
    deletePrimitive: 'future:accountRemoval.shopAccountAggregatePrimitive',
    verifyQuery: Object.freeze({
      type: 'sqlite-count',
      table: 'shops',
      ownerField: 'id',
      ownerPredicate: 'id = :ownerId',
      expected: 'zero',
    }),
    preserveRule: 'only the exact shops.id account row is eligible; all other shop account rows are preserved',
    risk: 'shop account metadata and encrypted credentials share one physical row and must be handled by one future aggregate primitive',
    executionGroup: 'shop-account-row',
  }),
  'secret-vault:shops': Object.freeze({
    ownerType: 'ozon_shop',
    ownerField: 'sqlite-column:id',
    removable: true,
    resource: 'shops.client_id/api_key_encrypted (encrypted credential fields in the shop account row)',
    deletePrimitive: 'future:accountRemoval.shopAccountAggregatePrimitive',
    verifyQuery: Object.freeze({ type: 'sqlite-account-row-absence', table: 'shops', ownerField: 'id', expected: 'absent-with-account' }),
    preserveRule: 'credential fields are part of the same exact shop account row; they must never receive a second independent delete pass',
    risk: 'DataDomainRegistry exposes a logical secret-vault domain, but the encrypted credential columns share the shops row with account metadata',
    executionGroup: 'shop-account-row',
  }),
  ozon_request_attempts: exactShopTechnicalTableAdapter('ozon_request_attempts'),
  ozon_cache_merge_log: exactShopTechnicalTableAdapter('ozon_cache_merge_log'),
  ozon_error_events: exactShopTechnicalTableAdapter('ozon_error_events'),
  ozon_scheduler_trace_events: exactShopTechnicalTableAdapter('ozon_scheduler_trace_events'),
  profit_ledger_snapshots: Object.freeze({
    ownerType: 'unknown',
    ownerField: 'snapshot_key/logical_scope can represent zero, one, or multiple shops',
    removable: false,
    preserveRule: 'mixed-scope profit snapshots are preserved until an authoritative single-owner key contract exists',
    risk: 'snapshot keys can aggregate more than one shop; no account removal may infer ownership from key text',
  }),
});

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((child) => deepFreeze(child, seen));
  return Object.freeze(value);
}

function sourceEvidence(sourceFile, sourceSymbol, ownerBasis) {
  return Object.freeze({ sourceFile, sourceSymbol, ownerBasis });
}

// Each current non-registry resource must retain an auditable production anchor.
// This is intentionally an ID -> source map rather than an inferred path from
// a display string: an ownership declaration is invalid when its source state
// stops existing or moves without updating the declaration.
const EXTERNAL_SOURCE_EVIDENCE = Object.freeze({
  'memory:purchase-search-bridge-context-unattributed': sourceEvidence('frontend/scripts/purchase-bridge/plugin-store.mjs', 'let purchasePluginContext = {};', 'bridge context has no purchaseAccountId'),
  'memory:purchase-search-bridge-captures-unattributed': sourceEvidence('frontend/scripts/purchase-bridge/plugin-store.mjs', 'let purchasePluginCaptures = [];', 'bridge captures have no authoritative purchaseAccountId'),
  'memory:purchase-search-bridge-pdd-image-title-cache-unattributed': sourceEvidence('frontend/scripts/purchase-bridge/pdd-title-search-service.mjs', 'const pddImageTitleCache = new Map();', 'bounded image URL cache has no authoritative purchase account or Ozon shop owner'),
  'browser:external-chrome-extension-profile-unattributed': sourceEvidence('frontend/src/audit/retiredBrowserStorageAudit.js', "profileResource: 'browser:external-chrome-extension-profile-unattributed'", 'the old external Chrome profile has been retired and has no runtime owner state'),
  'browser:external-chrome-extension-storage-unattributed': sourceEvidence('frontend/src/audit/retiredBrowserStorageAudit.js', "storageResource: 'browser:external-chrome-extension-storage-unattributed'", 'the old external Chrome storage has been retired and has no runtime owner state'),
  'runtime:desktop-recovery-auto-backup-scheduler': sourceEvidence('desktop/src/licensing/recoveryAutoBackupScheduler.js', 'timer/running/status', 'process-global recovery scheduler; no business-owner anchor'),
  'memory:local-api-write-guard-previews': sourceEvidence('local-api/src/security/writeGuardService.js', 'previews.set(previewId, {', 'preview records carry exact shopId only for a future scoped invalidation'),
  'memory:renderer-ozon-shop-settings-unattributed': sourceEvidence('frontend/src/services/ozonShopSettingsStore.js', 'export let ozonShopSettingsMemory = null;', 'aggregate renderer memory can include multiple shops'),
  'runtime:renderer-ozon-shop-settings-write-queue': sourceEvidence('frontend/src/services/ozonShopSettingsStore.js', 'let ozonShopSettingsWriteQueue = Promise.resolve();', 'shared queue can write multiple shop preferences'),
  'memory:renderer-purchase-order-local-overrides-unattributed': sourceEvidence('frontend/src/services/purchaseOrderRuntime.js', 'export let purchaseOrderLocalOverridesMemory = null;', 'legacy override keys do not prove one shop'),
  'memory:renderer-purchase-order-override-local-api-hashes-unattributed': sourceEvidence('frontend/src/services/purchaseOrderRuntime.js', 'export const purchaseOrderOverrideLocalApiHashes = new Map();', 'dedupe hashes are keyed by non-authoritative order keys'),
  'runtime:renderer-purchase-order-override-local-api-write-queue': sourceEvidence('frontend/src/services/purchaseOrderRuntime.js', 'export let purchaseOrderOverrideLocalApiWriteQueue = Promise.resolve();', 'shared override write pipeline can backwrite multiple shops'),
  'runtime:renderer-purchase-order-override-migration-task': sourceEvidence('frontend/src/services/purchaseOrderRuntime.js', 'let activePurchaseOrderOverrideMigration = null;', 'migration consumes legacy aggregate override state'),
  'memory:renderer-purchase-plugin-source-context-unattributed': sourceEvidence('frontend/src/services/purchasePluginContextStore.js', 'export let purchasePluginSourceContextMemory = null;', 'context lacks an authoritative purchaseAccountId'),
  'runtime:renderer-purchase-plugin-context-write-queue': sourceEvidence('frontend/src/services/purchasePluginContextStore.js', 'let purchasePluginContextWriteQueue = Promise.resolve();', 'shared context write queue must be fenced before future removal'),
  'runtime:renderer-purchase-plugin-context-last-operation': sourceEvidence('frontend/src/services/purchasePluginContextStore.js', 'let lastPurchasePluginContextOperation = Promise.resolve();', 'shared completion promise can race context persistence'),
  'runtime:renderer-purchase-plugin-context-migration-task': sourceEvidence('frontend/src/services/purchasePluginContextStore.js', 'let activePurchasePluginSourceContextMigration = null;', 'migration can republish legacy context'),
  'runtime:renderer-purchase-plugin-context-revision-guard': sourceEvidence('frontend/src/services/purchasePluginContextStore.js', 'let purchasePluginContextRevision = 0;', 'shared revision guard coordinates queued context publication'),
  'memory:renderer-cross-border-settings-unattributed': sourceEvidence('frontend/src/shared/ozon/ozonRuntime.jsx', 'export let crossBorderSettingsMemory = null;', 'memory can use default-account fallback'),
  'runtime:renderer-cross-border-settings-write-queue': sourceEvidence('frontend/src/shared/ozon/ozonRuntime.jsx', 'let crossBorderSettingsWriteQueue = Promise.resolve();', 'shared cross-border preference queue needs a future fence'),
  'memory:desktop-license-session-store-memory': sourceEvidence('desktop/src/licensing/licenseSessionStore.js', 'this.memory = cleanSession(EMPTY_SESSION);', 'license state is device/profile system scope'),
  'runtime:desktop-license-session-load-task': sourceEvidence('desktop/src/licensing/licenseSessionStore.js', 'this.loadPromise = null;', 'license load promise is installation scoped'),
  'runtime:desktop-license-session-operation-queue': sourceEvidence('desktop/src/licensing/licenseSessionStore.js', 'this.operationQueue = Promise.resolve();', 'license queue is installation scoped'),
  'runtime:desktop-license-device-code-load-task': sourceEvidence('desktop/src/licensing/licenseSessionStore.js', 'this.deviceCodePromise = null;', 'device-code task is installation scoped'),
  'memory:desktop-purchase-bridge-auth-token': sourceEvidence('desktop/src/runtime/purchaseBridgeState.js', 'const authToken = crypto.randomBytes(32).toString("base64url");', 'bridge capability token has no purchaseAccount owner'),
  'memory:renderer-product-list-memory-cache-unattributed': sourceEvidence('frontend/src/entities/product/productLocalData.jsx', 'export const productListMemoryCache = new Map();', 'cache keys allow client/id/label fallback'),
  'memory:renderer-product-list-page-meta-cache-unattributed': sourceEvidence('frontend/src/entities/product/productLocalData.jsx', 'export const productListPageMetaMemoryCache = new Map();', 'page metadata keys allow non-authoritative shop fallback'),
  'memory:renderer-product-list-cursor-cache-unattributed': sourceEvidence('frontend/src/entities/product/productLocalData.jsx', 'export const productListCursorMemoryCache = new Map();', 'cursor keys allow non-authoritative shop fallback'),
  'memory:renderer-ozon-snapshot-memory-cache-unattributed': sourceEvidence('frontend/src/shared/config/appConfigRuntime.jsx', 'export const ozonSnapshotMemoryCache = new Map();', 'snapshot cache can aggregate sources'),
  'memory:renderer-ozon-snapshot-inflight-unattributed': sourceEvidence('frontend/src/shared/config/appConfigRuntime.jsx', 'export const ozonSnapshotInFlight = new Map();', 'in-flight snapshot key can aggregate sources'),
  'memory:renderer-ozon-snapshot-manual-refresh-unattributed': sourceEvidence('frontend/src/shared/config/appConfigRuntime.jsx', 'export const ozonSnapshotManualRefreshAt = new Map();', 'manual refresh key has no owner contract'),
  'runtime:renderer-sales-supplement-cooldown-unattributed': sourceEvidence('frontend/src/shared/config/appConfigRuntime.jsx', 'export const salesSupplementCooldown', 'cooldown state has no one-owner selector'),
  'runtime:renderer-purchase-supplement-cooldown-unattributed': sourceEvidence('frontend/src/shared/config/appConfigRuntime.jsx', 'export const purchaseSupplementCooldown', 'cooldown state has no one-owner selector'),
  'runtime:renderer-profit-finance-cooldown-unattributed': sourceEvidence('frontend/src/shared/config/appConfigRuntime.jsx', 'export const profitFinanceCooldown', 'cooldown state has no one-owner selector'),
  'memory:renderer-sales-order-paged-cache-unattributed': sourceEvidence('frontend/src/services/salesOrderPagedCacheClient.js', 'const salesOrderPagedMemoryCache = new Map();', 'one cached query may aggregate shopIds'),
  'memory:renderer-profit-finance-operation-cache': sourceEvidence('frontend/src/entities/profit/profitFinanceEvidence.jsx', 'const profitFinanceOperationCache = new Map();', 'future scope must resolve canonical Ozon shop/client id'),
  'memory:renderer-profit-after-sales-snapshot-cache': sourceEvidence('frontend/src/entities/profit/profitFinanceEvidence.jsx', 'const profitAfterSalesSnapshotCache = new Map();', 'future scope must resolve canonical Ozon shop/client id'),
  'memory:renderer-profit-rating-penalty-operation-cache': sourceEvidence('frontend/src/entities/profit/profitLedgerMapping.jsx', 'const profitRatingPenaltyOperationCache = new Map();', 'future scope must resolve canonical Ozon shop/client id'),
  'memory:renderer-ozon-order-supplement-cache-unattributed': sourceEvidence('frontend/src/services/ozonOrderExperience.js', 'const supplementCache = new Map();', 'supplement cache falls back across several shop labels'),
  'memory:renderer-ozon-order-image-preload-cache-unattributed': sourceEvidence('frontend/src/services/ozonOrderExperience.js', 'const imagePreloadCache = new Map();', 'image URL alone has no account owner'),
  'memory:renderer-local-api-active-issues-unattributed': sourceEvidence('frontend/src/api/localApiClient.js', 'const localApiActiveIssues = new Map();', 'issues are keyed by request path'),
  'memory:renderer-local-api-sync-jobs-unattributed': sourceEvidence('frontend/src/api/localApiClient.js', 'const localApiSyncJobs = new Map();', 'jobs are keyed by jobId without renderer owner proof'),
  'memory:local-api-exchange-rate-daily-cache': sourceEvidence('local-api/src/domain/exchange/exchangeRateService.js', 'const dailyRateCache = new Map();', 'exchange rate cache is date/global system state'),
  'runtime:local-api-exchange-rate-batch-inflight': sourceEvidence('local-api/src/domain/exchange/exchangeRateService.js', 'const dailyBatchInflight = new Map();', 'exchange rate batch is date/global system state'),
  'memory:local-api-software-category-name-index': sourceEvidence('local-api/src/cache/catalog/softwareCategoryNameService.js', 'let categoryIndexCache = null;', 'versioned SQLite shared-catalog L0 projection is profile-shared system state'),
  'runtime:local-api-traffic-controller-mixed-state': sourceEvidence('local-api/src/ozon/trafficController.js', 'const nextAllowedAt = new Map();', 'all traffic keys begin with an exact shop scope'),
  'memory:local-api-rate-limit-state-mixed-next-allowed': sourceEvidence('local-api/src/ozon/rateLimitState.js', 'const nextAllowedAt = new Map();', 'stateKey rejects requests without an exact shopId'),
  'runtime:renderer-ozon-request-control-queue-unattributed': sourceEvidence('frontend/src/services/ozonRequestControl.js', 'const queuesByShop = new Map();', 'one independent renderer queue exists per exact shop key'),
  'memory:renderer-ozon-request-control-inflight-issues-unattributed': sourceEvidence('frontend/src/services/ozonRequestControl.js', 'const inFlightByDedupeKey = new Map();', 'dedupe keys are prefixed by the exact shop key'),
  'runtime:desktop-app-protocol-file-write-queues': sourceEvidence('desktop/src/protocol/appProtocol.js', 'const writeQueues = new Map();', 'one file-path queue can carry mixed legacy JSON writes'),
  'runtime:renderer-local-mirror-file-write-queues-unattributed': sourceEvidence('frontend/src/entities/product/productLocalData.jsx', 'export let localMirrorReadLogWriteQueue', 'legacy mirror queues have no owner key'),
  'runtime:renderer-ozon-local-data-file-write-queues-unattributed': sourceEvidence('frontend/src/entities/product/productLocalData.jsx', 'export const ozonLocalDataWriteQueues = new Map();', 'file-key queue has no owner key'),
  'filesystem:desktop-data-profile-json': sourceEvidence('desktop/src/runtime/dataLayout.js', 'profilePath: path.join(root, "profile.json")', 'profile file spans system and account domains'),
  'filesystem:desktop-data-logs-directory': sourceEvidence('desktop/src/runtime/dataLayout.js', 'logDirectory: path.join(root, "logs")', 'log directory is shared system scope'),
  'filesystem:desktop-runtime-profile-lock': sourceEvidence('desktop/src/runtime/dataLayout.js', 'profileLockPath: path.join(root, "runtime", "profile.lock")', 'lock is installation-wide'),
  'filesystem:desktop-backups-directory-unattributed': sourceEvidence('desktop/src/runtime/dataLayout.js', 'backupDirectory: path.join(root, "backups")', 'backup directory may contain mixed generations'),
  'filesystem:desktop-tmp-directory-unattributed': sourceEvidence('desktop/src/runtime/dataLayout.js', 'temporaryDirectory: path.join(root, "tmp")', 'temporary directory may contain mixed work'),
  'filesystem:desktop-local-api-data-root': sourceEvidence('desktop/src/runtime/dataLayout.js', 'const localApiDataRoot = path.join(root, "local-api-data");', 'shared local-api root is not an owner boundary'),
  'filesystem:desktop-local-api-sqlite-file': sourceEvidence('desktop/src/runtime/dataLayout.js', 'databasePath: path.join(localApiDataRoot, "wangzai-local-api.sqlite")', 'database file contains all owners'),
  'filesystem:local-api-secret-key': sourceEvidence('local-api/src/security/secretCrypto.js', 'const DEFAULT_SECRET_FILE = resolve(', 'key material protects multiple owner domains'),
  'filesystem:desktop-license-session': sourceEvidence('desktop/src/licensing/licenseSessionStore.js', 'this.sessionPath = path.join(directory, "license-session.bin")', 'license session is device/profile system scope'),
  'filesystem:desktop-license-device-id': sourceEvidence('desktop/src/licensing/licenseSessionStore.js', 'this.devicePath = path.join(directory, "license-device-id")', 'device id is installation system scope'),
  'filesystem:desktop-purchase-bridge-license-state': sourceEvidence('desktop/src/runtime/purchaseBridgeState.js', 'const statePath = path.join(directory, "purchase-bridge-license.json")', 'bridge license state has no purchaseAccount binding'),
  'runtime:desktop-process-supervisor-child-processes': sourceEvidence('desktop/src/runtime/processSupervisor.js', 'const childProcesses = new Map();', 'supervisor owns shared local-api and bridge processes'),
  'filesystem:desktop-process-supervisor-logs': sourceEvidence('desktop/src/runtime/processSupervisor.js', 'const logPath = path.join(getLogDirectory(), `${name}.log`);', 'supervisor logs are shared diagnostic output'),
  'filesystem:legacy-classification-cache-root': sourceEvidence('desktop/src/protocol/appProtocol.js', 'const LOCAL_DATA_FILES = {', 'legacy local-data root can hold mixed/unclassified records'),
  'filesystem:retired-purchase-plugin-context': sourceEvidence('desktop/src/protocol/appProtocol.js', 'RETIRED_PURCHASE_PLUGIN_CONTEXT_FILE', 'retired context has no authoritative purchase owner'),
  'filesystem:retired-marketing-activity-cache': sourceEvidence('desktop/src/protocol/appProtocol.js', 'RETIRED_MARKETING_ACTIVITY_CACHE_FILE', 'retired marketing cache may span shops'),
  'filesystem:software-category-tree-static': sourceEvidence('local-api/src/domain/catalog/sharedCatalogService.js', "return resolve(currentDir, '../../../assets/ozonCategoryTree.zh.json');", 'local-api packaged seed asset is immutable profile-independent system data'),
  'memory:local-api-hot-cache-l1': sourceEvidence('local-api/src/cache/hotCacheService.js', 'tags: normalizeTags(setOptions.tags)', 'shop:${ownerId} tag is the only exact L1 scope'),
  'memory:local-api-hot-cache-shop-tag': sourceEvidence('local-api/src/cache/hotCacheService.js', 'tags: normalizeTags(setOptions.tags)', 'shop:${ownerId} tag is the only exact L1 scope'),
  'memory:renderer-local-data-read-cache-l0': sourceEvidence('frontend/src/shared/config/appConfigCore.jsx', 'export const localDataFileReadCache = new Map();', 'legacy local-data read key lacks authoritative owner'),
  'memory:catalog-cache-active-jobs': sourceEvidence('local-api/src/cache/catalog/catalogCacheService.js', 'const jobs = new Map();', 'job.shopId is an exact future quiesce selector'),
  'memory:performance-access-token-cache': sourceEvidence('local-api/src/integrations/performanceApiClient.js', 'const performanceTokenReuseByAccount = new Map();', 'performanceTokenKeysByOwner binds reusable token keys to the exact performance account id'),
  'memory:performance-inflight-request-cache': sourceEvidence('local-api/src/integrations/performanceApiClient.js', 'const performanceOverviewInFlightReads = new Map();', 'request key accepts multiple account/client forms'),
  'memory:customer-message-translation-cache': sourceEvidence('local-api/src/domain/customerService/customerMessageTranslationService.js', 'const memoryCache = new Map();', 'text-derived cache key has no owner'),
  'runtime:ozon-scheduler-active-queue': sourceEvidence('local-api/src/ozon/ozonScheduler.js', 'const inFlight = new Map();', 'job request carries exact shopId'),
  'runtime:ozon-request-queue': sourceEvidence('local-api/src/ozon/requestQueue.js', 'const active = new Map();', 'queue item carries exact shopId'),
  'runtime:continuous-sync-owner-state': sourceEvidence('local-api/src/sync/continuousSyncService.js', 'const taskStatuses = new Map();', 'task lifecycle is keyed by exact shopId'),
  'filesystem:recovery-staging-root': sourceEvidence('local-api/src/backup/recoveryStagingService.js', "const stagingRoot = join(dirname(activeDatabasePath), 'restore-staging');", 'staging database can contain a complete mixed profile'),
  'backup:remote-recovery-generation-shared-profile': sourceEvidence('local-api/src/backup/recoveryGeneration.js', 'export function createRecoveryGeneration({', 'generation combines profile candidate and shop candidate'),
  'backup:remote-recovery-generation-chunks-shared-profile': sourceEvidence('local-api/src/backup/recoveryGeneration.js', 'chunkId', 'chunk references can be shared by one generation'),
  'backup:remote-recovery-generation-key-envelope-shared-profile': sourceEvidence('local-api/src/backup/recoveryGeneration.js', 'keyEnvelope', 'key envelope wraps mixed generation material'),
  'browser:electron-default-session-unattributed': sourceEvidence('desktop/src/window/mainWindow.js', 'const guardedSession = webContents.session;', 'current BrowserWindow does not use a per-account partition'),
  'logical:profile-settings-ozon-shop-preferences': sourceEvidence('frontend/src/services/ozonShopSettingsStore.js', 'ozon-shop-preferences', 'logical preference slice is a future exact shop contract'),
  'logical:profile-settings-purchase-plugin-context': sourceEvidence('frontend/src/services/purchasePluginContextStore.js', 'purchase-plugin-context', 'context does not prove a purchase account'),
  'runtime:purchase-task-queue': sourceEvidence('local-api/src/domain/purchaseBrowser/purchaseBrowserTaskService.js', 'function getAccountRemovalStatus(owner) {', 'active task count and owner fence are keyed by exact purchase account id'),
  'browser:purchase-profile-identity': sourceEvidence('desktop/src/purchaseBrowser/cefPurchaseBrowserController.js', 'profileStore.remove(binding);', 'encrypted identity records use an HMAC owner reference derived from account id plus incarnation'),
  'browser:purchase-persistent-partition': sourceEvidence('desktop/src/purchaseBrowser/cefPurchaseBrowserController.js', 'async function purgeOperation(operationId) {', 'the CEF profile directory is derived only from the HMAC owner reference'),
  'browser:purchase-cookies': sourceEvidence('desktop/src/purchaseBrowser/cefPurchaseBrowserController.js', 'export const PURCHASE_BROWSER_PURGE_RESOURCE_IDS = Object.freeze([', 'cookies are removed with and read back from the exact owner CEF profile'),
  'browser:purchase-local-storage': sourceEvidence('desktop/src/purchaseBrowser/cefPurchaseBrowserController.js', 'export const PURCHASE_BROWSER_PURGE_RESOURCE_IDS = Object.freeze([', 'localStorage is removed with and read back from the exact owner CEF profile'),
  'browser:purchase-indexed-db': sourceEvidence('desktop/src/purchaseBrowser/cefPurchaseBrowserController.js', 'export const PURCHASE_BROWSER_PURGE_RESOURCE_IDS = Object.freeze([', 'IndexedDB is removed with and read back from the exact owner CEF profile'),
  'browser:purchase-cache-storage': sourceEvidence('desktop/src/purchaseBrowser/cefPurchaseBrowserController.js', 'export const PURCHASE_BROWSER_PURGE_RESOURCE_IDS = Object.freeze([', 'CacheStorage is removed with and read back from the exact owner CEF profile'),
  'browser:purchase-http-cache': sourceEvidence('desktop/src/purchaseBrowser/cefPurchaseBrowserController.js', 'export const PURCHASE_BROWSER_PURGE_RESOURCE_IDS = Object.freeze([', 'HTTP cache is removed with the exact owner CEF profile'),
  'browser:purchase-service-workers': sourceEvidence('desktop/src/purchaseBrowser/cefPurchaseBrowserController.js', 'export const PURCHASE_BROWSER_PURGE_RESOURCE_IDS = Object.freeze([', 'service workers are removed with the exact owner CEF profile'),
  'browser:purchase-proxy-auth': sourceEvidence('desktop/src/purchaseBrowser/cefPurchaseBrowserController.js', 'export const PURCHASE_BROWSER_PURGE_RESOURCE_IDS = Object.freeze([', 'proxy and authentication state are removed with the exact owner CEF profile'),
  'browser:purchase-plugin-installation-state': sourceEvidence('desktop/src/purchaseBrowser/cefPurchaseBrowserController.js', 'addonManager.purgeOwner(ownerRef);', 'built-in addon state is keyed only by the HMAC owner reference'),
  'browser:purchase-extension-storage': sourceEvidence('desktop/src/purchaseBrowser/cefPurchaseBrowserController.js', 'export const PURCHASE_BROWSER_PURGE_RESOURCE_IDS = Object.freeze([', 'extension storage is removed with the exact owner CEF profile'),
  'browser:purchase-downloads': sourceEvidence('desktop/src/purchaseBrowser/cefPurchaseBrowserController.js', 'removeOwnedPath(downloadDirectory, ownerRef);', 'download path contains only the HMAC owner reference and is removed independently'),
});

// This is catalog metadata, not a second test-only list.  The coverage test
// derives its required evidence keys from production source anchors and checks
// both directions against these marked entries.
const COVERAGE_AUDIT_CURRENT_RESOURCE_IDS = new Set([
  'memory:renderer-marketing-activity-runtime-cache',
  'runtime:renderer-marketing-view-state-write-queue',
  'memory:renderer-product-material-profiles',
  'runtime:renderer-product-material-profile-write-queue',
  'runtime:renderer-product-source-link-migration',
  'runtime:renderer-sales-source-link-migration',
  'runtime:renderer-purchase-source-link-migration',
  'runtime:local-api-performance-request-queue',
  'runtime:desktop-recovery-staged-descriptors',
  'filesystem:recovery-rollback-root',
  'filesystem:recovery-failed-root',
  'filesystem:desktop-local-api-sqlite-sidecars',
  'logical:renderer-ozon-shop-settings-shop-slices',
  'memory:renderer-model-api-settings',
  'logical:renderer-purchase-order-overrides-shop-records',
  'logical:renderer-cross-border-settings-account-slice',
  'memory:local-api-products-hot-cache',
  'runtime:local-api-ozon-client-endpoint-limiter',
  'logical:local-api-rate-limit-shop-state',
  'logical:local-api-traffic-controller-shop-state',
  'memory:external-chrome-content-snapshots',
  'runtime:external-chrome-content-pollers',
  'memory:external-chrome-popup-snapshots',
  'logical:local-data-ozon-shop-settings-shop-slices',
  'logical:local-data-product-material-profiles-shop-records',
  'logical:local-data-purchase-order-overrides-shop-records',
  'logical:local-data-product-source-links-shop-records',
  'logical:local-data-sales-source-links-shop-records',
  'logical:local-data-purchase-source-links-shop-records',
  'filesystem:desktop-local-data-root',
  'filesystem:desktop-runtime-directory',
  'filesystem:legacy-local-api-secret-key',
  'runtime:desktop-profile-lock-handle',
  'runtime:renderer-local-api-request-listeners',
  'memory:renderer-local-api-request-stats',
  'runtime:renderer-workspace-performance',
  'runtime:renderer-sales-orders-page-load',
  'runtime:renderer-profit-refresh-progress',
  'memory:renderer-prompt-library-store',
  'runtime:renderer-prompt-library-write-queue',
  'memory:renderer-watermark-settings',
  'runtime:renderer-watermark-settings-write-queue',
  'runtime:renderer-watermark-settings-load-task',
  'memory:renderer-fee-plan-state',
  'runtime:renderer-fee-settings-write-queue',
  'memory:renderer-product-material-profile-hashes',
  'runtime:renderer-legacy-browser-read-telemetry',
  'runtime:renderer-browser-local-storage-mirror',
  'memory:renderer-product-fee-exchange-rate',
  'memory:renderer-license-browser-tokens',
  'runtime:renderer-legacy-browser-read-listeners',
  'runtime:desktop-license-runtime-promises',
]);

function isNonEmptyString(value) {
  return typeof value === 'string' && Boolean(value.trim());
}

function isJsonContractValue(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  if (!Array.isArray(value) && !isPlainObject(value)) return false;
  seen.add(value);
  return Object.values(value).every((child) => isJsonContractValue(child, seen));
}

function isContractText(value) {
  return isNonEmptyString(value) && value === value.trim() && !/[\u0000-\u001F\u007F]/u.test(value);
}

function hasOnlyKeys(value, keys) {
  return Object.keys(value).every((key) => keys.has(key));
}

function hasRequiredKeys(value, keys) {
  return [...keys].every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isSqlIdentifier(value) {
  return typeof value === 'string' && SQL_IDENTIFIER_PATTERN.test(value);
}

function isJsonPath(value) {
  return typeof value === 'string' && JSON_PATH_PATTERN.test(value);
}

function isPropertyPath(value) {
  return typeof value === 'string' && PROPERTY_PATH_PATTERN.test(value);
}

function parseOwnerFieldSelector(value) {
  if (!isContractText(value)) return null;
  const separator = value.indexOf(':');
  if (separator <= 0) return null;
  const kind = value.slice(0, separator);
  const valuePart = value.slice(separator + 1);
  if (!valuePart) return null;
  if (kind === 'sqlite-column' && isSqlIdentifier(valuePart)) return { kind, value: valuePart };
  if ((kind === 'memory-property' || kind === 'runtime-property') && isPropertyPath(valuePart)) return { kind, value: valuePart };
  if (kind === 'memory-tag' && valuePart === 'shop:${ownerId}') return { kind, value: valuePart };
  if (kind === 'json-path' && isJsonPath(valuePart)) return { kind, value: valuePart };
  if (kind === 'resolver' && OWNER_RESOLVER_ALLOWLIST.has(valuePart)) return { kind, value: valuePart };
  return null;
}

function isStrictSourceEvidence(value) {
  return isPlainObject(value)
    && hasOnlyKeys(value, new Set(['sourceFile', 'sourceSymbol', 'ownerBasis']))
    && hasRequiredKeys(value, new Set(['sourceFile', 'sourceSymbol', 'ownerBasis']))
    && typeof value.sourceFile === 'string'
    && SOURCE_FILE_PATTERN.test(value.sourceFile)
    && isContractText(value.sourceSymbol)
    && isContractText(value.ownerBasis);
}

function isStrictLocalDataPathContract(entry) {
  return isContractText(entry.directory)
    && isContractText(entry.fileName)
    && isContractText(entry.relativePath)
    && !/\\|\.\.|^\/|\/$/u.test(entry.directory)
    && !/[\\/]|\.\./u.test(entry.fileName)
    && entry.relativePath === `${entry.directory}/${entry.fileName}`
    && entry.resource === `desktop local-data/${entry.relativePath}`;
}

function validateSourceEvidenceContract(entry) {
  if (entry.sourceEvidence === undefined) {
    throw new Error('ACCOUNT_OWNERSHIP_CATALOG_SOURCE_EVIDENCE_REQUIRED');
  }
  if (entry.sourceEvidence !== undefined && !isStrictSourceEvidence(entry.sourceEvidence)) {
    throw new Error('ACCOUNT_OWNERSHIP_CATALOG_SOURCE_EVIDENCE_INVALID');
  }
  if (entry.sourceEvidence?.sourceFile === 'local-api/src/domain/accountRemoval/accountOwnershipCatalog.js') {
    throw new Error('ACCOUNT_OWNERSHIP_CATALOG_SOURCE_EVIDENCE_INVALID');
  }
  const hasLocalDataPath = ['directory', 'fileName', 'relativePath'].some(
    (field) => Object.prototype.hasOwnProperty.call(entry, field),
  );
  if (hasLocalDataPath && !isStrictLocalDataPathContract(entry)) {
    throw new Error('ACCOUNT_OWNERSHIP_CATALOG_LOCAL_DATA_PATH_INVALID');
  }
  if (entry.sourceProtocolKey !== undefined) {
    if (!isContractText(entry.sourceProtocolKey) || !hasLocalDataPath) {
      throw new Error('ACCOUNT_OWNERSHIP_CATALOG_SOURCE_PROTOCOL_INVALID');
    }
    if (entry.sourceEvidence?.sourceFile !== 'desktop/src/protocol/appProtocol.js') {
      throw new Error('ACCOUNT_OWNERSHIP_CATALOG_SOURCE_PROTOCOL_INVALID');
    }
  }
}

function assertVerifyContract(condition) {
  if (!condition) throw new Error('ACCOUNT_OWNERSHIP_CATALOG_VERIFY_CONTRACT_INVALID');
}

function validateOwnerScopeFieldMatrix(entry) {
  const ownerTypeRules = OWNER_SCOPE_MATRIX[entry.ownerType];
  if (!ownerTypeRules?.[entry.scopeType]) throw new Error('ACCOUNT_OWNERSHIP_CATALOG_OWNER_SCOPE_INVALID');
  if (entry.ownerType !== 'system' && entry.ownerType !== 'unknown' && entry.ownerField.startsWith('constant:')) {
    throw new Error('ACCOUNT_OWNERSHIP_CATALOG_OWNER_SCOPE_INVALID');
  }
  if (entry.availability === 'current' && entry.removable === true && !parseOwnerFieldSelector(entry.ownerField)) {
    throw new Error(`ACCOUNT_OWNERSHIP_CATALOG_OWNER_SELECTOR_INVALID:${entry.id}`);
  }
}

function validateVerifyQueryContract(entry) {
  const query = entry.verifyQuery;
  assertVerifyContract(
    isPlainObject(query)
      && isContractText(query.type)
      && VALID_VERIFY_QUERY_TYPES.has(query.type)
      && isContractText(query.expected)
      && isJsonContractValue(query),
  );
  assertVerifyContract(STORAGE_VERIFY_MATRIX[entry.storageKind]?.includes(query.type));

  switch (query.type) {
    case 'browser-artifact-absence':
      assertVerifyContract(
        entry.availability === 'current'
          && entry.removable === true
          && ['purchase_account', 'integration_profile'].includes(entry.ownerType)
          && hasOnlyKeys(query, new Set(['type', 'artifact', 'ownerField', 'expected']))
          && hasRequiredKeys(query, new Set(['type', 'artifact', 'ownerField', 'expected']))
          && isContractText(query.artifact)
          && query.ownerField === 'resolver:purchase-browser-owner-ref'
          && query.expected === 'absent',
      );
      return;
    case 'browser-partition-unavailable':
      assertVerifyContract(
        entry.availability === 'current'
          && entry.removable === true
          && ['purchase_account', 'integration_profile'].includes(entry.ownerType)
          && hasOnlyKeys(query, new Set(['type', 'ownerField', 'expected']))
          && hasRequiredKeys(query, new Set(['type', 'ownerField', 'expected']))
          && query.ownerField === 'resolver:purchase-browser-owner-ref'
          && query.expected === 'unavailable',
      );
      return;
    case 'browser-profile-absence':
      assertVerifyContract(
        entry.availability === 'current'
          && entry.removable === true
          && ['purchase_account', 'integration_profile'].includes(entry.ownerType)
          && hasOnlyKeys(query, new Set(['type', 'ownerField', 'expected']))
          && hasRequiredKeys(query, new Set(['type', 'ownerField', 'expected']))
          && query.ownerField === 'resolver:purchase-browser-owner-ref'
          && query.expected === 'absent',
      );
      return;
    case 'fail-closed':
      assertVerifyContract(
        entry.ownerType === 'unknown'
          && entry.removable === false
          && hasOnlyKeys(query, new Set(['type', 'ownerField', 'expected']))
          && hasRequiredKeys(query, new Set(['type', 'ownerField', 'expected']))
          && isContractText(query.ownerField)
          && query.expected === 'no-action',
      );
      return;
    case 'json-file-owner-reference-absence':
      assertVerifyContract(
        entry.storageKind === 'filesystem'
          && entry.ownerType === 'ozon_shop'
          && entry.availability === 'current'
          && entry.removable === true
          && hasOnlyKeys(query, new Set(['type', 'directory', 'fileName', 'relativePath', 'ownerField', 'paths', 'expected']))
          && hasRequiredKeys(query, new Set(['type', 'directory', 'fileName', 'relativePath', 'ownerField', 'paths', 'expected']))
          && isStrictLocalDataPathContract(entry)
          && query.directory === entry.directory
          && query.fileName === entry.fileName
          && query.relativePath === entry.relativePath
          && isJsonPath(query.ownerField)
          && Array.isArray(query.paths)
          && query.paths.length > 0
          && query.paths.every(isJsonPath)
          && new Set(query.paths).size === query.paths.length
          && query.paths.includes(query.ownerField)
          && query.expected === 'absent',
      );
      return;
    case 'json-record-map-owner-absence':
      assertVerifyContract(
        entry.storageKind === 'filesystem'
          && entry.ownerType === 'ozon_shop'
          && entry.availability === 'current'
          && entry.removable === true
          && hasOnlyKeys(query, new Set(['type', 'directory', 'fileName', 'relativePath', 'ownerField', 'expected']))
          && hasRequiredKeys(query, new Set(['type', 'directory', 'fileName', 'relativePath', 'ownerField', 'expected']))
          && isStrictLocalDataPathContract(entry)
          && query.directory === entry.directory
          && query.fileName === entry.fileName
          && query.relativePath === entry.relativePath
          && query.ownerField === 'resolver:local-data-shop-record-map'
          && entry.ownerField === query.ownerField
          && query.expected === 'absent',
      );
      return;
    case 'json-owner-reference-absence':
      assertVerifyContract(
        entry.storageKind === 'sqlite'
          && entry.ownerType !== 'unknown'
          && entry.ownerType !== 'system'
          && entry.availability === 'current'
          && entry.removable === true
          && hasOnlyKeys(query, new Set(['type', 'namespace', 'ownerField', 'paths', 'expected']))
          && hasRequiredKeys(query, new Set(['type', 'namespace', 'ownerField', 'paths', 'expected']))
          && isContractText(query.namespace)
          && entry.resource.includes(`namespace=${query.namespace}`)
          && isJsonPath(query.ownerField)
          && Array.isArray(query.paths)
          && query.paths.length > 0
          && query.paths.every(isJsonPath)
          && new Set(query.paths).size === query.paths.length
          && query.paths.includes(query.ownerField)
          && ['absent', 'absent-and-not-active'].includes(query.expected),
      );
      return;
    case 'memory-owner-absence': {
      const hasOwnerField = Object.prototype.hasOwnProperty.call(query, 'ownerField')
        && (isPropertyPath(query.ownerField) || (typeof query.ownerField === 'string' && query.ownerField.startsWith('resolver:') && OWNER_RESOLVER_ALLOWLIST.has(query.ownerField.slice('resolver:'.length))));
      const hasTag = Object.prototype.hasOwnProperty.call(query, 'tag') && query.tag === 'shop:${ownerId}';
      assertVerifyContract(
        entry.ownerType !== 'unknown'
          && entry.ownerType !== 'system'
          && hasOnlyKeys(query, new Set(['type', 'ownerField', 'tag', 'expected']))
          && hasRequiredKeys(query, new Set(['type', 'expected']))
          && Number(hasOwnerField) + Number(hasTag) === 1
          && query.expected === 'absent',
      );
      return;
    }
    case 'memory-tag-absence':
      assertVerifyContract(
        entry.ownerType !== 'unknown'
          && entry.ownerType !== 'system'
          && hasOnlyKeys(query, new Set(['type', 'tag', 'expected']))
          && hasRequiredKeys(query, new Set(['type', 'tag', 'expected']))
          && query.tag === 'shop:${ownerId}'
          && query.expected === 'absent',
      );
      return;
    case 'preserve':
      assertVerifyContract(
        entry.ownerType === 'system'
          && entry.removable === false
          && hasOnlyKeys(query, new Set(['type', 'ownerField', 'expected']))
          && hasRequiredKeys(query, new Set(['type', 'ownerField', 'expected']))
          && isContractText(query.ownerField)
          && query.expected === 'unchanged',
      );
      return;
    case 'protection-owner-absence':
      assertVerifyContract(
        entry.storageKind === 'filesystem'
          && entry.ownerType !== 'unknown'
          && entry.ownerType !== 'system'
          && entry.availability === 'current'
          && entry.removable === true
          && hasOnlyKeys(query, new Set(['type', 'ownerField', 'expected']))
          && hasRequiredKeys(query, new Set(['type', 'ownerField', 'expected']))
          && query.ownerField === 'resolver:recovery-protection-owner'
          && query.expected === 'absent-and-physically-erased',
      );
      return;
    case 'diagnostic-log-owner-absence':
      assertVerifyContract(
        entry.storageKind === 'filesystem'
          && entry.ownerType !== 'unknown'
          && entry.ownerType !== 'system'
          && entry.availability === 'current'
          && entry.removable === true
          && hasOnlyKeys(query, new Set(['type', 'ownerField', 'expected']))
          && hasRequiredKeys(query, new Set(['type', 'ownerField', 'expected']))
          && query.ownerField === 'resolver:diagnostic-log-owner'
          && query.expected === 'absent-and-overwritten',
      );
      return;
    case 'remote-owner-absence':
      assertVerifyContract(
        entry.storageKind === 'backup-remote'
          && entry.ownerType !== 'unknown'
          && entry.ownerType !== 'system'
          && entry.availability === 'current'
          && entry.removable === true
          && hasOnlyKeys(query, new Set(['type', 'ownerField', 'expected']))
          && hasRequiredKeys(query, new Set(['type', 'ownerField', 'expected']))
          && query.ownerField === 'resolver:recovery-owner-ref'
          && query.expected === 'tombstoned-and-absent',
      );
      return;
    case 'runtime-owner-count':
      assertVerifyContract(
        entry.ownerType !== 'unknown'
          && entry.ownerType !== 'system'
          && hasOnlyKeys(query, new Set(['type', 'path', 'expected']))
          && hasRequiredKeys(query, new Set(['type', 'path', 'expected']))
          && (isPropertyPath(query.path) || (typeof query.path === 'string' && query.path.startsWith('resolver:') && OWNER_RESOLVER_ALLOWLIST.has(query.path.slice('resolver:'.length))))
          && query.expected === 'zero',
      );
      return;
    case 'runtime-owner-state':
      assertVerifyContract(
        entry.ownerType !== 'unknown'
          && hasOnlyKeys(query, new Set(['type', 'path', 'expected']))
          && hasRequiredKeys(query, new Set(['type', 'path', 'expected']))
          && (isPropertyPath(query.path) || (typeof query.path === 'string' && query.path.startsWith('resolver:') && OWNER_RESOLVER_ALLOWLIST.has(query.path.slice('resolver:'.length))))
          && RUNTIME_OWNER_STATE_EXPECTED.has(query.expected),
      );
      return;
    case 'secret-vault-absence':
      assertVerifyContract(
        entry.storageKind === 'secret-vault'
          && entry.ownerType !== 'unknown'
          && entry.ownerType !== 'system'
          && hasOnlyKeys(query, new Set(['type', 'resource', 'ownerField', 'expected']))
          && hasRequiredKeys(query, new Set(['type', 'resource', 'ownerField', 'expected']))
          && isContractText(query.resource)
          && isContractText(query.ownerField)
          && query.expected === 'absent',
      );
      return;
    case 'shop-storage-scope-absence':
      assertVerifyContract(
        entry.storageKind === 'filesystem'
          && entry.ownerType === 'ozon_shop'
          && entry.availability === 'current'
          && entry.removable === true
          && hasOnlyKeys(query, new Set(['type', 'ownerField', 'expected']))
          && hasRequiredKeys(query, new Set(['type', 'ownerField', 'expected']))
          && ['resolver:shop-database-scope', 'resolver:shop-aggregate-index-scope'].includes(query.ownerField)
          && entry.ownerField === query.ownerField
          && query.expected === 'absent',
      );
      return;
    case 'sqlite-account-row-absence':
      assertVerifyContract(
        entry.storageKind === 'secret-vault'
          && entry.ownerType !== 'unknown'
          && entry.ownerType !== 'system'
          && hasOnlyKeys(query, new Set(['type', 'table', 'ownerField', 'expected']))
          && hasRequiredKeys(query, new Set(['type', 'table', 'ownerField', 'expected']))
          && isSqlIdentifier(query.table)
          && isSqlIdentifier(query.ownerField)
          && entry.resource.startsWith(`${query.table}.`)
          && query.expected === 'absent-with-account',
      );
      return;
    case 'sqlite-count':
      assertVerifyContract(
        entry.storageKind === 'sqlite'
          && entry.ownerType !== 'unknown'
          && entry.ownerType !== 'system'
          && hasOnlyKeys(query, new Set(['type', 'table', 'ownerField', 'ownerPredicate', 'expected']))
          && hasRequiredKeys(query, new Set(['type', 'table', 'ownerField', 'ownerPredicate', 'expected']))
          && isSqlIdentifier(query.table)
          && isSqlIdentifier(query.ownerField)
          && query.ownerPredicate === `${query.ownerField} = :ownerId`
          && entry.resource === query.table
          && query.expected === 'zero',
      );
      return;
    default:
      assertVerifyContract(false);
  }
}

function validatePlannableSelectorBinding(entry) {
  if (entry.availability !== 'current' || entry.removable !== true) return;
  const selector = parseOwnerFieldSelector(entry.ownerField);
  if (!selector) throw new Error('ACCOUNT_OWNERSHIP_CATALOG_OWNER_SELECTOR_INVALID');
  const query = entry.verifyQuery;
  if (query.type === 'sqlite-count' || query.type === 'sqlite-account-row-absence') {
    assertVerifyContract(selector.kind === 'sqlite-column' && selector.value === query.ownerField);
    return;
  }
  if (query.type === 'memory-owner-absence') {
    if (Object.prototype.hasOwnProperty.call(query, 'tag')) {
      assertVerifyContract(selector.kind === 'memory-tag' && selector.value === query.tag);
    } else if (query.ownerField.startsWith('resolver:')) {
      assertVerifyContract(selector.kind === 'resolver' && `resolver:${selector.value}` === query.ownerField);
    } else {
      assertVerifyContract(selector.kind === 'memory-property' && selector.value === query.ownerField);
    }
    return;
  }
  if (query.type === 'memory-tag-absence') {
    assertVerifyContract(selector.kind === 'memory-tag' && selector.value === query.tag);
    return;
  }
  if (query.type === 'runtime-owner-count' || query.type === 'runtime-owner-state') {
    if (query.path.startsWith('resolver:')) {
      assertVerifyContract(selector.kind === 'resolver' && `resolver:${selector.value}` === query.path);
    } else {
      assertVerifyContract(selector.kind === 'runtime-property' && selector.value === query.path);
    }
    return;
  }
  if (query.type === 'json-owner-reference-absence' || query.type === 'json-file-owner-reference-absence') {
    assertVerifyContract(selector.kind === 'json-path' && selector.value === query.ownerField);
    return;
  }
  if (query.type === 'json-record-map-owner-absence') {
    assertVerifyContract(selector.kind === 'resolver' && selector.value === 'local-data-shop-record-map');
    return;
  }
  if (query.type === 'remote-owner-absence') {
    assertVerifyContract(selector.kind === 'resolver' && selector.value === 'recovery-owner-ref');
    return;
  }
  if (query.type === 'protection-owner-absence') {
    assertVerifyContract(selector.kind === 'resolver' && selector.value === 'recovery-protection-owner');
    return;
  }
  if (query.type === 'diagnostic-log-owner-absence') {
    assertVerifyContract(selector.kind === 'resolver' && selector.value === 'diagnostic-log-owner');
    return;
  }
  if (query.type === 'shop-storage-scope-absence') {
    assertVerifyContract(
      selector.kind === 'resolver'
        && `resolver:${selector.value}` === query.ownerField,
    );
    return;
  }
  if (
    query.type === 'browser-artifact-absence'
    || query.type === 'browser-partition-unavailable'
    || query.type === 'browser-profile-absence'
  ) {
    assertVerifyContract(
      selector.kind === 'resolver'
        && selector.value === 'purchase-browser-owner-ref'
        && query.ownerField === 'resolver:purchase-browser-owner-ref',
    );
    return;
  }
  throw new Error('ACCOUNT_OWNERSHIP_CATALOG_OWNER_SELECTOR_INVALID');
}

function freezeEntry(entry) {
  return deepFreeze({
    ...entry,
    verifyQuery: { ...entry.verifyQuery },
  });
}

function getOwnerAdapter(policy) {
  const tableAdapter = REGISTRY_OWNER_ADAPTERS[policy.canonicalTable];
  if (tableAdapter) return tableAdapter;
  if (policy.scopeType === 'shop') {
    return { ownerType: 'ozon_shop', ownerField: 'sqlite-column:shop_id', removable: true };
  }
  return PROFILE_OWNER_ADAPTERS[policy.domain] || {
    ownerType: 'system',
    ownerField: 'constant:global',
    removable: false,
  };
}

function getStorageKind(policy) {
  return String(policy.canonicalTable || '').startsWith('secret-vault:') ? 'secret-vault' : 'sqlite';
}

function getSqlSelectorColumn(ownerField) {
  const selector = parseOwnerFieldSelector(ownerField);
  return selector?.kind === 'sqlite-column' ? selector.value : ownerField;
}

function getVerifyQuery(storageKind, resource, ownerField, ownerType) {
  if (ownerType === 'unknown') {
    return { type: 'fail-closed', expected: 'no-action', ownerField };
  }
  if (ownerType === 'system') {
    return { type: 'preserve', expected: 'unchanged', ownerField };
  }
  if (storageKind === 'secret-vault') {
    return { type: 'secret-vault-absence', resource, ownerField: getSqlSelectorColumn(ownerField), expected: 'absent' };
  }
  const ownerColumn = getSqlSelectorColumn(ownerField);
  return {
    type: 'sqlite-count',
    table: resource,
    ownerField: ownerColumn,
    ownerPredicate: `${ownerColumn} = :ownerId`,
    expected: 'zero',
  };
}

function getDeletePrimitive(storageKind, ownerType) {
  if (ownerType === 'unknown') return 'prohibited:unclassified-resource';
  if (ownerType === 'system') return 'prohibited:system-preserve';
  if (storageKind === 'secret-vault') return 'future:accountRemoval.secretVaultOwnerPrimitive';
  return 'future:accountRemoval.sqliteOwnerPrimitive';
}

function createRegistryCatalogEntry(policy) {
  const adapter = getOwnerAdapter(policy);
  const storageKind = getStorageKind(policy);
  const resource = adapter.resource || policy.canonicalTable;
  return freezeEntry({
    id: `registry:${policy.domain}`,
    storageKind,
    resource,
    scopeType: adapter.scopeType || policy.scopeType,
    ownerType: adapter.ownerType,
    ownerField: adapter.ownerField,
    deletePrimitive: adapter.deletePrimitive || getDeletePrimitive(storageKind, adapter.ownerType),
    verifyQuery: adapter.verifyQuery || getVerifyQuery(storageKind, resource, adapter.ownerField, adapter.ownerType),
    preserveRule: adapter.preserveRule || (
      adapter.ownerType === 'system'
        ? 'system/profile resource is never selected by a business-account removal'
        : 'only the exact ownerType + ownerId scope is eligible; all other owners are preserved'
    ),
    backupRule: policy.backup,
    risk: adapter.risk || (
      policy.scopeType === 'profile' && adapter.ownerType === 'system'
        ? 'profile-scoped shared/system resource; fail closed for business account removal'
        : policy.dataClass === 'secret'
          ? 'secret-bearing resource; future removal requires owner-scoped key and readback proof'
          : policy.dataClass === 'runtime' || policy.dataClass === 'cache'
            ? 'rebuildable/runtime resource; future removal still requires scope proof'
            : 'business resource; future removal requires owner-scoped verification'
    ),
    sourceRegistryDomain: policy.domain,
    sourceEvidence: {
      sourceFile: 'local-api/src/data/dataDomainRegistry.js',
      sourceSymbol: `domain: '${policy.domain}'`,
      ownerBasis: `DataDomainRegistry domain ${policy.domain}`,
    },
    removable: adapter.removable,
    availability: adapter.availability || 'current',
    executionGroup: adapter.executionGroup || null,
    coverageAudit: false,
  });
}

function externalEntry(input) {
  const ownerType = input.ownerType || 'unknown';
  const sourceEvidenceContract = input.sourceEvidence || EXTERNAL_SOURCE_EVIDENCE[input.id];
  const entry = {
    ...input,
    scopeType: input.scopeType || (ownerType === 'system' ? 'system' : 'external'),
    deletePrimitive: input.deletePrimitive || getDeletePrimitive(input.storageKind, ownerType),
    verifyQuery: input.verifyQuery || getVerifyQuery(input.storageKind, input.resource, input.ownerField, ownerType),
    preserveRule:
      input.preserveRule ||
      (ownerType === 'unknown'
        ? 'missing authoritative owner metadata; no removal may be planned'
        : ownerType === 'system'
          ? 'system/global resource is always preserved'
          : 'only the exact ownerType + ownerId scope is eligible; all other owners are preserved'),
    backupRule: input.backupRule || 'excluded',
    risk: input.risk || 'external resource contract only; no executor exists in Phase B',
    removable: input.removable ?? !['system', 'unknown'].includes(ownerType),
    availability: input.availability || 'current',
    ownerType,
    sourceEvidence: sourceEvidenceContract,
    coverageAudit: input.coverageAudit ?? COVERAGE_AUDIT_CURRENT_RESOURCE_IDS.has(input.id),
  };
  return freezeEntry(entry);
}

// The Electron local-data protocol is outside local-api's SQLite registry.  It
// remains an explicit adapter rather than a second SQLite table list.  Existing
// JSON payloads can be mixed, stale, or missing an authoritative owner field,
// therefore every current file fails closed until a per-file migration proof is
// introduced in a later phase.
const LOCAL_DATA_FILE_OWNERSHIP_ADAPTERS = Object.freeze([
  ['ozon-shop-settings', '分类缓存/01-店铺设置', 'ozon-shop-settings.json'],
  ['sales-source-links', '分类缓存/05-销售订单', 'sales-source-links.json'],
  ['product-material-profiles', '商品资料', 'product-material-profiles.json'],
  ['product-source-links', '商品资料', 'product-source-links.json'],
  ['purchase-source-links', '分类缓存/07-拍单采购', 'purchase-source-links.json'],
  ['purchase-order-local-overrides', '商品资料', 'purchase-order-local-overrides.json'],
  ['cross-border-bus-order-records', '商品资料', 'cross-border-bus-order-records.json'],
  ['after-sales-display-snapshots', '分类缓存/09-售后订单', 'after-sales-display-snapshots.json'],
  ['profit-local-cache', '分类缓存/10-利润核算', 'profit-local-cache.json'],
  ['local-mirror-read-log', '分类缓存/14-失败重试', 'local-mirror-read-log.json'],
  ['local-mirror-retry-queue', '分类缓存/14-失败重试', 'local-mirror-retry-queue.json'],
  ['browser-local-storage', 'settings', 'browser-local-storage.json'],
].map(([sourceProtocolKey, directory, fileName]) => externalEntry({
  id: `filesystem:local-data-${sourceProtocolKey}`,
  storageKind: 'filesystem',
  resource: `desktop local-data/${directory}/${fileName}`,
  ownerType: 'unknown',
  ownerField: 'legacy JSON payload owner mapping unavailable',
  sourceProtocolKey,
  directory,
  fileName,
  relativePath: `${directory}/${fileName}`,
  sourceEvidence: {
    sourceFile: 'desktop/src/protocol/appProtocol.js',
    sourceSymbol: `'${sourceProtocolKey}':`,
    ownerBasis: 'current appProtocol local-data file has no authoritative whole-file owner',
  },
  risk: 'current local-data JSON can be mixed or unscoped; no account removal may infer ownership from a path, key, or payload shape',
})));

// Current renderer, bridge, desktop, and local-api process resources are
// catalogued separately from the SQLite registry.  A resource is only marked
// shop-removable where its current key has an authoritative owner boundary;
// mixed, label-derived, global, or absent owner data stays prohibited.
const CURRENT_RUNTIME_OWNERSHIP_RESOURCES = Object.freeze([
  externalEntry({
    id: 'memory:purchase-search-bridge-context-unattributed',
    storageKind: 'memory',
    resource: 'frontend/scripts/purchase-bridge/plugin-store purchasePluginContext',
    ownerType: 'unknown',
    ownerField: 'context contains shop/order/product fields but no purchaseAccountId',
    availability: 'current',
    risk: 'current purchase bridge context may point to an Ozon shop and order but cannot prove one purchase account; preserve until an authoritative account binding exists',
  }),
  externalEntry({
    id: 'memory:purchase-search-bridge-captures-unattributed',
    storageKind: 'memory',
    resource: 'frontend/scripts/purchase-bridge/plugin-store purchasePluginCaptures (maximum 200)',
    ownerType: 'unknown',
    ownerField: 'capture.context has shop/order/product/link/order number/amount but no purchaseAccountId',
    availability: 'current',
    risk: 'current bridge captures can contain mixed shop and purchase facts without an account identifier; no removal may infer owner from captured fields',
  }),
  externalEntry({
    id: 'memory:purchase-search-bridge-pdd-image-title-cache-unattributed',
    storageKind: 'memory',
    resource: 'frontend/scripts/purchase-bridge/pdd-title-search-service pddImageTitleCache',
    ownerType: 'unknown',
    ownerField: 'cache key is an image URL without purchaseAccountId or shopId',
    availability: 'current',
    risk: 'the bounded process-global title cache may contain product facts from multiple purchase sessions; preserve until the cache key carries an authoritative purchase account owner',
  }),
  externalEntry({
    id: 'memory:purchase-search-bridge-purchase-account-context',
    storageKind: 'memory',
    resource: 'purchase bridge context with authoritative purchaseAccountId',
    ownerType: 'purchase_account',
    ownerField: 'memory-property:purchasePluginContext.purchaseAccountId',
    deletePrimitive: 'future:accountRemovalClient.purchaseBridgeAccountOwnerPurge',
    verifyQuery: { type: 'memory-owner-absence', ownerField: 'purchasePluginContext.purchaseAccountId', expected: 'absent' },
    preserveRule: 'remove only context whose normalized purchaseAccountId exactly equals ownerId; preserve every other purchase account context',
    risk: 'the bridge must reject account-less replacement writes while this exact purchase account is fenced',
    availability: 'current',
    removable: true,
    sourceEvidence: sourceEvidence('frontend/scripts/purchase-bridge/plugin-store.mjs', 'purchaseAccountId: String(firstPresent(context.purchaseAccountId)', 'normalized bridge context carries the exact selected purchase account id'),
  }),
  externalEntry({
    id: 'memory:purchase-search-bridge-purchase-account-captures',
    storageKind: 'memory',
    resource: 'purchase bridge captures with authoritative purchaseAccountId',
    ownerType: 'purchase_account',
    ownerField: 'memory-property:purchasePluginCaptures.context.purchaseAccountId',
    deletePrimitive: 'future:accountRemovalClient.purchaseBridgeAccountOwnerPurge',
    verifyQuery: { type: 'memory-owner-absence', ownerField: 'purchasePluginCaptures.context.purchaseAccountId', expected: 'absent' },
    preserveRule: 'remove only captures whose normalized context.purchaseAccountId exactly equals ownerId; preserve every other purchase account capture',
    risk: 'capture ownership is accepted only from the native browser owner binding and is never inferred from shop/order/link/amount fields',
    availability: 'current',
    removable: true,
    sourceEvidence: sourceEvidence('frontend/scripts/purchase-bridge/plugin-store.mjs', 'purchaseAccountId: String(firstPresent(context.purchaseAccountId)', 'each normalized capture embeds the exact selected purchase account id'),
  }),
  externalEntry({
    id: 'browser:external-chrome-extension-profile-unattributed',
    storageKind: 'browser-extension',
    resource: 'retired external-profile alias for the stateless built-in purchase extension source bundle',
    ownerType: 'system',
    ownerField: 'constant:global',
    availability: 'current',
    risk: 'the source bundle is shared code only; account data is held by separately catalogued Electron partitions',
  }),
  externalEntry({
    id: 'browser:external-chrome-extension-storage-unattributed',
    storageKind: 'browser-extension',
    resource: 'retired external-storage alias for the stateless built-in content runtime',
    ownerType: 'system',
    ownerField: 'constant:global',
    availability: 'current',
    risk: 'the built-in extension declares no storage permission and keeps no shared context; partition storage is catalogued separately',
  }),
  externalEntry({
    id: 'runtime:desktop-recovery-auto-backup-scheduler',
    storageKind: 'runtime',
    resource: 'desktop recoveryAutoBackupScheduler timer, running status, and backup-all-shops runNow lifecycle',
    ownerType: 'system',
    ownerField: 'one desktop-global scheduler can upload a full profile and all shops',
    deletePrimitive: 'future:accountRemoval.recoveryAutoBackupSchedulerOwnerQuiesce',
    verifyQuery: { type: 'runtime-owner-state', path: 'recoveryAutoBackupScheduler', expected: 'stopped-or-owner-write-fenced' },
    preserveRule: 'preserve scheduler state; any future account removal must fence/quiesce an overlapping backup generation before changing one owner',
    backupRule: 'excluded',
    risk: 'startup and 15-minute runs can race owner removal because each run calls backup-all-shops; no owner delete is permitted in Phase B',
    removable: false,
  }),
  externalEntry({
    id: 'memory:local-api-write-guard-previews',
    storageKind: 'memory',
    resource: 'local-api security/writeGuardService previews Map containing payload, before, after, diff, and shopId',
    scopeType: 'shop',
    ownerType: 'ozon_shop',
    ownerField: 'memory-property:preview.shopId',
    deletePrimitive: 'future:accountRemoval.writeGuardPreviewOwnerInvalidate',
    verifyQuery: { type: 'memory-owner-absence', ownerField: 'preview.shopId', expected: 'absent' },
    preserveRule: 'future primitive may invalidate only previews with exact non-empty shopId; preserve null/unscoped and other-shop previews',
    risk: 'current Map has no clear/delete API; future removal must quiesce confirmation consumers and never discard a null-scope preview',
  }),
  externalEntry({
    id: 'memory:renderer-ozon-shop-settings-unattributed',
    storageKind: 'memory',
    resource: 'frontend services/ozonShopSettingsStore ozonShopSettingsMemory',
    ownerType: 'unknown',
    ownerField: 'one renderer store contains shops[], activeShopId, and defaultWarehouseIds for multiple Ozon shops',
    risk: 'the current aggregate settings snapshot cannot prove one exact shop owner; preserve it rather than selecting entries by label or active-shop fallback',
  }),
  externalEntry({
    id: 'runtime:renderer-ozon-shop-settings-write-queue',
    storageKind: 'runtime',
    resource: 'frontend services/ozonShopSettingsStore ozonShopSettingsWriteQueue',
    ownerType: 'system',
    ownerField: 'one renderer-global queue can persist multiple shops and profile preference keys',
    deletePrimitive: 'future:accountRemoval.ozonShopSettingsQueueQuiesce',
    verifyQuery: { type: 'runtime-owner-state', path: 'ozonShopSettingsWriteQueue', expected: 'stopped-or-owner-write-fenced' },
    preserveRule: 'a future operation must fence and drain the shared queue before any owner-scoped primitive; it must preserve queued work for every other owner',
    executionGroup: 'renderer-ozon-shop-settings-write-pipeline',
    risk: 'an in-flight optimistic settings write can backwrite account preferences or credentials after a future deletion unless the full queue is write-fenced',
  }),
  externalEntry({
    id: 'memory:renderer-purchase-order-local-overrides-unattributed',
    storageKind: 'memory',
    resource: 'frontend services/purchaseOrderRuntime purchaseOrderLocalOverridesMemory',
    ownerType: 'unknown',
    ownerField: 'legacy override object keys can be unscoped order keys while values may contain different shopIds',
    risk: 'the aggregate legacy override snapshot cannot be selected safely for one account without a canonical scoped-key readback contract',
  }),
  externalEntry({
    id: 'memory:renderer-purchase-order-override-local-api-hashes-unattributed',
    storageKind: 'memory',
    resource: 'frontend services/purchaseOrderRuntime purchaseOrderOverrideLocalApiHashes Map',
    ownerType: 'unknown',
    ownerField: 'dedupe hash is keyed by orderKey without an authoritative shop/account identity',
    risk: 'one order key or hash entry must not be attributed to a shop by string shape; preserve until the cache key carries verified owner scope',
  }),
  externalEntry({
    id: 'runtime:renderer-purchase-order-override-local-api-write-queue',
    storageKind: 'runtime',
    resource: 'frontend services/purchaseOrderRuntime purchaseOrderOverrideLocalApiWriteQueue',
    ownerType: 'system',
    ownerField: 'one renderer-global queue serializes purchase override writes that can span multiple shops',
    deletePrimitive: 'future:accountRemoval.purchaseOrderOverrideWritePipelineQuiesce',
    verifyQuery: { type: 'runtime-owner-state', path: 'purchaseOrderOverrideLocalApiWriteQueue', expected: 'stopped-or-owner-write-fenced' },
    preserveRule: 'a future operation must fence and drain this shared write queue before any owner action, preserving entries that cannot be proven to belong to the selected owner',
    executionGroup: 'renderer-purchase-order-override-write-pipeline',
    risk: 'the queued persistence path can backwrite canonical purchase overrides or a legacy fallback after a future owner removal unless it is quiesced first',
  }),
  externalEntry({
    id: 'runtime:renderer-purchase-order-override-migration-task',
    storageKind: 'runtime',
    resource: 'frontend services/purchaseOrderRuntime activePurchaseOrderOverrideMigration',
    ownerType: 'system',
    ownerField: 'one startup migration reads legacy and canonical override sets across its current aggregate input',
    deletePrimitive: 'future:accountRemoval.purchaseOrderOverrideWritePipelineQuiesce',
    verifyQuery: { type: 'runtime-owner-state', path: 'activePurchaseOrderOverrideMigration', expected: 'stopped-or-owner-write-fenced' },
    preserveRule: 'a future operation must wait for or fence the migration before any owner-scoped work; it must not infer ownership from legacy order keys',
    executionGroup: 'renderer-purchase-order-override-write-pipeline',
    risk: 'a concurrent migration can re-persist or retain legacy override data after a future account operation if it is not explicitly quiesced',
  }),
  externalEntry({
    id: 'memory:renderer-purchase-plugin-source-context-unattributed',
    storageKind: 'memory',
    resource: 'frontend services/purchasePluginContextStore purchasePluginSourceContextMemory',
    ownerType: 'unknown',
    ownerField: 'context can contain shopId, order, product, link, and amount but no authoritative purchaseAccountId',
    risk: 'purchase plugin context must remain preserved until a single purchase-account binding exists; shop/order fields are not a substitute for that binding',
  }),
  externalEntry({
    id: 'runtime:renderer-purchase-plugin-context-write-queue',
    storageKind: 'runtime',
    resource: 'frontend services/purchasePluginContextStore purchasePluginContextWriteQueue',
    ownerType: 'system',
    ownerField: 'one renderer-global queue serializes profile-settings writes and legacy source markers',
    deletePrimitive: 'future:accountRemoval.purchasePluginContextWritePipelineQuiesce',
    verifyQuery: { type: 'runtime-owner-state', path: 'purchasePluginContextWriteQueue', expected: 'stopped-or-owner-write-fenced' },
    preserveRule: 'a future operation must fence and drain this shared queue before any account primitive and preserve every context without an authoritative purchaseAccountId',
    executionGroup: 'renderer-purchase-plugin-context-write-pipeline',
    risk: 'queued canonical or migration writes can backwrite a plugin context after a future account operation unless the pipeline is quiesced',
  }),
  externalEntry({
    id: 'runtime:renderer-purchase-plugin-context-last-operation',
    storageKind: 'runtime',
    resource: 'frontend services/purchasePluginContextStore lastPurchasePluginContextOperation',
    ownerType: 'system',
    ownerField: 'last operation is a shared completion promise for the renderer-global plugin context pipeline',
    deletePrimitive: 'future:accountRemoval.purchasePluginContextWritePipelineQuiesce',
    verifyQuery: { type: 'runtime-owner-state', path: 'lastPurchasePluginContextOperation', expected: 'stopped-or-owner-write-fenced' },
    preserveRule: 'a future operation must wait for or fence the last shared operation and preserve unscoped context rather than treating completion as an owner match',
    executionGroup: 'renderer-purchase-plugin-context-write-pipeline',
    risk: 'a stale completion can race a future removal and publish or re-save context unless the shared operation boundary is observed',
  }),
  externalEntry({
    id: 'runtime:renderer-purchase-plugin-context-migration-task',
    storageKind: 'runtime',
    resource: 'frontend services/purchasePluginContextStore activePurchasePluginSourceContextMigration',
    ownerType: 'system',
    ownerField: 'one startup migration reads legacy browser/file context and may write canonical profile settings',
    deletePrimitive: 'future:accountRemoval.purchasePluginContextWritePipelineQuiesce',
    verifyQuery: { type: 'runtime-owner-state', path: 'activePurchasePluginSourceContextMigration', expected: 'stopped-or-owner-write-fenced' },
    preserveRule: 'a future operation must fence or await this migration before touching an owner; no legacy context may be attributed by shop/order fields alone',
    executionGroup: 'renderer-purchase-plugin-context-write-pipeline',
    risk: 'the migration can backwrite or retain a legacy plugin context after a future account action unless it is explicitly quiesced',
  }),
  externalEntry({
    id: 'runtime:renderer-purchase-plugin-context-revision-guard',
    storageKind: 'runtime',
    resource: 'frontend services/purchasePluginContextStore purchasePluginContextRevision',
    ownerType: 'system',
    ownerField: 'one renderer-global revision gate decides whether queued/migration results may publish context',
    deletePrimitive: 'future:accountRemoval.purchasePluginContextWritePipelineQuiesce',
    verifyQuery: { type: 'runtime-owner-state', path: 'purchasePluginContextRevision', expected: 'stopped-or-owner-write-fenced' },
    preserveRule: 'a future operation must coordinate the revision guard with its queue and migration; the guard itself is not an ownership proof or a delete target',
    executionGroup: 'renderer-purchase-plugin-context-write-pipeline',
    risk: 'changing or ignoring the revision guard can allow an older task to re-publish a context after a future write fence',
  }),
  externalEntry({
    id: 'memory:renderer-cross-border-settings-unattributed',
    storageKind: 'memory',
    resource: 'frontend shared/ozon/ozonRuntime crossBorderSettingsMemory',
    ownerType: 'unknown',
    ownerField: 'settings can fall back to a configured main account and do not prove one canonical cross_border_accounts row',
    risk: 'a preferred accountId string or default account fallback is insufficient to select a cross-border account memory snapshot for removal',
  }),
  externalEntry({
    id: 'runtime:renderer-cross-border-settings-write-queue',
    storageKind: 'runtime',
    resource: 'frontend shared/ozon/ozonRuntime crossBorderSettingsWriteQueue',
    ownerType: 'system',
    ownerField: 'one renderer-global queue persists cross-border preference state that can combine profile and account data',
    deletePrimitive: 'future:accountRemoval.crossBorderSettingsQueueQuiesce',
    verifyQuery: { type: 'runtime-owner-state', path: 'crossBorderSettingsWriteQueue', expected: 'stopped-or-owner-write-fenced' },
    preserveRule: 'a future operation must fence and drain this shared queue before any exact account primitive and preserve all unproven preference/account combinations',
    executionGroup: 'renderer-cross-border-settings-write-pipeline',
    risk: 'the queue can backwrite cross-border preferences after a future account operation unless it is quiesced at the shared pipeline boundary',
  }),
  externalEntry({
    id: 'memory:desktop-license-session-store-memory',
    storageKind: 'memory',
    resource: 'desktop licensing LicenseSessionStore memory',
    ownerType: 'system',
    ownerField: 'desktop-global license user/token/entitlement snapshot has no business account owner',
    backupRule: 'required',
    risk: 'license session state authorizes the application installation and must never be treated as Ozon, cross-border, promotion, purchase, or model account data',
  }),
  externalEntry({
    id: 'runtime:desktop-license-session-load-task',
    storageKind: 'runtime',
    resource: 'desktop licensing LicenseSessionStore loaded flag and loadPromise',
    ownerType: 'system',
    ownerField: 'desktop-global license load state is shared by the installation',
    deletePrimitive: 'future:accountRemoval.licenseSessionRuntimeFence',
    verifyQuery: { type: 'runtime-owner-state', path: 'LicenseSessionStore.loadPromise', expected: 'stopped-or-owner-write-fenced' },
    preserveRule: 'a future account operation may fence the shared license runtime only to prevent unrelated persistence races; it must preserve license state and never clear it',
    backupRule: 'required',
    executionGroup: 'desktop-license-session-runtime',
    risk: 'a license load may publish installation-wide authorization while an unrelated account operation is running; it is a preserve-only coordination concern',
  }),
  externalEntry({
    id: 'runtime:desktop-license-session-operation-queue',
    storageKind: 'runtime',
    resource: 'desktop licensing LicenseSessionStore operationQueue',
    ownerType: 'system',
    ownerField: 'one desktop-global queue serializes encrypted license save/clear operations',
    deletePrimitive: 'future:accountRemoval.licenseSessionRuntimeFence',
    verifyQuery: { type: 'runtime-owner-state', path: 'LicenseSessionStore.operationQueue', expected: 'stopped-or-owner-write-fenced' },
    preserveRule: 'a future operation must fence this system queue only for coordination and must not change license session or device identity while removing a business account',
    backupRule: 'required',
    executionGroup: 'desktop-license-session-runtime',
    risk: 'license operations write global encrypted state and must remain outside every business-account deletion scope',
  }),
  externalEntry({
    id: 'runtime:desktop-license-device-code-load-task',
    storageKind: 'runtime',
    resource: 'desktop licensing LicenseSessionStore deviceCodePromise',
    ownerType: 'system',
    ownerField: 'desktop-global device code load/create task is not a business account owner',
    deletePrimitive: 'future:accountRemoval.licenseSessionRuntimeFence',
    verifyQuery: { type: 'runtime-owner-state', path: 'LicenseSessionStore.deviceCodePromise', expected: 'stopped-or-owner-write-fenced' },
    preserveRule: 'a future operation must preserve the device identity and coordinate its shared task rather than regenerating or deleting it for one account',
    backupRule: 'required',
    executionGroup: 'desktop-license-session-runtime',
    risk: 'a concurrent device-code task writes installation identity and is never an account-removal target',
  }),
  externalEntry({
    id: 'memory:desktop-purchase-bridge-auth-token',
    storageKind: 'memory',
    resource: 'desktop runtime purchaseBridgeState authToken',
    ownerType: 'system',
    ownerField: 'per-process bridge authorization token has no purchaseAccountId or business account owner',
    backupRule: 'excluded',
    risk: 'the runtime bridge token is a global process secret distinct from current external Chrome storage and future per-purchase-account Electron partitions',
  }),
  externalEntry({
    id: 'memory:renderer-product-list-memory-cache-unattributed',
    storageKind: 'memory',
    resource: 'frontend productLocalData productListMemoryCache',
    ownerType: 'unknown',
    ownerField: 'cache key can use client, id, or label fallback from getOzonStableShopSourceKey',
    risk: 'label fallback prevents authoritative one-owner invalidation without a current shop binding resolver',
  }),
  externalEntry({
    id: 'memory:renderer-product-list-page-meta-cache-unattributed',
    storageKind: 'memory',
    resource: 'frontend productLocalData productListPageMetaMemoryCache',
    ownerType: 'unknown',
    ownerField: 'cache key can use client, id, or label fallback from getOzonStableShopSourceKey',
    risk: 'page metadata key has the same non-authoritative label fallback as product list rows',
  }),
  externalEntry({
    id: 'memory:renderer-product-list-cursor-cache-unattributed',
    storageKind: 'memory',
    resource: 'frontend productLocalData productListCursorMemoryCache',
    ownerType: 'unknown',
    ownerField: 'cache key can use client, id, or label fallback from getOzonStableShopSourceKey',
    risk: 'cursor cache cannot be cleared by a business owner while legacy label keys remain valid',
  }),
  externalEntry({
    id: 'memory:renderer-ozon-snapshot-memory-cache-unattributed',
    storageKind: 'memory',
    resource: 'frontend shared/config appConfigRuntime ozonSnapshotMemoryCache',
    ownerType: 'unknown',
    ownerField: 'snapshot key can represent one or more source shops',
    risk: 'snapshot key ownership is not an authoritative single-shop contract',
  }),
  externalEntry({
    id: 'memory:renderer-ozon-snapshot-inflight-unattributed',
    storageKind: 'memory',
    resource: 'frontend shared/config appConfigRuntime ozonSnapshotInFlight',
    ownerType: 'unknown',
    ownerField: 'in-flight snapshot key can represent one or more source shops',
    risk: 'in-flight requests require a future cancellation/scope contract before any owner action',
  }),
  externalEntry({
    id: 'memory:renderer-ozon-snapshot-manual-refresh-unattributed',
    storageKind: 'memory',
    resource: 'frontend shared/config appConfigRuntime ozonSnapshotManualRefreshAt',
    ownerType: 'unknown',
    ownerField: 'manual refresh key has no authoritative single-owner map',
    risk: 'refresh timing may represent an aggregate snapshot and is fail-closed',
  }),
  externalEntry({
    id: 'runtime:renderer-sales-supplement-cooldown-unattributed',
    storageKind: 'runtime',
    resource: 'frontend shared/config appConfigRuntime salesSupplementCooldown',
    ownerType: 'unknown',
    ownerField: 'cooldown key is not declared as one authoritative shopId',
    risk: 'cooldown state may suppress shared reads and must remain preserved until scoped cancellation exists',
  }),
  externalEntry({
    id: 'runtime:renderer-purchase-supplement-cooldown-unattributed',
    storageKind: 'runtime',
    resource: 'frontend shared/config appConfigRuntime purchaseSupplementCooldown',
    ownerType: 'unknown',
    ownerField: 'cooldown key is not declared as one authoritative purchaseAccountId or shopId',
    risk: 'purchase cooldown lacks an account identity contract',
  }),
  externalEntry({
    id: 'runtime:renderer-profit-finance-cooldown-unattributed',
    storageKind: 'runtime',
    resource: 'frontend shared/config appConfigRuntime profitFinanceCooldown',
    ownerType: 'unknown',
    ownerField: 'cooldown key is not declared as one authoritative shopId',
    risk: 'finance cooldown may coordinate mixed requests and is fail-closed',
  }),
  externalEntry({
    id: 'memory:renderer-sales-order-paged-cache-unattributed',
    storageKind: 'memory',
    resource: 'frontend services/salesOrderPagedCacheClient salesOrderPagedMemoryCache',
    ownerType: 'unknown',
    ownerField: 'query can contain one shopId or aggregate shopIds across multiple shops',
    risk: 'multi-shop page cache cannot be selected for one owner from its serialized query alone',
  }),
  externalEntry({
    id: 'memory:renderer-profit-finance-operation-cache',
    storageKind: 'memory',
    resource: 'frontend profitFinanceEvidence profitFinanceOperationCache',
    scopeType: 'shop',
    ownerType: 'ozon_shop',
    ownerField: 'resolver:ozon-shop-client-id',
    deletePrimitive: 'future:accountRemoval.profitFinanceOperationCacheInvalidate',
    verifyQuery: { type: 'memory-owner-absence', ownerField: 'resolver:ozon-shop-client-id', expected: 'absent' },
    preserveRule: 'invalidate only entries whose resolved current shop binding exactly equals ownerId; preserve unresolvable keys and other shops',
    risk: 'clientId fallback needs a read-only current shops binding before an owner-scoped invalidation',
  }),
  externalEntry({
    id: 'memory:renderer-profit-after-sales-snapshot-cache',
    storageKind: 'memory',
    resource: 'frontend profitFinanceEvidence profitAfterSalesSnapshotCache',
    scopeType: 'shop',
    ownerType: 'ozon_shop',
    ownerField: 'resolver:ozon-shop-client-id',
    deletePrimitive: 'future:accountRemoval.profitAfterSalesSnapshotCacheInvalidate',
    verifyQuery: { type: 'memory-owner-absence', ownerField: 'resolver:ozon-shop-client-id', expected: 'absent' },
    preserveRule: 'invalidate only entries with an exact current shop binding; preserve unresolvable and other-shop entries',
    risk: 'after-sales snapshot key combines owner and time scope and must not be matched by substring',
  }),
  externalEntry({
    id: 'memory:renderer-profit-rating-penalty-operation-cache',
    storageKind: 'memory',
    resource: 'frontend profitLedgerMapping profitRatingPenaltyOperationCache',
    scopeType: 'shop',
    ownerType: 'ozon_shop',
    ownerField: 'resolver:ozon-shop-client-id',
    deletePrimitive: 'future:accountRemoval.profitRatingPenaltyCacheInvalidate',
    verifyQuery: { type: 'memory-owner-absence', ownerField: 'resolver:ozon-shop-client-id', expected: 'absent' },
    preserveRule: 'invalidate only entries with an exact current shop binding; preserve unresolvable and other-shop entries',
    risk: 'rating lookup key also contains posting and date ranges, so owner matching must resolve the leading shop binding only',
  }),
  externalEntry({
    id: 'memory:renderer-ozon-order-supplement-cache-unattributed',
    storageKind: 'memory',
    resource: 'frontend ozonOrderExperience supplementCache',
    ownerType: 'unknown',
    ownerField: 'order experience key can use shopClientId, shopId, sellerId, shopName, storeName, or no shop key',
    risk: 'supplement keys can fall back to labels or an unscoped order and cannot prove one shop owner',
  }),
  externalEntry({
    id: 'memory:renderer-ozon-order-image-preload-cache-unattributed',
    storageKind: 'memory',
    resource: 'frontend ozonOrderExperience imagePreloadCache keyed only by image URL',
    ownerType: 'unknown',
    ownerField: 'image URL has no account owner',
    risk: 'a product image can be shared across shops and no owner may be inferred from URL text',
  }),
  externalEntry({
    id: 'memory:renderer-local-api-active-issues-unattributed',
    storageKind: 'memory',
    resource: 'frontend api/localApiClient localApiActiveIssues keyed by request path',
    ownerType: 'unknown',
    ownerField: 'issue map key is normalized local API path without owner identity',
    risk: 'path-level failures can be shared and are fail-closed',
  }),
  externalEntry({
    id: 'memory:renderer-local-api-sync-jobs-unattributed',
    storageKind: 'memory',
    resource: 'frontend api/localApiClient localApiSyncJobs keyed by jobId',
    ownerType: 'unknown',
    ownerField: 'jobId cache has no authoritative owner field in the renderer contract',
    risk: 'job payload may omit or aggregate scope; preserve until a read-only owner map exists',
  }),
  externalEntry({
    id: 'memory:local-api-exchange-rate-daily-cache',
    storageKind: 'memory',
    resource: 'local-api exchangeRateService dailyRateCache keyed by date',
    ownerType: 'system',
    ownerField: 'date-only exchange rate cache is global',
    backupRule: 'excluded',
    risk: 'daily currency rate is shared system data, not a business account resource',
  }),
  externalEntry({
    id: 'runtime:local-api-exchange-rate-batch-inflight',
    storageKind: 'runtime',
    resource: 'local-api exchangeRateService dailyBatchInflight keyed by date',
    ownerType: 'system',
    ownerField: 'date-only batch request is global',
    backupRule: 'excluded',
    risk: 'global exchange-rate fetches must not be cancelled by one business owner removal',
  }),
  externalEntry({
    id: 'memory:local-api-software-category-name-index',
    storageKind: 'memory',
    resource: 'local-api softwareCategoryNameService categoryIndexCache built from versioned SQLite shared catalog',
    ownerType: 'system',
    ownerField: 'profile-shared catalog version has no business-account scope',
    backupRule: 'excluded',
    risk: 'software category index is a disposable L0 projection, but its SQLite shared-catalog source is canonical and must survive account/cache deletion',
  }),
  externalEntry({
    id: 'runtime:local-api-traffic-controller-mixed-state',
    storageKind: 'runtime',
    resource: 'local-api trafficController nextAllowedAt, limitedUntil, and recentLimits',
    ownerType: 'system',
    ownerField: 'physical map container; exact owner slices are cataloged separately',
    risk: 'the container is preserved while logical:local-api-traffic-controller-shop-state clears only one exact shop prefix',
  }),
  externalEntry({
    id: 'memory:local-api-rate-limit-state-mixed-next-allowed',
    storageKind: 'memory',
    resource: 'local-api rateLimitState nextAllowedAt keyed by exact shopId plus endpoint/bucket',
    ownerType: 'system',
    ownerField: 'physical map container; exact owner slices are cataloged separately',
    risk: 'the container is preserved while logical:local-api-rate-limit-shop-state clears only the selected shop state',
  }),
  externalEntry({
    id: 'runtime:renderer-ozon-request-control-queue-unattributed',
    storageKind: 'runtime',
    resource: 'frontend ozonRequestControl queue and active controller state',
    ownerType: 'system',
    ownerField: 'physical renderer controller containing separate queuesByShop entries',
    risk: 'the controller container is preserved; each request lane remains isolated by its exact shop key',
  }),
  externalEntry({
    id: 'memory:renderer-ozon-request-control-inflight-issues-unattributed',
    storageKind: 'memory',
    resource: 'frontend ozonRequestControl inFlightByDedupeKey and activeIssues',
    ownerType: 'system',
    ownerField: 'physical renderer maps containing only shop-prefixed dedupe and issue keys',
    risk: 'the maps are preserved as a container; dedupe cannot coalesce requests from different shops',
  }),
  externalEntry({
    id: 'runtime:desktop-app-protocol-file-write-queues',
    storageKind: 'runtime',
    resource: 'desktop appProtocol writeQueues for local-data JSON paths',
    ownerType: 'system',
    ownerField: 'one desktop-global queue map serializes multiple legacy JSON paths',
    backupRule: 'excluded',
    risk: 'protocol queue can contain mixed/unscoped legacy file operations and must be preserved/fenced before any future storage action',
  }),
  externalEntry({
    id: 'runtime:renderer-local-mirror-file-write-queues-unattributed',
    storageKind: 'runtime',
    resource: 'frontend productLocalData localMirrorReadLogWriteQueue and localMirrorRetryQueueWriteQueue',
    ownerType: 'unknown',
    ownerField: 'legacy mirror log/retry queues have no authoritative business-owner field',
    risk: 'renderer write queues can flush mixed legacy records and must not be cleared by guessed scope',
  }),
  externalEntry({
    id: 'runtime:renderer-ozon-local-data-file-write-queues-unattributed',
    storageKind: 'runtime',
    resource: 'frontend productLocalData ozonLocalDataWriteQueues keyed by local-data file key',
    ownerType: 'unknown',
    ownerField: 'file key is a legacy storage key, not an authoritative account owner',
    risk: 'file write queue can serialize unscoped/mixed JSON updates and is fail-closed',
  }),
  externalEntry({
    id: 'filesystem:desktop-data-profile-json',
    storageKind: 'filesystem',
    resource: 'desktop dataRoot/profile.json',
    ownerType: 'system',
    ownerField: 'single profile metadata file spans application/account domains',
    backupRule: 'required',
    risk: 'profile JSON is not a single business-account file and must remain preserved',
  }),
  externalEntry({
    id: 'filesystem:desktop-data-logs-directory',
    storageKind: 'filesystem',
    resource: 'desktop dataRoot/logs/',
    ownerType: 'system',
    ownerField: 'desktop-global log directory',
    backupRule: 'excluded',
    executionGroup: 'desktop-data-logs',
    risk: 'logs can contain mixed runtime diagnostics and are not an account deletion target',
  }),
  externalEntry({
    id: 'filesystem:desktop-runtime-profile-lock',
    storageKind: 'filesystem',
    resource: 'desktop dataRoot/runtime/profile.lock',
    ownerType: 'system',
    ownerField: 'single profile process lock',
    backupRule: 'excluded',
    risk: 'profile lock coordinates the whole desktop process and must never be removed for one account',
  }),
  externalEntry({
    id: 'filesystem:desktop-backups-directory-unattributed',
    storageKind: 'filesystem',
    resource: 'desktop dataRoot/backups/',
    ownerType: 'unknown',
    ownerField: 'local backup directory can contain profile-wide or mixed owner generations',
    backupRule: 'preserve-until-owner-partition-contract',
    risk: 'backup path ownership cannot be inferred from directory placement',
  }),
  externalEntry({
    id: 'filesystem:desktop-tmp-directory-unattributed',
    storageKind: 'filesystem',
    resource: 'desktop dataRoot/tmp/',
    ownerType: 'unknown',
    ownerField: 'temporary files can belong to mixed restore/runtime operations',
    backupRule: 'excluded',
    risk: 'temporary path has no authoritative owner manifest and remains prohibited',
  }),
  externalEntry({
    id: 'filesystem:desktop-local-api-data-root',
    storageKind: 'filesystem',
    resource: 'desktop dataRoot/local-api-data/',
    ownerType: 'system',
    ownerField: 'one local-api data root contains canonical SQLite plus profile key material',
    backupRule: 'required',
    executionGroup: 'desktop-local-api-data-root',
    risk: 'path-level root is shared by every account domain and is preserved; per-owner work must use canonical registry resources only',
  }),
  externalEntry({
    id: 'filesystem:desktop-local-api-sqlite-file',
    storageKind: 'sqlite',
    resource: 'desktop dataRoot/local-api-data/wangzai-local-api.sqlite',
    ownerType: 'system',
    ownerField: 'one canonical database file contains multiple owner and system tables',
    backupRule: 'required',
    executionGroup: 'desktop-local-api-data-root',
    risk: 'database path is not a table or owner boundary; future execution must use registry-scoped rows and preserve the file',
  }),
  externalEntry({
    id: 'filesystem:desktop-license-session',
    storageKind: 'filesystem',
    resource: 'desktop license directory/license-session.bin',
    ownerType: 'system',
    ownerField: 'encrypted desktop license session is device/profile scoped',
    backupRule: 'required',
    risk: 'license session can authorize the whole installation and is not business-account data',
  }),
  externalEntry({
    id: 'filesystem:desktop-license-device-id',
    storageKind: 'filesystem',
    resource: 'desktop license directory/license-device-id',
    ownerType: 'system',
    ownerField: 'stable desktop device identifier',
    backupRule: 'required',
    risk: 'device identity is global and must not be regenerated by account removal',
  }),
  externalEntry({
    id: 'filesystem:desktop-purchase-bridge-license-state',
    storageKind: 'filesystem',
    resource: 'desktop runtime/purchase-bridge-license.json',
    ownerType: 'system',
    ownerField: 'bridge license state has authorization mode/permissions but no purchaseAccountId',
    backupRule: 'excluded',
    risk: 'current bridge authorization state is global runtime state, separate from future purchase-account browser identity',
  }),
  externalEntry({
    id: 'runtime:desktop-process-supervisor-child-processes',
    storageKind: 'runtime',
    resource: 'desktop processSupervisor childProcesses Map',
    ownerType: 'system',
    ownerField: 'desktop-global child process names include local-api and purchase-search-bridge',
    backupRule: 'excluded',
    risk: 'supervisor lifecycle is global; any future owner quiesce must coordinate rather than kill unrelated processes',
  }),
  externalEntry({
    id: 'filesystem:desktop-process-supervisor-logs',
    storageKind: 'filesystem',
    resource: 'desktop processSupervisor appendLog files under dataRoot/logs/',
    ownerType: 'system',
    ownerField: 'one shared log directory and child-name file convention',
    backupRule: 'excluded',
    executionGroup: 'desktop-data-logs',
    risk: 'process logs can mix all runtime/account events and are not owner-removable',
  }),
  externalEntry({
    id: 'memory:collection-browser-capture-inbox-listeners',
    storageKind: 'memory',
    resource: 'collection pricing browser capture inbox listener Set',
    ownerType: 'system',
    ownerField: 'renderer-global transient subscriber callbacks without account data',
    sourceEvidence: sourceEvidence(
      'frontend/src/features/collectionPricing/services/collectionBrowserCaptureInbox.js',
      'const listeners = new Set();',
      'the listener registry is process-global transient UI wiring and contains no business-account payload',
    ),
    backupRule: 'excluded',
    risk: 'preserve the shared subscriber registry; pending capture payload ownership is handled separately by its producer contract',
  }),
]);

const EXTERNAL_ACCOUNT_OWNERSHIP_RESOURCES = Object.freeze([
  ...CURRENT_RUNTIME_OWNERSHIP_RESOURCES,
  ...ACCOUNT_OWNERSHIP_V8_EXTERNAL_INPUTS.map(externalEntry),
  ...ACCOUNT_OWNERSHIP_V9_EXTERNAL_INPUTS.map(externalEntry),
  // Coverage-audit current resources.  These declarations are deliberately
  // separate from the registry generated SQLite list: each is a renderer,
  // runtime, file, browser-extension, or recovery state that the registry
  // cannot observe.  Unknown or mixed ownership stays prohibited.
  externalEntry({
    id: 'memory:renderer-marketing-activity-runtime-cache', storageKind: 'memory',
    resource: 'frontend orderShopScope marketingActivityRuntimeCacheStore', ownerType: 'unknown',
    ownerField: 'marketing runtime cache contains aggregate shop snapshots without one authoritative owner selector',
    sourceEvidence: sourceEvidence('frontend/src/entities/order/orderShopScope.jsx', 'export let marketingActivityRuntimeCacheStore = {};', 'marketing cache is an aggregate renderer object'),
    preserveRule: 'preserve mixed cache state; a future operation must first establish an exact shop slice and readback',
    risk: 'marketing cache can revive a stale activity snapshot after a future account operation unless its write pipeline is fenced',
  }),
  externalEntry({
    id: 'runtime:renderer-marketing-view-state-write-queue', storageKind: 'runtime',
    resource: 'frontend orderShopScope marketingActivityViewStateWriteQueue', ownerType: 'system',
    ownerField: 'renderer-global marketing view-state queue coordinates profile and shop selections',
    deletePrimitive: 'future:accountRemoval.marketingViewStateWritePipelineQuiesce',
    verifyQuery: { type: 'runtime-owner-state', path: 'marketingActivityViewStateWriteQueue', expected: 'stopped-or-owner-write-fenced' },
    sourceEvidence: sourceEvidence('frontend/src/entities/order/orderShopScope.jsx', 'export let marketingActivityViewStateWriteQueue = Promise.resolve();', 'one queue may re-persist mixed marketing view state'),
    preserveRule: 'fence and drain the shared queue before a future owner primitive; preserve other shop and global view state',
    risk: 'queued marketing state can backwrite or revive data after a future deletion without a write fence',
  }),
  externalEntry({
    id: 'memory:renderer-product-material-profiles', storageKind: 'memory', scopeType: 'shop', ownerType: 'ozon_shop',
    resource: 'frontend productMaterialProfileStore productMaterialProfileMemory exact shop profile slice', ownerField: 'resolver:product-material-profile-shop-slice',
    deletePrimitive: 'future:accountRemoval.productMaterialProfileOwnerInvalidate',
    verifyQuery: { type: 'memory-owner-absence', ownerField: 'resolver:product-material-profile-shop-slice', expected: 'absent' },
    sourceEvidence: sourceEvidence('frontend/src/services/productMaterialProfileStore.js', 'let productMaterialProfileMemory = null;', 'future resolver must use canonical profile shopId, never a cache label'),
    preserveRule: 'invalidate only records with a validated exact shopId; preserve unknown, null, and other-shop records',
    risk: 'profile memory can retain or revive material data if its authoritative shop slice is not read back before a future operation',
  }),
  externalEntry({
    id: 'runtime:renderer-product-material-profile-write-queue', storageKind: 'runtime', ownerType: 'system',
    resource: 'frontend productMaterialProfileStore productMaterialProfileLocalApiWriteQueue',
    ownerField: 'renderer-global material profile write pipeline',
    deletePrimitive: 'future:accountRemoval.productMaterialProfileWritePipelineQuiesce',
    verifyQuery: { type: 'runtime-owner-state', path: 'productMaterialProfileLocalApiWriteQueue', expected: 'stopped-or-owner-write-fenced' },
    sourceEvidence: sourceEvidence('frontend/src/services/productMaterialProfileStore.js', 'let productMaterialProfileLocalApiWriteQueue = Promise.resolve();', 'shared queue can write multiple profile records'),
    preserveRule: 'fence and drain the queue before future owner work and preserve all unproven queued records',
    risk: 'queued product material persistence can backwrite a deleted shop slice without quiesce and readback',
  }),
  externalEntry({
    id: 'runtime:renderer-product-source-link-migration', storageKind: 'runtime', ownerType: 'system',
    resource: 'frontend productSourceLinkStore activeProductSourceLinkMigration', ownerField: 'shared source-link migration promise',
    deletePrimitive: 'future:accountRemoval.sourceLinkMigrationFence',
    verifyQuery: { type: 'runtime-owner-state', path: 'activeProductSourceLinkMigration', expected: 'stopped-or-owner-write-fenced' },
    sourceEvidence: sourceEvidence('frontend/src/services/productSourceLinkStore.js', 'let activeProductSourceLinkMigration = null;', 'startup migration may consume multiple legacy aliases'),
    preserveRule: 'wait for or fence migration before future owner work; preserve unrelated migration inputs',
    risk: 'a source-link migration can recreate a legacy record after deletion unless it is fenced and read back',
  }),
  externalEntry({
    id: 'runtime:renderer-sales-source-link-migration', storageKind: 'runtime', ownerType: 'system',
    resource: 'frontend salesSourceLinkStore salesSourceLinkMigrationCoordinator', ownerField: 'shared sales source-link migration coordinator',
    deletePrimitive: 'future:accountRemoval.sourceLinkMigrationFence',
    verifyQuery: { type: 'runtime-owner-state', path: 'salesSourceLinkMigrationCoordinator', expected: 'stopped-or-owner-write-fenced' },
    sourceEvidence: sourceEvidence('frontend/src/services/salesSourceLinkStore.js', 'const salesSourceLinkMigrationCoordinator = createLegacyScopedMigrationCoordinator();', 'coordinator owns concurrent legacy migration coordination'),
    preserveRule: 'fence or await coordinator before future owner work; preserve other shops',
    risk: 'concurrent sales link migration can re-persist a source link after an owner operation',
  }),
  externalEntry({
    id: 'runtime:renderer-purchase-source-link-migration', storageKind: 'runtime', ownerType: 'system',
    resource: 'frontend purchaseSourceLinkStore purchaseSourceLinkMigrationCoordinator', ownerField: 'shared purchase source-link migration coordinator',
    deletePrimitive: 'future:accountRemoval.sourceLinkMigrationFence',
    verifyQuery: { type: 'runtime-owner-state', path: 'purchaseSourceLinkMigrationCoordinator', expected: 'stopped-or-owner-write-fenced' },
    sourceEvidence: sourceEvidence('frontend/src/services/purchaseSourceLinkStore.js', 'const purchaseSourceLinkMigrationCoordinator = createLegacyScopedMigrationCoordinator();', 'coordinator owns concurrent legacy migration coordination'),
    preserveRule: 'fence or await coordinator before future owner work; preserve other shops',
    risk: 'concurrent purchase link migration can re-persist a source link after an owner operation',
  }),
  externalEntry({
    id: 'runtime:local-api-performance-request-queue', storageKind: 'runtime', scopeType: 'external', ownerType: 'promotion_account',
    resource: 'local-api performanceApiClient per-account queue state, performanceQueuedByOwner, and owner fence', ownerField: 'resolver:performance-account-runtime',
    deletePrimitive: 'future:accountRemovalRuntimeCoordinator.quiesce.performanceApiRuntime',
    verifyQuery: { type: 'runtime-owner-count', path: 'resolver:performance-account-runtime', expected: 'zero' },
    sourceEvidence: sourceEvidence('local-api/src/integrations/performanceApiClient.js', 'const performanceQueueStatesByOwner = new Map();', 'queue, active, token, and in-flight indexes use the exact performance account id'),
    preserveRule: 'fence and drain only the exact Performance account queue; preserve every other account lane',
    risk: 'a queued promotion request must be drained by its exact account id before that account row is removed',
  }),
  externalEntry({
    id: 'runtime:desktop-recovery-staged-descriptors', storageKind: 'runtime', ownerType: 'unknown',
    resource: 'desktop recoveryIpcBridge stagedRecoveries Map', ownerField: 'restore descriptor can represent a mixed profile and multiple shops',
    sourceEvidence: sourceEvidence('desktop/src/runtime/recoveryIpcBridge.js', 'const stagedRecoveries = new Map();', 'staged recovery descriptor has no single business owner'),
    preserveRule: 'preserve staged descriptors until an authoritative restore owner manifest exists; future recovery must quiesce and read back',
    risk: 'activating or clearing a mixed staged recovery can restore data after a future owner action',
  }),
  externalEntry({
    id: 'filesystem:recovery-rollback-root', storageKind: 'filesystem', ownerType: 'unknown',
    resource: 'desktop recovery restore-rollback/<suffix> database family', ownerField: 'rollback database family contains whole profile state',
    sourceEvidence: sourceEvidence('desktop/src/runtime/recoveryDatabaseActivator.js', "const rollbackDirectory = path.join(path.dirname(activePath), 'restore-rollback', suffix);", 'rollback directory holds full mixed database family'),
    preserveRule: 'preserve rollback directories until an explicit owner-partition recovery contract exists',
    risk: 'rollback files can contain all owners and must never be removed from a guessed account scope',
  }),
  externalEntry({
    id: 'filesystem:recovery-failed-root', storageKind: 'filesystem', ownerType: 'unknown',
    resource: 'desktop recovery restore-failed/<suffix> database family', ownerField: 'failed restore database family contains whole profile state',
    sourceEvidence: sourceEvidence('desktop/src/runtime/recoveryDatabaseActivator.js', "const failedDirectory = path.join(path.dirname(activePath), 'restore-failed', suffix);", 'failed recovery directory holds full mixed database family'),
    preserveRule: 'preserve failed recovery directories until an explicit owner-partition recovery contract exists',
    risk: 'failed restore files can contain all owners and must never be removed from a guessed account scope',
  }),
  externalEntry({
    id: 'filesystem:desktop-local-api-sqlite-sidecars', storageKind: 'filesystem', ownerType: 'system',
    resource: 'desktop local-api SQLite -wal and -shm sidecar files', ownerField: 'profile database family shared system state',
    sourceEvidence: sourceEvidence('desktop/src/runtime/recoveryDatabaseActivator.js', 'function databaseFamily(databasePath) {', 'profile database family; shared system state'),
    preserveRule: 'preserve WAL and SHM sidecars; a future physical-erasure phase requires checkpoint proof outside account removal',
    risk: 'sidecars can retain every owner and system page; removing them for one owner can corrupt the database or leak data',
  }),
  externalEntry({
    id: 'logical:renderer-ozon-shop-settings-shop-slices', storageKind: 'memory', scopeType: 'profile', ownerType: 'ozon_shop',
    resource: 'frontend ozonShopSettingsMemory shops/defaultWarehouseIds exact shop slice', ownerField: 'resolver:ozon-shop-settings-shop-slice',
    deletePrimitive: 'future:accountRemoval.ozonShopSettingsOwnerSlicePrimitive',
    verifyQuery: { type: 'memory-owner-absence', ownerField: 'resolver:ozon-shop-settings-shop-slice', expected: 'absent' },
    sourceEvidence: sourceEvidence('frontend/src/services/ozonShopSettingsStore.js', 'export let ozonShopSettingsMemory = null;', 'future resolver must bind exact shops[].id and keyed preference records'),
    preserveRule: 'only an exact shop slice may be changed; preserve defaults, global fields, and all other shops',
    risk: 'aggregate settings memory has a shared write queue and must be fenced before future scoped work',
  }),
  externalEntry({
    id: 'memory:renderer-model-api-settings', storageKind: 'memory', scopeType: 'profile', ownerType: 'model_api_account',
    resource: 'frontend modelApiSettingsMemory interface records', ownerField: 'resolver:model-api-interface-id',
    deletePrimitive: 'future:accountRemoval.modelApiSettingsOwnerInvalidate',
    verifyQuery: { type: 'memory-owner-absence', ownerField: 'resolver:model-api-interface-id', expected: 'absent' },
    sourceEvidence: sourceEvidence('frontend/src/features/settings/lib/modelApiSettings.jsx', 'let modelApiSettingsMemory = null;', 'future resolver must use exact interface id, not active/default selection'),
    preserveRule: 'invalidate only an exact interface id and preserve active/default state for other interfaces',
    risk: 'model API memory can contain multiple interfaces and must not be selected through an active-id fallback',
  }),
  externalEntry({
    id: 'memory:renderer-purchase-plugin-account-context', storageKind: 'memory', scopeType: 'profile', ownerType: 'purchase_account',
    resource: 'frontend purchasePluginSourceContextMemory exact purchase account context', ownerField: 'memory-property:purchasePluginSourceContextMemory.purchaseAccountId',
    deletePrimitive: 'future:accountRemovalClient.purchasePluginAccountContextPurge',
    verifyQuery: { type: 'memory-owner-absence', ownerField: 'purchasePluginSourceContextMemory.purchaseAccountId', expected: 'absent' },
    sourceEvidence: sourceEvidence('frontend/src/services/purchasePluginContextStore.js', 'purchaseAccountId: 128,', 'renderer context carries the exact native purchase browser account id'),
    preserveRule: 'remove only renderer context whose purchaseAccountId exactly equals ownerId; preserve contexts owned by other purchase accounts',
    risk: 'the shared context write queue must be fenced before clearing an account-owned context',
  }),
  externalEntry({
    id: 'logical:renderer-purchase-order-overrides-shop-records', storageKind: 'memory', scopeType: 'profile', ownerType: 'ozon_shop',
    resource: 'frontend purchaseOrderLocalOverridesMemory canonical exact shop records', ownerField: 'resolver:purchase-override-shop-record',
    deletePrimitive: 'future:accountRemoval.purchaseOverrideOwnerSlicePrimitive',
    verifyQuery: { type: 'memory-owner-absence', ownerField: 'resolver:purchase-override-shop-record', expected: 'absent' },
    sourceEvidence: sourceEvidence('frontend/src/services/purchaseOrderRuntime.js', 'export let purchaseOrderLocalOverridesMemory = null;', 'future resolver must inspect canonical row shopId rather than legacy order key'),
    preserveRule: 'only records with an exact canonical shopId may be touched; preserve legacy/unscoped records and other shops',
    risk: 'unscoped legacy order keys must not be used as a deletion selector',
  }),
  externalEntry({
    id: 'logical:renderer-cross-border-settings-account-slice', storageKind: 'memory', scopeType: 'profile', ownerType: 'cross_border_bus',
    resource: 'frontend crossBorderSettingsMemory exact account settings slice', ownerField: 'resolver:cross-border-settings-account-slice',
    deletePrimitive: 'future:accountRemoval.crossBorderSettingsAccountSlicePrimitive',
    verifyQuery: { type: 'memory-owner-absence', ownerField: 'resolver:cross-border-settings-account-slice', expected: 'absent' },
      sourceEvidence: sourceEvidence('frontend/src/shared/ozon/crossBorderAuthorization.js', 'export function getCrossBorderLocalApiAccountId(settings = {}) {', 'crossBorderAccountId/accountId'),
    preserveRule: 'only a canonical cross-border account slice may be touched; preserve defaults and other account settings',
    risk: 'default account fallback is not an ownership proof and can cause cross-account removal',
  }),
  externalEntry({
    id: 'memory:local-api-products-hot-cache', storageKind: 'memory', ownerType: 'unknown',
    resource: 'frozen audit alias for the local-api canonical productHotCache', ownerField: 'the active cache is registered separately as memory:local-api-hot-cache-l1 and carries typed shop tags',
    sourceEvidence: sourceEvidence('local-api/src/domain/products/productCanonicalReadService.js', 'productHotCache.set(cacheKey, { ...payload, source: "memory" }, {', 'canonical product L1 entries carry every shop owner tag and expose exact owner count/invalidation'),
    preserveRule: 'never plan this frozen duplicate alias; the registered memory:local-api-hot-cache-l1 resource performs exact owner invalidation',
    risk: 'planning both the frozen alias and the canonical tagged resource would double-count one physical L1 cache',
  }),
  externalEntry({
    id: 'runtime:local-api-ozon-client-endpoint-limiter', storageKind: 'runtime', ownerType: 'system',
    resource: 'local-api ozonClient createEndpointLimiter Client-Id/bucket state', ownerField: 'credential Client-Id',
    sourceEvidence: sourceEvidence('local-api/src/ozon/ozonClient.js', 'const key = `${clientId}::${bucket}`;', 'credential-scoped endpoint limiter'),
    preserveRule: 'the short-lived credential limiter is never shared between different Client-Ids',
    risk: 'duplicate local bindings of the same Client-Id intentionally share the upstream credential quota',
  }),
  externalEntry({
    id: 'logical:local-api-rate-limit-shop-state', storageKind: 'runtime', scopeType: 'shop', ownerType: 'ozon_shop',
    resource: 'local-api rateLimitState exact parsed shop state slice', ownerField: 'resolver:rate-limit-shop-state',
    deletePrimitive: 'future:accountRemoval.rateLimitShopStateQuiesce',
    verifyQuery: { type: 'runtime-owner-count', path: 'resolver:rate-limit-shop-state', expected: 'zero' },
    sourceEvidence: sourceEvidence('local-api/src/ozon/rateLimitState.js', 'function createRateLimitState', 'state keys reject missing shop IDs'),
    preserveRule: 'clear only the exact shop prefix and preserve nonmatching shops',
    risk: 'missing or ambiguous shop scope fails closed',
  }),
  externalEntry({
    id: 'logical:local-api-traffic-controller-shop-state', storageKind: 'runtime', scopeType: 'shop', ownerType: 'ozon_shop',
    resource: 'local-api trafficController exact parsed shop state slice', ownerField: 'resolver:traffic-controller-shop-state',
    deletePrimitive: 'future:accountRemoval.trafficControllerShopStateQuiesce',
    verifyQuery: { type: 'runtime-owner-count', path: 'resolver:traffic-controller-shop-state', expected: 'zero' },
    sourceEvidence: sourceEvidence('local-api/src/ozon/trafficController.js', 'export function createTrafficController(options = {})', 'all dynamic and fixed scopes are shop-prefixed'),
    preserveRule: 'clear only the exact shop prefix and preserve nonmatching shops',
    risk: 'missing shop/client scope fails closed before a permit is reserved',
  }),
  externalEntry({
    id: 'memory:external-chrome-content-snapshots', storageKind: 'browser-extension', ownerType: 'system',
    resource: 'retired external-snapshot alias for the built-in extension call-local inspection result', ownerField: 'constant:global',
    sourceEvidence: sourceEvidence('frontend/src/audit/retiredBrowserStorageAudit.js', "contentSnapshotResource: 'memory:external-chrome-content-snapshots'", 'the old content snapshot runtime is retired and stores no account data'),
    preserveRule: 'there is no shared snapshot store to remove; exact partition artifacts are handled by browser:purchase-* resources',
    risk: 'future edits must not reintroduce shared extension snapshot state or chrome.storage fallback',
  }),
  externalEntry({
    id: 'runtime:external-chrome-content-pollers', storageKind: 'browser-extension', ownerType: 'system',
    resource: 'retired external-poller alias for one call-local fixture receipt timer', ownerField: 'constant:global',
    sourceEvidence: sourceEvidence('frontend/src/audit/retiredBrowserStorageAudit.js', "contentPollerResource: 'runtime:external-chrome-content-pollers'", 'the old content poller runtime is retired and cannot retain account work'),
    preserveRule: 'the controller destroys the owner webContents before partition purge, which terminates any call-local timer',
    risk: 'no background or shared cross-account polling loop may be introduced',
  }),
  externalEntry({
    id: 'memory:external-chrome-popup-snapshots', storageKind: 'browser-extension', ownerType: 'system',
    resource: 'retired popup-snapshot alias for a stateless version label', ownerField: 'constant:global',
    sourceEvidence: sourceEvidence('frontend/src/audit/retiredBrowserStorageAudit.js', "popupSnapshotResource: 'memory:external-chrome-popup-snapshots'", 'the old popup runtime is retired and stores no account state'),
    preserveRule: 'the popup is stateless shared extension code; partition extension storage is removed separately',
    risk: 'future popup changes must not persist task or account context outside the owner partition contract',
  }),
  externalEntry({
    id: 'logical:local-data-ozon-shop-settings-shop-slices', storageKind: 'filesystem',
    resource: 'desktop local-data/分类缓存/01-店铺设置/ozon-shop-settings.json', scopeType: 'shop', ownerType: 'ozon_shop',
    ownerField: 'json-path:shops[].id', directory: '分类缓存/01-店铺设置', fileName: 'ozon-shop-settings.json', relativePath: '分类缓存/01-店铺设置/ozon-shop-settings.json',
    deletePrimitive: 'future:accountRemoval.localDataExactShopRecordPrimitive',
    verifyQuery: { type: 'json-file-owner-reference-absence', directory: '分类缓存/01-店铺设置', fileName: 'ozon-shop-settings.json', relativePath: '分类缓存/01-店铺设置/ozon-shop-settings.json', ownerField: 'shops[].id', paths: ['shops[].id', 'defaultWarehouseIds[ownerId]', 'activeShopId'], expected: 'absent' },
    sourceEvidence: sourceEvidence('frontend/src/services/ozonShopSettingsStore.js', 'normalizeOzonShopSettingsStore', 'shops[].id/defaultWarehouseIds[shopId]/activeShopId'),
    preserveRule: 'remove only an exact verified shop settings slice and preserve defaults, global fields, and every other shop',
    risk: 'aggregate settings may retain mixed or unscoped fields and must fail closed outside an exact shop slice',
  }),
  ...[
    ['logical:local-data-product-material-profiles-shop-records', '商品资料', 'product-material-profiles.json', 'frontend/src/services/productMaterialProfileStore.js', 'export function saveProductMaterialProfiles(profiles) {', 'root is {[recordKey]: profile}; no profiles[] selector; record-map selector unsupported'],
    ['logical:local-data-purchase-order-overrides-shop-records', '商品资料', 'purchase-order-local-overrides.json', 'frontend/src/services/purchaseOrderRuntime.js', 'export function savePurchaseOrderOverridesToLocalApi(overrides = {}) {', 'root is {[orderKey]: override}; no overrides[] selector; record-map selector unsupported'],
    ['logical:local-data-product-source-links-shop-records', '商品资料', 'product-source-links.json', 'frontend/src/services/productSourceLinkStore.js', 'export async function saveProductSourceLinkRecord({ key, record, product = {}, timeoutMs = 3000 } = {}) {', 'owner exists in key ${shopId}:${productKey}; value has no shopId; key selector unsupported'],
    ['logical:local-data-sales-source-links-shop-records', '分类缓存/05-销售订单', 'sales-source-links.json', 'frontend/src/services/salesSourceLinkStore.js', 'function mapSalesSourceRows(rows = []) {', 'owner exists in key ${shopId}:${orderKey}; value has no shopId; key selector unsupported'],
    ['logical:local-data-purchase-source-links-shop-records', '分类缓存/07-拍单采购', 'purchase-source-links.json', 'frontend/src/services/purchaseSourceLinkStore.js', 'function mapPurchaseSourceRows(rows = []) {', 'owner exists in key ${shopId}:${orderKey}; value has no shopId; key selector unsupported'],
  ].map(([id, directory, fileName, sourceFile, sourceSymbol, ownerBasis]) => externalEntry({
    id, storageKind: 'filesystem', resource: `desktop local-data/${directory}/${fileName}`, ownerType: 'unknown',
    ownerField: 'record-map key/value ownership selector is unsupported', directory, fileName, relativePath: `${directory}/${fileName}`,
    sourceEvidence: sourceEvidence(sourceFile, sourceSymbol, ownerBasis),
    preserveRule: 'record-map payload has no supported exact owner selector; preserve every entry until a future typed key/value ownership contract exists',
    risk: 'array selectors must never be applied to record-map payloads; inferred key ownership can cross shops or retain residual data',
  })),
  externalEntry({
    id: 'filesystem:desktop-local-data-root', storageKind: 'filesystem', ownerType: 'unknown',
    resource: 'desktop dataRoot/本地数据/', ownerField: 'directory contains legacy and unknown files outside authoritative per-record contracts',
    sourceEvidence: sourceEvidence('desktop/src/runtime/dataLayout.js', 'localDataRoot: path.join(root, "本地数据")', 'root directory itself is not an owner boundary'),
    preserveRule: 'preserve the root; future owner work must use an exact catalog child and never delete by directory traversal',
    risk: 'path-level deletion could erase unregistered or mixed account data',
  }),
  externalEntry({
    id: 'filesystem:desktop-runtime-directory', storageKind: 'filesystem', ownerType: 'unknown',
    resource: 'desktop dataRoot/runtime/', ownerField: 'runtime directory includes unknown shared handles and state',
    sourceEvidence: sourceEvidence('desktop/src/runtime/dataLayout.js', 'runtimeDirectory: path.join(root, "runtime")', 'runtime directory is shared and not owner partitioned'),
    preserveRule: 'preserve runtime directory; only a future named resource with exact ownership may be handled',
    risk: 'directory removal can disrupt the running application and erase mixed runtime state',
  }),
  externalEntry({
    id: 'filesystem:legacy-local-api-secret-key', storageKind: 'filesystem', ownerType: 'system',
    resource: 'desktop legacy local-api data/local-api-secret.key', ownerField: 'legacy profile encryption key protects shared data',
    sourceEvidence: sourceEvidence('desktop/src/runtime/dataLayout.js', 'legacySecretPath: resolvedLocalApiRoot', 'legacy key is installation/profile system scope'),
    backupRule: 'required',
    preserveRule: 'always preserve the legacy profile key during business account removal',
    risk: 'removing the key can make other owners unreadable and is never an account-scoped action',
  }),
  externalEntry({
    id: 'runtime:desktop-profile-lock-handle', storageKind: 'runtime', ownerType: 'system',
    resource: 'desktop profileLock active handle', ownerField: 'one lock protects the whole desktop profile',
    deletePrimitive: 'future:accountRemoval.profileLockCoordinationFence',
    verifyQuery: { type: 'runtime-owner-state', path: 'profileLockHandle', expected: 'stopped-or-owner-write-fenced' },
    sourceEvidence: sourceEvidence('desktop/src/main.js', 'profileLock', 'profile-global active handle'),
    preserveRule: 'coordinate with but never remove the profile lock for one business account',
    risk: 'releasing a global lock can corrupt concurrent profile writes and allow runtime rehydration',
  }),
  externalEntry({
    id: 'runtime:renderer-local-api-request-listeners', storageKind: 'runtime', ownerType: 'system',
    resource: 'frontend localApiClient localApiRequestListeners Set', ownerField: 'renderer-global request listener set',
    deletePrimitive: 'future:accountRemoval.localApiRequestRuntimeFence',
    verifyQuery: { type: 'runtime-owner-state', path: 'localApiRequestListeners', expected: 'stopped-or-owner-write-fenced' },
    sourceEvidence: sourceEvidence('frontend/src/api/localApiClient.js', 'const localApiRequestListeners = new Set();', 'listeners observe all local-api request state'),
    preserveRule: 'preserve listeners and fence notification delivery around future owner work',
    risk: 'listener callbacks can publish stale request state while a future account operation is in progress',
  }),
  externalEntry({
    id: 'memory:renderer-local-api-request-stats', storageKind: 'memory', ownerType: 'unknown',
    resource: 'frontend localApiClient localApiRequestStats aggregate', ownerField: 'request stats aggregate includes paths/jobs without authoritative owner metadata',
    sourceEvidence: sourceEvidence('frontend/src/api/localApiClient.js', 'const localApiRequestStats = {', 'aggregate request statistics are not a one-owner resource'),
    preserveRule: 'preserve aggregate stats; future owner reporting must use explicit scoped observations',
    risk: 'clearing aggregate stats by a guessed owner can hide unrelated active work or errors',
  }),
  externalEntry({
    id: 'runtime:renderer-workspace-performance', storageKind: 'runtime', ownerType: 'system',
    resource: 'frontend workspacePerformanceRuntime navigation/listener state', ownerField: 'renderer workspace performance metrics are global UI runtime state',
    deletePrimitive: 'future:accountRemoval.workspacePerformanceFence',
    verifyQuery: { type: 'runtime-owner-state', path: 'workspacePerformanceRuntime', expected: 'stopped-or-owner-write-fenced' },
    sourceEvidence: sourceEvidence('frontend/src/app/performance/workspacePerformanceRuntime.js', 'export const workspacePerformanceRuntime = createWorkspacePerformanceRuntime();', 'workspace performance runtime is global UI telemetry'),
    preserveRule: 'preserve UI performance metrics; only fence event publication around future work',
    risk: 'global observers/listeners can outlive an owner request and publish stale state',
  }),
  externalEntry({
    id: 'runtime:renderer-sales-orders-page-load', storageKind: 'runtime', ownerType: 'system',
    resource: 'frontend App salesOrdersPageLoadPromise lazy page load', ownerField: 'renderer page module load promise has no owner scope',
    deletePrimitive: 'future:accountRemoval.rendererPageLoadFence',
    verifyQuery: { type: 'runtime-owner-state', path: 'salesOrdersPageLoadPromise', expected: 'stopped-or-owner-write-fenced' },
    sourceEvidence: sourceEvidence('frontend/src/App.jsx', 'let salesOrdersPageLoadPromise = null;', 'lazy page load is global renderer runtime'),
    preserveRule: 'preserve shared page load promise and coordinate only its lifecycle',
    risk: 'interrupting a shared page load can break unrelated UI navigation',
  }),
  externalEntry({
    id: 'runtime:renderer-profit-refresh-progress', storageKind: 'runtime', ownerType: 'unknown',
    resource: 'frontend profitRefreshProgressRuntime snapshot/listeners', ownerField: 'progress snapshot can aggregate multiple shop refreshes',
    sourceEvidence: sourceEvidence('frontend/src/features/profit/model/profitRefreshProgressRuntime.js', 'let profitRefreshProgressSnapshot = {', 'progress runtime has no authoritative single owner selector'),
    preserveRule: 'preserve mixed progress state; future refresh cancellation must expose an exact owner fence',
    risk: 'refresh progress can publish or revive stale owner state after a future account action',
  }),
  externalEntry({
    id: 'memory:renderer-prompt-library-store', storageKind: 'memory', ownerType: 'system',
    resource: 'frontend promptLibraryStoreMemory', ownerField: 'prompt library is global tool configuration',
    sourceEvidence: sourceEvidence('frontend/src/features/promptLibrary/lib/promptLibraryStore.jsx', 'export let promptLibraryStoreMemory = null;', 'tool library is system/global configuration'),
    preserveRule: 'always preserve prompt library configuration for business account removal',
    risk: 'tool library is not business account data and must never be selected by owner inference',
  }),
  externalEntry({
    id: 'runtime:renderer-prompt-library-write-queue', storageKind: 'runtime', ownerType: 'system',
    resource: 'frontend promptLibraryWriteQueue', ownerField: 'global prompt library write queue',
    deletePrimitive: 'future:accountRemoval.promptLibraryWriteFence',
    verifyQuery: { type: 'runtime-owner-state', path: 'promptLibraryWriteQueue', expected: 'stopped-or-owner-write-fenced' },
    sourceEvidence: sourceEvidence('frontend/src/features/promptLibrary/lib/promptLibraryStore.jsx', 'let promptLibraryWriteQueue = Promise.resolve();', 'tool configuration queue is global'),
    preserveRule: 'preserve global tool configuration and fence its queue only for coordination',
    risk: 'queue completion can re-save global configuration after a future owner operation',
  }),
  externalEntry({
    id: 'memory:renderer-watermark-settings', storageKind: 'memory', ownerType: 'system',
    resource: 'frontend productEditing watermarkSettingsMemory', ownerField: 'watermark templates/settings are global profile configuration',
    sourceEvidence: sourceEvidence('frontend/src/features/products/lib/productEditing.jsx', 'export let watermarkSettingsMemory = null;', 'watermark store is global profile configuration'),
    preserveRule: 'always preserve watermark settings during business account removal',
    risk: 'global watermark templates are not a business account resource',
  }),
  externalEntry({
    id: 'runtime:renderer-watermark-settings-write-queue', storageKind: 'runtime', ownerType: 'system',
    resource: 'frontend productEditing watermarkSettingsWriteQueue', ownerField: 'global watermark settings write queue',
    deletePrimitive: 'future:accountRemoval.watermarkSettingsWriteFence',
    verifyQuery: { type: 'runtime-owner-state', path: 'watermarkSettingsWriteQueue', expected: 'stopped-or-owner-write-fenced' },
    sourceEvidence: sourceEvidence('frontend/src/features/products/lib/productEditing.jsx', 'let watermarkSettingsWriteQueue = Promise.resolve();', 'watermark write queue is global'),
    preserveRule: 'preserve watermark state and fence its shared queue only for coordination',
    risk: 'queued watermark persistence can backwrite global profile settings',
  }),
  externalEntry({
    id: 'runtime:renderer-watermark-settings-load-task', storageKind: 'runtime', ownerType: 'system',
    resource: 'frontend productEditing watermarkSettingsLoadPromise', ownerField: 'global watermark settings load task',
    deletePrimitive: 'future:accountRemoval.watermarkSettingsWriteFence',
    verifyQuery: { type: 'runtime-owner-state', path: 'watermarkSettingsLoadPromise', expected: 'stopped-or-owner-write-fenced' },
    sourceEvidence: sourceEvidence('frontend/src/features/products/lib/productEditing.jsx', 'let watermarkSettingsLoadPromise = null;', 'watermark load task is global'),
    preserveRule: 'preserve watermark settings and await/fence load task only for coordination',
    risk: 'late load completion can re-publish global settings after a future operation',
  }),
  externalEntry({
    id: 'memory:renderer-fee-plan-state', storageKind: 'memory', ownerType: 'system',
    resource: 'frontend feeSettingsRuntime saved fee plan state', ownerField: 'fee plan configuration is global profile state',
    sourceEvidence: sourceEvidence('frontend/src/services/feeSettingsRuntime.js', 'let feePlanStateMemory = null;', 'fee settings state is global configuration'),
    preserveRule: 'always preserve fee plans during business account removal',
    risk: 'fees are global settings and must not be selected by shop/account inference',
  }),
  externalEntry({
    id: 'runtime:renderer-fee-settings-write-queue', storageKind: 'runtime', ownerType: 'system',
    resource: 'frontend feeSettingsRuntime feeSettingsWriteQueue', ownerField: 'global fee settings write queue',
    deletePrimitive: 'future:accountRemoval.feeSettingsWriteFence',
    verifyQuery: { type: 'runtime-owner-state', path: 'feeSettingsWriteQueue', expected: 'stopped-or-owner-write-fenced' },
    sourceEvidence: sourceEvidence('frontend/src/services/feeSettingsRuntime.js', 'let feeSettingsWriteQueue = Promise.resolve();', 'fee settings queue is global'),
    preserveRule: 'preserve fee configuration and fence shared queue only for coordination',
    risk: 'queued fee writes can re-persist global configuration after a future owner operation',
  }),
  externalEntry({
    id: 'memory:renderer-product-material-profile-hashes', storageKind: 'memory', ownerType: 'unknown',
    resource: 'frontend productMaterialProfileStore productMaterialProfileLocalApiHashes', ownerField: 'hash key can be a legacy product key without a typed shop selector',
    sourceEvidence: sourceEvidence('frontend/src/services/productMaterialProfileStore.js', 'productMaterialProfileLocalApiHashes', 'key 可为 legacy product key'),
    preserveRule: 'preserve all hash entries until a future typed profile-key ownership contract proves one exact owner',
    risk: 'hash dedupe state can suppress a later correct save or revive stale data if cleared by inferred owner',
  }),
  externalEntry({
    id: 'runtime:renderer-legacy-browser-read-telemetry', storageKind: 'runtime', ownerType: 'system',
    resource: 'retired legacy browser-read telemetry audit marker', ownerField: 'constant:global',
    sourceEvidence: sourceEvidence('frontend/src/audit/retiredBrowserStorageAudit.js', "telemetryResource: 'runtime:renderer-legacy-browser-read-telemetry-retired'", 'the telemetry runtime has been removed and stores no owner state'),
    preserveRule: 'preserve only the static audit marker; there is no telemetry queue to clear',
    risk: 'future changes must not recreate browser localStorage read telemetry',
  }),
  externalEntry({
    id: 'runtime:renderer-browser-local-storage-mirror', storageKind: 'runtime', ownerType: 'unknown',
    resource: 'retired browser local-storage mirror audit marker', ownerField: 'constant:global',
    sourceEvidence: sourceEvidence('frontend/src/audit/retiredBrowserStorageAudit.js', "mirrorResource: 'memory:renderer-browser-local-storage-mirror-retired'", 'the mirror runtime has been removed and stores no owner state'),
    preserveRule: 'preserve only the static audit marker; there is no runtime mirror state to clear',
    risk: 'future changes must not recreate browser localStorage business persistence',
  }),
  externalEntry({
    id: 'memory:renderer-product-fee-exchange-rate', storageKind: 'memory', ownerType: 'system',
    resource: 'frontend product fee exchange-rate runtime value', ownerField: 'exchange rate is global financial reference data',
    sourceEvidence: sourceEvidence('frontend/src/services/productRowRuntime.js', 'let productFeeRubToCnyRateMemory = null;', 'product fee rate is shared reference state'),
    preserveRule: 'always preserve global exchange-rate reference state',
    risk: 'exchange rate is not an account resource and clearing it could affect other shops',
  }),
  externalEntry({
    id: 'memory:renderer-license-browser-tokens', storageKind: 'memory', ownerType: 'system',
    resource: 'frontend license/browser capability tokens', ownerField: 'license user/session',
    sourceEvidence: sourceEvidence('frontend/src/features/licensing/services/licenseCenterClient.js', 'browserTokens', 'license user/session'),
    preserveRule: 'always preserve installation capability state during business account removal',
    risk: 'clearing a global token can disable unrelated runtime services',
  }),
  externalEntry({
    id: 'runtime:renderer-legacy-browser-read-listeners', storageKind: 'runtime', ownerType: 'system',
    resource: 'retired legacy browser-read listener audit marker', ownerField: 'constant:global',
    sourceEvidence: sourceEvidence('frontend/src/audit/retiredBrowserStorageAudit.js', "readListenerResource: 'runtime:renderer-legacy-browser-read-listeners-retired'", 'the listener runtime has been removed and stores no owner state'),
    preserveRule: 'preserve only the static audit marker; there are no listeners to clear',
    risk: 'future changes must not recreate browser localStorage read listeners',
  }),
  externalEntry({
    id: 'runtime:desktop-license-runtime-promises', storageKind: 'runtime', ownerType: 'system',
    resource: 'desktop LicenseSessionStore runtime promise set', ownerField: 'license promises are global installation coordination state',
    deletePrimitive: 'future:accountRemoval.licenseSessionRuntimeFence',
    verifyQuery: { type: 'runtime-owner-state', path: 'LicenseSessionStore', expected: 'stopped-or-owner-write-fenced' },
    sourceEvidence: sourceEvidence('desktop/src/licensing/licenseRuntime.js', 'let deviceCodePromise;', '安装/license 级'),
    preserveRule: 'preserve license runtime and fence shared promises only for coordination',
    risk: 'late global license promise completion can alter runtime state after a future account operation',
  }),
  externalEntry({
    id: 'filesystem:legacy-classification-cache-root',
    storageKind: 'filesystem',
    resource: 'desktop-local-data/分类缓存/** + 商品资料/**',
    ownerType: 'unknown',
    ownerField: 'embedded-legacy-record-scope',
    risk: 'legacy JSON/classification cache can contain mixed or missing owner fields; fail closed until a verified migration map exists',
  }),
  ...LOCAL_DATA_FILE_OWNERSHIP_ADAPTERS,
  externalEntry({
    id: 'filesystem:retired-purchase-plugin-context',
    storageKind: 'filesystem',
    resource: 'desktop local-data/分类缓存/07-拍单采购/purchase-source-plugin-context.json',
    ownerType: 'unknown',
    ownerField: 'retired-file-owner-unavailable',
    risk: 'retired migration-only file has no authoritative purchase-account owner mapping',
  }),
  externalEntry({
    id: 'filesystem:retired-marketing-activity-cache',
    storageKind: 'filesystem',
    resource: 'desktop local-data/分类缓存/12-营销活动/marketing-activity-cache.json',
    ownerType: 'unknown',
    ownerField: 'retired-file-owner-unavailable',
    risk: 'retired migration-only cache can span shops; no removal is permitted without an explicit verified scope map',
  }),
  externalEntry({
    id: 'filesystem:local-api-secret-key',
    storageKind: 'filesystem',
    resource: 'desktop dataRoot/local-api-data/local-api-secret.key',
    ownerType: 'system',
    ownerField: 'constant:profile-secret-key',
    backupRule: 'required',
    executionGroup: 'desktop-local-api-data-root',
    sourceEvidence: sourceEvidence('desktop/src/runtime/dataLayout.js', 'secretPath: path.join(localApiDataRoot, "local-api-secret.key"),', 'profile 全局 key'),
    risk: 'profile key material protects multiple account domains and is never selected by a business-account removal',
  }),
  externalEntry({
    id: 'filesystem:protected-compute-version-state',
    storageKind: 'filesystem',
    resource: 'desktop dataRoot/local-api-data/protected-compute-version-state.enc',
    ownerType: 'system',
    ownerField: 'constant:profile-protected-compute-trust-state',
    backupRule: 'required',
    executionGroup: 'desktop-local-api-data-root',
    sourceEvidence: sourceEvidence(
      'desktop/src/runtime/dataLayout.js',
      'protectedComputeVersionStatePath: path.join(',
      'profile global authenticated protected-compute trust high-water mark',
    ),
    preserveRule: 'preserve across ordinary cache clear and every business-account removal; remove only with a full profile reset or uninstall',
    risk: 'deleting or rolling back this state can re-enable acceptance of an older signed-public revocation policy',
  }),
  externalEntry({
    id: 'filesystem:software-category-tree-static',
    storageKind: 'filesystem',
    resource: 'local-api/assets/ozonCategoryTree.zh.json packaged seed',
    ownerType: 'system',
    ownerField: 'constant:packaged-static-asset',
    backupRule: 'excluded',
    risk: 'software category tree is a packaged static asset, not account data or a mutable business cache',
  }),
  externalEntry({
    id: 'memory:local-api-hot-cache-l1',
    storageKind: 'memory',
    resource: 'local-api/cache/hotCacheService',
    ownerType: 'ozon_shop',
    ownerField: 'memory-tag:shop:${ownerId}',
    deletePrimitive: 'future:accountRemoval.hotCacheOwnerInvalidation',
    verifyQuery: { type: 'memory-owner-absence', tag: 'shop:${ownerId}', expected: 'absent' },
    risk: 'L1 cache is process-local and volatile; future removal must invalidate only the exact shop:${ownerId} tag and preserve global or other-shop entries',
  }),
  externalEntry({
    id: 'memory:local-api-hot-cache-shop-tag',
    storageKind: 'memory',
    resource: 'local-api/cache/hotCacheService tag index',
    ownerType: 'ozon_shop',
    ownerField: 'memory-tag:shop:${ownerId}',
    deletePrimitive: 'future:accountRemoval.hotCacheOwnerInvalidation',
    verifyQuery: { type: 'memory-tag-absence', tag: 'shop:${ownerId}', expected: 'absent' },
    sourceEvidence: sourceEvidence('local-api/src/cache/cacheReadService.js', 'tags: [', 'shop:${ownerId}'),
    risk: 'cache tags are the authoritative in-memory shop boundary; a domain tag alone is never sufficient to invalidate one shop',
  }),
  externalEntry({
    id: 'memory:renderer-local-data-read-cache-l0',
    storageKind: 'memory',
    resource: 'frontend/localDataFileReadCache',
    ownerType: 'unknown',
    ownerField: 'legacy-cache-key-owner-unavailable',
    risk: 'renderer compatibility cache key cannot prove one business owner; fail closed',
  }),
  externalEntry({
    id: 'memory:catalog-cache-active-jobs',
    storageKind: 'runtime',
    resource: 'local-api/cache/catalog/catalogCacheService active jobs',
    ownerType: 'ozon_shop',
    ownerField: 'runtime-property:job.shopId',
    deletePrimitive: 'future:accountRemoval.catalogCacheOwnerQuiesce',
    verifyQuery: { type: 'runtime-owner-count', path: 'job.shopId', expected: 'zero' },
    risk: 'catalog cache work may be in flight; future removal must quiesce only the exact shop job before any persistent action',
  }),
  externalEntry({
    id: 'memory:performance-access-token-cache',
    storageKind: 'memory',
    resource: 'local-api/integrations/performanceApiClient access-token cache',
    scopeType: 'external',
    ownerType: 'promotion_account',
    ownerField: 'resolver:performance-account-runtime',
    deletePrimitive: 'future:accountRemovalRuntimeCoordinator.clear.performanceApiRuntime',
    verifyQuery: { type: 'memory-owner-absence', ownerField: 'resolver:performance-account-runtime', expected: 'absent' },
    risk: 'performanceTokenKeysByOwner must clear only tokens indexed by the exact account id',
  }),
  externalEntry({
    id: 'memory:performance-inflight-request-cache',
    storageKind: 'memory',
    resource: 'local-api/integrations/performanceApiClient in-flight requests',
    scopeType: 'external',
    ownerType: 'promotion_account',
    ownerField: 'resolver:performance-account-runtime',
    deletePrimitive: 'future:accountRemovalRuntimeCoordinator.clear.performanceApiRuntime',
    verifyQuery: { type: 'memory-owner-absence', ownerField: 'resolver:performance-account-runtime', expected: 'absent' },
    risk: 'coalesced in-flight reads must be drained and removed only for the exact performance account id',
  }),
  externalEntry({
    id: 'memory:customer-message-translation-cache',
    storageKind: 'memory',
    resource: 'local-api/domain/customerService translation cache',
    ownerType: 'unknown',
    ownerField: 'text-derived cache key has no account owner',
    risk: 'translation cache is keyed by text rather than account scope; fail closed instead of inferring an owner',
  }),
  externalEntry({
    id: 'memory:renderer-smart-tool-ozon-product-detail-cache',
    storageKind: 'memory',
    resource: 'frontend smartToolExternalOzonDataService externalOzonProductDetailCache',
    ownerType: 'unknown',
    ownerField: 'cache key combines tool inputs and does not expose one canonical account-removal owner',
    sourceEvidence: sourceEvidence('frontend/src/features/promptLibrary/services/smartToolExternalOzonDataService.js', 'const externalOzonProductDetailCache = new Map();', 'smart-tool product detail cache is renderer-local and may span shops'),
    risk: 'preserve the mixed smart-tool cache instead of inferring ownership from a request key',
  }),
  externalEntry({
    id: 'memory:renderer-smart-tool-seerfar-category-option-cache',
    storageKind: 'memory',
    resource: 'frontend smartToolSeerfarCategoryService categoryOptionCache',
    ownerType: 'system',
    ownerField: 'category options are shared tool metadata without a business-account owner',
    sourceEvidence: sourceEvidence('frontend/src/features/promptLibrary/services/smartToolSeerfarCategoryService.js', 'const categoryOptionCache = new Map();', 'Seerfar category option requests are shared tool metadata'),
    risk: 'category metadata is profile-global and must survive business-account removal',
  }),
  externalEntry({
    id: 'memory:renderer-collection-listing-category-template-cache',
    storageKind: 'memory',
    scopeType: 'shop',
    resource: 'frontend collectionListingCatalogService categoryTemplateCache',
    ownerType: 'ozon_shop',
    ownerField: 'resolver:collection-listing-category-template-shop-slice',
    deletePrimitive: 'future:accountRemoval.collectionListingCategoryTemplateCacheInvalidate',
    verifyQuery: { type: 'memory-owner-absence', ownerField: 'resolver:collection-listing-category-template-shop-slice', expected: 'absent' },
    sourceEvidence: sourceEvidence('frontend/src/features/collectionPricing/services/collectionListingCatalogService.js', 'const categoryTemplateCache = new Map();', 'category template keys begin with the exact Ozon shop id followed by category and type ids'),
    preserveRule: 'invalidate only entries whose first cache-key segment equals the removed shop id; preserve every other shop template',
    risk: 'a removed shop template must not be reused after account recreation or exposed through another shop selection',
  }),
  externalEntry({
    id: 'runtime:renderer-logistics-pricing-settings-write-queue',
    storageKind: 'runtime',
    resource: 'frontend logisticsPricingSettingsRuntime logisticsPricingSettingsWriteQueue',
    ownerType: 'system',
    ownerField: 'one profile-global queue serializes logistics pricing settings writes',
    sourceEvidence: sourceEvidence('frontend/src/services/logisticsPricingSettingsRuntime.js', 'let logisticsPricingSettingsWriteQueue = Promise.resolve();', 'logistics pricing settings are global presets rather than shop-owned data'),
    risk: 'preserve global logistics pricing presets and their serialized write pipeline',
  }),
  externalEntry({
    id: 'memory:renderer-follow-seller-capture-cache',
    storageKind: 'memory',
    resource: 'frontend followSellerCaptureService followSellerMemoryCache',
    ownerType: 'unknown',
    ownerField: 'market-capture cache keys are research inputs and not canonical bound-shop ids',
    sourceEvidence: sourceEvidence('frontend/src/services/ozonMarketCapture/followSellerCaptureService.js', 'const followSellerMemoryCache = new Map();', 'market follow-seller cache can contain unrelated seller observations'),
    risk: 'preserve mixed market-capture observations instead of assigning them to the active bound shop',
  }),
  externalEntry({
    id: 'runtime:renderer-market-collector-shared-coordinator',
    storageKind: 'runtime',
    resource: 'frontend marketCollectorCoordinator sharedCoordinator',
    ownerType: 'system',
    ownerField: 'one renderer-global coordinator serializes market collection tasks',
    sourceEvidence: sourceEvidence('frontend/src/services/ozonMarketCapture/marketCollectorCoordinator.js', 'const sharedCoordinator = createOzonMarketCollectorCoordinator();', 'market collection coordination is process-global runtime state'),
    risk: 'preserve the global coordinator; owner-scoped cancellation requires a separate explicit task contract',
  }),
  externalEntry({
    id: 'runtime:ozon-scheduler-active-queue',
    storageKind: 'runtime',
    resource: 'local-api/ozon/ozonScheduler active jobs',
    ownerType: 'ozon_shop',
    ownerField: 'runtime-property:job.shopId',
    deletePrimitive: 'future:accountRemoval.schedulerOwnerQuiesce',
    verifyQuery: { type: 'runtime-owner-count', path: 'job.shopId', expected: 'zero' },
    risk: 'must quiesce and wait for in-flight work before any future persistent action',
  }),
  externalEntry({
    id: 'runtime:ozon-request-queue',
    storageKind: 'runtime',
    resource: 'local-api/ozon/requestQueue',
    ownerType: 'ozon_shop',
    ownerField: 'runtime-property:item.shopId',
    deletePrimitive: 'future:accountRemoval.requestQueueOwnerCancel',
    verifyQuery: { type: 'runtime-owner-count', path: 'item.shopId', expected: 'zero' },
    risk: 'request queue may contain in-flight work; no asynchronous cancellation is implemented in Phase B',
  }),
  externalEntry({
    id: 'runtime:continuous-sync-owner-state',
    storageKind: 'runtime',
    resource: 'local-api/sync/continuousSyncService timer/lastQueuedAtByTask/taskStatuses/pausedShopIds',
    ownerType: 'ozon_shop',
    ownerField: 'runtime-property:shopId',
    deletePrimitive: 'future:accountRemoval.continuousSyncOwnerPause',
    verifyQuery: { type: 'runtime-owner-state', path: 'shopId', expected: 'paused-and-absent' },
    risk: 'future removal must pause only the selected shop and preserve other schedules',
  }),
  externalEntry({
    id: 'logical:purchase-browser-receipts-shop-links',
    storageKind: 'sqlite',
    resource: 'purchase_browser_receipts',
    scopeType: 'shop',
    ownerType: 'ozon_shop',
    ownerField: 'sqlite-column:shop_id',
    deletePrimitive: 'future:accountRemoval.sqliteOwnerPrimitive',
    verifyQuery: { type: 'sqlite-count', table: 'purchase_browser_receipts', ownerField: 'shop_id', ownerPredicate: 'shop_id = :ownerId', expected: 'zero' },
    preserveRule: 'delete only receipt rows carrying the exact shop_id while preserving the purchase account and every other shop receipt',
    backupRule: 'required',
    sourceEvidence: sourceEvidence('local-api/src/domain/purchaseBrowser/purchaseBrowserTaskService.js', 'row.shop_id || null,', 'receipt rows copy the exact optional shop_id from their canonical task'),
    risk: 'receipt rows must be deleted before their task rows so no shop-linked purchase evidence survives a shop removal',
  }),
  externalEntry({
    id: 'logical:purchase-browser-tasks-shop-links',
    storageKind: 'sqlite',
    resource: 'purchase_browser_tasks',
    scopeType: 'shop',
    ownerType: 'ozon_shop',
    ownerField: 'sqlite-column:shop_id',
    deletePrimitive: 'future:accountRemoval.sqliteOwnerPrimitive',
    verifyQuery: { type: 'sqlite-count', table: 'purchase_browser_tasks', ownerField: 'shop_id', ownerPredicate: 'shop_id = :ownerId', expected: 'zero' },
    preserveRule: 'delete only task rows carrying the exact shop_id while preserving the purchase account and every other shop task',
    backupRule: 'required',
    sourceEvidence: sourceEvidence('local-api/src/domain/purchaseBrowser/purchaseBrowserTaskService.js', "shopId: optionalText(input.shopId, 'PURCHASE_BROWSER_SHOP_ID_INVALID', 128),", 'task preview stores an exact optional Ozon shop id instead of inferring it from order keys'),
    risk: 'an empty shop_id is not attributable and must never be removed by an Ozon shop operation',
  }),
  externalEntry({
    id: 'runtime:purchase-task-queue',
    storageKind: 'runtime',
    resource: 'purchase browser/plugin task queue',
    ownerType: 'purchase_account',
    ownerField: 'resolver:purchase-browser-task-runtime',
    deletePrimitive: 'future:accountRemovalRuntimeCoordinator.quiesce.purchaseBrowserRuntime',
    verifyQuery: { type: 'runtime-owner-count', path: 'resolver:purchase-browser-task-runtime', expected: 'zero' },
    risk: 'the owner fence must drain every executing or receipt-pending task before SQLite or browser cleanup begins',
    availability: 'current',
    removable: true,
  }),
  externalEntry({
    id: 'filesystem:recovery-staging-root',
    storageKind: 'filesystem',
    resource: 'recovery staging profile/database root',
    ownerType: 'unknown',
    ownerField: 'restore-manifest-owner-unavailable',
    risk: 'staging may contain mixed owners during restore; only a future verified manifest may authorize cleanup',
  }),
  ...[
    ['ozon_shop', 'ozon-shop'],
    ['cross_border_bus', 'cross-border-bus'],
    ['promotion_account', 'promotion-account'],
    ['purchase_account', 'purchase-account'],
    ['model_api_account', 'model-api-account'],
    ['integration_profile', 'integration-profile'],
  ].map(([ownerType, ownerToken]) => externalEntry({
    id: `filesystem:recovery-protection-owner-${ownerToken}`,
    storageKind: 'filesystem',
    resource: `restore-staging, restore-rollback, and restore-failed SQLite families scrubbed for one ${ownerType}`,
    scopeType: 'external',
    ownerType,
    ownerField: 'resolver:recovery-protection-owner',
    deletePrimitive: 'future:accountRemoval.recoveryProtectionOwnerPurge',
    verifyQuery: {
      type: 'protection-owner-absence',
      ownerField: 'resolver:recovery-protection-owner',
      expected: 'absent-and-physically-erased',
    },
    sourceEvidence: sourceEvidence(
      'local-api/src/backup/accountRemovalProtectionService.js',
      'export function createAccountRemovalProtectionService({',
      'only the three fixed recovery roots and their exact SQLite family names are accepted; each copy uses the static owner allowlist, secure_delete, checkpoint, integrity check, and zero-length sidecar readback',
    ),
    preserveRule: 'rewrite only exact owner rows inside recognized recovery SQLite families; preserve every other owner and every system/global row',
    backupRule: 'user-confirmed-owner-scrub',
    executionGroup: 'recovery-local-protection-owner-purge',
    risk: 'unknown files, nested layouts, links, integrity failures, nonzero sidecars, or incomplete readback must keep the account operation pending',
  })),
  ...[
    ['ozon_shop', 'ozon-shop'],
    ['cross_border_bus', 'cross-border-bus'],
    ['promotion_account', 'promotion-account'],
    ['purchase_account', 'purchase-account'],
    ['model_api_account', 'model-api-account'],
    ['integration_profile', 'integration-profile'],
  ].map(([ownerType, ownerToken]) => externalEntry({
    id: `filesystem:diagnostic-logs-owner-${ownerToken}`,
    storageKind: 'filesystem',
    resource: `shared desktop diagnostic logs scrubbed for exact ${ownerType} identifiers`,
    scopeType: 'external',
    ownerType,
    ownerField: 'resolver:diagnostic-log-owner',
    deletePrimitive: 'future:accountRemoval.diagnosticLogOwnerScrub',
    verifyQuery: {
      type: 'diagnostic-log-owner-absence',
      ownerField: 'resolver:diagnostic-log-owner',
      expected: 'absent-and-overwritten',
    },
    sourceEvidence: sourceEvidence(
      'local-api/src/backup/accountRemovalProtectionService.js',
      'export function scrubAccountRemovalDiagnosticLogs({ logDirectory, owner: ownerInput } = {}) {',
      'only fixed process-supervisor log names are accepted; exact raw and URL-encoded owner identifiers are overwritten and read back while other owner text is preserved',
    ),
    preserveRule: 'overwrite only exact target-owner identifier tokens; preserve all unrelated diagnostic text and every other owner identifier',
    backupRule: 'owner-scrub-before-completion',
    executionGroup: 'diagnostic-log-owner-scrub',
    risk: 'unknown files, links, non-UTF-8 data, or failed readback keep the account operation pending',
  })),
  externalEntry({
    id: 'backup:remote-recovery-generation-shared-profile',
    storageKind: 'backup-remote',
    resource: 'remote recovery generation manifest/reference (full profile candidate plus one shop candidate)',
    ownerType: 'unknown',
    ownerField: 'generation mixes profile-wide accounts/settings/assets with a shop candidate; chunk references can be shared',
    deletePrimitive: 'prohibited:shared-encrypted-backup-no-delete-contract',
    verifyQuery: { type: 'fail-closed', expected: 'no-action', ownerField: 'mixed profile and shop generation scope' },
    backupRule: 'preserve-until-owner-partition-contract',
    executionGroup: 'recovery-remote-shared-generation',
    risk: 'remote client has no owner-delete API and a generation is not a single account resource; no account removal may purge or infer generation ownership in Phase B',
  }),
  externalEntry({
    id: 'backup:remote-recovery-generation-chunks-shared-profile',
    storageKind: 'backup-remote',
    resource: 'remote recovery encrypted chunks referenced by a mixed profile/shop generation',
    ownerType: 'unknown',
    ownerField: 'chunk references can be shared by profile and shop candidates and have no single account owner',
    deletePrimitive: 'prohibited:shared-encrypted-backup-no-delete-contract',
    verifyQuery: { type: 'fail-closed', expected: 'no-action', ownerField: 'shared encrypted chunk reference scope' },
    preserveRule: 'preserve every chunk reference until an authoritative owner-partition and reference-count contract exists',
    backupRule: 'preserve-until-owner-partition-contract',
    executionGroup: 'recovery-remote-shared-generation',
    risk: 'destroying an encrypted chunk can make another profile/shop generation unrestorable; Phase B declares no purge primitive',
  }),
  externalEntry({
    id: 'backup:remote-recovery-generation-key-envelope-shared-profile',
    storageKind: 'backup-remote',
    resource: 'remote recovery generation encrypted key envelope',
    ownerType: 'unknown',
    ownerField: 'key envelope wraps mixed profile and shop generation material',
    deletePrimitive: 'prohibited:shared-encrypted-backup-no-delete-contract',
    verifyQuery: { type: 'fail-closed', expected: 'no-action', ownerField: 'shared generation key-envelope scope' },
    preserveRule: 'preserve key envelope with its generation/chunks; never destroy keys for one inferred account',
    backupRule: 'preserve-until-owner-partition-contract',
    executionGroup: 'recovery-remote-shared-generation',
    risk: 'key-envelope destruction is irreversible and cannot be attributed to a single account in the current generation format',
  }),
  ...[
    ['ozon_shop', 'ozon-shop'],
    ['cross_border_bus', 'cross-border-bus'],
    ['promotion_account', 'promotion-account'],
    ['purchase_account', 'purchase-account'],
    ['model_api_account', 'model-api-account'],
    ['integration_profile', 'integration-profile'],
  ].map(([ownerType, ownerToken]) => externalEntry({
    id: `backup:remote-recovery-owner-${ownerToken}`,
    storageKind: 'backup-remote',
    resource: `remote recovery generations rewritten and tombstoned for one ${ownerType} incarnation`,
    scopeType: 'external',
    ownerType,
    ownerField: 'resolver:recovery-owner-ref',
    deletePrimitive: 'future:accountRemoval.remoteRecoveryOwnerPurge',
    verifyQuery: {
      type: 'remote-owner-absence',
      ownerField: 'resolver:recovery-owner-ref',
      expected: 'tombstoned-and-absent',
    },
    sourceEvidence: sourceEvidence(
      'local-api/src/backup/recoveryBackupOrchestrator.js',
      'async function purgeAccountOwner({ owner: ownerInput, ownerIncarnation, remoteClient } = {}) {',
      'HMAC owner reference binds ownerType, ownerId, and created_at incarnation; replacement generations use CAS and final decrypt/readback before a server tombstone is accepted',
    ),
    preserveRule: 'rewrite mixed generations to preserve every other owner, then purge only generations still carrying the exact opaque owner-incarnation reference',
    backupRule: 'purge-owner-material-before-completion',
    executionGroup: 'recovery-remote-owner-purge',
    risk: 'remote deletion must remain pending unless generation CAS, authenticated decrypt/readback, and server tombstone status all succeed',
  })),
  externalEntry({
    id: 'browser:electron-default-session-unattributed',
    storageKind: 'browser-profile',
    resource: 'current Electron default session/profile including cookies, localStorage, IndexedDB, CacheStorage, service workers, HTTP cache, and downloads',
    ownerType: 'unknown',
    ownerField: 'current BrowserWindow has no purchaseAccountId partition or identity mapping',
    risk: 'current Chromium default session can contain shared or unknown data; preserve it until a dedicated per-account browser subsystem exists',
  }),
  externalEntry({
    id: 'browser:purchase-profile-identity',
    storageKind: 'browser-profile',
    resource: 'Electron BrowserIdentityProfile',
    ownerType: 'purchase_account',
    ownerField: 'resolver:purchase-browser-owner-ref',
    deletePrimitive: 'future:purchaseBrowserController.purgeOwner.removeIdentity',
    verifyQuery: { type: 'browser-profile-absence', ownerField: 'resolver:purchase-browser-owner-ref', expected: 'absent' },
    risk: 'raw account IDs must never appear in profile paths, logs, extension state, or download paths',
    availability: 'current',
    removable: true,
  }),
  externalEntry({
    id: 'browser:purchase-persistent-partition',
    storageKind: 'browser-profile',
    resource: 'Electron session persistent partition',
    ownerType: 'purchase_account',
    ownerField: 'resolver:purchase-browser-owner-ref',
    deletePrimitive: 'future:purchaseBrowserController.purgeOwner.removePartition',
    verifyQuery: { type: 'browser-partition-unavailable', ownerField: 'resolver:purchase-browser-owner-ref', expected: 'unavailable' },
    risk: 'all owner webContents must close before storage clear and physical partition removal',
    availability: 'current',
    removable: true,
  }),
  ...[
    ['cookies', 'browser-storage', 'cookies'],
    ['local-storage', 'browser-storage', 'localStorage'],
    ['indexed-db', 'browser-storage', 'IndexedDB'],
    ['cache-storage', 'browser-storage', 'CacheStorage'],
    ['http-cache', 'browser-storage', 'HTTP cache'],
    ['service-workers', 'browser-storage', 'service workers'],
    ['proxy-auth', 'browser-storage', 'proxy configuration and authentication state'],
    ['plugin-installation-state', 'browser-extension', 'purchase plugin installation and enabled state'],
    ['extension-storage', 'browser-extension', 'purchase plugin extension storage'],
    ['downloads', 'browser-download', 'purchase browser temporary downloads'],
  ].map(([suffix, storageKind, resource]) =>
    externalEntry({
      id: `browser:purchase-${suffix}`,
      storageKind,
      resource: `Electron purchase partition ${resource}`,
      ownerType: 'purchase_account',
      ownerField: 'resolver:purchase-browser-owner-ref',
      deletePrimitive: 'future:purchaseBrowserController.purgeOwner.removePartitionArtifacts',
      verifyQuery: { type: 'browser-artifact-absence', artifact: resource, ownerField: 'resolver:purchase-browser-owner-ref', expected: 'absent' },
      risk: 'the controller must close every owner view, clear the exact partition, remove owner state, and read back absence',
      availability: 'current',
      removable: true,
    })
  ),
  externalEntry({
    id: 'browser:integration-profile-identity',
    storageKind: 'browser-profile',
    resource: 'Ozon integration BrowserIdentityProfile',
    ownerType: 'integration_profile',
    ownerField: 'resolver:purchase-browser-owner-ref',
    deletePrimitive: 'future:purchaseBrowserController.purgeOwner.removeIdentity',
    verifyQuery: { type: 'browser-profile-absence', ownerField: 'resolver:purchase-browser-owner-ref', expected: 'absent' },
    sourceEvidence: sourceEvidence('desktop/src/purchaseBrowser/purchaseBrowserProfileStore.js', 'function ownerRefFor(binding = {}) {', 'integration profile id and created-at incarnation resolve to one encrypted browser profile identity'),
    risk: 'an Ozon integration login must use its exact profile id and incarnation without exposing either in filesystem paths',
    availability: 'current',
    removable: true,
  }),
  externalEntry({
    id: 'browser:integration-persistent-partition',
    storageKind: 'browser-profile',
    resource: 'Ozon integration persistent CEF profile',
    ownerType: 'integration_profile',
    ownerField: 'resolver:purchase-browser-owner-ref',
    deletePrimitive: 'future:purchaseBrowserController.purgeOwner.removePartition',
    verifyQuery: { type: 'browser-partition-unavailable', ownerField: 'resolver:purchase-browser-owner-ref', expected: 'unavailable' },
    sourceEvidence: sourceEvidence('desktop/src/purchaseBrowser/cefPurchaseBrowserController.js', 'async function purgeOperation(operationId) {', 'controller closes interactive and collector runtimes before removing the exact owner storage path'),
    risk: 'interactive and collector views sharing the storage reference must both close before physical deletion',
    availability: 'current',
    removable: true,
  }),
  ...[
    ['cookies', 'browser-storage', 'cookies'],
    ['local-storage', 'browser-storage', 'localStorage'],
    ['indexed-db', 'browser-storage', 'IndexedDB'],
    ['cache-storage', 'browser-storage', 'CacheStorage'],
    ['http-cache', 'browser-storage', 'HTTP cache'],
    ['service-workers', 'browser-storage', 'service workers'],
    ['proxy-auth', 'browser-storage', 'proxy configuration and authentication state'],
    ['plugin-installation-state', 'browser-extension', 'built-in plugin installation state'],
    ['extension-storage', 'browser-extension', 'built-in plugin extension storage'],
    ['downloads', 'browser-download', 'browser downloads'],
  ].map(([suffix, storageKind, resource]) => externalEntry({
    id: `browser:integration-${suffix}`,
    storageKind,
    resource: `Ozon integration CEF profile ${resource}`,
    ownerType: 'integration_profile',
    ownerField: 'resolver:purchase-browser-owner-ref',
    deletePrimitive: 'future:purchaseBrowserController.purgeOwner.removePartitionArtifacts',
    verifyQuery: { type: 'browser-artifact-absence', artifact: resource, ownerField: 'resolver:purchase-browser-owner-ref', expected: 'absent' },
    sourceEvidence: sourceEvidence('desktop/src/purchaseBrowser/cefPurchaseBrowserController.js', 'async function purgeOperation(operationId) {', 'controller removes and reads back the exact integration owner browser artifacts'),
    risk: 'only the exact integration profile owner reference may be cleared; other browser accounts and the hidden collector remain isolated',
    availability: 'current',
    removable: true,
  })),
]);

const ACCOUNT_OWNERSHIP_CLOSURE_PATCHES = Object.freeze({
  'memory:purchase-search-bridge-context-unattributed': Object.freeze({
    scopeType: 'shop', ownerType: 'ozon_shop', ownerField: 'resolver:purchase-bridge-shop-context', removable: true,
    deletePrimitive: 'future:accountRemovalClient.purchaseBridgeShopOwnerPurge',
    verifyQuery: Object.freeze({ type: 'memory-owner-absence', ownerField: 'resolver:purchase-bridge-shop-context', expected: 'absent' }),
    preserveRule: 'remove only bridge context whose normalized context.shopId exactly equals ownerId; fence the owner before readback',
  }),
  'memory:purchase-search-bridge-captures-unattributed': Object.freeze({
    scopeType: 'shop', ownerType: 'ozon_shop', ownerField: 'resolver:purchase-bridge-shop-context', removable: true,
    deletePrimitive: 'future:accountRemovalClient.purchaseBridgeShopOwnerPurge',
    verifyQuery: Object.freeze({ type: 'memory-owner-absence', ownerField: 'resolver:purchase-bridge-shop-context', expected: 'absent' }),
    preserveRule: 'remove only captures whose normalized context.shopId exactly equals ownerId; preserve every other shop capture',
  }),
  'memory:renderer-purchase-plugin-source-context-unattributed': Object.freeze({
    scopeType: 'shop', ownerType: 'ozon_shop', ownerField: 'resolver:purchase-plugin-shop-context', removable: true,
    deletePrimitive: 'future:accountRemovalClient.purchasePluginContextOwnerPurge',
    verifyQuery: Object.freeze({ type: 'memory-owner-absence', ownerField: 'resolver:purchase-plugin-shop-context', expected: 'absent' }),
    preserveRule: 'remove the renderer context only when context.shopId exactly equals ownerId and keep the owner write fence for process lifetime',
  }),
  'memory:renderer-product-list-memory-cache-unattributed': Object.freeze({
    scopeType: 'shop', ownerType: 'ozon_shop', ownerField: 'resolver:renderer-product-list-owner-cache', removable: true,
    deletePrimitive: 'future:accountRemovalClient.productListOwnerCachePurge',
    verifyQuery: Object.freeze({ type: 'memory-owner-absence', ownerField: 'resolver:renderer-product-list-owner-cache', expected: 'absent' }),
    preserveRule: 'invalidate only keys carrying the exact canonical Ozon shop id/client id owner token',
  }),
  'memory:renderer-product-list-page-meta-cache-unattributed': Object.freeze({
    scopeType: 'shop', ownerType: 'ozon_shop', ownerField: 'resolver:renderer-product-list-owner-cache', removable: true,
    deletePrimitive: 'future:accountRemovalClient.productListOwnerCachePurge',
    verifyQuery: Object.freeze({ type: 'memory-owner-absence', ownerField: 'resolver:renderer-product-list-owner-cache', expected: 'absent' }),
    preserveRule: 'invalidate only page metadata carrying the exact canonical Ozon shop id/client id owner token',
  }),
  'memory:renderer-product-list-cursor-cache-unattributed': Object.freeze({
    scopeType: 'shop', ownerType: 'ozon_shop', ownerField: 'resolver:renderer-product-list-owner-cache', removable: true,
    deletePrimitive: 'future:accountRemovalClient.productListOwnerCachePurge',
    verifyQuery: Object.freeze({ type: 'memory-owner-absence', ownerField: 'resolver:renderer-product-list-owner-cache', expected: 'absent' }),
    preserveRule: 'invalidate only cursor state carrying the exact canonical Ozon shop id/client id owner token',
  }),
  'memory:renderer-ozon-snapshot-memory-cache-unattributed': Object.freeze({
    scopeType: 'shop', ownerType: 'ozon_shop', ownerField: 'resolver:renderer-ozon-snapshot-owner-cache', removable: true,
    deletePrimitive: 'future:accountRemovalClient.ozonSnapshotOwnerCachePurge',
    verifyQuery: Object.freeze({ type: 'memory-owner-absence', ownerField: 'resolver:renderer-ozon-snapshot-owner-cache', expected: 'absent' }),
    preserveRule: 'remove snapshots whose canonical source key contains the exact shop id/client id owner token; preserve other source members',
  }),
  'memory:renderer-ozon-snapshot-inflight-unattributed': Object.freeze({
    scopeType: 'shop', ownerType: 'ozon_shop', ownerField: 'resolver:renderer-ozon-snapshot-owner-cache', removable: true,
    deletePrimitive: 'future:accountRemovalClient.ozonSnapshotOwnerCachePurge',
    verifyQuery: Object.freeze({ type: 'memory-owner-absence', ownerField: 'resolver:renderer-ozon-snapshot-owner-cache', expected: 'absent' }),
    preserveRule: 'drain and remove only in-flight snapshots carrying the exact canonical shop owner token',
  }),
  'memory:renderer-ozon-snapshot-manual-refresh-unattributed': Object.freeze({
    scopeType: 'shop', ownerType: 'ozon_shop', ownerField: 'resolver:renderer-ozon-snapshot-owner-cache', removable: true,
    deletePrimitive: 'future:accountRemovalClient.ozonSnapshotOwnerCachePurge',
    verifyQuery: Object.freeze({ type: 'memory-owner-absence', ownerField: 'resolver:renderer-ozon-snapshot-owner-cache', expected: 'absent' }),
    preserveRule: 'remove only refresh timestamps carrying the exact canonical shop owner token',
  }),
  'logical:profile-settings-purchase-plugin-context': Object.freeze({
    scopeType: 'profile', ownerType: 'ozon_shop', ownerField: 'json-path:context.shopId', removable: true,
    deletePrimitive: 'future:accountRemoval.profileSettingsPurchasePluginShopSlicePrimitive',
    verifyQuery: Object.freeze({ type: 'json-owner-reference-absence', namespace: 'purchase-plugin-context', ownerField: 'context.shopId', paths: ['context.shopId'], expected: 'absent' }),
    preserveRule: 'clear the context only when context.shopId exactly equals ownerId; preserve another shop context and envelope metadata',
  }),
});

// This list is intentionally exhaustive instead of being a catch-all.  A new
// unknown resource must remain unknown (and therefore fail closed) until it is
// either given an owner selector or explicitly reviewed as a system container.
const EXPLICIT_SYSTEM_CONTAINER_RESOURCE_IDS = new Set([
  'registry:profit-ledger-snapshots',
  'memory:renderer-ozon-shop-settings-unattributed',
  'memory:renderer-purchase-order-local-overrides-unattributed',
  'memory:renderer-purchase-order-override-local-api-hashes-unattributed',
  'memory:renderer-cross-border-settings-unattributed',
  'runtime:renderer-sales-supplement-cooldown-unattributed',
  'runtime:renderer-purchase-supplement-cooldown-unattributed',
  'runtime:renderer-profit-finance-cooldown-unattributed',
  'memory:renderer-sales-order-paged-cache-unattributed',
  'memory:renderer-ozon-order-supplement-cache-unattributed',
  'memory:renderer-ozon-order-image-preload-cache-unattributed',
  'memory:renderer-local-api-active-issues-unattributed',
  'memory:renderer-local-api-sync-jobs-unattributed',
  'runtime:local-api-traffic-controller-mixed-state',
  'memory:local-api-rate-limit-state-mixed-next-allowed',
  'runtime:renderer-ozon-request-control-queue-unattributed',
  'memory:renderer-ozon-request-control-inflight-issues-unattributed',
  'runtime:renderer-local-mirror-file-write-queues-unattributed',
  'runtime:renderer-ozon-local-data-file-write-queues-unattributed',
  'filesystem:desktop-backups-directory-unattributed',
  'filesystem:desktop-tmp-directory-unattributed',
  'memory:renderer-marketing-activity-runtime-cache',
  'runtime:desktop-recovery-staged-descriptors',
  'filesystem:recovery-rollback-root',
  'filesystem:recovery-failed-root',
  'memory:local-api-products-hot-cache',
  'filesystem:desktop-local-data-root',
  'filesystem:desktop-runtime-directory',
  'memory:renderer-local-api-request-stats',
  'runtime:renderer-profit-refresh-progress',
  'memory:renderer-product-material-profile-hashes',
  'runtime:renderer-browser-local-storage-mirror',
  'filesystem:legacy-classification-cache-root',
  'filesystem:local-data-ozon-shop-settings',
  'filesystem:local-data-sales-source-links',
  'filesystem:local-data-product-material-profiles',
  'filesystem:local-data-product-source-links',
  'filesystem:local-data-purchase-source-links',
  'filesystem:local-data-purchase-order-local-overrides',
  'filesystem:local-data-cross-border-bus-order-records',
  'filesystem:local-data-after-sales-display-snapshots',
  'filesystem:local-data-profit-local-cache',
  'filesystem:local-data-local-mirror-read-log',
  'filesystem:local-data-local-mirror-retry-queue',
  'filesystem:local-data-browser-local-storage',
  'filesystem:retired-purchase-plugin-context',
  'filesystem:retired-marketing-activity-cache',
  'memory:renderer-local-data-read-cache-l0',
  'memory:customer-message-translation-cache',
  'filesystem:recovery-staging-root',
  'backup:remote-recovery-generation-shared-profile',
  'backup:remote-recovery-generation-chunks-shared-profile',
  'backup:remote-recovery-generation-key-envelope-shared-profile',
  'browser:electron-default-session-unattributed',
]);

const OWNER_RECORD_MAP_RESOURCE_IDS = new Set([
  'logical:local-data-product-material-profiles-shop-records',
  'logical:local-data-purchase-order-overrides-shop-records',
  'logical:local-data-product-source-links-shop-records',
  'logical:local-data-sales-source-links-shop-records',
  'logical:local-data-purchase-source-links-shop-records',
]);

function closeAccountOwnershipUnknown(entry) {
  if (entry.ownerType !== 'unknown') return entry;
  if (OWNER_RECORD_MAP_RESOURCE_IDS.has(entry.id)) {
    return freezeEntry({
      ...entry,
      scopeType: 'shop',
      ownerType: 'ozon_shop',
      ownerField: 'resolver:local-data-shop-record-map',
      removable: true,
      deletePrimitive: 'future:accountRemovalClient.localDataShopRecordMapPurge',
      verifyQuery: {
        type: 'json-record-map-owner-absence',
        directory: entry.directory,
        fileName: entry.fileName,
        relativePath: entry.relativePath,
        ownerField: 'resolver:local-data-shop-record-map',
        expected: 'absent',
      },
      preserveRule: 'remove only record-map values whose explicit shopId/shop_id exactly equals ownerId; never infer ownership from a legacy key',
    });
  }
  const patch = ACCOUNT_OWNERSHIP_CLOSURE_PATCHES[entry.id];
  if (patch) return freezeEntry({ ...entry, ...patch });
  if (!EXPLICIT_SYSTEM_CONTAINER_RESOURCE_IDS.has(entry.id)) return entry;
  return freezeEntry({
    ...entry,
    scopeType: entry.scopeType === 'profile' ? 'profile' : 'system',
    ownerType: 'system',
    ownerField: `system-container:${entry.id}`,
    removable: false,
    deletePrimitive: 'prohibited:system-container-preserved',
    verifyQuery: { type: 'preserve', ownerField: `system-container:${entry.id}`, expected: 'unchanged' },
    preserveRule: `${entry.preserveRule}; the physical container is global, mixed, retired, or coordination-only and is preserved while separately cataloged owner slices are purged`,
  });
}

export function createAccountOwnershipCatalog(registry = DATA_DOMAIN_REGISTRY) {
  return Object.freeze([
    ...registry.map(createRegistryCatalogEntry),
    ...EXTERNAL_ACCOUNT_OWNERSHIP_RESOURCES,
    externalEntry({
      id: 'filesystem:desktop-recovery-shell-sqlite-file',
      storageKind: 'filesystem',
      resource: 'desktop recovery-shell.sqlite',
      ownerType: 'system',
      ownerField: 'profile recovery shell database',
      sourceEvidence: sourceEvidence('desktop/src/runtime/desktopPaths.js', 'recoveryShellDatabasePath', 'system/profile recovery shell; stop shell and checkpoint; no business-owner deletion'),
      preserveRule: 'preserve recovery shell database; a future physical maintenance task must stop the shell and checkpoint it',
      risk: 'recovery shell is profile system state and cannot be selected by a business-owner deletion',
      backupRule: 'excluded',
    }),
    externalEntry({
      id: 'filesystem:desktop-recovery-shell-sqlite-sidecars',
      storageKind: 'filesystem',
      resource: 'desktop recovery-shell.sqlite-wal and recovery-shell.sqlite-shm',
      ownerType: 'system',
      ownerField: 'profile recovery shell SQLite sidecar family',
      sourceEvidence: sourceEvidence('desktop/src/runtime/desktopPaths.js', 'function recoveryShellDatabasePath(activeDatabasePath = localApiDatabasePath()) {', 'recovery-shell.sqlite-wal/-shm; profile system state'),
      preserveRule: 'preserve recovery shell sidecars; only a future shell checkpoint task may coordinate them',
      risk: 'SQLite sidecars are profile recovery system state and cannot be attributed to one business owner',
      backupRule: 'excluded',
    }),
    externalEntry({
      id: 'memory:desktop-local-api-auth-token',
      storageKind: 'memory',
      resource: 'desktop serviceRuntime local-api authToken',
      ownerType: 'system',
      ownerField: 'process capability shared by local-api requests',
      sourceEvidence: sourceEvidence('desktop/src/runtime/serviceRuntime.js', 'authToken', 'process capability shared by local-api requests; no business-owner anchor'),
      preserveRule: 'preserve the process capability token during business account removal',
      risk: 'clearing the shared local-api capability token disrupts unrelated requests and is not an owner action',
      backupRule: 'excluded',
    }),
    externalEntry({
      id: 'runtime:desktop-service-local-api-runtime',
      storageKind: 'runtime',
      resource: 'desktop serviceRuntime localApiRuntime',
      ownerType: 'system',
      ownerField: 'profile/process local-api runtime',
      sourceEvidence: sourceEvidence('desktop/src/runtime/serviceRuntime.js', 'localApiRuntime', 'profile/process system runtime containing DB path/token/port/recoveryMode'),
      preserveRule: 'preserve the shared local-api runtime; future operations may only coordinate lifecycle fencing',
      risk: 'runtime contains the profile database path, token, port, and recovery mode for every owner',
      backupRule: 'excluded',
    }),
    externalEntry({
      id: 'runtime:desktop-main-lifecycle-state',
      storageKind: 'runtime',
      resource: 'desktop main lifecycle runtime state',
      ownerType: 'system',
      ownerField: 'desktop bootstrap/restart/shutdown lifecycle',
      sourceEvidence: sourceEvidence('desktop/src/main.js', 'runtimeInfo/desktopLicenseRuntime/isQuitting/profileLock/shutdownPromise/runtimeLifecycle', 'desktop lifecycle system state; fence bootstrap/restart/shutdown'),
      preserveRule: 'preserve desktop lifecycle state; future account work may only fence bootstrap, restart, and shutdown',
      risk: 'lifecycle state is profile-global and cannot be cleared by business owner',
      backupRule: 'excluded',
    }),
    externalEntry({
      id: 'runtime:local-api-server-lifecycle-state',
      storageKind: 'runtime',
      resource: 'local-api server/database/shutdown lifecycle',
      ownerType: 'system',
      ownerField: 'server and database handle shared across owners',
      sourceEvidence: sourceEvidence('local-api/src/server.js', 'db/server/shutdownRequested', 'server/database handle shared across owners; drain/checkpoint only'),
      preserveRule: 'preserve server lifecycle state; future work may only drain and checkpoint it',
      risk: 'server/database handles are shared system resources and cannot be selected by owner',
      backupRule: 'excluded',
    }),
    externalEntry({
      id: 'runtime:renderer-purchase-plugin-bridge-runtime',
      storageKind: 'runtime',
      resource: 'renderer purchase plugin bridge availability runtime',
      ownerType: 'system',
      ownerField: 'renderer-global bridge availability state',
      sourceEvidence: sourceEvidence('frontend/src/entities/product/productLocalMirror.jsx', 'purchasePluginBridgeEnabledMemory/purchasePluginBridgeUnavailableUntil', 'renderer-global; no purchaseAccountId anchor'),
      preserveRule: 'preserve renderer-global bridge availability state during business account removal',
      risk: 'bridge state has no purchaseAccountId anchor and cannot be selected by owner',
      backupRule: 'excluded',
    }),
    externalEntry({
      id: 'memory:renderer-ozon-api-performance-counter',
      storageKind: 'memory',
      resource: 'renderer Ozon API performance counter',
      ownerType: 'system',
      ownerField: 'global performance counter',
      sourceEvidence: sourceEvidence('frontend/src/shared/config/appConfigRuntime.jsx', 'export const ozonApiPerformanceCounter = { count: 0 };', 'global performance counter; no business-owner anchor'),
      preserveRule: 'preserve global performance counters during business account removal',
      risk: 'counter is global renderer telemetry and cannot be selected by business owner',
      backupRule: 'excluded',
    }),
    // Ozon preferences are a logical sub-resource of one global profile row,
    // not a second physical SQLite table.  Its actual schema is deliberately
    // named here so a future executor cannot guess a generic JSON key.
    externalEntry({
      id: 'logical:profile-settings-ozon-shop-preferences',
      storageKind: 'sqlite',
      resource: 'profile_settings(namespace=ozon-shop-preferences).value_json.shops[id=ownerId] + defaultWarehouseIds[ownerId] + activeShopId reference',
      scopeType: 'profile',
      ownerType: 'ozon_shop',
      ownerField: 'json-path:shops[].id',
      deletePrimitive: 'future:accountRemoval.profileSettingsOwnerKeyPrimitive',
      verifyQuery: {
        type: 'json-owner-reference-absence',
        namespace: 'ozon-shop-preferences',
        ownerField: 'shops[].id',
        paths: ['shops[].id', 'defaultWarehouseIds[ownerId]', 'activeShopId'],
        expected: 'absent-and-not-active',
      },
      preserveRule: 'remove only the exact shop object and warehouse key; preserve other shops and fields, and require an independently validated remaining activeShopId before a future write',
      backupRule: 'required',
      risk: 'profile JSON requires exact-key readback; no whole-document deletion or guessed active-shop replacement is allowed',
    }),
    externalEntry({
      id: 'logical:profile-settings-cross-border-preferences',
      storageKind: 'sqlite',
      resource: 'profile_settings(namespace=cross-border-preferences).value_json.crossBorderAccountId + accountId reference',
      scopeType: 'profile',
      ownerType: 'cross_border_bus',
      ownerField: 'json-path:crossBorderAccountId',
      deletePrimitive: 'future:accountRemoval.profileSettingsCrossBorderAccountSlicePrimitive',
      verifyQuery: {
        type: 'json-owner-reference-absence',
        namespace: 'cross-border-preferences',
        ownerField: 'crossBorderAccountId',
        paths: ['crossBorderAccountId', 'accountId'],
        expected: 'absent',
      },
      sourceEvidence: sourceEvidence('frontend/src/shared/ozon/ozonRuntime.jsx', "export const PROFILE_CROSS_BORDER_PREFERENCES_NAMESPACE = 'cross-border-preferences';", 'crossBorderAccountId/accountId exact preference reference'),
      preserveRule: 'remove account-specific preference fields only when crossBorderAccountId/accountId resolves to the exact account; preserve global defaults and unrelated settings',
      backupRule: 'required',
      risk: 'a stale cross-border preference can reselect a deleted encrypted account after restart unless both account references are removed and read back',
    }),
    externalEntry({
      id: 'logical:profile-settings-purchase-plugin-context',
      storageKind: 'sqlite',
      resource: 'profile_settings(namespace=purchase-plugin-context).value_json.context',
      scopeType: 'profile',
    ownerType: 'unknown',
    ownerField: 'context.shopId/shopClientId has no authoritative purchaseAccountId mapping',
    backupRule: 'required',
    sourceEvidence: sourceEvidence('local-api/src/db/repositories/profileSettingsRepository.js', 'const PURCHASE_PLUGIN_CONTEXT_NAMESPACE = "purchase-plugin-context";', '无 `purchaseAccountId`'),
      risk: 'purchase plugin context refers to a shop but does not prove one purchase account; no removal may infer that relationship',
    }),
    externalEntry({
      id: 'logical:profile-settings-purchase-account-context',
      storageKind: 'sqlite',
      resource: 'profile_settings(namespace=purchase-plugin-context).value_json.context.purchaseAccountId',
      scopeType: 'profile',
      ownerType: 'purchase_account',
      ownerField: 'json-path:context.purchaseAccountId',
      deletePrimitive: 'future:accountRemoval.profileSettingsPurchaseAccountContextPrimitive',
      verifyQuery: {
        type: 'json-owner-reference-absence',
        namespace: 'purchase-plugin-context',
        ownerField: 'context.purchaseAccountId',
        paths: ['context.purchaseAccountId'],
        expected: 'absent',
      },
      sourceEvidence: sourceEvidence('local-api/src/db/repositories/profileSettingsRepository.js', 'purchaseAccountId: 128,', 'purchase plugin context stores the exact selected purchase account id'),
      preserveRule: 'clear the context only when context.purchaseAccountId exactly equals ownerId; preserve any context owned by another purchase account',
      backupRule: 'required',
      risk: 'a persisted context can republish deleted account state after restart unless the exact purchaseAccountId is removed and read back',
    }),
  ].map(closeAccountOwnershipUnknown));
}

export const ACCOUNT_OWNERSHIP_CATALOG = createAccountOwnershipCatalog();

export function validateAccountOwnershipCatalog(entries = ACCOUNT_OWNERSHIP_CATALOG) {
  if (!Array.isArray(entries)) throw new Error('ACCOUNT_OWNERSHIP_CATALOG_INVALID');
  const ids = new Set();
  for (const entry of entries) {
    if (!isPlainObject(entry) || !isNonEmptyString(entry.id) || ids.has(entry.id)) {
      throw new Error('ACCOUNT_OWNERSHIP_CATALOG_DUPLICATE_ID');
    }
    if (Object.keys(entry).some((field) => !CATALOG_ENTRY_FIELDS.has(field))) {
      throw new Error('ACCOUNT_OWNERSHIP_CATALOG_FIELDS_INCOMPLETE');
    }
    if (!CATALOG_ID_PATTERN.test(entry.id)) {
      throw new Error('ACCOUNT_OWNERSHIP_CATALOG_ID_INVALID');
    }
    if (typeof entry.storageKind !== 'string' || !VALID_STORAGE_KINDS.has(entry.storageKind)) {
      throw new Error('ACCOUNT_OWNERSHIP_CATALOG_STORAGE_KIND_INVALID');
    }
    if (!isContractText(entry.resource) || typeof entry.ownerType !== 'string' || !ACCOUNT_OWNER_TYPES.includes(entry.ownerType) || !isContractText(entry.ownerField)) {
      throw new Error('ACCOUNT_OWNERSHIP_CATALOG_OWNER_INVALID');
    }
    if (typeof entry.scopeType !== 'string' || !VALID_SCOPE_TYPES.has(entry.scopeType)) {
      throw new Error('ACCOUNT_OWNERSHIP_CATALOG_SCOPE_TYPE_INVALID');
    }
    if (typeof entry.availability !== 'string' || !VALID_AVAILABILITY.has(entry.availability)) {
      throw new Error('ACCOUNT_OWNERSHIP_CATALOG_AVAILABILITY_INVALID');
    }
    if (typeof entry.removable !== 'boolean') {
      throw new Error('ACCOUNT_OWNERSHIP_CATALOG_REMOVABLE_INVALID');
    }
    if (typeof entry.deletePrimitive !== 'string' || !/^(?:future|prohibited):[A-Za-z][A-Za-z0-9._:-]*$/u.test(entry.deletePrimitive)) {
      throw new Error('ACCOUNT_OWNERSHIP_CATALOG_DELETE_PRIMITIVE_INVALID');
    }
    if ((entry.ownerType === 'unknown' || entry.ownerType === 'system') && entry.removable !== false) {
      throw new Error('ACCOUNT_OWNERSHIP_CATALOG_FAIL_CLOSED_REQUIRED');
    }
    if (entry.ownerType === 'unknown' && !entry.deletePrimitive.startsWith('prohibited:')) {
      throw new Error('ACCOUNT_OWNERSHIP_CATALOG_UNKNOWN_MUST_BE_PROHIBITED');
    }
    if (entry.availability === 'future-contract' && entry.removable !== false) {
      throw new Error('ACCOUNT_OWNERSHIP_CATALOG_FUTURE_MUST_NOT_BE_PLANNED');
    }
    if (entry.removable === true && entry.deletePrimitive.startsWith('prohibited:')) {
      throw new Error('ACCOUNT_OWNERSHIP_CATALOG_REMOVABLE_PROHIBITED');
    }
    if (entry.removable === true && !entry.deletePrimitive.startsWith('future:')) {
      throw new Error('ACCOUNT_OWNERSHIP_CATALOG_REMOVABLE_PRIMITIVE_INVALID');
    }
    validateOwnerScopeFieldMatrix(entry);
    validateSourceEvidenceContract(entry);
    if (!isContractText(entry.preserveRule) || !isContractText(entry.backupRule) || !isContractText(entry.risk)) {
      throw new Error('ACCOUNT_OWNERSHIP_CATALOG_FIELDS_INCOMPLETE');
    }
    if (entry.executionGroup !== null && entry.executionGroup !== undefined && !isContractText(entry.executionGroup)) {
      throw new Error('ACCOUNT_OWNERSHIP_CATALOG_EXECUTION_GROUP_INVALID');
    }
    if (typeof entry.coverageAudit !== 'boolean') {
      throw new Error('ACCOUNT_OWNERSHIP_CATALOG_COVERAGE_AUDIT_INVALID');
    }
    if (entry.coverageAudit === true && entry.availability !== 'current') {
      throw new Error('ACCOUNT_OWNERSHIP_CATALOG_COVERAGE_AUDIT_INVALID');
    }
    validateVerifyQueryContract(entry);
    validatePlannableSelectorBinding(entry);
    ids.add(entry.id);
  }
  return { ok: true, entries: ids.size };
}

const validation = validateAccountOwnershipCatalog();
if (!validation.ok) throw new Error('ACCOUNT_OWNERSHIP_CATALOG_INVALID');

export function getAccountOwnershipCatalog() {
  return deepFreeze(JSON.parse(JSON.stringify(ACCOUNT_OWNERSHIP_CATALOG)));
}

export function getAccountOwnershipEntry(id) {
  if (typeof id !== 'string') return null;
  return ACCOUNT_OWNERSHIP_CATALOG.find((entry) => entry.id === id.trim()) || null;
}
