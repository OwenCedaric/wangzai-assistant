import { createHash } from 'node:crypto';

// Re-reviewed in docs/CI_REPAIR_REVIEW.md. These exact source bindings explain
// discovered state, not new deletion resources or broad scanner exemptions.
export const CURRENT_DISCOVERY_REVIEW_VERSION = 'account-ownership-current-discovery-v1';
const records = [
  {
    "sourceFile": "desktop/scripts/profit-lanes-browser-host.cjs",
    "sourceSymbol": "timer",
    "kind": "set",
    "classification": "isolated-test-runtime",
    "reason": "Deadline for a guarded scratch-directory fixture; not loaded by the product entry point.",
    "sourceSHA256": "1A1915FD63F87958EF8F23EB43E292490F7B4BE20CC9B919FF9BBA54BE74CD8C",
    "requiredSourceStatements": [
      "assert.ok(directory && /[\\\\/]\\.managed-dev-scratch[\\\\/]run-[a-f0-9-]+[\\\\/]work[\\\\/]profit-browser$/i.test(directory));",
      "const timer = setTimeout(() => finish({ complete: false, error: 'FIXTURE_TIMEOUT' }), 180000);",
      "finished = true; clearTimeout(timer);"
    ],
    "supportingSources": []
  },
  {
    "sourceFile": "desktop/scripts/ui-update-electron-smoke.mjs",
    "sourceSymbol": "runtime",
    "kind": "state",
    "classification": "isolated-test-runtime",
    "reason": "Synthetic signed-update smoke harness; owns only its guarded fixture root.",
    "sourceSHA256": "E796A404F04863A36778ACB48C5BB81232F69482281A3DFAA8A1286CC541CAD9",
    "requiredSourceStatements": [
      "assert.equal(fixture.contract, 'wangzai-ui-native-fixture/v1');",
      "runtime.dispose(); window?.destroy(); app.exit(process.exitCode || 0);"
    ],
    "supportingSources": []
  },
  {
    "sourceFile": "desktop/src/main.js",
    "sourceSymbol": "uiUpdateRuntime",
    "kind": "state",
    "classification": "system-update-runtime",
    "reason": "Signed UI bundle lifecycle. Credentials are obtained per check and authorization scope is rechecked before staging; no shop rows retained.",
    "sourceSHA256": "110149476568DA9FD3BB5FE1F243910F228B97B8AA1E2B8F24FCAEABD78753E4",
    "requiredSourceStatements": [
      "const uiUpdateRuntime = createUiUpdateRuntime({",
      "uiUpdateRuntime.dispose();"
    ],
    "supportingSources": [
      {
        "sourceFile": "desktop/src/updates/uiUpdateRuntime.js",
        "sourceSHA256": "1AC45A27692D5B93E4A1942C5724D825EA6ABEB5E21D268FF1D8124D3AB14206"
      }
    ]
  },
  {
    "sourceFile": "local-api/src/utils/storageUsage.js",
    "sourceSymbol": "storageUsageCache",
    "kind": "map",
    "classification": "profile-storage-metrics",
    "reason": "Ten-second filesystem size/count cache, keyed by database path; stores no account records or credentials.",
    "sourceSHA256": "1FBFF32160ACBC46D65DE99360A111BBB38EED36020CA8B3D31174EDA906E7FD",
    "requiredSourceStatements": [
      "const storageUsageCache = new Map();",
      "const STORAGE_USAGE_CACHE_TTL_MS = 10_000;",
      "if (cacheKey) storageUsageCache.set(cacheKey, { at: Date.now(), value });"
    ],
    "supportingSources": []
  },
  {
    "sourceFile": "frontend/src/entities/marketing/marketingActivityCache.jsx",
    "sourceSymbol": "marketingActivityRuntimeCacheStore",
    "kind": "state",
    "classification": "relocated-catalog-resource",
    "reason": "Existing mixed-owner marketing cache moved behind the original re-export; retain Catalog unknown ownership and fail-closed deletion policy.",
    "sourceSHA256": "FFE915C94BD522B4F990B85B6ACE9299567EA890E019BC800C888CFBA42AAC42",
    "requiredSourceStatements": [
      "export let marketingActivityRuntimeCacheStore = {};",
      "if (isMarketingActivityOwnerFenced(shop)) return false;"
    ],
    "supportingSources": [
      {
        "sourceFile": "local-api/src/domain/accountRemoval/accountOwnershipCatalog.js",
        "sourceSHA256": "2574361EF90FD4531060D8CF6EB8FEB09A53DEFD303C2966EBC21E0043F9D3B8"
      },
      {
        "sourceFile": "frontend/src/entities/order/orderShopScope.jsx",
        "sourceSHA256": "8D9EB59F710D89BEBB21B4403996A59B4BD0FC9E57506E1A2AF8AA0A05B8A827"
      }
    ],
    "catalogResourceId": "memory:renderer-marketing-activity-runtime-cache",
    "catalogEntrySHA256": "B7A79912E966F079E15F49A35AC6E6BB1BA0B76A3B10618316727133388814EF"
  },
  {
    "sourceFile": "frontend/src/entities/marketing/marketingActivityCache.jsx",
    "sourceSymbol": "marketingActivityViewStateWriteQueue",
    "kind": "promise",
    "classification": "relocated-catalog-resource",
    "reason": "Existing shared write queue moved behind the original re-export; still fence and drain the exact owner, never exempt queued business writes.",
    "sourceSHA256": "FFE915C94BD522B4F990B85B6ACE9299567EA890E019BC800C888CFBA42AAC42",
    "requiredSourceStatements": [
      "export let marketingActivityViewStateWriteQueue = Promise.resolve();",
      "const drain = await settleOwnerWriteDrain([marketingActivityViewStateWriteQueue, marketingActivityLastWrite]);",
      "assertMarketingActivityOwnerWritable(shop);"
    ],
    "supportingSources": [
      {
        "sourceFile": "local-api/src/domain/accountRemoval/accountOwnershipCatalog.js",
        "sourceSHA256": "2574361EF90FD4531060D8CF6EB8FEB09A53DEFD303C2966EBC21E0043F9D3B8"
      },
      {
        "sourceFile": "frontend/src/entities/order/orderShopScope.jsx",
        "sourceSHA256": "8D9EB59F710D89BEBB21B4403996A59B4BD0FC9E57506E1A2AF8AA0A05B8A827"
      }
    ],
    "catalogResourceId": "runtime:renderer-marketing-view-state-write-queue",
    "catalogEntrySHA256": "1428C7A09465D3EE6B159836E5CFFFEF8D6B989B0FFB34B728AA315D5F050781"
  }
];
export const CURRENT_DISCOVERY_REVIEWS = Object.freeze(records.map(record => Object.freeze({
  ...record,
  requiredSourceStatements: Object.freeze(record.requiredSourceStatements),
  supportingSources: Object.freeze(record.supportingSources.map(Object.freeze)),
})));

export const CATALOG_RELOCATION_REVIEWS = Object.freeze([
  ...CURRENT_DISCOVERY_REVIEWS.filter(record => record.catalogResourceId),
  Object.freeze({
    catalogResourceId: 'runtime:renderer-sales-orders-page-load',
    catalogEntrySHA256: '5097202BCEB81B18C96B258BB3D0044A6B966EAC850EC88AD75FF34BBE8607DF',
    sourceFile: 'frontend/src/appLazyRoutes.jsx', sourceSymbol: 'salesOrdersPageLoadPromise',
    sourceSHA256: '8CE82A3F12B80820847C17A32531EB3BF55761511C59A2DC9E9F1CC6F56EE617',
    requiredSourceStatements: Object.freeze([
      'export let salesOrdersPageLoadPromise = null;',
      "salesOrdersPageLoadPromise ??= import('./features/orders/sales/SalesOrdersPage.jsx');",
      'return salesOrdersPageLoadPromise;',
    ]),
    supportingSources: Object.freeze([Object.freeze({
      sourceFile: 'frontend/src/App.jsx',
      sourceSHA256: 'A2D42A814EF888E7FCAD3C90BE0CF546E1CB7971B082F3FB9030AA6FF70856A1',
    })]),
  }),
]);

function sourceBindingIntact(record, sourceByFile) {
  const intact = [record, ...record.supportingSources].every(binding => {
    const source = sourceByFile?.get(binding.sourceFile);
    return typeof source === 'string'
      && createHash('sha256').update(source).digest('hex').toUpperCase() === binding.sourceSHA256;
  });
  const lines = (sourceByFile?.get(record.sourceFile) || '').split(/\r\n|\n|\r/u).map(line => line.trim());
  return intact && record.requiredSourceStatements.every(statement => lines.includes(statement));
}

export function verifyCurrentDiscoveryReviews({ sourceByFile, discoveredStateFacts } = {}) {
  const verified = [];
  for (const record of CURRENT_DISCOVERY_REVIEWS) {
    const matches = (discoveredStateFacts || []).filter(fact =>
      fact.sourceFile === record.sourceFile && fact.sourceSymbol === record.sourceSymbol);
    // Partial scans used by negative tests need no unrelated records. A full
    // production scan separately asserts all six reviewed discoveries exist.
    if (!matches.length) continue;
    if (!sourceBindingIntact(record, sourceByFile) || matches.length !== 1 || matches[0].structured?.kind !== record.kind
      || matches[0].structured?.declaration !== record.sourceSymbol) {
      throw new Error(`ACCOUNT_OWNERSHIP_CURRENT_DISCOVERY_DRIFT:${record.sourceFile}:${record.sourceSymbol}`);
    }
    verified.push(Object.freeze({ ...record, discovery: matches[0] }));
  }
  return Object.freeze(verified);
}

export function resolveReviewedCatalogRelocation(entry, sourceByFile) {
  const record = CATALOG_RELOCATION_REVIEWS.find(review => review.catalogResourceId === entry?.id);
  if (!record) return null;
  // Bind the complete original resource, including ownership and delete policy.
  // An edited Catalog entry cannot acquire permission through this relocation.
  if (createHash('sha256').update(JSON.stringify(entry)).digest('hex').toUpperCase() !== record.catalogEntrySHA256) {
    return null;
  }
  if (!sourceBindingIntact(record, sourceByFile)) {
    throw new Error(`ACCOUNT_OWNERSHIP_CURRENT_DISCOVERY_DRIFT:${record.sourceFile}:${record.sourceSymbol}`);
  }
  return record;
}
