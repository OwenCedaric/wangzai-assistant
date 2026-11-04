import {
  importProductImage,
  promoteProductImage,
  readProductImageAssetPreviews,
  waitForProductImagePersistenceTask,
} from '../../products/services/productImageAssetService.js';
import {
  normalizeCollectionProductGeneratedImageSelections,
  resolveCollectionProductImageAssetShopId,
} from '../lib/collectionProductImageHistory.js';

function text(value) {
  return String(value ?? '').trim();
}

function assetResult(value = {}) {
  return value?.asset || value?.result?.asset || value?.result || value || {};
}

function stableAssetItem(item, asset = {}, shopId = '') {
  const assetId = text(asset.id || asset.assetId || item.assetId);
  const localUrl = text(asset.localUrl)
    || (assetId ? `/api/product-images/preview/${encodeURIComponent(assetId)}?shopId=${encodeURIComponent(shopId)}` : '');
  return {
    ...item,
    assetShopId: text(shopId),
    assetId,
    taskId: '',
    imageUrl: localUrl || text(asset.previewUrl || item.imageUrl),
    previewUrl: text(asset.previewUrl || asset.localUrl || item.previewUrl || item.imageUrl),
    thumbnailUrl: text(asset.thumbnailUrl || item.thumbnailUrl),
    storageScope: text(asset.storageScope || item.storageScope),
    persistenceStatus: 'completed',
    persistenceMessage: '',
  };
}

export async function hydrateCollectionProductGeneratedImageSelections(value = {}, options = {}) {
  const selections = normalizeCollectionProductGeneratedImageSelections(value);
  const fallbackShopId = text(options.shopId);
  const assetIdsByShop = new Map();
  Object.values(selections).forEach((selection) => {
    selection.items.forEach((item) => {
      if (!item.assetId) return;
      const assetShopId = resolveCollectionProductImageAssetShopId(
        item,
        selection.assetShopId || fallbackShopId,
      );
      if (!assetShopId) return;
      const assetIds = assetIdsByShop.get(assetShopId) || new Set();
      assetIds.add(item.assetId);
      assetIdsByShop.set(assetShopId, assetIds);
    });
  });
  if (!assetIdsByShop.size) return selections;
  const batches = await Promise.all([...assetIdsByShop.entries()].map(async ([assetShopId, assetIds]) => ({
    assetShopId,
    assets: await readProductImageAssetPreviews([...assetIds], {
      shopId: assetShopId,
      signal: options.signal,
    }),
  })));
  const byScopedId = new Map(batches.flatMap(({ assetShopId, assets }) => (
    assets.map((asset) => [`${assetShopId}::${text(asset.id)}`, asset])
  )));
  return Object.fromEntries(Object.entries(selections).map(([group, selection]) => [group, {
    ...selection,
    items: selection.items.map((item) => {
      const assetShopId = resolveCollectionProductImageAssetShopId(
        item,
        selection.assetShopId || fallbackShopId,
      );
      const asset = byScopedId.get(`${assetShopId}::${item.assetId}`);
      return asset ? stableAssetItem(item, asset, assetShopId) : item;
    }),
  }]));
}

async function persistItem(item, context, options) {
  let settledItem = context.verifiedAsset
    ? stableAssetItem(item, context.verifiedAsset, context.shopId)
    : { ...item };
  if ((!settledItem.assetId || settledItem.persistenceStatus === 'pending') && settledItem.taskId) {
    const settled = await waitForProductImagePersistenceTask(settledItem.taskId, {
      shopId: context.shopId,
      signal: options.signal,
    });
    settledItem = stableAssetItem(settledItem, assetResult(settled), context.shopId);
  }
  if (settledItem.storageScope === 'permanent' && settledItem.assetId) return settledItem;
  if (!settledItem.assetId && !text(settledItem.previewUrl || settledItem.imageUrl)) {
    throw new Error('生成图片尚未完成后台保存，请稍后再点保存修改。');
  }
  const shared = {
    shopId: context.shopId,
    productId: context.productId,
    offerId: context.offerId,
    sourceType: 'collection-product-editor-save',
    storageScope: 'permanent',
    variant: `collection-generated-${context.group}`,
  };
  const source = text(settledItem.previewUrl || settledItem.imageUrl);
  const saved = settledItem.assetId
    ? await promoteProductImage({ ...shared, assetId: settledItem.assetId }, options)
    : await importProductImage({
        ...shared,
        ...(/^data:image\/(?:png|jpeg|webp);base64,/iu.test(source)
          ? { dataBase64: source }
          : { sourceUrl: source }),
      }, options);
  const asset = assetResult(saved);
  if (!text(asset.id || asset.assetId)) throw new Error('生成图片没有完成长期保存，请稍后重试。');
  return stableAssetItem(settledItem, { ...asset, storageScope: 'permanent' }, context.shopId);
}

export async function persistCollectionProductGeneratedImageSelections(value = {}, context = {}, options = {}) {
  const selections = normalizeCollectionProductGeneratedImageSelections(value);
  const shopId = text(context.shopId);
  const productId = text(context.productId);
  if (!Object.keys(selections).length) return { selections, replacements: new Map() };
  if (!shopId) throw new Error('缺少当前 Ozon 店铺，生成图片不能保存。');
  if (!productId) throw new Error('缺少当前采集商品，生成图片不能保存。');
  const existingAssetRequests = Object.values(selections).flatMap((selection) => selection.items.flatMap((item) => {
    if (!item.assetId) return [];
    return [{
      assetId: item.assetId,
      assetShopId: resolveCollectionProductImageAssetShopId(item, selection.assetShopId || shopId),
    }];
  }));
  const assetIdsByShop = new Map();
  existingAssetRequests.forEach(({ assetId, assetShopId }) => {
    if (!assetShopId) return;
    const assetIds = assetIdsByShop.get(assetShopId) || new Set();
    assetIds.add(assetId);
    assetIdsByShop.set(assetShopId, assetIds);
  });
  const existingBatches = await Promise.all([...assetIdsByShop.entries()].map(async ([assetShopId, assetIds]) => ({
    assetShopId,
    assets: await readProductImageAssetPreviews([...assetIds], {
      shopId: assetShopId,
      signal: options.signal,
    }),
  })));
  const existingAssetsByScopedId = new Map(existingBatches.flatMap(({ assetShopId, assets }) => (
    assets.map((asset) => [`${assetShopId}::${text(asset.id)}`, asset])
  )));
  const replacements = new Map();
  const entries = await Promise.all(Object.entries(selections).map(async ([group, selection]) => {
    const items = await Promise.all(selection.items.map(async (item) => {
      const assetShopId = resolveCollectionProductImageAssetShopId(item, selection.assetShopId || shopId) || shopId;
      const verifiedAsset = item.assetId
        ? existingAssetsByScopedId.get(`${assetShopId}::${item.assetId}`)
        : null;
      const recoverableSource = text(item.previewUrl || item.imageUrl);
      if (item.assetId && !verifiedAsset && !recoverableSource) {
        throw new Error('生成图片没有完成本地保存，并且原始图片链接已经失效，请单独重新生成该位置。');
      }
      // Older Core V2 builds returned a synthetic v2-image-* id without a
      // matching local asset row. Re-import the still-valid provider URL and
      // replace it with a real asset instead of treating it as cross-shop data.
      const persistenceItem = item.assetId && !verifiedAsset
        ? { ...item, assetId: '', taskId: '', storageScope: '', persistenceStatus: 'pending' }
        : item;
      const saved = await persistItem(persistenceItem, {
        shopId: assetShopId,
        productId,
        offerId: text(context.offerId),
        group,
        verifiedAsset,
      }, options);
      [item.imageUrl, item.previewUrl].filter(Boolean).forEach((url) => replacements.set(url, saved.imageUrl));
      return saved;
    }));
    return [group, {
      ...selection,
      assetShopId: resolveCollectionProductImageAssetShopId(items[0], selection.assetShopId || shopId),
      items,
    }];
  }));
  return { selections: Object.fromEntries(entries), replacements };
}
