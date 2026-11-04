export const COLLECTION_PRODUCT_IMAGE_HISTORY_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
export const COLLECTION_PRODUCT_IMAGE_HISTORY_LIMIT = 50;

function text(value, maximum = 2_400) {
  return String(value ?? '').replace(/\p{Cc}/gu, '').trim().slice(0, maximum);
}

function timestamp(value, nowMs) {
  const parsed = Date.parse(text(value, 80));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(nowMs).toISOString();
}

function imageAssetShopIdFromUrl(value) {
  const raw = text(value, 4_000);
  if (!raw) return '';
  try {
    const parsed = new URL(raw, 'https://wangzai.local');
    return text(parsed.searchParams.get('shopId') || parsed.searchParams.get('shop_id'), 180);
  } catch {
    return '';
  }
}

export function resolveCollectionProductImageAssetShopId(item = {}, fallbackShopId = '') {
  return text(
    item.assetShopId
      || item.imageAssetShopId
      || imageAssetShopIdFromUrl(item.imageUrl)
      || imageAssetShopIdFromUrl(item.previewUrl)
      || imageAssetShopIdFromUrl(item.thumbnailUrl)
      || fallbackShopId,
    180,
  );
}

function settlementRank(item = {}) {
  if (item.storageScope === 'permanent') return 5;
  if (text(item.assetId)) return 4;
  if (item.persistenceStatus === 'completed') return 3;
  if (text(item.imageUrl || item.previewUrl)) return 2;
  return 1;
}

export function normalizeCollectionProductImageHistoryItem(item = {}) {
  const persistenceStatus = ['pending', 'completed', 'error'].includes(item.persistenceStatus)
    ? item.persistenceStatus
    : text(item.assetId) ? 'completed' : 'pending';
  return {
    sourceIndex: Number.isInteger(item.sourceIndex) ? item.sourceIndex : Number(item.sourceIndex) || 0,
    assetId: text(item.assetId || item.result?.asset?.id || item.result?.asset?.assetId, 240),
    taskId: text(item.taskId || item.result?.taskId || item.result?.task?.id, 240),
    sourceImageUrl: text(item.sourceImageUrl || item.sourceUrl, 4_000),
    sourceSkuId: text(item.sourceSkuId || item.skuId, 260),
    assetShopId: resolveCollectionProductImageAssetShopId(item),
    imageUrl: text(item.imageUrl || item.result?.imageUrl, 4_000),
    previewUrl: text(item.previewUrl || item.result?.previewUrl || item.result?.asset?.previewUrl, 4_000),
    thumbnailUrl: text(item.thumbnailUrl || item.result?.thumbnailUrl || item.result?.asset?.thumbnailUrl, 4_000),
    storageScope: ['temporary', 'permanent'].includes(item.storageScope || item.result?.asset?.storageScope)
      ? (item.storageScope || item.result?.asset?.storageScope)
      : '',
    persistenceStatus,
    persistenceMessage: text(item.persistenceMessage, 1_000),
  };
}

export function normalizeCollectionProductGeneratedImageSelections(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(['main', 'sku', 'detail'].flatMap((group) => {
    const selection = source[group];
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return [];
    const bySourceIndex = new Map();
    const selectionShopId = text(selection.assetShopId || selection.shopId, 180);
    (Array.isArray(selection.items) ? selection.items : []).forEach((item) => {
      const normalized = normalizeCollectionProductImageHistoryItem({
        ...item,
        assetShopId: resolveCollectionProductImageAssetShopId(item, selectionShopId),
      });
      if (!normalized.assetId && !normalized.taskId && !normalized.imageUrl && !normalized.previewUrl) return;
      bySourceIndex.set(normalized.sourceIndex, mergeHistoryItem(bySourceIndex.get(normalized.sourceIndex), normalized));
    });
    const items = [...bySourceIndex.values()].sort((left, right) => left.sourceIndex - right.sourceIndex);
    if (!items.length) return [];
    return [[group, {
      historyEntryId: text(selection.historyEntryId, 240),
      assetShopId: resolveCollectionProductImageAssetShopId(items[0], selectionShopId),
      items,
    }]];
  }));
}

export function withCollectionProductGeneratedImageSelection(value = {}, entry = {}) {
  const current = normalizeCollectionProductGeneratedImageSelections(value);
  const normalizedEntry = normalizeCollectionProductImageHistoryEntry(entry);
  if (!normalizedEntry.items.length) return current;
  const active = current[normalizedEntry.group];
  const incomingItems = active?.historyEntryId === normalizedEntry.id
    ? normalizedEntry.items.map((item) => {
        const existing = active.items.find((candidate) => candidate.sourceIndex === item.sourceIndex);
        return mergeHistoryItem(existing, item);
      })
    : normalizedEntry.items;
  return {
    ...current,
    [normalizedEntry.group]: {
      historyEntryId: normalizedEntry.id,
      assetShopId: normalizedEntry.shopId,
      items: incomingItems,
    },
  };
}

// A normal generation run may target only one or a few source positions.  It
// must replace those exact positions without dropping the other images that
// the user has already confirmed for upload.  Re-applying a history batch
// still uses withCollectionProductGeneratedImageSelection above because that
// action intentionally restores the selected batch as a whole.
export function mergeCollectionProductGeneratedImageSelection(value = {}, entry = {}) {
  const current = normalizeCollectionProductGeneratedImageSelections(value);
  const normalizedEntry = normalizeCollectionProductImageHistoryEntry(entry);
  const replaceSourceIndexes = new Set(
    (Array.isArray(entry.replaceSourceIndexes) ? entry.replaceSourceIndexes : [])
      .map(Number)
      .filter((item) => Number.isInteger(item) && item >= 0)
  );
  const active = current[normalizedEntry.group];
  const sameGenerationBatch = Boolean(active?.historyEntryId && active.historyEntryId === normalizedEntry.id);
  const bySourceIndex = new Map((active?.items || []).map((item) => [item.sourceIndex, item]));
  if (!sameGenerationBatch) {
    replaceSourceIndexes.forEach((sourceIndex) => bySourceIndex.delete(sourceIndex));
  }
  normalizedEntry.items.forEach((item) => {
    bySourceIndex.set(
      item.sourceIndex,
      sameGenerationBatch ? mergeHistoryItem(bySourceIndex.get(item.sourceIndex), item) : item,
    );
  });
  if (!normalizedEntry.items.length && !replaceSourceIndexes.size) return current;
  if (!bySourceIndex.size) {
    const next = { ...current };
    delete next[normalizedEntry.group];
    return next;
  }
  return {
    ...current,
    [normalizedEntry.group]: {
      historyEntryId: normalizedEntry.id || active?.historyEntryId || '',
      assetShopId: normalizedEntry.shopId || active?.assetShopId || '',
      items: [...bySourceIndex.values()].sort((left, right) => left.sourceIndex - right.sourceIndex),
    },
  };
}

export function withCollectionProductGeneratedImageItemSelection(value = {}, input = {}) {
  if (input.selected === false) return removeCollectionProductGeneratedImageSelection(value, input);
  const current = normalizeCollectionProductGeneratedImageSelections(value);
  const group = ['main', 'sku', 'detail'].includes(input.group) ? input.group : 'main';
  const normalized = normalizeCollectionProductImageHistoryItem(input.item || input);
  if (!normalized.assetId && !normalized.taskId && !normalized.imageUrl && !normalized.previewUrl) return current;
  const active = current[group];
  const bySourceIndex = new Map((active?.items || []).map((item) => [item.sourceIndex, item]));
  bySourceIndex.set(normalized.sourceIndex, mergeHistoryItem(bySourceIndex.get(normalized.sourceIndex), normalized));
  return {
    ...current,
    [group]: {
      historyEntryId: text(input.historyEntryId || active?.historyEntryId, 240),
      assetShopId: resolveCollectionProductImageAssetShopId(normalized, active?.assetShopId),
      items: [...bySourceIndex.values()].sort((left, right) => left.sourceIndex - right.sourceIndex),
    },
  };
}

export function isCollectionProductGeneratedImageSelected(value = {}, input = {}) {
  const current = normalizeCollectionProductGeneratedImageSelections(value);
  const group = ['main', 'sku', 'detail'].includes(input.group) ? input.group : 'main';
  const sourceIndex = Number(input.sourceIndex);
  const assetId = text(input.assetId, 240);
  const taskId = text(input.taskId, 240);
  const imageUrl = text(input.imageUrl || input.previewUrl, 4_000);
  return (current[group]?.items || []).some((item) => {
    if (Number.isInteger(sourceIndex)) return item.sourceIndex === sourceIndex;
    if (assetId) return item.assetId === assetId;
    if (taskId) return item.taskId === taskId;
    return Boolean(imageUrl && [item.imageUrl, item.previewUrl].includes(imageUrl));
  });
}

export function removeCollectionProductGeneratedImageSelection(value = {}, input = {}) {
  const current = normalizeCollectionProductGeneratedImageSelections(value);
  const group = ['main', 'sku', 'detail'].includes(input.group) ? input.group : 'main';
  const selection = current[group];
  if (!selection) return current;
  const sourceIndex = Number(input.sourceIndex);
  const assetId = text(input.assetId, 240);
  const taskId = text(input.taskId, 240);
  const imageUrl = text(input.imageUrl || input.previewUrl, 4_000);
  // A missing selector must never clear an entire group.  Callers may pass
  // stale/partial tile data while an async image result is settling; in that
  // case leave the selection untouched and let the UI retry with the full id.
  if (!Number.isInteger(sourceIndex) && !assetId && !taskId && !imageUrl) return current;
  const items = selection.items.filter((item) => {
    // Source position is the stable tile identity. Asset URLs and task ids can
    // change asynchronously when a provider preview is promoted to private OSS.
    if (Number.isInteger(sourceIndex)) return item.sourceIndex !== sourceIndex;
    if (assetId) return item.assetId !== assetId;
    if (taskId) return item.taskId !== taskId;
    return ![item.imageUrl, item.previewUrl].includes(imageUrl);
  });
  const next = { ...current };
  if (items.length) next[group] = { ...selection, items };
  else delete next[group];
  return next;
}

function mergeHistoryItem(current = {}, next = {}) {
  const left = normalizeCollectionProductImageHistoryItem(current);
  const right = normalizeCollectionProductImageHistoryItem(next);
  const preferred = settlementRank(right) >= settlementRank(left) ? right : left;
  const fallback = preferred === right ? left : right;
  return normalizeCollectionProductImageHistoryItem({
    ...fallback,
    ...preferred,
    assetId: preferred.assetId || fallback.assetId,
    taskId: preferred.taskId || fallback.taskId,
    sourceImageUrl: preferred.sourceImageUrl || fallback.sourceImageUrl,
    sourceSkuId: preferred.sourceSkuId || fallback.sourceSkuId,
    assetShopId: preferred.assetShopId || fallback.assetShopId,
    imageUrl: preferred.imageUrl || fallback.imageUrl,
    previewUrl: preferred.previewUrl || fallback.previewUrl,
    thumbnailUrl: preferred.thumbnailUrl || fallback.thumbnailUrl,
    persistenceStatus: preferred.persistenceStatus || fallback.persistenceStatus,
  });
}

function normalizeGroup(value) {
  return ['main', 'sku', 'detail'].includes(value) ? value : 'main';
}

function groupLabel(value) {
  if (value === 'sku') return 'SKU 图';
  if (value === 'detail') return '详情图';
  return '主图';
}

export function normalizeCollectionProductImageHistoryEntry(entry = {}, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const group = normalizeGroup(entry.group);
  const bySourceIndex = new Map();
  const entryShopId = text(entry.shopId, 180);
  (Array.isArray(entry.items) ? entry.items : []).forEach((item) => {
    const normalized = normalizeCollectionProductImageHistoryItem({
      ...item,
      assetShopId: resolveCollectionProductImageAssetShopId(item, entryShopId),
    });
    if (!normalized.assetId && !normalized.imageUrl && !normalized.previewUrl) return;
    bySourceIndex.set(normalized.sourceIndex, mergeHistoryItem(bySourceIndex.get(normalized.sourceIndex), normalized));
  });
  return {
    id: text(entry.id, 240) || `collection-image-history-${nowMs}`,
    shopId: entryShopId,
    productKey: text(entry.productKey || entry.sourceProductId || entry.sourceUrl, 2_400),
    sourceProductId: text(entry.sourceProductId, 260),
    sourcePlatform: text(entry.sourcePlatform, 120),
    sourceUrl: text(entry.sourceUrl, 2_400),
    productTitle: text(entry.productTitle, 1_000),
    group,
    groupLabel: text(entry.groupLabel, 120) || groupLabel(group),
    createdAt: timestamp(entry.createdAt, nowMs),
    plannerModel: text(entry.plannerModel, 240),
    model: text(entry.model, 240),
    items: [...bySourceIndex.values()].sort((left, right) => left.sourceIndex - right.sourceIndex),
  };
}

function retained(entry, nowMs) {
  const createdAt = Date.parse(entry.createdAt);
  return Number.isFinite(createdAt)
    && createdAt <= nowMs
    && nowMs - createdAt <= COLLECTION_PRODUCT_IMAGE_HISTORY_RETENTION_MS;
}

export function normalizeCollectionProductImageHistory(entries = [], options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => normalizeCollectionProductImageHistoryEntry(entry, { nowMs }))
    .filter((entry) => entry.shopId && entry.productKey && entry.items.length && retained(entry, nowMs))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, COLLECTION_PRODUCT_IMAGE_HISTORY_LIMIT);
}

export function upsertCollectionProductImageHistory(entries = [], entry = {}, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const current = normalizeCollectionProductImageHistory(entries, { nowMs });
  const incoming = normalizeCollectionProductImageHistoryEntry(entry, { nowMs });
  const existing = current.find((item) => item.id === incoming.id);
  const merged = existing
    ? normalizeCollectionProductImageHistoryEntry({
        ...existing,
        ...incoming,
        items: [...existing.items, ...incoming.items],
      }, { nowMs })
    : incoming;
  return normalizeCollectionProductImageHistory([
    merged,
    ...current.filter((item) => item.id !== merged.id),
  ], { nowMs });
}

export function countCollectionProductImageHistoryImages(entries = [], options = {}) {
  return normalizeCollectionProductImageHistory(entries, options)
    .reduce((total, entry) => total + entry.items.length, 0);
}

export function resolveCollectionProductImageHistoryUrl(item = {}, shopId = '') {
  const normalized = normalizeCollectionProductImageHistoryItem(item);
  if (normalized.assetId) {
    const query = text(shopId, 180) ? `?shopId=${encodeURIComponent(text(shopId, 180))}` : '';
    return `/api/product-images/preview/${encodeURIComponent(normalized.assetId)}${query}`;
  }
  return normalized.previewUrl || normalized.imageUrl;
}
