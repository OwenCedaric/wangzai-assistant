import { getDataBackupDomainLabel } from '../../../dataBackup/lib/dataBackupPresentation.js';

export const accountRemovalOwnerLabels = Object.freeze({
  ozon_shop: 'Ozon 店铺账号',
  cross_border_bus: '跨境巴士账号',
  promotion_account: '推广账号',
  purchase_account: '采购账号',
  model_api_account: '接口配置',
  integration_profile: '平台接口配置',
});

const storageKindLabels = Object.freeze({
  sqlite: '本地数据库',
  'secret-vault': '本机加密凭证库',
  filesystem: '本机文件',
  memory: '当前窗口数据',
  runtime: '后台运行任务',
  'browser-extension': '登录辅助组件',
  'browser-profile': '内置浏览器资料',
  'browser-storage': '网站本地数据',
  'backup-remote': '远端恢复备份',
  'browser-download': '网站下载记录',
  backup: '数据备份',
  logical: '关联数据',
});

const resourceLabels = Object.freeze({
  'browser:purchase-cache-storage': '拍单网站缓存数据',
  'browser:purchase-cookies': '拍单网站登录状态',
  'browser:purchase-downloads': '拍单网站下载记录',
  'browser:purchase-extension-storage': '拍单登录辅助数据',
  'browser:purchase-http-cache': '拍单网页临时缓存',
  'browser:purchase-indexed-db': '拍单网站本地数据库',
  'browser:purchase-local-storage': '拍单网站本地设置',
  'browser:purchase-persistent-partition': '拍单账号独立浏览器空间',
  'browser:purchase-plugin-installation-state': '拍单登录组件安装状态',
  'browser:purchase-profile-identity': '拍单账号浏览器标识',
  'browser:purchase-proxy-auth': '拍单网站网络代理登录信息',
  'browser:purchase-service-workers': '拍单网站后台服务数据',
  'memory:renderer-model-api-settings': '当前窗口中的模型接口配置',
  'logical:renderer-cross-border-settings-account-slice': '当前窗口中的跨境巴士账号设置',
  'logical:renderer-ozon-shop-settings-shop-slices': '当前窗口中的 Ozon 店铺设置',
  'logical:renderer-purchase-order-overrides-shop-records': '当前窗口中的采购补录',
  'memory:renderer-product-material-profiles': '当前窗口中的商品材积数据',
  'logical:local-data-ozon-shop-settings-shop-slices': '本机保存的 Ozon 店铺设置',
  'logical:local-data-product-material-profiles-shop-records': '本机保存的商品材积数据',
  'logical:local-data-product-source-links-shop-records': '本机保存的商品货源关系',
  'logical:local-data-purchase-order-overrides-shop-records': '本机保存的采购补录',
  'logical:local-data-purchase-source-links-shop-records': '本机保存的采购货源关系',
  'logical:local-data-sales-source-links-shop-records': '本机保存的销售货源关系',
  'logical:local-api-rate-limit-shop-state': 'Ozon 店铺接口限流状态',
  'logical:purchase-browser-receipts-shop-links': '采购执行回执与店铺关系',
  'logical:purchase-browser-tasks-shop-links': '采购浏览任务与店铺关系',
  'memory:purchase-search-bridge-context-unattributed': '当前窗口中的采购搜索信息',
  'memory:purchase-search-bridge-captures-unattributed': '当前窗口中的采购搜索结果',
  'memory:renderer-purchase-plugin-source-context-unattributed': '当前窗口中的拍单货源信息',
  'memory:local-api-write-guard-previews': '当前窗口中的写入确认预览',
  'runtime:renderer-marketing-view-state-write-queue': '营销页面设置保存任务',
  'runtime:renderer-ozon-shop-settings-write-queue': 'Ozon 店铺设置保存任务',
  'runtime:renderer-product-material-profile-write-queue': '商品材积保存任务',
  'runtime:renderer-product-source-link-migration': '商品货源关系迁移任务',
  'runtime:renderer-purchase-plugin-context-write-queue': '拍单登录上下文保存任务',
  'runtime:renderer-purchase-source-link-migration': '采购货源关系迁移任务',
  'runtime:renderer-sales-source-link-migration': '销售货源关系迁移任务',
  'runtime:local-api-performance-request-queue': '本地服务请求队列',
  'runtime:desktop-recovery-auto-backup-scheduler': '自动恢复备份任务',
});

function resourceOwnerSubject(resourceId) {
  if (/purchase/iu.test(resourceId)) return '拍单账号';
  if (/cross-border/iu.test(resourceId)) return '跨境巴士账号';
  if (/model-api/iu.test(resourceId)) return '模型接口账号';
  if (/promotion|performance/iu.test(resourceId)) return '推广账号';
  if (/ozon-shop|shop|ozon/iu.test(resourceId)) return 'Ozon 店铺';
  if (/product/iu.test(resourceId)) return '商品';
  if (/sales|order/iu.test(resourceId)) return '订单';
  if (/marketing/iu.test(resourceId)) return '营销';
  if (/profit|finance/iu.test(resourceId)) return '利润与财务';
  if (/recovery|backup/iu.test(resourceId)) return '数据恢复';
  if (/license/iu.test(resourceId)) return '软件授权';
  return '系统';
}

function resourcePurpose(resourceId, storageKind) {
  if (/credential|secret|token|proxy-auth/iu.test(resourceId)) return '加密凭证';
  if (/cookie|profile-identity/iu.test(resourceId)) return '登录状态';
  if (/source-link/iu.test(resourceId)) return '货源关系';
  if (/material|dimension/iu.test(resourceId)) return '材积信息';
  if (/setting/iu.test(resourceId)) return '设置';
  if (/snapshot/iu.test(resourceId)) return '临时快照';
  if (/cache/iu.test(resourceId)) return '缓存';
  if (/migration/iu.test(resourceId)) return '数据迁移任务';
  if (/queue|write-task|job|poller|scheduler/iu.test(resourceId)) return '后台任务';
  if (/lock|limiter|traffic|rate-limit|circuit-breaker/iu.test(resourceId)) return '运行控制状态';
  if (/(?:^|[:-])(?:log|logs|diagnostic)(?:[:-]|$)/iu.test(resourceId)) return '诊断记录';
  if (/backup|recovery/iu.test(resourceId)) return '恢复备份';
  if (/receipt/iu.test(resourceId)) return '执行回执';
  if (/source-context|context/iu.test(resourceId)) return '相关信息';
  if (/capture/iu.test(resourceId)) return '采集结果';
  if (/preview/iu.test(resourceId)) return '操作预览';
  if (/link|relation/iu.test(resourceId)) return '关联数据';
  return storageKindLabels[storageKind] || '数据项目';
}

export function getAccountRemovalStorageKindLabel(storageKind) {
  return storageKindLabels[String(storageKind || '').trim()] || '数据项目';
}

export function getAccountRemovalResourceLabel(resource = {}, { preserved = false } = {}) {
  const resourceId = String(resource?.id || resource?.resourceId || '').trim();
  if (resourceLabels[resourceId]) return resourceLabels[resourceId];
  const registryDomain = resourceId.startsWith('registry:')
    ? resourceId.slice('registry:'.length)
    : String(resource?.sourceRegistryDomain || '').trim();
  if (registryDomain) return getDataBackupDomainLabel(registryDomain);
  if (resourceId.startsWith('backup:remote-recovery-owner-')) {
    return `${resourceOwnerSubject(resourceId)}远端恢复备份`;
  }
  if (resourceId.startsWith('filesystem:diagnostic-logs-owner-')) {
    return `${resourceOwnerSubject(resourceId)}诊断记录`;
  }
  if (resourceId.startsWith('filesystem:recovery-protection-owner-')) {
    return `${resourceOwnerSubject(resourceId)}本地恢复保护副本`;
  }
  const subject = resourceOwnerSubject(resourceId);
  const purpose = resourcePurpose(resourceId, resource?.storageKind);
  if (subject === '数据恢复' && purpose === '恢复备份') return '数据恢复文件与备份';
  const inferred = `${subject}${purpose}`;
  if (inferred !== '系统数据项目') return inferred;
  return preserved ? '受保护的系统数据项目' : '当前账号的数据项目';
}

const phaseLabels = Object.freeze({
  loading: '正在核对账号和相关数据',
  preview: '等待人工确认',
  confirmed: '已确认，准备删除',
  quiescing: '正在停止账号相关任务',
  'local-delete-pending': '正在删除本机账号数据',
  'external-delete-pending': '正在清理账号外部数据',
  'backup-exporting': '正在导出并检查删除前备份',
  'backup-validating': '正在检查备份是否包含当前数据',
  barrier: '正在停止账号相关任务',
  executing: '正在删除并回读校验',
  'client-cleanup': '正在清理当前页面中的账号数据',
  verifying: '正在确认账号数据已经清除',
  completed: '账号删除已完成',
  error: '删除未完成',
  pending: '清理仍在进行',
});

const errorMessages = Object.freeze({
  LOCAL_API_AUTH_POLICY_MISSING:
    '本地删除接口授权策略不完整，本次删除尚未开始。可以关闭窗口，更新后重新尝试。',
  ACCOUNT_REMOVAL_OWNER_NOT_FOUND: '账号不存在或已被其他已完成操作删除。',
  ACCOUNT_REMOVAL_SNAPSHOT_FINGERPRINT_MISMATCH: '预览后账号数据发生变化，请刷新预览后重新确认。',
  ACCOUNT_REMOVAL_PREVIEW_FINGERPRINT_MISMATCH: '删除预览已失效，请重新生成。',
  ACCOUNT_REMOVAL_OWNER_LOCKED: '该账号已有删除任务在执行，系统会继续同一任务。',
  ACCOUNT_REMOVAL_CLIENT_VERIFY_FAILED: '本窗口仍有账号数据未清理干净，任务没有被标记为完成。',
  PURCHASE_BROWSER_ACCOUNT_REMOVAL_IN_PROGRESS: '清理仍在进行，可稍后继续查看。',
  ACCOUNT_REMOVAL_RELEASE_NOT_VERIFIED: '尚未确认取消成功，安全保护仍保留，请稍后重试。',
  ACCOUNT_REMOVAL_CLIENT_CLEANUP_PROOF_INVALID: '当前页面的数据清理结果不完整，删除流程已停止。',
  ACCOUNT_REMOVAL_SERVER_VERIFY_FAILED: '服务端回读仍发现账号数据，任务没有被标记为完成。',
  ACCOUNT_REMOVAL_PRESERVATION_MISMATCH: '保护校验未通过，删除尚未完成；请查看原任务状态后继续。',
  ACCOUNT_REMOVAL_DATABASE_BUSY: '数据库暂时忙，当前阶段尚未完成；可稍后继续原删除任务。',
  ACCOUNT_REMOVAL_SQLITE_EXECUTION_FAILED: '本地数据清理阶段未完成；部分此前阶段可能已经完成，请继续原任务核实。',
  ACCOUNT_REMOVAL_PHYSICAL_ERASURE_INCOMPLETE: '本地数据库文件仍被占用，账号删除尚未完成。',
  ACCOUNT_REMOVAL_QUIESCE_TIMEOUT: '仍有账号相关任务未排空，删除流程已停止。',
  ACCOUNT_REMOVAL_RECOVERY_BARRIER_UNAVAILABLE: '暂时无法暂停数据恢复任务，删除流程已停止。',
  ACCOUNT_REMOVAL_RECOVERY_BARRIER_FAILED: '没有成功暂停数据恢复任务，删除流程已停止。',
  ACCOUNT_REMOVAL_REMOTE_RECOVERY_BRIDGE_UNAVAILABLE:
    '暂时无法清理远端恢复数据，删除流程已停止。',
  ACCOUNT_REMOVAL_REMOTE_RECOVERY_PURGE_FAILED: '远端账号版本和恢复记录尚未清理完成，删除流程已停止。',
  ACCOUNT_REMOVAL_PROTECTION_BRIDGE_UNAVAILABLE: '暂时无法清理本机恢复副本，删除流程已停止。',
  ACCOUNT_REMOVAL_PROTECTION_PURGE_FAILED:
    '本地恢复/回滚/失败副本或诊断日志尚未全部清理并回读，删除流程已停止。',
  ACCOUNT_REMOVAL_OWNER_REBIND_REQUIRED:
    '这个账号编号已经删除过；如需再次使用，请通过“重新绑定新账号”创建一条全新的账号记录。',
  ACCOUNT_REMOVAL_BACKUP_REVIEW_REQUIRED: '当前账号包含不可重建数据，请先备份或明确选择跳过备份。',
  ACCOUNT_REMOVAL_BACKUP_PREVIEW_MISMATCH: '删除预览已经变化，原备份授权已失效，请重新确认。',
  ACCOUNT_REMOVAL_BACKUP_STALE: '备份没有覆盖当前最新数据，请重新导出。',
  ACCOUNT_REMOVAL_BACKUP_NOT_VERIFIED: '所选备份未通过校验、不会在删号后保留，或不属于当前账号。',
  ACCOUNT_REMOVAL_BACKUP_SKIP_CONFIRMATION_REQUIRED: '请先确认你了解跳过备份可能导致数据无法恢复。',
  ACCOUNT_REMOVAL_BACKUP_AUTHORIZATION_REQUIRED: '删除前必须先完成备份审阅。',
  ACCOUNT_REMOVAL_BACKUP_PREVIEW_CHANGED: '删除预览刚刚发生变化，请重新核对后再确认。',
  ACCOUNT_REMOVAL_ACTIVE_TASK_EXISTS: '当前已有其他删除任务，请先处理该任务，不能切换到另一项删除。',
  ACCOUNT_REMOVAL_RECOVERY_DATA_UNAVAILABLE: '恢复信息缺失，不能安全继续。请保留任务并联系支持人员检查。',
  RECOVERY_REMOTE_AUTH_REQUIRED: '远端恢复服务需要重新授权；当前清理未完成，授权后可继续原任务。',
  RECOVERY_REMOTE_LOGIN_REQUIRED: '请重新登录以恢复远端授权；当前清理未完成，登录后可继续原任务。',
  RECOVERY_REMOTE_ACCESS_DENIED: '远端恢复服务拒绝访问；请检查权限，恢复权限后可继续原任务。',
  RECOVERY_REMOTE_ENDPOINT_UNAVAILABLE: '远端恢复清理接口暂不可用；当前阶段未完成，可稍后继续查看。',
  RECOVERY_REMOTE_UNAVAILABLE: '远端恢复服务暂时无法连接；当前阶段未完成，可稍后继续原任务。',
});

function safePositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeLatestVerifiedBackup(backup = null) {
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) return null;
  const status = String(backup.status || backup.verificationStatus || '')
    .trim()
    .toLowerCase();
  return {
    backupId: String(backup.backupId || backup.id || '').trim(),
    status,
    verified: backup.verified === true || status === 'verified',
    dataFingerprint: String(backup.dataFingerprint || '').trim(),
    survivesAccountRemoval: backup.survivesAccountRemoval === true,
    verifiedAt: String(backup.verifiedAt || backup.completedAt || backup.createdAt || '').trim(),
    packageSha256: String(backup.packageSha256 || backup.manifestHash || '').trim(),
  };
}

export function normalizeAccountRemovalBackupReview(review = null, preview = null) {
  const source = review && typeof review === 'object' && !Array.isArray(review) ? review : {};
  return {
    required: source.required === true,
    reason: String(source.reason || '').trim(),
    previewFingerprint: String(source.previewFingerprint || preview?.previewFingerprint || '').trim(),
    dataFingerprint: String(source.dataFingerprint || '').trim(),
    totalRecords: safePositiveNumber(source.totalRecords),
    domains: (Array.isArray(source.domains) ? source.domains : []).map((domain) => ({
      domain: String(domain?.domain || '').trim(),
      label: getDataBackupDomainLabel(domain?.domain),
      recordCount: safePositiveNumber(domain?.recordCount),
      logicalBytes: safePositiveNumber(domain?.logicalBytes),
    })),
    latestVerifiedBackup: normalizeLatestVerifiedBackup(source.latestVerifiedBackup),
  };
}

export function canUseAccountRemovalRecentBackup(review = {}) {
  const normalizedReview = normalizeAccountRemovalBackupReview(review);
  const backup = normalizedReview.latestVerifiedBackup;
  return Boolean(
    normalizedReview.required === true &&
    normalizedReview.dataFingerprint &&
    backup?.backupId &&
    backup.verified === true &&
    backup.survivesAccountRemoval === true &&
    backup.dataFingerprint === normalizedReview.dataFingerprint
  );
}

export function isAccountRemovalBackupAuthorizationCurrent(review = {}, preview = {}, authorization = null) {
  const normalizedReview = normalizeAccountRemovalBackupReview(review, preview);
  if (normalizedReview.required !== true) return true;
  if (!authorization || typeof authorization !== 'object' || Array.isArray(authorization)) return false;
  if (String(authorization.previewFingerprint || '') !== String(preview?.previewFingerprint || '')) return false;
  if (String(authorization.dataFingerprint || '') !== normalizedReview.dataFingerprint) return false;
  if (authorization.outcome === 'explicitly-skipped') return Boolean(authorization.skipConfirmationCode);
  return (
    ['exported', 'recent-verified'].includes(authorization.outcome) &&
    Boolean(String(authorization.backupId || '').trim())
  );
}

export function getAccountRemovalPhaseLabel(stage) {
  return phaseLabels[stage] || '账号删除处理中';
}

export function getAccountRemovalErrorMessage(error) {
  const rawMessage = error instanceof Error ? error.message : String(error || '账号删除失败');
  const code = String(
    error?.code ||
      error?.payload?.error?.code ||
      (/^(?:ACCOUNT_REMOVAL|RECOVERY)_[A-Z0-9_]+$/u.test(rawMessage) ? rawMessage : '')
  ).trim();
  if (errorMessages[code]) return errorMessages[code];
  if (code && rawMessage === code) return '账号删除尚未确认完成，请查看原任务状态后继续。';
  return /\p{Script=Han}/u.test(rawMessage) ? rawMessage : '账号删除尚未确认完成，请查看原任务状态后继续。';
}

export function getAccountRemovalAccountLabel(account = {}, owner = {}) {
  if (owner?.ownerType === 'model_api_account') return '接口配置';
  return String(
    account?.displayName || account?.secondaryLabel || accountRemovalOwnerLabels[owner?.ownerType] || '当前账号'
  ).trim();
}

export function summarizeAccountRemovalPreview(preview = {}) {
  const source = preview && typeof preview === 'object' ? preview : {};
  const planned = Array.isArray(source.plannedResources) ? source.plannedResources : [];
  const preserved = Array.isArray(source.preserveResources) ? source.preserveResources : [];
  return {
    plannedCount: planned.length,
    preservedCount: preserved.length,
    barrierCount: new Set(
      [
        ...(Array.isArray(source.quiesceResources) ? source.quiesceResources : []),
        ...(Array.isArray(source.fenceResources) ? source.fenceResources : []),
        ...(Array.isArray(source.drainResources) ? source.drainResources : []),
      ]
        .map((entry) => entry?.resourceId || entry?.id)
        .filter(Boolean)
    ).size,
  };
}
