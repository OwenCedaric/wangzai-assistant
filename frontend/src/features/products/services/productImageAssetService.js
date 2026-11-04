import { requestLocalApi } from '../../../api/localApiClient.js';

export const PRODUCT_IMAGE_OSS_FREEZE_VERSION = 'product-image-oss-v94-server-template-current-flow-20260828';

const MAX_PREVIEW_BATCH_SIZE = 50;
const PREVIEW_CACHE_FALLBACK_TTL_MS = 2 * 60 * 1000;
const PREVIEW_CACHE_SAFETY_MS = 30 * 1000;
const productImagePreviewLookup = new Map();

function normalizeText(value) {
  return value == null ? '' : String(value).trim();
}

export function isLocalProductImage(value) {
  return /^data:image\/(?:png|jpeg|webp);base64,/iu.test(normalizeText(value));
}

export function getLocalProductImageAssetId(value) {
  const normalized = normalizeText(value);
  const match = normalized.match(/\/api\/(?:product-images\/preview|profile-assets)\/([^/?#]+)/iu);
  if (!match) return '';
  try { return decodeURIComponent(match[1]); } catch { return match[1]; }
}

export async function importProductImage(input = {}, options = {}) {
  return requestLocalApi('/api/product-images/import', {
    method: 'POST',
    body: input,
    timeoutMs: options.timeoutMs || 45_000,
    signal: options.signal,
  });
}

export async function editProductImage(input = {}, options = {}) {
  return requestLocalApi('/api/product-images/edit', {
    method: 'POST',
    body: input,
    timeoutMs: options.timeoutMs || 150_000,
    signal: options.signal,
  });
}

export async function generateProductImage(input = {}, options = {}) {
  return requestLocalApi('/api/product-images/generate', {
    method: 'POST',
    body: input,
    timeoutMs: options.timeoutMs || 180_000,
    signal: options.signal,
  });
}

export async function readProductImagePersistenceTask(taskId, options = {}) {
  const normalizedTaskId = normalizeText(taskId);
  if (!normalizedTaskId) throw new Error('缺少图片保存任务。');
  const shopId = normalizeText(options.shopId);
  const query = shopId ? `?shopId=${encodeURIComponent(shopId)}` : '';
  return requestLocalApi(`/api/product-images/tasks/${encodeURIComponent(normalizedTaskId)}${query}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs || 10_000,
    signal: options.signal,
  });
}

export async function readProductImageAssetPreview(assetId, options = {}) {
  const normalizedAssetId = normalizeText(assetId);
  if (!normalizedAssetId) throw new Error('缺少图片资产。');
  const shopId = normalizeText(options.shopId);
  if (!shopId) throw new Error('缺少当前 Ozon 店铺。');
  const cacheKey = `${shopId}::${normalizedAssetId}`;
  const cached = productImagePreviewLookup.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.asset;
  const payload = await requestLocalApi(
    `/api/product-images/assets/${encodeURIComponent(normalizedAssetId)}/preview?shopId=${encodeURIComponent(shopId)}`,
    {
      method: 'GET',
      timeoutMs: options.timeoutMs || 10_000,
      signal: options.signal,
    },
  );
  const asset = payload?.asset || null;
  if (asset) cacheProductImageAssetPreview(asset, shopId);
  return asset;
}

function cacheProductImageAssetPreview(asset, shopId) {
  const assetId = normalizeText(asset?.id);
  if (!assetId || !shopId) return;
  const ttlSeconds = Number(asset?.previewUrlExpiresInSeconds);
  const ttlMs = Number.isFinite(ttlSeconds) && ttlSeconds > 0
    ? Math.max(5_000, ttlSeconds * 1000 - PREVIEW_CACHE_SAFETY_MS)
    : PREVIEW_CACHE_FALLBACK_TTL_MS;
  productImagePreviewLookup.set(`${shopId}::${assetId}`, {
    asset,
    expiresAt: Date.now() + ttlMs,
  });
}

export async function readProductImageAssetPreviews(assetIds = [], options = {}) {
  const shopId = normalizeText(options.shopId);
  if (!shopId) throw new Error('缺少当前 Ozon 店铺。');
  const normalizedAssetIds = [...new Set((Array.isArray(assetIds) ? assetIds : [])
    .map((assetId) => normalizeText(assetId))
    .filter(Boolean))];
  if (normalizedAssetIds.length > MAX_PREVIEW_BATCH_SIZE) {
    throw new Error(`一次最多读取 ${MAX_PREVIEW_BATCH_SIZE} 张历史图片。`);
  }
  const now = Date.now();
  const assetsById = new Map();
  const missingAssetIds = [];
  normalizedAssetIds.forEach((assetId) => {
    const cached = productImagePreviewLookup.get(`${shopId}::${assetId}`);
    if (cached && cached.expiresAt > now) assetsById.set(assetId, cached.asset);
    else missingAssetIds.push(assetId);
  });
  if (missingAssetIds.length) {
    const payload = await requestLocalApi('/api/product-images/assets/previews', {
      method: 'POST',
      body: { shopId, assetIds: missingAssetIds },
      timeoutMs: options.timeoutMs || 10_000,
      signal: options.signal,
    });
    (Array.isArray(payload?.assets) ? payload.assets : []).forEach((asset) => {
      const assetId = normalizeText(asset?.id);
      if (!assetId) return;
      cacheProductImageAssetPreview(asset, shopId);
      assetsById.set(assetId, asset);
    });
  }
  return normalizedAssetIds.map((assetId) => assetsById.get(assetId)).filter(Boolean);
}

export function clearProductImageAssetPreviewCache() {
  productImagePreviewLookup.clear();
}

export async function waitForProductImagePersistenceTask(taskId, options = {}) {
  const timeoutMs = Math.max(5_000, Number(options.persistenceTimeoutMs) || 150_000);
  const pollIntervalMs = Math.max(250, Number(options.persistencePollIntervalMs) || 800);
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const payload = await readProductImagePersistenceTask(taskId, options);
    const task = payload?.task || {};
    if (task.status === 'completed' && task.result) return task.result;
    if (task.status === 'failed') throw new Error(task.error?.message || '图片后台保存失败。');
    await new Promise((resolve) => globalThis.setTimeout(resolve, pollIntervalMs));
  }
  throw new Error('图片已经生成，但后台保存超时；可继续预览，稍后再尝试替换。');
}

export async function promoteProductImage(input = {}, options = {}) {
  return requestLocalApi('/api/product-images/promote', {
    method: 'POST',
    body: input,
    timeoutMs: options.timeoutMs || 45_000,
    signal: options.signal,
  });
}

export async function releaseProductImage(input = {}, options = {}) {
  return requestLocalApi('/api/product-images/release', {
    method: 'POST',
    body: input,
    timeoutMs: options.timeoutMs || 45_000,
    signal: options.signal,
  });
}

export async function prepareProductImagesForOzon(images = [], options = {}) {
  const prepared = await Promise.all(
    images.map(async (image) => {
      const value = normalizeText(image);
      const assetId = getLocalProductImageAssetId(value);
      if (!isLocalProductImage(value) && !assetId) return value;
      const shared = {
        shopId: options.shopId,
        productId: options.productId,
        offerId: options.offerId,
        sourceType: options.sourceType || 'product-editor-local',
        storageScope: 'permanent',
        variant: options.variant || 'original',
      };
      const result = assetId
        ? await promoteProductImage({ ...shared, assetId }, options)
        : await importProductImage({ ...shared, dataBase64: value }, options);
      const ozonUrl = normalizeText(result?.asset?.ozonUrl);
      if (!ozonUrl) {
        throw new Error(
          '图片已保存，但服务器图片存储尚未就绪，暂时不能提交 Ozon。',
        );
      }
      return ozonUrl;
    }),
  );
  return [...new Set(prepared.filter(Boolean))];
}
