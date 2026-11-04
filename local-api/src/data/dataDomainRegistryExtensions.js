const EXTENSION_SOURCE = 'local-api/src/data/dataDomainRegistryExtensions.js';

const REQUIRED_LIFECYCLE_FIELDS = Object.freeze([
  'retentionPolicy',
  'cachePolicy',
  'syncPolicy',
  'accountRemovalDisposition',
  'spaceReleaseDisposition',
  'domainRebuildDisposition',
  'rebuildStrategy',
  'provenancePolicy',
]);

function policy(input) {
  const value = {
    schemaVersion: 1,
    containsPii: false,
    ordinaryCacheClear: 'preserve',
    restorePriority: 100,
    physicalResourceType: 'sqlite-table',
    ...input,
    registryExtensionSource: EXTENSION_SOURCE,
  };
  if (!value.domain || !value.canonicalTable || !Array.isArray(value.primaryKey) || !value.primaryKey.length) {
    throw new Error('DATA_DOMAIN_EXTENSION_IDENTITY_INVALID');
  }
  if (value.ordinaryCacheClear !== 'preserve') {
    throw new Error('DATA_DOMAIN_EXTENSION_ORDINARY_CACHE_CLEAR_FORBIDDEN');
  }
  for (const field of REQUIRED_LIFECYCLE_FIELDS) {
    if (typeof value[field] !== 'string' || !value[field].trim()) {
      throw new Error(`DATA_DOMAIN_EXTENSION_LIFECYCLE_REQUIRED:${value.domain}:${field}`);
    }
  }
  if (value.scopeType === 'shop' && value.primaryKey[0] !== 'shop_id') {
    throw new Error(`DATA_DOMAIN_EXTENSION_SHOP_KEY_REQUIRED:${value.domain}`);
  }
  if (
    (value.scopeType === 'profile' && value.accountRemovalDisposition !== 'preserve')
    || (value.scopeType === 'shop' && value.accountRemovalDisposition !== 'delete-with-shop')
  ) {
    throw new Error(`DATA_DOMAIN_EXTENSION_ACCOUNT_REMOVAL_INVALID:${value.domain}`);
  }
  return Object.freeze({
    ...value,
    primaryKey: Object.freeze([...value.primaryKey]),
    ...(Array.isArray(value.optionalBackupIncludedColumns)
      ? { optionalBackupIncludedColumns: Object.freeze([...value.optionalBackupIncludedColumns]) }
      : {}),
  });
}

const SHOP_RUNTIME = Object.freeze({
  scopeType: 'shop',
  dataClass: 'runtime',
  source: 'system',
  backup: 'excluded',
  rebuildable: true,
  accountRemovalDisposition: 'delete-with-shop',
  cachePolicy: 'not-cache; preserve during ordinary cache clear',
  spaceReleaseDisposition: 'explicit-runtime-retention-only',
  domainRebuildDisposition: 'recreate-from-a-new-scoped-run',
});

const SHOP_OZON_FACT = Object.freeze({
  scopeType: 'shop',
  dataClass: 'fact',
  source: 'ozon',
  backup: 'optional',
  rebuildable: true,
  accountRemovalDisposition: 'delete-with-shop',
  retentionPolicy: 'retain-current-canonical-fact-while-shop-exists',
  cachePolicy: 'canonical-sqlite-fact; never ordinary-cache-clear',
  syncPolicy: 'activate-only-after-run-proof-and-transactional-snapshot-commit',
  spaceReleaseDisposition: 'never-space-release; only-domain-rebuild-or-shop-delete',
  domainRebuildDisposition: 'preview-confirm-resync-stage-proof-activate',
  rebuildStrategy: 'rehydrate-from-ozon-with-contract-and-provenance-proof',
  provenancePolicy: 'operation-contract-mapper-responseHash-run-snapshot-observedAt',
  restorePriority: 30,
});

const SHARED_CATALOG_FACT = Object.freeze({
  scopeType: 'profile',
  dataClass: 'fact',
  source: 'ozon',
  backup: 'excluded',
  rebuildable: true,
  accountRemovalDisposition: 'preserve',
  retentionPolicy: 'retain-active-contract-version-and-reviewed-predecessors',
  cachePolicy: 'shared-canonical-catalog; never ordinary-cache-clear',
  syncPolicy: 'seed-or-remote-import-by-platform-marketplace-locale-contract-version',
  spaceReleaseDisposition: 'explicit-shared-catalog-retention-only',
  domainRebuildDisposition: 'reseed-packaged-catalog-then-remote-reconcile',
  rebuildStrategy: 'stable-key-and-content-hash-dedupe-with-conflict-quarantine',
  provenancePolicy: 'source-kind-source-ref-hash-import-contract-mapper-content-hash',
});

export const DATA_DOMAIN_REGISTRY_EXTENSION_INPUTS = Object.freeze([
  policy({
    domain: 'shop-identity-tombstones',
    scopeType: 'profile',
    dataClass: 'fact',
    source: 'system',
    canonicalTable: 'shop_identity_tombstones',
    primaryKey: ['tombstone_id'],
    backup: 'excluded',
    rebuildable: false,
    retentionPolicy: 'retain-for-profile-lifetime-or-explicit-audit-retention-change',
    cachePolicy: 'canonical-deletion-audit; never ordinary-cache-clear',
    syncPolicy: 'write-only-after-verified-shop-deletion-transaction',
    accountRemovalDisposition: 'preserve',
    spaceReleaseDisposition: 'never-automatic-space-release',
    domainRebuildDisposition: 'not-rebuildable; never-derived-from-active-shop-row',
    rebuildStrategy: 'none',
    provenancePolicy: 'profile-former-shop-incarnation-credential-revision-deletion-operation',
  }),
  policy({
    ...SHOP_RUNTIME,
    domain: 'shop-bootstrap-runs',
    canonicalTable: 'shop_bootstrap_runs',
    primaryKey: ['shop_id', 'run_id'],
    retentionPolicy: 'retain-active-runs-and-bounded-terminal-bootstrap-evidence',
    syncPolicy: 'persistent-bootstrap-state-machine-with-incarnation-and-credential-fence',
    rebuildStrategy: 'enqueue-new-bootstrap-for-current-shop-incarnation',
    provenancePolicy: 'profile-shop-incarnation-credential-revision-proof-hash',
    restorePriority: 80,
  }),
  policy({
    ...SHOP_RUNTIME,
    domain: 'shop-domain-sync-state',
    canonicalTable: 'shop_domain_sync_state',
    primaryKey: ['shop_id', 'profile_id', 'shop_incarnation', 'domain'],
    retentionPolicy: 'retain-current-incarnation-state-until-shop-delete-or-new-incarnation',
    syncPolicy: 'domain-completion-only-after-current-incarnation-proof-and-activation',
    rebuildStrategy: 'derive-by-running-current-incarnation-bootstrap-domains',
    provenancePolicy: 'profile-shop-incarnation-credential-revision-bootstrap-snapshot-cursor-proof',
    restorePriority: 81,
  }),
  policy({
    domain: 'purchase-completion-history',
    scopeType: 'shop',
    dataClass: 'fact',
    source: 'user',
    canonicalTable: 'purchase_completion_history',
    primaryKey: ['shop_id', 'source_receipt_id'],
    backup: 'required',
    storageAdapter: 'profile-core',
    recoveryChannel: 'profile-core',
    rebuildable: false,
    containsPii: true,
    retentionPolicy: 'retain-completed-purchase-evidence-while-ozon-shop-exists',
    cachePolicy: 'canonical-encrypted-business-fact; never ordinary-cache-clear',
    syncPolicy: 'dual-write-in-the-same-transaction-as-verified-website-readback',
    accountRemovalDisposition: 'delete-with-shop',
    spaceReleaseDisposition: 'never-space-release; only-corresponding-shop-delete',
    domainRebuildDisposition: 'not-rebuildable; restore-from-required-shop-backup',
    rebuildStrategy: 'restore-encrypted-canonical-history-or-idempotently-archive-legacy-completions',
    provenancePolicy: 'shop-receipt-readback-order-product-source-account-hash-completion-time',
    restorePriority: 15,
  }),

  policy({
    ...SHARED_CATALOG_FACT,
    domain: 'shared-catalog-versions',
    canonicalTable: 'shared_catalog_versions',
    primaryKey: ['catalog_id'],
  }),
  policy({
    scopeType: 'profile',
    dataClass: 'runtime',
    source: 'system',
    domain: 'shared-catalog-import-runs',
    canonicalTable: 'shared_catalog_import_runs',
    primaryKey: ['import_id'],
    backup: 'excluded',
    rebuildable: true,
    retentionPolicy: 'retain-active-and-bounded-terminal-import-evidence',
    cachePolicy: 'not-cache; preserve during ordinary cache clear',
    syncPolicy: 'single-import-run-per-content-hash-with-terminal-counts',
    accountRemovalDisposition: 'preserve',
    spaceReleaseDisposition: 'explicit-shared-catalog-runtime-retention-only',
    domainRebuildDisposition: 'create-new-import-run',
    rebuildStrategy: 'rerun-seed-or-remote-import',
    provenancePolicy: 'catalog-source-kind-source-shop-summary-source-ref-hash-payload-hash',
  }),
  policy({ ...SHARED_CATALOG_FACT, domain: 'shared-catalog-categories', canonicalTable: 'shared_catalog_categories', primaryKey: ['catalog_id', 'category_id'] }),
  policy({ ...SHARED_CATALOG_FACT, domain: 'shared-catalog-types', canonicalTable: 'shared_catalog_types', primaryKey: ['catalog_id', 'category_id', 'type_id'] }),
  policy({ ...SHARED_CATALOG_FACT, domain: 'shared-catalog-attributes', canonicalTable: 'shared_catalog_attributes', primaryKey: ['catalog_id', 'category_id', 'type_id', 'attribute_id'] }),
  policy({ ...SHARED_CATALOG_FACT, domain: 'shared-catalog-attribute-values', canonicalTable: 'shared_catalog_attribute_values', primaryKey: ['catalog_id', 'category_id', 'type_id', 'attribute_id', 'value_id'] }),
  policy({ ...SHARED_CATALOG_FACT, source: 'system', domain: 'shared-catalog-entity-sources', canonicalTable: 'shared_catalog_entity_sources', primaryKey: ['catalog_id', 'entity_kind', 'stable_key', 'content_hash', 'source_ref_hash'] }),
  policy({
    ...SHARED_CATALOG_FACT,
    source: 'system',
    domain: 'shared-catalog-quarantine',
    canonicalTable: 'shared_catalog_quarantine',
    primaryKey: ['quarantine_id'],
    rebuildable: false,
    retentionPolicy: 'retain-until-explicit-conflict-resolution',
    domainRebuildDisposition: 'not-automatically-rebuildable',
    rebuildStrategy: 'manual-resolution-or-repeat-import-from-preserved-source',
    provenancePolicy: 'stable-key-existing-and-incoming-hashes-source-ref-import-resolution',
  }),

  policy({
    ...SHOP_RUNTIME,
    domain: 'product-sync-runs',
    canonicalTable: 'product_sync_runs',
    primaryKey: ['shop_id', 'id'],
    retentionPolicy: 'retain-active-leases-and-bounded-terminal-run-proofs',
    syncPolicy: 'singleflight-lease-fetch-prove-activate-terminal-state-machine',
    rebuildStrategy: 'enqueue-new-scoped-product-run',
    provenancePolicy: 'shop-incarnation-credential-contract-mapper-request-fingerprint-proof',
    restorePriority: 70,
  }),
  policy({
    ...SHOP_RUNTIME,
    domain: 'product-sync-stage-batches',
    canonicalTable: 'product_sync_stage_batches',
    primaryKey: ['shop_id', 'run_id', 'batch_key'],
    retentionPolicy: 'retain-until-run-terminal-retention-expires',
    syncPolicy: 'run-scoped-staging-only-never-active-query-source',
    rebuildStrategy: 'refetch-batch-under-new-run',
    provenancePolicy: 'endpoint-facet-expected-actual-response-contract-mapper-hashes',
    restorePriority: 71,
  }),
  policy({
    ...SHOP_RUNTIME,
    domain: 'product-sync-page-proofs',
    canonicalTable: 'product_sync_page_proofs',
    primaryKey: ['shop_id', 'run_id', 'visibility', 'page_index'],
    retentionPolicy: 'retain-with-parent-run-proof-retention',
    syncPolicy: 'prove-cursor-sequence-short-page-and-terminal-page-per-visibility',
    rebuildStrategy: 'refetch-all-pages-under-new-run',
    provenancePolicy: 'cursor-page-count-limit-terminal-response-contract-mapper',
    restorePriority: 72,
  }),
  policy({
    ...SHOP_RUNTIME,
    domain: 'product-sync-outbox',
    canonicalTable: 'product_sync_outbox',
    primaryKey: ['shop_id', 'event_id'],
    retentionPolicy: 'retain-pending-until-published-and-bound-published-history',
    syncPolicy: 'write-in-same-activation-transaction-then-idempotently-publish',
    rebuildStrategy: 'derive-new-event-only-from-a-new-successful-activation',
    provenancePolicy: 'run-snapshot-event-payload-hash-attempt-status',
    restorePriority: 73,
  }),
  policy({
    ...SHOP_RUNTIME,
    domain: 'product-sync-quarantine',
    canonicalTable: 'product_sync_quarantine',
    primaryKey: ['shop_id', 'id'],
    retentionPolicy: 'retain-until-explicit-review-or-bounded-diagnostic-retention',
    syncPolicy: 'fail-closed-isolation-for-invalid-or-ambiguous-sync-evidence',
    rebuildStrategy: 'repeat-source-read-after-contract-or-identity-repair',
    provenancePolicy: 'shop-run-endpoint-reason-evidence-hash',
    restorePriority: 74,
  }),

  policy({
    ...SHOP_OZON_FACT,
    domain: 'product-identities',
    canonicalTable: 'product_identities',
    primaryKey: ['shop_id', 'product_identity_id'],
    backup: 'required',
    retentionPolicy: 'retain-identity-while-shop-exists; required-by-user-dimension-recovery',
    rebuildStrategy: 'restore-before-dependent-user-facts-or-rehydrate-from-ozon',
    provenancePolicy: 'product-offer-sku-source-operation-contract-mapper-response-run-snapshot-row-hash',
    restorePriority: 10,
  }),
  policy({ ...SHOP_OZON_FACT, domain: 'product-status-facts', canonicalTable: 'product_status_facts', primaryKey: ['shop_id', 'product_identity_id'] }),
  policy({ ...SHOP_OZON_FACT, domain: 'product-detail-facts', canonicalTable: 'product_detail_facts', primaryKey: ['shop_id', 'product_identity_id'] }),
  policy({
    ...SHOP_OZON_FACT,
    domain: 'product-dimension-facts',
    source: 'user',
    canonicalTable: 'product_dimension_facts',
    primaryKey: ['shop_id', 'product_identity_id', 'source_type'],
    backup: 'required',
    rebuildable: false,
    retentionPolicy: 'retain-all-sources-while-shop-exists; user-supplier-cross-border-values-never-auto-expire',
    syncPolicy: 'row-source-priority; weak-ozon-or-null-never-overwrites-strong-source',
    domainRebuildDisposition: 'ozon-source-may-rehydrate; user-supplier-cross-border-source-must-restore',
    rebuildStrategy: 'restore-source-typed-rows-before-ozon-reconcile',
    provenancePolicy: 'source-type-priority-operation-contract-mapper-response-run-snapshot-row-hash',
    restorePriority: 20,
  }),
  policy({ ...SHOP_OZON_FACT, domain: 'product-price-facts', canonicalTable: 'product_price_facts', primaryKey: ['shop_id', 'product_identity_id'] }),
  policy({ ...SHOP_OZON_FACT, domain: 'product-commission-facts', canonicalTable: 'product_commission_facts', primaryKey: ['shop_id', 'product_identity_id', 'fulfillment_type'] }),
  policy({ ...SHOP_OZON_FACT, domain: 'product-acquiring-facts', canonicalTable: 'product_acquiring_facts', primaryKey: ['shop_id', 'product_identity_id'] }),
  policy({ ...SHOP_OZON_FACT, domain: 'product-stock-facts', canonicalTable: 'product_stock_facts', primaryKey: ['shop_id', 'product_identity_id'] }),
  policy({ ...SHOP_OZON_FACT, domain: 'product-warehouse-stock-facts', canonicalTable: 'product_warehouse_stock_facts', primaryKey: ['shop_id', 'product_identity_id', 'warehouse_key'] }),
  policy({ ...SHOP_OZON_FACT, domain: 'product-image-facts', canonicalTable: 'product_image_facts', primaryKey: ['shop_id', 'product_identity_id', 'image_index'] }),
  policy({ ...SHOP_OZON_FACT, domain: 'product-attribute-facts', canonicalTable: 'product_attribute_facts', primaryKey: ['shop_id', 'product_identity_id'], optionalBackupIncludedColumns: ['attributes_json'] }),
  policy({ ...SHOP_OZON_FACT, domain: 'product-facet-observations', canonicalTable: 'product_facet_observations', primaryKey: ['shop_id', 'product_identity_id', 'facet'] }),
]);

export const DATA_DOMAIN_REGISTRY_EXTENSION_TABLES = Object.freeze(
  DATA_DOMAIN_REGISTRY_EXTENSION_INPUTS.map((entry) => entry.canonicalTable),
);
