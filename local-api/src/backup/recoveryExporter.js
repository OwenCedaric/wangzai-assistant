import { compareDataDomainRestoreOrder, DATA_DOMAIN_REGISTRY } from '../data/dataDomainRegistry.js';
import { ACCOUNT_OWNERSHIP_CATALOG } from '../domain/accountRemoval/accountOwnershipCatalog.js';
import { buildRecoveryChunk, encryptRecoveryChunk } from './recoveryChunkCodec.js';
import { SHOP_BACKUP_HARD_QUOTA_BYTES } from './recoveryBackupPlanner.js';
const OPTIONAL_EXCLUDED_COLUMNS = new Set([
  'id', 'raw_json', 'payload_json', 'images_json', 'attributes_json', 'price_json', 'stock_json',
  'fee_json', 'submitted_payload_json', 'ozon_response_json', 'parent_snapshot_json',
  'child_snapshots_json', 'readback_rows_json', 'summary_json', 'metrics_json',
]);

/** Shop-required domains that are intentionally carried by profile-core. */
export const DATA_BACKUP_SPECIAL_SHOP_DOMAINS = Object.freeze([
  'purchase-completion-history',
  'shop-credentials',
]);
export const DATA_BACKUP_OZON_LOGICAL_SLICE_DOMAINS = Object.freeze({
  'logical:profile-settings-ozon-shop-preferences': 'profile-settings',
  'logical:profile-settings-purchase-plugin-context': 'profile-settings',
  'logical:purchase-browser-receipts-shop-links': 'purchase-browser-receipts',
  'logical:purchase-browser-tasks-shop-links': 'purchase-browser-tasks',
});

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function normalizeShopId(value) {
  const shopId = String(value || '').trim();
  if (!shopId) throw new Error('BACKUP_SHOP_ID_REQUIRED');
  return shopId;
}

function listColumns(db, tableName) {
  const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all().map((column) => column.name);
  if (!columns.length) throw new Error(`BACKUP_TABLE_NOT_FOUND:${tableName}`);
  return columns;
}

function selectedColumns(policy, columns) {
  const explicitlyIncluded = new Set(policy.optionalBackupIncludedColumns || []);
  const primaryKey = new Set(policy.primaryKey || []);
  const selected = policy.backup === 'required'
    ? columns.filter((column) => column !== 'id' || primaryKey.has(column))
    : columns.filter((column) => explicitlyIncluded.has(column) || !OPTIONAL_EXCLUDED_COLUMNS.has(column));
  if (!selected.length) throw new Error(`BACKUP_EXPORT_PROJECTION_EMPTY:${policy.domain}`);
  return selected;
}

function assertShopPolicy(policy, columns) {
  if (policy.scopeType !== 'shop') throw new Error(`BACKUP_SCOPE_UNSUPPORTED:${policy.domain}`);
  if (!columns.includes('shop_id')) throw new Error(`BACKUP_SHOP_SCOPE_COLUMN_MISSING:${policy.canonicalTable}`);
  if (!Array.isArray(policy.primaryKey) || !policy.primaryKey.length || !policy.primaryKey.every((column) => columns.includes(column))) {
    throw new Error(`BACKUP_PRIMARY_KEY_INVALID:${policy.domain}`);
  }
}

function normalizeExportValue(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) throw new Error('BACKUP_BINARY_FIELD_NOT_SUPPORTED');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('BACKUP_NONFINITE_FIELD');
  return value;
}

export function buildRecoveryRecordKey(policy, row, { primaryKey = policy.primaryKey } = {}) {
  const parts = primaryKey.map((column) => {
    const value = row[column];
    if (value === null || value === undefined || String(value).trim() === '') {
      throw new Error(`BACKUP_PRIMARY_KEY_VALUE_MISSING:${policy.domain}:${column}`);
    }
    return `${column}:${String(value)}`;
  });
  return parts.join('|');
}

function domainRows(db, policy, shopId) {
  const columns = listColumns(db, policy.canonicalTable);
  assertShopPolicy(policy, columns);
  const projection = selectedColumns(policy, columns);
  const rows = db.prepare(`
    SELECT ${projection.map(quoteIdentifier).join(', ')}
    FROM ${quoteIdentifier(policy.canonicalTable)}
    WHERE shop_id = ?
    ORDER BY ${policy.primaryKey.map(quoteIdentifier).join(', ')}
  `).all(shopId);
  const keys = new Set();
  return rows.map((row) => {
    const key = buildRecoveryRecordKey(policy, row);
    if (keys.has(key)) throw new Error(`BACKUP_PRIMARY_KEY_DUPLICATE:${policy.domain}`);
    keys.add(key);
    return {
      key,
      value: Object.fromEntries(Object.entries(row).map(([column, value]) => [column, normalizeExportValue(value)])),
    };
  });
}

function publicDomainManifest(policy, chunk, encrypted) {
  return {
    domain: policy.domain,
    schemaVersion: Number(policy.schemaVersion ?? 1),
    disposition: policy.backup,
    table: policy.canonicalTable,
    primaryKey: policy.primaryKey,
    recordCount: chunk.recordCount,
    recordsRootHash: chunk.recordsRootHash,
    plainCanonicalSha256: chunk.plainCanonicalSha256,
    chunkId: encrypted.chunkId,
    cipherBytes: encrypted.cipherBytes,
    cipherSha256: encrypted.cipherSha256,
  };
}

export function selectRecoveryShopPolicies({
  registry = DATA_DOMAIN_REGISTRY,
  mode = 'standard',
} = {}) {
  if (!['standard', 'core-only'].includes(mode)) throw new Error('BACKUP_EXPORT_MODE_INVALID');
  return registry
    .filter((policy) => policy.scopeType === 'shop' && policy.backup !== 'excluded')
    .filter((policy) => policy.storageAdapter !== 'secret-vault')
    .filter((policy) => policy.recoveryChannel !== 'profile-core')
    .filter((policy) => mode === 'standard' || policy.backup === 'required')
    .sort(compareDataDomainRestoreOrder);
}

/**
 * Fail closed when a registry-required, generic SQLite shop domain is no longer
 * admitted by the core-only exporter. Special secret/profile-core channels are
 * intentionally checked by their own coverage gates.
 */
export function assertRequiredRecoveryShopDomainCoverage(registry = DATA_DOMAIN_REGISTRY) {
  const expected = registry
    .filter((policy) => policy.scopeType === 'shop' && policy.backup === 'required')
    .filter((policy) => policy.storageAdapter !== 'secret-vault')
    .filter((policy) => policy.recoveryChannel !== 'profile-core')
    .map((policy) => policy.domain)
    .sort();
  const selected = selectRecoveryShopPolicies({ registry, mode: 'core-only' })
    .map((policy) => policy.domain)
    .sort();
  if (
    expected.length !== selected.length
    || expected.some((domain, index) => domain !== selected[index])
    || new Set(selected).size !== selected.length
  ) {
    throw new Error('BACKUP_REQUIRED_SHOP_DOMAIN_COVERAGE_MISMATCH');
  }
  return Object.freeze({ ok: true, domains: Object.freeze(selected) });
}

/**
 * Independent user exports combine the generic shop exporter with the existing
 * encrypted profile-core channel. Compare that combined routing against the
 * registry so a newly required shop domain cannot silently fall out of both.
 */
export function assertRequiredDataBackupShopDomainCoverage(
  registry = DATA_DOMAIN_REGISTRY,
  ownershipCatalog = ACCOUNT_OWNERSHIP_CATALOG,
) {
  const expected = registry
    .filter((policy) => policy.scopeType === 'shop' && policy.backup === 'required')
    .map((policy) => policy.domain)
    .sort();
  const generic = selectRecoveryShopPolicies({ registry, mode: 'core-only' })
    .map((policy) => policy.domain);
  const specialSet = new Set(DATA_BACKUP_SPECIAL_SHOP_DOMAINS);
  const special = registry
    .filter((policy) => specialSet.has(policy.domain))
    .filter((policy) => policy.scopeType === 'shop' && policy.backup === 'required')
    .filter((policy) => (
      policy.storageAdapter === 'secret-vault'
      || policy.recoveryChannel === 'profile-core'
    ))
    .map((policy) => policy.domain);
  const selected = [...generic, ...special].sort();
  if (
    expected.length !== selected.length
    || expected.some((domain, index) => domain !== selected[index])
    || new Set(selected).size !== selected.length
  ) {
    throw new Error('DATA_BACKUP_REQUIRED_SHOP_DOMAIN_COVERAGE_MISMATCH');
  }
  const expectedLogicalSlices = ownershipCatalog
    .filter((entry) => (
      entry.ownerType === 'ozon_shop'
      && entry.availability === 'current'
      && entry.removable === true
      && entry.backupRule === 'required'
      && String(entry.id || '').startsWith('logical:')
    ))
    .map((entry) => entry.id)
    .sort();
  const selectedLogicalSlices = Object.keys(DATA_BACKUP_OZON_LOGICAL_SLICE_DOMAINS).sort();
  if (
    expectedLogicalSlices.length !== selectedLogicalSlices.length
    || expectedLogicalSlices.some((resourceId, index) => resourceId !== selectedLogicalSlices[index])
  ) {
    throw new Error('DATA_BACKUP_REQUIRED_SHOP_LOGICAL_SLICE_COVERAGE_MISMATCH');
  }
  return Object.freeze({
    ok: true,
    domains: Object.freeze(selected),
    logicalResources: Object.freeze(selectedLogicalSlices),
  });
}

/**
 * 从同一个 SQLite handle 读取已登记的 shop 数据，构造加密 chunk 候选。
 * 该服务不写文件、不接触远端、不导出 profile secret；调用方必须传入由
 * 受控 key envelope 解出的 account-scoped keys。
 */
export function createRecoveryExporter({
  db,
  resolveDomainDatabase = () => db,
  registry = DATA_DOMAIN_REGISTRY,
  quotaBytes = SHOP_BACKUP_HARD_QUOTA_BYTES,
} = {}) {
  if (!db) throw new Error('createRecoveryExporter requires db.');
  assertRequiredRecoveryShopDomainCoverage(registry);

  function buildShopCandidate({
    shopId: shopIdInput,
    encryptionKey,
    dedupeKey,
    aad,
    mode = 'standard',
    includeDomains,
  } = {}) {
    const shopId = normalizeShopId(shopIdInput);
    const included = includeDomains === undefined
      ? null
      : new Set((Array.isArray(includeDomains) ? includeDomains : []).map((domain) => String(domain || '').trim()));
    const policies = selectRecoveryShopPolicies({ registry, mode })
      .filter((policy) => !included || included.has(policy.domain));
    const chunks = [];
    const domains = [];
    for (const policy of policies) {
      const records = domainRows(resolveDomainDatabase({ db, shopId, policy }), policy, shopId);
      if (!records.length) continue;
      const chunk = buildRecoveryChunk({
        domain: policy.domain,
        domainSchemaVersion: policy.schemaVersion,
        partitionKey: 'scope:current',
        records,
      });
      const encrypted = encryptRecoveryChunk({ chunk, encryptionKey, dedupeKey, aad });
      chunks.push(encrypted);
      domains.push(publicDomainManifest(policy, chunk, encrypted));
    }
    const requiredCoreBytes = domains
      .filter((domain) => domain.disposition === 'required')
      .reduce((total, domain) => total + domain.cipherBytes, 0);
    const totalCipherBytes = domains.reduce((total, domain) => total + domain.cipherBytes, 0);
    if (Number.isFinite(quotaBytes) && requiredCoreBytes > quotaBytes) {
      throw new Error('BACKUP_REQUIRED_DATA_OVER_QUOTA');
    }
    if (Number.isFinite(quotaBytes) && totalCipherBytes > quotaBytes) {
      throw new Error('BACKUP_QUOTA_EXCEEDED_LOCAL_PREFLIGHT');
    }
    return {
      ok: true,
      format: 'wangzai-recovery-export-candidate',
      version: 1,
      shopId,
      mode,
      quotaBytes,
      requiredCoreBytes,
      totalCipherBytes,
      domains,
      chunks,
      serverCommitRequired: true,
    };
  }

  return { buildShopCandidate };
}
