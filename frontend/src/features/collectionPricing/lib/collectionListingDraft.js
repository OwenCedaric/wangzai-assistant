import {
  getCollectionMinimumAllowedPrice,
  repairLegacyCollectionMinimumPrice,
} from './collectionPriceBounds.js';
import { sanitizeBuiltListingAttributeList } from './collectionProductAttributeSchema.js';

function clean(value, maximum = 10_000) {
  return String(value ?? '')
    .replace(/\p{Cc}/gu, '')
    .trim()
    .slice(0, maximum);
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function decimalText(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return number.toFixed(2).replace(/\.00$/u, '');
}

function normalizeListingHttpsUrl(value) {
  try {
    const url = new URL(clean(value, 2400));
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function effectiveCnyOrListingPrice(row, field) {
  const cnyField = `${field}Cny`;
  return clean(row[cnyField]) ? row[cnyField] : row[field];
}

function repairLegacyMinimumPriceBoundary(row = {}) {
  const price = positiveNumber(effectiveCnyOrListingPrice(row, 'price'));
  const currentValue = effectiveCnyOrListingPrice(row, 'minPrice');
  const current = clean(currentValue) ? positiveNumber(currentValue) : null;
  const repaired = repairLegacyCollectionMinimumPrice(price, current);
  if (current === null || repaired === null || repaired === current) return row;
  if (clean(row.minPriceCny)) return { ...row, minPriceCny: decimalText(repaired) };
  return { ...row, minPrice: decimalText(repaired) };
}

function listingAttributeValueSignature(attributes = [], attributeIds = []) {
  const wanted = new Set((Array.isArray(attributeIds) ? attributeIds : []).map(String).filter(Boolean));
  return JSON.stringify((Array.isArray(attributes) ? attributes : [])
    .filter((attribute) => wanted.has(String(attribute?.id)))
    .map((attribute) => [
      String(attribute.id),
      (Array.isArray(attribute.values) ? attribute.values : []).map((value) => [
        String(value?.dictionary_value_id ?? value?.dictionaryValueId ?? ''),
        clean(value?.value, 2_000).toLocaleLowerCase(),
      ]).sort(),
    ])
    .sort((left, right) => left[0].localeCompare(right[0])));
}

function duplicateListingSkuVariantGroup(rows = [], globalAttributes = [], skuAttributeIds = []) {
  const ids = [...new Set((Array.isArray(skuAttributeIds) ? skuAttributeIds : []).map(String).filter(Boolean))];
  if (rows.length < 2 || !ids.length) return [];
  const hasModelName = (Array.isArray(globalAttributes) ? globalAttributes : []).some((attribute) => (
    String(attribute?.id) === '9048'
      && Array.isArray(attribute.values)
      && attribute.values.some((value) => clean(value?.value, 2_000))
  ));
  if (!hasModelName) return [];
  const bySignature = new Map();
  rows.forEach((row) => {
    const signature = listingAttributeValueSignature(row.attributes, ids);
    const group = bySignature.get(signature) || [];
    group.push(row);
    bySignature.set(signature, group);
  });
  return [...bySignature.values()].find((group) => group.length > 1) || [];
}

export function parseListingImages(value) {
  const rows = Array.isArray(value) ? value : String(value || '').split(/[\n,]/u);
  const images = [];
  for (const row of rows) {
    const normalized = normalizeListingHttpsUrl(row);
    if (normalized && !images.includes(normalized)) images.push(normalized);
  }
  return images.slice(0, 30);
}

export function buildCollectionListingImagePayload(primaryImage, candidates = []) {
  const primary = clean(primaryImage, 2400);
  const images = [...new Set((Array.isArray(candidates) ? candidates : [])
    .map((value) => clean(value, 2400))
    .filter((value) => value && value !== primary))]
    .slice(0, 29);
  return { primary_image: primary, images };
}

export function parseListingAttributes(value) {
  const raw = clean(value || '[]', 80_000);
  let parsed;
  try {
    parsed = JSON.parse(raw || '[]');
  } catch {
    return { ok: false, attributes: [], error: '属性 JSON 格式不正确。' };
  }
  if (!Array.isArray(parsed)) return { ok: false, attributes: [], error: '属性 JSON 必须是数组。' };
  const attributes = parsed
    .filter((item) => item && typeof item === 'object' && positiveInteger(item.id))
    .map((item) => ({ ...item, id: positiveInteger(item.id) }));
  if (attributes.length !== parsed.length) {
    return { ok: false, attributes: [], error: '每个属性都必须是带正整数 id 的对象。' };
  }
  return { ok: true, attributes, error: '' };
}

export function validateCollectionListingDraft(draft = {}) {
  const errors = [];
  const warnings = [];
  const title = clean(draft.title, 5000);
  const images = parseListingImages(draft.imagesText);
  const rawImageRows = (Array.isArray(draft.imagesText)
    ? draft.imagesText
    : String(draft.imagesText || '').split(/[\n,]/u))
    .map((value) => clean(value, 2400))
    .filter(Boolean);
  const parsedAttributes = Array.isArray(draft.attributes)
    ? { ok: true, attributes: draft.attributes, error: '' }
    : parseListingAttributes(draft.attributesJson);
  const rows = Array.isArray(draft.skus) && draft.skus.length
    ? draft.skus.filter((item) => item?.enabled !== false).map((item) => repairLegacyMinimumPriceBoundary({
      offerId: clean(item.offerId ?? item.offer_id, 200),
      title: clean(item.title || title, 5000),
      price: item.price,
      oldPrice: item.oldPrice ?? item.old_price,
      minPrice: item.minPrice ?? item.min_price,
      priceCny: item.priceCny,
      oldPriceCny: item.oldPriceCny,
      minPriceCny: item.minPriceCny,
      stock: item.stock,
      warehouseId: item.warehouseId ?? item.warehouse_id,
      imageUrl: normalizeListingHttpsUrl(item.imageUrl),
      invalidImageUrl: Boolean(clean(item.imageUrl, 2400) && !normalizeListingHttpsUrl(item.imageUrl)),
      attributes: Array.isArray(item.attributes)
        ? sanitizeBuiltListingAttributeList(item.attributes.filter(
          (attribute) => attribute && typeof attribute === 'object' && positiveInteger(attribute.id),
        ))
        : [],
    }))
    : [repairLegacyMinimumPriceBoundary({
      offerId: clean(draft.offerId, 200), title, price: draft.price, oldPrice: draft.oldPrice,
      minPrice: draft.minPrice, stock: draft.stock, warehouseId: draft.warehouseId, imageUrl: '',
    })];

  if (!clean(draft.shopId, 180)) errors.push('请选择 Ozon 店铺。');
  if (!rows.length) errors.push('至少启用 1 个 SKU。');
  if (rows.length > 80) errors.push('单次最多上架 80 个 SKU。');
  if (new Set(rows.map((item) => item.offerId)).size !== rows.length) errors.push('SKU 货号不能重复。');
  if (rows.some((item) => !item.offerId)) errors.push('请填写每个 SKU 的货号。');
  if (rows.some((item) => item.offerId.length > 30)) errors.push('SKU 货号不能超过 30 个字符。');
  if (!title) errors.push('请填写 Ozon 商品标题。');
  if (!positiveInteger(draft.descriptionCategoryId)) errors.push('请填写有效的 description_category_id。');
  if (!positiveInteger(draft.typeId)) errors.push('请填写有效的 type_id。');
  if (rows.some((item) => positiveNumber(effectiveCnyOrListingPrice(item, 'price')) === null)) errors.push('每个启用的 SKU 售价都必须大于 0。');
  if (rows.some((item) => {
    const price = positiveNumber(effectiveCnyOrListingPrice(item, 'price'));
    const oldPrice = positiveNumber(effectiveCnyOrListingPrice(item, 'oldPrice'));
    return oldPrice === null || (price !== null && oldPrice <= price);
  })) errors.push('每个启用的 SKU 划线价都必须大于售价。');
  if (rows.some((item) => {
    const price = positiveNumber(effectiveCnyOrListingPrice(item, 'price'));
    const effectiveMinPrice = effectiveCnyOrListingPrice(item, 'minPrice');
    const minPrice = clean(effectiveMinPrice) ? positiveNumber(effectiveMinPrice) : null;
    const minimumAllowed = getCollectionMinimumAllowedPrice(price);
    return minPrice !== null && price !== null && (
      minPrice > price || (minimumAllowed !== null && minPrice < minimumAllowed)
    );
  })) {
    errors.push('最低价必须位于售价的 50% 到 100% 之间。');
  }
  if (!images.length) errors.push('至少需要 1 张可访问的 HTTPS 商品图片。');
  if (rawImageRows.some((value) => !normalizeListingHttpsUrl(value)) || rows.some((item) => item.invalidImageUrl)) {
    errors.push('所有待上传商品图片都必须是有效的 HTTPS 地址。');
  }
  if (positiveNumber(draft.weightG) === null) errors.push('包裹重量必须大于 0 g。');
  for (const [field, label] of [
    ['packageLengthCm', '包裹长度'],
    ['packageWidthCm', '包裹宽度'],
    ['packageHeightCm', '包裹高度'],
  ]) {
    if (positiveNumber(draft[field]) === null) errors.push(`${label}必须大于 0 cm。`);
  }
  if (!parsedAttributes.ok) errors.push(parsedAttributes.error);
  if (rows.some((item) => clean(item.stock) && nonNegativeNumber(item.stock) === null)) errors.push('库存必须是大于或等于 0 的数字。');
  if (rows.some((item) => clean(item.stock) && !positiveInteger(item.warehouseId))) errors.push('填写库存时必须同时选择仓库。');
  if (!/[\u0400-\u04FF]/u.test(title)) warnings.push('标题中没有检测到俄文，上架前请人工复核语言。');
  const sanitizedAttributes = sanitizeBuiltListingAttributeList(parsedAttributes.attributes);
  const duplicateVariantGroup = duplicateListingSkuVariantGroup(
    rows,
    sanitizedAttributes,
    draft.skuAttributeIds,
  );
  if (duplicateVariantGroup.length) {
    const labels = duplicateVariantGroup.slice(0, 3).map((item) => item.offerId).filter(Boolean).join('、');
    errors.push(`SKU 变体属性组合重复${labels ? `（${labels}${duplicateVariantGroup.length > 3 ? '等' : ''}）` : ''}，本次不会提交 Ozon。`);
  }
  if (!sanitizedAttributes.length) warnings.push('属性列表为空，Ozon 可能会按类目必填属性拒绝导入。');

  return { ok: errors.length === 0, errors, warnings, images, attributes: sanitizedAttributes, rows };
}

function appendDescriptionAttribute(attributes, description) {
  const value = clean(description, 6000);
  if (!value || attributes.some((item) => Number(item.id) === 4191)) return attributes;
  return [...attributes, { complex_id: 0, id: 4191, values: [{ value }] }];
}

export function buildCollectionListingCommands(draft = {}, operationId = '') {
  const validation = validateCollectionListingDraft(draft);
  if (!validation.ok) {
    const error = new Error(validation.errors[0] || '上架草稿未通过校验。');
    error.code = 'COLLECTION_LISTING_DRAFT_INVALID';
    error.details = validation;
    throw error;
  }
  const shopId = clean(draft.shopId, 180);
  const baseId = clean(operationId, 180) || `collection-listing-${Date.now()}`;
  const attributes = validation.attributes;
  const listingRows = validation.rows.map((row) => ({
    ...row,
    price: effectiveCnyOrListingPrice(row, 'price'),
    oldPrice: effectiveCnyOrListingPrice(row, 'oldPrice'),
    minPrice: effectiveCnyOrListingPrice(row, 'minPrice'),
  }));
  const commonImages = buildCollectionListingImagePayload(validation.images[0], validation.images);
  const commonInfo = {
    description_category_id: positiveInteger(draft.descriptionCategoryId),
    type_id: positiveInteger(draft.typeId),
    currency_code: 'CNY',
    vat: clean(draft.vat || '0', 20),
    weight: Math.round(positiveNumber(draft.weightG)),
    weight_unit: 'g',
    depth: Math.round(positiveNumber(draft.packageLengthCm) * 10),
    width: Math.round(positiveNumber(draft.packageWidthCm) * 10),
    height: Math.round(positiveNumber(draft.packageHeightCm) * 10),
    dimension_unit: 'mm',
    ...commonImages,
    attributes: appendDescriptionAttribute(attributes, draft.description),
    complex_attributes: [],
    pdf_list: [],
  };
  const infoItems = listingRows.map((row) => {
    const images = buildCollectionListingImagePayload(
      row.imageUrl || commonInfo.primary_image,
      [row.imageUrl, commonInfo.primary_image, ...commonInfo.images],
    );
    return {
      ...commonInfo,
      ...images,
      offer_id: row.offerId,
      name: row.title || clean(draft.title, 5000),
      old_price: decimalText(row.oldPrice),
      price: decimalText(row.price),
      attributes: appendDescriptionAttribute(
        sanitizeBuiltListingAttributeList([...attributes, ...(row.attributes || [])]),
        draft.description,
      ),
    };
  });
  const priceItems = listingRows.map((row) => ({
    offer_id: row.offerId,
    price: decimalText(row.price),
    old_price: decimalText(row.oldPrice),
    currency_code: commonInfo.currency_code,
    ...(clean(row.minPrice) ? { min_price: decimalText(row.minPrice) } : {}),
  }));
  const commands = [
    {
      kind: 'info',
      label: '商品卡',
      command: {
        shopId,
        action: 'product.updateInfo',
        endpointKey: 'products.import',
        payload: { items: infoItems },
        before: null,
        after: { items: infoItems },
        idempotencyKey: `${baseId}:info`,
        requestedBy: 'collection-pricing-listing',
      },
    },
    {
      kind: 'price',
      label: '价格',
      command: {
        shopId,
        action: 'product.updatePrice',
        endpointKey: 'products.updatePrices',
        payload: { prices: priceItems },
        before: null,
        after: { prices: priceItems },
        idempotencyKey: `${baseId}:price`,
        requestedBy: 'collection-pricing-listing',
      },
    },
  ];
  const stockItems = listingRows.filter((row) => clean(row.stock)).map((row) => ({
    offer_id: row.offerId,
    stock: Math.floor(nonNegativeNumber(row.stock)),
    warehouse_id: positiveInteger(row.warehouseId),
  }));
  if (stockItems.length) {
    commands.push({
      kind: 'stock',
      label: '库存',
      command: {
        shopId,
        action: 'product.updateStock',
        endpointKey: 'products.updateStocks',
        payload: { stocks: stockItems },
        before: null,
        after: { stocks: stockItems },
        idempotencyKey: `${baseId}:stock`,
        requestedBy: 'collection-pricing-listing',
      },
    });
  }
  return {
    validation,
    commands,
    infoItem: infoItems[0],
    priceItem: priceItems[0],
    infoItems,
    priceItems,
    stockItems,
  };
}
