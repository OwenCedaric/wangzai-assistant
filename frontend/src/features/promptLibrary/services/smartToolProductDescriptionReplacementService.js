import { buildProductInfoWriteCommand } from '../../../entities/product/productWriteHelpers.jsx';
import { isProductWriteReadbackComplete, submitProductInfoWrite } from '../../../services/productModuleClient.js';
import { resolveSmartToolWritableProduct } from './smartToolProductImageReplacementService.js';

function text(value) {
  return String(value ?? '').trim();
}

function replaceGeneratedAttributes(attributes = [], fieldValues = {}) {
  const normalized = Array.isArray(attributes) ? attributes : [];
  const changes = new Map(
    Object.entries(fieldValues || {})
      .map(([id, value]) => [String(id).trim(), text(value)])
      .filter(([id, value]) => /^\d+$/u.test(id) && value)
  );
  const applied = new Set();
  const next = normalized.map((attribute) => {
    const id = Number(attribute?.id ?? attribute?.attribute_id ?? attribute?.attributeId);
    const value = changes.get(String(id));
    if (!value) return attribute;
    applied.add(String(id));
    return { ...attribute, id, values: [{ value }] };
  });
  changes.forEach((value, id) => {
    if (!applied.has(id)) next.push({ id: Number(id), values: [{ value }] });
  });
  return next;
}

export async function replaceGeneratedProductDescription({ shop, product, fieldValues, attributes } = {}, options = {}) {
  const selectedFields = Object.fromEntries(
    Object.entries(fieldValues || {}).map(([id, value]) => [String(id).trim(), text(value)]).filter(([, value]) => value)
  );
  if (!Object.keys(selectedFields).length) throw new Error('请先选择至少一个生成字段。');
  if (!shop?.id && !shop?.shopId) throw new Error('没有找到商品所属店铺，不能提交 Ozon。');
  if (!product) throw new Error('没有选择商品，不能替换描述。');
  const writableProduct = resolveSmartToolWritableProduct(product);
  if (!writableProduct.offerId) throw new Error('缺少商品货号，不能提交 Ozon。');
  if (!writableProduct.descriptionCategoryId || !writableProduct.typeId) {
    throw new Error('商品缺少 Ozon 类目或商品类型，不能提交描述。');
  }
  const images = (Array.isArray(product.mainImages) && product.mainImages.length
    ? product.mainImages
    : product.images || []).map(text).filter(Boolean);
  const nextAttributes = replaceGeneratedAttributes(
    Array.isArray(attributes) && attributes.length ? attributes : writableProduct.attributes,
    selectedFields,
  );
  const form = {
    name: selectedFields['4180'] || writableProduct.name || writableProduct.offerId,
    oldPrice: writableProduct.oldPriceValue,
    price: writableProduct.priceValue,
    weight: writableProduct.weight,
    length: writableProduct.length,
    width: writableProduct.width,
    height: writableProduct.height,
    images,
    attributes: nextAttributes,
  };
  const command = buildProductInfoWriteCommand(shop, writableProduct, form, {
    requestedBy: 'smart-tool-product-description-replacement',
  });
  const result = await submitProductInfoWrite(command, {
    ...options,
    humanConfirmed: true,
    realWrite: true,
    dryRun: false,
    timeoutMs: options.timeoutMs || 60000,
  });
  if (!isProductWriteReadbackComplete(result)) {
    throw new Error('商品资料已提交，但 Ozon 回读尚未确认成功，页面不会标记为完成。');
  }
  return { ...result, fieldIds: Object.keys(selectedFields) };
}

export { replaceGeneratedAttributes };
