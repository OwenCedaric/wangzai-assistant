/**
 * 桌面 profile 的普通清缓存白名单。
 *
 * “远端可以重新读取”不等于“普通清缓存可以删除”。商品、订单、佣金、
 * 价格、库存、材积、财务、售后、类目字典、同步游标、用户配置和审计记录
 * 都属于受保护数据。只有已经证明删除后不会让页面丢字段、不会触发远端
 * 重建、也不会改变用户事实的响应/索引缓存，才允许进入 clearable。
 */
export const PROFILE_CACHE_POLICY_VERSION = "profile-cache-policy-v5";

// Created lazily by shopProductStorage, not by the base SQL migrations. It is
// an authoritative mutation counter, never a response cache. Older/unopened
// profiles may lack it; whenever present it must be fingerprint-protected.
export const OPTIONAL_PROTECTED_PROFILE_TABLES = Object.freeze([
  'shop_product_storage_revisions',
]);

/**
 * 四类维护动作必须使用四个互不相同的入口、确认口令和资源边界。
 *
 * 本文件只描述边界，不把“释放空间 / 领域重建 / 永久删除”偷渡进普通清缓存。
 * 其余命令由独立 local-api service / account orchestrator 实现；profileCacheMaintenance 只能接受
 * CLEAR_TRANSIENT_CACHE。
 */
export const PROFILE_MAINTENANCE_COMMANDS = Object.freeze({
  CLEAR_TRANSIENT_CACHE: "clear-transient-cache",
  RELEASE_SPACE: "release-space",
  REBUILD_DOMAIN: "rebuild-domain",
  PERMANENT_DELETE: "permanent-delete",
});

export const PROFILE_MAINTENANCE_COMMAND_CONTRACTS = Object.freeze({
  [PROFILE_MAINTENANCE_COMMANDS.CLEAR_TRANSIENT_CACHE]: Object.freeze({
    confirmation: "CLEAR_TRANSIENT_PROFILE_CACHE_ONLY",
    owner: "desktop/profileCacheMaintenance",
    destructiveScope: "explicit-transient-cache-whitelist-only",
    mayDeleteCanonicalFacts: false,
    mayDeleteAccountData: false,
    mayRebuildFromRemote: false,
  }),
  [PROFILE_MAINTENANCE_COMMANDS.RELEASE_SPACE]: Object.freeze({
    confirmation: "RELEASE_RETIRED_PROFILE_SPACE_ONLY",
    owner: "local-api/profileMaintenanceCommandService.releaseSpace",
    destructiveScope: "unified-registry-approved-derived-sqlite-cache-only",
    mayDeleteCanonicalFacts: false,
    mayDeleteAccountData: false,
    mayRebuildFromRemote: false,
  }),
  [PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN]: Object.freeze({
    confirmation: "REBUILD_ONE_PROFILE_DOMAIN_FROM_SOURCE_ONLY",
    owner: "local-api/profileMaintenanceCommandService.rebuildDomain",
    destructiveScope: "one-domain-staging-and-atomic-activation-only",
    mayDeleteCanonicalFacts: false,
    mayDeleteAccountData: false,
    mayRebuildFromRemote: true,
  }),
  [PROFILE_MAINTENANCE_COMMANDS.PERMANENT_DELETE]: Object.freeze({
    confirmation: "PERMANENTLY_DELETE_ONE_ACCOUNT_PROFILE_ONLY",
    owner: "account-lifecycle-orchestrator",
    destructiveScope: "one-confirmed-account-owned-resource-closure-only",
    mayDeleteCanonicalFacts: true,
    mayDeleteAccountData: true,
    mayRebuildFromRemote: false,
  }),
});

export function assertProfileMaintenanceCommandBoundary(
  command,
  expectedCommand = PROFILE_MAINTENANCE_COMMANDS.CLEAR_TRANSIENT_CACHE,
) {
  const normalized = String(command || "").trim();
  if (!PROFILE_MAINTENANCE_COMMAND_CONTRACTS[normalized]) {
    throw new Error(`未知 profile 维护命令：${normalized || "空"}`);
  }
  if (normalized !== expectedCommand) {
    const owner = PROFILE_MAINTENANCE_COMMAND_CONTRACTS[normalized].owner;
    throw new Error(
      `profile 维护命令边界错误：${normalized} 必须由 ${owner} 独立执行，不能进入普通清缓存`,
    );
  }
  return PROFILE_MAINTENANCE_COMMAND_CONTRACTS[normalized];
}

/**
 * 普通清缓存唯一允许 DELETE 的 SQLite 表，顺序按依赖关系排列。
 */
export const ORDINARY_CLEARABLE_CACHE_TABLES = Object.freeze([
  "ozon_response_cache",
  "ozon_cache_keys",
]);

/**
 * 普通清缓存必须逐表做前后指纹校验的表。
 *
 * 这里有意包含 Ozon 事实、派生快照和运行状态：只有未来存在经过验收的
 * “领域重建”命令时，才能由该命令通过 staging + proof + 原子激活替换；
 * 不能因为 dataClass/rebuildable/cache 等名称被普通清缓存直接删除。
 */
export const PROTECTED_PROFILE_TABLES = Object.freeze([
  "account_removal_operations",
  "catalog_attribute_values",
  "catalog_attributes",
  "catalog_cache_key_registry",
  "catalog_cache_sync_state",
  "catalog_category_mappings",
  "catalog_category_nodes",
  "customer_service_push_view_markers",
  "cross_border_accounts", "cross_border_account_shop_bindings", "cross_border_charge_links", "cross_border_charge_records",
  "cross_border_order_records",
  "data_backup_exports",
  "data_backup_imports",
  "data_backup_owner_imports",
  "data_analysis_snapshots",
  "data_analysis_sync_state",
  "exchange_rate_cache",
  "follow_seller_action_attempts",
  "follow_seller_cases",
  "follow_seller_login_preferences",
  "follow_seller_patrol_runs",
  "historical_import_rows",
  "historical_import_runs",
  "historical_order_facts",
  "historical_order_import_rows",
  "historical_order_import_runs",
  "integration_credentials",
  "integration_profiles",
  "legacy_browser_observation_batches",
  "legacy_browser_observation_days",
  "legacy_browser_observation_sessions",
  "legacy_browser_read_key_days",
  "marketing_view_state",
  "model_api_accounts",
  "ozon_analytics_daily",
  "ozon_cache_merge_log",
  "ozon_circuit_breakers",
  "ozon_error_events",
  "ozon_finance_balance_snapshots",
  "ozon_finance_statement_reports",
  "ozon_finance_transactions",
  "ozon_marketing_activities",
  "ozon_marketing_activity_products",
  "ozon_notification_events",
  "ozon_notification_settings",
  "ozon_order_split_relations",
  "ozon_orders",
  "ozon_products",
  "ozon_rate_limit_state",
  "ozon_rating_penalties",
  "ozon_request_attempts",
  "ozon_request_jobs",
  "ozon_scheduler_trace_events",
  "ozon_shop_runtime_state",
  "ozon_sync_locks",
  "ozon_sync_snapshots",
  "ozon_sync_state",
  "ozon_returns",
  "ozon_write_audit_log",
  "performance_accounts",
  "product_acquiring_facts",
  "product_attribute_facts",
  "product_commission_facts",
  "product_detail_facts",
  "product_dimension_facts",
  "product_facet_observations",
  "product_identities",
  "product_image_assets",
  "product_image_health",
  "product_image_facts",
  "product_image_usage_events",
  "product_manual_cost_profiles",
  "product_material_profiles",
  "product_price_facts",
  "product_source_links",
  "product_status_facts",
  "product_stock_facts",
  "product_sync_outbox",
  "product_sync_page_proofs",
  "product_sync_quarantine",
  "product_sync_runs",
  "product_sync_stage_batches",
  "product_warehouse_stock_facts",
  "profile_assets",
  "profile_settings",
  "profit_ledger_snapshots",
  "profit_ledger_owner_routes",
  "purchase_accounts",
  "purchase_browser_plugin_state",
  "purchase_browser_receipts",
  "purchase_browser_tasks",
  "purchase_completion_history",
  "purchase_order_overrides",
  "purchase_source_links",
  "recovery_local_state",
  "recovery_reconcile_state",
  "sales_source_links",
  "shared_catalog_attribute_values",
  "shared_catalog_attributes",
  "shared_catalog_categories",
  "shared_catalog_entity_sources",
  "shared_catalog_import_runs",
  "shared_catalog_quarantine",
  "shared_catalog_types",
  "shared_catalog_versions",
  "shop_bootstrap_runs",
  "shop_domain_sync_state",
  "shop_identity_tombstones",
  "shops",
  "sync_jobs",
  "sync_state",
]);

export const PROFILE_SCHEMA_TABLES = Object.freeze(["schema_migrations"]);

/**
 * 只有纯技术读取日志允许被普通清缓存删除。商品镜像、浏览器旧存储、售后、
 * 利润和营销 JSON 即使属于待退役副本，也必须留给独立迁移/退役命令处理。
 */
export const ORDINARY_CLEARABLE_LOCAL_DATA_FILES = Object.freeze([
  "本地数据/分类缓存/14-失败重试/local-mirror-read-log.json",
]);

export const PROTECTED_LOCAL_DATA_FILES = Object.freeze([
  "本地数据/商品资料/ozon-local-data-layer.json",
  "本地数据/settings/browser-local-storage.json",
  "本地数据/分类缓存/09-售后订单/after-sales-display-snapshots.json",
  "本地数据/分类缓存/10-利润核算/profit-local-cache.json",
  "本地数据/分类缓存/12-营销活动/marketing-activity-cache.json",
  "本地数据/分类缓存/14-失败重试/local-mirror-retry-queue.json",
]);

/**
 * Electron 的纯渲染/网络缓存。Cookies、Local Storage、Session Storage、
 * blob_storage、license、runtime、backups 和 purchase-browser 均不在白名单。
 */
export const ORDINARY_CLEARABLE_ELECTRON_CACHE_DIRECTORIES = Object.freeze([
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "ShaderCache",
  "GrShaderCache",
  "Service Worker/CacheStorage",
  "Shared Dictionary/cache",
]);

export const PROTECTED_ELECTRON_STORAGE_DIRECTORIES = Object.freeze([
  "blob_storage",
  "Local Storage",
  "Session Storage",
]);

/**
 * 这些是旧数据世界/密钥/维护记录，不是缓存。普通清缓存只观察并校验指纹，
 * 不迁移、不压缩、不删除；它们只能由独立的受控迁移或释放空间命令处理。
 */
export const PROTECTED_RETIRED_WORKSPACE_FILES = Object.freeze([
  "local-api/data/wangzai-local-api.sqlite",
  "local-api/data/wangzai-local-api.sqlite-wal",
  "local-api/data/wangzai-local-api.sqlite-shm",
  "local-api/data/local-api-secret.key",
]);

export const PROTECTED_RETIRED_WORKSPACE_DIRECTORIES = Object.freeze([
  "local-api/data/maintenance-runtime",
]);

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  values.forEach((value) => {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  });
  return [...duplicates].sort();
}

export function getProfileCacheTableClassification() {
  return {
    clearable: [...ORDINARY_CLEARABLE_CACHE_TABLES],
    protected: [...PROTECTED_PROFILE_TABLES, ...OPTIONAL_PROTECTED_PROFILE_TABLES],
    schema: [...PROFILE_SCHEMA_TABLES],
  };
}

/**
 * 对真实 schema 做封闭世界校验。新增表未明确归入 clearable/protected/schema
 * 时直接拒绝执行；未知资源永远不能因为名字里含 cache 就被猜测删除。
 */
export function assertCompleteProfileCacheTableClassification(tableNames = []) {
  const actual = [...new Set(tableNames.map((name) => String(name || "").trim()).filter(Boolean))].sort();
  const classified = [
    ...ORDINARY_CLEARABLE_CACHE_TABLES,
    ...PROTECTED_PROFILE_TABLES,
    ...OPTIONAL_PROTECTED_PROFILE_TABLES,
    ...PROFILE_SCHEMA_TABLES,
  ];
  const duplicates = duplicateValues(classified);
  if (duplicates.length) {
    throw new Error(`缓存表分级存在重复：${duplicates.join(", ")}`);
  }
  const classifiedSet = new Set(classified);
  const actualSet = new Set(actual);
  const unclassified = actual.filter((name) => !classifiedSet.has(name));
  const optionalProtected = new Set(OPTIONAL_PROTECTED_PROFILE_TABLES);
  const missing = classified.filter((name) => !actualSet.has(name) && !optionalProtected.has(name)).sort();
  if (unclassified.length || missing.length) {
    throw new Error(
      `缓存表分级与 schema 不一致；未分级=${unclassified.join(", ") || "无"}；缺失=${missing.join(", ") || "无"}`,
    );
  }
  return true;
}
