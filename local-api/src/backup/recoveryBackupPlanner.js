import { DATA_DOMAIN_REGISTRY } from '../data/dataDomainRegistry.js';
import { createRecoveryStorageAdapter } from './recoveryStorageAdapter.js';

export const SHOP_BACKUP_HARD_QUOTA_BYTES = 30 * 1024 * 1024;

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function normalizeShopId(value) {
  const shopId = String(value || '').trim();
  if (!shopId) throw new Error('BACKUP_SHOP_ID_REQUIRED');
  return shopId;
}

function tableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all().map((column) => column.name);
}

function tableExists(db, tableName) {
  return Boolean(db.prepare(`
    SELECT 1 AS present FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName)?.present);
}

function hasColumn(columns, name) {
  return columns.includes(name);
}

function byteExpression(columns) {
  if (!columns.length) return '0';
  return columns
    .map((column) => `COALESCE(LENGTH(CAST(${quoteIdentifier(column)} AS TEXT)), 0)`)
    .join(' + ');
}

function tableStats(db, policy, shopId = null) {
  if (!tableExists(db, policy.canonicalTable)) {
    throw new Error(`BACKUP_TABLE_NOT_FOUND:${policy.canonicalTable}`);
  }
  const columns = tableColumns(db, policy.canonicalTable);
  const isShopScope = policy.scopeType === 'shop' && policy.recoveryChannel !== 'profile-core';
  if (isShopScope && !hasColumn(columns, 'shop_id')) {
    throw new Error(`BACKUP_SHOP_SCOPE_COLUMN_MISSING:${policy.canonicalTable}`);
  }
  const where = isShopScope ? ' WHERE shop_id = ?' : '';
  const row = db.prepare(`
    SELECT COUNT(*) AS record_count,
           COALESCE(SUM(${byteExpression(columns)}), 0) AS logical_bytes
    FROM ${quoteIdentifier(policy.canonicalTable)}${where}
  `).get(...(isShopScope ? [shopId] : []));
  return {
    recordCount: Number(row?.record_count) || 0,
    logicalBytes: Number(row?.logical_bytes) || 0,
  };
}

function estimateCipherBytes(logicalBytes, recordCount) {
  // 这里是不读取业务内容的保守本地预估。实际 quota 必须由服务端对密文 chunk 去重后裁决。
  if (!logicalBytes && !recordCount) return 0;
  return Math.ceil(logicalBytes * 1.15) + 4096;
}

function toPublicDomainPreview(policy, stats) {
  return {
    domain: policy.domain,
    table: policy.canonicalTable,
    scopeType: policy.scopeType,
    dataClass: policy.dataClass,
    source: policy.source,
    disposition: policy.backup,
    recordCount: stats.recordCount,
    logicalBytes: stats.logicalBytes,
    estimatedCipherBytes: estimateCipherBytes(stats.logicalBytes, stats.recordCount),
  };
}

function summarize(domains, quotaBytes) {
  const required = domains.filter((domain) => domain.disposition === 'required');
  const optional = domains.filter((domain) => domain.disposition === 'optional');
  const bytes = (items) => items.reduce((total, item) => total + item.estimatedCipherBytes, 0);
  const requiredCoreBytes = bytes(required);
  const optionalBytes = bytes(optional);
  const projectedStandardBytes = requiredCoreBytes + optionalBytes;
  const status = requiredCoreBytes > quotaBytes
    ? 'required_core_over_quota'
    : projectedStandardBytes > quotaBytes
      ? 'compact_required'
      : 'fits_standard';
  return {
    quotaBytes,
    requiredCoreBytes,
    optionalBytes,
    projectedStandardBytes,
    projectedCoreOnlyBytes: requiredCoreBytes,
    fitsStandard: projectedStandardBytes <= quotaBytes,
    fitsCoreOnly: requiredCoreBytes <= quotaBytes,
    status,
  };
}

/**
 * 只读灾难备份预检：用唯一 DataDomainRegistry 算出可导出范围和 30MiB 预算。
 * 不读取业务 payload、不导出密钥、不上传、更不会删除任何本机数据。
 */
export function createRecoveryBackupPlanner({
  db,
  storageAdapter,
  registry = DATA_DOMAIN_REGISTRY,
  quotaBytes = SHOP_BACKUP_HARD_QUOTA_BYTES,
} = {}) {
  if (!db) throw new Error('createRecoveryBackupPlanner requires db.');
  storageAdapter ||= createRecoveryStorageAdapter({ db });

  function previewShop(shopIdInput) {
    const shopId = normalizeShopId(shopIdInput);
    const domains = registry
      .filter((policy) => policy.scopeType === 'shop' && policy.backup !== 'excluded')
      .filter((policy) => policy.storageAdapter !== 'secret-vault')
      .filter((policy) => policy.recoveryChannel !== 'profile-core')
      .map((policy) => toPublicDomainPreview(policy, tableStats(storageAdapter.resolveDatabase({ db, shopId, policy }), policy, shopId)))
      .filter((domain) => domain.recordCount > 0)
      .sort((left, right) => left.domain.localeCompare(right.domain));
    return {
      ok: true,
      mode: 'read-only-preview',
      shopId,
      domains,
      ...summarize(domains, quotaBytes),
      serverCommitRequired: true,
      automaticUploadAllowed: false,
    };
  }

  function previewProfileCore() {
    const domains = registry
      .filter((policy) => (
        (policy.scopeType === 'profile' || policy.recoveryChannel === 'profile-core')
        && policy.backup === 'required'
      ))
      .filter((policy) => policy.storageAdapter !== 'secret-vault')
      .map((policy) => toPublicDomainPreview(policy, tableStats(db, policy)))
      .filter((domain) => domain.recordCount > 0)
      .sort((left, right) => left.domain.localeCompare(right.domain));
    return {
      ok: true,
      mode: 'read-only-preview',
      domains,
      estimatedCipherBytes: domains.reduce((total, item) => total + item.estimatedCipherBytes, 0),
      automaticUploadAllowed: false,
    };
  }

  function previewAll() {
    const shopIds = db.prepare('SELECT id FROM shops ORDER BY id').all()
      .map((row) => String(row.id || '').trim())
      .filter(Boolean);
    return {
      ok: true,
      mode: 'read-only-preview',
      profileCore: previewProfileCore(),
      shops: shopIds.map(previewShop),
      quotaBytes,
      serverCommitRequired: true,
      automaticUploadAllowed: false,
    };
  }

  return { previewShop, previewProfileCore, previewAll };
}
