import { getProfileSetting, saveProfileSetting } from '../../../api/localApiClient.js';

export const SMART_TOOL_IMAGE_HISTORY_NAMESPACE = 'smart-tool-image-generation-history';
export const SMART_TOOL_IMAGE_HISTORY_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_HISTORY_PER_TOOL = 50;
const DEFAULT_ACCOUNT_SCOPE = 'default';
const DEFAULT_SHOP_SCOPE = 'unassigned';

function text(value) {
  return String(value ?? '').trim();
}

function isDataUrl(value) {
  return /^data:image\//iu.test(text(value));
}

function normalizeHistoryItem(item = {}) {
  const assetId = text(item.assetId || item.result?.asset?.id || item.result?.asset?.assetId);
  const assetPreviewUrl = assetId ? `/api/product-images/preview/${encodeURIComponent(assetId)}` : '';
  const sourceImageUrl = text(item.imageUrl || item.previewUrl || assetPreviewUrl);
  const previewUrl = text(item.previewUrl || assetPreviewUrl || (!isDataUrl(sourceImageUrl) ? sourceImageUrl : ''));
  return {
    sourceIndex: Number.isInteger(item.sourceIndex) ? item.sourceIndex : Number(item.sourceIndex) || 0,
    assetId,
    imageUrl: isDataUrl(sourceImageUrl) ? previewUrl : sourceImageUrl,
    previewUrl,
  };
}

function normalizeHistoryTimestamp(value, nowMs) {
  const raw = text(value);
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return raw ? '' : new Date(nowMs).toISOString();
}

function isRetainedHistoryEntry(entry, nowMs) {
  const createdAt = Date.parse(entry.createdAt);
  return Number.isFinite(createdAt)
    && createdAt <= nowMs
    && nowMs - createdAt <= SMART_TOOL_IMAGE_HISTORY_RETENTION_MS;
}

export function normalizeSmartToolImageHistoryEntry(entry = {}, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const items = (Array.isArray(entry.items) ? entry.items : []).map(normalizeHistoryItem).filter((item) => item.imageUrl || item.assetId);
  return {
    id: text(entry.id) || `image-history-${Date.now()}`,
    accountId: text(entry.accountId || entry.profileId || entry.profile_id) || DEFAULT_ACCOUNT_SCOPE,
    shopId: text(entry.shopId || entry.shop_id) || DEFAULT_SHOP_SCOPE,
    productKey: text(entry.productKey || entry.offerId || entry.productId || entry.productTitle),
    offerId: text(entry.offerId),
    productId: text(entry.productId),
    sku: text(entry.sku),
    skuFacts: text(entry.skuFacts),
    productTitle: text(entry.productTitle),
    group: entry.group === 'detail' ? 'detail' : 'main',
    groupLabel: text(entry.groupLabel) || (entry.group === 'detail' ? '详情图' : '主图'),
    createdAt: normalizeHistoryTimestamp(entry.createdAt, nowMs),
    plannerModel: text(entry.plannerModel),
    model: text(entry.model),
    items,
  };
}

export function normalizeSmartToolImageHistoryMap(value, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  return Object.fromEntries(
    Object.entries(value).map(([toolId, entries]) => [
      toolId,
      (Array.isArray(entries) ? entries : [])
        .map((entry) => normalizeSmartToolImageHistoryEntry(entry, { nowMs }))
        .filter((entry) => entry.items.length && entry.productKey && isRetainedHistoryEntry(entry, nowMs))
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
        .slice(0, MAX_HISTORY_PER_TOOL),
    ])
  );
}

export function mergeSmartToolImageHistoryMaps(savedValue, currentValue, options = {}) {
  const saved = normalizeSmartToolImageHistoryMap(savedValue, options);
  const current = normalizeSmartToolImageHistoryMap(currentValue, options);
  const toolIds = new Set([...Object.keys(saved), ...Object.keys(current)]);
  return Object.fromEntries([...toolIds].map((toolId) => {
    const byId = new Map();
    [...(current[toolId] || []), ...(saved[toolId] || [])].forEach((entry) => {
      if (!byId.has(entry.id)) byId.set(entry.id, entry);
    });
    return [toolId, [...byId.values()]
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, MAX_HISTORY_PER_TOOL)];
  }));
}

export function filterSmartToolImageHistory(entries = [], scope = {}, options = {}) {
  const accountId = text(scope.accountId || scope.profileId || scope.profile_id) || DEFAULT_ACCOUNT_SCOPE;
  const shopId = text(scope.shopId || scope.shop_id) || DEFAULT_SHOP_SCOPE;
  const productKey = text(scope.productKey || scope.offerId || scope.productId || scope.productTitle);
  const sku = text(scope.sku);
  if (!productKey) return [];
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => normalizeSmartToolImageHistoryEntry(entry, options))
    .filter((entry) => (
      isRetainedHistoryEntry(entry, Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now())
      && entry.accountId === accountId
      && entry.shopId === shopId
      && entry.productKey === productKey
      && (!sku || entry.sku === sku)
    ));
}

export async function loadSmartToolImageGenerationHistory(options = {}) {
  const response = await getProfileSetting(SMART_TOOL_IMAGE_HISTORY_NAMESPACE, {
    timeoutMs: options.timeoutMs || 10000,
    signal: options.signal,
  });
  const savedValue = response?.setting?.value;
  const normalized = normalizeSmartToolImageHistoryMap(savedValue, { nowMs: options.nowMs });
  if (JSON.stringify(savedValue || {}) !== JSON.stringify(normalized)) {
    try {
      await saveProfileSetting(SMART_TOOL_IMAGE_HISTORY_NAMESPACE, normalized, {
        timeoutMs: options.timeoutMs || 30000,
        signal: options.signal,
      });
    } catch {
      // Expired rows are already hidden in memory. A later successful save
      // will retry the physical cleanup without blocking the workbench.
    }
  }
  return normalized;
}

export async function saveSmartToolImageGenerationHistory(historyMap, options = {}) {
  const savedResponse = await getProfileSetting(SMART_TOOL_IMAGE_HISTORY_NAMESPACE, {
    timeoutMs: options.readTimeoutMs || options.timeoutMs || 10000,
    signal: options.signal,
  });
  const normalized = mergeSmartToolImageHistoryMaps(savedResponse?.setting?.value, historyMap, {
    nowMs: options.nowMs,
  });
  const response = await saveProfileSetting(SMART_TOOL_IMAGE_HISTORY_NAMESPACE, normalized, {
    timeoutMs: options.timeoutMs || 30000,
    signal: options.signal,
  });
  return normalizeSmartToolImageHistoryMap(response?.setting?.value || normalized, { nowMs: options.nowMs });
}
