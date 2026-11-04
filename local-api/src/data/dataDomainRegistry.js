const VALID_SCOPE_TYPES = new Set(['shop', 'profile', 'system']);
const VALID_DATA_CLASSES = new Set(['fact', 'config', 'secret', 'cache', 'runtime']);
const VALID_BACKUP_DISPOSITIONS = new Set(['required', 'optional', 'excluded']); const VALID_ORDINARY_CACHE_CLEAR_DISPOSITIONS = new Set(['preserve', 'delete']); import { applyDataDomainLifecycleDefaults, DATA_DOMAIN_LIFECYCLE_FIELDS } from './dataDomainLifecycleDefaults.js'; import { DATA_DOMAIN_REGISTRY_EXTENSION_INPUTS } from './dataDomainRegistryExtensions.js';

function entry(input) {
  const policy = applyDataDomainLifecycleDefaults(input);
  if (policy.legacyPrimaryKeys && typeof policy.legacyPrimaryKeys === 'object') {
    policy.legacyPrimaryKeys = Object.freeze(
      Object.fromEntries(
        Object.entries(policy.legacyPrimaryKeys).map(([version, primaryKey]) => [
          version,
          Object.freeze([...(Array.isArray(primaryKey) ? primaryKey : [])]),
        ]),
      ),
    );
  }
  return Object.freeze(policy);
}

/**
 * 唯一的数据归属、类别和备份策略来源。
 * 新表必须先在这里登记；未知表不会被误当作当前店铺数据或备份数据。
 */
export const DATA_DOMAIN_REGISTRY = Object.freeze([
  entry({ domain: 'shops', scopeType: 'profile', dataClass: 'config', source: 'user', canonicalTable: 'shops', primaryKey: ['id'], backup: 'required' }),
  entry({ domain: 'shop-credentials', scopeType: 'shop', dataClass: 'secret', source: 'user', canonicalTable: 'secret-vault:shops', storageAdapter: 'secret-vault', primaryKey: ['shop_id'], backup: 'required' }),
  // 本地密钥集本身不离开设备；同一密钥集的可恢复副本只存在于 passphrase envelope 中。
  entry({ domain: 'recovery-keyset', scopeType: 'profile', dataClass: 'secret', source: 'user', canonicalTable: 'recovery_local_state', storageAdapter: 'secret-vault', recoveryChannel: 'envelope', primaryKey: ['id'], backup: 'required' }),
  entry({ domain: 'cross-border-accounts', scopeType: 'profile', dataClass: 'secret', source: 'user', canonicalTable: 'cross_border_accounts', primaryKey: ['id'], backup: 'required' }),
  entry({ domain: 'performance-accounts', scopeType: 'profile', dataClass: 'secret', source: 'user', canonicalTable: 'performance_accounts', primaryKey: ['id'], backup: 'required' }),
  entry({ domain: 'purchase-accounts', scopeType: 'profile', dataClass: 'secret', source: 'user', canonicalTable: 'purchase_accounts', primaryKey: ['id'], backup: 'required' }),
  entry({ domain: 'model-api-accounts', scopeType: 'profile', dataClass: 'secret', source: 'user', canonicalTable: 'model_api_accounts', primaryKey: ['id'], backup: 'required' }),
  entry({ domain: 'integration-profiles', scopeType: 'profile', dataClass: 'config', source: 'user', canonicalTable: 'integration_profiles', primaryKey: ['id'], backup: 'required' }),
  entry({ domain: 'integration-credentials', scopeType: 'profile', dataClass: 'secret', source: 'user', canonicalTable: 'integration_credentials', primaryKey: ['profile_id'], backup: 'required' }),
  entry({ domain: 'profile-settings', scopeType: 'profile', dataClass: 'config', source: 'user', canonicalTable: 'profile_settings', primaryKey: ['namespace'], backup: 'required' }),
  entry({ domain: 'profile-assets', scopeType: 'profile', dataClass: 'config', source: 'user', canonicalTable: 'profile_assets', primaryKey: ['id'], backup: 'required' }),
  entry({ domain: 'purchase-overrides', scopeType: 'shop', dataClass: 'fact', source: 'user', canonicalTable: 'purchase_order_overrides', primaryKey: ['shop_id', 'order_key'], backup: 'required' }),
  entry({ domain: 'purchase-source-links', scopeType: 'shop', dataClass: 'fact', source: 'user', canonicalTable: 'purchase_source_links', primaryKey: ['shop_id', 'order_key', 'slot_index'], backup: 'required' }),
  entry({ domain: 'sales-source-links', scopeType: 'shop', dataClass: 'fact', source: 'user', canonicalTable: 'sales_source_links', primaryKey: ['shop_id', 'order_key', 'slot_index'], backup: 'required' }),
  entry({ domain: 'product-source-links', scopeType: 'shop', dataClass: 'fact', source: 'user', canonicalTable: 'product_source_links', primaryKey: ['shop_id', 'product_key', 'slot_index'], backup: 'required' }),
  entry({ domain: 'product-material-profiles', schemaVersion: 2, legacyPrimaryKeys: { 1: ['shop_id', 'product_key'] }, scopeType: 'shop', dataClass: 'fact', source: 'user', canonicalTable: 'product_material_profiles', primaryKey: ['shop_id', 'product_key', 'source'], backup: 'required' }), entry({ domain: 'product-manual-cost-profiles', scopeType: 'shop', dataClass: 'fact', source: 'user', canonicalTable: 'product_manual_cost_profiles', primaryKey: ['shop_id', 'product_key', 'source_type'], backup: 'required', containsPii: true }), entry({ domain: 'historical-order-facts', scopeType: 'shop', dataClass: 'fact', source: 'user', canonicalTable: 'historical_order_facts', primaryKey: ['shop_id', 'posting_number', 'source_type'], backup: 'required', containsPii: true }),
  entry({ domain: 'order-split-relations', scopeType: 'shop', dataClass: 'fact', source: 'user', canonicalTable: 'ozon_order_split_relations', primaryKey: ['shop_id', 'parent_posting_number'], backup: 'required' }),
  entry({ domain: 'notification-settings', scopeType: 'shop', dataClass: 'config', source: 'user', canonicalTable: 'ozon_notification_settings', primaryKey: ['shop_id', 'domain', 'event_type'], backup: 'required' }),

  entry({ domain: 'products', schemaVersion: 2, legacyPrimaryKeys: { 1: ['shop_id', 'product_key'] }, scopeType: 'shop', dataClass: 'fact', source: 'ozon', canonicalTable: 'ozon_products', primaryKey: ['shop_id', 'product_key'], backup: 'optional', rebuildable: true }),
  entry({ domain: 'orders', scopeType: 'shop', dataClass: 'fact', source: 'ozon', canonicalTable: 'ozon_orders', primaryKey: ['shop_id', 'posting_number'], backup: 'optional', rebuildable: true }),
  entry({ domain: 'finance-transactions', scopeType: 'shop', dataClass: 'fact', source: 'ozon', canonicalTable: 'ozon_finance_transactions', primaryKey: ['shop_id', 'operation_id'], backup: 'optional', rebuildable: true }),
  // Ozon 对账报表和余额快照是只读、可从官方接口重建的店铺缓存。
  // 它们不参与订单利润冻结计算，也不允许被当作用户手工财务事实写回。
  entry({ domain: 'finance-statement-reports', scopeType: 'shop', dataClass: 'cache', source: 'ozon', canonicalTable: 'ozon_finance_statement_reports', primaryKey: ['shop_id', 'period_id'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'finance-balance-snapshots', scopeType: 'shop', dataClass: 'cache', source: 'ozon', canonicalTable: 'ozon_finance_balance_snapshots', primaryKey: ['shop_id', 'id'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'returns', scopeType: 'shop', dataClass: 'fact', source: 'ozon', canonicalTable: 'ozon_returns', primaryKey: ['shop_id', 'return_id'], backup: 'optional', rebuildable: true }),
  entry({
    domain: 'marketing-activities',
    schemaVersion: 2,
    scopeType: 'shop',
    dataClass: 'fact',
    source: 'ozon',
    canonicalTable: 'ozon_marketing_activities',
    primaryKey: ['shop_id', 'activity_id', 'source_type'],
    legacyPrimaryKeys: { 1: ['shop_id', 'activity_id'] },
    backup: 'optional',
    rebuildable: true,
  }),
  entry({
    domain: 'marketing-activity-products',
    schemaVersion: 2,
    scopeType: 'shop',
    dataClass: 'fact',
    source: 'ozon',
    canonicalTable: 'ozon_marketing_activity_products',
    primaryKey: ['shop_id', 'activity_id', 'source_type', 'product_id'],
    legacyPrimaryKeys: { 1: ['shop_id', 'activity_id', 'product_id'] },
    backup: 'optional',
    rebuildable: true,
  }),
  // The compact UI selection/summary state belongs to the shop but is not
  // required for a core-only recovery. 053 added typed counters and 054 added
  // their provenance bit, so retain both historical row shapes for recovery.
  entry({
    domain: 'marketing-view-state',
    schemaVersion: 3,
    scopeType: 'shop',
    dataClass: 'config',
    source: 'user',
    canonicalTable: 'marketing_view_state',
    primaryKey: ['shop_id'],
    legacyPrimaryKeys: { 1: ['shop_id'], 2: ['shop_id'] },
    backup: 'optional',
  }),
  entry({ domain: 'rating-penalties', scopeType: 'shop', dataClass: 'fact', source: 'ozon', canonicalTable: 'ozon_rating_penalties', primaryKey: ['shop_id', 'operation_id'], backup: 'optional', rebuildable: true }),
  entry({ domain: 'analytics-daily', scopeType: 'shop', dataClass: 'fact', source: 'ozon', canonicalTable: 'ozon_analytics_daily', primaryKey: ['shop_id', 'report_date'], backup: 'optional', rebuildable: true }),
  entry({ domain: 'cross-border-order-records', scopeType: 'shop', dataClass: 'fact', source: 'user', canonicalTable: 'cross_border_order_records', primaryKey: ['shop_id', 'record_key'], backup: 'required' }),

  entry({ domain: 'catalog-category-nodes', scopeType: 'shop', dataClass: 'cache', source: 'ozon', canonicalTable: 'catalog_category_nodes', primaryKey: ['shop_id', 'category_id'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'catalog-category-mappings', scopeType: 'shop', dataClass: 'cache', source: 'derived', canonicalTable: 'catalog_category_mappings', primaryKey: ['shop_id', 'source_namespace', 'source_category_id', 'source_type_id'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'catalog-attributes', scopeType: 'shop', dataClass: 'cache', source: 'ozon', canonicalTable: 'catalog_attributes', primaryKey: ['shop_id', 'attribute_id'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'catalog-attribute-values', scopeType: 'shop', dataClass: 'cache', source: 'ozon', canonicalTable: 'catalog_attribute_values', primaryKey: ['shop_id', 'attribute_id', 'value_id'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'product-image-health', scopeType: 'shop', dataClass: 'cache', source: 'derived', canonicalTable: 'product_image_health', primaryKey: ['shop_id', 'image_url'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'data-analysis-snapshots', scopeType: 'shop', dataClass: 'cache', source: 'derived', canonicalTable: 'data_analysis_snapshots', primaryKey: ['shop_id', 'cache_key'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'profit-ledger-snapshots', scopeType: 'profile', dataClass: 'cache', source: 'derived', canonicalTable: 'profit_ledger_snapshots', primaryKey: ['snapshot_key'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'profit-ledger-owner-routes', scopeType: 'shop', dataClass: 'config', source: 'system', canonicalTable: 'profit_ledger_owner_routes', primaryKey: ['shop_id'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'exchange-rate-cache', scopeType: 'profile', dataClass: 'cache', source: 'external', canonicalTable: 'exchange_rate_cache', primaryKey: ['requested_date'], backup: 'excluded', rebuildable: true }),

  // 现有 ozon_sync_state 是按请求 scope 展开的运行状态，不是可恢复的紧凑游标头；
  // 不能把数万条技术 scope 误传到 30MiB 灾难备份中。
  entry({ domain: 'sync-state-runtime', scopeType: 'shop', dataClass: 'runtime', source: 'system', canonicalTable: 'ozon_sync_state', primaryKey: ['shop_id', 'domain', 'scope_key'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'recovery-reconcile-state', scopeType: 'shop', dataClass: 'runtime', source: 'system', canonicalTable: 'recovery_reconcile_state', primaryKey: ['shop_id', 'restore_id'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'response-cache', scopeType: 'shop', dataClass: 'cache', source: 'ozon', canonicalTable: 'ozon_response_cache', primaryKey: ['shop_id', 'domain', 'cache_key'], backup: 'excluded', rebuildable: true, ordinaryCacheClear: 'delete' }),
  entry({ domain: 'catalog-cache-keys', scopeType: 'shop', dataClass: 'cache', source: 'derived', canonicalTable: 'ozon_cache_keys', primaryKey: ['shop_id', 'cache_key'], backup: 'excluded', rebuildable: true, ordinaryCacheClear: 'delete' }),
  entry({ domain: 'catalog-cache-key-registry', scopeType: 'shop', dataClass: 'cache', source: 'derived', canonicalTable: 'catalog_cache_key_registry', primaryKey: ['shop_id', 'cache_key'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'catalog-cache-sync-state', scopeType: 'shop', dataClass: 'runtime', source: 'system', canonicalTable: 'catalog_cache_sync_state', primaryKey: ['shop_id', 'cache_key'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'data-analysis-sync-state', scopeType: 'shop', dataClass: 'runtime', source: 'system', canonicalTable: 'data_analysis_sync_state', primaryKey: ['shop_id', 'analysis_type'], backup: 'excluded', rebuildable: true }), entry({ domain: 'historical-import-runs', scopeType: 'shop', dataClass: 'runtime', source: 'system', canonicalTable: 'historical_import_runs', primaryKey: ['shop_id', 'import_id'], backup: 'excluded', rebuildable: true, containsPii: true }), entry({ domain: 'historical-import-rows', scopeType: 'shop', dataClass: 'runtime', source: 'system', canonicalTable: 'historical_import_rows', primaryKey: ['shop_id', 'import_id', 'row_index'], backup: 'excluded', rebuildable: true, containsPii: true }), entry({ domain: 'historical-order-import-runs', scopeType: 'shop', dataClass: 'runtime', source: 'system', canonicalTable: 'historical_order_import_runs', primaryKey: ['shop_id', 'import_id'], backup: 'excluded', rebuildable: true, containsPii: true }), entry({ domain: 'historical-order-import-rows', scopeType: 'shop', dataClass: 'runtime', source: 'system', canonicalTable: 'historical_order_import_rows', primaryKey: ['shop_id', 'import_id', 'row_index'], backup: 'excluded', rebuildable: true, containsPii: true }),
  entry({ domain: 'scheduler-trace-events', scopeType: 'system', dataClass: 'runtime', source: 'system', canonicalTable: 'ozon_scheduler_trace_events', primaryKey: ['id'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'request-jobs', scopeType: 'shop', dataClass: 'runtime', source: 'system', canonicalTable: 'ozon_request_jobs', primaryKey: ['shop_id', 'id'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'request-attempts', scopeType: 'system', dataClass: 'runtime', source: 'system', canonicalTable: 'ozon_request_attempts', primaryKey: ['id'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'cache-merge-log', scopeType: 'system', dataClass: 'runtime', source: 'system', canonicalTable: 'ozon_cache_merge_log', primaryKey: ['id'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'sync-locks', scopeType: 'shop', dataClass: 'runtime', source: 'system', canonicalTable: 'ozon_sync_locks', primaryKey: ['shop_id', 'lock_key'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'sync-snapshots', scopeType: 'shop', dataClass: 'runtime', source: 'system', canonicalTable: 'ozon_sync_snapshots', primaryKey: ['shop_id', 'id'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'error-events', scopeType: 'system', dataClass: 'runtime', source: 'system', canonicalTable: 'ozon_error_events', primaryKey: ['id'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'circuit-breakers', scopeType: 'shop', dataClass: 'runtime', source: 'system', canonicalTable: 'ozon_circuit_breakers', primaryKey: ['shop_id', 'endpoint_key'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'rate-limit-state', scopeType: 'shop', dataClass: 'runtime', source: 'system', canonicalTable: 'ozon_rate_limit_state', primaryKey: ['shop_id', 'endpoint_key'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'shop-runtime-state', scopeType: 'shop', dataClass: 'runtime', source: 'system', canonicalTable: 'ozon_shop_runtime_state', primaryKey: ['shop_id'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'notification-events', scopeType: 'shop', dataClass: 'runtime', source: 'system', canonicalTable: 'ozon_notification_events', primaryKey: ['shop_id', 'id'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'write-audit-log', scopeType: 'shop', dataClass: 'runtime', source: 'system', canonicalTable: 'ozon_write_audit_log', primaryKey: ['shop_id', 'id'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'sync-jobs', scopeType: 'shop', dataClass: 'runtime', source: 'system', canonicalTable: 'sync_jobs', primaryKey: ['shop_id', 'id'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'legacy-sync-state', scopeType: 'shop', dataClass: 'runtime', source: 'system', canonicalTable: 'sync_state', primaryKey: ['shop_id', 'module'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'legacy-browser-observation-days', scopeType: 'profile', dataClass: 'runtime', source: 'system', canonicalTable: 'legacy_browser_observation_days', primaryKey: ['profile_id', 'observed_on'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'legacy-browser-read-key-days', scopeType: 'profile', dataClass: 'runtime', source: 'system', canonicalTable: 'legacy_browser_read_key_days', primaryKey: ['profile_id', 'observed_on', 'legacy_key'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'legacy-browser-observation-sessions', scopeType: 'profile', dataClass: 'runtime', source: 'system', canonicalTable: 'legacy_browser_observation_sessions', primaryKey: ['profile_id', 'session_id'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'legacy-browser-observation-batches', scopeType: 'profile', dataClass: 'runtime', source: 'system', canonicalTable: 'legacy_browser_observation_batches', primaryKey: ['profile_id', 'batch_id'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'schema-migrations', scopeType: 'system', dataClass: 'config', source: 'system', canonicalTable: 'schema_migrations', primaryKey: ['version'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'account-removal-operations', scopeType: 'system', dataClass: 'runtime', source: 'system', canonicalTable: 'account_removal_operations', primaryKey: ['operation_id'], backup: 'excluded', rebuildable: true }),
  // 只保存脱敏导出摘要与校验状态；外部文件路径、包内容和密钥永不入库。
  entry({ domain: 'data-backup-exports', scopeType: 'system', dataClass: 'runtime', source: 'system', canonicalTable: 'data_backup_exports', primaryKey: ['backup_id'], backup: 'excluded', rebuildable: true }),
  // 只保存导入的脱敏结果摘要；.wzb 包、口令、client_id 和恢复密钥永不入库。
  entry({ domain: 'data-backup-imports', scopeType: 'shop', dataClass: 'runtime', source: 'system', canonicalTable: 'data_backup_imports', primaryKey: ['shop_id', 'import_id'], backup: 'excluded', rebuildable: true }), entry({ domain: 'data-backup-owner-imports', scopeType: 'profile', dataClass: 'runtime', source: 'system', canonicalTable: 'data_backup_owner_imports', primaryKey: ['target_profile_id', 'owner_type', 'owner_ref', 'import_id'], backup: 'excluded', rebuildable: true }),
  entry({ domain: 'purchase-browser-tasks', scopeType: 'profile', dataClass: 'fact', source: 'user', canonicalTable: 'purchase_browser_tasks', primaryKey: ['id'], backup: 'required', containsPii: true }),
  entry({ domain: 'purchase-browser-receipts', scopeType: 'profile', dataClass: 'fact', source: 'user', canonicalTable: 'purchase_browser_receipts', primaryKey: ['id'], backup: 'required', containsPii: true }),
  entry({ domain: 'purchase-browser-plugin-state', scopeType: 'profile', dataClass: 'cache', source: 'system', canonicalTable: 'purchase_browser_plugin_state', primaryKey: ['owner_id'], backup: 'excluded', rebuildable: true }),
  // 商品图是迁移 086 新增的正式域，追加在冻结的 B0 源码锚点之后，避免改动既有审计证据行号。
  entry({ domain: 'product-image-assets', scopeType: 'shop', dataClass: 'fact', source: 'user', canonicalTable: 'product_image_assets', primaryKey: ['shop_id', 'id'], backup: 'required' }),
  entry({ domain: 'product-image-usage-events', scopeType: 'shop', dataClass: 'runtime', source: 'system', canonicalTable: 'product_image_usage_events', primaryKey: ['shop_id', 'id'], backup: 'excluded', rebuildable: true }),
  // 跟卖巡查、处理案例和写入审计属于店铺正式业务证据，必须随店铺备份与删除。
  entry({ domain: 'follow-seller-patrol-runs', scopeType: 'shop', dataClass: 'fact', source: 'system', canonicalTable: 'follow_seller_patrol_runs', primaryKey: ['shop_id', 'id'], backup: 'required' }),
  entry({ domain: 'follow-seller-cases', scopeType: 'shop', dataClass: 'fact', source: 'user', canonicalTable: 'follow_seller_cases', primaryKey: ['shop_id', 'id'], backup: 'required' }),
  entry({ domain: 'follow-seller-action-attempts', scopeType: 'shop', dataClass: 'fact', source: 'system', canonicalTable: 'follow_seller_action_attempts', primaryKey: ['shop_id', 'id'], backup: 'required' }),
  entry({ domain: 'follow-seller-login-preferences', scopeType: 'profile', dataClass: 'config', source: 'user', canonicalTable: 'follow_seller_login_preferences', primaryKey: ['preference_key'], backup: 'required' }),
  ...DATA_DOMAIN_REGISTRY_EXTENSION_INPUTS.map(entry), entry({ domain: 'customer-service-push-view-markers', scopeType: 'shop', dataClass: 'cache', source: 'derived', canonicalTable: 'customer_service_push_view_markers', primaryKey: ['shop_id', 'account_scope', 'chat_id', 'last_message_id', 'last_message_at'], backup: 'excluded', rebuildable: true }), entry({ domain: 'cross-border-charge-records', scopeType: 'shop', dataClass: 'fact', source: 'external', canonicalTable: 'cross_border_charge_records', primaryKey: ['shop_id', 'tenant_id', 'user_id', 'profile_id', 'browser_account_ref', 'source_record_hash'], backup: 'required', containsPii: true }), entry({ domain: 'cross-border-charge-links', scopeType: 'shop', dataClass: 'fact', source: 'derived', canonicalTable: 'cross_border_charge_links', primaryKey: ['shop_id', 'tenant_id', 'user_id', 'profile_id', 'browser_account_ref', 'collection_number'], backup: 'required', containsPii: true }), entry({ domain: 'cross-border-account-shop-bindings', scopeType: 'shop', dataClass: 'fact', source: 'user', canonicalTable: 'cross_border_account_shop_bindings', primaryKey: ['shop_id', 'account_id'], backup: 'required', rebuildable: false, containsPii: true }), ]); // reviewed extension anchors: domain: 'shop-identity-tombstones'; domain: 'shop-bootstrap-runs'; domain: 'shop-domain-sync-state'; domain: 'purchase-completion-history'; domain: 'shared-catalog-versions'; domain: 'shared-catalog-import-runs'; domain: 'shared-catalog-categories'; domain: 'shared-catalog-types'; domain: 'shared-catalog-attributes'; domain: 'shared-catalog-attribute-values'; domain: 'shared-catalog-entity-sources'; domain: 'shared-catalog-quarantine'; domain: 'product-sync-runs'; domain: 'product-sync-stage-batches'; domain: 'product-sync-page-proofs'; domain: 'product-sync-outbox'; domain: 'product-sync-quarantine'; domain: 'product-identities'; domain: 'product-status-facts'; domain: 'product-detail-facts'; domain: 'product-dimension-facts'; domain: 'product-price-facts'; domain: 'product-commission-facts'; domain: 'product-acquiring-facts'; domain: 'product-stock-facts'; domain: 'product-warehouse-stock-facts'; domain: 'product-image-facts'; domain: 'product-attribute-facts'; domain: 'product-facet-observations'
export function validateDataDomainRegistry(entries = DATA_DOMAIN_REGISTRY) {
  const domains = new Set();
  const tables = new Set();
  for (const policy of entries) {
    const schemaVersion = policy?.schemaVersion ?? 1; const ordinaryCacheClear = policy?.ordinaryCacheClear ?? 'preserve';
    if (!policy?.domain || domains.has(policy.domain)) throw new Error('DATA_DOMAIN_DUPLICATE');
    if (!policy?.canonicalTable || tables.has(policy.canonicalTable)) throw new Error('DATA_TABLE_DUPLICATE');
    if (!VALID_SCOPE_TYPES.has(policy.scopeType)) throw new Error('DATA_DOMAIN_INVALID_SCOPE');
    if (!VALID_DATA_CLASSES.has(policy.dataClass)) throw new Error('DATA_DOMAIN_INVALID_CLASS');
    if (!VALID_BACKUP_DISPOSITIONS.has(policy.backup)) throw new Error('DATA_DOMAIN_INVALID_BACKUP'); if (!VALID_ORDINARY_CACHE_CLEAR_DISPOSITIONS.has(ordinaryCacheClear)) throw new Error('DATA_DOMAIN_INVALID_ORDINARY_CACHE_CLEAR');
    if (!Number.isSafeInteger(Number(schemaVersion)) || Number(schemaVersion) < 1) {
      throw new Error('DATA_DOMAIN_SCHEMA_VERSION_INVALID');
    }
    if (!Array.isArray(policy.primaryKey) || !policy.primaryKey.length) throw new Error('DATA_DOMAIN_PRIMARY_KEY_REQUIRED');
    if (policy.legacyPrimaryKeys && typeof policy.legacyPrimaryKeys !== 'object') {
      throw new Error('DATA_DOMAIN_LEGACY_PRIMARY_KEY_INVALID');
    }
    for (const [version, primaryKey] of Object.entries(policy.legacyPrimaryKeys || {})) {
      if (!Number.isSafeInteger(Number(version)) || Number(version) < 1 || Number(version) >= Number(schemaVersion)) {
        throw new Error('DATA_DOMAIN_LEGACY_SCHEMA_VERSION_INVALID');
      }
      if (!Array.isArray(primaryKey) || !primaryKey.length) throw new Error('DATA_DOMAIN_LEGACY_PRIMARY_KEY_INVALID');
      if (policy.scopeType === 'shop' && primaryKey[0] !== 'shop_id') {
        throw new Error('DATA_DOMAIN_LEGACY_SHOP_SCOPE_KEY_REQUIRED');
      }
    }
    if (policy.scopeType === 'shop' && policy.primaryKey[0] !== 'shop_id') throw new Error('DATA_DOMAIN_SHOP_SCOPE_KEY_REQUIRED');
    if ((policy.dataClass === 'cache' || policy.dataClass === 'runtime') && policy.backup !== 'excluded') {
      throw new Error('DATA_DOMAIN_REBUILDABLE_MUST_NOT_BACKUP');
    }
    if (policy.dataClass === 'secret' && policy.backup !== 'required') throw new Error('DATA_DOMAIN_SECRET_BACKUP_REQUIRED'); if (ordinaryCacheClear === 'delete' && (policy.dataClass !== 'cache' || policy.backup !== 'excluded' || policy.rebuildable !== true)) throw new Error('DATA_DOMAIN_ORDINARY_CACHE_CLEAR_UNSAFE'); for (const field of DATA_DOMAIN_LIFECYCLE_FIELDS) { if (typeof policy[field] !== 'string' || !policy[field].trim()) throw new Error(`DATA_DOMAIN_LIFECYCLE_REQUIRED:${policy.domain}:${field}`); }
    domains.add(policy.domain);
    tables.add(policy.canonicalTable);
  }
  return { ok: true, domains: domains.size, tables: tables.size };
}

const validation = validateDataDomainRegistry();
if (!validation.ok) throw new Error('DATA_DOMAIN_REGISTRY_INVALID');

const BY_DOMAIN = new Map(DATA_DOMAIN_REGISTRY.map((policy) => [policy.domain, policy]));
const BY_TABLE = new Map(DATA_DOMAIN_REGISTRY.map((policy) => [policy.canonicalTable, policy]));

export function getDataDomain(domain) {
  const policy = BY_DOMAIN.get(String(domain || '').trim());
  if (!policy) throw new Error('DATA_DOMAIN_UNREGISTERED');
  return policy;
}

/** Returns the authenticated recovery record key shape for one registered schema version. */
export function getDataDomainPrimaryKeyForSchemaVersion(policy, schemaVersion = policy?.schemaVersion) {
  const version = Number(schemaVersion);
  if (!policy || !Number.isSafeInteger(version) || version < 1) {
    throw new Error('DATA_DOMAIN_SCHEMA_VERSION_UNSUPPORTED');
  }
  if (version === Number(policy.schemaVersion)) return policy.primaryKey;
  const legacy = policy.legacyPrimaryKeys?.[version];
  if (Array.isArray(legacy) && legacy.length) return legacy;
  throw new Error('DATA_DOMAIN_SCHEMA_VERSION_UNSUPPORTED');
}

export function getDataDomainForTable(tableName) {
  return BY_TABLE.get(String(tableName || '').trim()) || null;
}

function lifecycleFor(policy) {
  if (policy.dataClass === 'runtime') return 'runtime';
  if (policy.dataClass === 'cache') return 'cache';
  return 'preserve';
}

export function getStorageTableClassificationForPolicy(policy) {
  if (!policy) {
    return {
      registered: false,
      domain: null,
      ownerScope: 'unclassified',
      lifecycle: 'unclassified',
      dataClass: null,
      source: null,
      backup: null,
      rebuildable: null,
      ordinaryCacheClear: null,
    };
  }
  return {
    registered: true,
    domain: policy.domain,
    ownerScope: policy.scopeType,
    lifecycle: lifecycleFor(policy),
    dataClass: policy.dataClass,
    source: policy.source,
    backup: policy.backup,
    rebuildable: policy.rebuildable === true,
    ordinaryCacheClear: policy.ordinaryCacheClear,
  };
}

/**
 * Public, value-free ownership metadata for storage audits and recovery planning.
 * Unknown tables deliberately remain unclassified instead of inheriting the active shop.
 */
export function getStorageTableClassification(tableName) {
  return getStorageTableClassificationForPolicy(getDataDomainForTable(tableName));
}

export function classifyStorageTable(tableName) {
  const policy = getDataDomainForTable(tableName);
  if (!policy) return 'unclassified';
  if (policy.dataClass === 'runtime') return 'technical_runtime';
  if (policy.dataClass === 'cache') return 'business_cache';
  if (policy.dataClass === 'fact' && policy.source === 'ozon') return 'canonical_fact';
  if (policy.scopeType === 'system') return 'system_schema';
  return 'manual_account';
}

export function compareDataDomainRestoreOrder(left, right) {
  const priorityDifference = Number(left?.restorePriority ?? 100) - Number(right?.restorePriority ?? 100);
  if (priorityDifference !== 0) return priorityDifference;
  return String(left?.domain || '').localeCompare(String(right?.domain || ''));
}

/**
 * Loads the physical-resource extension without introducing an initialization
 * cycle: the account ownership catalog itself is derived from this table
 * registry.  Callers that plan deletion/maintenance must use the unified view
 * rather than inventing a second file or memory allowlist.
 */
export async function loadUnifiedDataResourceRegistry() {
  const registry = await import('./unifiedDataResourceRegistry.js');
  return {
    version: registry.DATA_RESOURCE_REGISTRY_VERSION,
    resources: registry.DATA_RESOURCE_REGISTRY,
    validation: registry.DATA_RESOURCE_REGISTRY_VALIDATION,
  };
}
