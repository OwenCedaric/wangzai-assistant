import {
  getLocalProductImageAssetId,
  importProductImage,
  isLocalProductImage,
  promoteProductImage,
  readProductImageAssetPreviews,
} from '../../products/services/productImageAssetService.js';
import { loadCollectionListingWarehouses } from './collectionListingCatalogService.js';
import {
  canResumeCollectionListingReadBack,
  confirmCollectionListing,
  continueCollectionListingReadBack,
  previewCollectionListing,
  releaseCollectionListingPreview,
} from './collectionListingService.js';
import { getCollectionSkuShopInventory } from '../lib/collectionProductShopInventory.js';
import { normalizeCollectionListingErrorMessage } from '../lib/collectionListingErrorMessage.js';
import { formatCollectionShopLabel, getCollectionShopId } from '../lib/collectionShopLabel.js';

const IMAGE_COPY_CONCURRENCY = 4;
const IMAGE_PREVIEW_BATCH_SIZE = 50;

function text(value) {
  return String(value ?? '').trim();
}

function shopIdOf(shop = {}) {
  return getCollectionShopId(shop);
}

function warehouseIdOf(warehouse = {}) {
  return text(warehouse.rawId || warehouse.id);
}

function warehouseNameOf(warehouse = {}) {
  return text(warehouse.name || warehouse.label || warehouse.title || warehouseIdOf(warehouse));
}

function skuIdentity(sku = {}) {
  return text(sku.sourceSkuId || sku.offerId || sku.offer_id);
}

function assetResult(value = {}) {
  return value?.asset || value?.result?.asset || value?.result || value || {};
}

function createAbortError() {
  const error = new Error('已取消生成上架预览。');
  error.name = 'AbortError';
  error.code = 'COLLECTION_LISTING_PREVIEW_ABORTED';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError();
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const rows = Array.isArray(items) ? items : [];
  const results = new Array(rows.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(rows[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), rows.length || 1) }, worker));
  return results;
}

async function readSourceAssets(assetIds, sourceShopId, options = {}) {
  const rows = [];
  for (let index = 0; index < assetIds.length; index += IMAGE_PREVIEW_BATCH_SIZE) {
    throwIfAborted(options.signal);
    rows.push(...await readProductImageAssetPreviews(
      assetIds.slice(index, index + IMAGE_PREVIEW_BATCH_SIZE),
      { shopId: sourceShopId, signal: options.signal },
    ));
  }
  return new Map(rows.map((asset) => [text(asset.id), asset]));
}

async function prepareTargetImageUrls(draft, context, options = {}) {
  const sourceShopId = text(context.sourceShopId);
  const targetShopId = text(context.targetShopId);
  const urls = [...new Set([
    ...(Array.isArray(draft.images) ? draft.images : []),
    ...(Array.isArray(draft.skus) ? draft.skus.map((sku) => sku.imageUrl) : []),
  ].map(text).filter(Boolean))];
  const localAssetIds = [...new Set(urls.map(getLocalProductImageAssetId).filter(Boolean))];
  const sourceAssets = localAssetIds.length
    ? await readSourceAssets(localAssetIds, sourceShopId, options)
    : new Map();

  const prepared = await mapWithConcurrency(urls, IMAGE_COPY_CONCURRENCY, async (url) => {
    throwIfAborted(options.signal);
    const assetId = getLocalProductImageAssetId(url);
    const shared = {
      shopId: targetShopId,
      productId: text(context.productId),
      offerId: text(context.offerId),
      sourceType: 'collection-multi-shop-listing',
      variant: 'collection-listing',
    };
    const promoteImported = async (imported) => {
      const importedAssetId = text(assetResult(imported).id || assetResult(imported).assetId);
      if (!importedAssetId) throw new Error('目标店铺图片没有完成临时保存，不能生成暗水印。');
      return promoteProductImage({
        ...shared,
        assetId: importedAssetId,
        storageScope: 'permanent',
      }, options);
    };
    if (assetId) {
      const sourceAsset = sourceAssets.get(assetId);
      if (!sourceAsset) throw new Error('已保存图片不属于当前编辑店铺或已经失效，不能跨店铺上架。');
      const sourceUrl = text(sourceAsset.ozonUrl || sourceAsset.previewUrl);
      if (targetShopId !== sourceShopId && !/^https:\/\//iu.test(sourceUrl)) {
        throw new Error('当前店铺图片没有可供目标店铺复制的 HTTPS 地址。');
      }
      const result = targetShopId === sourceShopId
        ? await promoteProductImage({ ...shared, assetId, storageScope: 'permanent' }, options)
        : await promoteImported(await importProductImage({
            ...shared,
            sourceUrl,
            storageScope: 'temporary',
          }, options));
      const ozonUrl = text(assetResult(result).ozonUrl);
      if (!ozonUrl) throw new Error('目标店铺图片资产尚未准备完成，不能提交 Ozon。');
      return [url, ozonUrl];
    }
    if (isLocalProductImage(url)) {
      const result = await promoteImported(await importProductImage({
        ...shared,
        dataBase64: url,
        storageScope: 'temporary',
      }, options));
      const ozonUrl = text(assetResult(result).ozonUrl);
      if (!ozonUrl) throw new Error('目标店铺图片资产尚未准备完成，不能提交 Ozon。');
      return [url, ozonUrl];
    }
    if (!/^https:\/\//iu.test(url)) throw new Error('商品图片不是可供 Ozon 读取的 HTTPS 地址。');
    const result = await promoteImported(await importProductImage({
      ...shared,
      sourceUrl: url,
      storageScope: 'temporary',
    }, options));
    const ozonUrl = text(assetResult(result).ozonUrl);
    if (!ozonUrl) throw new Error('目标店铺暗水印图片尚未准备完成，不能提交 Ozon。');
    return [url, ozonUrl];
  });
  return new Map(prepared);
}

export function normalizeCollectionListingTargetShopIds(shopIds = [], shops = []) {
  const available = new Set((Array.isArray(shops) ? shops : []).map(shopIdOf).filter(Boolean));
  return [...new Set((Array.isArray(shopIds) ? shopIds : []).map(text).filter((id) => id && available.has(id)))];
}

export async function prepareCollectionListingTargetDraft({
  baseDraft = {},
  savedTargetDraft = {},
  sourceShopId = '',
  targetShopId = '',
  productId = '',
} = {}, options = {}) {
  const normalizedTargetShopId = text(targetShopId);
  if (!normalizedTargetShopId) throw new Error('缺少目标 Ozon 店铺。');
  throwIfAborted(options.signal);
  const warehouses = await loadCollectionListingWarehouses(normalizedTargetShopId, {
    signal: options.signal,
  });
  const warehouseById = new Map((Array.isArray(warehouses) ? warehouses : [])
    .map((warehouse) => [warehouseIdOf(warehouse), warehouse])
    .filter(([id]) => Boolean(id)));
  const savedSkuById = new Map((Array.isArray(savedTargetDraft?.skus) ? savedTargetDraft.skus : [])
    .map((sku) => [skuIdentity(sku), sku])
    .filter(([id]) => Boolean(id)));
  const skus = (Array.isArray(baseDraft.skus) ? baseDraft.skus : []).map((sku) => {
    const savedSku = savedSkuById.get(skuIdentity(sku));
    const currentInventory = getCollectionSkuShopInventory(sku, normalizedTargetShopId);
    const savedInventory = getCollectionSkuShopInventory(savedSku || {}, normalizedTargetShopId);
    const inventory = (currentInventory.stock || currentInventory.warehouseId)
      ? currentInventory
      : savedInventory;
    const requestedWarehouseId = text(inventory.warehouseId);
    const stock = text(inventory.stock);
    const warehouse = warehouseById.get(requestedWarehouseId);
    if (requestedWarehouseId && !warehouse) {
      const error = new Error('该店铺已选择的 Ozon 仓库已经失效，请返回 SKU/价格重新读取仓库。');
      error.code = 'COLLECTION_LISTING_TARGET_WAREHOUSE_INVALID';
      throw error;
    }
    if (stock && !warehouseIdOf(warehouse)) {
      const error = new Error('该店铺已经填写库存，但没有选择对应的 Ozon 仓库。');
      error.code = 'COLLECTION_LISTING_TARGET_WAREHOUSE_REQUIRED';
      throw error;
    }
    return {
      ...sku,
      stock,
      warehouseId: stock ? warehouseIdOf(warehouse) : '',
    };
  });
  const configuredWarehouseIds = [...new Set(skus
    .filter((sku) => text(sku.stock))
    .map((sku) => text(sku.warehouseId))
    .filter(Boolean))];
  const configuredWarehouse = warehouseById.get(configuredWarehouseIds[0]);
  const draftWithWarehouse = {
    ...baseDraft,
    shopId: normalizedTargetShopId,
    skus,
    targetWarehouseId: configuredWarehouseIds.length === 1 ? configuredWarehouseIds[0] : '',
    targetWarehouseName: configuredWarehouseIds.length > 1
      ? `${configuredWarehouseIds.length} 个仓库`
      : warehouseNameOf(configuredWarehouse),
  };
  const imageUrls = await prepareTargetImageUrls(draftWithWarehouse, {
    sourceShopId,
    targetShopId: normalizedTargetShopId,
    productId,
    offerId: skus[0]?.offerId || skus[0]?.offer_id,
  }, options);
  const images = (Array.isArray(draftWithWarehouse.images) ? draftWithWarehouse.images : [])
    .map((url) => imageUrls.get(text(url)) || text(url))
    .filter(Boolean);
  return {
    ...draftWithWarehouse,
    images,
    imagesText: images.join('\n'),
    skus: skus.map((sku) => ({
      ...sku,
      imageUrl: imageUrls.get(text(sku.imageUrl)) || text(sku.imageUrl),
    })),
  };
}

export async function previewCollectionListingsForShops({
  baseDraft = {},
  sourceShopId = '',
  targetShopIds = [],
  shops = [],
  savedDraftsByShop = {},
  productId = '',
} = {}, options = {}) {
  const selectedShopIds = normalizeCollectionListingTargetShopIds(targetShopIds, shops);
  if (!selectedShopIds.length) {
    const error = new Error('请至少选择一个上传店铺。');
    error.code = 'COLLECTION_LISTING_TARGET_SHOP_REQUIRED';
    throw error;
  }
  const shopById = new Map(shops.map((shop) => [shopIdOf(shop), shop]));
  const shopPreviews = await Promise.all(selectedShopIds.map(async (shopId, shopIndex) => {
    const shopLabel = formatCollectionShopLabel(shopById.get(shopId), shopId);
    try {
      const targetDraft = await prepareCollectionListingTargetDraft({
        baseDraft,
        savedTargetDraft: savedDraftsByShop?.[shopId],
        sourceShopId,
        targetShopId: shopId,
        productId,
      }, options);
      const preview = await previewCollectionListing(targetDraft, {
        ...options,
        onProgress(progress) {
          options.onProgress?.({
            ...progress,
            shopId,
            shopLabel,
            shopIndex: shopIndex + 1,
            shopTotal: selectedShopIds.length,
            message: `${shopLabel}：${progress.message}`,
          });
        },
      });
      return {
        shopId,
        shopLabel,
        status: 'ready',
        error: '',
        warehouseId: targetDraft.targetWarehouseId,
        warehouseName: targetDraft.targetWarehouseName,
        preview,
      };
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      return {
        shopId,
        shopLabel,
        status: 'failed',
        error: normalizeCollectionListingErrorMessage(error, '该店铺上架预览生成失败。'),
        warehouseId: '',
        warehouseName: '',
        preview: null,
      };
    }
  }));
  const ready = shopPreviews.filter((item) => item.status === 'ready' && item.preview);
  const representative = ready[0]?.preview || null;
  return {
    ok: ready.length > 0,
    multiShop: true,
    operationId: `collection-multi-shop-${Date.now()}-${selectedShopIds.join('-')}`,
    createdAt: new Date().toISOString(),
    selectedShopIds,
    shopPreviews,
    readyCount: ready.length,
    failedCount: shopPreviews.length - ready.length,
    draftSnapshot: baseDraft,
    validation: representative?.validation || { warnings: [] },
    product: representative?.product || null,
    price: representative?.price || null,
    products: representative?.products || [],
    prices: representative?.prices || [],
    stocks: representative?.stocks || [],
    transport: {
      chunkCount: ready.reduce((total, item) => total + Number(item.preview.transport?.chunkCount || 0), 0),
      totalBytes: ready.reduce((total, item) => total + Number(item.preview.transport?.totalBytes || 0), 0),
    },
  };
}

export async function confirmCollectionListingsForShops(preview, options = {}) {
  const entries = Array.isArray(preview?.shopPreviews) ? preview.shopPreviews : [];
  const ready = entries.filter((item) => item.status === 'ready' && item.preview);
  if (!preview?.multiShop || !ready.length) {
    const error = new Error('没有可上传的店铺预览，请重新生成。');
    error.code = 'COLLECTION_LISTING_PREVIEW_REQUIRED';
    throw error;
  }
  const submitted = await Promise.all(ready.map(async (entry, shopIndex) => {
    try {
      const result = await confirmCollectionListing(entry.preview, {
        ...options,
        onProgress(progress) {
          options.onProgress?.({
            ...progress,
            shopId: entry.shopId,
            shopLabel: entry.shopLabel,
            shopIndex: shopIndex + 1,
            shopTotal: ready.length,
            message: `${entry.shopLabel}：${progress.message}`,
          });
        },
      });
      return {
        shopId: entry.shopId,
        shopLabel: entry.shopLabel,
        status: result.completed ? 'completed' : result.status,
        completed: result.completed === true,
        error: result.completed ? '' : normalizeCollectionListingErrorMessage(result.message),
        result,
      };
    } catch (error) {
      return {
        shopId: entry.shopId,
        shopLabel: entry.shopLabel,
        status: 'failed',
        completed: false,
        error: normalizeCollectionListingErrorMessage(error, '该店铺上传失败。'),
        result: null,
      };
    }
  }));
  const previewFailures = entries.filter((entry) => entry.status !== 'ready').map((entry) => ({
    shopId: entry.shopId,
    shopLabel: entry.shopLabel,
    status: 'preview_failed',
    completed: false,
    error: normalizeCollectionListingErrorMessage(entry.error, '该店铺上架预览生成失败。'),
    result: null,
  }));
  const shopResults = [...submitted, ...previewFailures];
  const completedCount = shopResults.filter((item) => item.completed).length;
  const failedCount = shopResults.length - completedCount;
  const completed = completedCount === shopResults.length;
  const resumable = shopResults.some((item) => canResumeCollectionListingReadBack(item?.result));
  const status = completed ? 'completed' : resumable ? 'pending_readback' : completedCount > 0 ? 'partial' : 'failed';
  const message = completed
    ? `${completedCount} 个店铺均已通过 Ozon 回读校验。`
    : resumable
      ? '仍有店铺等待 Ozon 回读，可继续回读；不会重复上传商品。'
      : completedCount > 0
        ? `${completedCount} 个店铺上传完成，${failedCount} 个店铺未完成；各店铺互不影响。`
        : '所选店铺均未完成上传，请查看各店铺错误后重试。';
  return {
    ok: completedCount > 0,
    completed,
    status,
    operationId: preview.operationId,
    selectedShopIds: preview.selectedShopIds,
    completedCount,
    failedCount,
    shopResults,
    results: shopResults.flatMap((shopResult) => (
      Array.isArray(shopResult.result?.results)
        ? shopResult.result.results.map((item) => ({
            ...item,
            shopId: shopResult.shopId,
            shopLabel: shopResult.shopLabel,
            label: `${shopResult.shopLabel} · ${item.label}`,
          }))
        : []
    )),
    message,
  };
}

export function canResumeCollectionListingsReadBack(result = {}) {
  const shopResults = Array.isArray(result?.shopResults) ? result.shopResults : [];
  return shopResults.some((item) => canResumeCollectionListingReadBack(item?.result));
}

export async function continueCollectionListingsReadBackForShops(preview, priorResult = {}, options = {}) {
  const entries = Array.isArray(preview?.shopPreviews) ? preview.shopPreviews : [];
  const ready = entries.filter((item) => item.status === 'ready' && item.preview);
  if (!preview?.multiShop || !ready.length) {
    const error = new Error('没有可继续回读的店铺预览。');
    error.code = 'COLLECTION_LISTING_PREVIEW_REQUIRED';
    throw error;
  }
  const priorByShop = new Map(
    (Array.isArray(priorResult?.shopResults) ? priorResult.shopResults : [])
      .map((item) => [text(item?.shopId), item]),
  );
  const submitted = await Promise.all(ready.map(async (entry, shopIndex) => {
    const priorShop = priorByShop.get(text(entry.shopId));
    if (priorShop?.completed === true) return priorShop;
    if (!canResumeCollectionListingReadBack(priorShop?.result)) {
      return priorShop || {
        shopId: entry.shopId,
        shopLabel: entry.shopLabel,
        status: 'failed',
        completed: false,
        error: '该店铺没有可继续的回读任务，本次没有重复上传。',
        result: null,
      };
    }
    try {
      const result = await continueCollectionListingReadBack(entry.preview, priorShop.result, {
        ...options,
        onProgress(progress) {
          options.onProgress?.({
            ...progress,
            shopId: entry.shopId,
            shopLabel: entry.shopLabel,
            shopIndex: shopIndex + 1,
            shopTotal: ready.length,
            message: `${entry.shopLabel}：${progress.message}`,
          });
        },
      });
      return {
        shopId: entry.shopId,
        shopLabel: entry.shopLabel,
        status: result.completed ? 'completed' : result.status,
        completed: result.completed === true,
        error: result.completed ? '' : normalizeCollectionListingErrorMessage(result.message),
        result,
      };
    } catch (error) {
      return {
        shopId: entry.shopId,
        shopLabel: entry.shopLabel,
        status: 'failed',
        completed: false,
        error: normalizeCollectionListingErrorMessage(error, '该店铺继续回读失败。'),
        result: priorShop?.result || null,
      };
    }
  }));
  const previewFailures = entries.filter((entry) => entry.status !== 'ready').map((entry) => (
    priorByShop.get(text(entry.shopId)) || {
      shopId: entry.shopId,
      shopLabel: entry.shopLabel,
      status: 'preview_failed',
      completed: false,
      error: normalizeCollectionListingErrorMessage(entry.error, '该店铺上架预览生成失败。'),
      result: null,
    }
  ));
  const shopResults = [...submitted, ...previewFailures];
  const completedCount = shopResults.filter((item) => item.completed).length;
  const failedCount = shopResults.length - completedCount;
  const completed = completedCount === shopResults.length;
  const resumable = shopResults.some((item) => canResumeCollectionListingReadBack(item?.result));
  const status = completed ? 'completed' : resumable ? 'pending_readback' : completedCount > 0 ? 'partial' : 'failed';
  const message = completed
    ? `${completedCount} 个店铺均已通过 Ozon 回读校验。`
    : resumable
      ? '仍有店铺等待 Ozon 回读，可继续回读；不会重复上传商品。'
      : completedCount > 0
        ? `${completedCount} 个店铺上传完成，${failedCount} 个店铺未完成；各店铺互不影响。`
        : '所选店铺均未完成上传，请查看各店铺错误。';
  return {
    ok: completedCount > 0,
    completed,
    status,
    operationId: preview.operationId,
    selectedShopIds: preview.selectedShopIds,
    completedCount,
    failedCount,
    shopResults,
    results: shopResults.flatMap((shopResult) => (
      Array.isArray(shopResult.result?.results)
        ? shopResult.result.results.map((item) => ({
            ...item,
            shopId: shopResult.shopId,
            shopLabel: shopResult.shopLabel,
            label: `${shopResult.shopLabel} · ${item.label}`,
          }))
        : []
    )),
    message,
  };
}

export async function releaseCollectionListingsForShops(preview, options = {}) {
  const entries = Array.isArray(preview?.shopPreviews) ? preview.shopPreviews : [];
  const results = await Promise.all(entries
    .filter((entry) => entry.preview)
    .map((entry) => releaseCollectionListingPreview(entry.preview, options)));
  return { ok: true, released: results.reduce((total, result) => total + Number(result?.released || 0), 0) };
}
