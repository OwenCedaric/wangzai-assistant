import { buildProductInfoWriteCommand } from '../../../entities/product/productWriteHelpers.jsx';
import { getOzonDetailImages } from '../../../entities/product/productAttributes.jsx';
import {
  OZON_RICH_CONTENT_ATTRIBUTE_ID,
  readProductRichContent,
  replaceProductRichContentAttribute,
  replaceProductRichContentImages,
} from '../../../entities/product/productRichContent.js';
import { isProductWriteReadbackComplete, submitProductInfoWrite } from '../../../services/productModuleClient.js';
import {
  importProductImage,
  promoteProductImage,
} from '../../products/services/productImageAssetService.js';
import { readStoredProductImagePreview } from './smartToolImageGenerationService.js';

function text(value) {
  return String(value ?? '').trim();
}

function firstFilled(...values) {
  return values.map(text).find(Boolean) || '';
}

export { OZON_RICH_CONTENT_ATTRIBUTE_ID };
export const readSmartToolRichContent = readProductRichContent;
export const replaceSmartToolRichContentAttribute = replaceProductRichContentAttribute;
export const replaceSmartToolRichContentImages = replaceProductRichContentImages;

function productAttributes(product = {}) {
  const raw = product.raw || {};
  const candidates = [
    product.attributes,
    raw.attributes,
    raw.attributes?.attributes,
    raw.detail?.attributes,
  ];
  return candidates.find((value) => Array.isArray(value) && value.length)
    || candidates.find((value) => Array.isArray(value))
    || [];
}

export function resolveSmartToolWritableProduct(product = {}) {
  const raw = product.raw || {};
  const detail = raw.detail || {};
  const attributes = raw.attributes || {};
  return {
    ...product,
    shopId: firstFilled(product.shopId, product.shop_id, raw.shopId, raw.shop_id),
    offerId: firstFilled(product.offerId, raw.offerId, raw.offer_id),
    productId: firstFilled(product.productId, raw.productId, raw.product_id),
    descriptionCategoryId: firstFilled(
      product.descriptionCategoryId,
      product.description_category_id,
      product.categoryId,
      raw.descriptionCategoryId,
      raw.description_category_id,
      raw.categoryId,
      detail.description_category_id,
      attributes.description_category_id,
    ),
    typeId: firstFilled(
      product.typeId,
      product.type_id,
      raw.typeId,
      raw.type_id,
      detail.type_id,
      attributes.type_id,
    ),
    currencyCode: firstFilled(product.currencyCode, product.currency_code, raw.currencyCode, raw.currency_code) || 'CNY',
    name: firstFilled(product.name, product.title, raw.name, raw.title),
    priceValue: firstFilled(product.priceValue, product.price, raw.price),
    oldPriceValue: firstFilled(product.oldPriceValue, product.oldPrice, raw.oldPrice),
    vat: firstFilled(product.vat, raw.vat),
    weight: product.weight ?? raw.weight ?? raw.weightKg,
    length: product.length ?? raw.length ?? raw.depthCm,
    width: product.width ?? raw.width ?? raw.widthCm,
    height: product.height ?? raw.height ?? raw.heightCm,
    attributes: productAttributes(product),
  };
}

async function resolveOzonImageUrl(item = {}, options = {}) {
  const assetId = text(item.assetId || item.result?.assetId || item.result?.asset?.id);
  if (assetId) {
    const promoted = await promoteProductImage({
      assetId,
      shopId: options.shopId,
      productId: options.productId,
      offerId: options.offerId,
      sourceType: options.sourceType || 'smart-tool-product-image-replacement',
      variant: options.variant || 'smart-tool-replacement',
    }, options);
    const promotedUrl = text(promoted?.asset?.ozonUrl || promoted?.asset?.publicUrl);
    if (!/^https:\/\//iu.test(promotedUrl)) {
      throw new Error('生成图片已入库，但没有可提交给 Ozon 的永久图片地址。');
    }
    return promotedUrl;
  }
  const candidate = text(item.imageUrl || item.result?.imageUrl || item.previewUrl);
  if (!candidate) throw new Error('缺少生成图片地址，不能替换商品图片。');
  if (/^https:\/\//iu.test(candidate)) return candidate;
  const inline = /^data:image\//iu.test(candidate)
    ? candidate
    : await readStoredProductImagePreview(candidate, options);
  if (!inline) throw new Error('生成图片仍是本地预览，未能读取图片内容。');
  const imported = await importProductImage(
    {
      dataBase64: inline,
      sourceType: options.sourceType || 'smart-tool-product-image-replacement',
      storageScope: 'permanent',
      variant: options.variant || 'smart-tool-replacement',
      shopId: options.shopId,
      productId: options.productId,
      offerId: options.offerId,
    },
    options,
  );
  const ozonUrl = text(imported?.asset?.ozonUrl || imported?.asset?.publicUrl);
  if (!/^https:\/\//iu.test(ozonUrl)) {
    throw new Error('图片已保存到本机，但没有可提交给 Ozon 的公网图片地址。');
  }
  return ozonUrl;
}

export async function replaceGeneratedProductImages({ shop, product, group = 'main', generatedItems = [] } = {}, options = {}) {
  if (!shop?.id && !shop?.shopId) throw new Error('没有找到商品所属店铺，不能提交 Ozon。');
  if (!product) throw new Error('没有选择商品，不能替换图片。');
  const writableProduct = resolveSmartToolWritableProduct(product);
  if (!writableProduct.offerId) throw new Error('缺少商品货号，不能提交 Ozon。');
  if (!writableProduct.descriptionCategoryId || !writableProduct.typeId) {
    throw new Error('商品缺少 Ozon 类目或商品类型，不能提交图片替换。');
  }
  const items = (Array.isArray(generatedItems) ? generatedItems : [])
    .filter((item) => Number.isInteger(item?.sourceIndex) && item?.status === 'success');
  if (!items.length) throw new Error('请先选择至少一张生成图片。');

  const currentImages = (Array.isArray(product.mainImages) && product.mainImages.length
    ? product.mainImages
    : product.images || []).map(text).filter(Boolean);
  // Both the main-image and Rich Content update go through the same product
  // import payload. Never allow a partial product snapshot to submit an empty
  // image list and accidentally clear the Ozon main images.
  if (!currentImages.length) throw new Error('没有读取到商品主图，不能提交商品更新。');
  const imageOptions = {
    ...options,
    shopId: shop.id || shop.shopId,
    productId: writableProduct.productId,
    offerId: writableProduct.offerId,
    variant: group === 'detail' ? 'detail' : 'main',
  };
  const resolved = await Promise.all(items.map((item) => resolveOzonImageUrl(item, imageOptions)));
  let nextImages = currentImages;
  let nextAttributes = writableProduct.attributes;
  let replacedDetailImages = [];

  if (group === 'detail') {
    const currentDetailImages = (Array.isArray(product.detailImages) && product.detailImages.length
      ? product.detailImages
      : getOzonDetailImages(product)).map(text).filter(Boolean);
    if (!currentDetailImages.length) throw new Error('没有读取到商品详情图，不能按位置替换。');
    const replacements = items.map((item, index) => {
      const sourceUrl = currentDetailImages[item.sourceIndex];
      if (!sourceUrl) throw new Error(`详情图位置 ${item.sourceIndex + 1} 不存在。`);
      return { sourceIndex: item.sourceIndex, sourceUrl, targetUrl: resolved[index] };
    });
    const nextRichContent = replaceSmartToolRichContentImages(readSmartToolRichContent(product), replacements);
    nextAttributes = replaceSmartToolRichContentAttribute(writableProduct.attributes, nextRichContent);
    replacedDetailImages = [...currentDetailImages];
    replacements.forEach((item) => {
      replacedDetailImages[item.sourceIndex] = item.targetUrl;
    });
  } else {
    nextImages = [...currentImages];
    items.forEach((item, index) => {
      if (item.sourceIndex >= nextImages.length) throw new Error(`生成图片位置 ${item.sourceIndex + 1} 不存在。`);
      nextImages[item.sourceIndex] = resolved[index];
    });
  }

  const form = {
    name: writableProduct.name || writableProduct.offerId,
    oldPrice: writableProduct.oldPriceValue,
    price: writableProduct.priceValue,
    weight: writableProduct.weight,
    length: writableProduct.length,
    width: writableProduct.width,
    height: writableProduct.height,
    images: nextImages,
    attributes: nextAttributes,
  };
  const command = buildProductInfoWriteCommand(shop, writableProduct, form, {
    requestedBy: 'smart-tool-product-image-replacement',
  });
  const result = await submitProductInfoWrite(command, {
    ...options,
    humanConfirmed: true,
    realWrite: true,
    dryRun: false,
    timeoutMs: options.timeoutMs || 60000,
  });
  if (!isProductWriteReadbackComplete(result)) {
    throw new Error('图片已提交，但 Ozon 回读尚未确认成功，页面不会标记为完成。');
  }
  return {
    ...result,
    group,
    replacedIndexes: items.map((item) => item.sourceIndex),
    images: nextImages,
    detailImages: replacedDetailImages,
  };
}
