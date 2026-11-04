import { convertFeeAmountToCny, normalizeEstimatedCommissionPercent } from '../../services/feeCalculationService';
import { getAfterSalesProductLookupKeys } from './afterSalesProductRules.jsx';
import { formatOzonPrice } from '../product/productPriceRules.jsx';
import { firstFiniteNumber, toFiniteNumber } from '../product/productAttributes.jsx';
import { normalizeImageList, safeImageUrl } from '../product/productImageRules.jsx';
import { firstFilled, firstUsableOzonId, normalizeOzonId } from './orderIdentityRules.jsx';
import { getAfterSalesTone, normalizeAfterSalesStatus } from './afterSalesStatusRules.jsx';
import { getOzonOrderProductSalesAmount, getOzonProductRawSalesAmount } from './orderProductAmountRules.jsx';

export { getAfterSalesStatusByRules } from './orderAsyncRules.jsx';

export function getOzonOrderProducts(item = {}) {
  const sourceProducts = [
    ...(Array.isArray(item.products) ? item.products : []),
    ...(Array.isArray(item.product) ? item.product : []),
    ...(Array.isArray(item.items) ? item.items : []),
  ];
  const financialProducts = Array.isArray(item.financial_data?.products)
    ? item.financial_data.products
    : Array.isArray(item.financialData?.products)
      ? item.financialData.products
      : [];

  const baseProducts = sourceProducts.length ? sourceProducts : financialProducts;

  return baseProducts.map((product, index) => {
    const productOfferId = normalizeOzonId(firstFilled(product?.offer_id, product?.offerId));
    const productSkuId = normalizeOzonId(
      firstFilled(product?.sku, product?.sku_id, product?.skuId, product?.product_id)
    );
    const financialProduct = sourceProducts.length
      ? (financialProducts.find((itemProduct) => {
          const financialOfferId = normalizeOzonId(firstFilled(itemProduct?.offer_id, itemProduct?.offerId));
          const financialSkuId = normalizeOzonId(
            firstFilled(itemProduct?.sku, itemProduct?.sku_id, itemProduct?.skuId, itemProduct?.product_id)
          );
          return (
            (productOfferId && financialOfferId && productOfferId === financialOfferId) ||
            (productSkuId && financialSkuId && productSkuId === financialSkuId)
          );
        }) ??
        financialProducts[index] ??
        {})
      : product;
    const financialOfferId = normalizeOzonId(firstFilled(financialProduct?.offer_id, financialProduct?.offerId));
    const financialSkuId = normalizeOzonId(
      firstFilled(
        financialProduct?.sku,
        financialProduct?.sku_id,
        financialProduct?.skuId,
        financialProduct?.product_id
      )
    );
    const offerId = productOfferId || financialOfferId;
    const skuId = productSkuId || financialSkuId;
    const productId = firstUsableOzonId(
      product?.product_id,
      product?.productId,
      financialProduct?.product_id,
      financialProduct?.productId
    );
    const currencyCode =
      product?.currency_code ||
      product?.currency ||
      product?.price?.currency_code ||
      financialProduct?.currency_code ||
      financialProduct?.currency ||
      item?.currency_code ||
      item?.currency ||
      'RUB';
    const priceValue = firstFilled(
      financialProduct?.price?.price,
      financialProduct?.price,
      financialProduct?.offer_price,
      financialProduct?.offerPrice,
      financialProduct?.item_price,
      financialProduct?.itemPrice,
      product?.price?.price,
      product?.price,
      product?.offer_price,
      product?.offerPrice,
      product?.item_price,
      product?.itemPrice,
      product?.amount,
      product?.total_price
    );
    const commissionPercent = normalizeEstimatedCommissionPercent(
      firstFilled(
        product?.commission_percent,
        product?.commissionPercent,
        product?.fbs_commission_percent,
        product?.fbo_commission_percent,
        financialProduct?.commission_percent,
        financialProduct?.commissionPercent,
        item.financial_data?.commission_percent,
        item.financialData?.commissionPercent
      )
    );
    const commissionAmountValue = toFiniteNumber(
      firstFilled(
        product?.commission_amount,
        product?.commissionAmount,
        product?.commission,
        financialProduct?.commission_amount,
        financialProduct?.commissionAmount,
        financialProduct?.commission,
        financialProduct?.seller_commission
      )
    );
    const purchasePriceValue = firstFilled(
      product?.purchase_price,
      product?.purchasePrice,
      product?.cost_price,
      product?.costPrice,
      product?.source_price,
      product?.sourcePrice
    );
    const productImages = normalizeImageList([
      product?.sku_image,
      product?.skuImage,
      product?.primary_image,
      product?.primaryImage,
      product?.main_image,
      product?.mainImage,
      product?.image,
      product?.image_url,
      product?.imageUrl,
      product?.picture,
      product?.picture_url,
      product?.pictureUrl,
      ...(Array.isArray(product?.images) ? product.images : []),
      ...(Array.isArray(product?.pictures) ? product.pictures : []),
      financialProduct?.sku_image,
      financialProduct?.skuImage,
      financialProduct?.primary_image,
      financialProduct?.primaryImage,
      financialProduct?.main_image,
      financialProduct?.mainImage,
      financialProduct?.image,
      financialProduct?.image_url,
      financialProduct?.imageUrl,
      ...(Array.isArray(financialProduct?.images) ? financialProduct.images : []),
    ]);
    return {
      name:
        firstFilled(
          product?.name_cn,
          product?.cn_name,
          product?.chinese_name,
          product?.title_cn,
          product?.name,
          product?.product_name,
          product?.offer_name,
          financialProduct?.name,
          financialProduct?.product_name,
          financialProduct?.offer_name,
          product?.sku,
          product?.offer_id
        ) || `商品 ${index + 1}`,
      sku: offerId || skuId || '未返回',
      productId: productId || '未返回',
      productIdSource: productId ? 'orderRaw' : '',
      offerId: offerId || '未返回',
      skuId: skuId || '未返回',
      qty:
        toFiniteNumber(
          firstFilled(
            product?.quantity,
            product?.qty,
            product?.count,
            financialProduct?.quantity,
            financialProduct?.qty,
            financialProduct?.count
          )
        ) ?? 1,
      price: formatOzonPrice(priceValue, currencyCode) === '-' ? '未返回' : formatOzonPrice(priceValue, currencyCode),
      priceValue: toFiniteNumber(priceValue),
      currencyCode,
      commissionPercent,
      commissionPercentText: commissionPercent === null ? '未返回' : `${commissionPercent}%`,
      commissionAmountValue,
      commissionAmount:
        commissionAmountValue === null ? '未返回' : formatOzonPrice(commissionAmountValue, currencyCode),
      image: productImages[0] || '',
      images: productImages,
      skuImage: productImages[0] || '',
      skuImages: productImages,
      mainImage:
        firstFilled(product?.primary_image, product?.primaryImage, product?.main_image, product?.mainImage) || '',
      mainImages: normalizeImageList([
        product?.primary_image,
        product?.primaryImage,
        product?.main_image,
        product?.mainImage,
      ]),
      sourceTitle:
        firstFilled(product?.source_title, product?.sourceTitle, product?.purchase_title, product?.purchaseTitle) || '',
      sourceProductId:
        normalizeOzonId(
          firstFilled(
            product?.source_product_id,
            product?.sourceProductId,
            product?.purchase_product_id,
            product?.purchaseProductId
          )
        ) || '',
      purchasePrice: purchasePriceValue === '' ? '未返回' : formatOzonPrice(purchasePriceValue, currencyCode),
      purchasePriceValue: toFiniteNumber(purchasePriceValue),
      raw: product,
      financialRaw: financialProduct,
    };
  });
}

export function hasUsefulOzonOrderProductInfo(product = {}) {
  const raw = product?.raw ?? {};
  return Boolean(
    safeImageUrl(product.image || product.images?.[0] || product.skuImage || product.mainImage) ||
    firstUsableOzonId(
      product.offerId,
      product.skuId,
      product.productId,
      raw.offer_id,
      raw.offerId,
      raw.sku,
      raw.sku_id,
      raw.skuId,
      raw.product_id,
      raw.productId
    )
  );
}

export function getOzonAfterSalesProducts(item = {}) {
  const directProducts = getOzonOrderProducts(item);
  if (directProducts.length) return directProducts;

  const nestedProductSources = [
    item.product,
    item.return_product,
    item.returnProduct,
    item.return_item,
    item.returnItem,
    item.item,
    item.product_info,
    item.productInfo,
    item.product_details,
    item.productDetails,
    item.returns?.product,
    item.returns?.products,
    item.returns?.items,
    item.returns?.return_product,
    item.returns?.returnProduct,
    item.listItem?.product,
    item.listItem?.products,
    item.listItem?.item,
    item.detail?.product,
    item.detail?.products,
    item.detail?.items,
    item.detail?.return_product,
    item.detail?.returnProduct,
    item.detail?.returns?.product,
    item.detail?.returns?.products,
    item.detail?.returns?.items,
  ];
  const nestedProducts = nestedProductSources.flatMap((value) => {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return [value];
    return [];
  });

  return nestedProducts.length ? getOzonOrderProducts({ ...item, products: nestedProducts }) : [];
}

export function getOzonAfterSalesQuantityValue(source = {}) {
  const value = firstFilled(
    source.return_quantity,
    source.returnQuantity,
    source.returned_quantity,
    source.returnedQuantity,
    source.refund_quantity,
    source.refundQuantity,
    source.cancel_quantity,
    source.cancelQuantity,
    source.canceled_quantity,
    source.canceledQuantity,
    source.returned_count,
    source.returnedCount,
    source.return_count,
    source.returnCount,
    source.returned_items_count,
    source.returnedItemsCount,
    source.return?.quantity,
    source.return?.qty,
    source.return?.count
  );
  const quantity = toFiniteNumber(value);
  return quantity !== null && quantity > 0 ? quantity : null;
}

export function getOzonAfterSalesRootQuantityValue(item = {}) {
  const directQuantity = getOzonAfterSalesQuantityValue(item);
  if (directQuantity !== null) return directQuantity;

  const value = firstFilled(
    item.quantity,
    item.qty,
    item.count,
    item.listItem?.quantity,
    item.listItem?.qty,
    item.listItem?.count,
    item.detail?.quantity,
    item.detail?.qty,
    item.detail?.count
  );
  const quantity = toFiniteNumber(value);
  return quantity !== null && quantity > 0 ? quantity : null;
}

export function normalizeOzonAfterSalesProductQuantities(products = [], item = {}) {
  const rootQuantity = products.length <= 1 ? getOzonAfterSalesRootQuantityValue(item) : null;
  return products.map((product) => {
    const productQuantity =
      getOzonAfterSalesQuantityValue(product) ??
      getOzonAfterSalesQuantityValue(product.raw) ??
      rootQuantity ??
      toFiniteNumber(product.qty) ??
      1;
    return {
      ...product,
      qty: productQuantity,
    };
  });
}

export function getOzonOrderAmount(item = {}, products = []) {
  const currencyCode =
    item.currency_code ||
    item.currency ||
    products.find((product) => product.currencyCode)?.currencyCode ||
    item.financial_data?.currency_code ||
    'RUB';
  const productAmounts = products.map((product) => getOzonOrderProductSalesAmount(product));
  const availableProductAmounts = productAmounts.filter((amount) => amount !== null);
  if (availableProductAmounts.length) {
    const productTotal = availableProductAmounts.reduce((sum, amount) => sum + amount, 0);
    return formatOzonPrice(productTotal, currencyCode);
  }

  const directValue = firstFilled(
    item.total_price,
    item.totalPrice,
    item.order_price,
    item.orderPrice,
    item.sum_price,
    item.sumPrice,
    item.total_amount,
    item.totalAmount,
    item.order_amount,
    item.orderAmount
  );
  const directNumber = toFiniteNumber(directValue);
  return directNumber !== null ? formatOzonPrice(directNumber, currencyCode) : '未返回';
}

export function getOzonOrderCurrencyCode(item = {}, products = []) {
  return (
    item.currency_code ||
    item.currency ||
    products.find((product) => product.currencyCode)?.currencyCode ||
    item.financial_data?.currency_code ||
    'RUB'
  );
}

export function formatOzonAmountAsCny(value, currencyCode, fallback = '未返回', options = {}) {
  const amountCny = convertFeeAmountToCny(value, currencyCode, { rubToCnyRate: options.rubToCnyRate });
  return amountCny === null ? fallback : formatOzonPrice(amountCny, 'CNY');
}

export function inferOzonDisplayCurrencyCode(value, fallback = '') {
  const text = String(value ?? '')
    .trim()
    .toUpperCase();
  if (!text) return fallback;
  if (text.includes('¥') || text.includes('￥') || text.includes('CNY') || text.includes('RMB')) return 'CNY';
  if (text.includes('RUB') || text.includes('RUR') || text.includes('₽')) return 'RUB';
  return fallback;
}

export function normalizeOzonAfterSalesProductCurrency(product = {}, options = {}) {
  const raw = product.raw && typeof product.raw === 'object' ? product.raw : {};
  const sourceCurrencyCode =
    product.currencyCode || raw.currency_code || raw.currency || inferOzonDisplayCurrencyCode(product.price, 'RUB');
  const priceValue = toFiniteNumber(firstFilled(product.priceValue, product.price, raw.price));
  const priceValueCny = convertFeeAmountToCny(priceValue, sourceCurrencyCode, {
    rubToCnyRate: options.rubToCnyRate,
  });
  if (priceValueCny === null) return product;

  const normalizedSourceCurrencyCode = String(sourceCurrencyCode || '')
    .trim()
    .toUpperCase();
  const afterSalesAmountSource =
    product.afterSalesAmountSource ||
    (Object.keys(raw).length
      ? normalizedSourceCurrencyCode === 'RUB' || normalizedSourceCurrencyCode === 'RUR'
        ? 'ozon-return-rub'
        : normalizedSourceCurrencyCode === 'CNY' || normalizedSourceCurrencyCode === 'RMB'
          ? 'ozon-return-cny'
          : ''
      : '');

  return {
    ...product,
    sourceCurrencyCode,
    sourcePriceValue: priceValue,
    afterSalesAmountSource,
    currencyCode: 'CNY',
    priceValue: priceValueCny,
    price: formatOzonPrice(priceValueCny, 'CNY'),
  };
}

export function getOzonAfterSalesProductSourceCurrencyCode(product = {}) {
  const raw = product.raw && typeof product.raw === 'object' ? product.raw : {};
  return String(
    firstFilled(product.sourceCurrencyCode, raw.currency_code, raw.currency, product.currencyCode) || ''
  ).toUpperCase();
}

export function getOzonAfterSalesProductQualityScore(product = {}) {
  const sourceCurrencyCode = getOzonAfterSalesProductSourceCurrencyCode(product);
  const sourceScore =
    sourceCurrencyCode === 'CNY' || sourceCurrencyCode === 'RMB'
      ? 100
      : sourceCurrencyCode === 'RUB' || sourceCurrencyCode === 'RUR'
        ? 10
        : 40;
  const priceScore = toFiniteNumber(firstFilled(product.priceValue, product.price)) === null ? 0 : 5;
  const imageScore = firstFilled(product.image, product.skuImage, product.mainImage, product.images?.[0]) ? 1 : 0;
  return sourceScore + priceScore + imageScore;
}

export function dedupeOzonAfterSalesProductsBySource(products = []) {
  if (!Array.isArray(products) || products.length < 2) return Array.isArray(products) ? products : [];
  const rows = [];
  const indexByKey = new Map();

  products.forEach((product, index) => {
    const lookupKey = getAfterSalesProductLookupKeys(product)[0];
    if (!lookupKey) {
      rows.push(product);
      return;
    }

    const currentIndex = indexByKey.get(lookupKey);
    if (currentIndex === undefined) {
      indexByKey.set(lookupKey, rows.length);
      rows.push(product);
      return;
    }

    const current = rows[currentIndex];
    if (getOzonAfterSalesProductQualityScore(product) > getOzonAfterSalesProductQualityScore(current)) {
      rows[currentIndex] = product;
    }
  });

  return rows;
}

export function getOzonAfterSalesProductCnyAmounts(products = [], { onlyDirectCnySource = false } = {}) {
  return products
    .map((product) => {
      if (product.currencyCode !== 'CNY') return null;
      const sourceCurrencyCode = getOzonAfterSalesProductSourceCurrencyCode(product);
      if (onlyDirectCnySource && sourceCurrencyCode !== 'CNY' && sourceCurrencyCode !== 'RMB') {
        return null;
      }
      const priceValue = toFiniteNumber(product.priceValue);
      const qty = toFiniteNumber(product.qty) ?? 1;
      return priceValue === null ? null : priceValue * qty;
    })
    .filter((amount) => amount !== null);
}

export function getOzonAfterSalesDirectAmountValue(item = {}) {
  const refund = item.refund ?? item.refund_data ?? item.refundData ?? item.compensation ?? {};
  return firstFilled(
    item.refund_amount,
    item.refundAmount,
    item.refund_sum,
    item.refundSum,
    item.refund_price,
    item.refundPrice,
    item.return_amount,
    item.returnAmount,
    item.return_sum,
    item.returnSum,
    item.compensation_amount,
    item.compensationAmount,
    item.total_refund_amount,
    item.totalRefundAmount,
    refund.amount,
    refund.total_amount,
    refund.totalAmount,
    refund.sum,
    refund.price,
    item.amount,
    item.total_price,
    item.totalPrice,
    item.order_price,
    item.orderPrice,
    item.sum_price,
    item.sumPrice,
    item.total_amount,
    item.totalAmount,
    item.order_amount,
    item.orderAmount
  );
}

export function getOzonAfterSalesDirectAmountCurrencyCode(item = {}, directValue = null) {
  const refund = item.refund ?? item.refund_data ?? item.refundData ?? item.compensation ?? {};
  return firstFilled(
    item.refund_currency_code,
    item.refundCurrencyCode,
    item.refund_currency,
    item.refundCurrency,
    item.return_currency_code,
    item.returnCurrencyCode,
    item.return_currency,
    item.returnCurrency,
    refund.currency_code,
    refund.currencyCode,
    refund.currency,
    item.currency_code,
    item.currency,
    item.financial_data?.currency_code,
    inferOzonDisplayCurrencyCode(directValue, 'RUB')
  );
}

export function getOzonAfterSalesAmountCnyDisplay(item = {}, products = []) {
  const directCnyProductAmounts = getOzonAfterSalesProductCnyAmounts(products, { onlyDirectCnySource: true });
  if (directCnyProductAmounts.length) {
    return formatOzonPrice(
      directCnyProductAmounts.reduce((sum, amount) => sum + amount, 0),
      'CNY'
    );
  }

  const directValue = getOzonAfterSalesDirectAmountValue(item);
  const directNumber = toFiniteNumber(directValue);
  if (directNumber !== null) {
    const currencyCode = getOzonAfterSalesDirectAmountCurrencyCode(item, directValue);
    return formatOzonAmountAsCny(directNumber, currencyCode);
  }

  const availableProductAmounts = getOzonAfterSalesProductCnyAmounts(products);
  if (availableProductAmounts.length) {
    return formatOzonPrice(
      availableProductAmounts.reduce((sum, amount) => sum + amount, 0),
      'CNY'
    );
  }
  return '未返回';
}

export function normalizeAfterSalesAmountCurrencyForDisplay(row = {}) {
  const safeRow = row && typeof row === 'object' ? row : {};
  const products = Array.isArray(safeRow.products)
    ? dedupeOzonAfterSalesProductsBySource(
        safeRow.products.filter((product) => product && typeof product === 'object').map(normalizeOzonAfterSalesProductCurrency)
      )
    : safeRow.products;
  const normalizedStatus = normalizeAfterSalesStatus(safeRow.status);
  const normalizedType = normalizeAfterSalesStatus(safeRow.type || normalizedStatus);
  const displayCurrencyCode = inferOzonDisplayCurrencyCode(
    safeRow.refundAmount || safeRow.amount,
    safeRow.currencyCode || safeRow.sourceCurrencyCode || 'RUB'
  );
  const sourceRow =
    safeRow.raw && typeof safeRow.raw === 'object'
      ? {
          ...safeRow.raw,
          currency_code:
            safeRow.raw.currency_code || safeRow.raw.currency || safeRow.sourceCurrencyCode || displayCurrencyCode,
        }
      : {
          ...safeRow,
          currency_code: displayCurrencyCode,
          refund_amount:
            safeRow.refundAmountValue ?? safeRow.amountValue ?? safeRow.refundAmount ?? safeRow.amount,
        };
  const refundAmount = getOzonAfterSalesAmountCnyDisplay(sourceRow, products || []);
  return {
    ...safeRow,
    products,
    type: normalizedType,
    status: normalizedStatus,
    tone: getAfterSalesTone(normalizedStatus),
    amount: refundAmount,
    amountValue: toFiniteNumber(refundAmount),
    refundAmount,
    refundAmountValue: toFiniteNumber(refundAmount),
    currencyCode: 'CNY',
    sourceCurrencyCode: displayCurrencyCode,
  };
}

export { getOzonProductRawSalesAmount };
