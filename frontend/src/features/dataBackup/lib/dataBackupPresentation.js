import { normalizeOzonShopOption } from '../../../shared/ozon/ozonShopOption.js';

const integerFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });

const DATA_BACKUP_DOMAIN_LABELS = Object.freeze({
  shops: '店铺资料',
  'shop-credentials': '店铺凭证',
  'recovery-keyset': '数据恢复密钥',
  'cross-border-accounts': '跨境巴士账号',
  'performance-accounts': '推广账号',
  'purchase-accounts': '采购账号',
  'model-api-accounts': '模型接口账号',
  'integration-profiles': '外部服务配置',
  'integration-credentials': '外部服务凭证',
  'profile-settings': '账号相关设置',
  'profile-assets': '账号资源',
  'purchase-overrides': '采购补录',
  'purchase-source-links': '采购货源',
  'sales-source-links': '销售来源',
  'product-source-links': '商品货源',
  'product-material-profiles': '商品材积',
  'product-manual-cost-profiles': '商品历史成本',
  'historical-import-runs': '历史订单导入记录',
  'historical-import-rows': '历史订单导入明细',
  'historical-order-import-runs': '历史订单导入记录',
  'historical-order-import-rows': '历史订单导入明细',
  'data-backup-imports': '软件备份恢复记录',
  'data-backup-owner-imports': '账号备份恢复记录',
  'cross-border-account-shop-bindings': '跨境账号店铺绑定',
  'historical-order-facts': '历史订单导入数据',
  'order-split-relations': '订单拆分关系',
  'notification-settings': '通知设置',
  'cross-border-order-records': '跨境巴士记录',
  'purchase-browser-tasks': '采购浏览任务',
  'purchase-browser-receipts': '采购执行回执',
  'purchase-completion-history': '拍单完成记录',
  products: '商品资料',
  orders: '订单资料',
  'finance-transactions': '财务流水',
  returns: '售后退货',
  'marketing-activities': '营销活动',
  'marketing-activity-products': '营销活动商品',
  'marketing-view-state': '营销页面设置',
  'rating-penalties': '店铺评分与罚款',
  'analytics-daily': '每日分析数据',
  'product-identities': '商品识别信息',
  'product-status-facts': '商品状态',
  'product-detail-facts': '商品详情',
  'product-dimension-facts': '商品长宽高信息',
  'product-price-facts': '商品价格',
  'product-commission-facts': '商品佣金',
  'product-acquiring-facts': '商品收单费',
  'product-stock-facts': '商品总库存',
  'product-warehouse-stock-facts': '商品仓库库存',
  'product-image-facts': '商品图片',
  'product-attribute-facts': '商品属性',
  'product-facet-observations': '商品同步观测记录',
  'catalog-category-nodes': '类目节点',
  'catalog-category-mappings': '类目映射',
  'catalog-attributes': '类目属性',
  'catalog-attribute-values': '类目属性值',
  'product-image-health': '商品图片健康状态',
  'account-removal-operations': '账号删除操作记录',
  'cache-merge-log': '缓存合并记录',
  'catalog-cache-key-registry': '类目缓存登记',
  'catalog-cache-keys': '类目缓存索引',
  'catalog-cache-sync-state': '类目缓存同步状态',
  'circuit-breakers': '接口熔断状态',
  'data-analysis-snapshots': '数据分析快照',
  'data-analysis-sync-state': '数据分析同步状态',
  'data-backup-exports': '备份导出记录',
  'error-events': '错误记录',
  'exchange-rate-cache': '汇率缓存',
  'legacy-browser-observation-days': '历史浏览器观测日期',
  'legacy-browser-read-key-days': '历史浏览器读取记录',
  'legacy-browser-observation-sessions': '历史浏览器观测会话',
  'legacy-browser-observation-batches': '历史浏览器观测批次',
  'legacy-sync-state': '历史同步状态',
  'notification-events': '通知事件记录',
  'product-sync-runs': '商品同步任务',
  'product-sync-stage-batches': '商品同步批次',
  'product-sync-page-proofs': '商品同步分页校验',
  'product-sync-outbox': '商品同步待处理记录',
  'product-sync-quarantine': '商品同步隔离记录',
  'profit-ledger-snapshots': '利润账本快照',
  'purchase-browser-plugin-state': '拍单插件状态',
  'rate-limit-state': '接口限流状态',
  'recovery-reconcile-state': '恢复核对状态',
  'request-jobs': '接口请求任务',
  'request-attempts': '接口请求尝试记录',
  'response-cache': '接口响应缓存',
  'scheduler-trace-events': '后台调度追踪记录',
  'schema-migrations': '数据库升级记录',
  'shared-catalog-versions': '公共类目版本',
  'shared-catalog-import-runs': '公共类目导入记录',
  'shared-catalog-categories': '公共类目分类',
  'shared-catalog-types': '公共类目类型',
  'shared-catalog-attributes': '公共类目属性',
  'shared-catalog-attribute-values': '公共类目属性值',
  'shared-catalog-entity-sources': '公共类目来源',
  'shared-catalog-quarantine': '公共类目隔离记录',
  'shop-bootstrap-runs': '店铺初始化记录',
  'shop-domain-sync-state': '店铺领域同步状态',
  'shop-identity-tombstones': '已删除店铺标记',
  'shop-runtime-state': '店铺运行状态',
  'sync-jobs': '数据同步任务',
  'sync-locks': '数据同步锁',
  'sync-snapshots': '数据同步快照',
  'sync-state-runtime': '数据同步运行状态',
  'write-audit-log': '数据写入审计记录',
});

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function firstText(...values) {
  const value = values.find((item) => String(item || '').trim());
  return value === undefined ? '' : String(value).trim();
}

function safeFileName(value) {
  const raw = [...firstText(value)]
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join('');
  return raw.split(/[\\/]/u).filter(Boolean).at(-1) || '';
}

export function getDataBackupDomainLabel(domain) {
  return DATA_BACKUP_DOMAIN_LABELS[firstText(domain)] || '其他用户数据';
}

export function normalizeDataBackupDomains(value) {
  return (Array.isArray(value) ? value : []).map((domain) => ({
    domain: firstText(domain?.domain),
    label: getDataBackupDomainLabel(domain?.domain),
    schemaVersion: nonNegativeNumber(domain?.schemaVersion) || 1,
    recordCount: nonNegativeNumber(domain?.recordCount),
    logicalBytes: nonNegativeNumber(domain?.logicalBytes),
    requiredForRestore: domain?.requiredForRestore === true || domain?.required_for_restore === true,
  }));
}

export function normalizeDataBackupShopOption(shop = {}) {
  return normalizeOzonShopOption(shop);
}

export function createDataBackupOwnerKey(owner = {}) {
  const ownerType = firstText(owner.ownerType, owner.owner_type);
  const ownerId = firstText(owner.ownerId, owner.owner_id, owner.shopId, owner.id);
  return ownerType && ownerId ? JSON.stringify([ownerType, ownerId]) : '';
}

export function parseDataBackupOwnerKey(value) {
  try {
    const parsed = JSON.parse(String(value || ''));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const ownerType = firstText(parsed[0]);
    const ownerId = firstText(parsed[1]);
    return ownerType && ownerId ? { ownerType, ownerId } : null;
  } catch {
    return null;
  }
}

export function normalizeDataBackupOwnerOption(value = {}) {
  const owner = value.owner && typeof value.owner === 'object' ? value.owner : value;
  const ownerType = firstText(owner.ownerType, owner.owner_type, value.ownerType, value.owner_type,
    value.shopId || value.id ? 'ozon_shop' : '');
  const ownerId = firstText(owner.ownerId, owner.owner_id, value.ownerId, value.owner_id, value.shopId, value.id);
  const ownerTypeLabel = firstText(value.ownerTypeLabel, value.owner_type_label,
    ownerType === 'ozon_shop' ? 'Ozon 店铺' : '其他账号');
  const displayName = firstText(value.displayName, value.display_name, value.alias, value.name, ownerId);
  return {
    owner: { ownerType, ownerId },
    ownerKey: createDataBackupOwnerKey({ ownerType, ownerId }),
    ownerType,
    ownerId,
    ownerTypeLabel,
    displayName,
    shopId: ownerType === 'ozon_shop' ? ownerId : '',
    shopExternalId: firstText(value.clientId, value.client_id, ownerId),
    shopName: displayName,
    shopAlias: firstText(value.alias, displayName),
  };
}

export function normalizeBackupSummary(backup = {}, index = 0) {
  const completedAt = firstText(
    backup.completedAt,
    backup.verifiedAt,
    backup.createdAt,
    backup.completed_at,
    backup.verified_at,
    backup.created_at,
  );
  const verificationStatus = firstText(
    backup.verificationStatus,
    backup.verification_status,
    backup.status,
    backup.verified === true ? 'verified' : '',
  );
  return {
    id: firstText(backup.backupId, backup.id, backup.exportId, backup.backup_id, `backup-${index}`),
    shopId: firstText(backup.shopId, backup.shop_id),
    owner: backup.owner && typeof backup.owner === 'object'
      ? {
          ownerType: firstText(backup.owner.ownerType, backup.owner.owner_type),
          ownerId: firstText(backup.owner.ownerId, backup.owner.owner_id),
        }
      : null,
    displayName: firstText(backup.displayName, backup.shopName, backup.shop_name),
    completedAt,
    totalRecords: nonNegativeNumber(backup.totalRecords ?? backup.recordCount ?? backup.record_count),
    logicalBytes: nonNegativeNumber(backup.logicalBytes ?? backup.logical_bytes ?? backup.sizeBytes),
    packageVersion: firstText(backup.packageVersion, backup.formatVersion, backup.schemaVersion),
    verificationStatus,
    manifestHash: firstText(backup.manifestHash, backup.rootHash, backup.manifest_hash, backup.root_hash),
    fileName: safeFileName(firstText(
      backup.fileName,
      backup.filename,
      backup.suggestedFileName,
      backup.suggested_file_name,
    )),
    verified: backup.verified === true || verificationStatus.toLowerCase() === 'verified',
    dataFingerprint: firstText(backup.dataFingerprint, backup.data_fingerprint),
    coversCurrentData: backup.coversCurrentData === true,
    coverageMode: firstText(backup.coverageMode, backup.coverage_mode, 'full'),
    survivesAccountRemoval: backup.survivesAccountRemoval === true,
    operationType: firstText(backup.operationType, backup.operation_type, 'backup-export'),
    domains: normalizeDataBackupDomains(backup.domains),
  };
}

export function normalizeDataBackupPreview(payload = {}) {
  const shops = Array.isArray(payload?.shops) ? payload.shops : [];
  const rawOwners = Array.isArray(payload?.owners)
    ? payload.owners
    : payload?.owner && typeof payload.owner === 'object'
      ? [payload.owner]
      : shops.map((shop) => ({ ...shop, owner: { ownerType: 'ozon_shop', ownerId: shop.shopId || shop.id } }));
  const owners = rawOwners.map((value) => {
    const option = normalizeDataBackupOwnerOption(value);
    return {
      ...option,
      domains: normalizeDataBackupDomains(value?.domains).filter((domain) => domain.domain || domain.label),
      totalRecords: nonNegativeNumber(value?.totalRecords),
      dataFingerprint: firstText(value?.dataFingerprint),
      ownerIncarnation: firstText(value?.ownerIncarnation, value?.owner_incarnation),
      latestVerifiedBackup: value?.latestVerifiedBackup
        ? normalizeBackupSummary(value.latestVerifiedBackup)
        : null,
    };
  }).filter((owner) => owner.ownerKey);
  return {
    owners,
    shops: shops
      .map((shop) => {
        const option = normalizeDataBackupShopOption(shop);
        return {
          ...option,
          domains: normalizeDataBackupDomains(shop?.domains)
            .filter((domain) => domain.domain || domain.label),
          totalRecords: nonNegativeNumber(shop?.totalRecords),
          dataFingerprint: firstText(shop?.dataFingerprint),
          latestVerifiedBackup: shop?.latestVerifiedBackup
            ? normalizeBackupSummary(shop.latestVerifiedBackup)
            : null,
        };
      })
      .filter((shop) => shop.shopId),
  };
}

export function normalizeDataBackupHistory(payload = {}) {
  const backups = Array.isArray(payload?.backups) ? payload.backups : [];
  return backups.map((backup, index) => normalizeBackupSummary(backup, index));
}

export function normalizeDataBackupImportHistory(payload = {}) {
  const imports = Array.isArray(payload?.imports) ? payload.imports : [];
  return imports.map((entry, index) => normalizeBackupSummary({
    ...entry,
    backupId: entry.importId || entry.import_id,
    operationType: 'backup-import',
    verificationStatus: entry.status || (entry.verified === true ? 'verified' : ''),
  }, index));
}

export function formatDataBackupCount(value) {
  return integerFormatter.format(nonNegativeNumber(value));
}

export function formatDataBackupBytes(value) {
  const bytes = nonNegativeNumber(value);
  if (bytes < 1024) return `${integerFormatter.format(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(bytes / (1024 ** 2)).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MiB`;
}

export function formatDataBackupTime(value) {
  if (!value) return '时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function getDataBackupVerificationLabel(backup = {}) {
  if (backup.verified === true) return '校验通过';
  const status = String(backup.verificationStatus || '').toLowerCase();
  if (status === 'failed' || status === 'invalid') return '校验失败';
  if (status === 'pending' || status === 'verifying') return '校验中';
  return '状态未知';
}

export function shortDataFingerprint(value) {
  const fingerprint = String(value || '').trim();
  if (!fingerprint) return '';
  return fingerprint.length > 12 ? `${fingerprint.slice(0, 8)}…${fingerprint.slice(-4)}` : fingerprint;
}
