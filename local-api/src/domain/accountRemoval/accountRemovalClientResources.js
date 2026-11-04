const CLIENT_RESOURCES = Object.freeze({
  ozon_shop: Object.freeze([
    'backup:remote-recovery-owner-ozon-shop',
    'filesystem:diagnostic-logs-owner-ozon-shop',
    'filesystem:recovery-protection-owner-ozon-shop',
    'logical:local-data-ozon-shop-settings-shop-slices',
    'logical:local-data-product-material-profiles-shop-records',
    'logical:local-data-product-source-links-shop-records',
    'logical:local-data-purchase-order-overrides-shop-records',
    'logical:local-data-purchase-source-links-shop-records',
    'logical:local-data-sales-source-links-shop-records',
    'logical:renderer-ozon-shop-settings-shop-slices',
    'logical:renderer-purchase-order-overrides-shop-records',
    'memory:renderer-product-material-profiles',
    'memory:renderer-collection-listing-category-template-cache',
    'memory:purchase-search-bridge-captures-unattributed',
    'memory:purchase-search-bridge-context-unattributed',
    'memory:renderer-ozon-snapshot-inflight-unattributed',
    'memory:renderer-ozon-snapshot-manual-refresh-unattributed',
    'memory:renderer-ozon-snapshot-memory-cache-unattributed',
    'memory:renderer-product-list-cursor-cache-unattributed',
    'memory:renderer-product-list-memory-cache-unattributed',
    'memory:renderer-product-list-page-meta-cache-unattributed',
    'memory:renderer-purchase-plugin-source-context-unattributed',
    'memory:renderer-profit-after-sales-snapshot-cache',
    'memory:renderer-profit-finance-operation-cache',
    'memory:renderer-profit-rating-penalty-operation-cache',
  ].sort()),
  cross_border_bus: Object.freeze([
    'backup:remote-recovery-owner-cross-border-bus',
    'filesystem:diagnostic-logs-owner-cross-border-bus',
    'filesystem:recovery-protection-owner-cross-border-bus',
    'logical:renderer-cross-border-settings-account-slice',
  ]),
  promotion_account: Object.freeze([
    'backup:remote-recovery-owner-promotion-account',
    'filesystem:diagnostic-logs-owner-promotion-account',
    'filesystem:recovery-protection-owner-promotion-account',
  ]),
  purchase_account: Object.freeze([
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
    'filesystem:diagnostic-logs-owner-purchase-account',
    'filesystem:recovery-protection-owner-purchase-account',
    'memory:purchase-search-bridge-purchase-account-captures',
    'memory:purchase-search-bridge-purchase-account-context',
    'memory:renderer-purchase-plugin-account-context',
  ]),
  model_api_account: Object.freeze([
    'backup:remote-recovery-owner-model-api-account',
    'filesystem:diagnostic-logs-owner-model-api-account',
    'filesystem:recovery-protection-owner-model-api-account',
    'memory:renderer-model-api-settings',
  ]),
  integration_profile: Object.freeze([
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
  ]),
});

const SERVER_VERIFIED_RESOURCE_PREFIXES = Object.freeze([
  'backup:remote-recovery-owner-',
  'browser:purchase-',
  'browser:integration-',
  'filesystem:diagnostic-logs-owner-',
  'filesystem:recovery-protection-owner-',
]);

const CLIENT_BARRIERS = Object.freeze({
  ozon_shop: Object.freeze([
    'runtime:renderer-marketing-view-state-write-queue',
    'runtime:renderer-ozon-shop-settings-write-queue',
    'runtime:renderer-product-material-profile-write-queue',
    'runtime:renderer-product-source-link-migration',
    'runtime:renderer-purchase-plugin-context-write-queue',
    'runtime:renderer-purchase-source-link-migration',
    'runtime:renderer-sales-source-link-migration',
  ].sort()),
  cross_border_bus: Object.freeze([]),
  promotion_account: Object.freeze([]),
  purchase_account: Object.freeze([
    'runtime:renderer-purchase-plugin-context-write-queue',
  ]),
  model_api_account: Object.freeze([]),
  integration_profile: Object.freeze([]),
});

export function getAccountRemovalClientResourceIds(ownerType) {
  return [...(CLIENT_RESOURCES[ownerType] || [])];
}

export function getAccountRemovalClientBarrierIds(ownerType) {
  return [...(CLIENT_BARRIERS[ownerType] || [])];
}

export function isAccountRemovalClientResource(ownerType, resourceId) {
  return (CLIENT_RESOURCES[ownerType] || []).includes(resourceId);
}

export function isAccountRemovalServerVerifiedClientResource(ownerType, resourceId) {
  return isAccountRemovalClientResource(ownerType, resourceId)
    && SERVER_VERIFIED_RESOURCE_PREFIXES.some((prefix) => resourceId.startsWith(prefix));
}
