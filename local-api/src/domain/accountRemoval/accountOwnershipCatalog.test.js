import { verifyCurrentDiscoveryReviews, resolveReviewedCatalogRelocation } from './accountOwnershipCurrentDiscoveryReviews.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { runMigrations } from '../../db/database.js';
import { DATA_DOMAIN_REGISTRY } from '../../data/dataDomainRegistry.js';
import {
  ACCOUNT_OWNERSHIP_CATALOG,
  ACCOUNT_OWNERSHIP_CATALOG_VERSION,
  getAccountOwnershipCatalog,
  validateAccountOwnershipCatalog,
} from './accountOwnershipCatalog.js';
import {
  ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY,
  ACCOUNT_OWNERSHIP_FROZEN_SOURCE_LINE_OVERLAY,
  applyAccountOwnershipAnchorOverlay,
  ACCOUNT_OWNERSHIP_CURRENT_CATALOG_SOURCE_VERSION,
  ACCOUNT_OWNERSHIP_CURRENT_CATALOG_SOURCE_COMPATIBILITY,
  currentAccountOwnershipCatalogSourceCompatibility,
  frozenAccountOwnershipAnchorMatches,
  ACCOUNT_OWNERSHIP_CURRENT_PRIMARY_SOURCE_VERSION,
  currentAccountOwnershipPrimarySourceCompatibility,
  missingAccountOwnershipPrimarySourceStatements,
} from './accountOwnershipAnchorOverlay.js';
import {
  ACCOUNT_OWNERSHIP_SYSTEM_SOURCE_FACTS,
  verifyAccountOwnershipSystemSourceFacts,
} from './accountOwnershipSystemSourceFacts.js';
import {
  discoverAccountOwnershipOwnerRuntimeSourceFacts,
  verifyAccountOwnershipOwnerRuntimeSourceFacts,
} from './accountOwnershipOwnerRuntimeSourceFacts.js';

const localApiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const workspaceRoot = resolve(localApiRoot, '..');

const COVERAGE_AUDIT_CURRENT_RESOURCE_COUNT = 52;
const FROZEN_B0_LEDGER_SHA256 = 'EDFF68B271830BFEFE320D19774B3DE2B1FC61DF640FED1224D8C61D593B737C';
const CORRECTED_PRIMARY_ANCHORS_BY_ID = new Map(
  ACCOUNT_OWNERSHIP_ANCHOR_OVERLAY.map((entry) => [entry.id, entry.primaryAnchor]),
);

// The frozen B0 ledger remains byte-for-byte immutable. Production work after B0 may
// move declarations, so non-certificate anchors get an explicit current-source line
// overlay instead of weakening the source-window check or rewriting the ledger.
const CURRENT_SOURCE_ANCHORS_BY_ID = new Map(
  ACCOUNT_OWNERSHIP_FROZEN_SOURCE_LINE_OVERLAY.map(([id, current]) => [
    id,
    typeof current === 'string' ? { line: current } : current,
  ]),
);
const MIGRATION_058_062_REGISTRY_EXTENSION_IDS = Object.freeze([
  'registry:shop-identity-tombstones',
  'registry:shop-bootstrap-runs',
  'registry:shop-domain-sync-state',
  'registry:purchase-completion-history',
  'registry:shared-catalog-versions',
  'registry:shared-catalog-import-runs',
  'registry:shared-catalog-categories',
  'registry:shared-catalog-types',
  'registry:shared-catalog-attributes',
  'registry:shared-catalog-attribute-values',
  'registry:shared-catalog-entity-sources',
  'registry:shared-catalog-quarantine',
  'registry:product-sync-runs',
  'registry:product-sync-stage-batches',
  'registry:product-sync-page-proofs',
  'registry:product-sync-outbox',
  'registry:product-sync-quarantine',
  'registry:product-identities',
  'registry:product-status-facts',
  'registry:product-detail-facts',
  'registry:product-dimension-facts',
  'registry:product-price-facts',
  'registry:product-commission-facts',
  'registry:product-acquiring-facts',
  'registry:product-stock-facts',
  'registry:product-warehouse-stock-facts',
  'registry:product-image-facts',
  'registry:product-attribute-facts',
  'registry:product-facet-observations',
]);
const MIGRATION_068_069_REGISTRY_EXTENSION_IDS = Object.freeze([
  'registry:product-manual-cost-profiles',
  'registry:historical-import-runs',
  'registry:historical-import-rows',
  'registry:data-backup-imports',
  'registry:historical-order-facts',
  'registry:historical-order-import-runs',
  'registry:historical-order-import-rows',
]);
const MIGRATION_073_REGISTRY_EXTENSION_IDS = Object.freeze([
  'registry:integration-credentials',
]);
const MIGRATION_074_REGISTRY_EXTENSION_IDS = Object.freeze([
  'registry:cross-border-charge-records',
  'registry:cross-border-charge-links',
]);
const MIGRATION_076_REGISTRY_EXTENSION_IDS = Object.freeze([
  'registry:cross-border-account-shop-bindings',
]);
const MIGRATION_078_REGISTRY_EXTENSION_IDS = Object.freeze([
  'registry:data-backup-owner-imports',
]);
const MIGRATION_112_REGISTRY_EXTENSION_IDS = Object.freeze(['registry:profit-ledger-owner-routes']);
const MIGRATION_096_097_REGISTRY_EXTENSION_IDS = Object.freeze([
  'registry:finance-balance-snapshots',
  'registry:finance-statement-reports',
]);
const ACCOUNT_OWNERSHIP_V5_EXTENSION_IDS = Object.freeze([
  'backup:remote-recovery-owner-integration-profile',
  'browser:integration-cache-storage',
  'browser:integration-cookies',
  'browser:integration-downloads',
  'browser:integration-extension-storage',
  'browser:integration-http-cache',
  'browser:integration-indexed-db',
  'browser:integration-local-storage',
  'browser:integration-persistent-partition',
  'browser:integration-plugin-installation-state',
  'browser:integration-profile-identity',
  'browser:integration-proxy-auth',
  'browser:integration-service-workers',
  'filesystem:diagnostic-logs-owner-integration-profile',
  'filesystem:recovery-protection-owner-integration-profile',
  'logical:profile-settings-purchase-account-context',
  'memory:purchase-search-bridge-purchase-account-captures',
  'memory:purchase-search-bridge-purchase-account-context',
  'memory:renderer-purchase-plugin-account-context',
]);
const ACCOUNT_OWNERSHIP_V6_EXTENSION_IDS = Object.freeze([
  'memory:renderer-collection-listing-category-template-cache',
  'memory:renderer-follow-seller-capture-cache',
  'memory:renderer-smart-tool-ozon-product-detail-cache',
  'memory:renderer-smart-tool-seerfar-category-option-cache',
  'runtime:renderer-logistics-pricing-settings-write-queue',
  'runtime:renderer-market-collector-shared-coordinator',
]);
const ACCOUNT_OWNERSHIP_V7_EXTENSION_IDS = Object.freeze([
  'memory:purchase-search-bridge-pdd-image-title-cache-unattributed',
]);
const ACCOUNT_OWNERSHIP_V8_EXTENSION_IDS = Object.freeze([
  'memory:desktop-purchase-browser-event-listeners',
  'memory:renderer-order-domain-cache-unattributed',
  'runtime:desktop-purchase-browser-cache-maintenance',
  'runtime:desktop-wechat-assistant-runtime',
  'runtime:renderer-customer-consultation-preferences-write-queue',
]);
const ACCOUNT_OWNERSHIP_V9_EXTENSION_IDS = Object.freeze([
  'filesystem:desktop-shop-aggregate-index-file',
  'filesystem:desktop-shop-database-backup-root',
  'filesystem:desktop-shop-database-root',
  'filesystem:shop-aggregate-index-scope',
  'filesystem:shop-database-scope',
]);
const PRODUCT_IMAGE_OSS_EXTENSION_IDS = Object.freeze([
  'memory:collection-browser-capture-inbox-listeners',
  'registry:product-image-assets',
  'registry:product-image-usage-events',
]);
const FOLLOW_SELLER_DEFENSE_REGISTRY_EXTENSION_IDS = Object.freeze([
  'registry:follow-seller-action-attempts',
  'registry:follow-seller-cases',
  'registry:follow-seller-login-preferences',
  'registry:follow-seller-patrol-runs',
]);
const VERSIONED_CURRENT_CATALOG_EXTENSION_IDS = new Set([
  'registry:customer-service-push-view-markers',
  'backup:remote-recovery-owner-cross-border-bus',
  'backup:remote-recovery-owner-model-api-account',
  'backup:remote-recovery-owner-ozon-shop',
  'backup:remote-recovery-owner-promotion-account',
  'backup:remote-recovery-owner-purchase-account',
  'browser:purchase-cache-storage',
  'browser:purchase-cookies',
  'browser:purchase-downloads',
  'browser:purchase-extension-storage',
  'browser:purchase-http-cache',
  'browser:purchase-indexed-db',
  'browser:purchase-local-storage',
  'browser:purchase-persistent-partition',
  'browser:purchase-plugin-installation-state',
  'browser:purchase-profile-identity',
  'browser:purchase-proxy-auth',
  'browser:purchase-service-workers',
  'filesystem:diagnostic-logs-owner-cross-border-bus',
  'filesystem:diagnostic-logs-owner-model-api-account',
  'filesystem:diagnostic-logs-owner-ozon-shop',
  'filesystem:diagnostic-logs-owner-promotion-account',
  'filesystem:diagnostic-logs-owner-purchase-account',
  'filesystem:recovery-protection-owner-cross-border-bus',
  'filesystem:recovery-protection-owner-model-api-account',
  'filesystem:recovery-protection-owner-ozon-shop',
  'filesystem:recovery-protection-owner-promotion-account',
  'filesystem:recovery-protection-owner-purchase-account',
  'filesystem:protected-compute-version-state',
  'logical:profile-settings-cross-border-preferences',
  'logical:purchase-browser-receipts-shop-links',
  'logical:purchase-browser-tasks-shop-links',
  'registry:account-removal-operations',
  'registry:data-backup-exports',
  'registry:purchase-browser-plugin-state',
  'registry:purchase-browser-receipts',
  'registry:purchase-browser-tasks',
  'runtime:purchase-task-queue',
  ...MIGRATION_058_062_REGISTRY_EXTENSION_IDS,
  ...MIGRATION_068_069_REGISTRY_EXTENSION_IDS,
  ...MIGRATION_073_REGISTRY_EXTENSION_IDS,
  ...MIGRATION_074_REGISTRY_EXTENSION_IDS,
  ...MIGRATION_076_REGISTRY_EXTENSION_IDS,
  ...MIGRATION_078_REGISTRY_EXTENSION_IDS,
  ...MIGRATION_096_097_REGISTRY_EXTENSION_IDS,
  ...MIGRATION_112_REGISTRY_EXTENSION_IDS,
  ...ACCOUNT_OWNERSHIP_V5_EXTENSION_IDS,
  ...ACCOUNT_OWNERSHIP_V6_EXTENSION_IDS,
  ...ACCOUNT_OWNERSHIP_V7_EXTENSION_IDS,
  ...ACCOUNT_OWNERSHIP_V8_EXTENSION_IDS,
  ...ACCOUNT_OWNERSHIP_V9_EXTENSION_IDS,
  ...PRODUCT_IMAGE_OSS_EXTENSION_IDS,
  ...FOLLOW_SELLER_DEFENSE_REGISTRY_EXTENSION_IDS,
]);

// <BEGIN_B0_LEDGER_JSON>{"ledgerVersion":"phase-b-b0-frozen-ledger-v2","binding":{"stage":"Phase-B-B0","executionWindow":"019f5d12-22e8-77e3-b58b-8435a5ba5ae4","executionTurn":"019f5fd0-280e-76e2-8f82-484c07be9d12","branch":"codex/checkpoint-20260624-184705","head":"88a6a98f871336a1e64c1c1772a244e0ceda4d05","gitStatusSha256":"11C0E697206A5A5C36E0BB2D3C32625E791927ADE6D30B84F5B04E1C872622DD","fiveFiles":[["accountOwnershipCatalog.js",2275,"138BB0D485F872524FA1EB66E1453590047CCF26DBD7F378DFC8FC7F59756358"],["accountOwnershipCatalog.test.js",1062,"D9D14F4BB8E656CEC1C3E692EE25AD50FA4C40E99BF1A23E006DF89D9DAAE772"],["accountRemovalContract.js",842,"19BBB45F95BD9395A14565E21E0FC2012C276562A139E0BAF56955FAF334797F"],["accountRemovalContract.test.js",619,"BE2951DC9553A292C064A3A95DC0EAE1AA70EB966B0D2FBDCDCA9B0BE6106FE2"],["accountRemovalErrors.js",41,"6C812BD8C4E6F607D89C1BE5485AA2C658561F3525A8AC04E86B48E90B2D4564"]],"phaseA":["28C56AFD1BDBBA5B21E648B8861CF6A8CBDBE9E0C39D3700128F1545E64C42A5","C7918F161CD5078D21686343255256DFE65B219610082AE82F251F0176B4A955","5DAB0B9EA4F6325774156CEFB02EDF00DFC162D7E69F52D15701308EC81C27E4","DDDCD1F25BDD52D44A720C12F4B87AA215A7E854AD47A690E7279C913C063D1C"],"auditTurns":{"contract":"019f601e-f1c5-7e91-8a9b-37ac11ee5923","coverage":"019f601e-f259-7770-8a64-fbe7b75c363b","evidence":"019f601f-1959-7251-8a18-a2d5062d65df"}},"resourceSummary":{"total":333,"catalogRequired":218,"staticCodePreserveNotCatalog":115,"dispositions":{"catalog current":69,"preserve system":191,"unknown prohibited":73},"groups":{"A":{"total":61,"catalog current":50,"preserve system":10,"unknown prohibited":1},"B":{"total":97,"catalog current":11,"preserve system":30,"unknown prohibited":56},"C":{"total":52,"catalog current":8,"preserve system":28,"unknown prohibited":16},"D":{"total":115,"catalog current":0,"preserve system":115,"unknown prohibited":0},"E":{"total":8,"catalog current":0,"preserve system":8,"unknown prohibited":0}},"rule":"Only the three disposition strings above are allowed. No source anchor => unknown prohibited. Group D is code-static preserve and must not enter deletion Catalog."},"resources":[{"id":"registry:shops","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[shops]","line":"25","ownerBasis":"shops.id","disposition":"catalog current","catalogRequired":true},{"id":"registry:shop-credentials","group":"A","category":"Secret Vault","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[shop-credentials]","line":"26","ownerBasis":"`shops.id` 对应加密凭证列","disposition":"catalog current","catalogRequired":true},{"id":"registry:recovery-keyset","group":"A","category":"SQLite/secret","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[recovery-keyset]","line":"27-28","ownerBasis":"无业务账号 anchor；profile keyset","disposition":"preserve system","catalogRequired":true},{"id":"registry:cross-border-accounts","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[cross-border-accounts]","line":"29","ownerBasis":"cross_border_accounts.id","disposition":"catalog current","catalogRequired":true},{"id":"registry:performance-accounts","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[performance-accounts]","line":"30","ownerBasis":"performance_accounts.id","disposition":"catalog current","catalogRequired":true},{"id":"registry:purchase-accounts","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[purchase-accounts]","line":"31","ownerBasis":"purchase_accounts.id","disposition":"catalog current","catalogRequired":true},{"id":"registry:model-api-accounts","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[model-api-accounts]","line":"32","ownerBasis":"model_api_accounts.id","disposition":"catalog current","catalogRequired":true},{"id":"registry:integration-profiles","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[integration-profiles]","line":"33","ownerBasis":"无业务账号 anchor","disposition":"preserve system","catalogRequired":true},{"id":"registry:profile-settings","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[profile-settings]","line":"34","ownerBasis":"namespace 不是业务 owner","disposition":"preserve system","catalogRequired":true},{"id":"registry:profile-assets","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[profile-assets]","line":"35","ownerBasis":"无业务账号 anchor","disposition":"preserve system","catalogRequired":true},{"id":"registry:purchase-overrides","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[purchase-overrides]","line":"36","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:purchase-source-links","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[purchase-source-links]","line":"37","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:sales-source-links","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[sales-source-links]","line":"38","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:product-source-links","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[product-source-links]","line":"39","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:product-material-profiles","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[product-material-profiles]","line":"40","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:order-split-relations","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[order-split-relations]","line":"41","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:notification-settings","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[notification-settings]","line":"42","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:products","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[products]","line":"44","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:orders","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[orders]","line":"45","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:finance-transactions","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[finance-transactions]","line":"46","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:returns","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[returns]","line":"47","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:marketing-activities","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[marketing-activities]","line":"48-59","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:marketing-activity-products","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[marketing-activity-products]","line":"60-71","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:marketing-view-state","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[marketing-view-state]","line":"72-85","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:rating-penalties","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[rating-penalties]","line":"86","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:analytics-daily","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[analytics-daily]","line":"87","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:cross-border-order-records","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[cross-border-order-records]","line":"88","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:catalog-category-nodes","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[catalog-category-nodes]","line":"90","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:catalog-category-mappings","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[catalog-category-mappings]","line":"91","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:catalog-attributes","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[catalog-attributes]","line":"92","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:catalog-attribute-values","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[catalog-attribute-values]","line":"93","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:product-image-health","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[product-image-health]","line":"94","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:data-analysis-snapshots","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[data-analysis-snapshots]","line":"95","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:profit-ledger-snapshots","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[profit-ledger-snapshots]","line":"96","ownerBasis":"无可证明 owner anchor；`snapshot_key/logical_scope` 可多店","disposition":"unknown prohibited","catalogRequired":true},{"id":"registry:exchange-rate-cache","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[exchange-rate-cache]","line":"97","ownerBasis":"日期/币种，无业务 owner","disposition":"preserve system","catalogRequired":true},{"id":"registry:sync-state-runtime","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[sync-state-runtime]","line":"99-101","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:recovery-reconcile-state","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[recovery-reconcile-state]","line":"102","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:response-cache","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[response-cache]","line":"103","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:catalog-cache-keys","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[catalog-cache-keys]","line":"104","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:catalog-cache-key-registry","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[catalog-cache-key-registry]","line":"105","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:catalog-cache-sync-state","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[catalog-cache-sync-state]","line":"106","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:data-analysis-sync-state","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[data-analysis-sync-state]","line":"107","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:scheduler-trace-events","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\db\\migrations\\027_create_ozon_scheduler_observability.sql","sourceSymbol":"ozon_scheduler_trace_events","line":"33","ownerBasis":"nullable `shop_id`","disposition":"catalog current","catalogRequired":true},{"id":"registry:request-jobs","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[request-jobs]","line":"109","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:request-attempts","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\db\\migrations\\004_create_ozon_scheduler_tables.sql","sourceSymbol":"ozon_request_attempts","line":"26","ownerBasis":"nullable `shop_id`","disposition":"catalog current","catalogRequired":true},{"id":"registry:cache-merge-log","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\db\\migrations\\004_create_ozon_scheduler_tables.sql","sourceSymbol":"ozon_cache_merge_log","line":"127","ownerBasis":"nullable `shop_id`","disposition":"catalog current","catalogRequired":true},{"id":"registry:sync-locks","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[sync-locks]","line":"112","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:sync-snapshots","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[sync-snapshots]","line":"113","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:error-events","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\db\\migrations\\004_create_ozon_scheduler_tables.sql","sourceSymbol":"ozon_error_events","line":"156","ownerBasis":"nullable `shop_id`","disposition":"catalog current","catalogRequired":true},{"id":"registry:circuit-breakers","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[circuit-breakers]","line":"115","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:rate-limit-state","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[rate-limit-state]","line":"116","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:shop-runtime-state","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[shop-runtime-state]","line":"117","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:notification-events","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[notification-events]","line":"118","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:write-audit-log","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[write-audit-log]","line":"119","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:sync-jobs","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[sync-jobs]","line":"120","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:legacy-sync-state","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[legacy-sync-state]","line":"121","ownerBasis":"shop_id","disposition":"catalog current","catalogRequired":true},{"id":"registry:legacy-browser-observation-days","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[legacy-browser-observation-days]","line":"122","ownerBasis":"`profile_id` 不是业务账号","disposition":"preserve system","catalogRequired":true},{"id":"registry:legacy-browser-read-key-days","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[legacy-browser-read-key-days]","line":"123","ownerBasis":"`profile_id` 不是业务账号","disposition":"preserve system","catalogRequired":true},{"id":"registry:legacy-browser-observation-sessions","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[legacy-browser-observation-sessions]","line":"124","ownerBasis":"`profile_id` 不是业务账号","disposition":"preserve system","catalogRequired":true},{"id":"registry:legacy-browser-observation-batches","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[legacy-browser-observation-batches]","line":"125","ownerBasis":"`profile_id` 不是业务账号","disposition":"preserve system","catalogRequired":true},{"id":"registry:schema-migrations","group":"A","category":"SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"DATA_DOMAIN_REGISTRY[schema-migrations]","line":"126","ownerBasis":"migration version，无业务 owner","disposition":"preserve system","catalogRequired":true},{"id":"memory:purchase-search-bridge-context-unattributed","group":"B","category":"memory","sourceFile":"G:\\桌面端\\frontend\\scripts\\purchase-bridge\\plugin-store.mjs","sourceSymbol":"purchasePluginContext","line":"59-79,140-147,157,163","ownerBasis":"无 `purchaseAccountId`","disposition":"unknown prohibited","catalogRequired":true},{"id":"memory:purchase-search-bridge-captures-unattributed","group":"B","category":"memory","sourceFile":"G:\\桌面端\\frontend\\scripts\\purchase-bridge\\plugin-store.mjs","sourceSymbol":"purchasePluginCaptures","line":"131-164","ownerBasis":"无 `purchaseAccountId`","disposition":"unknown prohibited","catalogRequired":true},{"id":"memory:local-api-write-guard-previews","group":"B","category":"Map","sourceFile":"G:\\桌面端\\local-api\\src\\security\\writeGuardService.js","sourceSymbol":"previews","line":"48-78,102-220","ownerBasis":"preview.shopId","disposition":"catalog current","catalogRequired":true},{"id":"memory:renderer-ozon-shop-settings-unattributed","group":"B","category":"memory","sourceFile":"G:\\桌面端\\frontend\\src\\services\\ozonShopSettingsStore.js","sourceSymbol":"ozonShopSettingsMemory","line":"12-15,92-103","ownerBasis":"聚合多店；整个对象无单一 owner","disposition":"unknown prohibited","catalogRequired":true},{"id":"memory:renderer-purchase-order-local-overrides-unattributed","group":"B","category":"memory","sourceFile":"G:\\桌面端\\frontend\\src\\services\\purchaseOrderRuntime.js","sourceSymbol":"purchaseOrderLocalOverridesMemory","line":"659-665","ownerBasis":"key 可为无 scope 订单 key","disposition":"unknown prohibited","catalogRequired":true},{"id":"memory:renderer-purchase-order-override-local-api-hashes-unattributed","group":"B","category":"Map","sourceFile":"G:\\桌面端\\frontend\\src\\services\\purchaseOrderRuntime.js","sourceSymbol":"purchaseOrderOverrideLocalApiHashes","line":"661,907-939","ownerBasis":"key 只有 `orderKey`","disposition":"unknown prohibited","catalogRequired":true},{"id":"memory:renderer-purchase-plugin-source-context-unattributed","group":"B","category":"memory","sourceFile":"G:\\桌面端\\frontend\\src\\services\\purchasePluginContextStore.js","sourceSymbol":"purchasePluginSourceContextMemory","line":"48-53,335-438","ownerBasis":"无 `purchaseAccountId`","disposition":"unknown prohibited","catalogRequired":true},{"id":"memory:renderer-cross-border-settings-unattributed","group":"B","category":"memory","sourceFile":"G:\\桌面端\\frontend\\src\\shared\\ozon\\ozonRuntime.jsx","sourceSymbol":"crossBorderSettingsMemory","line":"287-289,383-431","ownerBasis":"整体混合偏好、默认账号和直接凭证","disposition":"unknown prohibited","catalogRequired":true},{"id":"memory:desktop-license-session-store-memory","group":"B","category":"memory","sourceFile":"G:\\桌面端\\desktop\\src\\licensing\\licenseSessionStore.js","sourceSymbol":"LicenseSessionStore.memory","line":"87-98","ownerBasis":"安装级 license session","disposition":"preserve system","catalogRequired":true},{"id":"memory:desktop-purchase-bridge-auth-token","group":"B","category":"token","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\purchaseBridgeState.js","sourceSymbol":"authToken","line":"27-51","ownerBasis":"进程级 bridge token","disposition":"preserve system","catalogRequired":true},{"id":"memory:renderer-product-list-memory-cache-unattributed","group":"B","category":"Map/cache","sourceFile":"G:\\桌面端\\frontend\\src\\entities\\product\\productLocalData.jsx","sourceSymbol":"productListMemoryCache","line":"60-70,260-271","ownerBasis":"key 可用 client/id/label fallback","disposition":"unknown prohibited","catalogRequired":true},{"id":"memory:renderer-product-list-page-meta-cache-unattributed","group":"B","category":"Map/cache","sourceFile":"G:\\桌面端\\frontend\\src\\entities\\product\\productLocalData.jsx","sourceSymbol":"productListPageMetaMemoryCache","line":"62-70,260-271","ownerBasis":"同上","disposition":"unknown prohibited","catalogRequired":true},{"id":"memory:renderer-product-list-cursor-cache-unattributed","group":"B","category":"Map/cache","sourceFile":"G:\\桌面端\\frontend\\src\\entities\\product\\productLocalData.jsx","sourceSymbol":"productListCursorMemoryCache","line":"64-70,260-271","ownerBasis":"同上","disposition":"unknown prohibited","catalogRequired":true},{"id":"memory:renderer-ozon-snapshot-memory-cache-unattributed","group":"B","category":"Map/cache","sourceFile":"G:\\桌面端\\frontend\\src\\shared\\config\\appConfigRuntime.jsx","sourceSymbol":"ozonSnapshotMemoryCache","line":"440-458","ownerBasis":"key 可包含多 shop scope","disposition":"unknown prohibited","catalogRequired":true},{"id":"memory:renderer-ozon-snapshot-inflight-unattributed","group":"B","category":"Map/in-flight","sourceFile":"G:\\桌面端\\frontend\\src\\shared\\config\\appConfigRuntime.jsx","sourceSymbol":"ozonSnapshotInFlight","line":"444-458","ownerBasis":"key 可包含多 shop scope","disposition":"unknown prohibited","catalogRequired":true},{"id":"memory:renderer-ozon-snapshot-manual-refresh-unattributed","group":"B","category":"Map","sourceFile":"G:\\桌面端\\frontend\\src\\shared\\config\\appConfigRuntime.jsx","sourceSymbol":"ozonSnapshotManualRefreshAt","line":"446-458","ownerBasis":"无权威单 owner map","disposition":"unknown prohibited","catalogRequired":true},{"id":"memory:renderer-sales-order-paged-cache-unattributed","group":"B","category":"Map/cache","sourceFile":"G:\\桌面端\\frontend\\src\\services\\salesOrderPagedCacheClient.js","sourceSymbol":"salesOrderPagedMemoryCache","line":"5-11,30-115","ownerBasis":"query 可含单个或多个 shopIds","disposition":"unknown prohibited","catalogRequired":true},{"id":"memory:renderer-profit-finance-operation-cache","group":"B","category":"Map/cache","sourceFile":"G:\\桌面端\\frontend\\src\\entities\\profit\\profitFinanceEvidence.jsx","sourceSymbol":"profitFinanceOperationCache","line":"541-572","ownerBasis":"shop `id/clientId` 解析对","disposition":"catalog current","catalogRequired":true},{"id":"memory:renderer-profit-after-sales-snapshot-cache","group":"B","category":"Map/cache","sourceFile":"G:\\桌面端\\frontend\\src\\entities\\profit\\profitFinanceEvidence.jsx","sourceSymbol":"profitAfterSalesSnapshotCache","line":"805-839","ownerBasis":"shop `id/clientId` 解析对","disposition":"catalog current","catalogRequired":true},{"id":"memory:renderer-profit-rating-penalty-operation-cache","group":"B","category":"Map/cache","sourceFile":"G:\\桌面端\\frontend\\src\\entities\\profit\\profitLedgerMapping.jsx","sourceSymbol":"profitRatingPenaltyOperationCache","line":"234-264,282-361","ownerBasis":"shop `id/clientId` 解析对","disposition":"catalog current","catalogRequired":true},{"id":"memory:renderer-ozon-order-supplement-cache-unattributed","group":"B","category":"Map/cache","sourceFile":"G:\\桌面端\\frontend\\src\\services\\ozonOrderExperience.js","sourceSymbol":"supplementCache","line":"1-7,532-646","ownerBasis":"key 可用名称、seller、order 或无 shop","disposition":"unknown prohibited","catalogRequired":true},{"id":"memory:renderer-ozon-order-image-preload-cache-unattributed","group":"B","category":"Map/cache","sourceFile":"G:\\桌面端\\frontend\\src\\services\\ozonOrderExperience.js","sourceSymbol":"imagePreloadCache","line":"1-7,1035-1088","ownerBasis":"image URL","disposition":"unknown prohibited","catalogRequired":true},{"id":"memory:renderer-local-api-active-issues-unattributed","group":"B","category":"Map","sourceFile":"G:\\桌面端\\frontend\\src\\api\\localApiClient.js","sourceSymbol":"localApiActiveIssues","line":"47-60,187-200","ownerBasis":"key 为 API path","disposition":"unknown prohibited","catalogRequired":true},{"id":"memory:renderer-local-api-sync-jobs-unattributed","group":"B","category":"Map","sourceFile":"G:\\桌面端\\frontend\\src\\api\\localApiClient.js","sourceSymbol":"localApiSyncJobs","line":"49,104-150","ownerBasis":"renderer normalization 丢弃 `shopId`","disposition":"unknown prohibited","catalogRequired":true},{"id":"memory:local-api-exchange-rate-daily-cache","group":"B","category":"Map/cache","sourceFile":"G:\\桌面端\\local-api\\src\\domain\\exchange\\exchangeRateService.js","sourceSymbol":"dailyRateCache","line":"270-275,329-360","ownerBasis":"date key","disposition":"preserve system","catalogRequired":true},{"id":"memory:local-api-software-category-name-index","group":"B","category":"memory/cache","sourceFile":"G:\\桌面端\\local-api\\src\\cache\\catalog\\softwareCategoryNameService.js","sourceSymbol":"categoryIndexCache","line":"7,49-117","ownerBasis":"静态类目树","disposition":"preserve system","catalogRequired":true},{"id":"memory:local-api-rate-limit-state-mixed-next-allowed","group":"B","category":"Map","sourceFile":"G:\\桌面端\\local-api\\src\\ozon\\rateLimitState.js","sourceSymbol":"nextAllowedAt","line":"9-10,64-65,194-201","ownerBasis":"混合 `shopId/global`","disposition":"unknown prohibited","catalogRequired":true},{"id":"memory:renderer-ozon-request-control-inflight-issues-unattributed","group":"B","category":"Map/in-flight","sourceFile":"G:\\桌面端\\frontend\\src\\services\\ozonRequestControl.js","sourceSymbol":"inFlightByDedupeKey/activeIssues","line":"88-108","ownerBasis":"dedupe/issue key 可用 unknown-shop","disposition":"unknown prohibited","catalogRequired":true},{"id":"memory:local-api-hot-cache-l1","group":"B","category":"Map/cache","sourceFile":"G:\\桌面端\\local-api\\src\\cache\\hotCacheService.js","sourceSymbol":"store","line":"37-52,115-147","ownerBasis":"entry tag `shop:${ownerId}`","disposition":"catalog current","catalogRequired":true},{"id":"memory:local-api-hot-cache-shop-tag","group":"B","category":"cache tag","sourceFile":"G:\\桌面端\\local-api\\src\\cache\\cacheReadService.js","sourceSymbol":"shop-tag write site","line":"116-134","ownerBasis":"shop:${ownerId}","disposition":"catalog current","catalogRequired":true},{"id":"memory:renderer-local-data-read-cache-l0","group":"B","category":"Map/cache","sourceFile":"G:\\桌面端\\frontend\\src\\shared\\config\\appConfigCore.jsx","sourceSymbol":"localDataFileReadCache","line":"512-514","ownerBasis":"key 仅 file key","disposition":"unknown prohibited","catalogRequired":true},{"id":"memory:catalog-cache-active-jobs","group":"B","category":"Map/jobs","sourceFile":"G:\\桌面端\\local-api\\src\\cache\\catalog\\catalogCacheService.js","sourceSymbol":"jobs","line":"185-193,225-246","ownerBasis":"job.shopId","disposition":"catalog current","catalogRequired":true},{"id":"memory:performance-access-token-cache","group":"B","category":"Map/token","sourceFile":"G:\\桌面端\\local-api\\src\\integrations\\performanceApiClient.js","sourceSymbol":"performanceTokenReuseByAccount","line":"21-22,580-609","ownerBasis":"key 为 `baseUrl::clientId`","disposition":"unknown prohibited","catalogRequired":true},{"id":"memory:performance-inflight-request-cache","group":"B","category":"Map/in-flight","sourceFile":"G:\\桌面端\\local-api\\src\\integrations\\performanceApiClient.js","sourceSymbol":"performanceOverviewInFlightReads","line":"21,115-134,3607-3625","ownerBasis":"key 接受 accountId/clientId/direct","disposition":"unknown prohibited","catalogRequired":true},{"id":"memory:customer-message-translation-cache","group":"B","category":"Map/cache","sourceFile":"G:\\桌面端\\local-api\\src\\domain\\customerService\\customerMessageTranslationService.js","sourceSymbol":"memoryCache","line":"38-44,62-94","ownerBasis":"text-derived key","disposition":"unknown prohibited","catalogRequired":true},{"id":"browser:external-chrome-extension-profile-unattributed","group":"B","category":"browser profile","sourceFile":"G:\\桌面端\\frontend\\purchase-capture-extension\\manifest.json","sourceSymbol":"manifest","line":"1-64","ownerBasis":"无 `purchaseAccountId`/partition 映射","disposition":"unknown prohibited","catalogRequired":true},{"id":"browser:external-chrome-extension-storage-unattributed","group":"B","category":"browser storage","sourceFile":"G:\\桌面端\\frontend\\purchase-capture-extension\\content.js","sourceSymbol":"POSITION_KEY..LOCKED_CONTEXT_KEY","line":"7-12,849-895,1644-1653","ownerBasis":"六个 key 均无账号字段","disposition":"unknown prohibited","catalogRequired":true},{"id":"browser:electron-default-session-unattributed","group":"B","category":"Electron session","sourceFile":"G:\\桌面端\\desktop\\src\\window\\mainWindow.js","sourceSymbol":"new BrowserWindow","line":"3590-3620","ownerBasis":"未配置 `partition`","disposition":"unknown prohibited","catalogRequired":true},{"id":"runtime:desktop-recovery-auto-backup-scheduler","group":"B","category":"scheduler","sourceFile":"G:\\桌面端\\desktop\\src\\licensing\\recoveryAutoBackupScheduler.js","sourceSymbol":"timer/running/status","line":"13-67","ownerBasis":"process-global recovery scheduler; no business-owner anchor","disposition":"preserve system","catalogRequired":true},{"id":"runtime:renderer-ozon-shop-settings-write-queue","group":"B","category":"write queue","sourceFile":"G:\\桌面端\\frontend\\src\\services\\ozonShopSettingsStore.js","sourceSymbol":"ozonShopSettingsWriteQueue","line":"12-15,228-250","ownerBasis":"共享多店写队列","disposition":"preserve system","catalogRequired":true},{"id":"runtime:renderer-purchase-order-override-local-api-write-queue","group":"B","category":"write queue","sourceFile":"G:\\桌面端\\frontend\\src\\services\\purchaseOrderRuntime.js","sourceSymbol":"purchaseOrderOverrideLocalApiWriteQueue","line":"663,907-939","ownerBasis":"共享多店闭包","disposition":"preserve system","catalogRequired":true},{"id":"runtime:renderer-purchase-order-override-migration-task","group":"B","category":"migration promise","sourceFile":"G:\\桌面端\\frontend\\src\\services\\purchaseOrderRuntime.js","sourceSymbol":"activePurchaseOrderOverrideMigration","line":"664,1073-1173","ownerBasis":"聚合 legacy 输入","disposition":"preserve system","catalogRequired":true},{"id":"runtime:renderer-purchase-plugin-context-write-queue","group":"B","category":"write queue","sourceFile":"G:\\桌面端\\frontend\\src\\services\\purchasePluginContextStore.js","sourceSymbol":"purchasePluginContextWriteQueue","line":"48-53,286-290","ownerBasis":"无 purchase owner","disposition":"preserve system","catalogRequired":true},{"id":"runtime:renderer-purchase-plugin-context-last-operation","group":"B","category":"promise","sourceFile":"G:\\桌面端\\frontend\\src\\services\\purchasePluginContextStore.js","sourceSymbol":"lastPurchasePluginContextOperation","line":"48-53,286-290","ownerBasis":"profile 全局","disposition":"preserve system","catalogRequired":true},{"id":"runtime:renderer-purchase-plugin-context-migration-task","group":"B","category":"migration promise","sourceFile":"G:\\桌面端\\frontend\\src\\services\\purchasePluginContextStore.js","sourceSymbol":"activePurchasePluginSourceContextMigration","line":"50,335-438","ownerBasis":"无 purchase owner","disposition":"preserve system","catalogRequired":true},{"id":"runtime:renderer-purchase-plugin-context-revision-guard","group":"B","category":"runtime guard","sourceFile":"G:\\桌面端\\frontend\\src\\services\\purchasePluginContextStore.js","sourceSymbol":"purchasePluginContextRevision","line":"51-53,286-438","ownerBasis":"renderer 全局 revision","disposition":"preserve system","catalogRequired":true},{"id":"runtime:renderer-cross-border-settings-write-queue","group":"B","category":"write queue","sourceFile":"G:\\桌面端\\frontend\\src\\shared\\ozon\\ozonRuntime.jsx","sourceSymbol":"crossBorderSettingsWriteQueue","line":"287-289,383-407","ownerBasis":"共享偏好/account 写入","disposition":"preserve system","catalogRequired":true},{"id":"runtime:desktop-license-session-load-task","group":"B","category":"promise","sourceFile":"G:\\桌面端\\desktop\\src\\licensing\\licenseSessionStore.js","sourceSymbol":"loadPromise","line":"87-98,104-129","ownerBasis":"安装级","disposition":"preserve system","catalogRequired":true},{"id":"runtime:desktop-license-session-operation-queue","group":"B","category":"queue","sourceFile":"G:\\桌面端\\desktop\\src\\licensing\\licenseSessionStore.js","sourceSymbol":"operationQueue","line":"87-98,120-129","ownerBasis":"安装级","disposition":"preserve system","catalogRequired":true},{"id":"runtime:desktop-license-device-code-load-task","group":"B","category":"promise","sourceFile":"G:\\桌面端\\desktop\\src\\licensing\\licenseSessionStore.js","sourceSymbol":"deviceCodePromise","line":"87-98","ownerBasis":"设备级","disposition":"preserve system","catalogRequired":true},{"id":"runtime:renderer-sales-supplement-cooldown-unattributed","group":"B","category":"cooldown","sourceFile":"G:\\桌面端\\frontend\\src\\shared\\config\\appConfigRuntime.jsx","sourceSymbol":"salesSupplementCooldown","line":"440-458","ownerBasis":"composite source/client key","disposition":"unknown prohibited","catalogRequired":true},{"id":"runtime:renderer-purchase-supplement-cooldown-unattributed","group":"B","category":"cooldown","sourceFile":"G:\\桌面端\\frontend\\src\\shared\\config\\appConfigRuntime.jsx","sourceSymbol":"purchaseSupplementCooldown","line":"440-458","ownerBasis":"无 purchaseAccountId","disposition":"unknown prohibited","catalogRequired":true},{"id":"runtime:renderer-profit-finance-cooldown-unattributed","group":"B","category":"cooldown","sourceFile":"G:\\桌面端\\frontend\\src\\shared\\config\\appConfigRuntime.jsx","sourceSymbol":"profitFinanceCooldown","line":"440-458","ownerBasis":"composite client key","disposition":"unknown prohibited","catalogRequired":true},{"id":"runtime:local-api-exchange-rate-batch-inflight","group":"B","category":"in-flight","sourceFile":"G:\\桌面端\\local-api\\src\\domain\\exchange\\exchangeRateService.js","sourceSymbol":"dailyBatchInflight","line":"274-275,499-602","ownerBasis":"date list","disposition":"preserve system","catalogRequired":true},{"id":"runtime:local-api-traffic-controller-mixed-state","group":"B","category":"runtime","sourceFile":"G:\\桌面端\\local-api\\src\\ozon\\trafficController.js","sourceSymbol":"nextAllowedAt/limitedUntil/recentLimits","line":"108-168","ownerBasis":"混合 global/client/shop/endpoint","disposition":"unknown prohibited","catalogRequired":true},{"id":"runtime:renderer-ozon-request-control-queue-unattributed","group":"B","category":"queue/runtime","sourceFile":"G:\\桌面端\\frontend\\src\\services\\ozonRequestControl.js","sourceSymbol":"queue/active/stats","line":"88-108,130-250","ownerBasis":"scope 可回退 unknown-shop","disposition":"unknown prohibited","catalogRequired":true},{"id":"runtime:desktop-app-protocol-file-write-queues","group":"B","category":"Map/write queue","sourceFile":"G:\\桌面端\\desktop\\src\\protocol\\appProtocol.js","sourceSymbol":"writeQueues","line":"64,126-135","ownerBasis":"key 为完整 filePath","disposition":"preserve system","catalogRequired":true},{"id":"runtime:renderer-local-mirror-file-write-queues-unattributed","group":"B","category":"write queues","sourceFile":"G:\\桌面端\\frontend\\src\\entities\\product\\productLocalData.jsx","sourceSymbol":"localMirrorReadLogWriteQueue/localMirrorRetryQueueWriteQueue","line":"280-331","ownerBasis":"文件级，无业务 owner","disposition":"unknown prohibited","catalogRequired":true},{"id":"runtime:renderer-ozon-local-data-file-write-queues-unattributed","group":"B","category":"Map/write queue","sourceFile":"G:\\桌面端\\frontend\\src\\entities\\product\\productLocalData.jsx","sourceSymbol":"ozonLocalDataWriteQueues","line":"316-331","ownerBasis":"key 为 legacy file key","disposition":"unknown prohibited","catalogRequired":true},{"id":"runtime:desktop-process-supervisor-child-processes","group":"B","category":"Map/process handles","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\processSupervisor.js","sourceSymbol":"childProcesses","line":"6-86","ownerBasis":"process name，不是账号","disposition":"preserve system","catalogRequired":true},{"id":"runtime:ozon-scheduler-active-queue","group":"B","category":"scheduler/in-flight","sourceFile":"G:\\桌面端\\local-api\\src\\ozon\\ozonScheduler.js","sourceSymbol":"inFlight","line":"310-355,662-813","ownerBasis":"job.shopId","disposition":"catalog current","catalogRequired":true},{"id":"runtime:ozon-request-queue","group":"B","category":"queue/Map/Set","sourceFile":"G:\\桌面端\\local-api\\src\\ozon\\requestQueue.js","sourceSymbol":"queue/active/activeByShop/pausedShops","line":"50-74,296-350","ownerBasis":"item.shopId`/`pausedShops","disposition":"catalog current","catalogRequired":true},{"id":"runtime:continuous-sync-owner-state","group":"B","category":"scheduler/Map","sourceFile":"G:\\桌面端\\local-api\\src\\sync\\continuousSyncService.js","sourceSymbol":"timer/lastQueuedAtByTask/taskStatuses","line":"70-85,106-151,180-247","ownerBasis":"shopId::policyId","disposition":"catalog current","catalogRequired":true},{"id":"filesystem:desktop-data-profile-json","group":"B","category":"file","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\dataLayout.js","sourceSymbol":"profilePath","line":"24-27","ownerBasis":"profile 全局","disposition":"preserve system","catalogRequired":true},{"id":"filesystem:desktop-data-logs-directory","group":"B","category":"directory","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\dataLayout.js","sourceSymbol":"logDirectory","line":"28","ownerBasis":"日志无统一 owner anchor","disposition":"preserve system","catalogRequired":true},{"id":"filesystem:desktop-runtime-profile-lock","group":"B","category":"file/lock","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\dataLayout.js","sourceSymbol":"profileLockPath","line":"29-30","ownerBasis":"profile 全局","disposition":"preserve system","catalogRequired":true},{"id":"filesystem:desktop-backups-directory-unattributed","group":"B","category":"directory","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\dataLayout.js","sourceSymbol":"backupDirectory","line":"31","ownerBasis":"混合 profile/shops","disposition":"unknown prohibited","catalogRequired":true},{"id":"filesystem:desktop-tmp-directory-unattributed","group":"B","category":"directory","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\dataLayout.js","sourceSymbol":"temporaryDirectory","line":"32","ownerBasis":"无统一 owner anchor","disposition":"unknown prohibited","catalogRequired":true},{"id":"filesystem:desktop-local-api-data-root","group":"B","category":"directory","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\dataLayout.js","sourceSymbol":"localApiDataRoot","line":"22,33","ownerBasis":"多 owner 共享容器","disposition":"preserve system","catalogRequired":true},{"id":"filesystem:desktop-local-api-sqlite-file","group":"B","category":"SQLite file","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\dataLayout.js","sourceSymbol":"databasePath","line":"34","ownerBasis":"多 owner 表共享","disposition":"preserve system","catalogRequired":true},{"id":"filesystem:desktop-license-session","group":"B","category":"file","sourceFile":"G:\\桌面端\\desktop\\src\\licensing\\licenseSessionStore.js","sourceSymbol":"sessionPath","line":"87-98","ownerBasis":"安装级 license","disposition":"preserve system","catalogRequired":true},{"id":"filesystem:desktop-license-device-id","group":"B","category":"file","sourceFile":"G:\\桌面端\\desktop\\src\\licensing\\licenseSessionStore.js","sourceSymbol":"devicePath","line":"87-98","ownerBasis":"设备级","disposition":"preserve system","catalogRequired":true},{"id":"filesystem:desktop-purchase-bridge-license-state","group":"B","category":"file","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\purchaseBridgeState.js","sourceSymbol":"statePath","line":"27-51","ownerBasis":"bridge/license 全局","disposition":"preserve system","catalogRequired":true},{"id":"filesystem:desktop-process-supervisor-logs","group":"B","category":"files","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\processSupervisor.js","sourceSymbol":"<logs>/<name>.log","line":"6-86","ownerBasis":"process name","disposition":"preserve system","catalogRequired":true},{"id":"filesystem:legacy-classification-cache-root","group":"B","category":"directory tree","sourceFile":"G:\\桌面端\\desktop\\src\\protocol\\appProtocol.js","sourceSymbol":"LOCAL_DATA_FILES roots","line":"14-45","ownerBasis":"多文件混合 owner","disposition":"unknown prohibited","catalogRequired":true},{"id":"filesystem:local-data-ozon-shop-settings","group":"B","category":"JSON","sourceFile":"G:\\桌面端\\desktop\\src\\protocol\\appProtocol.js","sourceSymbol":"LOCAL_DATA_FILES['ozon-shop-settings']","line":"14-45","ownerBasis":"整文件聚合多店","disposition":"unknown prohibited","catalogRequired":true},{"id":"filesystem:local-data-sales-source-links","group":"B","category":"JSON","sourceFile":"G:\\桌面端\\desktop\\src\\protocol\\appProtocol.js","sourceSymbol":"LOCAL_DATA_FILES['sales-source-links']","line":"14-45","ownerBasis":"legacy key 可无 scope","disposition":"unknown prohibited","catalogRequired":true},{"id":"filesystem:local-data-product-material-profiles","group":"B","category":"JSON","sourceFile":"G:\\桌面端\\desktop\\src\\protocol\\appProtocol.js","sourceSymbol":"LOCAL_DATA_FILES['product-material-profiles']","line":"14-45","ownerBasis":"可含无 shopId 残留","disposition":"unknown prohibited","catalogRequired":true},{"id":"filesystem:local-data-product-source-links","group":"B","category":"JSON","sourceFile":"G:\\桌面端\\desktop\\src\\protocol\\appProtocol.js","sourceSymbol":"LOCAL_DATA_FILES['product-source-links']","line":"14-45","ownerBasis":"alias/default/all 可未解析","disposition":"unknown prohibited","catalogRequired":true},{"id":"filesystem:local-data-purchase-source-links","group":"B","category":"JSON","sourceFile":"G:\\桌面端\\desktop\\src\\protocol\\appProtocol.js","sourceSymbol":"LOCAL_DATA_FILES['purchase-source-links']","line":"14-45","ownerBasis":"alias/default/all 可未解析","disposition":"unknown prohibited","catalogRequired":true},{"id":"filesystem:local-data-purchase-order-local-overrides","group":"B","category":"JSON","sourceFile":"G:\\桌面端\\desktop\\src\\protocol\\appProtocol.js","sourceSymbol":"LOCAL_DATA_FILES['purchase-order-local-overrides']","line":"14-45","ownerBasis":"key 可无 scope","disposition":"unknown prohibited","catalogRequired":true},{"id":"filesystem:local-data-cross-border-bus-order-records","group":"B","category":"JSON","sourceFile":"G:\\桌面端\\desktop\\src\\protocol\\appProtocol.js","sourceSymbol":"LOCAL_DATA_FILES['cross-border-bus-order-records']","line":"14-45","ownerBasis":"无统一 owner schema","disposition":"unknown prohibited","catalogRequired":true},{"id":"filesystem:local-data-after-sales-display-snapshots","group":"B","category":"JSON","sourceFile":"G:\\桌面端\\desktop\\src\\protocol\\appProtocol.js","sourceSymbol":"LOCAL_DATA_FILES['after-sales-display-snapshots']","line":"14-45","ownerBasis":"无统一 owner anchor","disposition":"unknown prohibited","catalogRequired":true},{"id":"filesystem:local-data-profit-local-cache","group":"B","category":"JSON","sourceFile":"G:\\桌面端\\desktop\\src\\protocol\\appProtocol.js","sourceSymbol":"LOCAL_DATA_FILES['profit-local-cache']","line":"14-45","ownerBasis":"可多店聚合","disposition":"unknown prohibited","catalogRequired":true},{"id":"filesystem:local-data-local-mirror-read-log","group":"B","category":"JSON","sourceFile":"G:\\桌面端\\desktop\\src\\protocol\\appProtocol.js","sourceSymbol":"LOCAL_DATA_FILES['local-mirror-read-log']","line":"14-45","ownerBasis":"日志无 owner schema","disposition":"unknown prohibited","catalogRequired":true},{"id":"filesystem:local-data-local-mirror-retry-queue","group":"B","category":"JSON","sourceFile":"G:\\桌面端\\desktop\\src\\protocol\\appProtocol.js","sourceSymbol":"LOCAL_DATA_FILES['local-mirror-retry-queue']","line":"14-45","ownerBasis":"retry 项无统一 owner schema","disposition":"unknown prohibited","catalogRequired":true},{"id":"filesystem:local-data-browser-local-storage","group":"B","category":"JSON","sourceFile":"G:\\桌面端\\desktop\\src\\protocol\\appProtocol.js","sourceSymbol":"LOCAL_DATA_FILES['browser-local-storage']","line":"14-45","ownerBasis":"storage key 不等于 owner","disposition":"unknown prohibited","catalogRequired":true},{"id":"filesystem:retired-purchase-plugin-context","group":"B","category":"JSON","sourceFile":"G:\\桌面端\\desktop\\src\\protocol\\appProtocol.js","sourceSymbol":"RETIRED_PURCHASE_PLUGIN_CONTEXT_FILE","line":"37-40,280-306","ownerBasis":"无 purchaseAccountId","disposition":"unknown prohibited","catalogRequired":true},{"id":"filesystem:retired-marketing-activity-cache","group":"B","category":"JSON","sourceFile":"G:\\桌面端\\desktop\\src\\protocol\\appProtocol.js","sourceSymbol":"RETIRED_MARKETING_ACTIVITY_CACHE_FILE","line":"42-45,361-421","ownerBasis":"legacy scope 可未映射","disposition":"unknown prohibited","catalogRequired":true},{"id":"filesystem:local-api-secret-key","group":"B","category":"secret file","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\dataLayout.js","sourceSymbol":"canonical secret-key path","line":"35","ownerBasis":"profile 全局 key","disposition":"preserve system","catalogRequired":true},{"id":"filesystem:software-category-tree-static","group":"B","category":"packaged file","sourceFile":"G:\\桌面端\\local-api\\src\\cache\\catalog\\softwareCategoryNameService.js","sourceSymbol":"getDefaultTreePath","line":"25-48","ownerBasis":"静态软件资源","disposition":"preserve system","catalogRequired":true},{"id":"filesystem:recovery-staging-root","group":"B","category":"directory/SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\backup\\recoveryStagingService.js","sourceSymbol":"stagingRoot/restore.sqlite","line":"28-45,69-92","ownerBasis":"descriptor 可含 profile 和多 shops","disposition":"unknown prohibited","catalogRequired":true},{"id":"backup:remote-recovery-generation-shared-profile","group":"B","category":"remote generation","sourceFile":"G:\\桌面端\\local-api\\src\\backup\\recoveryGeneration.js","sourceSymbol":"generation","line":"130-194","ownerBasis":"profileCandidate + shopCandidate 混合","disposition":"unknown prohibited","catalogRequired":true},{"id":"backup:remote-recovery-generation-chunks-shared-profile","group":"B","category":"remote chunks","sourceFile":"G:\\桌面端\\local-api\\src\\backup\\recoveryGeneration.js","sourceSymbol":"chunks/objectsById","line":"67-108,170-194","ownerBasis":"chunk 可被多个 object 引用","disposition":"unknown prohibited","catalogRequired":true},{"id":"backup:remote-recovery-generation-key-envelope-shared-profile","group":"B","category":"key envelope","sourceFile":"G:\\桌面端\\local-api\\src\\backup\\recoveryGeneration.js","sourceSymbol":"key envelope","line":"130-194","ownerBasis":"profile keyset 包装混合 generation","disposition":"unknown prohibited","catalogRequired":true},{"id":"logical:profile-settings-ozon-shop-preferences","group":"B","category":"JSON-in-SQLite","sourceFile":"G:\\桌面端\\frontend\\src\\services\\ozonShopSettingsStore.js","sourceSymbol":"normalizeOzonShopSettingsStore","line":"92-103,212-290","ownerBasis":"shops[].id/defaultWarehouseIds[shopId]/activeShopId","disposition":"catalog current","catalogRequired":true},{"id":"logical:profile-settings-purchase-plugin-context","group":"B","category":"JSON-in-SQLite","sourceFile":"G:\\桌面端\\local-api\\src\\db\\repositories\\profileSettingsRepository.js","sourceSymbol":"purchase plugin context shape","line":"13-31,69-99","ownerBasis":"无 `purchaseAccountId`","disposition":"unknown prohibited","catalogRequired":true},{"id":"logical:local-data-ozon-shop-settings-shop-slices","group":"C","category":"JSON records","sourceFile":"G:\\桌面端\\frontend\\src\\services\\ozonShopSettingsStore.js","sourceSymbol":"normalizeOzonShopSettingsStore","line":"92-103","ownerBasis":"shops[].id/defaultWarehouseIds[shopId]/activeShopId","disposition":"catalog current","catalogRequired":true},{"id":"logical:local-data-product-material-profiles-shop-records","group":"C","category":"JSON records","sourceFile":"G:\\桌面端\\frontend\\src\\services\\productMaterialProfileStore.js","sourceSymbol":"product-material profile record-map payload","line":"159-178,314-319","ownerBasis":"root is {[recordKey]: profile}; no profiles[] selector; record-map selector unsupported","disposition":"unknown prohibited","catalogRequired":true},{"id":"logical:local-data-purchase-order-overrides-shop-records","group":"C","category":"JSON records","sourceFile":"G:\\桌面端\\frontend\\src\\services\\purchaseOrderRuntime.js","sourceSymbol":"purchase override record-map payload","line":"907-955","ownerBasis":"root is {[orderKey]: override}; no overrides[] selector; record-map selector unsupported","disposition":"unknown prohibited","catalogRequired":true},{"id":"logical:local-data-product-source-links-shop-records","group":"C","category":"JSON records","sourceFile":"G:\\桌面端\\frontend\\src\\services\\productSourceLinkStore.js","sourceSymbol":"product source-link scoped map key","line":"102-122,132-150","ownerBasis":"owner exists in key ${shopId}:${productKey}; value has no shopId; key selector unsupported","disposition":"unknown prohibited","catalogRequired":true},{"id":"logical:local-data-sales-source-links-shop-records","group":"C","category":"JSON records","sourceFile":"G:\\桌面端\\frontend\\src\\services\\salesSourceLinkStore.js","sourceSymbol":"sales source-link scoped map key","line":"61-104,141-168","ownerBasis":"owner exists in key ${shopId}:${orderKey}; value has no shopId; key selector unsupported","disposition":"unknown prohibited","catalogRequired":true},{"id":"logical:local-data-purchase-source-links-shop-records","group":"C","category":"JSON records","sourceFile":"G:\\桌面端\\frontend\\src\\services\\purchaseSourceLinkStore.js","sourceSymbol":"purchase source-link scoped map key","line":"61-104,141-189","ownerBasis":"owner exists in key ${shopId}:${orderKey}; value has no shopId; key selector unsupported","disposition":"unknown prohibited","catalogRequired":true},{"id":"runtime:renderer-local-api-request-listeners","group":"C","category":"Set/listeners","sourceFile":"G:\\桌面端\\frontend\\src\\api\\localApiClient.js","sourceSymbol":"localApiRequestListeners","line":"47,83-85,210-213","ownerBasis":"listener 函数，无业务 owner","disposition":"preserve system","catalogRequired":true},{"id":"memory:renderer-local-api-request-stats","group":"C","category":"memory/stats","sourceFile":"G:\\桌面端\\frontend\\src\\api\\localApiClient.js","sourceSymbol":"localApiRequestStats","line":"50-60,153-203","ownerBasis":"path/error/job DTO 无 owner anchor","disposition":"unknown prohibited","catalogRequired":true},{"id":"runtime:renderer-workspace-performance","group":"C","category":"Map/Set/arrays","sourceFile":"G:\\桌面端\\frontend\\src\\app\\performance\\workspacePerformanceRuntime.js","sourceSymbol":"workspacePerformanceRuntime","line":"55-66,170-182","ownerBasis":"pageId/performance timing","disposition":"preserve system","catalogRequired":true},{"id":"runtime:renderer-sales-orders-page-load","group":"C","category":"promise","sourceFile":"G:\\桌面端\\frontend\\src\\App.jsx","sourceSymbol":"salesOrdersPageLoadPromise","line":"99","ownerBasis":"module load","disposition":"preserve system","catalogRequired":true},{"id":"memory:renderer-marketing-activity-runtime-cache","group":"C","category":"memory/cache","sourceFile":"G:\\桌面端\\frontend\\src\\entities\\order\\orderShopScope.jsx","sourceSymbol":"marketingActivityRuntimeCacheStore","line":"102-115,351-366","ownerBasis":"key 可为 shop.id/clientId/default","disposition":"unknown prohibited","catalogRequired":true},{"id":"runtime:renderer-marketing-view-state-write-queue","group":"C","category":"write queue","sourceFile":"G:\\桌面端\\frontend\\src\\entities\\order\\orderShopScope.jsx","sourceSymbol":"marketingActivityViewStateWriteQueue","line":"369-404","ownerBasis":"闭包内 `shopId`，队列本身共享","disposition":"preserve system","catalogRequired":true},{"id":"runtime:renderer-profit-refresh-progress","group":"C","category":"Set/state","sourceFile":"G:\\桌面端\\frontend\\src\\features\\profit\\model\\profitRefreshProgressRuntime.js","sourceSymbol":"profitRefreshProgressListeners/Snapshot","line":"1-66","ownerBasis":"只有阶段和计数","disposition":"preserve system","catalogRequired":true},{"id":"memory:renderer-prompt-library-store","group":"C","category":"memory","sourceFile":"G:\\桌面端\\frontend\\src\\features\\promptLibrary\\lib\\promptLibraryStore.jsx","sourceSymbol":"promptLibraryStoreMemory","line":"395-396,619-640","ownerBasis":"profile 工具库","disposition":"preserve system","catalogRequired":true},{"id":"runtime:renderer-prompt-library-write-queue","group":"C","category":"write queue","sourceFile":"G:\\桌面端\\frontend\\src\\features\\promptLibrary\\lib\\promptLibraryStore.jsx","sourceSymbol":"promptLibraryWriteQueue","line":"395-396,619-640","ownerBasis":"profile 全局","disposition":"preserve system","catalogRequired":true},{"id":"memory:renderer-watermark-settings","group":"C","category":"memory","sourceFile":"G:\\桌面端\\frontend\\src\\features\\products\\lib\\productEditing.jsx","sourceSymbol":"watermarkSettingsMemory","line":"236-238,274-314","ownerBasis":"profile 水印设置","disposition":"preserve system","catalogRequired":true},{"id":"runtime:renderer-watermark-settings-write-queue","group":"C","category":"write queue","sourceFile":"G:\\桌面端\\frontend\\src\\features\\products\\lib\\productEditing.jsx","sourceSymbol":"watermarkSettingsWriteQueue","line":"236-238,274-314","ownerBasis":"profile 全局","disposition":"preserve system","catalogRequired":true},{"id":"runtime:renderer-watermark-settings-load-task","group":"C","category":"promise","sourceFile":"G:\\桌面端\\frontend\\src\\features\\products\\lib\\productEditing.jsx","sourceSymbol":"watermarkSettingsLoadPromise","line":"236-238,274-314","ownerBasis":"profile 全局","disposition":"preserve system","catalogRequired":true},{"id":"memory:renderer-fee-plan-state","group":"C","category":"memory","sourceFile":"G:\\桌面端\\frontend\\src\\services\\feeSettingsRuntime.js","sourceSymbol":"feePlanStateMemory","line":"16-50","ownerBasis":"profile 费用配置","disposition":"preserve system","catalogRequired":true},{"id":"runtime:renderer-fee-settings-write-queue","group":"C","category":"write queue","sourceFile":"G:\\桌面端\\frontend\\src\\services\\feeSettingsRuntime.js","sourceSymbol":"feeSettingsWriteQueue","line":"16-50","ownerBasis":"profile 全局","disposition":"preserve system","catalogRequired":true},{"id":"memory:renderer-model-api-settings","group":"C","category":"memory","sourceFile":"G:\\桌面端\\frontend\\src\\features\\settings\\lib\\modelApiSettings.jsx","sourceSymbol":"modelApiSettingsMemory","line":"82,134-180","ownerBasis":"interfaces[].id/activeId","disposition":"catalog current","catalogRequired":true},{"id":"memory:renderer-product-material-profiles","group":"C","category":"memory","sourceFile":"G:\\桌面端\\frontend\\src\\services\\productMaterialProfileStore.js","sourceSymbol":"productMaterialProfileMemory","line":"23-36,314-365","ownerBasis":"profile.shopId","disposition":"catalog current","catalogRequired":true},{"id":"runtime:renderer-product-material-profile-write-queue","group":"C","category":"write queue","sourceFile":"G:\\桌面端\\frontend\\src\\services\\productMaterialProfileStore.js","sourceSymbol":"productMaterialProfileLocalApiWriteQueue","line":"35,314-365","ownerBasis":"多店共享队列","disposition":"preserve system","catalogRequired":true},{"id":"memory:renderer-product-material-profile-hashes","group":"C","category":"Map","sourceFile":"G:\\桌面端\\frontend\\src\\services\\productMaterialProfileStore.js","sourceSymbol":"productMaterialProfileLocalApiHashes","line":"36,310-365","ownerBasis":"key 可为 legacy product key","disposition":"unknown prohibited","catalogRequired":true},{"id":"runtime:renderer-product-source-link-migration","group":"C","category":"migration promise","sourceFile":"G:\\桌面端\\frontend\\src\\services\\productSourceLinkStore.js","sourceSymbol":"activeProductSourceLinkMigration","line":"20,221-231","ownerBasis":"聚合 shops scope","disposition":"preserve system","catalogRequired":true},{"id":"runtime:renderer-sales-source-link-migration","group":"C","category":"migration coordinator","sourceFile":"G:\\桌面端\\frontend\\src\\services\\salesSourceLinkStore.js","sourceSymbol":"salesSourceLinkMigrationCoordinator","line":"18,159-243","ownerBasis":"activeRun 可跨多 shop","disposition":"preserve system","catalogRequired":true},{"id":"runtime:renderer-purchase-source-link-migration","group":"C","category":"migration coordinator","sourceFile":"G:\\桌面端\\frontend\\src\\services\\purchaseSourceLinkStore.js","sourceSymbol":"purchaseSourceLinkMigrationCoordinator","line":"18,180-265","ownerBasis":"activeRun 可跨多 shop","disposition":"preserve system","catalogRequired":true},{"id":"runtime:renderer-legacy-browser-read-telemetry","group":"C","category":"Map/timer/in-flight","sourceFile":"G:\\桌面端\\frontend\\src\\services\\legacyBrowserReadTelemetry.js","sourceSymbol":"pendingReads/retryBatch/timer/inFlight","line":"22-111","ownerBasis":"value-free key counters","disposition":"preserve system","catalogRequired":true},{"id":"runtime:renderer-browser-local-storage-mirror","group":"C","category":"timer/promise","sourceFile":"G:\\桌面端\\frontend\\src\\services\\browserLocalStorageMirror.js","sourceSymbol":"state.flushTimer/flushPromise","line":"120-253","ownerBasis":"当前 keys 为空；controller 全局","disposition":"preserve system","catalogRequired":true},{"id":"memory:renderer-product-fee-exchange-rate","group":"C","category":"memory","sourceFile":"G:\\桌面端\\frontend\\src\\services\\productRowRuntime.js","sourceSymbol":"productFeeRubToCnyRateMemory","line":"67-75","ownerBasis":"汇率值","disposition":"preserve system","catalogRequired":true},{"id":"memory:renderer-license-browser-tokens","group":"C","category":"token memory","sourceFile":"G:\\桌面端\\frontend\\src\\features\\licensing\\services\\licenseCenterClient.js","sourceSymbol":"browserTokens","line":"1-7,40-57","ownerBasis":"license user/session","disposition":"preserve system","catalogRequired":true},{"id":"runtime:renderer-legacy-browser-read-listeners","group":"C","category":"Set/listeners","sourceFile":"G:\\桌面端\\frontend\\src\\services\\browserLegacyReadStore.js","sourceSymbol":"legacyBrowserReadListeners","line":"3-30","ownerBasis":"listener 函数","disposition":"preserve system","catalogRequired":true},{"id":"logical:renderer-ozon-shop-settings-shop-slices","group":"C","category":"memory logical slice","sourceFile":"G:\\桌面端\\frontend\\src\\services\\ozonShopSettingsStore.js","sourceSymbol":"ozonShopSettingsMemory","line":"92-103,212-290","ownerBasis":"shops[].id/defaultWarehouseIds/activeShopId","disposition":"catalog current","catalogRequired":true},{"id":"logical:renderer-purchase-order-overrides-shop-records","group":"C","category":"memory logical slice","sourceFile":"G:\\桌面端\\frontend\\src\\services\\purchaseOrderRuntime.js","sourceSymbol":"purchaseOrderLocalOverridesMemory values","line":"858-875","ownerBasis":"value.shopId/shop_id","disposition":"catalog current","catalogRequired":true},{"id":"logical:renderer-cross-border-settings-account-slice","group":"C","category":"memory logical slice","sourceFile":"G:\\桌面端\\frontend\\src\\shared\\ozon\\crossBorderAuthorization.js","sourceSymbol":"cross-border account owner shape","line":"10-20","ownerBasis":"crossBorderAccountId/accountId","disposition":"catalog current","catalogRequired":true},{"id":"memory:local-api-products-hot-cache","group":"C","category":"cache","sourceFile":"G:\\桌面端\\local-api\\src\\domain\\products\\productsService.js","sourceSymbol":"productHotCache","line":"131-157,525-590","ownerBasis":"shopId 被哈希；set 未写 tag","disposition":"unknown prohibited","catalogRequired":true},{"id":"runtime:local-api-performance-request-queue","group":"C","category":"promise queue","sourceFile":"G:\\桌面端\\local-api\\src\\integrations\\performanceApiClient.js","sourceSymbol":"performanceQueueState.tail","line":"11-22,393-437","ownerBasis":"task 闭包未暴露 accountId","disposition":"unknown prohibited","catalogRequired":true},{"id":"runtime:local-api-ozon-client-endpoint-limiter","group":"C","category":"Map/timer","sourceFile":"G:\\桌面端\\local-api\\src\\ozon\\ozonClient.js","sourceSymbol":"createEndpointLimiter.nextAllowedAt","line":"114-151","ownerBasis":"endpoint key，无 shop","disposition":"preserve system","catalogRequired":true},{"id":"logical:local-api-rate-limit-shop-state","group":"C","category":"Map logical slice","sourceFile":"G:\\桌面端\\local-api\\src\\ozon\\rateLimitState.js","sourceSymbol":"stateKey/nextAllowedAt","line":"9-10,194-201","ownerBasis":"key 首段精确 `shopId`","disposition":"catalog current","catalogRequired":true},{"id":"logical:local-api-traffic-controller-shop-state","group":"C","category":"Map logical slice","sourceFile":"G:\\桌面端\\local-api\\src\\ozon\\trafficController.js","sourceSymbol":"shop:${shopId}:${profile}","line":"125-150,221-239","ownerBasis":"显式 shop scope key","disposition":"catalog current","catalogRequired":true},{"id":"filesystem:desktop-local-data-root","group":"C","category":"directory","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\dataLayout.js","sourceSymbol":"localDataRoot","line":"27","ownerBasis":"多 JSON 域混合","disposition":"unknown prohibited","catalogRequired":true},{"id":"filesystem:desktop-runtime-directory","group":"C","category":"directory","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\dataLayout.js","sourceSymbol":"runtimeDirectory","line":"29","ownerBasis":"profile runtime","disposition":"preserve system","catalogRequired":true},{"id":"filesystem:legacy-local-api-secret-key","group":"C","category":"secret file","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\dataLayout.js","sourceSymbol":"legacySecretPath","line":"36-38","ownerBasis":"profile 全局密钥","disposition":"preserve system","catalogRequired":true},{"id":"filesystem:desktop-local-api-sqlite-sidecars","group":"C","category":"SQLite WAL/SHM","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\recoveryDatabaseActivator.js","sourceSymbol":"database family sidecars","line":"14-16","ownerBasis":"profile database family; shared system state","disposition":"preserve system","catalogRequired":true},{"id":"runtime:desktop-license-runtime-promises","group":"C","category":"promises","sourceFile":"G:\\桌面端\\desktop\\src\\licensing\\licenseRuntime.js","sourceSymbol":"license runtime load/refresh/operation promises","line":"126-128,154-184,256-275","ownerBasis":"安装/license 级","disposition":"preserve system","catalogRequired":true},{"id":"runtime:desktop-recovery-staged-descriptors","group":"C","category":"Map","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\recoveryIpcBridge.js","sourceSymbol":"stagedRecoveries","line":"14-35","ownerBasis":"descriptor 可含 profile、多 shops","disposition":"unknown prohibited","catalogRequired":true},{"id":"filesystem:recovery-rollback-root","group":"C","category":"directory/SQLite","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\recoveryDatabaseActivator.js","sourceSymbol":"rollbackDirectory","line":"63-90","ownerBasis":"完整旧数据库副本","disposition":"unknown prohibited","catalogRequired":true},{"id":"filesystem:recovery-failed-root","group":"C","category":"directory/SQLite","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\recoveryDatabaseActivator.js","sourceSymbol":"failedDirectory","line":"72-104","ownerBasis":"完整失败数据库副本","disposition":"unknown prohibited","catalogRequired":true},{"id":"runtime:desktop-profile-lock-handle","group":"C","category":"lock handle","sourceFile":"G:\\桌面端\\desktop\\src\\main.js","sourceSymbol":"profileLock","line":"107,120-127","ownerBasis":"profile-global active handle","disposition":"preserve system","catalogRequired":true},{"id":"memory:external-chrome-content-snapshots","group":"C","category":"Map/memory","sourceFile":"G:\\桌面端\\frontend\\purchase-capture-extension\\content.js","sourceSymbol":"bridgeContext/pageSnapshot/locked*/frameSnapshots","line":"19-33,701-730","ownerBasis":"无 purchaseAccountId","disposition":"unknown prohibited","catalogRequired":true},{"id":"runtime:external-chrome-content-pollers","group":"C","category":"timers","sourceFile":"G:\\桌面端\\frontend\\purchase-capture-extension\\content.js","sourceSymbol":"postFrameSnapshot/refreshAll intervals","line":"719-722,1661-1664","ownerBasis":"tab/frame runtime","disposition":"preserve system","catalogRequired":true},{"id":"memory:external-chrome-popup-snapshots","group":"C","category":"memory","sourceFile":"G:\\桌面端\\frontend\\purchase-capture-extension\\popup.js","sourceSymbol":"bridgeContext/locked*Snapshot","line":"21-24","ownerBasis":"无 purchaseAccountId","disposition":"unknown prohibited","catalogRequired":true},{"id":"memory:static:frontend-src-api-local-api-client:order-sync-final-statuses","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\api\\localApiClient.js","sourceSymbol":"ORDER_SYNC_FINAL_STATUSES","line":"837","ownerBasis":"状态 enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-api-local-api-client:order-sync-failed-statuses","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\api\\localApiClient.js","sourceSymbol":"ORDER_SYNC_FAILED_STATUSES","line":"847","ownerBasis":"状态 enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-entities-marketing-marketing-order-fields:ozon-cancel-reason-translations","group":"D","category":"Map","sourceFile":"G:\\桌面端\\frontend\\src\\entities\\marketing\\marketingOrderFields.jsx","sourceSymbol":"OZON_CANCEL_REASON_TRANSLATIONS","line":"612","ownerBasis":"翻译表","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-entities-order-order-shop-scope:legacy-marketing-snapshot-fields","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\entities\\order\\orderShopScope.jsx","sourceSymbol":"LEGACY_MARKETING_SNAPSHOT_FIELDS","line":"433","ownerBasis":"字段 allowlist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-entities-order-order-shop-scope:legacy-marketing-activity-fields","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\entities\\order\\orderShopScope.jsx","sourceSymbol":"LEGACY_MARKETING_ACTIVITY_FIELDS","line":"443","ownerBasis":"字段 allowlist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-entities-order-order-shop-scope:legacy-marketing-product-fields","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\entities\\order\\orderShopScope.jsx","sourceSymbol":"LEGACY_MARKETING_PRODUCT_FIELDS","line":"444","ownerBasis":"字段 allowlist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-entities-order-order-shop-scope:legacy-marketing-summary-fields","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\entities\\order\\orderShopScope.jsx","sourceSymbol":"LEGACY_MARKETING_SUMMARY_FIELDS","line":"445","ownerBasis":"字段 allowlist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-entities-order-order-shop-scope:legacy-marketing-source-type-aliases","group":"D","category":"Map","sourceFile":"G:\\桌面端\\frontend\\src\\entities\\order\\orderShopScope.jsx","sourceSymbol":"LEGACY_MARKETING_SOURCE_TYPE_ALIASES","line":"589","ownerBasis":"alias 表","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-entities-order-order-shop-scope:legacy-marketing-product-status-aliases","group":"D","category":"Map","sourceFile":"G:\\桌面端\\frontend\\src\\entities\\order\\orderShopScope.jsx","sourceSymbol":"LEGACY_MARKETING_PRODUCT_STATUS_ALIASES","line":"612","ownerBasis":"alias 表","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-entities-product-product-attributes:product-attribute-id-name-map","group":"D","category":"Map","sourceFile":"G:\\桌面端\\frontend\\src\\entities\\product\\productAttributes.jsx","sourceSymbol":"productAttributeIdNameMap","line":"323","ownerBasis":"属性定义表","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-entities-product-product-attributes:product-attribute-value-map","group":"D","category":"Map","sourceFile":"G:\\桌面端\\frontend\\src\\entities\\product\\productAttributes.jsx","sourceSymbol":"productAttributeValueMap","line":"355","ownerBasis":"属性定义表","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-features-customer-consultation-lib-customer-consultation-formatter:customer-notification-domains","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\features\\customerConsultation\\lib\\customerConsultationFormatter.js","sourceSymbol":"CUSTOMER_NOTIFICATION_DOMAINS","line":"7","ownerBasis":"domain enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-features-licensing-services-license-center-client:entitlement-rejection-statuses","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\features\\licensing\\services\\licenseCenterClient.js","sourceSymbol":"entitlementRejectionStatuses","line":"10","ownerBasis":"HTTP 状态 enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-features-orders-sales-model-use-sales-order-paged-cache-state:final-sync-statuses","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\features\\orders\\sales\\model\\useSalesOrderPagedCacheState.jsx","sourceSymbol":"FINAL_SYNC_STATUSES","line":"5","ownerBasis":"状态 enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-features-orders-sales-model-use-sales-order-paged-cache-state:failed-sync-statuses","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\features\\orders\\sales\\model\\useSalesOrderPagedCacheState.jsx","sourceSymbol":"FAILED_SYNC_STATUSES","line":"6","ownerBasis":"状态 enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-features-products-lib-product-bus-material-sync:product-bus-material-write-failed-statuses","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\features\\products\\lib\\productBusMaterialSync.js","sourceSymbol":"PRODUCT_BUS_MATERIAL_WRITE_FAILED_STATUSES","line":"15","ownerBasis":"状态 enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-features-products-model-use-product-batch-state:product-batch-write-failed-statuses","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\features\\products\\model\\useProductBatchState.jsx","sourceSymbol":"PRODUCT_BATCH_WRITE_FAILED_STATUSES","line":"43","ownerBasis":"状态 enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-features-products-model-use-product-sync-state:product-refresh-final-statuses","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\features\\products\\model\\useProductSyncState.jsx","sourceSymbol":"PRODUCT_REFRESH_FINAL_STATUSES","line":"55","ownerBasis":"状态 enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-features-products-model-use-product-write-state:product-archive-write-failed-statuses","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\features\\products\\model\\useProductWriteState.jsx","sourceSymbol":"PRODUCT_ARCHIVE_WRITE_FAILED_STATUSES","line":"45","ownerBasis":"状态 enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-features-products-model-use-product-write-state:product-archive-write-success-statuses","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\features\\products\\model\\useProductWriteState.jsx","sourceSymbol":"PRODUCT_ARCHIVE_WRITE_SUCCESS_STATUSES","line":"53","ownerBasis":"状态 enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-after-sales-classification:missing-text-values","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\services\\afterSalesClassification.js","sourceSymbol":"MISSING_TEXT_VALUES","line":"22","ownerBasis":"placeholder enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-after-sales-reason-translate:after-sales-reason-translations","group":"D","category":"Map","sourceFile":"G:\\桌面端\\frontend\\src\\services\\afterSalesReasonTranslate.js","sourceSymbol":"AFTER_SALES_REASON_TRANSLATIONS","line":"26","ownerBasis":"翻译表","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-after-sales-reason-translate:after-sales-logistics-translations","group":"D","category":"Map","sourceFile":"G:\\桌面端\\frontend\\src\\services\\afterSalesReasonTranslate.js","sourceSymbol":"AFTER_SALES_LOGISTICS_TRANSLATIONS","line":"89","ownerBasis":"翻译表","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-browser-legacy-read-store:legacy-browser-audit-keys","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\services\\browserLegacyReadStore.js","sourceSymbol":"LEGACY_BROWSER_AUDIT_KEYS","line":"4","ownerBasis":"key allowlist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-external-interface-registry:interface-registry","group":"D","category":"Map","sourceFile":"G:\\桌面端\\frontend\\src\\services\\externalInterfaceRegistry.js","sourceSymbol":"INTERFACE_REGISTRY","line":"44","ownerBasis":"interface registry","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-local-data-domain-catalog:domain-by-id","group":"D","category":"Map","sourceFile":"G:\\桌面端\\frontend\\src\\services\\localDataDomainCatalog.js","sourceSymbol":"DOMAIN_BY_ID","line":"200","ownerBasis":"domain registry","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-local-data-domain-catalog:entity-owner-by-type","group":"D","category":"Map","sourceFile":"G:\\桌面端\\frontend\\src\\services\\localDataDomainCatalog.js","sourceSymbol":"ENTITY_OWNER_BY_TYPE","line":"201","ownerBasis":"owner type registry","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-manual-data-protection:protected-manual-data-field-set","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\services\\manualDataProtection.js","sourceSymbol":"PROTECTED_MANUAL_DATA_FIELD_SET","line":"34","ownerBasis":"字段 allowlist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-order-exchange-rate-rules:placeholder-values","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\services\\orderExchangeRateRules.js","sourceSymbol":"PLACEHOLDER_VALUES","line":"3","ownerBasis":"placeholder enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-order-time-sort-rules:not-returned-text","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\services\\orderTimeSortRules.js","sourceSymbol":"NOT_RETURNED_TEXT","line":"2","ownerBasis":"placeholder enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-ozon-after-sales-cache-merge-policy:missing-text-values","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\services\\ozonAfterSalesCacheMergePolicy.js","sourceSymbol":"MISSING_TEXT_VALUES","line":"1","ownerBasis":"placeholder enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-ozon-local-data-layer-shared:omit-order-fields","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\services\\ozonLocalDataLayerShared.js","sourceSymbol":"OMIT_ORDER_FIELDS","line":"37","ownerBasis":"字段 denylist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-ozon-local-data-layer-shared:omit-product-fields","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\services\\ozonLocalDataLayerShared.js","sourceSymbol":"OMIT_PRODUCT_FIELDS","line":"39","ownerBasis":"字段 denylist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-ozon-local-data-layer-shared:product-image-payload-field-keys","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\services\\ozonLocalDataLayerShared.js","sourceSymbol":"PRODUCT_IMAGE_PAYLOAD_FIELD_KEYS","line":"111","ownerBasis":"字段 allowlist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-ozon-local-data-layer-shared:missing-text-values","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\services\\ozonLocalDataLayerShared.js","sourceSymbol":"MISSING_TEXT_VALUES","line":"134","ownerBasis":"placeholder enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-ozon-local-data-layer-shared:after-sales-clearable-classification-fields","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\services\\ozonLocalDataLayerShared.js","sourceSymbol":"AFTER_SALES_CLEARABLE_CLASSIFICATION_FIELDS","line":"136","ownerBasis":"字段 allowlist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-ozon-order-experience:product-picture-lookup-sources","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\services\\ozonOrderExperience.js","sourceSymbol":"PRODUCT_PICTURE_LOOKUP_SOURCES","line":"7","ownerBasis":"source enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-ozon-order-experience:after-sales-classification-values","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\services\\ozonOrderExperience.js","sourceSymbol":"AFTER_SALES_CLASSIFICATION_VALUES","line":"106","ownerBasis":"状态 enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-ozon-order-experience:after-sales-reason-field-keys","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\services\\ozonOrderExperience.js","sourceSymbol":"AFTER_SALES_REASON_FIELD_KEYS","line":"113","ownerBasis":"字段 allowlist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-ozon-order-experience:ozon-after-sales-reason-translations","group":"D","category":"Map","sourceFile":"G:\\桌面端\\frontend\\src\\services\\ozonOrderExperience.js","sourceSymbol":"OZON_AFTER_SALES_REASON_TRANSLATIONS","line":"168","ownerBasis":"翻译表","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-ozon-order-experience:ozon-after-sales-reason-id-translations","group":"D","category":"Map","sourceFile":"G:\\桌面端\\frontend\\src\\services\\ozonOrderExperience.js","sourceSymbol":"OZON_AFTER_SALES_REASON_ID_TRANSLATIONS","line":"256","ownerBasis":"翻译表","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-product-material-profile-store:material-profile-transient-fields","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\services\\productMaterialProfileStore.js","sourceSymbol":"MATERIAL_PROFILE_TRANSIENT_FIELDS","line":"227","ownerBasis":"字段集合","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-product-material-profile-store:material-profile-known-legacy-fields","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\services\\productMaterialProfileStore.js","sourceSymbol":"MATERIAL_PROFILE_KNOWN_LEGACY_FIELDS","line":"228","ownerBasis":"字段集合","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-profit-finance-matching:placeholder-values","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\services\\profitFinanceMatching.js","sourceSymbol":"PLACEHOLDER_VALUES","line":"1","ownerBasis":"placeholder enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-profit-ledger-service:placeholder-values","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\services\\profitLedgerService.js","sourceSymbol":"PLACEHOLDER_VALUES","line":"18","ownerBasis":"placeholder enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-profit-ledger-service:profit-ledger-hash-volatile-keys","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\services\\profitLedgerService.js","sourceSymbol":"PROFIT_LEDGER_HASH_VOLATILE_KEYS","line":"1151","ownerBasis":"字段 denylist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-profit-penalty-attribution:placeholder-values","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\services\\profitPenaltyAttribution.js","sourceSymbol":"PLACEHOLDER_VALUES","line":"3","ownerBasis":"placeholder enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-profit-rating-penalty:placeholder-values","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\services\\profitRatingPenalty.js","sourceSymbol":"PLACEHOLDER_VALUES","line":"92","ownerBasis":"placeholder enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-purchase-info-support:empty-purchase-info-values","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\services\\purchaseInfoSupport.js","sourceSymbol":"EMPTY_PURCHASE_INFO_VALUES","line":"5","ownerBasis":"placeholder enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-purchase-order-detail-url:empty-text-values","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\services\\purchaseOrderDetailUrl.js","sourceSymbol":"EMPTY_TEXT_VALUES","line":"8","ownerBasis":"placeholder enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-purchase-order-runtime:purchase-empty-order-no-values","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\services\\purchaseOrderRuntime.js","sourceSymbol":"PURCHASE_EMPTY_ORDER_NO_VALUES","line":"585","ownerBasis":"placeholder enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-purchase-order-runtime:purchase-empty-platform-values","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\services\\purchaseOrderRuntime.js","sourceSymbol":"PURCHASE_EMPTY_PLATFORM_VALUES","line":"587","ownerBasis":"placeholder enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-purchase-order-runtime:purchase-empty-price-values","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\services\\purchaseOrderRuntime.js","sourceSymbol":"PURCHASE_EMPTY_PRICE_VALUES","line":"589","ownerBasis":"placeholder enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-purchase-order-runtime:purchase-override-protected-fields","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\services\\purchaseOrderRuntime.js","sourceSymbol":"PURCHASE_OVERRIDE_PROTECTED_FIELDS","line":"706","ownerBasis":"字段保护表","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-purchase-plugin-context-store:purchase-plugin-context-fields","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\services\\purchasePluginContextStore.js","sourceSymbol":"PURCHASE_PLUGIN_CONTEXT_FIELDS","line":"38","ownerBasis":"字段 allowlist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-services-purchase-plugin-context-store:purchase-plugin-context-envelope-fields","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\services\\purchasePluginContextStore.js","sourceSymbol":"PURCHASE_PLUGIN_CONTEXT_ENVELOPE_FIELDS","line":"39","ownerBasis":"字段 allowlist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-shared-config-app-config-core:purchase-direct-image-search-platforms","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\shared\\config\\appConfigCore.jsx","sourceSymbol":"PURCHASE_DIRECT_IMAGE_SEARCH_PLATFORMS","line":"530","ownerBasis":"platform enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-src-shared-config-app-config-core:cross-border-legacy-empty-text","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\src\\shared\\config\\appConfigCore.jsx","sourceSymbol":"CROSS_BORDER_LEGACY_EMPTY_TEXT","line":"532","ownerBasis":"placeholder enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-backup-recovery-exporter:optional-excluded-columns","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\backup\\recoveryExporter.js","sourceSymbol":"OPTIONAL_EXCLUDED_COLUMNS","line":"5","ownerBasis":"schema metadata","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-backup-recovery-importer:marketing-source-type-aliases","group":"D","category":"Map","sourceFile":"G:\\桌面端\\local-api\\src\\backup\\recoveryImporter.js","sourceSymbol":"MARKETING_SOURCE_TYPE_ALIASES","line":"51","ownerBasis":"alias 表","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-backup-recovery-reconcile-state:final-job-statuses","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\backup\\recoveryReconcileState.js","sourceSymbol":"FINAL_JOB_STATUSES","line":"2","ownerBasis":"状态 enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-backup-recovery-reconcile-state:success-job-statuses","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\backup\\recoveryReconcileState.js","sourceSymbol":"SUCCESS_JOB_STATUSES","line":"3","ownerBasis":"状态 enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-cache-catalog-catalog-cache-keys:valid-catalog-types","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\cache\\catalog\\catalogCacheKeys.js","sourceSymbol":"VALID_CATALOG_TYPES","line":"3","ownerBasis":"enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-cache-catalog-catalog-cache-keys:valid-scopes","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\cache\\catalog\\catalogCacheKeys.js","sourceSymbol":"VALID_SCOPES","line":"4","ownerBasis":"enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-data-data-domain-registry:valid-scope-types","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"VALID_SCOPE_TYPES","line":"1","ownerBasis":"schema enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-data-data-domain-registry:valid-data-classes","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"VALID_DATA_CLASSES","line":"2","ownerBasis":"schema enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-data-data-domain-registry:valid-backup-dispositions","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"VALID_BACKUP_DISPOSITIONS","line":"3","ownerBasis":"schema enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-data-data-domain-registry:by-domain","group":"D","category":"Map","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"BY_DOMAIN","line":"169","ownerBasis":"registry index","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-data-data-domain-registry:by-table","group":"D","category":"Map","sourceFile":"G:\\桌面端\\local-api\\src\\data\\dataDomainRegistry.js","sourceSymbol":"BY_TABLE","line":"170","ownerBasis":"registry index","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-db-repositories-cross-border-account-repository:valid-statuses","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\db\\repositories\\crossBorderAccountRepository.js","sourceSymbol":"VALID_STATUSES","line":"5","ownerBasis":"状态 enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-db-repositories-marketing-repository:legacy-marketing-activity-fields","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\db\\repositories\\marketingRepository.js","sourceSymbol":"LEGACY_MARKETING_ACTIVITY_FIELDS","line":"61","ownerBasis":"字段 allowlist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-db-repositories-marketing-repository:legacy-marketing-product-fields","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\db\\repositories\\marketingRepository.js","sourceSymbol":"LEGACY_MARKETING_PRODUCT_FIELDS","line":"77","ownerBasis":"字段 allowlist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-db-repositories-marketing-repository:legacy-marketing-summary-fields","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\db\\repositories\\marketingRepository.js","sourceSymbol":"LEGACY_MARKETING_SUMMARY_FIELDS","line":"92","ownerBasis":"字段 allowlist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-db-repositories-marketing-repository:legacy-marketing-snapshot-fields","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\db\\repositories\\marketingRepository.js","sourceSymbol":"LEGACY_MARKETING_SNAPSHOT_FIELDS","line":"98","ownerBasis":"字段 allowlist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-db-repositories-marketing-repository:legacy-marketing-source-type-aliases","group":"D","category":"Map","sourceFile":"G:\\桌面端\\local-api\\src\\db\\repositories\\marketingRepository.js","sourceSymbol":"LEGACY_MARKETING_SOURCE_TYPE_ALIASES","line":"108","ownerBasis":"alias 表","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-db-repositories-marketing-repository:marketing-view-state-fields","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\db\\repositories\\marketingRepository.js","sourceSymbol":"MARKETING_VIEW_STATE_FIELDS","line":"704","ownerBasis":"字段 allowlist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-db-repositories-performance-account-repository:valid-statuses","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\db\\repositories\\performanceAccountRepository.js","sourceSymbol":"VALID_STATUSES","line":"5","ownerBasis":"状态 enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-db-repositories-product-repository:strong-product-visibilities","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\db\\repositories\\productRepository.js","sourceSymbol":"STRONG_PRODUCT_VISIBILITIES","line":"75","ownerBasis":"状态 enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-db-repositories-product-repository:weak-inferred-product-visibilities","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\db\\repositories\\productRepository.js","sourceSymbol":"WEAK_INFERRED_PRODUCT_VISIBILITIES","line":"81","ownerBasis":"状态 enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-db-repositories-product-repository:sellable-product-visibilities","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\db\\repositories\\productRepository.js","sourceSymbol":"SELLABLE_PRODUCT_VISIBILITIES","line":"82","ownerBasis":"状态 enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-db-repositories-product-repository:legacy-product-material-fields","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\db\\repositories\\productRepository.js","sourceSymbol":"LEGACY_PRODUCT_MATERIAL_FIELDS","line":"1645","ownerBasis":"字段 allowlist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-db-repositories-profile-asset-repository:allowed-mime-types","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\db\\repositories\\profileAssetRepository.js","sourceSymbol":"ALLOWED_MIME_TYPES","line":"4","ownerBasis":"MIME allowlist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-db-repositories-profile-settings-repository:profile-setting-namespace-set","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\db\\repositories\\profileSettingsRepository.js","sourceSymbol":"PROFILE_SETTING_NAMESPACE_SET","line":"10","ownerBasis":"namespace registry","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-db-repositories-profile-settings-repository:purchase-plugin-context-top-level-keys","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\db\\repositories\\profileSettingsRepository.js","sourceSymbol":"PURCHASE_PLUGIN_CONTEXT_TOP_LEVEL_KEYS","line":"31","ownerBasis":"字段 allowlist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-db-repositories-shop-repository:valid-statuses","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\db\\repositories\\shopRepository.js","sourceSymbol":"VALID_STATUSES","line":"7","ownerBasis":"状态 enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-db-repositories-shop-repository:legacy-ozon-shop-input-fields","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\db\\repositories\\shopRepository.js","sourceSymbol":"LEGACY_OZON_SHOP_INPUT_FIELDS","line":"9","ownerBasis":"字段 allowlist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-db-repositories-shop-repository:legacy-ozon-shop-preference-forbidden-fields","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\db\\repositories\\shopRepository.js","sourceSymbol":"LEGACY_OZON_SHOP_PREFERENCE_FORBIDDEN_FIELDS","line":"10","ownerBasis":"字段 denylist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-domain-customer-service-customer-service-service:customer-service-read-endpoints","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\domain\\customerService\\customerServiceService.js","sourceSymbol":"CUSTOMER_SERVICE_READ_ENDPOINTS","line":"1","ownerBasis":"endpoint allowlist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-domain-orders-orders-query-rules:sales-order-status-scopes","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\domain\\orders\\ordersQueryRules.js","sourceSymbol":"SALES_ORDER_STATUS_SCOPES","line":"1","ownerBasis":"状态 enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-domain-products-products-service:product-hydration-modes","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\domain\\products\\productsService.js","sourceSymbol":"PRODUCT_HYDRATION_MODES","line":"36","ownerBasis":"mode enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-domain-purchase-purchase-service:empty-purchase-value","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\domain\\purchase\\purchaseService.js","sourceSymbol":"EMPTY_PURCHASE_VALUE","line":"5","ownerBasis":"placeholder enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-maintenance-shop-scope-repair-preview:user-owned-classes","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\maintenance\\shopScopeRepairPreview.js","sourceSymbol":"USER_OWNED_CLASSES","line":"4","ownerBasis":"class enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-ozon-ozon-client:default-retry-status","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\ozon\\ozonClient.js","sourceSymbol":"DEFAULT_RETRY_STATUS","line":"6","ownerBasis":"HTTP 状态 enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-ozon-ozon-endpoint-registry:read-only-risks","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\ozon\\ozonEndpointRegistry.js","sourceSymbol":"READ_ONLY_RISKS","line":"1","ownerBasis":"risk enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-ozon-ozon-endpoint-registry:write-risks","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\ozon\\ozonEndpointRegistry.js","sourceSymbol":"WRITE_RISKS","line":"2","ownerBasis":"risk enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-ozon-request-queue:known-profiles","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\ozon\\requestQueue.js","sourceSymbol":"KNOWN_PROFILES","line":"3","ownerBasis":"queue profile enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-ozon-retry-controller:default-retryable-status","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\ozon\\retryController.js","sourceSymbol":"DEFAULT_RETRYABLE_STATUS","line":"1","ownerBasis":"HTTP 状态 enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-ozon-traffic-controller:known-profiles","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\ozon\\trafficController.js","sourceSymbol":"KNOWN_PROFILES","line":"37","ownerBasis":"traffic profile enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:local-api-src-sync-sync-job-service:valid-statuses","group":"D","category":"Set","sourceFile":"G:\\桌面端\\local-api\\src\\sync\\syncJobService.js","sourceSymbol":"VALID_STATUSES","line":"15","ownerBasis":"状态 enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:desktop-src-licensing-license-config:modes","group":"D","category":"Set","sourceFile":"G:\\桌面端\\desktop\\src\\licensing\\licenseConfig.js","sourceSymbol":"MODES","line":"6","ownerBasis":"license mode enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:desktop-src-licensing-license-config:loopback-hosts","group":"D","category":"Set","sourceFile":"G:\\桌面端\\desktop\\src\\licensing\\licenseConfig.js","sourceSymbol":"LOOPBACK_HOSTS","line":"7","ownerBasis":"host allowlist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:desktop-src-licensing-license-runtime:allowed-methods","group":"D","category":"Set","sourceFile":"G:\\桌面端\\desktop\\src\\licensing\\licenseRuntime.js","sourceSymbol":"ALLOWED_METHODS","line":"13","ownerBasis":"method allowlist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:desktop-src-licensing-license-runtime:entitlement-rejection-statuses","group":"D","category":"Set","sourceFile":"G:\\桌面端\\desktop\\src\\licensing\\licenseRuntime.js","sourceSymbol":"ENTITLEMENT_REJECTION_STATUSES","line":"15","ownerBasis":"HTTP 状态 enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:desktop-src-licensing-license-session-store:retryable-rename-codes","group":"D","category":"Set","sourceFile":"G:\\桌面端\\desktop\\src\\licensing\\licenseSessionStore.js","sourceSymbol":"RETRYABLE_RENAME_CODES","line":"6","ownerBasis":"filesystem error enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:desktop-src-runtime-legacy-retirement-fault:write-methods","group":"D","category":"Set","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\legacyRetirementFault.js","sourceSymbol":"WRITE_METHODS","line":"1","ownerBasis":"method enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:desktop-src-runtime-legacy-retirement-fault:supported-modes","group":"D","category":"Set","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\legacyRetirementFault.js","sourceSymbol":"SUPPORTED_MODES","line":"2","ownerBasis":"mode enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:desktop-src-runtime-local-api-proxy:allowed-methods","group":"D","category":"Set","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\localApiProxy.js","sourceSymbol":"ALLOWED_METHODS","line":"1","ownerBasis":"method allowlist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:desktop-src-runtime-local-api-proxy:allowed-headers","group":"D","category":"Set","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\localApiProxy.js","sourceSymbol":"ALLOWED_HEADERS","line":"2","ownerBasis":"header allowlist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:desktop-src-runtime-local-api-proxy:legacy-import-post-paths","group":"D","category":"Set","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\localApiProxy.js","sourceSymbol":"LEGACY_IMPORT_POST_PATHS","line":"14","ownerBasis":"route allowlist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:desktop-src-runtime-local-api-proxy:domain-permissions","group":"D","category":"Map","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\localApiProxy.js","sourceSymbol":"DOMAIN_PERMISSIONS","line":"71","ownerBasis":"permission registry","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:desktop-src-runtime-purchase-bridge-proxy:allowed-requests","group":"D","category":"Map","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\purchaseBridgeProxy.js","sourceSymbol":"ALLOWED_REQUESTS","line":"1","ownerBasis":"request allowlist","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:desktop-src-runtime-purchase-bridge-state:modes","group":"D","category":"Set","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\purchaseBridgeState.js","sourceSymbol":"MODES","line":"5","ownerBasis":"mode enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:desktop-src-window-main-window:retired-legacy-retirement-fixture-ids","group":"D","category":"Set","sourceFile":"G:\\桌面端\\desktop\\src\\window\\mainWindow.js","sourceSymbol":"RETIRED_LEGACY_RETIREMENT_FIXTURE_IDS","line":"1592","ownerBasis":"fixture ID registry","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:desktop-src-window-main-window:legacy-retirement-marketing-file-source-phases","group":"D","category":"Set","sourceFile":"G:\\桌面端\\desktop\\src\\window\\mainWindow.js","sourceSymbol":"LEGACY_RETIREMENT_MARKETING_FILE_SOURCE_PHASES","line":"1665","ownerBasis":"phase enum","disposition":"preserve system","catalogRequired":false},{"id":"memory:static:frontend-scripts-purchase-bridge-config:purchase-extension-origins","group":"D","category":"Set","sourceFile":"G:\\桌面端\\frontend\\scripts\\purchase-bridge\\config.mjs","sourceSymbol":"PURCHASE_EXTENSION_ORIGINS","line":"10","ownerBasis":"origin allowlist","disposition":"preserve system","catalogRequired":false},{"id":"filesystem:desktop-recovery-shell-sqlite-file","group":"E","category":"filesystem/SQLite","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\desktopPaths.js","sourceSymbol":"recoveryShellDatabasePath","line":"136-148","ownerBasis":"system/profile recovery shell; stop shell and checkpoint; no business-owner deletion","disposition":"preserve system","catalogRequired":true},{"id":"filesystem:desktop-recovery-shell-sqlite-sidecars","group":"E","category":"filesystem/SQLite sidecars","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\desktopPaths.js","sourceSymbol":"recoveryShellDatabasePath + WAL/SHM family","line":"136-148; database.js 15-17","ownerBasis":"recovery-shell.sqlite-wal/-shm; profile system state","disposition":"preserve system","catalogRequired":true},{"id":"memory:desktop-local-api-auth-token","group":"E","category":"memory/capability","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\serviceRuntime.js","sourceSymbol":"authToken","line":"140-163,186-196","ownerBasis":"process capability shared by local-api requests; no business-owner anchor","disposition":"preserve system","catalogRequired":true},{"id":"runtime:desktop-service-local-api-runtime","group":"E","category":"runtime","sourceFile":"G:\\桌面端\\desktop\\src\\runtime\\serviceRuntime.js","sourceSymbol":"localApiRuntime","line":"101,108-196,279-316","ownerBasis":"profile/process system runtime containing DB path/token/port/recoveryMode","disposition":"preserve system","catalogRequired":true},{"id":"runtime:desktop-main-lifecycle-state","group":"E","category":"runtime","sourceFile":"G:\\桌面端\\desktop\\src\\main.js","sourceSymbol":"runtimeInfo/desktopLicenseRuntime/isQuitting/profileLock/shutdownPromise","line":"81-108,120-143,198-202","ownerBasis":"desktop lifecycle system state; fence bootstrap/restart/shutdown","disposition":"preserve system","catalogRequired":true},{"id":"runtime:local-api-server-lifecycle-state","group":"E","category":"runtime","sourceFile":"G:\\桌面端\\local-api\\src\\server.js","sourceSymbol":"db/server/shutdownRequested","line":"5-37,83-84","ownerBasis":"server/database handle shared across owners; drain/checkpoint only","disposition":"preserve system","catalogRequired":true},{"id":"runtime:renderer-purchase-plugin-bridge-runtime","group":"E","category":"runtime","sourceFile":"G:\\桌面端\\frontend\\src\\entities\\product\\productLocalMirror.jsx","sourceSymbol":"purchasePluginBridgeEnabledMemory/purchasePluginBridgeUnavailableUntil","line":"492-545","ownerBasis":"renderer-global; no purchaseAccountId anchor","disposition":"preserve system","catalogRequired":true},{"id":"memory:renderer-ozon-api-performance-counter","group":"E","category":"memory/counter","sourceFile":"G:\\桌面端\\frontend\\src\\shared\\config\\appConfigRuntime.jsx","sourceSymbol":"Ozon API performance counter","line":"440,464-466; ozonRuntime.jsx 188","ownerBasis":"global performance counter; no business-owner anchor","disposition":"preserve system","catalogRequired":true}],"resourceFindings":[{"id":"B1-RES-01","severity":"P0","path":"accountOwnershipCatalog.js","line":"current set","resourceIds":["filesystem:desktop-recovery-shell-sqlite-file","filesystem:desktop-recovery-shell-sqlite-sidecars","memory:desktop-local-api-auth-token","runtime:desktop-service-local-api-runtime","runtime:desktop-main-lifecycle-state","runtime:local-api-server-lifecycle-state","runtime:renderer-purchase-plugin-bridge-runtime","memory:renderer-ozon-api-performance-counter"],"required":"add all 8 as current, removable:false, preserve system with exact anchors; Required-Catalog becomes 0"},{"id":"B1-RES-02","severity":"P0","path":"accountOwnershipCatalog.js:1711-1723","resourceIds":["logical:local-data-product-material-profiles-shop-records","logical:local-data-purchase-order-overrides-shop-records","logical:local-data-product-source-links-shop-records","logical:local-data-sales-source-links-shop-records","logical:local-data-purchase-source-links-shop-records"],"current":"array selectors profiles[]/overrides[]/records[] do not match record-map payloads","required":"classify all 5 unknown prohibited, removable:false until record-map key/value selector grammar exists"},{"id":"B1-RES-03","severity":"P0","path":"accountOwnershipCatalog.js:1653-1669,1855-1862","resourceIds":["memory:local-api-products-hot-cache","runtime:local-api-ozon-client-endpoint-limiter","memory:renderer-product-material-profile-hashes"],"required":"match frozen dispositions in resource ledger; no owner guess"},{"id":"B1-ANCHOR-01","severity":"P1","path":"accountOwnershipCatalog.js sourceEvidence","resourceIds":["runtime:desktop-recovery-auto-backup-scheduler","filesystem:desktop-local-api-sqlite-sidecars","logical:renderer-cross-border-settings-account-slice","runtime:desktop-profile-lock-handle","runtime:renderer-legacy-browser-read-telemetry","memory:renderer-license-browser-tokens","runtime:renderer-legacy-browser-read-listeners","runtime:desktop-license-runtime-promises","filesystem:local-api-secret-key","memory:local-api-hot-cache-shop-tag","logical:profile-settings-purchase-plugin-context"],"required":"replace sourceEvidence with exact frozen sourceFile/sourceSymbol/line anchors"},{"id":"B1-DISCOVERY-01","severity":"P1","path":"accountOwnershipCatalog.test.js:982-1061","poc":"G:/__b0_virtual__/frontend/src/services/orphanOwnerRuntime.js => export const orphanOwnerWriteQueue = Promise.resolve();","required":"run discovery against real production roots; no manual 46 count; compare production evidence and Catalog both directions; key duplicate anchors by resource ID plus structured selector"},{"id":"B1-MIGRATION-01","severity":"P2","path":"inventory evidence","resourceIds":["registry:scheduler-trace-events","registry:request-attempts","registry:cache-merge-log","registry:error-events"],"required":"use frozen real migration paths/lines; Catalog DataDomainRegistry anchor may remain only if owner/schema evidence is also structured"}],"contractFindings":[{"id":"B2-CONTRACT-01","severity":"P2","path":"G:\\桌面端\\local-api\\src\\domain\\accountRemoval\\accountRemovalContract.js","symbols":"isPlainObject 24-28; createAccountRemovalPreviewDto 534-547; createAccountRemovalConfirmDto 715-810","poc":"const poison=new Proxy({},{getPrototypeOf(){throw new TypeError('prototype-poison')}}); createAccountRemovalPreviewDto(poison); createAccountRemovalConfirmDto(poison,{});","current":"native TypeError, code=null","expected":"AccountRemovalContractError / ACCOUNT_REMOVAL_PREVIEW_INVALID"},{"id":"B2-CONTRACT-02","severity":"P2","path":"G:\\桌面端\\local-api\\src\\domain\\accountRemoval\\accountRemovalContract.js:129-157,160-170,173-185,317-379,534-547,715-810","pocCases":[["confirm.contractVersion getter throws","ACCOUNT_REMOVAL_CONTRACT_VERSION_MISMATCH"],["confirm.requestedResourceIds getter throws","ACCOUNT_REMOVAL_REQUESTED_RESOURCES_INVALID"],["confirm.owner.ownerType getter throws","ACCOUNT_REMOVAL_OWNER_TYPE_INVALID"],["confirm.owner.ownerId getter throws","ACCOUNT_REMOVAL_OWNER_ID_INVALID"],["confirm.resourceObservations[0].resourceId getter throws","ACCOUNT_REMOVAL_RESOURCE_OBSERVATIONS_INVALID"],["trusted currentResourceObservations[0].resourceId getter throws","ACCOUNT_REMOVAL_RESOURCE_OBSERVATIONS_INVALID"],["preview-create owner.ownerId getter throws","ACCOUNT_REMOVAL_OWNER_ID_INVALID"],["preview-create resourceObservations[0].resourceId getter throws","ACCOUNT_REMOVAL_RESOURCE_OBSERVATIONS_INVALID"],["preview-validate version getter throws","ACCOUNT_REMOVAL_PREVIEW_INVALID"]],"current":"8 of 9 getter probes leak native TypeError; preview-validate version getter already returns ACCOUNT_REMOVAL_PREVIEW_INVALID","expected":"each exact stable code above; never native TypeError","symbols":"validatePreviewFingerprintShape 129-157; normalizeOwnerType 160-170; normalizeOwnerId 173-185; canonicalizeResourceObservations 317-379; createAccountRemovalPreviewDto 534-547; createAccountRemovalConfirmDto 715-810"},{"id":"B2-CONTRACT-03","severity":"P2","path":"G:\\桌面端\\local-api\\src\\domain\\accountRemoval\\accountRemovalContract.js:654-681,685-696,807-809","poc":"Object.defineProperty(idempotencyReference,'requestDigest',{get(){throw new TypeError('poison')}}); run validateAccountRemovalIdempotencyReuse and confirm reference path","current":"native TypeError in both paths","expected":"AccountRemovalContractError / ACCOUNT_REMOVAL_PREVIEW_CONTRACT_MISMATCH","symbols":"canonicalizeIdempotencyContract 654-681; validateAccountRemovalIdempotencyReuse 685-696; createAccountRemovalConfirmDto 807-809"},{"id":"B2-CATALOG-01","severity":"P2","path":"G:\\桌面端\\local-api\\src\\domain\\accountRemoval\\accountOwnershipCatalog.js:2201-2262; accountRemovalContract.js:255-278,416-441","poc":"structuredClone catalog; registry:shops.unexpectedContractField={executorAlias:'deleteEverything'}","current":"validator ok=true; catalog and preview fingerprint unchanged","expected":"direct validator rejects exact-key drift with ACCOUNT_OWNERSHIP_CATALOG_FIELDS_INCOMPLETE; planner returns ACCOUNT_REMOVAL_CATALOG_INVALID; invalid catalog never reaches fingerprint/plan"},{"id":"B2-QUIESCE-01","severity":"P0","path":"G:\\桌面端\\local-api\\src\\domain\\accountRemoval\\accountRemovalContract.js:283-288","resourceIds":["runtime:renderer-marketing-view-state-write-queue","runtime:renderer-product-material-profile-write-queue","runtime:renderer-product-source-link-migration","runtime:renderer-sales-source-link-migration","runtime:renderer-purchase-source-link-migration","runtime:renderer-ozon-shop-settings-write-queue","runtime:local-api-performance-request-queue"],"poc":"create shop preview; all seven currently planned=false,preserve=true and no quiesce/fence/drain collection","required":"pure Phase-B contract adds canonical quiesceResources/fenceResources/drainResources assertions with owner applicability, action, required readback; malformed => ACCOUNT_REMOVAL_PREVIEW_INVALID; tamper => ACCOUNT_REMOVAL_PREVIEW_CONTRACT_MISMATCH; no executor"}],"staticFindings":{"paths":{"contractTest":"G:\\桌面端\\local-api\\src\\domain\\accountRemoval\\accountRemovalContract.test.js:552-618","ownershipTest":"G:\\桌面端\\local-api\\src\\domain\\accountRemoval\\accountOwnershipCatalog.test.js:982-1061"},"roots":[["G:\\桌面端\\local-api\\src\\domain\\accountRemoval","5 .js"],["G:\\桌面端\\local-api\\src","210 .js"],["G:\\桌面端\\desktop\\src","45 .js + 1 .cjs"],["G:\\桌面端\\frontend\\src","308 .js + 263 .jsx"],["G:\\桌面端\\local-api\\scripts","6 .mjs"],["G:\\桌面端\\frontend\\scripts","14 .mjs"],["G:\\桌面端\\desktop\\scripts","14 .mjs"],["G:\\桌面端\\frontend\\purchase-capture-extension","3 .js + 1 .json"]],"metaIssues":[{"id":"B3-META-01","severity":"P1","line":"accountRemovalContract.test.js:553-579","current":"pattern-first assertion only requires each pattern hit some fixture","required":"fixture-first assertion: each of all 28 fixtures must hit its declared expectedGate; exact 28/28"},{"id":"B3-ROOT-01","severity":"P1","line":"accountRemovalContract.test.js:596-618","current":"seven narrow entries; six complete production roots absent","required":"scan all 8 frozen roots; each root independently exists and count>0; no other root may satisfy it"},{"id":"B3-OWN-01","severity":"P1","line":"accountOwnershipCatalog.test.js:982-1061","current":"discovery regex runs only against in-memory string; productionInventory is manual 46","required":"real production-root scanner and B0-OWN-F01 failure; no fixed quantity"}],"fixtureSummary":{"total":28,"captured":18,"missed":[{"id":"B0-OWN-F01","path":"G:/__b0_virtual__/frontend/src/services/orphanOwnerRuntime.js","code":"export const orphanOwnerWriteQueue = Promise.resolve();","expectedGate":"production ownership discovery","targeted":"node --test src/domain/accountRemoval/accountOwnershipCatalog.test.js"},{"id":"B0-SQL-F02","path":"virtual accountRemoval source","code":"const sqlText = [\"DELETE\", \"FROM shops WHERE id = ?\"].join(\" \");\\nexecuteSql(sqlText, ownerId);","expectedGate":"SQL executor alias","targeted":"node --test src/domain/accountRemoval/accountRemovalContract.test.js"},{"id":"B0-FS-F04","path":"G:/__b0_virtual__/shared/fileOps.js + accountRemoval/entry.js","code":"import { rm } from \"node:fs/promises\";\\nexport const eraseAccountPath = rm;\\n// second file\\nimport { eraseAccountPath } from \"../shared/fileOps.js\";\\nawait eraseAccountPath(targetPath);","expectedGate":"filesystem indirect alias","targeted":"node --test src/domain/accountRemoval/accountRemovalContract.test.js"},{"id":"B0-REPO-F03","path":"virtual accountRemoval source","code":"import { deletePurchaseAccount as purge } from \"../../db/repositories/purchaseAccountRepository.js\";\\nawait purge(ownerId);","expectedGate":"repository imported alias","targeted":"node --test src/domain/accountRemoval/accountRemovalContract.test.js"},{"id":"B0-REPO-F04","path":"virtual accountRemoval source","code":"const erase = purchaseAccountRepository.remove.bind(purchaseAccountRepository);\\nawait erase(ownerId);","expectedGate":"repository bound alias","targeted":"node --test src/domain/accountRemoval/accountRemovalContract.test.js"},{"id":"B0-REPO-F05","path":"virtual repository facade + accountRemoval entry","code":"export { deletePurchaseAccount as purgePurchaseAccount } from \"./purchaseAccountRepository.js\";\\n// second file\\nimport { purgePurchaseAccount as run } from \"../../db/repositories/accountPurgeFacade.js\";\\nawait run(ownerId);","expectedGate":"repository indirect export","targeted":"node --test src/domain/accountRemoval/accountRemovalContract.test.js"},{"id":"B0-ROUTE-F05","path":"virtual route source","code":"const methodName = [\"del\", \"ete\"].join(\"\");\\napp[methodName](\"/accounts/:id\", handler);","expectedGate":"computed route alias","targeted":"node --test src/domain/accountRemoval/accountRemovalContract.test.js"},{"id":"B0-NET-F01","path":"virtual accountRemoval source","code":"const send = fetch;\\nawait send(url, { method: \"DELETE\" });","expectedGate":"fetch alias","targeted":"node --test src/domain/accountRemoval/accountRemovalContract.test.js"},{"id":"B0-NET-F02","path":"virtual accountRemoval source","code":"import axiosClient from \"axios\";\\nawait axiosClient.delete(url);","expectedGate":"axios import alias","targeted":"node --test src/domain/accountRemoval/accountRemovalContract.test.js"},{"id":"B0-WIRE-F01","path":"G:/__b0_virtual__/frontend/src/services/removalFlow.js","code":"export {\\n  createAccountRemovalConfirmDto as createConfirm,\\n} from \"../../../local-api/src/domain/accountRemoval/accountRemovalContract.js\";","expectedGate":"domain-external accountRemoval wiring","targeted":"node --test src/domain/accountRemoval/accountRemovalContract.test.js"}],"passedIds":["B0-SQL-F01","B0-FS-F01","B0-FS-F02","B0-FS-F03","B0-SQLITE-F01","B0-SQLITE-F02","B0-SQLITE-F03","B0-REPO-F01","B0-REPO-F02","B0-ROUTE-F01","B0-ROUTE-F02","B0-ROUTE-F03","B0-ROUTE-F04","B0-NET-F03","B0-NET-F04","B0-IPC-F01","B0-IPC-F02","B0-IPC-F03"]},"targeted":["node --test src/domain/accountRemoval/accountOwnershipCatalog.test.js","node --test src/domain/accountRemoval/accountRemovalContract.test.js"]},"observedPassingEvidence":{"nodeCheck":"5/5","targeted":"21/21","localApiFull":"479/479","actualWiring":"0 executable accountRemoval route/UI/IPC/executor/network/file-delete outside domain","note":"green tests do not override frozen findings"}}<END_B0_LEDGER_JSON>

function readFrozenB0LedgerJson() {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const beginMarker = '<BEGIN_B0_LEDGER_JSON>';
  const endMarker = '<END_B0_LEDGER_JSON>';
  const begin = source.indexOf(beginMarker);
  const end = source.indexOf(endMarker, begin + beginMarker.length);
  assert.ok(begin >= 0 && end > begin, 'frozen B0 ledger markers must remain intact');
  return source.slice(begin + beginMarker.length, end);
}

const FROZEN_B0_ANCHOR_BASELINE_BY_ID = new Map(
  JSON.parse(readFrozenB0LedgerJson()).resources.map((resource) => [resource.id, resource]),
);

const FUTURE_PURCHASE_BROWSER_IDS = Object.freeze([
  'browser:purchase-profile-identity',
  'browser:purchase-persistent-partition',
  'browser:purchase-cookies',
  'browser:purchase-local-storage',
  'browser:purchase-indexed-db',
  'browser:purchase-cache-storage',
  'browser:purchase-http-cache',
  'browser:purchase-service-workers',
  'browser:purchase-proxy-auth',
  'browser:purchase-plugin-installation-state',
  'browser:purchase-extension-storage',
  'browser:purchase-downloads',
]);

function sorted(values) {
  return [...values].sort();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function getLocalDataFilesSourceBlock(source) {
  const start = source.indexOf('const LOCAL_DATA_FILES = {');
  const end = source.indexOf('const RETIRED_PURCHASE_PLUGIN_CONTEXT_FILE', start);
  assert.ok(start >= 0 && end > start, 'unable to locate LOCAL_DATA_FILES source block');
  return source.slice(start, end);
}

function getLocalDataFileSourceEntry(sourceBlock, key) {
  const marker = `  '${key}':`;
  const start = sourceBlock.indexOf(marker);
  assert.ok(start >= 0, `missing LOCAL_DATA_FILES entry: ${key}`);
  const tail = sourceBlock.slice(start);
  const nextEntry = tail.search(/\n  '[^']+':|\n\};/u);
  return tail.slice(0, nextEntry >= 0 ? nextEntry : tail.length);
}

function catalogEntry(id) {
  const entry = ACCOUNT_OWNERSHIP_CATALOG.find((item) => item.id === id);
  assert.ok(entry, `missing catalog entry: ${id}`);
  return entry;
}

function currentPhysicalTables() {
  const db = new DatabaseSync(':memory:');
  try {
    runMigrations(db);
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

test('account ownership catalog has stable ids, complete fields, and fail-closed unknowns', () => {
  const requiredFields = [
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
    'availability',
  ];
  const ids = new Set();

  assert.match(ACCOUNT_OWNERSHIP_CATALOG_VERSION, /^account-ownership-catalog-v\d+$/u);
  assert.doesNotThrow(() => validateAccountOwnershipCatalog());
  for (const entry of ACCOUNT_OWNERSHIP_CATALOG) {
    assert.equal(ids.has(entry.id), false, `duplicate catalog id: ${entry.id}`);
    ids.add(entry.id);
    for (const field of requiredFields) {
      assert.ok(entry[field], `${entry.id} is missing ${field}`);
    }
    assert.ok(entry.verifyQuery.type, `${entry.id} has no verify contract type`);
    assert.equal(typeof entry.coverageAudit, 'boolean', `${entry.id} must declare coverage-audit membership`);
    assert.match(entry.sourceEvidence.sourceFile, /^(?:frontend|local-api|desktop)\//u, `${entry.id} needs an auditable production source`);
    assert.ok(entry.sourceEvidence.sourceSymbol.length > 0, `${entry.id} needs a source symbol`);
    assert.ok(entry.sourceEvidence.ownerBasis.length > 0, `${entry.id} needs an ownership basis`);
    if (entry.ownerType === 'unknown' || entry.ownerType === 'system') {
      assert.equal(entry.removable, false, `${entry.id} must fail closed`);
    }
    if (entry.ownerType === 'unknown') {
      assert.match(entry.deletePrimitive, /^prohibited:/u, `${entry.id} must not claim a delete primitive`);
    }
    if (entry.availability === 'future-contract') {
      assert.equal(entry.removable, false, `${entry.id} must not be planned before its subsystem exists`);
    }
  }
});

test('catalog covers every fresh-migration SQLite table through DataDomainRegistry and rejects registry/migration drift', () => {
  const physicalTables = currentPhysicalTables();
  const registryPhysicalTables = DATA_DOMAIN_REGISTRY
    .map((policy) => policy.canonicalTable)
    .filter((table) => !table.startsWith('secret-vault:'))
    .sort();

  assert.deepEqual(physicalTables, registryPhysicalTables);
  // 表数量由真实迁移结果与 Registry 双向比对决定，不再写死某个数据库版本的数量。
  assert.equal(physicalTables.length, registryPhysicalTables.length);

  for (const policy of DATA_DOMAIN_REGISTRY) {
    const entry = catalogEntry(`registry:${policy.domain}`);
    assert.equal(entry.sourceRegistryDomain, policy.domain);
    if (!policy.canonicalTable.startsWith('secret-vault:')) {
      assert.ok(physicalTables.includes(policy.canonicalTable), `${policy.domain} maps to a non-physical SQLite resource`);
    }
  }
});

test('catalog distinguishes account types, row-level shop technical tables, profile/system preservation, and mixed scopes', () => {
  assert.equal(catalogEntry('registry:shops').ownerType, 'ozon_shop');
  assert.equal(catalogEntry('registry:cross-border-accounts').ownerType, 'cross_border_bus');
  assert.equal(catalogEntry('registry:performance-accounts').ownerType, 'promotion_account');
  assert.equal(catalogEntry('registry:purchase-accounts').ownerType, 'purchase_account');
  assert.equal(catalogEntry('registry:model-api-accounts').ownerType, 'model_api_account');

  for (const id of ['registry:profile-settings', 'registry:profile-assets', 'registry:schema-migrations']) {
    const entry = catalogEntry(id);
    assert.equal(entry.ownerType, 'system');
    assert.equal(entry.removable, false);
  }

  for (const table of [
    'ozon_request_attempts',
    'ozon_cache_merge_log',
    'ozon_error_events',
    'ozon_scheduler_trace_events',
  ]) {
    const entry = ACCOUNT_OWNERSHIP_CATALOG.find((item) => item.resource === table);
    assert.ok(entry, `missing row adapter for ${table}`);
    assert.equal(entry.ownerType, 'ozon_shop');
    assert.equal(entry.ownerField, 'sqlite-column:shop_id');
    assert.equal(entry.verifyQuery.ownerPredicate, 'shop_id = :ownerId');
    assert.match(entry.preserveRule, /NULL\/global/u);
  }

  const profitSnapshots = catalogEntry('registry:profit-ledger-snapshots');
  assert.equal(profitSnapshots.ownerType, 'system');
  assert.equal(profitSnapshots.removable, false);
  assert.equal(profitSnapshots.verifyQuery.type, 'preserve');

  const account = catalogEntry('registry:shops');
  const credentials = catalogEntry('registry:shop-credentials');
  assert.equal(account.executionGroup, 'shop-account-row');
  assert.equal(credentials.executionGroup, 'shop-account-row');
  assert.equal(account.deletePrimitive, credentials.deletePrimitive);
});

test('explicit local-data adapter covers each current desktop protocol file and keeps legacy JSON fail-closed', () => {
  const protocolPath = resolve(workspaceRoot, 'desktop/src/protocol/appProtocol.js');
  const source = readFileSync(protocolPath, 'utf8');
  const sourceBlock = getLocalDataFilesSourceBlock(source);
  const sourceKeys = [...sourceBlock.matchAll(/^\s*'([^']+)'\s*:/gmu)]
    .map((match) => match[1])
    .sort();
  const catalogKeys = ACCOUNT_OWNERSHIP_CATALOG
    .filter((entry) => entry.sourceProtocolKey)
    .map((entry) => entry.sourceProtocolKey)
    .sort();

  assert.deepEqual(catalogKeys, sourceKeys);
  for (const sourceProtocolKey of sourceKeys) {
    const entry = ACCOUNT_OWNERSHIP_CATALOG.find((item) => item.sourceProtocolKey === sourceProtocolKey);
    assert.equal(entry.ownerType, 'system');
    assert.equal(entry.removable, false);
    assert.match(entry.deletePrimitive, /^prohibited:/u);

    const sourceEntry = getLocalDataFileSourceEntry(sourceBlock, sourceProtocolKey);
    const directory = sourceEntry.match(/directory:\s*'([^']+)'/u)?.[1];
    const fileName = sourceEntry.match(/fileName:\s*'([^']+)'/u)?.[1];
    assert.ok(directory, `${sourceProtocolKey} must declare directory`);
    assert.ok(fileName, `${sourceProtocolKey} must declare fileName`);
    assert.equal(
      entry.resource,
      `desktop local-data/${directory}/${fileName}`,
      `${sourceProtocolKey} catalog path must match appProtocol directory/fileName`,
    );
    assert.equal(entry.directory, directory, `${sourceProtocolKey} directory must be structural catalog data`);
    assert.equal(entry.fileName, fileName, `${sourceProtocolKey} fileName must be structural catalog data`);
    assert.equal(entry.relativePath, `${directory}/${fileName}`, `${sourceProtocolKey} relativePath must be structural catalog data`);
    assert.match(sourceEntry, new RegExp(`directory:\\s*'${escapeRegExp(directory)}'`, 'u'));
    assert.match(sourceEntry, new RegExp(`fileName:\\s*'${escapeRegExp(fileName)}'`, 'u'));
  }

  for (const id of [
    'filesystem:retired-purchase-plugin-context',
    'filesystem:retired-marketing-activity-cache',
    'filesystem:legacy-classification-cache-root',
  ]) {
    const entry = catalogEntry(id);
    assert.equal(entry.ownerType, 'system');
    assert.equal(entry.removable, false);
  }
});

test('backup declarations preserve shared storage while exposing exact owner purge contracts', () => {
  const remoteBackupIds = [
    'backup:remote-recovery-generation-shared-profile',
    'backup:remote-recovery-generation-chunks-shared-profile',
    'backup:remote-recovery-generation-key-envelope-shared-profile',
  ];
  assert.deepEqual(
    sorted(ACCOUNT_OWNERSHIP_CATALOG.filter((entry) => entry.id.startsWith('backup:remote-recovery-generation-')).map((entry) => entry.id)),
    sorted(remoteBackupIds),
  );
  const remoteExecutionGroups = new Set();
  for (const id of remoteBackupIds) {
    const remote = catalogEntry(id);
    assert.equal(remote.ownerType, 'system');
    assert.equal(remote.removable, false);
    assert.match(remote.deletePrimitive, /^prohibited:/u);
    assert.equal(remote.verifyQuery.type, 'preserve');
    assert.ok(remote.preserveRule.length > 0);
    assert.ok(remote.risk.length > 0);
    remoteExecutionGroups.add(remote.executionGroup);
  }
  assert.deepEqual([...remoteExecutionGroups], ['recovery-remote-shared-generation']);

  const remoteOwnerEntries = ACCOUNT_OWNERSHIP_CATALOG
    .filter((entry) => entry.id.startsWith('backup:remote-recovery-owner-'));
  assert.deepEqual(sorted(remoteOwnerEntries.map((entry) => entry.ownerType)), sorted([
    'ozon_shop',
    'cross_border_bus',
    'promotion_account',
    'purchase_account',
    'model_api_account',
    'integration_profile',
  ]));
  for (const remoteOwner of remoteOwnerEntries) {
    assert.equal(remoteOwner.availability, 'current');
    assert.equal(remoteOwner.removable, true);
    assert.equal(remoteOwner.ownerField, 'resolver:recovery-owner-ref');
    assert.equal(remoteOwner.verifyQuery.type, 'remote-owner-absence');
    assert.equal(remoteOwner.verifyQuery.expected, 'tombstoned-and-absent');
    assert.equal(remoteOwner.executionGroup, 'recovery-remote-owner-purge');
  }
  const localProtectionEntries = ACCOUNT_OWNERSHIP_CATALOG
    .filter((entry) => entry.id.startsWith('filesystem:recovery-protection-owner-'));
  assert.deepEqual(sorted(localProtectionEntries.map((entry) => entry.ownerType)), sorted(remoteOwnerEntries.map((entry) => entry.ownerType)));
  for (const localProtection of localProtectionEntries) {
    assert.equal(localProtection.availability, 'current');
    assert.equal(localProtection.removable, true);
    assert.equal(localProtection.ownerField, 'resolver:recovery-protection-owner');
    assert.equal(localProtection.verifyQuery.type, 'protection-owner-absence');
    assert.equal(localProtection.verifyQuery.expected, 'absent-and-physically-erased');
    assert.equal(localProtection.executionGroup, 'recovery-local-protection-owner-purge');
  }
  const diagnosticLogEntries = ACCOUNT_OWNERSHIP_CATALOG
    .filter((entry) => entry.id.startsWith('filesystem:diagnostic-logs-owner-'));
  assert.deepEqual(sorted(diagnosticLogEntries.map((entry) => entry.ownerType)), sorted(remoteOwnerEntries.map((entry) => entry.ownerType)));
  for (const diagnosticLog of diagnosticLogEntries) {
    assert.equal(diagnosticLog.availability, 'current');
    assert.equal(diagnosticLog.removable, true);
    assert.equal(diagnosticLog.ownerField, 'resolver:diagnostic-log-owner');
    assert.equal(diagnosticLog.verifyQuery.type, 'diagnostic-log-owner-absence');
    assert.equal(diagnosticLog.verifyQuery.expected, 'absent-and-overwritten');
    assert.equal(diagnosticLog.executionGroup, 'diagnostic-log-owner-scrub');
  }

  const currentBrowser = catalogEntry('browser:electron-default-session-unattributed');
  assert.equal(currentBrowser.ownerType, 'system');
  assert.equal(currentBrowser.removable, false);
  assert.notEqual(currentBrowser.id, 'browser:external-chrome-extension-profile-unattributed');
  const currentBrowserIds = ACCOUNT_OWNERSHIP_CATALOG
    .filter((entry) => entry.id === 'browser:electron-default-session-unattributed' || entry.id.startsWith('browser:external-chrome-extension-'))
    .map((entry) => entry.id);
  assert.deepEqual(sorted(currentBrowserIds), sorted([
    'browser:electron-default-session-unattributed',
    'browser:external-chrome-extension-profile-unattributed',
    'browser:external-chrome-extension-storage-unattributed',
  ]));
  for (const id of [
    'browser:external-chrome-extension-profile-unattributed',
    'browser:external-chrome-extension-storage-unattributed',
  ]) {
    const externalChrome = catalogEntry(id);
    assert.equal(externalChrome.ownerType, 'system');
    assert.equal(externalChrome.removable, false);
    assert.match(externalChrome.deletePrimitive, /^prohibited:/u);
  }

  const purchaseBrowserEntries = ACCOUNT_OWNERSHIP_CATALOG.filter((entry) => entry.id.startsWith('browser:purchase-'));
  assert.deepEqual(sorted(purchaseBrowserEntries.map((entry) => entry.id)), sorted(FUTURE_PURCHASE_BROWSER_IDS));
  for (const entry of purchaseBrowserEntries) {
    assert.equal(entry.ownerType, 'purchase_account');
    assert.equal(entry.availability, 'current');
    assert.equal(entry.removable, true);
  }

  assert.equal(catalogEntry('logical:profile-settings-ozon-shop-preferences').ownerType, 'ozon_shop');
  const pluginContext = catalogEntry('logical:profile-settings-purchase-plugin-context');
  assert.equal(pluginContext.ownerType, 'ozon_shop');
  assert.equal(pluginContext.removable, true);
});

test('catalog validator rejects malformed removable, scope, availability, primitive, and verify contracts fail closed', () => {
  function clonedCatalog() {
    return structuredClone(ACCOUNT_OWNERSHIP_CATALOG);
  }

  function mutateEntry(catalog, id, patch) {
    const index = catalog.findIndex((entry) => entry.id === id);
    assert.notEqual(index, -1, `fixture entry exists: ${id}`);
    catalog[index] = { ...catalog[index], ...patch };
  }

  for (const removable of ['false', 1, null]) {
    const catalog = clonedCatalog();
    mutateEntry(catalog, 'registry:shops', { removable });
    assert.throws(
      () => validateAccountOwnershipCatalog(catalog),
      /ACCOUNT_OWNERSHIP_CATALOG_REMOVABLE_INVALID/u,
      `removable=${String(removable)} must never be truthy-planned`,
    );
  }

  const malformedCases = [
    {
      name: 'unknown resource is always fail-closed',
      id: 'filesystem:legacy-classification-cache-root',
      patch: { removable: true },
      expected: /ACCOUNT_OWNERSHIP_CATALOG_FAIL_CLOSED_REQUIRED/u,
    },
    {
      name: 'system resource is always preserved',
      id: 'registry:schema-migrations',
      patch: { removable: true },
      expected: /ACCOUNT_OWNERSHIP_CATALOG_FAIL_CLOSED_REQUIRED/u,
    },
    {
      name: 'future contract cannot be planned',
      id: 'memory:purchase-search-bridge-purchase-account-context',
      patch: { availability: 'future-contract', removable: true },
      expected: /ACCOUNT_OWNERSHIP_CATALOG_FUTURE_MUST_NOT_BE_PLANNED/u,
    },
    {
      name: 'scope type must be enumerated',
      id: 'registry:shops',
      patch: { scopeType: 'tenant' },
      expected: /ACCOUNT_OWNERSHIP_CATALOG_SCOPE_TYPE_INVALID/u,
    },
    {
      name: 'availability must be enumerated',
      id: 'registry:shops',
      patch: { availability: null },
      expected: /ACCOUNT_OWNERSHIP_CATALOG_AVAILABILITY_INVALID/u,
    },
    {
      name: 'delete primitive must remain a declaration, not arbitrary text',
      id: 'registry:shops',
      patch: { deletePrimitive: 'delete-now' },
      expected: /ACCOUNT_OWNERSHIP_CATALOG_DELETE_PRIMITIVE_INVALID/u,
    },
    {
      name: 'verify query must remain a machine-readable object',
      id: 'registry:shops',
      patch: { verifyQuery: null },
      expected: /ACCOUNT_OWNERSHIP_CATALOG_VERIFY_CONTRACT_INVALID/u,
    },
    {
      name: 'verify query type must come from the closed contract vocabulary',
      id: 'registry:shops',
      patch: { verifyQuery: { type: 'arbitrary-query', expected: 'zero' } },
      expected: /ACCOUNT_OWNERSHIP_CATALOG_VERIFY_CONTRACT_INVALID/u,
    },
    {
      name: 'verify query requires an explicit expected readback state',
      id: 'registry:shops',
      patch: { verifyQuery: { type: 'sqlite-count' } },
      expected: /ACCOUNT_OWNERSHIP_CATALOG_VERIFY_CONTRACT_INVALID/u,
    },
  ];

  for (const { name, id, patch, expected } of malformedCases) {
    const catalog = clonedCatalog();
    mutateEntry(catalog, id, patch);
    assert.throws(() => validateAccountOwnershipCatalog(catalog), expected, name);
  }
});

test('catalog validator closes stable-ID, owner/scope, prohibited-plan, and every verify-query schema escape hatch', () => {
  function clonedCatalog() {
    return structuredClone(ACCOUNT_OWNERSHIP_CATALOG);
  }

  function mutateEntry(catalog, id, patch) {
    const index = catalog.findIndex((entry) => entry.id === id);
    assert.notEqual(index, -1, `fixture entry exists: ${id}`);
    catalog[index] = { ...catalog[index], ...patch };
  }

  const semanticCases = [
    {
      name: 'catalog ID namespace and lowercase token grammar are stable',
      id: 'registry:shops',
      patch: { id: 'registry:Shops' },
      expected: /ACCOUNT_OWNERSHIP_CATALOG_ID_INVALID/u,
    },
    {
      name: 'Ozon shop cannot be relabeled as a system scope',
      id: 'registry:shops',
      patch: { scopeType: 'system' },
      expected: /ACCOUNT_OWNERSHIP_CATALOG_OWNER_SCOPE_INVALID/u,
    },
    {
      name: 'cross-border profile account cannot be relabeled as a shop scope',
      id: 'registry:cross-border-accounts',
      patch: { scopeType: 'shop' },
      expected: /ACCOUNT_OWNERSHIP_CATALOG_OWNER_SCOPE_INVALID/u,
    },
    {
      name: 'system resource cannot be relabeled as an external account resource',
      id: 'registry:schema-migrations',
      patch: { scopeType: 'external' },
      expected: /ACCOUNT_OWNERSHIP_CATALOG_OWNER_SCOPE_INVALID/u,
    },
    {
      name: 'owner-scoped contract cannot use a global constant owner field',
      id: 'registry:shops',
      patch: { ownerField: 'constant:global' },
      expected: /ACCOUNT_OWNERSHIP_CATALOG_OWNER_SCOPE_INVALID/u,
    },
    {
      name: 'a removable resource cannot claim a prohibited no-op primitive',
      id: 'registry:shops',
      patch: { deletePrimitive: 'prohibited:no-op' },
      expected: /ACCOUNT_OWNERSHIP_CATALOG_REMOVABLE_PROHIBITED/u,
    },
  ];
  for (const { name, id, patch, expected } of semanticCases) {
    const catalog = clonedCatalog();
    mutateEntry(catalog, id, patch);
    assert.throws(() => validateAccountOwnershipCatalog(catalog), expected, name);
  }

  const malformedVerifyCases = [
    {
      name: 'sqlite-count requires exact table, owner field, owner predicate, and zero expectation',
      id: 'registry:shops',
      verifyQuery: { type: 'sqlite-count', table: 'shops', ownerField: 'id', ownerPredicate: 'id = :ownerId', expected: 'banana' },
    },
    {
      name: 'sqlite-count cannot omit the exact owner predicate',
      id: 'registry:shops',
      verifyQuery: { type: 'sqlite-count', table: 'shops', ownerField: 'id', expected: 'zero' },
    },
    {
      name: 'sqlite account-row absence has a closed expected state',
      id: 'registry:shop-credentials',
      verifyQuery: { type: 'sqlite-account-row-absence', table: 'shops', ownerField: 'id', expected: 'banana' },
    },
    {
      name: 'secret-vault absence has a closed expected state',
      id: 'registry:shop-credentials',
      verifyQuery: { type: 'secret-vault-absence', resource: 'shops encrypted fields', ownerField: 'id', expected: 'banana' },
    },
    {
      name: 'browser artifact absence has a closed expected state',
      id: 'browser:purchase-cookies',
      verifyQuery: { type: 'browser-artifact-absence', artifact: 'cookies', expected: 'banana' },
    },
    {
      name: 'browser partition unavailable has a closed expected state',
      id: 'browser:purchase-persistent-partition',
      verifyQuery: { type: 'browser-partition-unavailable', ownerField: 'purchaseAccountId-hmac', expected: 'absent' },
    },
    {
      name: 'browser profile absence has a closed expected state',
      id: 'browser:purchase-profile-identity',
      verifyQuery: { type: 'browser-profile-absence', ownerField: 'purchaseAccountId-hmac', expected: 'unavailable' },
    },
    {
      name: 'fail-closed resources cannot advertise a readback success state',
      id: 'filesystem:legacy-classification-cache-root',
      verifyQuery: { type: 'fail-closed', ownerField: 'embedded-legacy-record-scope', expected: 'banana' },
    },
    {
      name: 'JSON owner-reference absence requires explicit paths',
      id: 'logical:profile-settings-ozon-shop-preferences',
      verifyQuery: { type: 'json-owner-reference-absence', namespace: 'ozon-shop-preferences', paths: [], expected: 'absent-and-not-active' },
    },
    {
      name: 'memory owner absence requires an exact owner field or tag selector',
      id: 'memory:local-api-write-guard-previews',
      verifyQuery: { type: 'memory-owner-absence', expected: 'absent' },
    },
    {
      name: 'memory tag absence requires the owner placeholder',
      id: 'memory:local-api-hot-cache-shop-tag',
      verifyQuery: { type: 'memory-tag-absence', tag: 'shop:all', expected: 'absent' },
    },
    {
      name: 'preserve resources have an unchanged-only verification state',
      id: 'registry:schema-migrations',
      verifyQuery: { type: 'preserve', ownerField: 'constant:global', expected: 'banana' },
    },
    {
      name: 'runtime owner count has a zero-only verification state',
      id: 'runtime:ozon-request-queue',
      verifyQuery: { type: 'runtime-owner-count', path: 'item.shopId', expected: 'banana' },
    },
    {
      name: 'runtime owner state has a closed quiesce vocabulary',
      id: 'runtime:desktop-recovery-auto-backup-scheduler',
      verifyQuery: { type: 'runtime-owner-state', path: 'global scheduler', expected: 'banana' },
    },
  ];
  for (const { name, id, verifyQuery } of malformedVerifyCases) {
    const catalog = clonedCatalog();
    mutateEntry(catalog, id, { verifyQuery });
    assert.throws(() => validateAccountOwnershipCatalog(catalog), /ACCOUNT_OWNERSHIP_CATALOG_VERIFY_CONTRACT_INVALID/u, name);
  }

  const strictBindingCases = [
    {
      name: 'sqlite owner selector rejects wildcard and SQL fragments',
      id: 'registry:shops',
      patch: { ownerField: 'shop_id LIKE *' },
      expected: /ACCOUNT_OWNERSHIP_CATALOG_OWNER_SELECTOR_INVALID/u,
    },
    {
      name: 'sqlite verifier cannot be replaced by browser verifier',
      id: 'registry:shops',
      patch: { verifyQuery: { type: 'browser-artifact-absence', artifact: 'cookies', expected: 'absent' } },
      expected: /ACCOUNT_OWNERSHIP_CATALOG_VERIFY_CONTRACT_INVALID/u,
    },
    {
      name: 'sqlite verifier cannot use a different column and predicate than its owner selector',
      id: 'registry:shops',
      patch: { verifyQuery: { type: 'sqlite-count', table: 'shops', ownerField: 'client_id', ownerPredicate: 'client_id = :ownerId', expected: 'zero' } },
      expected: /ACCOUNT_OWNERSHIP_CATALOG_VERIFY_CONTRACT_INVALID/u,
    },
    {
      name: 'memory owner verifier requires exactly one of ownerField or tag',
      id: 'memory:local-api-write-guard-previews',
      patch: { verifyQuery: { type: 'memory-owner-absence', ownerField: 'preview.shopId', tag: 'shop:${ownerId}', expected: 'absent' } },
      expected: /ACCOUNT_OWNERSHIP_CATALOG_VERIFY_CONTRACT_INVALID/u,
    },
    {
      name: 'unknown runtime state cannot masquerade as an owner-scoped quiesce verifier',
      id: 'runtime:local-api-performance-request-queue',
      patch: { ownerType: 'unknown', scopeType: 'external', removable: false, deletePrimitive: 'prohibited:test-unknown', verifyQuery: { type: 'runtime-owner-state', path: 'performanceQueueState', expected: 'stopped-or-owner-write-fenced' } },
      expected: /ACCOUNT_OWNERSHIP_CATALOG_VERIFY_CONTRACT_INVALID/u,
    },
    {
      name: 'JSON verifier rejects duplicate or non-canonical paths',
      id: 'logical:profile-settings-ozon-shop-preferences',
      patch: { verifyQuery: { type: 'json-owner-reference-absence', namespace: 'ozon-shop-preferences', ownerField: 'shops[].id', paths: ['shops[].id', 'shops[].id'], expected: 'absent-and-not-active' } },
      expected: /ACCOUNT_OWNERSHIP_CATALOG_VERIFY_CONTRACT_INVALID/u,
    },
    {
      name: 'current entry source evidence cannot become self-describing or malformed',
      id: 'memory:renderer-marketing-activity-runtime-cache',
      patch: { sourceEvidence: { sourceFile: 'local-api/src/domain/accountRemoval/accountOwnershipCatalog.js', sourceSymbol: '', ownerBasis: 'catalog' } },
      expected: /ACCOUNT_OWNERSHIP_CATALOG_SOURCE_EVIDENCE_INVALID/u,
    },
    {
      name: 'local-data structural path cannot drift from its resource contract',
      id: 'logical:local-data-product-material-profiles-shop-records',
      patch: { fileName: 'other.json' },
      expected: /ACCOUNT_OWNERSHIP_CATALOG_LOCAL_DATA_PATH_INVALID/u,
    },
  ];
  for (const { name, id, patch, expected } of strictBindingCases) {
    const catalog = clonedCatalog();
    mutateEntry(catalog, id, patch);
    assert.throws(() => validateAccountOwnershipCatalog(catalog), expected, name);
  }

  const originalPoc = clonedCatalog();
  mutateEntry(originalPoc, 'registry:shops', {
    scopeType: 'system',
    deletePrimitive: 'prohibited:no-op',
    verifyQuery: { type: 'sqlite-count', table: 'shops', ownerField: 'id', ownerPredicate: 'id = :ownerId', expected: 'banana' },
  });
  assert.throws(
    () => validateAccountOwnershipCatalog(originalPoc),
    /ACCOUNT_OWNERSHIP_CATALOG_(?:OWNER_SCOPE_INVALID|REMOVABLE_PROHIBITED)/u,
    'the exact acceptance PoC must fail before a plan can be constructed',
  );
});

test('catalog export recursively freezes nested contracts while validation catches cloned nested drift', () => {
  const exportedCatalog = getAccountOwnershipCatalog();
  const shops = exportedCatalog.find((entry) => entry.id === 'registry:shops');
  assert.ok(Object.isFrozen(exportedCatalog));
  assert.ok(Object.isFrozen(shops));
  assert.ok(Object.isFrozen(shops.verifyQuery));
  assert.ok(Object.isFrozen(shops.sourceEvidence));

  assert.throws(() => {
    shops.verifyQuery.type = 'tampered';
  }, TypeError);

  const drifted = structuredClone(exportedCatalog);
  const driftedShops = drifted.find((entry) => entry.id === 'registry:shops');
  driftedShops.verifyQuery = { ...driftedShops.verifyQuery, type: '' };
  assert.throws(() => validateAccountOwnershipCatalog(drifted), /ACCOUNT_OWNERSHIP_CATALOG_VERIFY_CONTRACT_INVALID/u);
});

test('current external, runtime, browser, and desktop inventory keeps audited resources explicit and fail-closed', () => {
  const coverageEntries = ACCOUNT_OWNERSHIP_CATALOG.filter((entry) => entry.coverageAudit === true);
  assert.equal(coverageEntries.length, COVERAGE_AUDIT_CURRENT_RESOURCE_COUNT, 'coverage audit metadata must enumerate every required current resource');
  assert.equal(new Set(coverageEntries.map((entry) => entry.id)).size, coverageEntries.length, 'coverage audit catalog IDs must be unique');

  for (const entry of coverageEntries) {
    const { id } = entry;
    assert.equal(entry.availability, 'current', `${id} must describe current production state`);
    assert.ok(entry.verifyQuery.type, `${id} must have a verification contract`);
    assert.ok(entry.preserveRule.length > 0, `${id} must state preservation`);
    assert.ok(entry.risk.length > 0, `${id} must state risk`);
    if (entry.ownerType === 'unknown' || entry.ownerType === 'system') {
      assert.equal(entry.removable, false, `${id} must remain fail-closed`);
      if (entry.ownerType === 'unknown') assert.match(entry.deletePrimitive, /^prohibited:/u);
    }
  }

  const writeGuard = catalogEntry('memory:local-api-write-guard-previews');
  assert.equal(writeGuard.ownerType, 'ozon_shop');
  assert.equal(writeGuard.ownerField, 'memory-property:preview.shopId');
  assert.equal(writeGuard.verifyQuery.type, 'memory-owner-absence');
  assert.match(writeGuard.deletePrimitive, /^future:/u);

  for (const id of [
    'logical:renderer-ozon-shop-settings-shop-slices',
    'logical:renderer-purchase-order-overrides-shop-records',
    'memory:renderer-product-material-profiles',
    'logical:local-api-rate-limit-shop-state',
    'logical:local-api-traffic-controller-shop-state',
  ]) {
    const entry = catalogEntry(id);
    assert.equal(entry.ownerType, 'ozon_shop', `${id} is an explicitly resolved exact shop slice`);
    assert.equal(entry.removable, true, `${id} is eligible only through its future exact-scope primitive`);
    assert.match(entry.ownerField, /^(?:resolver:|memory-property:|runtime-property:)/u);
    assert.match(entry.deletePrimitive, /^future:/u);
  }
  for (const id of [
    'memory:renderer-product-material-profile-hashes',
    'memory:local-api-products-hot-cache',
  ]) {
    const entry = catalogEntry(id);
    assert.equal(entry.ownerType, 'system', `${id} is a preserved physical/aggregate container`);
    assert.equal(entry.removable, false);
    assert.match(entry.deletePrimitive, /^prohibited:/u);
  }
  const endpointLimiter = catalogEntry('runtime:local-api-ozon-client-endpoint-limiter');
  assert.equal(endpointLimiter.ownerType, 'system');
  assert.equal(endpointLimiter.removable, false);
  assert.equal(endpointLimiter.verifyQuery.type, 'preserve');
  assert.equal(catalogEntry('memory:renderer-model-api-settings').ownerType, 'model_api_account');
  assert.equal(catalogEntry('logical:renderer-cross-border-settings-account-slice').ownerType, 'cross_border_bus');
  for (const id of [
    'runtime:local-api-performance-request-queue',
    'memory:performance-access-token-cache',
    'memory:performance-inflight-request-cache',
  ]) {
    const entry = catalogEntry(id);
    assert.equal(entry.ownerType, 'promotion_account', `${id} is isolated by exact Performance account id`);
    assert.equal(entry.removable, true);
    assert.equal(entry.ownerField, 'resolver:performance-account-runtime');
    assert.match(entry.deletePrimitive, /^future:/u);
  }
  for (const id of [
    'memory:renderer-marketing-activity-runtime-cache',
    'runtime:desktop-recovery-staged-descriptors',
  ]) {
    const entry = catalogEntry(id);
    assert.equal(entry.ownerType, 'system', `${id} is a preserved mixed/system container`);
    assert.equal(entry.removable, false);
    assert.match(entry.deletePrimitive, /^prohibited:/u);
  }
  for (const id of [
    'memory:external-chrome-content-snapshots',
    'runtime:external-chrome-content-pollers',
  ]) {
    const entry = catalogEntry(id);
    assert.equal(entry.ownerType, 'system', `${id} is retired stateless shared code`);
    assert.equal(entry.removable, false);
    assert.match(entry.deletePrimitive, /^prohibited:/u);
  }

  for (const id of [
    'memory:renderer-ozon-shop-settings-unattributed',
    'memory:renderer-purchase-order-local-overrides-unattributed',
    'memory:renderer-purchase-order-override-local-api-hashes-unattributed',
    'memory:renderer-cross-border-settings-unattributed',
  ]) {
    const entry = catalogEntry(id);
    assert.equal(entry.ownerType, 'system', `${id} is the aggregate container; exact owner slices are cataloged separately`);
    assert.equal(entry.removable, false);
    assert.match(entry.deletePrimitive, /^prohibited:/u);
    assert.equal(entry.verifyQuery.type, 'preserve');
  }
  const purchasePluginContext = catalogEntry('memory:renderer-purchase-plugin-source-context-unattributed');
  assert.equal(purchasePluginContext.ownerType, 'ozon_shop');
  assert.equal(purchasePluginContext.removable, true);
  assert.equal(purchasePluginContext.verifyQuery.type, 'memory-owner-absence');
  for (const id of [
    'runtime:renderer-ozon-shop-settings-write-queue',
    'runtime:renderer-purchase-order-override-local-api-write-queue',
    'runtime:renderer-purchase-order-override-migration-task',
    'runtime:renderer-purchase-plugin-context-write-queue',
    'runtime:renderer-purchase-plugin-context-last-operation',
    'runtime:renderer-purchase-plugin-context-migration-task',
    'runtime:renderer-purchase-plugin-context-revision-guard',
    'runtime:renderer-cross-border-settings-write-queue',
  ]) {
    const entry = catalogEntry(id);
    assert.equal(entry.ownerType, 'system', `${id} is a shared coordination boundary, not an owner selector`);
    assert.equal(entry.removable, false);
    assert.match(entry.deletePrimitive, /^future:accountRemoval\./u);
    assert.equal(entry.verifyQuery.type, 'runtime-owner-state');
    assert.equal(entry.verifyQuery.expected, 'stopped-or-owner-write-fenced');
    assert.match(entry.risk, /backwrite|re-persist|re-publish|re-save|queued/i, `${id} must explain write-race risk`);
  }
  for (const id of [
    'memory:desktop-license-session-store-memory',
    'runtime:desktop-license-session-load-task',
    'runtime:desktop-license-session-operation-queue',
    'runtime:desktop-license-device-code-load-task',
    'memory:desktop-purchase-bridge-auth-token',
  ]) {
    const entry = catalogEntry(id);
    assert.equal(entry.ownerType, 'system');
    assert.equal(entry.removable, false);
    assert.match(entry.preserveRule, /preserve|must never|never clear|never regenerate|must not change/i);
  }

  for (const id of [
    'memory:purchase-search-bridge-context-unattributed',
    'memory:purchase-search-bridge-captures-unattributed',
  ]) {
    const entry = catalogEntry(id);
    assert.equal(entry.ownerType, 'ozon_shop');
    assert.equal(entry.removable, true);
    assert.equal(entry.availability, 'current');
  }
  for (const id of [
    'memory:purchase-search-bridge-purchase-account-context',
    'memory:purchase-search-bridge-purchase-account-captures',
  ]) {
    const entry = catalogEntry(id);
    assert.equal(entry.ownerType, 'purchase_account');
    assert.match(entry.ownerField, /purchaseAccountId/u);
    assert.equal(entry.availability, 'current');
    assert.equal(entry.removable, true);
  }

  const autoBackup = catalogEntry('runtime:desktop-recovery-auto-backup-scheduler');
  assert.equal(autoBackup.ownerType, 'system');
  assert.match(autoBackup.deletePrimitive, /^future:accountRemoval\.recoveryAutoBackupSchedulerOwnerQuiesce$/u);
  assert.equal(autoBackup.verifyQuery.type, 'runtime-owner-state');
  assert.match(autoBackup.risk, /15-minute/u);

  const desktopLayoutPaths = {
    'filesystem:desktop-data-profile-json': 'desktop dataRoot/profile.json',
    'filesystem:desktop-data-logs-directory': 'desktop dataRoot/logs/',
    'filesystem:desktop-runtime-profile-lock': 'desktop dataRoot/runtime/profile.lock',
    'filesystem:desktop-backups-directory-unattributed': 'desktop dataRoot/backups/',
    'filesystem:desktop-tmp-directory-unattributed': 'desktop dataRoot/tmp/',
    'filesystem:desktop-local-api-data-root': 'desktop dataRoot/local-api-data/',
    'filesystem:desktop-local-api-sqlite-file': 'desktop dataRoot/local-api-data/wangzai-local-api.sqlite',
    'filesystem:local-api-secret-key': 'desktop dataRoot/local-api-data/local-api-secret.key',
    'filesystem:desktop-license-session': 'desktop license directory/license-session.bin',
    'filesystem:desktop-license-device-id': 'desktop license directory/license-device-id',
    'filesystem:desktop-purchase-bridge-license-state': 'desktop runtime/purchase-bridge-license.json',
    'filesystem:desktop-process-supervisor-logs': 'desktop processSupervisor appendLog files under dataRoot/logs/',
  };
  for (const [id, resource] of Object.entries(desktopLayoutPaths)) {
    assert.equal(catalogEntry(id).resource, resource, `${id} must retain its path-level contract`);
  }
  const localApiPathGroup = ['filesystem:desktop-local-api-data-root', 'filesystem:desktop-local-api-sqlite-file', 'filesystem:local-api-secret-key'];
  assert.deepEqual(
    [...new Set(localApiPathGroup.map((id) => catalogEntry(id).executionGroup))],
    ['desktop-local-api-data-root'],
  );
  assert.deepEqual(
    [...new Set(['filesystem:desktop-data-logs-directory', 'filesystem:desktop-process-supervisor-logs'].map((id) => catalogEntry(id).executionGroup))],
    ['desktop-data-logs'],
  );
});

test('legacy critical production anchors retain their associated catalog entries', () => {
  const requirements = [
    {
      file: 'desktop/src/runtime/serviceRuntime.js',
      symbols: ['async function startPurchaseBridge()', 'purchase-search-bridge'],
      ids: ['memory:purchase-search-bridge-context-unattributed', 'memory:purchase-search-bridge-captures-unattributed'],
    },
    {
      file: 'frontend/scripts/purchase-bridge/plugin-store.mjs',
      symbols: ['let purchasePluginContext = {};', 'let purchasePluginCaptures = [];', 'PURCHASE_PLUGIN_CAPTURE_LIMIT'],
      ids: ['memory:purchase-search-bridge-context-unattributed', 'memory:purchase-search-bridge-captures-unattributed'],
    },
    {
      file: 'desktop/src/runtime/desktopIpc.js',
      symbols: ['createRecoveryAutoBackupScheduler', 'recoveryAutoBackupScheduler.start();'],
      ids: ['runtime:desktop-recovery-auto-backup-scheduler'],
    },
    {
      file: 'local-api/src/security/writeGuardService.js',
      symbols: ['const previews = new Map();', 'previews.set(previewId, {', 'previews.get(input.previewId)'],
      ids: ['memory:local-api-write-guard-previews'],
    },
    {
      file: 'frontend/src/services/ozonShopSettingsStore.js',
      symbols: ['export let ozonShopSettingsMemory = null;', 'let ozonShopSettingsWriteQueue = Promise.resolve();'],
      ids: [
        'memory:renderer-ozon-shop-settings-unattributed',
        'runtime:renderer-ozon-shop-settings-write-queue',
      ],
    },
    {
      file: 'frontend/src/services/purchaseOrderRuntime.js',
      symbols: [
        'export let purchaseOrderLocalOverridesMemory = null;',
        'export const purchaseOrderOverrideLocalApiHashes = new Map();',
        'export let purchaseOrderOverrideLocalApiWriteQueue = Promise.resolve();',
        'let activePurchaseOrderOverrideMigration = null;',
      ],
      ids: [
        'memory:renderer-purchase-order-local-overrides-unattributed',
        'memory:renderer-purchase-order-override-local-api-hashes-unattributed',
        'runtime:renderer-purchase-order-override-local-api-write-queue',
        'runtime:renderer-purchase-order-override-migration-task',
      ],
    },
    {
      file: 'frontend/src/services/purchasePluginContextStore.js',
      symbols: [
        'let purchasePluginContextWriteQueue = Promise.resolve();',
        'let lastPurchasePluginContextOperation = Promise.resolve();',
        'let activePurchasePluginSourceContextMigration = null;',
        'let purchasePluginContextRevision = 0;',
        'export let purchasePluginSourceContextMemory = null;',
      ],
      ids: [
        'memory:renderer-purchase-plugin-source-context-unattributed',
        'runtime:renderer-purchase-plugin-context-write-queue',
        'runtime:renderer-purchase-plugin-context-last-operation',
        'runtime:renderer-purchase-plugin-context-migration-task',
        'runtime:renderer-purchase-plugin-context-revision-guard',
      ],
    },
    {
      file: 'frontend/src/shared/ozon/ozonRuntime.jsx',
      symbols: ['export let crossBorderSettingsMemory = null;', 'let crossBorderSettingsWriteQueue = Promise.resolve();'],
      ids: [
        'memory:renderer-cross-border-settings-unattributed',
        'runtime:renderer-cross-border-settings-write-queue',
      ],
    },
    {
      file: 'desktop/src/licensing/licenseSessionStore.js',
      symbols: [
        'this.memory = cleanSession(EMPTY_SESSION);',
        'this.loaded = false;',
        'this.loadPromise = null;',
        'this.operationQueue = Promise.resolve();',
        'this.deviceCodePromise = null;',
      ],
      ids: [
        'memory:desktop-license-session-store-memory',
        'runtime:desktop-license-session-load-task',
        'runtime:desktop-license-session-operation-queue',
        'runtime:desktop-license-device-code-load-task',
      ],
    },
    {
      file: 'desktop/src/runtime/purchaseBridgeState.js',
      symbols: ['const authToken = crypto.randomBytes(32).toString("base64url");'],
      ids: ['memory:desktop-purchase-bridge-auth-token'],
    },
    {
      file: 'frontend/src/audit/retiredBrowserStorageAudit.js',
      symbols: [
        "profileResource: 'browser:external-chrome-extension-profile-unattributed'",
        "storageResource: 'browser:external-chrome-extension-storage-unattributed'",
        "contentSnapshotResource: 'memory:external-chrome-content-snapshots'",
        "contentPollerResource: 'runtime:external-chrome-content-pollers'",
        "popupSnapshotResource: 'memory:external-chrome-popup-snapshots'",
        "state: 'removed-no-runtime-state'",
      ],
      ids: [
        'browser:external-chrome-extension-profile-unattributed',
        'browser:external-chrome-extension-storage-unattributed',
        'memory:external-chrome-content-snapshots',
        'runtime:external-chrome-content-pollers',
        'memory:external-chrome-popup-snapshots',
      ],
    },
    {
      file: 'desktop/src/window/mainWindow.js',
      symbols: ['import { BrowserWindow, Menu, ipcMain, screen } from "electron";', 'const guardedSession = webContents.session;'],
      ids: ['browser:electron-default-session-unattributed'],
    },
    {
      file: 'frontend/src/entities/product/productLocalData.jsx',
      symbols: ['productListMemoryCache = new Map()', 'productListPageMetaMemoryCache = new Map()', 'productListCursorMemoryCache = new Map()', 'ozonLocalDataWriteQueues = new Map()'],
      ids: [
        'memory:renderer-product-list-memory-cache-unattributed',
        'memory:renderer-product-list-page-meta-cache-unattributed',
        'memory:renderer-product-list-cursor-cache-unattributed',
        'runtime:renderer-local-mirror-file-write-queues-unattributed',
        'runtime:renderer-ozon-local-data-file-write-queues-unattributed',
      ],
    },
    {
      file: 'frontend/src/shared/config/appConfigRuntime.jsx',
      symbols: ['ozonSnapshotMemoryCache = new Map()', 'ozonSnapshotInFlight = new Map()', 'ozonSnapshotManualRefreshAt = new Map()', 'profitFinanceCooldown = createRequestCooldownState'],
      ids: [
        'memory:renderer-ozon-snapshot-memory-cache-unattributed',
        'memory:renderer-ozon-snapshot-inflight-unattributed',
        'memory:renderer-ozon-snapshot-manual-refresh-unattributed',
        'runtime:renderer-sales-supplement-cooldown-unattributed',
        'runtime:renderer-purchase-supplement-cooldown-unattributed',
        'runtime:renderer-profit-finance-cooldown-unattributed',
      ],
    },
    {
      file: 'frontend/src/services/salesOrderPagedCacheClient.js',
      symbols: ['const salesOrderPagedMemoryCache = new Map()', 'shopIds: selectedShopId ? undefined'],
      ids: ['memory:renderer-sales-order-paged-cache-unattributed'],
    },
    {
      file: 'frontend/src/entities/profit/profitFinanceEvidence.jsx',
      symbols: ['profitFinanceOperationCache = new Map()', 'profitAfterSalesSnapshotCache = new Map()'],
      ids: ['memory:renderer-profit-finance-operation-cache', 'memory:renderer-profit-after-sales-snapshot-cache'],
    },
    {
      file: 'frontend/src/entities/profit/profitLedgerMapping.jsx',
      symbols: ['profitRatingPenaltyOperationCache = new Map()'],
      ids: ['memory:renderer-profit-rating-penalty-operation-cache'],
    },
    {
      file: 'frontend/src/services/ozonOrderExperience.js',
      symbols: ['const supplementCache = new Map()', 'const imagePreloadCache = new Map()'],
      ids: ['memory:renderer-ozon-order-supplement-cache-unattributed', 'memory:renderer-ozon-order-image-preload-cache-unattributed'],
    },
    {
      file: 'frontend/src/api/localApiClient.js',
      symbols: ['const localApiActiveIssues = new Map()', 'const localApiSyncJobs = new Map()'],
      ids: ['memory:renderer-local-api-active-issues-unattributed', 'memory:renderer-local-api-sync-jobs-unattributed'],
    },
    {
      file: 'local-api/src/domain/exchange/exchangeRateService.js',
      symbols: ['const dailyRateCache = new Map()', 'const dailyBatchInflight = new Map()'],
      ids: ['memory:local-api-exchange-rate-daily-cache', 'runtime:local-api-exchange-rate-batch-inflight'],
    },
    {
      file: 'local-api/src/cache/catalog/softwareCategoryNameService.js',
      symbols: ['let categoryIndexCache = null', 'if (!categoryIndexCache) categoryIndexCache = buildCategoryIndex();'],
      ids: ['memory:local-api-software-category-name-index'],
    },
    {
      file: 'local-api/src/ozon/trafficController.js',
      symbols: ['const nextAllowedAt = new Map()', 'const limitedUntil = new Map()'],
      ids: ['runtime:local-api-traffic-controller-mixed-state'],
    },
    {
      file: 'local-api/src/ozon/rateLimitState.js',
      symbols: ['const nextAllowedAt = new Map()', 'function requireShopId'],
      ids: ['memory:local-api-rate-limit-state-mixed-next-allowed'],
    },
    {
      file: 'frontend/src/services/ozonRequestControl.js',
      symbols: ['const queuesByShop = new Map()', 'const inFlightByDedupeKey = new Map()', 'const activeIssues = new Map()'],
      ids: ['runtime:renderer-ozon-request-control-queue-unattributed', 'memory:renderer-ozon-request-control-inflight-issues-unattributed'],
    },
    {
      file: 'desktop/src/protocol/appProtocol.js',
      symbols: ['const LOCAL_DATA_FILES = {', 'const writeQueues = new Map()', 'function queueDataFileWrite'],
      ids: ['runtime:desktop-app-protocol-file-write-queues'],
    },
    {
      file: 'desktop/src/runtime/dataLayout.js',
      symbols: ['profilePath: path.join(root, "profile.json")', 'profileLockPath: path.join(root, "runtime", "profile.lock")', 'databasePath: path.join(localApiDataRoot, "wangzai-local-api.sqlite")'],
      ids: [
        'filesystem:desktop-data-profile-json',
        'filesystem:desktop-data-logs-directory',
        'filesystem:desktop-runtime-profile-lock',
        'filesystem:desktop-backups-directory-unattributed',
        'filesystem:desktop-tmp-directory-unattributed',
        'filesystem:desktop-local-api-data-root',
        'filesystem:desktop-local-api-sqlite-file',
        'filesystem:local-api-secret-key',
      ],
    },
    {
      file: 'desktop/src/licensing/licenseSessionStore.js',
      symbols: ['this.sessionPath = path.join(directory, "license-session.bin")', 'this.devicePath = path.join(directory, "license-device-id")'],
      ids: ['filesystem:desktop-license-session', 'filesystem:desktop-license-device-id'],
    },
    {
      file: 'desktop/src/runtime/purchaseBridgeState.js',
      symbols: ['const statePath = path.join(directory, "purchase-bridge-license.json")'],
      ids: ['filesystem:desktop-purchase-bridge-license-state'],
    },
    {
      file: 'desktop/src/runtime/processSupervisor.js',
      symbols: ['const childProcesses = new Map()', 'const logPath = path.join(getLogDirectory(), `${name}.log`)'],
      ids: ['runtime:desktop-process-supervisor-child-processes', 'filesystem:desktop-process-supervisor-logs'],
    },
    {
      file: 'local-api/src/backup/recoveryGeneration.js',
      symbols: ["const GENERATION_FORMAT = 'wangzai-recovery-generation'", 'const MANIFEST_DOMAIN = \'recovery-generation-manifest\'', 'keyEnvelope', 'chunkId'],
      ids: [
        'backup:remote-recovery-generation-shared-profile',
        'backup:remote-recovery-generation-chunks-shared-profile',
        'backup:remote-recovery-generation-key-envelope-shared-profile',
      ],
    },
  ];

  for (const { file, symbols, ids } of requirements) {
    const source = readFileSync(resolve(workspaceRoot, file), 'utf8');
    for (const symbol of symbols) assert.ok(source.includes(symbol), `${file} source anchor changed: ${symbol}`);
    for (const id of ids) assert.ok(ACCOUNT_OWNERSHIP_CATALOG.some((entry) => entry.id === id), `${file} requires catalog ID: ${id}`);
  }
});

function difference(left, right) {
  return [...left].filter((value) => !right.has(value)).sort();
}

const B1_PRODUCTION_SOURCE_ROOTS = Object.freeze([
  'local-api/src/domain/accountRemoval',
  'local-api/src',
  'desktop/src',
  'frontend/src',
  'local-api/scripts',
  'frontend/scripts',
  'desktop/scripts',
  'desktop/resources/browser-extensions',
]);

const B1_SOURCE_FILE_SUFFIX = /\.(?:[cm]?js|jsx|mjs|json|sql)$/iu;
const B1_STATE_NAME = /(?:cache|memory|queue|inflight|promise|runtime|token|handle|listener|snapshot|stats|recoveries|migration|coordinator|poller|store|timer)/iu;
const B1_DECLARATION = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([^\r\n;]*)/gmu;
const B1_SKIP_DIRECTORY = new Set(['node_modules', '.git', 'dist', 'test-results']);

function normalizeSourceFile(value) {
  const normalized = String(value).replace(/\\/gu, '/');
  const workspace = resolve(workspaceRoot).replace(/\\/gu, '/');
  if (normalized.startsWith(workspace + '/')) return normalized.slice(workspace.length + 1);
  const virtualPrefix = 'G:/__b0_virtual__/';
  if (normalized.startsWith(virtualPrefix)) return normalized.slice(virtualPrefix.length);
  return normalized.replace(/^[A-Za-z]:\/桌面端\//u, '');
}

function sourceLineNumber(source, index) {
  return source.slice(0, Math.max(0, index)).split(/\r?\n/u).length;
}

function parseAnchorLineNumbers(value) {
  if (!/^(?:[1-9]\d*)(?:-(?:[1-9]\d*))?(?:,(?:[1-9]\d*)(?:-(?:[1-9]\d*))?)*$/u.test(String(value))) {
    return null;
  }
  const lineNumbers = [];
  let previousLast = 0;
  for (const part of String(value).split(',')) {
    const [firstText, lastText = firstText] = part.split('-');
    const first = Number(firstText);
    const last = Number(lastText);
    if (
      !Number.isSafeInteger(first)
      || !Number.isSafeInteger(last)
      || first <= previousLast
      || last < first
    ) {
      return null;
    }
    for (let line = first; line <= last; line += 1) lineNumbers.push(line);
    previousLast = last;
  }
  return lineNumbers;
}

function splitSourceLines(source) {
  if (source.length === 0) return [];
  const lines = source.split(/\r\n|\n|\r/u);
  if (lines.at(-1) === '' && /(?:\r\n|\n|\r)$/u.test(source)) lines.pop();
  return lines;
}

function selectAnchorSourceWindow(anchor, source) {
  const lineNumbers = parseAnchorLineNumbers(anchor.line);
  const sourceLines = splitSourceLines(source);
  let configuredReason = '';
  if (!lineNumbers) {
    configuredReason = 'line-invalid';
  } else if (lineNumbers.some((line) => line > sourceLines.length)) {
    configuredReason = 'line-out-of-range';
  } else {
    const selectedLines = lineNumbers.map((line) => sourceLines[line - 1]);
    if (!selectedLines.some((line) => line.trim().length > 0)) {
      configuredReason = 'source-window-empty';
    } else {
      const sourceWindow = selectedLines.join('\n');
      if (classifySourceWindowMatch(anchor.sourceSymbol, sourceWindow)) {
        return { ok: true, lineNumbers, sourceWindow };
      }
      configuredReason = 'source-symbol-missing-at-effective-window';
    }
  }

  // Frozen ledger lines are historical evidence, not a reason to reject a
  // declaration that moved without changing. Relocate only an exact symbol
  // that appears once in the declared source file; duplicate symbols remain
  // fail-closed and still require an explicit reviewed overlay.
  const sourceSymbol = String(anchor.sourceSymbol || '');
  if (sourceSymbol) {
    const firstIndex = source.indexOf(sourceSymbol);
    const unique = firstIndex >= 0 && source.indexOf(sourceSymbol, firstIndex + sourceSymbol.length) < 0;
    if (unique) {
      const relocatedLine = sourceLineNumber(source, firstIndex);
      return {
        ok: true,
        lineNumbers: [relocatedLine],
        sourceWindow: sourceLines[relocatedLine - 1] || sourceSymbol,
        relocated: true,
      };
    }

    const identifierTokens = sourceSymbolTokens(sourceSymbol);
    const relocationLines = [];
    for (const token of identifierTokens) {
      const declarationPattern = new RegExp(
        `(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|var|function|class)\\s+${escapeRegExp(token)}(?:\\s|[=(<{])`,
        'gu',
      );
      const matches = [...source.matchAll(declarationPattern)];
      if (matches.length !== 1) continue;
      const symbolOffset = matches[0][0].lastIndexOf(token);
      relocationLines.push(sourceLineNumber(source, matches[0].index + Math.max(0, symbolOffset)));
    }
    const uniqueRelocationLines = [...new Set(relocationLines)].sort((left, right) => left - right);
    if (
      uniqueRelocationLines.length > 0
      && (identifierTokens.length === 1 || uniqueRelocationLines.length === identifierTokens.length)
    ) {
      const sourceWindow = uniqueRelocationLines.map((line) => sourceLines[line - 1] || '').join('\n');
      if (classifySourceWindowMatch(sourceSymbol, sourceWindow)) {
        return {
          ok: true,
          lineNumbers: uniqueRelocationLines,
          sourceWindow,
          relocated: true,
        };
      }
    }
  }
  return { ok: false, reason: configuredReason || 'source-symbol-not-unique' };
}

function listB1SourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory()) {
      if (!B1_SKIP_DIRECTORY.has(entry.name)) files.push(...listB1SourceFiles(resolve(directory, entry.name)));
      continue;
    }
    if (entry.isFile() && B1_SOURCE_FILE_SUFFIX.test(entry.name)) files.push(resolve(directory, entry.name));
  }
  return files;
}

function collectB1ProductionSources(roots = B1_PRODUCTION_SOURCE_ROOTS, virtualOverlay = {}) {
  const sourceByFile = new Map();
  const rootFileCounts = new Map();
  for (const root of roots) {
    const directory = resolve(workspaceRoot, root);
    assert.ok(existsSync(directory), 'B1 production root must exist: ' + root);
    const files = listB1SourceFiles(directory);
    assert.ok(files.length > 0, 'B1 production root must contain source files: ' + root);
    rootFileCounts.set(root, files.length);
    for (const file of files) {
      const sourceFile = normalizeSourceFile(file);
      if (!sourceByFile.has(sourceFile)) sourceByFile.set(sourceFile, readFileSync(file, 'utf8'));
    }
  }
  for (const [virtualPath, source] of Object.entries(virtualOverlay)) {
    sourceByFile.set(normalizeSourceFile(virtualPath), source);
  }
  return { rootFileCounts, sourceByFile };
}

function stripLineComments(source) {
  return source.split(/\r?\n/u).map((line) => line.replace(/\/\/.*$/u, '')).join('\n');
}

function discoverB1StateFacts(sourceFile, source) {
  if (/\.(?:test|spec)\.[cm]?jsx?$/iu.test(sourceFile)) return [];
  const uncommented = stripLineComments(source);
  const facts = [];
  for (const match of uncommented.matchAll(B1_DECLARATION)) {
    const name = match[1];
    const initializer = match[2] || '';
    if (/^(?:no|default)Cache$/u.test(name)) continue;
    const isState = B1_STATE_NAME.test(name)
      && /(?:new\s+(?:Map|Set)|Promise|set(?:Interval|Timeout)|create[A-Za-z0-9_$]*(?:Runtime|Controller|Coordinator)|^[\s]*[\[{])/iu.test(initializer);
    if (!isState || name === name.toUpperCase()) continue;
    const lower = (name + ' ' + initializer).toLowerCase();
    const kind = lower.includes('map') ? 'map'
      : lower.includes('set') ? 'set'
        : lower.includes('promise') ? 'promise'
          : lower.includes('queue') ? 'queue'
            : lower.includes('token') ? 'token'
              : lower.includes('timer') ? 'timer'
                : 'state';
    facts.push({
      resourceId: 'discovered:' + sourceFile.replace(/[^a-z0-9]+/giu, '-').replace(/^-|-$/gu, '') + ':' + name,
      sourceFile,
      sourceSymbol: name,
      line: sourceLineNumber(uncommented, match.index),
      structured: { kind, declaration: name },
    });
  }
  return facts;
}

function sourceSymbolTokens(value) {
  return [...String(value).matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/gu)]
    .map((match) => match[0]);
}

function isStructuredCompositeSymbol(value, tokens) {
  return (
    tokens.length >= 2
    && !/\s/u.test(value)
    && /(?:\/|\.|\[|\]|'|"|-)/u.test(value)
  );
}

function classifySourceWindowMatch(sourceSymbol, sourceWindow) {
  if (sourceWindow.includes(sourceSymbol)) return 'exact-literal';
  const tokens = sourceSymbolTokens(sourceSymbol);
  if (
    isStructuredCompositeSymbol(sourceSymbol, tokens)
    && tokens.every((token) => sourceWindow.includes(token))
  ) {
    return 'structured-composite';
  }
  return null;
}

function createFrozenAnchorFact(resource, sourceByFile) {
  const compatibility = currentPrimarySourceCompatibility(resource);
  const effectiveAnchor = compatibility?.currentSourceAnchor || currentPrimaryAnchor(resource);
  const sourceFile = normalizeSourceFile(effectiveAnchor.sourceFile);
  const source = sourceByFile.get(sourceFile);
  if (typeof source !== 'string') {
    return {
      resourceId: resource.id,
      sourceFile,
      sourceSymbol: effectiveAnchor.sourceSymbol,
      line: effectiveAnchor.line,
      structured: {
        category: resource.category,
        selector: resource.ownerBasis,
        frozenLine: resource.line,
        effectiveLine: effectiveAnchor.line,
      },
      anchored: false,
      reason: 'source-file-missing',
    };
  }
  const selection = selectAnchorSourceWindow(effectiveAnchor, source);
  if (!selection.ok) {
    return {
      resourceId: resource.id,
      sourceFile,
      sourceSymbol: effectiveAnchor.sourceSymbol,
      line: effectiveAnchor.line,
      structured: {
        category: resource.category,
        selector: resource.ownerBasis,
        frozenLine: resource.line,
        effectiveLine: effectiveAnchor.line,
      },
      anchored: false,
      reason: selection.reason,
    };
  }
  const missingBehavior = compatibility && missingAccountOwnershipPrimarySourceStatements(compatibility, selection.sourceWindow).length > 0;
  const matchMode = missingBehavior ? null : classifySourceWindowMatch(effectiveAnchor.sourceSymbol, selection.sourceWindow);
  return {
    resourceId: resource.id,
    sourceFile,
    sourceSymbol: effectiveAnchor.sourceSymbol,
    line: effectiveAnchor.line,
    lineNumbers: selection.lineNumbers,
    sourceWindowSHA256: createHash('sha256').update(selection.sourceWindow, 'utf8').digest('hex').toUpperCase(),
    matchMode,
    usingCorrectedPrimaryAnchor: CORRECTED_PRIMARY_ANCHORS_BY_ID.has(resource.id),
    structured: {
      category: resource.category,
      selector: resource.ownerBasis,
      frozenLine: resource.line,
      effectiveLine: effectiveAnchor.line,
      matchMode,
    },
    anchored: matchMode !== null,
    reason: matchMode ? null : 'source-symbol-missing-at-effective-window',
  };
}

function scanB1ProductionInventory({ ledger, roots = B1_PRODUCTION_SOURCE_ROOTS, virtualOverlay = {} }) {
  const production = collectB1ProductionSources(roots, virtualOverlay);
  const discoveredStateFacts = [...production.sourceByFile.entries()]
    .flatMap(([sourceFile, source]) => discoverB1StateFacts(sourceFile, source))
    .sort((left, right) => (
      left.sourceFile.localeCompare(right.sourceFile)
      || left.line - right.line
      || left.sourceSymbol.localeCompare(right.sourceSymbol)
    ));
  const frozenResourceFacts = ledger.resources
    .map((resource) => createFrozenAnchorFact(resource, production.sourceByFile))
    .sort((left, right) => left.resourceId.localeCompare(right.resourceId));
  return {
    ...production,
    discoveredStateFacts,
    frozenResourceFacts,
  };
}

function assertFrozenAnchorFacts(facts) {
  const missing = facts.filter((fact) => !fact.anchored);
  assert.deepEqual(missing, [], 'frozen resource source anchors must all resolve from the real production-root scanner');
  const keys = new Set();
  for (const fact of facts) {
    const key = fact.resourceId + '\u0000' + JSON.stringify(fact.structured);
    assert.equal(keys.has(key), false, 'duplicate resource/structured-anchor key: ' + key);
    keys.add(key);
  }
  assert.equal(facts.filter((fact) => fact.matchMode === 'exact-literal').length, 311);
  assert.equal(facts.filter((fact) => fact.matchMode === 'structured-composite').length, 22);
  assert.equal(facts.filter((fact) => fact.usingCorrectedPrimaryAnchor).length, 76);
  assert.ok(facts.filter((fact) => fact.usingCorrectedPrimaryAnchor).every((fact) => fact.matchMode === 'exact-literal'));
  assert.ok(facts.every((fact) => /^[A-F0-9]{64}$/u.test(fact.sourceWindowSHA256)));
}

function evidenceContainsExactStateSymbol(evidence, sourceSymbol) {
  return new RegExp(
    `(^|[^A-Za-z0-9_$])${escapeRegExp(sourceSymbol)}([^A-Za-z0-9_$]|$)`,
    'u',
  ).test(evidence);
}

function isCatalogOrLedgerBackedStateFact(fact, ledger, catalog) {
  const ledgerEvidence = ledger.resources
    .filter((resource) => normalizeSourceFile(currentPrimaryAnchor(resource).sourceFile) === fact.sourceFile)
    .map((resource) => [resource.id, currentPrimaryAnchor(resource).sourceSymbol, resource.ownerBasis, resource.category].join(' '));
  const catalogEvidence = catalog
    .filter((entry) => entry.availability === 'current' && normalizeSourceFile(entry.sourceEvidence.sourceFile) === fact.sourceFile)
    .map((entry) => [entry.id, entry.resource, entry.ownerField, entry.sourceEvidence.sourceSymbol, entry.sourceEvidence.ownerBasis].join(' '));
  return [...ledgerEvidence, ...catalogEvidence]
    .some((evidence) => evidenceContainsExactStateSymbol(evidence, fact.sourceSymbol));
}

function assertNoUnregisteredDiscoveredState(scan, ledger, catalog = ACCOUNT_OWNERSHIP_CATALOG) {
  const systemSourceFacts = verifyAccountOwnershipSystemSourceFacts(scan);
  const currentSourceFacts = verifyCurrentDiscoveryReviews(scan);
  const unregistered = scan.discoveredStateFacts
    .filter((fact) => !isCatalogOrLedgerBackedStateFact(fact, ledger, catalog)
      && !systemSourceFacts.some((reviewed) => reviewed.discovery === fact)
      && !currentSourceFacts.some((reviewed) => reviewed.discovery === fact));
  if (unregistered.length > 0) {
    throw new Error('ACCOUNT_OWNERSHIP_UNREGISTERED_DISCOVERY:' + unregistered.map((fact) => fact.sourceFile + ':' + fact.sourceSymbol).join(','));
  }
}

function b1FindingResourceIds(ledger) {
  return new Set(ledger.resourceFindings.flatMap((finding) => finding.resourceIds || []));
}

function b1MigrationResourceIds(ledger) {
  return new Set((ledger.resourceFindings.find((finding) => finding.id === 'B1-MIGRATION-01')?.resourceIds) || []);
}

function currentPrimaryAnchor(frozenResource) {
  const corrected = CORRECTED_PRIMARY_ANCHORS_BY_ID.get(frozenResource.id);
  const currentSource = CURRENT_SOURCE_ANCHORS_BY_ID.get(frozenResource.id);
  return applyAccountOwnershipAnchorOverlay({
    resource: frozenResource,
    frozenBaseline: FROZEN_B0_ANCHOR_BASELINE_BY_ID.get(frozenResource.id),
    primaryAnchor: corrected,
    currentSourceAnchor: currentSource,
  });
}

function currentPrimarySourceCompatibility(frozenResource) {
  if (!frozenAccountOwnershipAnchorMatches(frozenResource, FROZEN_B0_ANCHOR_BASELINE_BY_ID.get(frozenResource?.id))) return null;
  const primaryAnchor = CORRECTED_PRIMARY_ANCHORS_BY_ID.get(frozenResource.id);
  return currentAccountOwnershipPrimarySourceCompatibility(primaryAnchor, { resourceId: frozenResource.id });
}

function createCatalogSourceEvidenceFact(entry, frozenResource, sourceByFile) {
  const sourceFile = normalizeSourceFile(entry.sourceEvidence.sourceFile);
  const source = sourceByFile.get(sourceFile);
  if (typeof source !== 'string') {
    return { id: entry.id, sourceFile, anchored: false, reason: 'catalog-source-file-missing' };
  }
  const relocated = resolveReviewedCatalogRelocation(entry, sourceByFile);
  if (relocated) {
    return { id: entry.id, sourceFile: relocated.sourceFile, anchored: true, matchMode: 'exact-literal', usingReviewedCurrentSource: true };
  }
  const primaryCompatibility = currentPrimarySourceCompatibility(frozenResource);
  if (primaryCompatibility && entry.id === primaryCompatibility.id && ['sourceFile', 'sourceSymbol', 'ownerBasis'].every((field) => (
    entry.sourceEvidence[field] === primaryCompatibility.baselinePrimaryAnchor[field]
  ))) {
    const selection = selectAnchorSourceWindow(primaryCompatibility.currentSourceAnchor, source);
    if (!selection.ok) return { id: entry.id, sourceFile, anchored: false, reason: selection.reason };
    const missing = missingAccountOwnershipPrimarySourceStatements(primaryCompatibility, selection.sourceWindow);
    return {
      id: entry.id, sourceFile, anchored: missing.length === 0,
      matchMode: missing.length ? null : 'exact-literal',
      usingReviewedCurrentSource: true,
      compatibilityVersion: ACCOUNT_OWNERSHIP_CURRENT_PRIMARY_SOURCE_VERSION,
      sourceWindowSHA256: createHash('sha256').update(selection.sourceWindow, 'utf8').digest('hex').toUpperCase(),
      reason: missing.length ? 'primary-current-source-behavior-missing' : null,
    };
  }
  const compatibility = currentAccountOwnershipCatalogSourceCompatibility(entry);
  if (compatibility) {
    const anchor = compatibility.currentSourceAnchor;
    const selection = selectAnchorSourceWindow(anchor, source);
    if (!selection.ok) return { id: entry.id, sourceFile, anchored: false, reason: selection.reason };
    const concreteLines = splitSourceLines(selection.sourceWindow).map((line) => line.trim());
    const required = [anchor.sourceSymbol, ...compatibility.requiredSourceStatements];
    const missing = required.filter((statement) => !concreteLines.includes(statement));
    return {
      id: entry.id, sourceFile, anchored: missing.length === 0,
      matchMode: missing.length ? null : 'exact-literal',
      usingReviewedCurrentSource: true,
      compatibilityVersion: ACCOUNT_OWNERSHIP_CURRENT_CATALOG_SOURCE_VERSION,
      sourceWindowSHA256: createHash('sha256').update(selection.sourceWindow, 'utf8').digest('hex').toUpperCase(),
      reason: missing.length ? 'catalog-current-source-behavior-missing' : null,
    };
  }
  if (source.includes(entry.sourceEvidence.sourceSymbol)) {
    return { id: entry.id, sourceFile, anchored: true, matchMode: 'exact-literal' };
  }
  const effectiveAnchor = currentPrimaryAnchor(frozenResource);
  if (sourceFile !== normalizeSourceFile(effectiveAnchor.sourceFile)) {
    return { id: entry.id, sourceFile, anchored: false, reason: 'catalog-source-symbol-missing' };
  }
  const selection = selectAnchorSourceWindow(effectiveAnchor, source);
  if (!selection.ok) {
    return { id: entry.id, sourceFile, anchored: false, reason: selection.reason };
  }
  const matchMode = classifySourceWindowMatch(entry.sourceEvidence.sourceSymbol, selection.sourceWindow);
  return {
    id: entry.id,
    sourceFile,
    anchored: matchMode !== null,
    matchMode,
    reason: matchMode ? null : 'catalog-source-symbol-missing',
  };
}

function assertCurrentCatalogAnchors(catalog, ledger, scan) {
  const ledgerById = new Map(ledger.resources.map((resource) => [resource.id, resource]));
  const b1Ids = b1FindingResourceIds(ledger);
  const migrationIds = b1MigrationResourceIds(ledger);
  const seen = new Set();
  const sourceEvidenceFacts = [];
  for (const entry of catalog.filter((candidate) => candidate.availability === 'current')) {
    const frozen = ledgerById.get(entry.id);
    const sourceFile = normalizeSourceFile(entry.sourceEvidence.sourceFile);
    assert.ok(scan.sourceByFile.has(sourceFile), 'catalog source anchor file is absent: ' + entry.id);
    if (!frozen) {
      assert.equal(
        VERSIONED_CURRENT_CATALOG_EXTENSION_IDS.has(entry.id),
        true,
        'current catalog entry is absent from frozen ledger: ' + entry.id,
      );
      const sourceEvidenceFact = createCatalogSourceEvidenceFact(entry, entry.sourceEvidence, scan.sourceByFile);
      assert.ok(sourceEvidenceFact.anchored, 'versioned catalog extension source evidence is absent: ' + entry.id);
      sourceEvidenceFacts.push(sourceEvidenceFact);
      continue;
    }
    const frozenFact = scan.frozenResourceFacts.find((fact) => fact.resourceId === entry.id);
    assert.ok(frozenFact.anchored, 'frozen source symbol is absent: ' + entry.id);
    const sourceEvidenceFact = createCatalogSourceEvidenceFact(entry, frozen, scan.sourceByFile);
    assert.ok(sourceEvidenceFact.anchored, 'catalog source evidence is absent: ' + entry.id);
    sourceEvidenceFacts.push(sourceEvidenceFact);
    if (b1Ids.has(entry.id) && !migrationIds.has(entry.id)) {
      const expectedAnchor = currentPrimaryAnchor(frozen);
      assert.equal(sourceFile, normalizeSourceFile(expectedAnchor.sourceFile), 'B1 source file drift: ' + entry.id);
      assert.equal(entry.sourceEvidence.sourceSymbol, expectedAnchor.sourceSymbol, 'B1 source symbol drift: ' + entry.id);
      assert.equal(entry.sourceEvidence.ownerBasis, expectedAnchor.ownerBasis, 'B1 owner basis drift: ' + entry.id);
    }
    const key = entry.id + '\u0000' + JSON.stringify(frozenFact.structured);
    assert.equal(seen.has(key), false, 'duplicate current catalog source anchor: ' + key);
    seen.add(key);
  }
  return sourceEvidenceFacts;
}

test('frozen source overlay applies only to an untampered original anchor identity', () => {
  const baseline = FROZEN_B0_ANCHOR_BASELINE_BY_ID.get('runtime:desktop-main-lifecycle-state');
  const overlaid = currentPrimaryAnchor(baseline);
  assert.notStrictEqual(overlaid, baseline);
  assert.notEqual(overlaid.line, baseline.line);

  for (const [field, value] of [
    ['id', `${baseline.id}:tampered`],
    ['sourceFile', `${baseline.sourceFile}.tampered`],
    ['sourceSymbol', `${baseline.sourceSymbol}/tampered`],
    ['line', '1'],
    ['ownerBasis', `${baseline.ownerBasis}; tampered`],
  ]) {
    const tampered = { ...baseline, [field]: value };
    assert.strictEqual(
      currentPrimaryAnchor(tampered),
      tampered,
      `overlay must not mask a tampered frozen ${field}`,
    );
  }
});

test('versioned purchase and integration source compatibility preserves frozen Catalog identity and exact owner-scoped behavior', () => {
  const compatibilityIds = ACCOUNT_OWNERSHIP_CURRENT_CATALOG_SOURCE_COMPATIBILITY.map((entry) => entry.id).sort();
  const referencingIds = ACCOUNT_OWNERSHIP_CATALOG.filter((entry) => entry.sourceEvidence.sourceSymbol === 'async function purgeOperation(operationId) {')
    .map((entry) => entry.id).sort();
  assert.deepEqual(compatibilityIds, referencingIds, 'only the twelve existing references to this changed declaration have reviewed compatibility');
  for (const id of compatibilityIds) {
    const candidate = catalogEntry(id);
    const original = structuredClone(candidate);
    const sourceFile = candidate.sourceEvidence.sourceFile;
    const sourceByFile = new Map([[sourceFile, readFileSync(resolve(workspaceRoot, sourceFile), 'utf8')]]);
    assert.equal(createCatalogSourceEvidenceFact(candidate, candidate.sourceEvidence, sourceByFile).anchored, true);
    assert.deepEqual(candidate, original);
  }
  const entry = catalogEntry('browser:purchase-persistent-partition');
  const before = structuredClone(entry);
  const compatibility = currentAccountOwnershipCatalogSourceCompatibility(entry);
  assert.ok(compatibility);
  assert.equal(entry.sourceEvidence.sourceSymbol, 'async function purgeOperation(operationId) {');
  const sourceFile = entry.sourceEvidence.sourceFile;
  const source = readFileSync(resolve(workspaceRoot, sourceFile), 'utf8');
  const sourceByFile = new Map([[sourceFile, source]]);
  const fact = createCatalogSourceEvidenceFact(entry, entry.sourceEvidence, sourceByFile);
  assert.equal(fact.anchored, true);
  assert.equal(fact.matchMode, 'exact-literal');
  assert.equal(fact.usingReviewedCurrentSource, true);
  assert.deepEqual(entry, before, 'source compatibility must not rewrite ownership, selectors or deletion scope');
  for (const field of ['sourceFile', 'sourceSymbol', 'ownerBasis']) {
    const changed = structuredClone(entry);
    changed.sourceEvidence[field] += ':unreviewed-drift';
    assert.equal(currentAccountOwnershipCatalogSourceCompatibility(changed), null);
  }
  const [firstLine, lastLine] = compatibility.currentSourceAnchor.line.split('-').map(Number);
  for (const statement of [compatibility.currentSourceAnchor.sourceSymbol, ...compatibility.requiredSourceStatements]) {
    const lines = splitSourceLines(source);
    const index = lines.findIndex((line, lineIndex) => lineIndex >= firstLine - 1 && lineIndex < lastLine && line.trim() === statement);
    assert.ok(index >= 0, `missing real production statement: ${statement}`);
    lines[index] = `// ${statement}`;
    const commented = createCatalogSourceEvidenceFact(entry, entry.sourceEvidence, new Map([[sourceFile, lines.join('\n')]]));
    assert.equal(commented.anchored, false, 'a comment or removed ownership statement is not executable source evidence');
  }
});

test('reviewed browser cleanup source window rejects relocation even when the unchanged owner proof remains elsewhere', () => {
  const entry = catalogEntry('browser:purchase-persistent-partition');
  const compatibility = currentAccountOwnershipCatalogSourceCompatibility(entry);
  assert.ok(compatibility);
  const sourceFile = entry.sourceEvidence.sourceFile;
  const source = readFileSync(resolve(workspaceRoot, sourceFile), 'utf8');
  const lines = splitSourceLines(source);
  const [firstLine, lastLine] = compatibility.currentSourceAnchor.line.split('-').map(Number);
  const width = lastLine - firstLine + 1;
  assert.equal(lines[firstLine - 1].trim(), compatibility.currentSourceAnchor.sourceSymbol,
    'the reviewed window must begin at the concrete cleanup declaration');
  assert.equal(lines[lastLine - 1].trim(), '}', 'the reviewed window must end at the cleanup function boundary');
  const original = createCatalogSourceEvidenceFact(entry, entry.sourceEvidence, new Map([[sourceFile, source]]));
  assert.equal(original.anchored, true);

  // A lifecycle edit above this declaration can move the exact same function.
  // Finding its signature or guards somewhere else must not silently accept
  // an unreviewed new source window, even though no cleanup text was removed.
  lines.splice(firstLine - 1, 0, ...Array(width).fill('// synthetic unrelated lifecycle lines'));
  const relocatedSource = lines.join('\n');
  for (const statement of [compatibility.currentSourceAnchor.sourceSymbol, ...compatibility.requiredSourceStatements]) {
    assert.equal(relocatedSource.includes(statement), true, 'the negative fixture keeps the actual owner proof');
  }
  const relocated = createCatalogSourceEvidenceFact(entry, entry.sourceEvidence, new Map([[sourceFile, relocatedSource]]));
  assert.equal(relocated.anchored, false);
  assert.equal(relocated.reason, 'catalog-current-source-behavior-missing');
});

test('reviewed product source-link entry preserves frozen ownership and requires both retry guards and full owner drain', () => {
  const id = 'logical:local-data-product-source-links-shop-records';
  const entry = catalogEntry(id);
  const originalEntry = structuredClone(entry);
  const frozen = FROZEN_B0_ANCHOR_BASELINE_BY_ID.get(id);
  const compatibility = currentPrimarySourceCompatibility(frozen);
  assert.ok(compatibility);
  const sourceFile = compatibility.currentSourceAnchor.sourceFile;
  const source = readFileSync(resolve(workspaceRoot, sourceFile), 'utf8');
  const sourceByFile = new Map([[sourceFile, source]]);
  assert.equal(createFrozenAnchorFact(frozen, sourceByFile).anchored, true);
  assert.equal(createCatalogSourceEvidenceFact(entry, frozen, sourceByFile).anchored, true);
  assert.equal(entry.sourceEvidence.sourceSymbol, compatibility.baselinePrimaryAnchor.sourceSymbol);
  assert.deepEqual(entry, originalEntry, 'compatibility cannot change owner type, selectors, deletion primitive, or verification contract');
  for (const field of ['id', 'sourceFile', 'sourceSymbol', 'line', 'ownerBasis']) {
    const tampered = { ...frozen, [field]: `${frozen[field]}:unreviewed` };
    assert.equal(currentPrimarySourceCompatibility(tampered), null, `frozen ${field} drift must remain visible`);
  }
  for (const field of ['sourceFile', 'sourceSymbol', 'ownerBasis']) {
    const changedEntry = structuredClone(entry);
    changedEntry.sourceEvidence[field] += ':unreviewed';
    assert.equal(createCatalogSourceEvidenceFact(changedEntry, frozen, sourceByFile).anchored, false);
  }
  const lines = splitSourceLines(source);
  const selected = parseAnchorLineNumbers(compatibility.currentSourceAnchor.line);
  const required = [compatibility.currentSourceAnchor.sourceSymbol, ...compatibility.requiredSourceStatements];
  const checkedLines = selected.filter((line) => required.includes(lines[line - 1].trim()));
  assert.equal(checkedLines.filter((line) => lines[line - 1].trim() === 'assertProductSourceOwnerWritable(payload.shopId, task);').length, 2);
  for (const line of checkedLines) {
    for (const comment of [`// ${lines[line - 1]}`, `/* ${lines[line - 1]} */`]) {
      const changedLines = [...lines];
      changedLines[line - 1] = comment;
      const changedSources = new Map([[sourceFile, changedLines.join('\n')]]);
      assert.equal(createFrozenAnchorFact(frozen, changedSources).anchored, false, `missing executable primary behavior at ${line}`);
      assert.equal(createCatalogSourceEvidenceFact(entry, frozen, changedSources).anchored, false, `missing catalog behavior at ${line}`);
    }
  }
});

test('reviewed notification control state is exact-source system preservation, not an exemption for owner maps or other listeners', () => {
  const ledger = JSON.parse(readFrozenB0LedgerJson());
  const [reviewed] = ACCOUNT_OWNERSHIP_SYSTEM_SOURCE_FACTS;
  const source = readFileSync(resolve(workspaceRoot, reviewed.sourceFile), 'utf8');
  const makeScan = (sources) => ({
    sourceByFile: new Map(sources),
    discoveredStateFacts: sources.flatMap(([file, text]) => discoverB1StateFacts(file, text)),
  });
  const scan = makeScan([[reviewed.sourceFile, source]]);
  assert.doesNotThrow(() => assertNoUnregisteredDiscoveredState(scan, ledger));
  assert.equal(ACCOUNT_OWNERSHIP_SYSTEM_SOURCE_FACTS.length, 1);
  assert.equal(reviewed.ownerType, 'system');
  assert.equal(reviewed.removable, false);
  assert.equal(ACCOUNT_OWNERSHIP_CATALOG.some((entry) => entry.id === reviewed.id), false);
  assert.equal(ledger.resources.some((entry) => entry.id === reviewed.id), false);

  const otherFile = 'frontend/src/services/unreviewedCompletion.js';
  assert.throws(() => assertNoUnregisteredDiscoveredState(makeScan([
    [reviewed.sourceFile, source], [otherFile, source],
  ]), ledger), /ACCOUNT_OWNERSHIP_UNREGISTERED_DISCOVERY:.*unreviewedCompletion.js:listeners/u);
  for (const changedSource of [
    `${source}\nconst ownerMap = new Map();\n`,
    `${source}\nconst ownerReadTaskCache = new Set();\n`,
    source.replace('return () => listeners.delete(listener);', 'return () => undefined;'),
    source.replace('emitted.size > 500', 'emitted.size > 5000'),
    source.replace('emitted.add(operation.operationId);', 'emitted.add(operation);'),
  ]) {
    assert.throws(() => assertNoUnregisteredDiscoveredState(makeScan([
      [reviewed.sourceFile, changedSource],
    ]), ledger), /ACCOUNT_OWNERSHIP_SYSTEM_SOURCE_FACT_DRIFT/u);
  }
  assert.throws(() => assertNoUnregisteredDiscoveredState(makeScan([
    [reviewed.sourceFile, source],
    ['frontend/src/services/unreviewedOwnerReadTasks.js', 'const ownerReadTaskCache = new Set();'],
  ]), ledger), /ACCOUNT_OWNERSHIP_UNREGISTERED_DISCOVERY:.*ownerReadTaskCache/u);
});

test('B1 archives the immutable B0 compact resource ledger byte-for-byte', () => {
  const rawLedger = readFrozenB0LedgerJson();
  assert.equal(
    createHash('sha256').update(rawLedger, 'utf8').digest('hex').toUpperCase(),
    FROZEN_B0_LEDGER_SHA256,
  );
  const ledger = JSON.parse(rawLedger);
  assert.equal(ledger.ledgerVersion, 'phase-b-b0-frozen-ledger-v2');
  assert.equal(ledger.resources.length, ledger.resourceSummary.total);
  assert.equal(ledger.resources.length, 333);
  const required = ledger.resources.filter((resource) => resource.catalogRequired === true);
  assert.equal(required.length, ledger.resourceSummary.catalogRequired);
  assert.equal(required.length, 218);
  const groupD = ledger.resources.filter((resource) => resource.group === 'D');
  assert.equal(groupD.length, ledger.resourceSummary.staticCodePreserveNotCatalog);
  assert.equal(groupD.length, 115);
  assert.ok(groupD.every((resource) => resource.disposition === 'preserve system' && resource.catalogRequired === false));
  const dispositions = Object.fromEntries(
    ['catalog current', 'preserve system', 'unknown prohibited'].map((disposition) => [
      disposition,
      ledger.resources.filter((resource) => resource.disposition === disposition).length,
    ]),
  );
  assert.deepEqual(dispositions, ledger.resourceSummary.dispositions);
  assert.deepEqual(dispositions, { 'catalog current': 69, 'preserve system': 191, 'unknown prohibited': 73 });
  assert.equal(new Set(ledger.resources.map((resource) => resource.id)).size, ledger.resources.length);
});

test('B1 production source scanner consumes all eight roots, frozen anchors, and the catalog without a manual inventory', (t) => {
  const ledger = JSON.parse(readFrozenB0LedgerJson());
  const scan = scanB1ProductionInventory({ ledger });
  const ownerRuntimeSourceFacts = verifyAccountOwnershipOwnerRuntimeSourceFacts({
    sourceByFile: scan.sourceByFile,
    discoveredStateFacts: discoverAccountOwnershipOwnerRuntimeSourceFacts(scan.sourceByFile),
    catalog: ACCOUNT_OWNERSHIP_CATALOG,
  });
  assert.equal(ownerRuntimeSourceFacts.length, 6, 'six new owner task Sets require an independent exact source/barrier proof, not a system exemption');
  t.diagnostic(JSON.stringify({
    rootFileCounts: Object.fromEntries(scan.rootFileCounts),
    distinctSourceFiles: scan.sourceByFile.size,
    discoveredStateFacts: scan.discoveredStateFacts.length,
    supplementalOwnerRuntimeSourceFacts: ownerRuntimeSourceFacts.length,
  }));
  assert.deepEqual([...scan.rootFileCounts.keys()], [...B1_PRODUCTION_SOURCE_ROOTS]);
  for (const root of B1_PRODUCTION_SOURCE_ROOTS) assert.ok(scan.rootFileCounts.get(root) > 0, 'scanner must read real root: ' + root);
  assert.ok(scan.discoveredStateFacts.length > 0, 'scanner must discover real production state facts');
  assert.equal(verifyCurrentDiscoveryReviews(scan).length, 6, 'all six exact reviewed discoveries must still be present');
  assertNoUnregisteredDiscoveredState(scan, ledger);
  assertFrozenAnchorFacts(scan.frozenResourceFacts);
  for (const symbol of ['backupDirectory', 'temporaryDirectory']) {
    const productionReferences = [...scan.sourceByFile.entries()]
      .filter(([sourceFile, source]) => (
        sourceFile.startsWith('desktop/src/')
        && !sourceFile.endsWith('.test.js')
        && source.includes(symbol)
      ))
      .map(([sourceFile]) => sourceFile)
      .sort();
    const expectedReferences = symbol === 'backupDirectory'
      ? [
        'desktop/src/main.js',
        'desktop/src/runtime/dataBackupAtomicWriter.js',
        'desktop/src/runtime/dataLayout.js',
        'desktop/src/runtime/desktopIpc.js',
        'desktop/src/runtime/legacyWorkspaceBusinessMigration.js',
        'desktop/src/runtime/profileCacheMaintenance.js',
        'desktop/src/runtime/profileCacheMaintenanceMode.js',
      ]
      : ['desktop/src/runtime/dataLayout.js'];
    assert.deepEqual(
      productionReferences,
      expectedReferences,
      `${symbol} may only be referenced by its audited layout, backup, and maintenance owners`,
    );
  }

  const ledgerRequiredIds = new Set(ledger.resources.filter((resource) => resource.catalogRequired === true).map((resource) => resource.id));
  const catalogCurrentIds = new Set(ACCOUNT_OWNERSHIP_CATALOG.filter((entry) => entry.availability === 'current').map((entry) => entry.id));
  assert.deepEqual(difference(ledgerRequiredIds, catalogCurrentIds), [], 'Required-Catalog must be empty');
  assert.deepEqual(
    difference(catalogCurrentIds, ledgerRequiredIds),
    sorted(VERSIONED_CURRENT_CATALOG_EXTENSION_IDS),
    'only reviewed account-removal resources may extend the frozen B0 catalog',
  );
  assert.equal(
    ACCOUNT_OWNERSHIP_CATALOG.length,
    256 + MIGRATION_058_062_REGISTRY_EXTENSION_IDS.length
      + MIGRATION_068_069_REGISTRY_EXTENSION_IDS.length
      + MIGRATION_073_REGISTRY_EXTENSION_IDS.length
      + MIGRATION_074_REGISTRY_EXTENSION_IDS.length
      + MIGRATION_076_REGISTRY_EXTENSION_IDS.length
      + MIGRATION_078_REGISTRY_EXTENSION_IDS.length
      + MIGRATION_096_097_REGISTRY_EXTENSION_IDS.length
      + MIGRATION_112_REGISTRY_EXTENSION_IDS.length
      + ACCOUNT_OWNERSHIP_V5_EXTENSION_IDS.length
      + ACCOUNT_OWNERSHIP_V6_EXTENSION_IDS.length
      + ACCOUNT_OWNERSHIP_V7_EXTENSION_IDS.length
      + ACCOUNT_OWNERSHIP_V8_EXTENSION_IDS.length
      + ACCOUNT_OWNERSHIP_V9_EXTENSION_IDS.length
      + PRODUCT_IMAGE_OSS_EXTENSION_IDS.length
      + FOLLOW_SELLER_DEFENSE_REGISTRY_EXTENSION_IDS.length,
  );
  assert.equal(
    catalogCurrentIds.size,
    256 + MIGRATION_058_062_REGISTRY_EXTENSION_IDS.length
      + MIGRATION_068_069_REGISTRY_EXTENSION_IDS.length
      + MIGRATION_073_REGISTRY_EXTENSION_IDS.length
      + MIGRATION_074_REGISTRY_EXTENSION_IDS.length
      + MIGRATION_076_REGISTRY_EXTENSION_IDS.length
      + MIGRATION_078_REGISTRY_EXTENSION_IDS.length
      + MIGRATION_096_097_REGISTRY_EXTENSION_IDS.length
      + MIGRATION_112_REGISTRY_EXTENSION_IDS.length
      + ACCOUNT_OWNERSHIP_V5_EXTENSION_IDS.length
      + ACCOUNT_OWNERSHIP_V6_EXTENSION_IDS.length
      + ACCOUNT_OWNERSHIP_V7_EXTENSION_IDS.length
      + ACCOUNT_OWNERSHIP_V8_EXTENSION_IDS.length
      + ACCOUNT_OWNERSHIP_V9_EXTENSION_IDS.length
      + PRODUCT_IMAGE_OSS_EXTENSION_IDS.length
      + FOLLOW_SELLER_DEFENSE_REGISTRY_EXTENSION_IDS.length,
  );
  assert.equal(ACCOUNT_OWNERSHIP_CATALOG.filter((entry) => entry.availability === 'future-contract').length, 0);

  const frozenIntegrationProfile = ledger.resources.find((resource) => resource.id === 'registry:integration-profiles');
  assert.equal(frozenIntegrationProfile.disposition, 'preserve system');
  assert.equal(frozenIntegrationProfile.ownerBasis, '无业务账号 anchor');
  const currentIntegrationProfile = catalogEntry('registry:integration-profiles');
  assert.equal(currentIntegrationProfile.ownerType, 'integration_profile');
  assert.equal(currentIntegrationProfile.ownerField, 'sqlite-column:id');
  assert.equal(currentIntegrationProfile.removable, true);
  assert.deepEqual(
    sorted(ACCOUNT_OWNERSHIP_CATALOG
      .filter((entry) => entry.ownerType === 'integration_profile' && entry.availability === 'current')
      .map((entry) => entry.id)),
    sorted([
      'registry:integration-credentials',
      'registry:integration-profiles',
      ...ACCOUNT_OWNERSHIP_V5_EXTENSION_IDS.filter((id) => (
        id.startsWith('backup:') || id.startsWith('browser:integration-') || id.includes('owner-integration-profile')
      )),
    ]),
    'v5 review delta must expose the complete integration-profile deletion surface and nothing else',
  );

  const sourceEvidenceFacts = assertCurrentCatalogAnchors(ACCOUNT_OWNERSHIP_CATALOG, ledger, scan);
  assert.equal(
    sourceEvidenceFacts.length,
    256 + MIGRATION_058_062_REGISTRY_EXTENSION_IDS.length
      + MIGRATION_068_069_REGISTRY_EXTENSION_IDS.length
      + MIGRATION_073_REGISTRY_EXTENSION_IDS.length
      + MIGRATION_074_REGISTRY_EXTENSION_IDS.length
      + MIGRATION_076_REGISTRY_EXTENSION_IDS.length
      + MIGRATION_078_REGISTRY_EXTENSION_IDS.length
      + MIGRATION_096_097_REGISTRY_EXTENSION_IDS.length
      + MIGRATION_112_REGISTRY_EXTENSION_IDS.length
      + ACCOUNT_OWNERSHIP_V5_EXTENSION_IDS.length
      + ACCOUNT_OWNERSHIP_V6_EXTENSION_IDS.length
      + ACCOUNT_OWNERSHIP_V7_EXTENSION_IDS.length
      + ACCOUNT_OWNERSHIP_V8_EXTENSION_IDS.length
      + ACCOUNT_OWNERSHIP_V9_EXTENSION_IDS.length
      + PRODUCT_IMAGE_OSS_EXTENSION_IDS.length
      + FOLLOW_SELLER_DEFENSE_REGISTRY_EXTENSION_IDS.length,
  );
  assert.equal(
    sourceEvidenceFacts.filter((fact) => fact.matchMode === 'exact-literal').length,
    252 + MIGRATION_058_062_REGISTRY_EXTENSION_IDS.length
      + MIGRATION_068_069_REGISTRY_EXTENSION_IDS.length
      + MIGRATION_073_REGISTRY_EXTENSION_IDS.length
      + MIGRATION_074_REGISTRY_EXTENSION_IDS.length
      + MIGRATION_076_REGISTRY_EXTENSION_IDS.length
      + MIGRATION_078_REGISTRY_EXTENSION_IDS.length
      + MIGRATION_096_097_REGISTRY_EXTENSION_IDS.length
      + MIGRATION_112_REGISTRY_EXTENSION_IDS.length
      + ACCOUNT_OWNERSHIP_V5_EXTENSION_IDS.length
      + ACCOUNT_OWNERSHIP_V6_EXTENSION_IDS.length
      + ACCOUNT_OWNERSHIP_V7_EXTENSION_IDS.length
      + ACCOUNT_OWNERSHIP_V8_EXTENSION_IDS.length
      + ACCOUNT_OWNERSHIP_V9_EXTENSION_IDS.length
      + PRODUCT_IMAGE_OSS_EXTENSION_IDS.length
      + FOLLOW_SELLER_DEFENSE_REGISTRY_EXTENSION_IDS.length,
  );
  assert.equal(sourceEvidenceFacts.filter((fact) => fact.matchMode === 'structured-composite').length, 4);
  const b1Ids = b1FindingResourceIds(ledger);
  const migrationIds = b1MigrationResourceIds(ledger);
  const ledgerById = new Map(ledger.resources.map((resource) => [resource.id, resource]));
  for (const id of b1Ids) {
    const entry = catalogEntry(id);
    const frozen = ledgerById.get(id);
    if (migrationIds.has(id)) {
      assert.equal(entry.sourceEvidence.sourceFile, 'local-api/src/data/dataDomainRegistry.js', 'migration registry retains its registry anchor: ' + id);
      assert.equal(entry.verifyQuery.type, 'sqlite-count');
      assert.equal(entry.verifyQuery.table, frozen.sourceSymbol, 'migration table evidence: ' + id);
      assert.equal(entry.verifyQuery.ownerField, 'shop_id', 'migration owner column evidence: ' + id);
      assert.equal(entry.verifyQuery.ownerPredicate, 'shop_id = :ownerId', 'migration owner predicate evidence: ' + id);
    } else {
      const expectedAnchor = currentPrimaryAnchor(frozen);
      assert.equal(normalizeSourceFile(entry.sourceEvidence.sourceFile), normalizeSourceFile(expectedAnchor.sourceFile), 'B1 current source path: ' + id);
      assert.equal(entry.sourceEvidence.sourceSymbol, expectedAnchor.sourceSymbol, 'B1 current source symbol: ' + id);
      assert.equal(entry.sourceEvidence.ownerBasis, expectedAnchor.ownerBasis, 'B1 current owner basis: ' + id);
    }
    if (frozen.disposition === 'preserve system') {
      assert.equal(entry.ownerType, 'system', 'B1 preserve disposition must remain system: ' + id);
      assert.equal(entry.removable, false);
    }
    if (frozen.disposition === 'unknown prohibited') {
      assert.notEqual(entry.ownerType, 'unknown', 'post-B closure must resolve every frozen unknown: ' + id);
      if (entry.ownerType === 'system') {
        assert.equal(entry.removable, false);
        assert.equal(entry.verifyQuery.type, 'preserve');
      } else {
        assert.equal(entry.removable, true);
        assert.match(entry.deletePrimitive, /^future:/u);
      }
    }
  }

  for (const id of [
    'logical:local-data-product-material-profiles-shop-records',
    'logical:local-data-purchase-order-overrides-shop-records',
    'logical:local-data-product-source-links-shop-records',
    'logical:local-data-sales-source-links-shop-records',
    'logical:local-data-purchase-source-links-shop-records',
  ]) {
    const entry = catalogEntry(id);
    assert.equal(entry.ownerType, 'ozon_shop');
    assert.equal(entry.removable, true);
    assert.equal(entry.ownerField, 'resolver:local-data-shop-record-map');
    assert.equal(entry.verifyQuery.type, 'json-record-map-owner-absence');
  }

  const missingFileCatalog = structuredClone(ACCOUNT_OWNERSHIP_CATALOG);
  missingFileCatalog.find((entry) => entry.id === 'runtime:desktop-main-lifecycle-state').sourceEvidence.sourceFile = 'frontend/src/__b1_missing_anchor__.js';
  assert.throws(() => assertCurrentCatalogAnchors(missingFileCatalog, ledger, scan), /B1 source file drift|catalog source anchor file is absent/u);

  const missingSymbolCatalog = structuredClone(ACCOUNT_OWNERSHIP_CATALOG);
  missingSymbolCatalog.find((entry) => entry.id === 'memory:renderer-ozon-shop-settings-unattributed').sourceEvidence.sourceSymbol = '__b1_missing_catalog_symbol__';
  assert.throws(() => assertCurrentCatalogAnchors(missingSymbolCatalog, ledger, scan), /catalog source evidence is absent/u);

  const missingSymbolLedger = structuredClone(ledger);
  missingSymbolLedger.resources.find((resource) => resource.id === 'runtime:desktop-main-lifecycle-state').sourceSymbol = '__b1_missing_frozen_symbol__';
  const missingSymbolScan = scanB1ProductionInventory({ ledger: missingSymbolLedger });
  assert.throws(() => assertFrozenAnchorFacts(missingSymbolScan.frozenResourceFacts), /frozen resource source anchors/u);

  const relocatedLineLedger = structuredClone(ledger);
  relocatedLineLedger.resources.find((resource) => resource.id === 'runtime:desktop-recovery-auto-backup-scheduler').line = '1';
  const relocatedLineScan = scanB1ProductionInventory({ ledger: relocatedLineLedger });
  assert.doesNotThrow(() => assertFrozenAnchorFacts(relocatedLineScan.frozenResourceFacts));

  const partialCompositeLedger = structuredClone(ledger);
  partialCompositeLedger.resources.find((resource) => resource.id === 'runtime:desktop-recovery-auto-backup-scheduler').sourceSymbol = 'timer/__b1_missing_component__';
  const partialCompositeScan = scanB1ProductionInventory({ ledger: partialCompositeLedger });
  assert.throws(() => assertFrozenAnchorFacts(partialCompositeScan.frozenResourceFacts), /frozen resource source anchors/u);

  const duplicateFacts = [...scan.frozenResourceFacts, { ...scan.frozenResourceFacts[0] }];
  assert.throws(() => assertFrozenAnchorFacts(duplicateFacts), /duplicate resource\/structured-anchor key/u);

  const overlay = scanB1ProductionInventory({
    ledger,
    virtualOverlay: {
      'G:/__b0_virtual__/frontend/src/services/orphanOwnerRuntime.js': 'export const orphanOwnerWriteQueue = Promise.resolve();',
    },
  });
  assert.throws(() => assertNoUnregisteredDiscoveredState(overlay, ledger), /ACCOUNT_OWNERSHIP_UNREGISTERED_DISCOVERY:.*orphanOwnerRuntime/u);

  const existingRuntimeFile = 'frontend/src/features/profit/model/profitRefreshProgressRuntime.js';
  const siblingState = scanB1ProductionInventory({
    ledger,
    virtualOverlay: {
      [existingRuntimeFile]: `${scan.sourceByFile.get(existingRuntimeFile)}\nexport const profitRefreshProgressQueue = [];\n`,
    },
  });
  assert.throws(
    () => assertNoUnregisteredDiscoveredState(siblingState, ledger),
    /ACCOUNT_OWNERSHIP_UNREGISTERED_DISCOVERY:.*profitRefreshProgressQueue/u,
  );
});
