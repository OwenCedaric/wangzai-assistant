import { getOzonEndpoint } from '../../ozon/ozonEndpointRegistry.js';

const PRODUCT_WRITE_ACTIONS = Object.freeze({
  'product.updateInfo': {
    endpointKey: 'products.import',
    mergeTypes: ['info', 'attributes'],
    description: '商品资料保存',
  },
  'product.updateAttributes': {
    endpointKey: 'products.updateAttributes',
    mergeTypes: ['attributes'],
    payloadShape: 'modelAttributeOnly',
    description: '商品型号属性修改',
  },
  'product.updatePrice': {
    endpointKey: 'products.updatePrices',
    mergeTypes: ['prices'],
    description: '商品价格修改',
  },
  'product.updateStock': {
    endpointKey: 'products.updateStocks',
    mergeTypes: ['stocks'],
    description: '商品库存修改',
  },
  'product.archive': {
    endpointKey: 'products.archive',
    mergeTypes: ['list'],
    fallbackVisibility: 'ARCHIVED',
    payloadShape: 'productIdsOnly',
    description: '商品下架',
  },
  'product.unarchive': {
    endpointKey: 'products.unarchive',
    mergeTypes: ['list'],
    fallbackVisibility: 'TO_SUPPLY',
    payloadShape: 'productIdsOnly',
    description: '商品上架',
  },
});

const PRODUCT_INFO_READBACK_DELAYS_MS = Object.freeze([
  0,
  750,
  1_500,
  2_500,
  4_000,
  6_500,
  9_000,
  12_000,
  16_000,
  20_000,
]);

// A newly imported product can already be visible through product info while
// the stock service still returns PRODUCT_IS_NOT_CREATED. The same endpoint
// can also return TOO_MANY_REQUESTS inside a HTTP-200 item result. Retrying the
// whole batch would repeat successful stock mutations, so only retry rejected
// offer rows until the stock projection/cooldown catches up.
const PRODUCT_STOCK_VISIBILITY_RETRY_DELAYS_MS = Object.freeze([
  5_000,
  15_000,
  30_000,
  60_000,
]);

const RETRYABLE_STOCK_APPLICATION_ERROR_CODES = new Set([
  'PRODUCT_IS_NOT_CREATED',
  'TOO_MANY_REQUESTS',
]);

const PRODUCT_URL_ATTRIBUTE_IDS = new Set(['8790', '21841', '21845']);
const PRODUCT_MANAGED_ATTRIBUTE_IDS = Object.freeze({
  name: '4180',
  typeId: '8229',
  offerId: '9024',
  modelName: '9048',
});

const PRODUCT_MODEL_NAME_MAX_LENGTH = 100;

function waitForMilliseconds(delayMs = 0) {
  const boundedDelay = Math.max(0, Number(delayMs) || 0);
  if (!boundedDelay) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, boundedDelay));
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalizeRows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.products)) return value.products;
  if (Array.isArray(value?.result?.items)) return value.result.items;
  if (Array.isArray(value?.result)) return value.result;
  if (value && typeof value === 'object') return [value];
  return [];
}

function normalizeProductId(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Number.isSafeInteger(value) ? value : String(Math.trunc(value));
  }
  const text = normalizeText(value);
  if (!/^\d+$/.test(text)) return null;
  const numeric = Number(text);
  if (Number.isSafeInteger(numeric) && numeric > 0) return numeric;
  return text;
}

function collectProductIds(payload = {}) {
  const candidates = [
    payload.product_id,
    payload.productId,
    payload.productIds,
    payload.product_ids,
    payload.id,
  ];
  const ids = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const values = Array.isArray(candidate) ? candidate : candidate == null ? [] : [candidate];
    for (const value of values) {
      const id = normalizeProductId(value);
      if (id == null) continue;
      const key = String(id);
      if (seen.has(key)) continue;
      seen.add(key);
      ids.push(id);
    }
  }
  return ids;
}

function buildSchedulerPayload({ actionConfig, payload = {} } = {}) {
  if (actionConfig?.payloadShape === 'modelAttributeOnly') {
    const items = normalizeRows(payload?.items);
    if (!items.length || items.length > 100) {
      return {
        ok: false,
        error: {
          code: 'PRODUCT_MODEL_ATTRIBUTE_ITEMS_INVALID',
          message: '型号属性修改必须包含 1 至 100 个商品。',
        },
      };
    }
    const normalizedItems = [];
    for (const item of items) {
      const offerId = normalizeText(firstPresent(item?.offer_id, item?.offerId));
      const attributes = normalizeRows(item?.attributes);
      const modelAttribute = attributes.find((attribute) => (
        normalizeText(firstPresent(attribute?.id, attribute?.attribute_id, attribute?.attributeId)) ===
          PRODUCT_MANAGED_ATTRIBUTE_IDS.modelName
      ));
      const modelValue = normalizeText(
        normalizeRows(modelAttribute?.values)[0]?.value ?? modelAttribute?.value,
      );
      const hasForeignAttribute = attributes.some((attribute) => (
        normalizeText(firstPresent(attribute?.id, attribute?.attribute_id, attribute?.attributeId)) !==
          PRODUCT_MANAGED_ATTRIBUTE_IDS.modelName
      ));
      if (!offerId || !modelAttribute || !modelValue || modelValue.length > PRODUCT_MODEL_NAME_MAX_LENGTH || hasForeignAttribute) {
        return {
          ok: false,
          error: {
            code: 'PRODUCT_MODEL_ATTRIBUTE_PAYLOAD_INVALID',
            message: '剔除跟卖只允许按货号修改 9048 型号属性，且型号不能为空或超过 100 个字符。',
          },
        };
      }
      normalizedItems.push({
        offer_id: offerId,
        attributes: [{
          id: Number(PRODUCT_MANAGED_ATTRIBUTE_IDS.modelName),
          complex_id: 0,
          values: [{ dictionary_value_id: 0, value: modelValue }],
        }],
      });
    }
    return { ok: true, payload: { items: normalizedItems } };
  }
  if (actionConfig?.payloadShape !== 'productIdsOnly') {
    return { ok: true, payload: payload && typeof payload === 'object' ? payload : {} };
  }

  const productIds = collectProductIds(payload);
  if (!productIds.length) {
    return {
      ok: false,
      error: {
        code: 'PRODUCT_WRITE_PRODUCT_ID_REQUIRED',
        message: '商品上架/下架必须提供有效 product_id；本次不会提交 Ozon。',
      },
    };
  }

  return {
    ok: true,
    payload: { product_id: productIds },
  };
}

function resolveReadBackRows(result = {}, input = {}, preview = {}) {
  const direct = normalizeRows(result.readBackRows);
  if (direct.length) return direct;
  const dataRows = normalizeRows(result.data?.readBackRows || result.data?.items || result.data?.result);
  if (dataRows.length) return dataRows;
  const inputRows = normalizeRows(input.readBackRows || input.payload?.readBackRows);
  if (inputRows.length) return inputRows;
  return normalizeRows(preview?.payload?.readBackRows);
}

function ensureRowsForVisibility(rows = [], visibility = '') {
  if (!visibility) return rows;
  return rows.map((row) => ({
    ...row,
    visibility: normalizeText(row.visibility) || visibility,
  }));
}

function hasStockQuantityEvidence(row = {}) {
  if (!row || typeof row !== 'object') return false;
  const directCandidates = [
    row.present,
    row.stock,
    row.stock_value,
    row.stockValue,
    row.available,
    row.quantity,
    row.available_stock_count,
    row.valid_stock_count,
  ];
  if (directCandidates.some((value) => value !== undefined && value !== null && value !== '')) {
    return true;
  }
  const stocks = row.stocks;
  if (Array.isArray(stocks)) {
    return stocks.some(hasStockQuantityEvidence);
  }
  if (stocks && typeof stocks === 'object') {
    return hasStockQuantityEvidence(stocks);
  }
  return false;
}

function isRetryableStockTransportFailure(writeResult = {}) {
  const code = normalizeText(writeResult?.error?.code).toUpperCase();
  const message = normalizeText(writeResult?.error?.message).toLowerCase();
  const statusCode = Number(
    writeResult?.error?.status ??
    writeResult?.error?.statusCode ??
    writeResult?.statusCode,
  ) || 0;
  if ([408, 425, 429].includes(statusCode) || statusCode >= 500) return true;
  if (/401|403|invalid[_\s-]*(?:api[_\s-]*)?key|unauthor|forbidden/iu.test(`${code} ${message}`)) {
    return false;
  }
  return [
    'OZON_SCHEDULER_ERROR',
    'OZON_HTTP_ERROR',
    'OZON_NETWORK_ERROR',
    'OZON_TIMEOUT',
  ].includes(code) && /fetch|network|timeout|timed out|econn|socket|429|5\d\d/iu.test(message);
}

function collectRetryableStockVisibilityOfferIds(writeResult = {}, payload = {}) {
  if (writeResult?.ok) return [];
  const failedItems = Array.isArray(writeResult?.error?.failedItems)
    ? writeResult.error.failedItems
    : [];
  if (!failedItems.length) {
    if (!isRetryableStockTransportFailure(writeResult)) return [];
    return [...new Set((Array.isArray(payload?.stocks) ? payload.stocks : [])
      .map((row) => normalizeText(firstPresent(row?.offer_id, row?.offerId)))
      .filter(Boolean))];
  }

  const offerIds = [];
  for (const failedItem of failedItems) {
    const errors = Array.isArray(failedItem?.errors) ? failedItem.errors : [];
    if (!errors.length || errors.some((error) => !RETRYABLE_STOCK_APPLICATION_ERROR_CODES.has(
      normalizeText(firstPresent(error?.code, error?.error_code)).toUpperCase(),
    ))) {
      return [];
    }
    const offerId = normalizeText(firstPresent(
      failedItem?.raw?.offer_id,
      failedItem?.raw?.offerId,
      failedItem?.label,
    ));
    if (!offerId) return [];
    offerIds.push(offerId);
  }
  return [...new Set(offerIds)];
}

function narrowStockPayloadToOfferIds(payload = {}, offerIds = []) {
  const targetOfferIds = new Set(offerIds.map(normalizeText).filter(Boolean));
  const stocks = Array.isArray(payload?.stocks)
    ? payload.stocks.filter((row) => targetOfferIds.has(normalizeText(
        firstPresent(row?.offer_id, row?.offerId),
      )))
    : [];
  return stocks.length === targetOfferIds.size ? { stocks } : null;
}

function normalizeHttpsUrl(value) {
  const source = normalizeText(value);
  if (!source) return '';
  try {
    const parsed = new URL(source);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function normalizeOzonProductName(value) {
  return normalizeText(value)
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '')
    .replace(/[\u2212\u2010-\u2015]/gu, '-')
    .replace(/[°º]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function stableProductModelScopeToken(values = []) {
  const candidates = [...new Set(values.map(normalizeText).filter(Boolean))].sort();
  if (!candidates.length) return '';
  let commonPrefix = candidates[0];
  for (const value of candidates.slice(1)) {
    let length = 0;
    const boundary = Math.min(commonPrefix.length, value.length);
    while (length < boundary && commonPrefix[length] === value[length]) length += 1;
    commonPrefix = commonPrefix.slice(0, length);
    if (!commonPrefix) break;
  }
  const stableIdentity = commonPrefix.replace(/[-_:./]+$/gu, '').slice(0, 80)
    || candidates.join('|');
  let hash = 2166136261;
  for (const character of stableIdentity) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36).toUpperCase().padStart(7, '0').slice(-7);
}

function collectProductModelScopeTokens(items = []) {
  const offersByModel = new Map();
  for (const item of normalizeRows(items)) {
    const modelAttribute = normalizeRows(item?.attributes).find((attribute) => (
      String(firstPresent(attribute?.id, attribute?.attribute_id, attribute?.attributeId)) ===
      PRODUCT_MANAGED_ATTRIBUTE_IDS.modelName
    ));
    const modelName = normalizeOzonProductName(firstPresent(
      modelAttribute?.values?.[0]?.value,
      item?.model_name,
      item?.modelName,
      item?.name,
    )) || 'WZ-商品';
    if (!offersByModel.has(modelName)) offersByModel.set(modelName, []);
    offersByModel.get(modelName).push(normalizeText(firstPresent(item?.offer_id, item?.offerId)));
  }
  return new Map([...offersByModel.entries()].map(([modelName, offerIds]) => [
    modelName,
    stableProductModelScopeToken(offerIds),
  ]));
}

function collectPreferredExistingProductModels(items = [], existingRows = []) {
  const existingByOffer = new Map(normalizeRows(existingRows).map((row) => [
    normalizeText(firstPresent(row?.offerId, row?.offer_id)),
    normalizeOzonProductName(firstPresent(row?.modelName, row?.model_name, row?.value)),
  ]).filter(([offerId, modelName]) => offerId && modelName));
  const candidatesBySourceModel = new Map();
  for (const item of normalizeRows(items)) {
    const sourceModel = normalizeOzonProductName(firstPresent(
      normalizeRows(item?.attributes).find((attribute) => (
        String(firstPresent(attribute?.id, attribute?.attribute_id, attribute?.attributeId)) ===
        PRODUCT_MANAGED_ATTRIBUTE_IDS.modelName
      ))?.values?.[0]?.value,
      item?.model_name,
      item?.modelName,
      item?.name,
    )) || 'WZ-商品';
    const existingModel = existingByOffer.get(normalizeText(firstPresent(item?.offer_id, item?.offerId)));
    if (!existingModel) continue;
    if (!candidatesBySourceModel.has(sourceModel)) candidatesBySourceModel.set(sourceModel, new Map());
    const counts = candidatesBySourceModel.get(sourceModel);
    counts.set(existingModel, (counts.get(existingModel) || 0) + 1);
  }
  return new Map([...candidatesBySourceModel.entries()].map(([sourceModel, counts]) => [
    sourceModel,
    [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] || '',
  ]).filter(([, modelName]) => modelName));
}

function buildShopScopedProductModelName(value, shopId, productScopeToken = '') {
  const original = normalizeOzonProductName(value) || 'WZ-商品';
  const shopToken = normalizeText(shopId)
    .replace(/^ozon-shop-/iu, '')
    .replace(/[^a-z0-9]+/giu, '')
    .slice(-20);
  const scopeToken = normalizeText(productScopeToken).replace(/[^a-z0-9]+/giu, '').slice(-7);
  if (!shopToken && !scopeToken) return original.slice(0, PRODUCT_MODEL_NAME_MAX_LENGTH);
  const suffix = [shopToken ? `WZ${shopToken}` : 'WZ', scopeToken].filter(Boolean).join('-');
  const unscoped = original
    .replace(/-WZ[a-z0-9]{0,20}(?:-[a-z0-9]{1,7})?$/iu, '')
    .trim() || 'WZ-商品';
  const scopedSuffix = `-${suffix}`;
  return `${unscoped.slice(0, PRODUCT_MODEL_NAME_MAX_LENGTH - scopedSuffix.length)}${scopedSuffix}`;
}

function replaceAttributeTextValue(attribute = {}, value = '') {
  const sourceValues = Array.isArray(attribute.values) ? attribute.values : [];
  const first = sourceValues[0] && typeof sourceValues[0] === 'object'
    ? sourceValues[0]
    : {};
  return {
    ...attribute,
    values: [{ ...first, value }],
  };
}

function normalizeManagedProductAttributes(attributes = [], item = {}, options = {}) {
  const offerId = normalizeText(firstPresent(item.offer_id, item.offerId));
  const name = normalizeOzonProductName(item.name);
  return attributes.map((attribute) => {
    const id = String(firstPresent(attribute?.id, attribute?.attribute_id, attribute?.attributeId));
    if (id === PRODUCT_MANAGED_ATTRIBUTE_IDS.offerId) {
      return replaceAttributeTextValue(attribute, offerId);
    }
    if (id === PRODUCT_MANAGED_ATTRIBUTE_IDS.name) {
      return replaceAttributeTextValue(attribute, name);
    }
    if (id === PRODUCT_MANAGED_ATTRIBUTE_IDS.modelName) {
      const modelName = firstPresent(
        attribute?.values?.[0]?.value,
        item.model_name,
        item.modelName,
        name,
      );
      return replaceAttributeTextValue(
        attribute,
        options.preferredModelName || buildShopScopedProductModelName(
          modelName,
          options.shopId,
          options.productScopeToken,
        ),
      );
    }
    return attribute;
  });
}

function normalizeOzonAttributeList(attributes = [], itemLabel = '商品') {
  if (!Array.isArray(attributes)) {
    return {
      ok: false,
      error: {
        code: 'PRODUCT_ATTRIBUTE_LIST_INVALID',
        message: `${itemLabel}的属性列表格式错误，本次未提交 Ozon。`,
      },
    };
  }
  const normalized = [];
  for (const attribute of attributes) {
    const id = Number(firstPresent(attribute?.id, attribute?.attribute_id, attribute?.attributeId));
    if (!Number.isSafeInteger(id) || id <= 0 || !Array.isArray(attribute?.values)) {
      return {
        ok: false,
        error: {
          code: 'PRODUCT_ATTRIBUTE_VALUE_INVALID',
          message: `${itemLabel}包含无效的 Ozon 属性结构，本次未提交 Ozon。`,
        },
      };
    }
    const values = [];
    for (const entry of attribute.values) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return {
          ok: false,
          error: {
            code: 'PRODUCT_ATTRIBUTE_VALUE_INVALID',
            message: `${itemLabel}的属性 ${id} 值格式错误，本次未提交 Ozon。`,
          },
        };
      }
      const next = { ...entry };
      if (Object.hasOwn(next, 'value')) {
        if (typeof next.value === 'boolean') next.value = next.value ? 'true' : 'false';
        else if (typeof next.value === 'number' && Number.isFinite(next.value)) next.value = String(next.value);
        else if (next.value == null) delete next.value;
        else if (typeof next.value !== 'string') {
          return {
            ok: false,
            error: {
              code: 'PRODUCT_ATTRIBUTE_VALUE_INVALID',
              message: `${itemLabel}的属性 ${id} 必须是文本值，本次未提交 Ozon。`,
            },
          };
        }
      }
      if (PRODUCT_URL_ATTRIBUTE_IDS.has(String(id)) && next.value) {
        const url = normalizeHttpsUrl(next.value);
        if (!url) {
          return {
            ok: false,
            error: {
              code: 'PRODUCT_ATTRIBUTE_URL_INVALID',
              message: `${itemLabel}的属性 ${id} 不是有效的 HTTPS 地址，本次未提交 Ozon。`,
            },
          };
        }
        next.value = url;
      }
      values.push(next);
    }
    normalized.push({ ...attribute, id, values });
  }
  return { ok: true, attributes: normalized };
}

function normalizeOzonComplexAttributeList(complexAttributes = [], itemLabel = '商品') {
  if (!Array.isArray(complexAttributes)) {
    return {
      ok: false,
      error: {
        code: 'PRODUCT_COMPLEX_ATTRIBUTE_LIST_INVALID',
        message: `${itemLabel}的组合属性列表格式错误，本次未提交 Ozon。`,
      },
    };
  }

  const normalized = [];
  for (const entry of complexAttributes) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return {
        ok: false,
        error: {
          code: 'PRODUCT_COMPLEX_ATTRIBUTE_VALUE_INVALID',
          message: `${itemLabel}包含无效的 Ozon 组合属性结构，本次未提交 Ozon。`,
        },
      };
    }

    // Ozon 历史与新版 schema 都出现过：
    // 1. 属性直接放在 complex_attributes 里；
    // 2. 每个组合对象用 attributes 再包一层。
    // 两种都做递归式字段规范化，不按来源商品或类目写特判。
    if (Array.isArray(entry.attributes)) {
      const attributes = normalizeOzonAttributeList(entry.attributes, itemLabel);
      if (!attributes.ok) return attributes;
      normalized.push({ ...entry, attributes: attributes.attributes });
      continue;
    }

    const attribute = normalizeOzonAttributeList([entry], itemLabel);
    if (!attribute.ok) return attribute;
    normalized.push(attribute.attributes[0]);
  }
  return { ok: true, complexAttributes: normalized };
}

function normalizeProductInfoPayload(payload = {}, options = {}) {
  const items = normalizeRows(payload?.items);
  if (!items.length || items.length > 100) {
    return {
      ok: false,
      error: {
        code: 'PRODUCT_INFO_ITEMS_INVALID',
        message: '单次商品资料写入必须包含 1 到 100 个 SKU，本次未提交 Ozon。',
      },
    };
  }
  const modelScopeTokens = collectProductModelScopeTokens(items);
  const preferredExistingModels = collectPreferredExistingProductModels(
    items,
    options.existingProductModels,
  );
  const offerIds = new Set();
  const normalizedItems = [];
  for (const [index, item] of items.entries()) {
    const offerId = normalizeText(firstPresent(item?.offer_id, item?.offerId));
    const itemLabel = offerId || `第 ${index + 1} 个 SKU`;
    if (!offerId || offerId.length > 30 || offerIds.has(offerId)) {
      return {
        ok: false,
        error: {
          code: 'PRODUCT_OFFER_ID_INVALID',
          message: `${itemLabel}的货号为空、重复或超过 30 个字符，本次未提交 Ozon。`,
        },
      };
    }
    offerIds.add(offerId);
    const name = normalizeOzonProductName(item?.name);
    if (!name) {
      return {
        ok: false,
        error: {
          code: 'PRODUCT_NAME_REQUIRED',
          message: `${itemLabel}的商品标题为空，本次未提交 Ozon。`,
        },
      };
    }
    const primarySource = normalizeText(firstPresent(item.primary_image, item.primaryImage));
    const primaryImage = primarySource ? normalizeHttpsUrl(primarySource) : '';
    if (primarySource && !primaryImage) {
      return {
        ok: false,
        error: {
          code: 'PRODUCT_PRIMARY_IMAGE_URL_INVALID',
          message: `${itemLabel}的主图不是有效的 HTTPS 地址，本次未提交 Ozon。`,
        },
      };
    }
    const imageSources = Array.isArray(item.images) ? item.images : [];
    const images = [];
    for (const value of imageSources) {
      const image = normalizeHttpsUrl(value);
      if (!image) {
        return {
          ok: false,
          error: {
            code: 'PRODUCT_IMAGE_URL_INVALID',
            message: `${itemLabel}包含无效的 HTTPS 商品图片，本次未提交 Ozon。`,
          },
        };
      }
      if (image !== primaryImage && !images.includes(image)) images.push(image);
    }
    if (images.length > 29) {
      return {
        ok: false,
        error: {
          code: 'PRODUCT_IMAGE_LIMIT_EXCEEDED',
          message: `${itemLabel}超过 Ozon 图片上限：最多 1 张主图加 29 张附加图。`,
        },
      };
    }
    const attributes = normalizeOzonAttributeList(item.attributes || [], itemLabel);
    if (!attributes.ok) return attributes;
    const complexAttributes = normalizeOzonComplexAttributeList(
      item.complex_attributes || [],
      itemLabel,
    );
    if (!complexAttributes.ok) return complexAttributes;
    normalizedItems.push({
      ...item,
      offer_id: offerId,
      name,
      ...(primarySource ? { primary_image: primaryImage } : {}),
      images,
      attributes: normalizeManagedProductAttributes(attributes.attributes, {
        ...item,
        offer_id: offerId,
        name,
      }, {
        ...options,
        preferredModelName: preferredExistingModels.get(normalizeOzonProductName(firstPresent(
          attributes.attributes.find((attribute) => (
            String(firstPresent(attribute?.id, attribute?.attribute_id, attribute?.attributeId)) ===
            PRODUCT_MANAGED_ATTRIBUTE_IDS.modelName
          ))?.values?.[0]?.value,
          item?.model_name,
          item?.modelName,
          name,
        )) || 'WZ-商品'),
        productScopeToken: modelScopeTokens.get(normalizeOzonProductName(firstPresent(
          attributes.attributes.find((attribute) => (
            String(firstPresent(attribute?.id, attribute?.attribute_id, attribute?.attributeId)) ===
            PRODUCT_MANAGED_ATTRIBUTE_IDS.modelName
          ))?.values?.[0]?.value,
          item?.model_name,
          item?.modelName,
          name,
        )) || 'WZ-商品'),
      }),
      ...(Object.hasOwn(item, 'complex_attributes') || complexAttributes.complexAttributes.length
        ? { complex_attributes: complexAttributes.complexAttributes }
        : {}),
    });
  }
  return { ok: true, payload: { ...payload, items: normalizedItems } };
}

function hasPriceEvidence(row = {}) {
  if (!row || typeof row !== 'object') return false;
  const price = row.price && typeof row.price === 'object' ? row.price : {};
  return [
    row.price_value,
    row.priceValue,
    row.marketing_price,
    row.marketing_seller_price,
    row.old_price,
    price.price,
    price.marketing_price,
    price.marketing_seller_price,
    price.old_price,
  ].some((value) => value !== undefined && value !== null && value !== '');
}

function hasStatusEvidence(row = {}) {
  if (!row || typeof row !== 'object') return false;
  const status = row.status && typeof row.status === 'object' ? row.status : {};
  const visibilityDetails =
    row.visibility_details && typeof row.visibility_details === 'object' ? row.visibility_details : {};
  const textCandidates = [
    row.visibility,
    row.visibility_status,
    row.visibilityStatus,
    row.status_label,
    row.statusLabel,
    row.state,
    typeof row.status === 'string' ? row.status : '',
    status.state,
    status.name,
    visibilityDetails.visibility,
    visibilityDetails.status,
    visibilityDetails.state,
  ];
  if (textCandidates.some((value) => normalizeText(value))) return true;
  return [row.archived, row.is_archived, row.isArchive, row.is_archive].some(
    (value) => value === true || value === 1 || value === 'true',
  );
}

function hasUsableReadBackRows(rows = [], actionConfig = {}) {
  if (!rows.length) return false;
  const mergeTypes = Array.isArray(actionConfig.mergeTypes) ? actionConfig.mergeTypes : [];
  if (
    mergeTypes.includes('info') &&
    !rows.some((row) =>
      row &&
      typeof row === 'object' &&
      normalizeText(firstPresent(row.product_id, row.productId, row.id, row.offer_id, row.offerId)) &&
      normalizeText(row.name),
    )
  ) return false;
  if (mergeTypes.includes('stocks') && !rows.some(hasStockQuantityEvidence)) return false;
  if (mergeTypes.includes('prices') && !rows.some(hasPriceEvidence)) return false;
  if (mergeTypes.includes('list') && !rows.some(hasStatusEvidence)) return false;
  return true;
}

function firstPresent(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function normalizeAuditId(value) {
  const text = normalizeText(value);
  return text || null;
}

function toAuditNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getStockAuditQuantity(row = {}) {
  return toAuditNumber(
    firstPresent(
      row.stock,
      row.present,
      row.quantity,
      row.stock_value,
      row.stockValue,
      row.available,
      row.available_stock_count,
      row.valid_stock_count,
    ),
  );
}

function hasStockAuditIdentity(row = {}) {
  return Boolean(
    normalizeAuditId(firstPresent(row.product_id, row.productId, row.id)) ||
      normalizeAuditId(firstPresent(row.offer_id, row.offerId)) ||
      normalizeAuditId(firstPresent(row.warehouse_id, row.warehouseId, row.warehouse?.id)),
  );
}

function expandStockAuditRows(rows = []) {
  const output = [];
  for (const row of normalizeRows(rows)) {
    if (!row || typeof row !== 'object') continue;
    const stockContainer = row.stocks && typeof row.stocks === 'object' && !Array.isArray(row.stocks) ? row.stocks : {};
    const nested = [
      ...(Array.isArray(row.stocks) ? row.stocks : []),
      ...(Array.isArray(stockContainer.stocks) ? stockContainer.stocks : []),
      ...(Array.isArray(row.warehouse_stocks) ? row.warehouse_stocks : []),
      ...(Array.isArray(row.warehouseStocks) ? row.warehouseStocks : []),
      ...(Array.isArray(row.quants) ? row.quants : []),
    ].filter((item) => item && typeof item === 'object');
    if (nested.length) {
      nested.forEach((stock) => {
        output.push({
          ...stock,
          product_id: firstPresent(stock.product_id, stock.productId, stock.id, row.product_id, row.productId, row.id),
          offer_id: firstPresent(stock.offer_id, stock.offerId, row.offer_id, row.offerId),
          sku: firstPresent(stock.sku, stock.sku_id, stock.skuId, stock.fbs_sku, row.sku, row.sku_id, row.skuId, row.fbs_sku),
        });
      });
    } else {
      output.push(row);
    }
  }
  return output.filter(hasStockAuditIdentity);
}

function collectStockRowsFromPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return [];
  const candidates = [
    payload.stocks,
    payload.stock,
    payload.items,
    payload.result,
    payload.result?.items,
    payload.result?.stocks,
  ].filter((value) => value !== undefined && value !== null);
  if (!candidates.length && hasStockAuditIdentity(payload)) return [payload];
  return candidates.flatMap(expandStockAuditRows);
}

function uniqueStockAuditRows(rows = []) {
  const seen = new Set();
  const output = [];
  for (const row of rows) {
    const key = JSON.stringify({
      product_id: normalizeAuditId(firstPresent(row.product_id, row.productId, row.id)),
      offer_id: normalizeAuditId(firstPresent(row.offer_id, row.offerId)),
      sku: normalizeAuditId(firstPresent(row.sku, row.sku_id, row.skuId, row.fbs_sku)),
      warehouse_id: normalizeAuditId(firstPresent(row.warehouse_id, row.warehouseId, row.warehouse?.id)),
      quantity: getStockAuditQuantity(row),
    });
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(row);
  }
  return output;
}

function normalizeStockAuditRow(row = {}, mode = 'submitted') {
  const quantity = getStockAuditQuantity(row);
  return {
    warehouse_id: normalizeAuditId(firstPresent(row.warehouse_id, row.warehouseId, row.warehouse?.id)),
    offer_id: normalizeAuditId(firstPresent(row.offer_id, row.offerId)),
    product_id: normalizeAuditId(firstPresent(row.product_id, row.productId, row.id)),
    sku: normalizeAuditId(firstPresent(row.sku, row.sku_id, row.skuId, row.fbs_sku)),
    submitted_qty: mode === 'submitted' ? quantity : null,
    readback_qty: mode === 'readback' ? quantity : null,
    quantity,
  };
}

function collectSubmittedStockRows({ payload = {}, input = {}, preview = {} } = {}) {
  return uniqueStockAuditRows([
    ...collectStockRowsFromPayload(payload),
    ...collectStockRowsFromPayload(input.payload),
    ...collectStockRowsFromPayload(input.after),
    ...collectStockRowsFromPayload(preview?.payload),
    ...collectStockRowsFromPayload(preview?.diff?.after),
  ]).map((row) => normalizeStockAuditRow(row, 'submitted'));
}

function collectProductReadBackTargets({ payload = {}, input = {}, preview = {} } = {}) {
  const rows = normalizeRows([
    ...normalizeRows(payload?.prices),
    ...normalizeRows(payload?.stocks),
    ...normalizeRows(payload?.items),
    ...normalizeRows(payload),
    ...normalizeRows(input?.payload?.prices),
    ...normalizeRows(input?.payload?.stocks),
    ...normalizeRows(input?.payload?.items),
    ...normalizeRows(input?.after?.prices),
    ...normalizeRows(input?.after?.stocks),
    ...normalizeRows(input?.after?.items),
    ...normalizeRows(input?.before),
    ...normalizeRows(preview?.payload?.prices),
    ...normalizeRows(preview?.payload?.stocks),
    ...normalizeRows(preview?.payload?.items),
    ...normalizeRows(preview?.diff?.after?.prices),
    ...normalizeRows(preview?.diff?.after?.stocks),
    ...normalizeRows(preview?.diff?.after?.items),
    ...normalizeRows(preview?.diff?.before),
  ]);
  const rawProductIds = [
    payload?.product_id,
    payload?.productId,
    payload?.product_ids,
    payload?.productIds,
    input?.payload?.product_id,
    input?.payload?.productIds,
    input?.before?.product_id,
    input?.before?.productId,
    preview?.payload?.product_id,
    preview?.diff?.after?.product_id,
    preview?.diff?.before?.product_id,
    preview?.diff?.before?.productId,
  ];
  const rawOfferIds = [
    payload?.offer_id,
    payload?.offerId,
    payload?.offer_ids,
    payload?.offerIds,
    input?.payload?.offer_id,
    input?.payload?.offerIds,
    input?.before?.offer_id,
    input?.before?.offerId,
    preview?.payload?.offer_id,
    preview?.diff?.after?.offer_id,
    preview?.diff?.before?.offer_id,
    preview?.diff?.before?.offerId,
  ];
  const productIds = new Set();
  const offerIds = new Set();
  const pushProductId = (value) => {
    const id = normalizeProductId(value);
    if (id != null) productIds.add(String(id));
  };
  const pushOfferId = (value) => {
    const text = normalizeText(value);
    if (text) offerIds.add(text);
  };
  rawProductIds.flatMap((value) => (Array.isArray(value) ? value : [value])).forEach(pushProductId);
  rawOfferIds.flatMap((value) => (Array.isArray(value) ? value : [value])).forEach(pushOfferId);
  rows.forEach((row) => {
    pushProductId(firstPresent(row.product_id, row.productId, row.id));
    pushOfferId(firstPresent(row.offer_id, row.offerId));
  });
  return {
    productIds: [...productIds],
    offerIds: [...offerIds],
  };
}

function resolveReadBackProductIdsFromRepository({
  repository,
  shopId,
  payload,
  input,
  preview,
} = {}) {
  if (!repository?.listProducts || !shopId) return [];
  const targets = collectProductReadBackTargets({ payload, input, preview });
  if (!targets.offerIds.length) return [];
  const rows = repository.listProducts({
    shopId,
    offerIds: targets.offerIds,
    pageSize: Math.min(Math.max(targets.offerIds.length, 1), 1000),
  })?.rows || [];
  return [...new Set(rows
    .map((row) => normalizeProductId(firstPresent(row?.productId, row?.product_id, row?.id)))
    .filter((value) => value != null))];
}

function collectReadBackStockRows(rows = []) {
  return uniqueStockAuditRows(expandStockAuditRows(rows)).map((row) => normalizeStockAuditRow(row, 'readback'));
}

function hasExactSubmittedWarehouseEvidence({
  submittedRows = [],
  readBackEndpointRows = null,
} = {}) {
  const warehouseTargets = submittedRows.filter((row) => row.warehouse_id);
  if (!warehouseTargets.length) return true;
  const endpoint = readBackEndpointRows?.['products.stocksByWarehouseFbs'];
  if (!endpoint || endpoint.pagination?.explicitComplete !== true) return false;
  const candidates = collectReadBackStockRows(endpoint.rows);
  return warehouseTargets.every((target) =>
    candidates.some((candidate) => {
      const sameProduct =
        target.product_id && candidate.product_id === target.product_id;
      const sameOffer = target.offer_id && candidate.offer_id === target.offer_id;
      return (
        (sameProduct || sameOffer) &&
        candidate.warehouse_id === target.warehouse_id
      );
    }),
  );
}

function collectFinalStockRows({ repository, shopId, submittedRows = [], readBackRows = [] } = {}) {
  if (!repository?.listProducts || !shopId) return [];
  const productIds = [
    ...new Set([...submittedRows, ...readBackRows].map((row) => row.product_id).filter(Boolean)),
  ];
  const offerIds = [
    ...new Set([...submittedRows, ...readBackRows].map((row) => row.offer_id).filter(Boolean)),
  ];
  const rows = [];
  const seen = new Set();
  const pushRows = (pageRows = []) => {
    pageRows.forEach((row) => {
      const key = `${row.productId || ''}:${row.offerId || ''}:${row.sku || ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push(row);
    });
  };
  if (productIds.length) {
    pushRows(repository.listProducts({ shopId, productIds, pageSize: 100 }).rows || []);
  }
  if (offerIds.length) {
    pushRows(repository.listProducts({ shopId, offerIds, pageSize: 100 }).rows || []);
  }
  return rows.map((row) => ({
    product_id: row.productId || null,
    offer_id: row.offerId || null,
    sku: row.sku || null,
    stock_value: row.stockValue ?? null,
    stock_json: row.stockJson || null,
    stocks_synced_at: row.stocksSyncedAt || null,
    warehouse_stocks: Array.isArray(row.warehouseStocks)
      ? row.warehouseStocks.map((stock) => ({
          warehouse_id: stock.warehouseId ?? null,
          warehouse_name: stock.warehouseName ?? null,
          warehouse_key: stock.warehouseKey ?? stock.warehouseId ?? null,
          sku: stock.sku ?? null,
          fulfillment_type: stock.fulfillmentType ?? null,
          present: stock.presentQuantity ?? null,
          reserved: stock.reservedQuantity ?? null,
          free_stock: stock.freeQuantity ?? null,
          operation_id: stock.operationId ?? null,
          contract_version: stock.contractVersion ?? null,
          mapper_version: stock.mapperVersion ?? null,
          response_hash: stock.responseHash ?? null,
          observed_at: stock.observedAt ?? null,
        }))
      : [],
    seller_warehouse_stock_total: row.sellerWarehouseStockTotal ?? null,
    warehouse_stock_complete: row.warehouseStockComplete === true,
    warehouse_stock_observation: row.warehouseStockObservation || null,
  }));
}

function buildStockWriteAudit({
  actionConfig,
  repository,
  shopId,
  payload,
  input,
  preview,
  writeResult,
  writeStatus,
  readBackStatus = 'pending',
  readBackRows = [],
  readBackErrors = [],
  merge = null,
} = {}) {
  if (!actionConfig?.mergeTypes?.includes('stocks')) return null;
  const submittedRows = collectSubmittedStockRows({ payload, input, preview });
  const readBackAuditRows = collectReadBackStockRows(readBackRows);
  const readAt = readBackAuditRows.length ? new Date().toISOString() : null;
  const finalRows = collectFinalStockRows({
    repository,
    shopId,
    submittedRows,
    readBackRows: readBackAuditRows,
  });
  return {
    writeStatus,
    ozonResponse: writeResult?.data ?? null,
    schedulerStatus: writeResult?.status || null,
    jobId: writeResult?.jobId || writeResult?.id || null,
    submittedRows,
    readBack: {
      status: readBackStatus,
      rowCount: readBackAuditRows.length,
      rows: readBackAuditRows,
      readAt,
      errors: readBackErrors,
    },
    sqliteMerge: merge
      ? {
          changed: Number(merge.changed) || 0,
          unchanged: Number(merge.unchanged) || 0,
          missing: Number(merge.missing) || 0,
          rows: Number(merge.rows) || 0,
          skipped: merge.skipped === true,
          reason: merge.reason || null,
          merges: merge.merges || [],
        }
      : null,
    finalRows,
  };
}

function getSchedulerData(result = {}) {
  return result?.data ?? result?.cache?.payload ?? null;
}

function normalizeContractBoolean(value) {
  if (value === true || value === false) return value;
  const text = normalizeText(value).toLowerCase();
  if (text === 'true' || text === '1') return true;
  if (text === 'false' || text === '0') return false;
  return null;
}

function resolveWarehouseCursorContinuation(data = {}) {
  const rawCursor = data?.cursor !== undefined ? data.cursor : data?.result?.cursor;
  const rawHasNext =
    data?.has_next !== undefined ? data.has_next : data?.result?.has_next;
  const cursor = normalizeText(rawCursor);
  const hasNext = normalizeContractBoolean(rawHasNext);
  const metadataPresent = rawCursor !== undefined || rawHasNext !== undefined;
  return {
    cursor,
    hasNext,
    metadataPresent,
    requiresContinuation: hasNext === true || Boolean(cursor),
    explicitComplete: metadataPresent && hasNext !== true && !cursor,
  };
}

function warehouseReadBackIncompleteError(reason = 'unknown') {
  const error = new Error(
    `PRODUCT_WAREHOUSE_STOCK_RESPONSE_INCOMPLETE:${normalizeText(reason) || 'unknown'}`,
  );
  error.code = 'PRODUCT_WAREHOUSE_STOCK_RESPONSE_INCOMPLETE';
  return error;
}

function extractSchedulerRows(result = {}) {
  return normalizeRows(getSchedulerData(result));
}

function isSchedulerReadOk(result = {}) {
  if (result?.status === 'partial') return false;
  return Boolean(
    result?.ok ||
      result?.status === 'success' ||
      result?.status === 'cache_hit',
  );
}

function collectNestedCandidates(value, output = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectNestedCandidates(item, output));
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  output.push(value);
  if (value.result && value.result !== value) collectNestedCandidates(value.result, output);
  if (value.data && value.data !== value) collectNestedCandidates(value.data, output);
  if (value.items && value.items !== value) collectNestedCandidates(value.items, output);
  return output;
}

function resolveProductImportTaskId(writeResult = {}) {
  const candidates = collectNestedCandidates([
    writeResult?.data,
    writeResult?.result,
    writeResult?.response,
  ]);
  for (const candidate of candidates) {
    const rawTaskId = firstPresent(candidate.task_id, candidate.taskId);
    const taskId = Number(rawTaskId);
    if (Number.isSafeInteger(taskId) && taskId > 0) return taskId;
    const text = normalizeText(rawTaskId);
    if (text) return text;
  }
  return null;
}

function collectProductImportInfoItems(result = {}) {
  const data = getSchedulerData(result);
  const direct = normalizeRows(
    data?.result?.items ||
      data?.items ||
      data?.result ||
      data,
  );
  return direct.filter((item) => item && typeof item === 'object');
}

function collectImportItemErrors(item = {}) {
  const errors = [];
  const values = Array.isArray(item.errors)
    ? item.errors
    : item.error
      ? [item.error]
      : [];
  for (const value of values) {
    if (!value) continue;
    if (typeof value === 'string') {
      const message = normalizeText(value);
      if (message) errors.push(message);
      continue;
    }
    const message = [
      normalizeText(firstPresent(value.code, value.error_code, value.name)),
      normalizeText(firstPresent(value.message, value.description, value.detail, value.reason)),
    ].filter(Boolean).join(': ');
    if (message) errors.push(message);
  }
  return errors;
}

const PRODUCT_DAILY_CREATION_LIMIT_ERROR_CODE = 'OZON_PRODUCT_DAILY_CREATION_LIMIT_EXCEEDED';
const PRODUCT_DAILY_CREATION_LIMIT_REASON = 'product_daily_creation_limit_exceeded';
const PRODUCT_CARD_GROUP_CONFLICT_ERROR_CODE = 'OZON_PRODUCT_CARD_GROUP_CONFLICT';
const PRODUCT_CARD_GROUP_CONFLICT_REASON = 'product_card_group_conflict';

function isProductDailyCreationLimitMessage(value) {
  const message = normalizeText(value).toLowerCase();
  if (!message) return false;
  if (message.includes('periodic_limit_exceeded')) return true;
  if (/daily\s+(?:product\s+)?(?:creation\s+)?limit/iu.test(message)) return true;
  return /суточн/iu.test(message) && /лимит/iu.test(message) && /создани/iu.test(message);
}

function isProductCardGroupConflictMessage(value) {
  return normalizeText(value).toUpperCase().includes('SPU_ALREADY_EXISTS_IN_ANOTHER_ACCOUNT');
}

function summarizeProductImportFailure(importAnalysis = {}) {
  const failures = Array.isArray(importAnalysis.failures) ? importAnalysis.failures : [];
  if (failures.some((failure) => isProductCardGroupConflictMessage(failure?.message))) {
    return {
      code: PRODUCT_CARD_GROUP_CONFLICT_ERROR_CODE,
      reason: PRODUCT_CARD_GROUP_CONFLICT_REASON,
      message: 'Ozon 检测到该商品的合并卡片型号已被其他店铺账号使用。软件会按目标店铺生成独立型号；请重新生成上架预览后再上传。',
    };
  }
  const dailyLimitFailures = failures.filter((failure) => (
    isProductDailyCreationLimitMessage(failure?.message)
  ));
  if (dailyLimitFailures.length) {
    return {
      code: PRODUCT_DAILY_CREATION_LIMIT_ERROR_CODE,
      reason: PRODUCT_DAILY_CREATION_LIMIT_REASON,
      message: 'Ozon 今日新建商品额度已用完，当前批次无法继续创建。额度将在莫斯科时间 03:00（北京时间 08:00）重置，请重置后返回预览重试。',
    };
  }
  const message = failures
    .slice(0, 5)
    .map((failure) => `${failure.offerId}：${failure.message}`)
    .join('；');
  return {
    code: 'PRODUCT_IMPORT_TASK_FAILED',
    reason: 'product_import_failed',
    message: message || 'Ozon 商品导入任务失败。',
  };
}

function analyzeProductImportInfo(items = [], expectedOfferIds = []) {
  const expected = [...new Set(expectedOfferIds.map(normalizeText).filter(Boolean))];
  const byOffer = new Map();
  for (const item of items) {
    const offerId = normalizeText(firstPresent(item.offer_id, item.offerId));
    if (offerId) byOffer.set(offerId, item);
  }
  const relevant = expected.length
    ? expected.map((offerId) => byOffer.get(offerId)).filter(Boolean)
    : items;
  const missingOfferIds = expected.filter((offerId) => !byOffer.has(offerId));
  const failures = relevant.flatMap((item) => {
    const offerId = normalizeText(firstPresent(item.offer_id, item.offerId)) || '未知 SKU';
    const status = normalizeText(firstPresent(item.status, item.state)).toLowerCase();
    const itemErrors = collectImportItemErrors(item);
    if (!itemErrors.length && /failed|error|reject|declin|cancel/iu.test(status)) {
      itemErrors.push(`导入状态 ${status}`);
    }
    return itemErrors.map((message) => ({ offerId, message }));
  });
  const pending = relevant.some((item) => {
    const status = normalizeText(firstPresent(item.status, item.state)).toLowerCase();
    return /pending|process|progress|queue|wait|loading|check/iu.test(status);
  });
  const productIds = [...new Set(relevant
    .map((item) => normalizeProductId(firstPresent(item.product_id, item.productId, item.id)))
    .filter((value) => value != null))];
  const offerIds = [...new Set(relevant
    .map((item) => normalizeText(firstPresent(item.offer_id, item.offerId)))
    .filter(Boolean))];
  const productIdByOffer = Object.fromEntries(relevant
    .map((item) => [
      normalizeText(firstPresent(item.offer_id, item.offerId)),
      normalizeProductId(firstPresent(item.product_id, item.productId, item.id)),
    ])
    .filter(([offerId, productId]) => offerId && productId != null));
  return {
    ready:
      relevant.length > 0 &&
      !missingOfferIds.length &&
      !failures.length &&
      !pending &&
      productIds.length >= relevant.length,
    pending:
      !failures.length &&
      (pending || !relevant.length || missingOfferIds.length > 0 || productIds.length < relevant.length),
    failed: failures.length > 0,
    failures,
    missingOfferIds,
    productIds,
    offerIds,
    productIdByOffer,
    itemCount: relevant.length,
  };
}

function resolvePositiveOzonSku(row = {}) {
  const sources = normalizeRows(firstPresent(
    row?.sources,
    row?.source,
    row?.result?.sources,
  ));
  const candidates = [
    row?.sku,
    row?.sku_id,
    row?.skuId,
    row?.fbs_sku,
    row?.fbsSku,
    ...sources.flatMap((source) => [
      source?.sku,
      source?.sku_id,
      source?.skuId,
      source?.fbs_sku,
      source?.fbsSku,
    ]),
  ];
  return candidates
    .map(normalizeProductId)
    .find((value) => value != null) ?? null;
}

function verifyImportedProductSkuReadiness({
  submittedItems = [],
  infoRows = [],
  importAnalysis = {},
} = {}) {
  const missingOfferIds = [];
  for (const target of normalizeRows(submittedItems)) {
    const offerId = normalizeText(firstPresent(target?.offer_id, target?.offerId));
    const productId = normalizeProductId(importAnalysis?.productIdByOffer?.[offerId]);
    const infoRow = normalizeRows(infoRows).find((candidate) => {
      const candidateOfferId = normalizeText(firstPresent(candidate?.offer_id, candidate?.offerId));
      const candidateProductId = normalizeProductId(firstPresent(
        candidate?.product_id,
        candidate?.productId,
        candidate?.id,
      ));
      return Boolean(
        (offerId && candidateOfferId === offerId) ||
        (productId != null && String(candidateProductId) === String(productId)),
      );
    });
    const isCreated = firstPresent(
      infoRow?.statuses?.is_created,
      infoRow?.statuses?.isCreated,
      infoRow?.status?.is_created,
      infoRow?.status?.isCreated,
      infoRow?.is_created,
      infoRow?.isCreated,
    );
    if (!infoRow || resolvePositiveOzonSku(infoRow) == null || isCreated === false) {
      missingOfferIds.push(offerId || String(productId || '未知 SKU'));
    }
  }
  return {
    ok: submittedItems.length > 0 && missingOfferIds.length === 0,
    missingOfferIds,
  };
}

async function readBackStockRowsFromOzon({
  ozonScheduler,
  repository,
  shopId,
  submittedRows = [],
  requestedBy = 'write-guard',
  idempotencyKey = '',
} = {}) {
  if (!ozonScheduler?.executeReadOnly || !shopId) {
    return { rows: [], errors: [] };
  }
  const productIds = [
    ...new Set(submittedRows.map((row) => row.product_id).filter(Boolean)),
  ];
  const offerIds = [
    ...new Set(submittedRows.map((row) => row.offer_id).filter(Boolean)),
  ];
  if (productIds.length && repository?.resolveOfferIdsForProducts) {
    offerIds.push(
      ...repository.resolveOfferIdsForProducts({
        shopId,
        productIds,
        offerIds: [],
        limit: Math.max(productIds.length, 1),
      }),
    );
  }
  const uniqueOfferIds = [...new Set(offerIds.map(normalizeText).filter(Boolean))];
  const requests = [];
  if (productIds.length) {
    requests.push({
      endpointKey: 'products.stocks',
      params: { filter: { product_id: productIds }, limit: 1000 },
      cacheKey: `products:write-readback:${shopId}:stocks:${Date.now()}`,
      idempotencyKey: `${idempotencyKey || 'product-stock-write'}:readback:stocks`,
    });
  }
  if (uniqueOfferIds.length) {
    requests.push({
      endpointKey: 'products.stocksByWarehouseFbs',
      params: { offer_id: uniqueOfferIds, limit: 1000 },
      cacheKey: `products:write-readback:${shopId}:warehouse:${Date.now()}`,
      idempotencyKey: `${idempotencyKey || 'product-stock-write'}:readback:warehouse`,
    });
  }

  const rows = [];
  const endpointRows = {};
  const errors = [];
  for (const request of requests) {
    try {
      const isWarehouseReadBack =
        request.endpointKey === 'products.stocksByWarehouseFbs';
      const endpoint = isWarehouseReadBack
        ? getOzonEndpoint(request.endpointKey)
        : null;
      const maxPages = isWarehouseReadBack
        ? Math.max(Number(endpoint?.planning?.maxPages) || 0, 1)
        : 1;
      const cursorParam = normalizeText(endpoint?.planning?.cursorParam) || 'cursor';
      const seenCursors = new Set();
      const extractedRows = [];
      let firstResult = null;
      let currentParams = { ...(request.params || {}) };
      let pagination = {
        pages: 0,
        metadataPresent: false,
        explicitComplete: false,
        followedContinuation: false,
      };

      for (let page = 1; page <= maxPages; page += 1) {
        const result = await ozonScheduler.executeReadOnly({
          shopId,
          domain: 'products',
          action: 'product-stock-write-readback',
          priority: 'P1',
          endpointKey: request.endpointKey,
          params: currentParams,
          cacheKey: page === 1 ? request.cacheKey : `${request.cacheKey}:page:${page}`,
          idempotencyKey:
            page === 1 ? request.idempotencyKey : `${request.idempotencyKey}:page:${page}`,
          requestedBy,
          forceRefresh: true,
          allowStale: false,
        });
        if (!isSchedulerReadOk(result)) {
          const readError = new Error(
            result?.error?.message || result?.job?.lastError || 'stock readback failed',
          );
          readError.code =
            result?.status === 'partial'
              ? 'PRODUCT_WAREHOUSE_STOCK_RESPONSE_INCOMPLETE'
              : 'PRODUCT_STOCK_READBACK_FAILED';
          throw readError;
        }
        if (!firstResult) firstResult = result;
        const data = getSchedulerData(result);
        extractedRows.push(...normalizeRows(data));
        pagination.pages = page;
        if (!isWarehouseReadBack) break;

        const continuation = resolveWarehouseCursorContinuation(data);
        pagination.metadataPresent =
          pagination.metadataPresent || continuation.metadataPresent;
        pagination.explicitComplete = continuation.explicitComplete;
        if (!continuation.requiresContinuation) {
          if (pagination.followedContinuation && !continuation.explicitComplete) {
            throw warehouseReadBackIncompleteError(
              'continuation_terminal_metadata_missing',
            );
          }
          break;
        }
        if (!continuation.cursor) {
          throw warehouseReadBackIncompleteError('continuation_cursor_missing');
        }
        if (seenCursors.has(continuation.cursor)) {
          throw warehouseReadBackIncompleteError('duplicate_cursor');
        }
        if (page >= maxPages) {
          throw warehouseReadBackIncompleteError('max_pages_exceeded');
        }
        seenCursors.add(continuation.cursor);
        pagination.followedContinuation = true;
        currentParams = {
          ...(request.params || {}),
          [cursorParam]: continuation.cursor,
        };
      }

      const requestLimit = Number(request.params?.limit || 0) || null;
      if (isWarehouseReadBack && !pagination.explicitComplete) {
        throw warehouseReadBackIncompleteError('completion_metadata_missing');
      }
      const responseLimit =
        isWarehouseReadBack && pagination.explicitComplete ? null : requestLimit;
      if (
        isWarehouseReadBack &&
        responseLimit > 0 &&
        extractedRows.length >= responseLimit
      ) {
        throw warehouseReadBackIncompleteError(
          'page_limit_without_completion_metadata',
        );
      }
      rows.push(...extractedRows);
      endpointRows[request.endpointKey] = {
        rows: extractedRows,
        provenance: firstResult?.provenance || {},
        responseLimit,
        pagination,
      };
    } catch (error) {
      errors.push({
        endpointKey: request.endpointKey,
        code: normalizeText(error?.code) || null,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { rows, endpointRows, errors };
}

async function readBackProductRowsFromOzon({
  ozonScheduler,
  shopId,
  actionConfig = {},
  payload = {},
  input = {},
  preview = {},
  additionalProductIds = [],
  additionalOfferIds = [],
  attempt = 1,
  requestedBy = 'write-guard',
  idempotencyKey = '',
} = {}) {
  if (!ozonScheduler?.executeReadOnly || !shopId) return { rows: [], errors: [] };
  const targets = collectProductReadBackTargets({ payload, input, preview });
  const productIds = [...new Set([
    ...targets.productIds,
    ...additionalProductIds.map(normalizeProductId).filter((value) => value != null),
  ])];
  const offerIds = [...new Set([
    ...targets.offerIds,
    ...additionalOfferIds.map(normalizeText).filter(Boolean),
  ])];
  const mergeTypes = Array.isArray(actionConfig.mergeTypes) ? actionConfig.mergeTypes : [];
  const requests = [];
  const baseKey = idempotencyKey || `product-write-readback:${Date.now()}`;
  const attemptKey = `attempt:${Math.max(1, Number(attempt) || 1)}`;
  if (mergeTypes.includes('info') && productIds.length) {
    requests.push({
      endpointKey: 'products.infoList',
      params: { product_id: productIds },
      cacheKey: `products:write-readback:${shopId}:info:${Date.now()}`,
      idempotencyKey: `${baseKey}:readback:info:${attemptKey}`,
    });
  }
  if (mergeTypes.includes('attributes') && offerIds.length) {
    requests.push({
      endpointKey: 'products.attributes',
      params: { filter: { offer_id: offerIds }, limit: 1000 },
      cacheKey: `products:write-readback:${shopId}:attributes:${Date.now()}`,
      idempotencyKey: `${baseKey}:readback:attributes:${attemptKey}`,
    });
  }
  if (mergeTypes.includes('list') && productIds.length) {
    requests.push({
      endpointKey: 'products.infoList',
      params: { product_id: productIds },
      cacheKey: `products:write-readback:${shopId}:info:${Date.now()}`,
      idempotencyKey: `${baseKey}:readback:info:${attemptKey}`,
    });
  }
  if (mergeTypes.includes('prices') && productIds.length) {
    requests.push({
      endpointKey: 'products.prices',
      params: { filter: { product_id: productIds }, limit: 1000 },
      cacheKey: `products:write-readback:${shopId}:prices:${Date.now()}`,
      idempotencyKey: `${baseKey}:readback:prices:${attemptKey}`,
    });
  }
  if (mergeTypes.includes('prices') && !productIds.length && offerIds.length) {
    requests.push({
      endpointKey: 'products.prices',
      params: { filter: { offer_id: offerIds }, limit: 1000 },
      cacheKey: `products:write-readback:${shopId}:prices-offer:${Date.now()}`,
      idempotencyKey: `${baseKey}:readback:prices:offer:${attemptKey}`,
    });
  }

  const rows = [];
  const endpointRows = {};
  const errors = [];
  for (const request of requests) {
    try {
      const result = await ozonScheduler.executeReadOnly({
        shopId,
        domain: 'products',
        action: 'product-write-readback',
        priority: 'P1',
        endpointKey: request.endpointKey,
        params: request.params,
        cacheKey: request.cacheKey,
        idempotencyKey: request.idempotencyKey,
        requestedBy,
        forceRefresh: true,
        allowStale: false,
      });
      if (!isSchedulerReadOk(result)) {
        errors.push({
          endpointKey: request.endpointKey,
          message: result?.error?.message || result?.job?.lastError || 'product readback failed',
        });
        continue;
      }
      const extractedRows = extractSchedulerRows(result);
      rows.push(...extractedRows);
      endpointRows[request.endpointKey] = {
        rows: extractedRows,
        provenance: result?.provenance || {},
      };
    } catch (error) {
      errors.push({
        endpointKey: request.endpointKey,
        code: normalizeText(error?.code) || null,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const identityGroups = [];
  const groupsByOfferId = new Map();
  const groupsByProductId = new Map();
  const unidentified = [];
  const hasMeaningfulValue = (value) => {
    if (value === null || value === undefined || value === '') return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
  };
  const mergeProductRow = (base = {}, next = {}) => {
    const merged = { ...base };
    for (const [key, value] of Object.entries(next || {})) {
      if (hasMeaningfulValue(value) || !hasMeaningfulValue(merged[key])) {
        merged[key] = value;
      }
    }
    return merged;
  };
  const remapGroupAliases = (group) => {
    for (const offerId of group.offerIds) groupsByOfferId.set(offerId, group);
    for (const productId of group.productIds) groupsByProductId.set(productId, group);
  };

  rows.forEach((row) => {
    const offerId = normalizeText(firstPresent(row?.offer_id, row?.offerId));
    const productId = normalizeText(firstPresent(row?.product_id, row?.productId, row?.id));
    if (!offerId && !productId) {
      unidentified.push(row);
      return;
    }

    const matches = [...new Set([
      offerId ? groupsByOfferId.get(offerId) : null,
      productId ? groupsByProductId.get(productId) : null,
    ].filter((group) => group && group.active))];
    let group = matches[0];
    if (!group) {
      group = {
        active: true,
        row: {},
        offerIds: new Set(),
        productIds: new Set(),
      };
      identityGroups.push(group);
    }
    for (const duplicate of matches.slice(1)) {
      group.row = mergeProductRow(group.row, duplicate.row);
      duplicate.offerIds.forEach((value) => group.offerIds.add(value));
      duplicate.productIds.forEach((value) => group.productIds.add(value));
      duplicate.active = false;
    }
    group.row = mergeProductRow(group.row, row);
    if (offerId) group.offerIds.add(offerId);
    if (productId) group.productIds.add(productId);
    remapGroupAliases(group);
  });
  return {
    rows: [
      ...identityGroups.filter((group) => group.active).map((group) => group.row),
      ...unidentified,
    ],
    endpointRows,
    errors,
  };
}

function mergeReadBackRows({
  repository,
  shopId,
  rows,
  endpointRows = null,
  submittedRows = [],
  actionConfig,
}) {
  const hasEndpointRows = Boolean(
    endpointRows && Object.keys(endpointRows).length > 0,
  );
  if (!rows.length && !hasEndpointRows) {
    return { changed: 0, unchanged: 0, missing: 0, rows: 0, skipped: true };
  }
  const summary = {
    changed: 0,
    unchanged: 0,
    missing: 0,
    rows: rows.length,
    merges: [],
  };
  for (const mergeType of actionConfig.mergeTypes) {
    let result = null;
    if (mergeType === 'info') {
      result = repository.mergeProductInfoRows({
        shopId,
        rows: endpointRows?.['products.infoList']?.rows || rows,
      });
    } else if (mergeType === 'attributes') {
      result = repository.mergeProductAttributeRows({
        shopId,
        rows: endpointRows?.['products.attributes']?.rows || rows,
      });
    } else if (mergeType === 'prices') {
      result = repository.mergeProductPriceRows({
        shopId,
        rows: endpointRows?.['products.prices']?.rows || rows,
      });
    } else if (mergeType === 'stocks') {
      const primaryReadBack = endpointRows?.['products.stocks'];
      const warehouseEndpoint = endpointRows?.['products.stocksByWarehouseFbs'];
      const warehouseReadBack =
        warehouseEndpoint?.pagination?.explicitComplete === true
          ? warehouseEndpoint
          : null;
      const expectedProductIds = [
        ...new Set(submittedRows.map((row) => row.product_id).filter(Boolean)),
      ];
      const expectedOfferIds = [
        ...new Set(submittedRows.map((row) => row.offer_id).filter(Boolean)),
      ];
      if (primaryReadBack || warehouseReadBack) {
        const stockMerges = [];
        if (primaryReadBack) {
          stockMerges.push(repository.mergeProductStockRows({
            shopId,
            rows: primaryReadBack.rows,
            endpointKey: 'products.stocks',
            provenance: primaryReadBack.provenance,
          }));
        }
        if (warehouseReadBack) {
          stockMerges.push(repository.mergeProductWarehouseStockRows({
            shopId,
            rows: warehouseReadBack.rows,
            endpointKey: 'products.stocksByWarehouseFbs',
            provenance: warehouseReadBack.provenance,
            responseLimit: warehouseReadBack.responseLimit,
            expectedProductIds,
            expectedOfferIds,
          }));
        }
        result = {
          changed: stockMerges.reduce(
            (total, merge) => total + (Number(merge.changed) || 0),
            0,
          ),
          unchanged: stockMerges.reduce(
            (total, merge) => total + (Number(merge.unchanged) || 0),
            0,
          ),
          missing: stockMerges.reduce(
            (total, merge) => total + (Number(merge.missing) || 0),
            0,
          ),
          rows: stockMerges.reduce(
            (total, merge) => total + (Number(merge.rows) || 0),
            0,
          ),
          merges: stockMerges,
        };
      } else {
        result = {
          changed: 0,
          unchanged: 0,
          missing: 0,
          rows: 0,
          skipped: true,
          reason: 'stock_readback_endpoint_provenance_missing',
        };
      }
    } else if (mergeType === 'list') {
      result = repository.upsertProducts({
        shopId,
        rows: endpointRows?.['products.infoList']?.rows || rows,
        visibility: 'ALL',
        endpointKey: actionConfig.endpointKey,
      });
    }
    if (result) {
      summary.changed += Number(result.changed) || 0;
      summary.unchanged += Number(result.unchanged) || 0;
      summary.missing += Number(result.missing) || 0;
      summary.merges.push(result);
      if (result.skipped === true) {
        summary.skipped = true;
        summary.reason = summary.reason || result.reason || null;
      }
    }
  }
  return summary;
}

function sameNumericValue(left, right) {
  if (left === null || left === undefined || left === '' || right === null || right === undefined || right === '') {
    return false;
  }
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber === rightNumber;
}

function rowMatchesIdentity(row = {}, target = {}) {
  const rowProductId = normalizeText(firstPresent(row.product_id, row.productId, row.id));
  const rowOfferId = normalizeText(firstPresent(row.offer_id, row.offerId));
  const targetProductId = normalizeText(firstPresent(target.product_id, target.productId, target.id));
  const targetOfferId = normalizeText(firstPresent(target.offer_id, target.offerId));
  return Boolean(
    (targetProductId && rowProductId === targetProductId) ||
    (targetOfferId && rowOfferId === targetOfferId),
  );
}

function getReadBackPrice(row = {}) {
  const price = row.price && typeof row.price === 'object' ? row.price : {};
  return firstPresent(
    price.price,
    row.price_value,
    row.priceValue,
    row.marketing_seller_price,
    row.marketing_price,
  );
}

function getReadBackVisibilityText(row = {}) {
  const status = row.status && typeof row.status === 'object' ? row.status : {};
  const details = row.visibility_details && typeof row.visibility_details === 'object' ? row.visibility_details : {};
  return [
    row.visibility,
    row.visibility_status,
    row.visibilityStatus,
    row.status_label,
    row.statusLabel,
    row.state,
    typeof row.status === 'string' ? row.status : '',
    status.state,
    status.name,
    details.visibility,
    details.status,
    details.state,
  ].map(normalizeText).filter(Boolean).join(' ').toLowerCase();
}

function getReadBackInfoNumber(row = {}, field = '') {
  const dimensions = row.dimensions && typeof row.dimensions === 'object' ? row.dimensions : {};
  const raw = firstPresent(
    row[field],
    dimensions[field],
    field === 'depth' ? dimensions.length : null,
  );
  if (raw === null || raw === undefined || raw === '') return null;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return null;
  if (field === 'weight') {
    const unit = normalizeText(firstPresent(row.weight_unit, row.weightUnit, dimensions.weight_unit)).toLowerCase();
    return unit === 'kg' ? numeric * 1000 : numeric;
  }
  const unit = normalizeText(firstPresent(row.dimension_unit, row.dimensionUnit, dimensions.dimension_unit)).toLowerCase();
  return unit === 'cm' ? numeric * 10 : numeric;
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = stableJsonValue(value[key]);
      return result;
    }, {});
}

function normalizeComparableAttributeValue(value) {
  const normalized = normalizeText(value);
  if (!normalized || !/^[\[{]/u.test(normalized)) return normalized;
  try {
    return JSON.stringify(stableJsonValue(JSON.parse(normalized)));
  } catch {
    return normalized;
  }
}

function normalizeAttributeValues(attribute = {}) {
  const values = Array.isArray(attribute.values)
    ? attribute.values
    : Array.isArray(attribute.value)
      ? attribute.value
      : [attribute.value ?? attribute.dictionary_value ?? attribute.dictionaryValue];
  return values.map((value) => {
    if (value && typeof value === 'object') {
      const dictionaryValueId = Number(firstPresent(
        value.dictionary_value_id,
        value.dictionaryValueId,
      ));
      return normalizeComparableAttributeValue(
        Number.isSafeInteger(dictionaryValueId) && dictionaryValueId > 0
          ? dictionaryValueId
          : firstPresent(value.value, value.dictionary_value, value.dictionaryValue),
      );
    }
    return normalizeComparableAttributeValue(value);
  }).filter(Boolean).sort().join('|');
}

function verifySubmittedAttributes(target = {}, readBackRows = []) {
  const submitted = normalizeRows(target.attributes);
  if (!submitted.length) return true;
  const attributeRow = readBackRows.find((row) => (
    rowMatchesIdentity(row, target) &&
    Array.isArray(row.attributes) &&
    row.attributes.length > 0
  ));
  if (!attributeRow) return false;
  const actualById = new Map(attributeRow.attributes.map((attribute) => [
    normalizeText(firstPresent(attribute.id, attribute.attribute_id, attribute.attributeId)),
    normalizeAttributeValues(attribute),
  ]));
  return submitted.every((attribute) => {
    const id = normalizeText(firstPresent(attribute.id, attribute.attribute_id, attribute.attributeId));
    if (id === PRODUCT_MANAGED_ATTRIBUTE_IDS.offerId) {
      return normalizeText(firstPresent(attributeRow.offer_id, attributeRow.offerId)) ===
        normalizeText(firstPresent(target.offer_id, target.offerId));
    }
    if (id === PRODUCT_MANAGED_ATTRIBUTE_IDS.name) {
      return normalizeOzonProductName(attributeRow.name) === normalizeOzonProductName(target.name);
    }
    if (id === PRODUCT_MANAGED_ATTRIBUTE_IDS.typeId) {
      const submittedTypeId = normalizeText(firstPresent(
        target.type_id,
        target.typeId,
        normalizeAttributeValues(attribute),
      ));
      const actualTypeId = normalizeText(firstPresent(
        attributeRow.type_id,
        attributeRow.typeId,
        actualById.get(id),
      ));
      return Boolean(submittedTypeId) && submittedTypeId === actualTypeId;
    }
    return id && actualById.get(id) === normalizeAttributeValues(attribute);
  });
}

function flattenComplexAttributes(value = [], output = []) {
  for (const entry of normalizeRows(value)) {
    if (!entry || typeof entry !== 'object') continue;
    if (Array.isArray(entry.attributes)) {
      flattenComplexAttributes(entry.attributes, output);
      continue;
    }
    if (Array.isArray(entry.values)) output.push(entry);
  }
  return output;
}

function verifySubmittedComplexAttributes(target = {}, readBackRows = []) {
  const submitted = flattenComplexAttributes(target.complex_attributes);
  if (!submitted.length) return true;
  const candidates = readBackRows.filter((row) => rowMatchesIdentity(row, target));
  const actual = candidates.flatMap((row) => flattenComplexAttributes(row.complex_attributes));
  if (!actual.length) return false;
  const attributeId = (attribute = {}) => normalizeText(firstPresent(
    attribute.id,
    attribute.attribute_id,
    attribute.attributeId,
  ));
  const toKey = (attribute = {}) => [
    normalizeText(firstPresent(attribute.complex_id, attribute.complexId, 0)),
    attributeId(attribute),
  ].join(':');
  const actualById = new Map(actual.map((attribute) => [
    toKey(attribute),
    normalizeAttributeValues(attribute),
  ]));
  return submitted.every((attribute) => {
    const key = toKey(attribute);
    return Boolean(attributeId(attribute)) &&
      actualById.get(key) === normalizeAttributeValues(attribute);
  });
}

function collectImageUrls(value) {
  const values = (Array.isArray(value) ? value : value == null ? [] : [value]).flat(Infinity);
  return values
    .flatMap((item) => {
      if (typeof item === 'string') return [item];
      if (!item || typeof item !== 'object') return [];
      return [item.url, item.file_name, item.fileName, item.image_url, item.imageUrl];
    })
    .map(normalizeText)
    .filter(Boolean);
}

function collectTrackedImageUrls(value, output = []) {
  if (typeof value === 'string') {
    const normalized = normalizeText(value);
    if (/^https:\/\//iu.test(normalized)) output.push(normalized);
    else if (/^[\[{]/u.test(normalized)) {
      try { collectTrackedImageUrls(JSON.parse(normalized), output); } catch { /* ordinary attribute text */ }
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTrackedImageUrls(item, output);
    return output;
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) collectTrackedImageUrls(child, output);
  }
  return output;
}

function verifySubmittedImages(target = {}, readBackRows = []) {
  const submittedPrimary = normalizeText(firstPresent(target.primary_image, target.primaryImage));
  const submitted = [...new Set(collectImageUrls([submittedPrimary, target.images]))];
  if (!submitted.length) return true;
  const matchingRows = readBackRows.filter((candidate) => rowMatchesIdentity(candidate, target));
  if (!matchingRows.length) return false;
  const actualPrimary = collectImageUrls(matchingRows.flatMap((row) => [
    row.primary_image,
    row.primaryImage,
  ]));
  if (submittedPrimary && !actualPrimary.length) return false;
  const actual = collectImageUrls(matchingRows.flatMap((row) => [
    row.primary_image,
    row.primaryImage,
    row.images,
    row.pictures,
    row.complex_attributes?.images,
  ]));
  if (!actual.length) return false;
  // Ozon downloads source URLs into its own CDN, so URL equality is not stable.
  // Count/order evidence plus a returned primary image is the strongest official
  // readback signal available from product info.
  const expectedCount = submitted.length;
  const actualUniqueCount = new Set(actual).size;
  return actualUniqueCount >= expectedCount;
}

function verifyProductWriteReadBack({
  action,
  payload = {},
  input = {},
  preview = {},
  readBackRows = [],
  readBackEndpointRows = null,
} = {}) {
  if (!readBackRows.length) return { ok: false, reason: 'readback_empty' };

  if (action === 'product.updatePrice') {
    const submitted = normalizeRows(payload.prices || input?.payload?.prices || preview?.payload?.prices);
    const ok = submitted.length > 0 && submitted.every((target) => {
      const row = readBackRows.find((candidate) => rowMatchesIdentity(candidate, target));
      return row && sameNumericValue(getReadBackPrice(row), target.price);
    });
    return { ok, reason: ok ? '' : 'price_readback_mismatch' };
  }

  if (action === 'product.updateStock') {
    const submitted = collectSubmittedStockRows({ payload, input, preview });
    const combinedActual = collectReadBackStockRows(readBackRows);
    const warehouseEndpoint =
      readBackEndpointRows?.['products.stocksByWarehouseFbs'];
    const primaryEndpoint = readBackEndpointRows?.['products.stocks'];
    const warehouseActual = warehouseEndpoint?.pagination?.explicitComplete === true
      ? collectReadBackStockRows(warehouseEndpoint.rows)
      : [];
    const primaryActual = primaryEndpoint
      ? collectReadBackStockRows(primaryEndpoint.rows)
      : combinedActual;
    let missingWarehouseEvidence = false;
    const ok = submitted.length > 0 && submitted.every((target) => {
      const matchesIdentity = (candidate) => {
        const sameProduct =
          target.product_id && candidate.product_id === target.product_id;
        const sameOffer = target.offer_id && candidate.offer_id === target.offer_id;
        return Boolean(sameProduct || sameOffer);
      };
      if (target.warehouse_id) {
        const exactWarehouseRows = warehouseActual.filter(
          (candidate) =>
            matchesIdentity(candidate) &&
            candidate.warehouse_id === target.warehouse_id,
        );
        if (!exactWarehouseRows.length) {
          missingWarehouseEvidence = true;
          return false;
        }
        return exactWarehouseRows.some((candidate) =>
          sameNumericValue(candidate.readback_qty, target.submitted_qty),
        );
      }

      const productRows = primaryActual.filter(matchesIdentity);
      if (!productRows.length) return false;
      if (
        productRows.some((candidate) =>
          sameNumericValue(candidate.readback_qty, target.submitted_qty),
        )
      ) {
        return true;
      }
      const total = productRows.reduce(
        (sum, candidate) => sum + (Number(candidate.readback_qty) || 0),
        0,
      );
      return sameNumericValue(total, target.submitted_qty);
    });
    if (ok) return { ok: true, reason: '', pending: false };
    return {
      ok: false,
      reason: missingWarehouseEvidence
        ? 'warehouse_stock_readback_pending'
        : 'stock_readback_mismatch',
      pending: missingWarehouseEvidence,
    };
  }

  if (action === 'product.updateInfo') {
    const submitted = normalizeRows(payload.items || input?.payload?.items || preview?.payload?.items);
    const numericFields = ['weight', 'depth', 'width', 'height'];
    const infoRows = readBackEndpointRows?.['products.infoList']?.rows || readBackRows;
    const attributeRows = readBackEndpointRows?.['products.attributes']?.rows || readBackRows;
    const mismatches = [];
    const itemMatches = submitted.map((target) => {
      const offerId = normalizeText(firstPresent(target.offer_id, target.offerId));
      const infoRow = infoRows.find((candidate) => (
        rowMatchesIdentity(candidate, target) && normalizeText(candidate.name)
      ));
      const attributeRow = attributeRows.find((candidate) => rowMatchesIdentity(candidate, target));
      const row = infoRow || attributeRow;
      const fields = [];
      if (!row) fields.push('missing_product');
      else if (normalizeOzonProductName(row.name) !== normalizeOzonProductName(target.name)) fields.push('name');
      const numbersMatch = numericFields.every((field) => {
        if (target[field] === undefined || target[field] === null || target[field] === '') return true;
        const actual = [attributeRow, infoRow]
          .filter(Boolean)
          .map((candidate) => getReadBackInfoNumber(candidate, field))
          .find((value) => value !== null);
        const matches = sameNumericValue(actual, target[field]);
        if (!matches) fields.push(field);
        return matches;
      });
      const attributesMatch = verifySubmittedAttributes(target, attributeRows);
      if (!attributesMatch) fields.push('attributes');
      const complexAttributesMatch = verifySubmittedComplexAttributes(target, attributeRows);
      if (!complexAttributesMatch) fields.push('complex_attributes');
      const imagesMatch = verifySubmittedImages(target, [
        ...infoRows,
        ...attributeRows,
      ]);
      if (!imagesMatch) fields.push('images');
      if (
        !row ||
        normalizeOzonProductName(row.name) !== normalizeOzonProductName(target.name) ||
        !numbersMatch ||
        !attributesMatch ||
        !complexAttributesMatch ||
        !imagesMatch
      ) {
        mismatches.push({ offerId, fields: [...new Set(fields)] });
        return false;
      }
      return true;
    });
    const ok = submitted.length > 0 && itemMatches.every(Boolean);
    return {
      ok,
      reason: ok ? '' : 'info_readback_mismatch',
      checked: submitted.length,
      mismatches: mismatches.slice(0, 20),
    };
  }

  if (action === 'product.updateAttributes') {
    const submitted = normalizeRows(payload.items || input?.payload?.items || preview?.payload?.items);
    const attributeRows = readBackEndpointRows?.['products.attributes']?.rows || readBackRows;
    const mismatches = submitted
      .filter((target) => !verifySubmittedAttributes(target, attributeRows))
      .map((target) => ({
        offerId: normalizeText(firstPresent(target.offer_id, target.offerId)),
        fields: ['attributes'],
      }));
    const ok = submitted.length > 0 && mismatches.length === 0;
    return {
      ok,
      reason: ok ? '' : 'attribute_readback_mismatch',
      checked: submitted.length,
      mismatches: mismatches.slice(0, 20),
    };
  }

  if (action === 'product.archive' || action === 'product.unarchive') {
    const productIds = collectProductIds(payload);
    const matchedRows = productIds.map((id) => readBackRows.find((row) => rowMatchesIdentity(row, { product_id: id })));
    const shouldArchive = action === 'product.archive';
    const ok = matchedRows.length > 0 && matchedRows.every((row) => {
      if (!row || !hasStatusEvidence(row)) return false;
      const text = getReadBackVisibilityText(row);
      const archived = row.archived === true || row.is_archived === true || /archive|归档|下架/.test(text);
      return shouldArchive ? archived : !archived;
    });
    return { ok, reason: ok ? '' : 'visibility_readback_mismatch' };
  }

  return { ok: false, reason: 'readback_verifier_missing' };
}

async function readBackProductInfoUntilVerified({
  ozonScheduler,
  shopId,
  actionConfig,
  payload,
  input,
  preview,
  writeResult,
  action = 'product.updateInfo',
  requestedBy,
  idempotencyKey,
  waitForReadBack = waitForMilliseconds,
  readBackDelaysMs = PRODUCT_INFO_READBACK_DELAYS_MS,
} = {}) {
  const taskId = resolveProductImportTaskId(writeResult);
  const targets = collectProductReadBackTargets({ payload, input, preview });
  const submittedInfoItems = normalizeRows(
    payload?.items ||
      input?.payload?.items ||
      preview?.payload?.items ||
      preview?.diff?.after?.items,
  );
  const expectedOfferIds = submittedInfoItems.length
    ? [...new Set(submittedInfoItems
        .map((item) => normalizeText(firstPresent(item.offer_id, item.offerId)))
        .filter(Boolean))]
    : targets.offerIds;
  const configuredDelays = Array.isArray(readBackDelaysMs) && readBackDelaysMs.length
    ? readBackDelaysMs
    : PRODUCT_INFO_READBACK_DELAYS_MS;
  const delays = taskId ? configuredDelays : [configuredDelays[0] || 0];
  const errors = [];
  let importAnalysis = taskId
    ? {
        ready: false,
        pending: true,
        productIds: [],
        offerIds: [],
        productIdByOffer: {},
        itemCount: 0,
      }
    : null;
  let readBackRows = [];
  let readBackEndpointRows = null;
  let verification = { ok: false, pending: true, reason: 'info_readback_pending' };

  for (let index = 0; index < delays.length; index += 1) {
    await waitForReadBack(Math.max(0, Number(delays[index]) || 0));
    const attempt = index + 1;

    // Ozon can first expose product IDs and only later attach moderation
    // errors to the same import task. Re-read the task on every attempt so a
    // late terminal error is never mislabeled as an endless detail-readback
    // delay.
    if (taskId) {
      try {
        const importResult = await ozonScheduler.executeReadOnly({
          shopId,
          domain: 'products',
          action: 'product-import-task-readback',
          priority: 'P1',
          endpointKey: 'products.importInfo',
          params: { task_id: taskId },
          cacheKey: `products:write-readback:${shopId}:import:${taskId}:${attempt}:${Date.now()}`,
          idempotencyKey: `${idempotencyKey || writeResult?.jobId || 'product-import'}:readback:import:${attempt}`,
          requestedBy,
          forceRefresh: true,
          allowStale: false,
        });
        if (!isSchedulerReadOk(importResult)) {
          errors.push({
            endpointKey: 'products.importInfo',
            message: importResult?.error?.message || importResult?.job?.lastError || 'product import task readback failed',
          });
          continue;
        }
        importAnalysis = analyzeProductImportInfo(
          collectProductImportInfoItems(importResult),
          expectedOfferIds,
        );
        if (importAnalysis.failed) {
          const failure = summarizeProductImportFailure(importAnalysis);
          return {
            rows: [],
            endpointRows: null,
            errors: [{
              endpointKey: 'products.importInfo',
              code: failure.code,
              message: failure.message,
            }],
            verification: {
              ok: false,
              pending: false,
              terminal: true,
              code: failure.code,
              reason: failure.reason,
              message: failure.message,
            },
            importTask: { taskId, ...importAnalysis, attempts: attempt },
          };
        }
        if (!importAnalysis.ready) continue;
      } catch (error) {
        errors.push({
          endpointKey: 'products.importInfo',
          code: normalizeText(error?.code) || null,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }

    const readBack = await readBackProductRowsFromOzon({
      ozonScheduler,
      shopId,
      actionConfig,
      payload,
      input,
      preview,
      additionalProductIds: importAnalysis?.productIds || [],
      additionalOfferIds: importAnalysis?.offerIds || [],
      attempt,
      requestedBy,
      idempotencyKey,
    });
    readBackRows = readBack.rows;
    readBackEndpointRows = readBack.endpointRows || null;
    errors.push(...readBack.errors);
    if (!hasUsableReadBackRows(readBackRows, actionConfig)) {
      verification = {
        ok: false,
        pending: true,
        reason: readBackRows.length ? 'info_readback_unusable' : 'info_readback_empty',
      };
      continue;
    }
    verification = verifyProductWriteReadBack({
      action,
      payload,
      input,
      preview,
      readBackRows,
      readBackEndpointRows,
    });
    if (verification.ok && taskId && action === 'product.updateInfo') {
      const skuReadiness = verifyImportedProductSkuReadiness({
        submittedItems: submittedInfoItems,
        infoRows: readBackEndpointRows?.['products.infoList']?.rows || readBackRows,
        importAnalysis,
      });
      if (!skuReadiness.ok) {
        verification = {
          ok: false,
          pending: true,
          reason: 'product_sku_not_ready',
          checked: submittedInfoItems.length,
          missingOfferIds: skuReadiness.missingOfferIds.slice(0, 100),
        };
        continue;
      }
    }
    if (verification.ok) {
      return {
        rows: readBackRows,
        endpointRows: readBackEndpointRows,
        errors,
        verification,
        importTask: taskId ? { taskId, ...importAnalysis, attempts: attempt } : null,
      };
    }
  }

  const importStillPending = Boolean(taskId && importAnalysis?.ready !== true);
  return {
    rows: readBackRows,
    endpointRows: readBackEndpointRows,
    errors,
    verification: importStillPending || !hasUsableReadBackRows(readBackRows, actionConfig)
      ? {
          ok: false,
          pending: true,
          reason: importStillPending ? 'product_import_task_pending' : 'info_readback_pending',
        }
      : verification,
    importTask: taskId
      ? { taskId, ...importAnalysis, attempts: delays.length }
      : null,
  };
}

async function finalizeProductWriteResult({
  actionConfig,
  repository,
  productImageAssetRepository,
  ozonScheduler,
  clearProductReadCache = () => undefined,
  shopId,
  endpointKey,
  action,
  payload,
  input,
  preview,
  writeResult,
  waitForReadBack,
  productInfoReadBackDelaysMs,
} = {}) {
  if (!writeResult?.ok) {
    const stockWriteAudit = buildStockWriteAudit({
      actionConfig,
      repository,
      shopId,
      payload,
      input,
      preview,
      writeResult,
      writeStatus: 'failed',
      readBackStatus: 'failed',
      readBackRows: [],
      merge: null,
    });
    return {
      ok: false,
      confirmed: true,
      writeConnected: true,
      writeStatus: 'write_failed',
      endpointKey,
      action,
        error: writeResult?.error || { code: 'PRODUCT_WRITE_FAILED', message: 'Product write failed; old product cache is kept.' },
      schedulerResult: writeResult || null,
      stockWriteAudit,
    };
  }

  const submittedRows = collectSubmittedStockRows({ payload, input, preview });
  const isRealProductInfoWrite =
    ['product.updateInfo', 'product.updateAttributes'].includes(action) &&
    writeResult.realWrite === true &&
    writeResult.dryRun !== true;
  // `/v3/product/import` only acknowledges an asynchronous import task. Its
  // `result` is never product truth and must not be treated as readback rows.
  let readBackRows = isRealProductInfoWrite
    ? []
    : resolveReadBackRows(writeResult, input, preview);
  let readBackEndpointRows =
    writeResult?.readBackEndpointRows ||
    writeResult?.data?.readBackEndpointRows ||
    null;
  let readBackErrors = [];
  let productInfoReadBack = null;
  if (isRealProductInfoWrite) {
    productInfoReadBack = await readBackProductInfoUntilVerified({
      ozonScheduler,
      shopId,
      actionConfig,
      payload,
      input,
      preview,
      writeResult,
      action,
      requestedBy: input.requestedBy || preview?.requestedBy || 'write-guard',
      idempotencyKey: writeResult.jobId || writeResult.id || input.idempotencyKey || preview?.idempotencyKey,
      waitForReadBack,
      readBackDelaysMs: productInfoReadBackDelaysMs,
    });
    readBackRows = productInfoReadBack.rows;
    readBackEndpointRows = productInfoReadBack.endpointRows || null;
    readBackErrors = productInfoReadBack.errors;
  }
  const needsWarehouseStockReadBack =
    actionConfig?.mergeTypes?.includes('stocks') &&
    !hasExactSubmittedWarehouseEvidence({
      submittedRows,
      readBackEndpointRows,
    });
  if (
    (!hasUsableReadBackRows(readBackRows, actionConfig) ||
      needsWarehouseStockReadBack) &&
    actionConfig?.mergeTypes?.includes('stocks') &&
    writeResult.realWrite === true &&
    writeResult.dryRun !== true
  ) {
    const readBack = await readBackStockRowsFromOzon({
      ozonScheduler,
      repository,
      shopId,
      submittedRows,
      requestedBy: input.requestedBy || preview?.requestedBy || 'write-guard',
      idempotencyKey: writeResult.jobId || writeResult.id || input.idempotencyKey || preview?.idempotencyKey,
    });
    if (readBack.rows.length) readBackRows = readBack.rows;
    readBackEndpointRows = readBack.endpointRows || null;
    readBackErrors = readBack.errors;
  }
  if (
    !isRealProductInfoWrite &&
    !hasUsableReadBackRows(readBackRows, actionConfig) &&
    !actionConfig?.mergeTypes?.includes('stocks') &&
    writeResult.realWrite === true &&
    writeResult.dryRun !== true
  ) {
    const writeAcknowledgements = normalizeRows(getSchedulerData(writeResult));
    const repositoryProductIds = resolveReadBackProductIdsFromRepository({
      repository,
      shopId,
      payload,
      input,
      preview,
    });
    const readBack = await readBackProductRowsFromOzon({
      ozonScheduler,
      shopId,
      actionConfig,
      payload,
      input,
      preview,
      additionalProductIds: [
        ...repositoryProductIds,
        ...writeAcknowledgements.map((row) => firstPresent(
          row?.product_id,
          row?.productId,
          row?.id,
        )),
      ],
      additionalOfferIds: writeAcknowledgements.map((row) => firstPresent(
        row?.offer_id,
        row?.offerId,
      )),
      requestedBy: input.requestedBy || preview?.requestedBy || 'write-guard',
      idempotencyKey: writeResult.jobId || writeResult.id || input.idempotencyKey || preview?.idempotencyKey,
    });
    if (readBack.rows.length) readBackRows = readBack.rows;
    readBackEndpointRows = readBack.endpointRows || null;
    readBackErrors = readBack.errors;
  }

  const suppliedWarehouseReadBack =
    readBackEndpointRows?.['products.stocksByWarehouseFbs'];
  if (
    suppliedWarehouseReadBack &&
    suppliedWarehouseReadBack.pagination?.explicitComplete !== true &&
    !readBackErrors.some(
      (item) => item.endpointKey === 'products.stocksByWarehouseFbs',
    )
  ) {
    readBackErrors.push({
      endpointKey: 'products.stocksByWarehouseFbs',
      code: 'PRODUCT_WAREHOUSE_STOCK_RESPONSE_INCOMPLETE',
      message: 'warehouse stock readback completion metadata missing',
    });
  }

  const warehouseReadBackError = readBackErrors.find(
    (item) => item.endpointKey === 'products.stocksByWarehouseFbs',
  );
  if (
    warehouseReadBackError &&
    repository?.recordProductWarehouseStockObservations
  ) {
    const errorCode = normalizeText(
      warehouseReadBackError.code || warehouseReadBackError.message,
    );
    repository.recordProductWarehouseStockObservations({
      shopId,
      productIds: [
        ...new Set(submittedRows.map((row) => row.product_id).filter(Boolean)),
      ],
      offerIds: [
        ...new Set(submittedRows.map((row) => row.offer_id).filter(Boolean)),
      ],
      status:
        errorCode.includes('CONTRACT') || errorCode.includes('INCOMPLETE')
          ? 'contract_invalid'
          : 'failed',
      sourceReason:
        warehouseReadBackError.message || 'product-stock-write-readback-failed',
      provenance: {
        contractVersion: 'ozon-products-stocks-by-warehouse-fbs-v2',
        mapperVersion: 'product-warehouse-stock-mapper-v1',
        operationId: normalizeText(writeResult.jobId || writeResult.id) || null,
      },
    });
  }

  const hasReadBack = hasUsableReadBackRows(readBackRows, actionConfig);
  const verification = productInfoReadBack?.verification || (
    hasReadBack
      ? verifyProductWriteReadBack({
          action,
          payload,
          input,
          preview,
          readBackRows,
          readBackEndpointRows,
        })
      : { ok: false, reason: readBackRows.length ? 'readback_unusable' : 'readback_empty' }
  );
  const hasEndpointReadBack = Boolean(
    readBackEndpointRows && Object.keys(readBackEndpointRows).length > 0,
  );
  const merge = hasReadBack || hasEndpointReadBack
    ? mergeReadBackRows({
        repository,
        shopId,
        rows: readBackRows,
        endpointRows: readBackEndpointRows,
        submittedRows,
        actionConfig,
      })
    : {
        changed: 0,
        unchanged: 0,
        missing: 0,
        rows: readBackRows.length,
        skipped: true,
        reason: readBackRows.length ? 'readback_missing_stock_evidence' : 'readback_empty',
      };
  clearProductReadCache(shopId);
  const finalWriteStatus = writeResult.dryRun
    ? 'dry_run_recorded'
    : verification.terminal
      ? 'write_failed_after_accept'
    : verification.ok
      ? 'readback_merged'
      : verification.pending
        ? 'submitted_waiting_readback'
        : hasReadBack
          ? 'readback_mismatch'
          : 'submitted_waiting_readback';
  const finalReadBackStatus = verification.ok
    ? 'merged'
    : verification.terminal
      ? 'failed'
    : verification.pending || !hasReadBack
      ? 'pending'
      : 'mismatch';
  const stockWriteAudit = buildStockWriteAudit({
    actionConfig,
    repository,
    shopId,
    payload,
    input,
    preview,
    writeResult,
    writeStatus: finalWriteStatus,
    readBackStatus: finalReadBackStatus,
    readBackRows,
    readBackErrors,
    merge,
  });
  let imagePublication = null;
  if (action === 'product.updateInfo' && verification.ok && !writeResult.dryRun && productImageAssetRepository) {
    const submitted = normalizeRows(payload.items || input?.payload?.items || preview?.payload?.items);
    const urls = [...new Set(submitted.flatMap((item) => collectTrackedImageUrls([
      item.images,
      item.primary_image,
      item.attributes,
      item.rich_content_json,
      item.richContentJson,
    ])))];
    const first = submitted[0] || {};
    imagePublication = productImageAssetRepository.markPublishedByUrls({
      shopId,
      urls,
      productId: first.product_id || first.productId || '',
      offerId: first.offer_id || first.offerId || '',
    });
  }
  return {
    ok: verification.terminal !== true,
    confirmed: true,
    writeConnected: true,
    writeStatus: finalWriteStatus,
    endpointKey,
    action,
    schedulerResult: {
      ok: true,
      jobId: writeResult.jobId || writeResult.id || null,
      status: writeResult.status || 'success',
      realWrite: writeResult.realWrite === true,
      dryRun: writeResult.dryRun !== false,
      data: writeResult.data || null,
    },
    readBack: {
      status: finalReadBackStatus,
      rows: readBackRows.length,
      merge,
      errors: readBackErrors,
      verification,
      importTask: productInfoReadBack?.importTask || null,
    },
    stockWriteAudit,
    imagePublication,
    error: verification.terminal
      ? {
          code: verification.code || 'PRODUCT_IMPORT_TASK_FAILED',
          message: verification.message || 'Ozon 商品导入任务失败。',
        }
      : undefined,
    message: writeResult.dryRun
      ? '商品写入已记录 dry-run，未写入 Ozon。'
      : verification.terminal
        ? verification.message || 'Ozon 商品导入任务失败。'
      : verification.ok
        ? '回读成功，SQLite 已合并，列表已按 Ozon 最新数据刷新。'
        : hasReadBack && !verification.pending
          ? '已回读并合并 SQLite，但回读值与提交值不一致，不能标记完成。'
          : '已提交 Ozon，等待回读确认。',
  };
}

export function listProductWriteActions() {
  return Object.entries(PRODUCT_WRITE_ACTIONS).map(([action, config]) => ({
    action,
    endpointKey: config.endpointKey,
    description: config.description,
  }));
}

export function createProductWriteService({
  repository,
  productImageAssetRepository = null,
  refreshProductImagePayloadUrls = async (payload) => payload,
  ozonScheduler,
  clearProductReadCache = () => undefined,
  waitForReadBack = waitForMilliseconds,
  productInfoReadBackDelaysMs = PRODUCT_INFO_READBACK_DELAYS_MS,
  waitForStockVisibility = waitForMilliseconds,
  productStockVisibilityRetryDelaysMs = PRODUCT_STOCK_VISIBILITY_RETRY_DELAYS_MS,
} = {}) {
  function validateFoundation() {
    if (!repository) {
      return { ok: false, error: { code: 'PRODUCT_WRITE_CACHE_NOT_CONNECTED', message: '商品写入回读需要先连接 ozon_products 缓存表。' } };
    }
    if (!ozonScheduler?.executeWrite) {
      return {
        ok: false,
        confirmed: true,
        writeConnected: false,
        error: {
          code: 'WRITE_EXECUTION_NOT_CONNECTED',
          message: '商品写入已通过预览/确认记录，但真实 Ozon 写入执行器未连接；本次没有提交 Ozon。',
        },
        writeQueue: {
          priority: 'WRITE',
          connected: false,
          requiredFlow: ['preview', 'confirm', 'write_queue', 'ozonClient.requestWrite', 'read_back', 'audit'],
        },
      };
    }
    return null;
  }

  async function retryNewProductStockVisibility({
    initialWriteResult,
    action,
    shopId,
    endpointKey,
    payload,
    idempotencyKey,
    requestedBy,
    previewId,
    realWrite,
  } = {}) {
    if (
      action !== 'product.updateStock' ||
      realWrite !== true ||
      initialWriteResult?.ok
    ) {
      return initialWriteResult;
    }

    let writeResult = initialWriteResult;
    let remainingOfferIds = collectRetryableStockVisibilityOfferIds(writeResult, payload);
    if (!remainingOfferIds.length) return writeResult;

    const delays = Array.isArray(productStockVisibilityRetryDelaysMs)
      ? productStockVisibilityRetryDelaysMs
      : PRODUCT_STOCK_VISIBILITY_RETRY_DELAYS_MS;
    let retryCount = 0;
    for (const delayMs of delays) {
      const retryPayload = narrowStockPayloadToOfferIds(payload, remainingOfferIds);
      if (!retryPayload) return writeResult;
      await waitForStockVisibility(delayMs);
      retryCount += 1;
      writeResult = await ozonScheduler.executeWrite({
        shopId,
        domain: 'products',
        endpointKey,
        action,
        priority: 'WRITE',
        params: retryPayload,
        idempotencyKey: `${idempotencyKey}:stock-visibility-retry:${retryCount}`,
        requestedBy,
        previewId,
        realWrite: true,
        dryRun: false,
        readBackRows: [],
        waitForResult: true,
        fastAck: false,
        asyncWrite: false,
      });
      if (writeResult?.ok) {
        return {
          ...writeResult,
          stockVisibilityRetry: {
            recovered: true,
            retryCount,
            retriedOfferCount: remainingOfferIds.length,
          },
        };
      }
      remainingOfferIds = collectRetryableStockVisibilityOfferIds(writeResult, retryPayload);
      if (!remainingOfferIds.length) return writeResult;
    }
    return {
      ...writeResult,
      stockVisibilityRetry: {
        recovered: false,
        retryCount,
        remainingOfferIds,
      },
      error: {
        ...(writeResult?.error || {}),
        code: 'OZON_NEW_PRODUCT_STOCK_NOT_READY',
        message: `Ozon 库存系统仍有 ${remainingOfferIds.length} 个商品未就绪或更新过频，已停止重复写入；请稍后仅重试库存步骤。`,
      },
    };
  }

  async function executeConfirmedWrite({ preview, input = {}, recordAsyncResult = null } = {}) {
    const foundationError = validateFoundation();
    if (foundationError) return foundationError;

    const action = normalizeText(input.action || preview?.action || preview?.diff?.action);
    const actionConfig = PRODUCT_WRITE_ACTIONS[action];
    if (!actionConfig) {
      return {
        ok: false,
        confirmed: true,
        writeConnected: false,
        error: { code: 'PRODUCT_WRITE_ACTION_NOT_REGISTERED', message: `商品写入动作尚未登记：${action || 'unknown'}` },
      };
    }

    const shopId = normalizeText(input.shopId || input.shop_id || preview?.shopId || preview?.diff?.shopId);
    if (!shopId) {
      return {
        ok: false,
        confirmed: true,
        writeConnected: false,
        error: { code: 'PRODUCT_WRITE_SHOP_ID_REQUIRED', message: '商品写入确认必须包含 shopId。' },
      };
    }

    const requestedEndpointKey = normalizeText(input.endpointKey || preview?.endpointKey || preview?.diff?.endpointKey);
    if (requestedEndpointKey && requestedEndpointKey !== actionConfig.endpointKey) {
      return {
        ok: false,
        confirmed: true,
        writeConnected: false,
        endpointKey: requestedEndpointKey,
        action,
        error: {
          code: 'PRODUCT_WRITE_ENDPOINT_MISMATCH',
          message: `商品写入动作 ${action} 只能走 ${actionConfig.endpointKey}，不能改写为 ${requestedEndpointKey}。`,
        },
      };
    }
    const endpointKey = requestedEndpointKey || actionConfig.endpointKey;
    const rawPayload = input.payload ?? preview?.payload ?? preview?.diff?.after ?? {};
    let preparedPayload = rawPayload;
  if (action === 'product.updateInfo') {
      try {
        preparedPayload = await refreshProductImagePayloadUrls(rawPayload, { shopId });
      } catch (error) {
        return {
          ok: false,
          confirmed: true,
          writeConnected: false,
          writeStatus: 'image_url_refresh_failed',
          endpointKey,
          action,
          error: {
            code: 'PRODUCT_IMAGE_SIGNING_REFRESH_FAILED',
            message: error?.message || '图片提交链接刷新失败，本次未写入 Ozon。',
          },
        };
      }
      // The current Ozon `/v3/product/import` contract uses `items`. Keep the
      // historical flat fake/readback harness compatible, but apply strict
      // fail-closed validation to every real import-item batch regardless of
      // collection source, category or link.
      if (Array.isArray(preparedPayload?.items)) {
        let existingProductModels = [];
        if (typeof repository.resolveProductModelNamesForOffers === 'function') {
          try {
            existingProductModels = await repository.resolveProductModelNamesForOffers({
              shopId,
              offerIds: preparedPayload.items.map((item) => firstPresent(item?.offer_id, item?.offerId)),
            });
          } catch {
            existingProductModels = [];
          }
        }
        const normalizedProductInfo = normalizeProductInfoPayload(preparedPayload, {
          shopId,
          existingProductModels,
        });
        if (!normalizedProductInfo.ok) {
          return {
            ok: false,
            confirmed: true,
            writeConnected: false,
            writeStatus: 'write_payload_invalid',
            endpointKey,
            action,
            error: normalizedProductInfo.error,
          };
        }
        preparedPayload = normalizedProductInfo.payload;
      }
    }
    const schedulerPayload = buildSchedulerPayload({ actionConfig, payload: preparedPayload });
    if (!schedulerPayload.ok) {
      return {
        ok: false,
        confirmed: true,
        writeConnected: false,
        writeStatus: 'write_payload_invalid',
        endpointKey,
        action,
        error: schedulerPayload.error,
      };
    }
    const payload = schedulerPayload.payload;
    const idempotencyKey = normalizeText(input.idempotencyKey || preview?.idempotencyKey) || `product-write:${shopId}:${action}:${preview?.previewId || Date.now()}`;
    const realWrite = input.realWrite === true && input.dryRun === false;
    if (input.resumeReadBackOnly === true) {
      const taskId = normalizeProductId(input.readBackTaskId ?? input.read_back_task_id);
      const taskResumeValid = ['product.updateInfo', 'product.updateAttributes'].includes(action) && taskId != null;
      const mutationResumeValid = [
        'product.updatePrice',
        'product.updateStock',
        'product.archive',
        'product.unarchive',
      ].includes(action);
      if (!taskResumeValid && !mutationResumeValid) {
        return {
          ok: false,
          confirmed: true,
          writeConnected: true,
          writeStatus: 'readback_resume_invalid',
          endpointKey,
          action,
          error: {
            code: 'PRODUCT_IMPORT_READBACK_RESUME_INVALID',
            message: '当前商品步骤缺少可继续的 Ozon 回读依据，本次没有重复提交写入。',
          },
        };
      }
      return finalizeProductWriteResult({
        actionConfig,
        repository,
        productImageAssetRepository,
        ozonScheduler,
        clearProductReadCache,
        shopId,
        endpointKey,
        action,
        payload,
        input,
        preview,
        writeResult: {
          ok: true,
          status: 'success',
          realWrite: true,
          dryRun: false,
          jobId: normalizeText(input.readBackJobId ?? input.read_back_job_id) || (
            taskResumeValid
              ? `product-import-readback:${shopId}:${taskId}`
              : `product-mutation-readback:${shopId}:${action}`
          ),
          data: taskResumeValid ? { result: { task_id: taskId } } : { result: [] },
        },
        waitForReadBack,
        productInfoReadBackDelaysMs,
      });
    }
    const fastAck = input.fastAck === true || input.asyncWrite === true || input.waitForResult === false;
    const inlineReadBackRows =
      input.readBackRows ||
      input.payload?.readBackRows ||
      input.after?.readBackRows ||
      preview?.payload?.readBackRows ||
      preview?.diff?.after?.readBackRows ||
      [];
    const requestedBy = input.requestedBy || preview?.requestedBy || 'write-guard';
    const onAsyncWriteSettled =
      fastAck && typeof recordAsyncResult === 'function'
        ? async (settledWriteResult) => {
            const finalWriteResult = await retryNewProductStockVisibility({
              initialWriteResult: settledWriteResult,
              action,
              shopId,
              endpointKey,
              payload,
              idempotencyKey,
              requestedBy,
              previewId: preview?.previewId || input.previewId,
              realWrite,
            });
            const finalResult = await finalizeProductWriteResult({
              actionConfig,
              repository,
              productImageAssetRepository,
              ozonScheduler,
              clearProductReadCache,
              shopId,
              endpointKey,
              action,
              payload,
              input,
              preview,
              writeResult: finalWriteResult,
              waitForReadBack,
              productInfoReadBackDelaysMs,
            });
            recordAsyncResult(finalResult);
          }
        : undefined;

    const initialWriteResult = await ozonScheduler.executeWrite({
      shopId,
      domain: 'products',
      endpointKey,
      action,
      priority: 'WRITE',
      params: payload,
      idempotencyKey,
      requestedBy,
      previewId: preview?.previewId || input.previewId,
      realWrite,
      dryRun: !realWrite,
      readBackRows: inlineReadBackRows,
      waitForResult: fastAck ? false : true,
      fastAck,
      asyncWrite: fastAck,
      onAsyncWriteSettled,
    });

    if (initialWriteResult?.accepted === true || initialWriteResult?.pending === true) {
      clearProductReadCache(shopId);
      const stockWriteAudit = buildStockWriteAudit({
        actionConfig,
        repository,
        shopId,
        payload,
        input,
        preview,
        writeResult: initialWriteResult,
        writeStatus: 'submitted_waiting_readback',
        readBackStatus: 'pending',
        readBackRows: [],
        merge: null,
      });
      return {
        ok: true,
        accepted: true,
        pending: true,
        confirmed: true,
        writeConnected: true,
        writeStatus: 'submitted_waiting_readback',
        endpointKey,
        action,
        schedulerResult: {
          ok: true,
          accepted: true,
          pending: true,
          jobId: initialWriteResult.jobId || initialWriteResult.id || null,
          status: initialWriteResult.status || 'accepted',
          realWrite: initialWriteResult.realWrite === true,
          dryRun: initialWriteResult.dryRun !== false,
          job: initialWriteResult.job || null,
        },
        readBack: { status: 'pending', rows: 0, merge: null },
        stockWriteAudit,
        message: '已提交 Ozon，等待回读确认。',
      };
    }

    const writeResult = await retryNewProductStockVisibility({
      initialWriteResult,
      action,
      shopId,
      endpointKey,
      payload,
      idempotencyKey,
      requestedBy,
      previewId: preview?.previewId || input.previewId,
      realWrite,
    });

    return finalizeProductWriteResult({
      actionConfig,
      repository,
      productImageAssetRepository,
      ozonScheduler,
      clearProductReadCache,
      shopId,
      endpointKey,
      action,
      payload,
      input,
      preview,
      writeResult,
      waitForReadBack,
      productInfoReadBackDelaysMs,
    });
  }

  return {
    listActions: listProductWriteActions,
    executeConfirmedWrite,
  };
}
