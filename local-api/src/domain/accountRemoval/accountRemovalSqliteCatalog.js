import { ACCOUNT_OWNERSHIP_CATALOG } from './accountOwnershipCatalog.js';
import { ACCOUNT_REMOVAL_ERROR_CODES, failAccountRemovalContract } from './accountRemovalErrors.js';

/**
 * Executable SQLite scope allowlist. This list is intentionally independent
 * from sqlite_master: adding a table to the schema or catalog never makes it
 * deletable until this file is reviewed as well.
 */
export const ACCOUNT_REMOVAL_SQLITE_RESOURCES = Object.freeze({
  ozon_shop: Object.freeze([
    Object.freeze({ resourceId: 'registry:purchase-completion-history', table: 'purchase_completion_history', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'logical:purchase-browser-receipts-shop-links', table: 'purchase_browser_receipts', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'logical:purchase-browser-tasks-shop-links', table: 'purchase_browser_tasks', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:analytics-daily', table: 'ozon_analytics_daily', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:cache-merge-log', table: 'ozon_cache_merge_log', ownerField: 'shop_id', accountRow: false, evidenceMode: 'rowid-summary' }),
    Object.freeze({ resourceId: 'registry:catalog-attribute-values', table: 'catalog_attribute_values', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:catalog-attributes', table: 'catalog_attributes', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:catalog-cache-keys', table: 'ozon_cache_keys', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:catalog-cache-sync-state', table: 'catalog_cache_sync_state', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:catalog-category-mappings', table: 'catalog_category_mappings', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:catalog-category-nodes', table: 'catalog_category_nodes', ownerField: 'shop_id', accountRow: false }),
    // Child cache rows are deleted before their registry parent so the audit
    // summary records each explicit deletion instead of hiding cascade counts.
    Object.freeze({ resourceId: 'registry:catalog-cache-key-registry', table: 'catalog_cache_key_registry', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:circuit-breakers', table: 'ozon_circuit_breakers', ownerField: 'shop_id', accountRow: false }),
  Object.freeze({ resourceId: 'registry:cross-border-order-records', table: 'cross_border_order_records', ownerField: 'shop_id', accountRow: false }),
  Object.freeze({ resourceId: 'registry:cross-border-account-shop-bindings', table: 'cross_border_account_shop_bindings', ownerField: 'shop_id', accountRow: false }),
  Object.freeze({ resourceId: 'registry:cross-border-charge-records', table: 'cross_border_charge_records', ownerField: 'shop_id', accountRow: false }),
  Object.freeze({ resourceId: 'registry:cross-border-charge-links', table: 'cross_border_charge_links', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:customer-service-push-view-markers', table: 'customer_service_push_view_markers', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:data-analysis-snapshots', table: 'data_analysis_snapshots', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:data-analysis-sync-state', table: 'data_analysis_sync_state', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:data-backup-imports', table: 'data_backup_imports', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:error-events', table: 'ozon_error_events', ownerField: 'shop_id', accountRow: false, evidenceMode: 'rowid-summary' }),
    Object.freeze({ resourceId: 'registry:finance-balance-snapshots', table: 'ozon_finance_balance_snapshots', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:finance-statement-reports', table: 'ozon_finance_statement_reports', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:finance-transactions', table: 'ozon_finance_transactions', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:profit-ledger-owner-routes', table: 'profit_ledger_owner_routes', ownerField: 'shop_id', accountRow: false }),
    // 跟卖动作审计引用处理案例，案例再引用巡查任务；按子表到父表顺序删除。
    Object.freeze({ resourceId: 'registry:follow-seller-action-attempts', table: 'follow_seller_action_attempts', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:follow-seller-cases', table: 'follow_seller_cases', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:follow-seller-patrol-runs', table: 'follow_seller_patrol_runs', ownerField: 'shop_id', accountRow: false }),
    // Historical import staging rows reference their run; delete the child
    // first so both explicit deletion counts remain observable.
    Object.freeze({ resourceId: 'registry:historical-import-rows', table: 'historical_import_rows', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:historical-import-runs', table: 'historical_import_runs', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:historical-order-import-rows', table: 'historical_order_import_rows', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:historical-order-import-runs', table: 'historical_order_import_runs', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:historical-order-facts', table: 'historical_order_facts', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:legacy-sync-state', table: 'sync_state', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:marketing-activities', table: 'ozon_marketing_activities', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:marketing-activity-products', table: 'ozon_marketing_activity_products', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:marketing-view-state', table: 'marketing_view_state', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:notification-events', table: 'ozon_notification_events', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:notification-settings', table: 'ozon_notification_settings', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:order-split-relations', table: 'ozon_order_split_relations', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:orders', table: 'ozon_orders', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:product-image-health', table: 'product_image_health', ownerField: 'shop_id', accountRow: false }),
    // Usage rows reference image assets. Delete them first so the remote-object
    // cleanup summary and both exact SQLite deletion counts remain auditable.
    Object.freeze({ resourceId: 'registry:product-image-usage-events', table: 'product_image_usage_events', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:product-image-assets', table: 'product_image_assets', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:product-manual-cost-profiles', table: 'product_manual_cost_profiles', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:product-material-profiles', table: 'product_material_profiles', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:product-source-links', table: 'product_source_links', ownerField: 'shop_id', accountRow: false }),
    // Normalized product children are removed before product_identities so
    // every table has an explicit count instead of being hidden by FK cascade.
    Object.freeze({ resourceId: 'registry:product-acquiring-facts', table: 'product_acquiring_facts', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:product-attribute-facts', table: 'product_attribute_facts', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:product-commission-facts', table: 'product_commission_facts', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:product-detail-facts', table: 'product_detail_facts', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:product-dimension-facts', table: 'product_dimension_facts', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:product-facet-observations', table: 'product_facet_observations', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:product-image-facts', table: 'product_image_facts', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:product-price-facts', table: 'product_price_facts', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:product-status-facts', table: 'product_status_facts', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:product-stock-facts', table: 'product_stock_facts', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:product-warehouse-stock-facts', table: 'product_warehouse_stock_facts', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:product-identities', table: 'product_identities', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:products', table: 'ozon_products', ownerField: 'shop_id', accountRow: false }),
    // Run children precede product_sync_runs for the same explicit-readback reason.
    Object.freeze({ resourceId: 'registry:product-sync-outbox', table: 'product_sync_outbox', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:product-sync-page-proofs', table: 'product_sync_page_proofs', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:product-sync-quarantine', table: 'product_sync_quarantine', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:product-sync-stage-batches', table: 'product_sync_stage_batches', ownerField: 'shop_id', accountRow: false, evidenceMode: 'rowid-summary' }),
    Object.freeze({ resourceId: 'registry:product-sync-runs', table: 'product_sync_runs', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:purchase-overrides', table: 'purchase_order_overrides', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:purchase-source-links', table: 'purchase_source_links', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:rate-limit-state', table: 'ozon_rate_limit_state', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:rating-penalties', table: 'ozon_rating_penalties', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:recovery-reconcile-state', table: 'recovery_reconcile_state', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:request-attempts', table: 'ozon_request_attempts', ownerField: 'shop_id', accountRow: false, evidenceMode: 'rowid-summary' }),
    // Request jobs are high-volume technical rows. A bounded rowid summary is
    // enough to prove that the target-only DELETE did not alter another shop,
    // and avoids materializing hundreds of thousands of payload rows in JS.
    Object.freeze({ resourceId: 'registry:request-jobs', table: 'ozon_request_jobs', ownerField: 'shop_id', accountRow: false, evidenceMode: 'rowid-summary' }),
    Object.freeze({ resourceId: 'registry:response-cache', table: 'ozon_response_cache', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:returns', table: 'ozon_returns', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:sales-source-links', table: 'sales_source_links', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:scheduler-trace-events', table: 'ozon_scheduler_trace_events', ownerField: 'shop_id', accountRow: false, evidenceMode: 'rowid-summary' }),
    Object.freeze({ resourceId: 'registry:shop-runtime-state', table: 'ozon_shop_runtime_state', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:sync-jobs', table: 'sync_jobs', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:sync-locks', table: 'ozon_sync_locks', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:sync-snapshots', table: 'ozon_sync_snapshots', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:sync-state-runtime', table: 'ozon_sync_state', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:write-audit-log', table: 'ozon_write_audit_log', ownerField: 'shop_id', accountRow: false }),
    // Domain state references bootstrap runs; delete the child first.
    Object.freeze({ resourceId: 'registry:shop-domain-sync-state', table: 'shop_domain_sync_state', ownerField: 'shop_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:shop-bootstrap-runs', table: 'shop_bootstrap_runs', ownerField: 'shop_id', accountRow: false }),
    // The aggregate account row is always deleted last.
    Object.freeze({ resourceId: 'registry:shops', table: 'shops', ownerField: 'id', accountRow: true }),
  ]),
  cross_border_bus: Object.freeze([
    Object.freeze({ resourceId: 'registry:cross-border-accounts', table: 'cross_border_accounts', ownerField: 'id', accountRow: true }),
  ]),
  promotion_account: Object.freeze([
    Object.freeze({ resourceId: 'registry:performance-accounts', table: 'performance_accounts', ownerField: 'id', accountRow: true }),
  ]),
  purchase_account: Object.freeze([
    Object.freeze({ resourceId: 'registry:purchase-browser-receipts', table: 'purchase_browser_receipts', ownerField: 'owner_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:purchase-browser-tasks', table: 'purchase_browser_tasks', ownerField: 'owner_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:purchase-browser-plugin-state', table: 'purchase_browser_plugin_state', ownerField: 'owner_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:purchase-accounts', table: 'purchase_accounts', ownerField: 'id', accountRow: true }),
  ]),
  model_api_account: Object.freeze([
    Object.freeze({ resourceId: 'registry:model-api-accounts', table: 'model_api_accounts', ownerField: 'id', accountRow: true }),
  ]),
  integration_profile: Object.freeze([
    Object.freeze({ resourceId: 'registry:integration-credentials', table: 'integration_credentials', ownerField: 'profile_id', accountRow: false }),
    Object.freeze({ resourceId: 'registry:integration-profiles', table: 'integration_profiles', ownerField: 'id', accountRow: true }),
  ]),
});

const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/u;

export function quoteAccountRemovalIdentifier(value) {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.SQLITE_ALLOWLIST_DRIFT);
  }
  return `"${value}"`;
}

export function getAccountRemovalSqliteResources(ownerType) {
  const entries = ACCOUNT_REMOVAL_SQLITE_RESOURCES[ownerType];
  if (!entries) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.SQLITE_ALLOWLIST_DRIFT);
  return entries;
}

export function getAccountRemovalSqliteResourceById(ownerType, resourceId) {
  if (ownerType === 'ozon_shop' && resourceId === 'registry:shop-credentials') {
    return getAccountRemovalSqliteResources(ownerType).find((entry) => entry.resourceId === 'registry:shops');
  }
  return getAccountRemovalSqliteResources(ownerType).find((entry) => entry.resourceId === resourceId) || null;
}

export function assertAccountRemovalSqliteCatalog(catalog = ACCOUNT_OWNERSHIP_CATALOG) {
  for (const [ownerType, allowlist] of Object.entries(ACCOUNT_REMOVAL_SQLITE_RESOURCES)) {
    const planned = catalog
      .filter((entry) => (
        entry.ownerType === ownerType
        && entry.removable === true
        && entry.availability === 'current'
        && entry.verifyQuery?.type === 'sqlite-count'
      ))
      .map((entry) => `${entry.id}\0${entry.verifyQuery.table}\0${entry.verifyQuery.ownerField}`)
      .sort();
    const allowed = allowlist
      .map((entry) => `${entry.resourceId}\0${entry.table}\0${entry.ownerField}`)
      .sort();
    if (JSON.stringify(planned) !== JSON.stringify(allowed)) {
      failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.SQLITE_ALLOWLIST_DRIFT);
    }
  }
  return true;
}
