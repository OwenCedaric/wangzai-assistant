const PUBLICATION_STATUS_VALUES = new Set([
  'completed',
  'partial',
  'pending_readback',
  'failed',
  'preview_failed',
]);

function text(value) {
  return String(value ?? '').trim();
}

function normalizedStatus(value, fallback = 'failed') {
  const status = text(value).toLowerCase();
  return PUBLICATION_STATUS_VALUES.has(status) ? status : fallback;
}

function normalizePublicationShop(value = {}) {
  const shopId = text(value.shopId);
  if (!shopId) return null;
  const uploaded = value.uploaded === true || value.completed === true;
  const expectedSkuCount = Math.max(0, Math.trunc(Number(value.expectedSkuCount) || 0));
  const matchedSkuCount = Math.min(
    expectedSkuCount || Number.MAX_SAFE_INTEGER,
    Math.max(0, Math.trunc(Number(value.matchedSkuCount) || 0)),
  );
  const partiallyUploaded = !uploaded && matchedSkuCount > 0;
  return {
    shopId,
    shopLabel: text(value.shopLabel) || shopId,
    uploaded,
    partiallyUploaded,
    readBackVerified: (uploaded || partiallyUploaded) && value.readBackVerified !== false,
    expectedSkuCount,
    matchedSkuCount,
    status: uploaded ? 'completed' : partiallyUploaded ? 'partial' : normalizedStatus(value.status),
    lastAttemptStatus: normalizedStatus(value.lastAttemptStatus || value.status),
    error: text(value.error),
    updatedAt: text(value.updatedAt),
  };
}

export function normalizeCollectionProductPublication(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const shops = (Array.isArray(value.shops) ? value.shops : [])
    .map(normalizePublicationShop)
    .filter(Boolean);
  if (!shops.length) return null;
  return {
    version: 1,
    status: normalizedStatus(value.status, shops.every((shop) => shop.uploaded) ? 'completed' : 'failed'),
    operationId: text(value.operationId),
    updatedAt: text(value.updatedAt),
    shops,
  };
}

export function mergeCollectionProductPublicationResult(previous, result = {}, updatedAt = new Date().toISOString()) {
  const prior = normalizeCollectionProductPublication(previous);
  const priorByShop = new Map((prior?.shops || []).map((shop) => [shop.shopId, shop]));
  const shopResults = Array.isArray(result.shopResults) ? result.shopResults : [];
  shopResults.forEach((entry) => {
    const shopId = text(entry?.shopId);
    if (!shopId) return;
    const existing = priorByShop.get(shopId);
    const completed = entry?.completed === true || normalizedStatus(entry?.status) === 'completed';
    const uploaded = existing?.uploaded === true || completed;
    const expectedSkuCount = Math.max(
      Number(existing?.expectedSkuCount) || 0,
      Math.trunc(Number(entry?.expectedSkuCount) || 0),
    );
    const matchedSkuCount = uploaded
      ? Math.max(expectedSkuCount, Number(existing?.matchedSkuCount) || 0, Number(entry?.matchedSkuCount) || 0)
      : Math.max(Number(existing?.matchedSkuCount) || 0, Math.trunc(Number(entry?.matchedSkuCount) || 0));
    const partiallyUploaded = !uploaded && matchedSkuCount > 0;
    priorByShop.set(shopId, {
      shopId,
      shopLabel: text(entry?.shopLabel) || existing?.shopLabel || shopId,
      uploaded,
      partiallyUploaded,
      readBackVerified: uploaded || partiallyUploaded,
      expectedSkuCount,
      matchedSkuCount,
      status: uploaded ? 'completed' : partiallyUploaded ? 'partial' : normalizedStatus(entry?.status),
      lastAttemptStatus: completed ? 'completed' : normalizedStatus(entry?.status),
      error: completed ? '' : text(entry?.error),
      updatedAt,
    });
  });
  const shops = [...priorByShop.values()];
  if (!shops.length) return prior;
  return normalizeCollectionProductPublication({
    version: 1,
    status: normalizedStatus(result.status, shops.every((shop) => shop.uploaded) ? 'completed' : 'partial'),
    operationId: text(result.operationId) || prior?.operationId || '',
    updatedAt,
    shops,
  });
}

export function getCollectionProductPublicationSummary(product = {}, shops = []) {
  const publication = normalizeCollectionProductPublication(product.ozonPublication);
  if (!publication) return {
    state: 'not-uploaded',
    label: '未上传',
    shopLabels: [],
    detail: '尚未通过 Ozon 上传回读校验',
  };
  const shopNameById = new Map((Array.isArray(shops) ? shops : []).map((shop) => [
    text(shop?.id || shop?.shopId),
    text(shop?.alias || shop?.name || shop?.shopName),
  ]));
  const uploaded = publication.shops.filter((shop) => shop.uploaded && shop.readBackVerified);
  const shopLabels = uploaded.map((shop) => shopNameById.get(shop.shopId) || shop.shopLabel || shop.shopId);
  if (shopLabels.length) return {
    state: 'uploaded',
    label: '已上传',
    shopLabels,
    detail: `已通过 Ozon 回读：${shopLabels.join('、')}`,
  };
  const partialShops = publication.shops.filter((shop) => (
    shop.partiallyUploaded && shop.readBackVerified && shop.matchedSkuCount > 0
  ));
  if (partialShops.length) {
    const partialLabels = partialShops.map((shop) => shopNameById.get(shop.shopId) || shop.shopLabel || shop.shopId);
    const counts = partialShops
      .map((shop) => `${shop.matchedSkuCount}/${shop.expectedSkuCount || '?'}`)
      .join('、');
    return {
      state: 'partial',
      label: '部分上传',
      shopLabels: partialLabels,
      detail: `Ozon 已找到部分 SKU：${partialLabels.join('、')}（${counts}）`,
    };
  }
  const pending = publication.shops.some((shop) => shop.status === 'pending_readback');
  return {
    state: pending ? 'pending' : 'not-uploaded',
    label: pending ? '等待回读' : '未上传',
    shopLabels: [],
    detail: pending ? 'Ozon 已受理，正在等待完整回读' : '最近一次上传尚未完成',
  };
}
