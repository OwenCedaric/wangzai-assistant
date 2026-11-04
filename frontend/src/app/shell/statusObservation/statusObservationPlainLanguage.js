export const STATUS_OBSERVATION_CATEGORIES = Object.freeze([
  { id: 'all', title: '全部' },
  { id: 'ozon', title: '平台连接' },
  { id: 'local', title: '软件后台' },
  { id: 'cache', title: '本地数据' },
  { id: 'sync', title: '数据更新' },
  { id: 'write', title: '操作结果' },
  { id: 'network', title: '网络' },
  { id: 'maintenance', title: '数据安全' },
  { id: 'performance', title: '软件速度' },
]);

export const STATUS_OBSERVATION_DOMAIN_LABELS = Object.freeze({
  products: '商品',
  orders: '销售订单',
  returns: '售后',
  marketing: '营销活动',
  finance: '财务',
  profit: '利润',
  logistics: '物流',
  catalog: '类目',
  images: '图片',
  reports: '报表',
  purchase: '拍单',
});

export function getStatusObservationDomainLabel(domain) {
  return STATUS_OBSERVATION_DOMAIN_LABELS[domain] || domain || '业务数据';
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function formatRetryCountdown(value, now = Date.now()) {
  const retryAt = value ? new Date(value).getTime() : 0;
  if (!Number.isFinite(retryAt) || retryAt <= 0) return '';
  const remainingMs = retryAt - Number(now);
  if (remainingMs <= 0) return '等待下一轮自动重试';
  if (remainingMs < 60_000) return `约 ${Math.max(1, Math.ceil(remainingMs / 1000))} 秒后自动重试`;
  if (remainingMs < 3_600_000) return `约 ${Math.max(1, Math.ceil(remainingMs / 60_000))} 分钟后自动重试`;
  return `约 ${Math.max(1, Math.ceil(remainingMs / 3_600_000))} 小时后自动重试`;
}

export function getFriendlyBackgroundFailure(value = '') {
  const message = String(value || '');
  if (/429|rate.?limit|too many|circuit.?open|限流/i.test(message)) return 'Ozon 暂时限制继续读取';
  if (/timeout|timed out|超时/i.test(message)) return '等待 Ozon 返回超时';
  if (/401|403|unauthor|forbidden|credential|api.?key|client.?id|授权|凭证|权限/i.test(message)) {
    return '店铺授权失效或当前权限不足';
  }
  if (/Failed to fetch|NetworkError|Load failed|ECONN|network|网络/i.test(message)) return '网络连接不稳定';
  if (/temporarily unavailable|service unavailable|HTTP\s*5\d\d/i.test(message)) return 'Ozon 服务暂时不可用';
  if (/service_not_connected/i.test(message)) return '商品更新服务尚未连接';
  if (/shop_not_active|credentials_missing/i.test(message)) return '店铺尚未启用或授权不完整';
  return '本次后台更新没有完成';
}

export function getSchedulerDomainQueueCount(status = {}, domain = '') {
  const items = Array.isArray(status?.queue?.queuedItems) ? status.queue.queuedItems : [];
  return items.filter((item) => String(item?.domain || '') === String(domain || '')).length;
}

export function buildSchedulerRunningCards(status = {}, fallbackStats = {}) {
  const queue = status?.queue || {};
  const hasSchedulerStatus = status?.ok === true && status?.queue;
  const running = hasSchedulerStatus ? positiveNumber(queue.running) : positiveNumber(fallbackStats.active);
  const queued = hasSchedulerStatus ? positiveNumber(queue.queued) : positiveNumber(fallbackStats.queued);
  if (!running && !queued) return [];

  const productQueued = getSchedulerDomainQueueCount(status, 'products');
  const orderQueued = getSchedulerDomainQueueCount(status, 'orders');
  const details = [];
  if (productQueued) details.push(`商品缓存排队 ${productQueued} 个`);
  if (orderQueued) details.push(`订单缓存排队 ${orderQueued} 个`);
  if (!details.length) details.push(queued ? `全部排队 ${queued} 个` : '当前没有排队任务');

  return [{
    id: 'scheduler-running',
    source: 'local',
    category: 'sync',
    tone: 'running',
    title: '当前任务排队情况',
    state: details.join(' · '),
    stage: queued ? '按顺序处理中' : '正在处理',
    progress: `后台任务共 ${running + queued} 个`,
    solution: '系统会自动按顺序完成，不需要重复点击刷新。',
    userActionRequired: false,
  }];
}

function formatBytes(value) {
  const bytes = positiveNumber(value);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function buildMaintenanceObservationCards(status = {}) {
  if (status?.loading && !status?.loaded) {
    return [{
      id: 'maintenance-loading',
      source: 'system',
      category: 'maintenance',
      tone: 'running',
      title: '正在检查本地数据',
      state: '只检查数据是否需要维护，不会修改或删除',
      stage: '安全检查',
      progress: '通常几秒内完成',
      solution: '检查完成后会自动更新。',
      userActionRequired: false,
    }];
  }

  if (status?.error && !status?.loaded) {
    return [{
      id: 'maintenance-unavailable',
      source: 'system',
      category: 'maintenance',
      tone: 'warning',
      attention: true,
      title: '本地数据检查暂未完成',
      state: '本次检查没有返回结果，已有商品和订单不会受影响',
      stage: '等待下次检查',
      progress: '没有修改任何数据',
      solution: '先正常使用，稍后重新打开“运行状态”即可。',
      userActionRequired: false,
    }];
  }

  if (!status?.loaded && status?.ok !== true) return [];
  const data = status?.data || status;
  const cards = [];
  const unclassifiedTables = positiveNumber(data.unclassifiedTables);
  const emptyShopRows = positiveNumber(data.emptyShopRows);
  const manualAssignmentRows = positiveNumber(data.manualAssignmentRows);
  const safeRepairRows = positiveNumber(data.safeRepairRows);
  const technicalCleanupRows = positiveNumber(data.technicalCleanupRows);
  const reclaimableBytes = positiveNumber(data.reclaimableBytes);

  if (data.ok === false) {
    cards.push({
      id: 'maintenance-partial-check',
      source: 'system',
      category: 'maintenance',
      tone: 'warning',
      attention: true,
      title: '本地数据检查没有全部完成',
      state: '部分检查暂时没有返回，系统没有修改任何数据',
      stage: '等待下次检查',
      progress: '商品和订单继续使用现有本地数据',
      solution: '稍后重新打开“运行状态”；连续出现时再重新打开软件。',
      userActionRequired: false,
    });
  }

  if (manualAssignmentRows) {
    cards.push({
      id: 'maintenance-manual-shop-assignment',
      source: 'system',
      category: 'maintenance',
      tone: 'warning',
      attention: true,
      title: `${manualAssignmentRows} 条数据需要选择所属店铺`,
      state: '系统无法安全判断这些数据属于哪个店铺，因此没有自动分配',
      stage: '等待人工确认',
      progress: `待确认 ${manualAssignmentRows} 条`,
      solution: '需要你确认所属店铺；未确认前数据会原样保留。',
      userActionRequired: true,
    });
  }

  const otherEmptyShopRows = Math.max(0, emptyShopRows - manualAssignmentRows);
  if (otherEmptyShopRows || safeRepairRows) {
    cards.push({
      id: 'maintenance-empty-shop-scope',
      source: 'system',
      category: 'maintenance',
      tone: 'warning',
      attention: true,
      title: `${Math.max(otherEmptyShopRows, safeRepairRows)} 条数据没有店铺信息`,
      state: '系统已暂停自动处理，避免把数据放错店铺',
      stage: '安全保留',
      progress: safeRepairRows ? `可安全修复 ${safeRepairRows} 条` : '等待维护处理',
      solution: '数据仍被保留，需要时再由维护流程处理。',
      userActionRequired: false,
    });
  }

  if (unclassifiedTables) {
    cards.push({
      id: 'maintenance-unclassified-tables',
      source: 'system',
      category: 'maintenance',
      tone: 'problem',
      attention: true,
      title: '本地数据分类需要更新',
      state: `发现 ${unclassifiedTables} 项软件数据尚未登记用途，系统不会自动清理`,
      stage: '停止自动清理',
      progress: `待维护确认 ${unclassifiedTables} 项`,
      solution: '请联系维护人员确认，期间不要手动删除本地数据库文件。',
      userActionRequired: true,
    });
  }

  if (technicalCleanupRows) {
    cards.push({
      id: 'maintenance-technical-cleanup',
      source: 'system',
      category: 'maintenance',
      tone: 'healthy',
      title: '有过期运行记录可以整理',
      state: '这些只是旧日志和已结束任务，不包含商品、订单或设置',
      stage: '可选整理',
      progress: `可整理 ${technicalCleanupRows} 条`,
      solution: '继续正常使用即可。',
      userActionRequired: false,
    });
  }

  if (reclaimableBytes >= 1024 * 1024) {
    cards.push({
      id: 'maintenance-reclaimable-space',
      source: 'system',
      category: 'maintenance',
      tone: 'healthy',
      title: '本地数据库有空间可以释放',
      state: '这只是缩小本地文件，不会删除商品或订单记录',
      stage: '可选整理',
      progress: `预计可释放 ${formatBytes(reclaimableBytes)}`,
      solution: '磁盘空间紧张时再处理。',
      userActionRequired: false,
    });
  }

  if (!cards.length) {
    cards.push({
      id: 'maintenance-healthy',
      source: 'system',
      category: 'maintenance',
      tone: 'healthy',
      title: '本地数据检查正常',
      state: '没有发现串店、待归属或需要清理的问题',
      stage: '检查完成',
      progress: '业务数据保持原样',
      solution: '当前不需要处理。',
      userActionRequired: false,
    });
  }

  return cards;
}
