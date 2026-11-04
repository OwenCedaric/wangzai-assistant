import { getOzonShopClientId, normalizeOzonId } from '../entities/order/orderIdentityRules.jsx';
import { getOzonLocalProductPrimaryShopKey, getOzonLocalUniqueValues } from '../entities/product/productLocalData.jsx';
import {
  getAttributeList,
  getOzonAcquiringFee,
  getOzonCategoryName,
  getOzonCommissionAmount,
  getOzonCurrency,
  getOzonImages,
  getOzonMileageFeeCny,
  getOzonOldPriceValue,
  getOzonPriceValue,
  getOzonRealFbsCommissionPercent,
} from '../entities/product/productAttributes.jsx';
import {
  getEstimatedProfit,
  getOzonDimensionValue,
  getOzonProductStock,
  getOzonWarehouseId,
} from '../entities/product/productWriteHelpers.jsx';
import {
  formatOzonPrice,
  getWarehouseProductWarehouseIds,
  resolveOzonProductStatus,
} from '../entities/product/productOzonApi.jsx';
import { resolveDailyCommissionRateSnapshot } from './commissionRateSnapshot';
import {
  calculateOrderPreDeductionFeeCny,
  convertFeeAmountToCny,
  normalizeRubToCnyRate,
  OZON_MILEAGE_FEE_RUB,
} from './feeCalculationService';
import { OZON_RFBS_COMMISSION_RATE_SOURCE } from '../shared/config/appConfigCore.jsx';
import { productStatusToneMap } from '../shared/ozon/ozonRuntime.jsx';

export function getProductRowCacheKey(row) {
  const key = row?.productId ?? row?.raw?.listItem?.product_id ?? row?.offerId ?? row?.sku;
  return key === undefined || key === null || key === '' ? '' : String(key);
}

export function mergeProductRows(currentRows, nextRows) {
  if (!Array.isArray(nextRows) || nextRows.length === 0) return currentRows;
  const nextRowMap = new Map(nextRows.map((row) => [getProductRowCacheKey(row), row]).filter(([key]) => key));
  if (nextRowMap.size === 0) return currentRows;
  return currentRows.map((row) => {
    const nextRow = nextRowMap.get(getProductRowCacheKey(row));
    if (!nextRow) return row;
    if (nextRow.status === '未知状态' && row.status && row.status !== '未知状态') {
      return {
        ...nextRow,
        status: row.status,
        tone: productStatusToneMap[row.status] || nextRow.tone || 'default',
      };
    }
    return nextRow;
  });
}

let productFeeRubToCnyRateMemory = null;

export function setProductFeeRubToCnyRate(rubToCnyRate) {
  productFeeRubToCnyRateMemory = normalizeRubToCnyRate(rubToCnyRate);
  return productFeeRubToCnyRateMemory;
}

export function getProductFeeRubToCnyRate(rubToCnyRate = null) {
  return normalizeRubToCnyRate(rubToCnyRate) ?? productFeeRubToCnyRateMemory;
}

function buildOzonProductFeeFields({
  priceValue,
  currencyCode,
  commissionPercent,
  commissionAmountValue,
  acquiringFeeValue,
  rubToCnyRate,
} = {}) {
  const normalizedRubToCnyRate = getProductFeeRubToCnyRate(rubToCnyRate);
  const mileageFeeValue = getOzonMileageFeeCny(normalizedRubToCnyRate);
  const commissionAmountValueCny = convertFeeAmountToCny(commissionAmountValue, currencyCode, {
    rubToCnyRate: normalizedRubToCnyRate,
  });
  const acquiringFeeValueCny = convertFeeAmountToCny(acquiringFeeValue, currencyCode, {
    rubToCnyRate: normalizedRubToCnyRate,
  });
  const feeTotalValue = calculateOrderPreDeductionFeeCny({
    commissionFeeCny: commissionAmountValueCny,
    acquiringFeeCny: acquiringFeeValueCny,
    deliveryServiceFeeCny: mileageFeeValue,
    crossBorderBusFeeCny: 0,
  });

  return {
    rubToCnyRate: normalizedRubToCnyRate,
    mileageFeeValue,
    mileageFee: mileageFeeValue === null ? '待确认' : formatOzonPrice(mileageFeeValue, 'CNY'),
    mileageFeeSource: `${OZON_MILEAGE_FEE_RUB} RUB`,
    feeTotalValue,
    feeTotal: feeTotalValue === null ? '待确认' : formatOzonPrice(feeTotalValue, 'CNY'),
    estimatedProfit: getEstimatedProfit(priceValue, commissionPercent, currencyCode, undefined, undefined, {
      rubToCnyRate: normalizedRubToCnyRate,
    }),
  };
}

export function applyProductFeeExchangeRateToRows(rows = [], rubToCnyRate = null) {
  const normalizedRubToCnyRate = setProductFeeRubToCnyRate(rubToCnyRate);
  if (!normalizedRubToCnyRate || !Array.isArray(rows) || rows.length === 0) return rows;
  return rows.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const feeFields = buildOzonProductFeeFields({
      priceValue: row.priceValue,
      currencyCode: row.currencyCode,
      commissionPercent: row.commissionPercent,
      commissionAmountValue: row.commissionAmountValue,
      acquiringFeeValue: row.acquiringFeeValue,
      rubToCnyRate: normalizedRubToCnyRate,
    });
    return {
      ...row,
      ...feeFields,
    };
  });
}

export function normalizeOzonProductRow(
  listItem,
  detail,
  attributes,
  pictures,
  priceInfo,
  stockInfo,
  shop,
  requestStatusLabel = '',
  statusByProductId = new Map(),
  options
) {
  const normalizeOptions = options && typeof options === 'object' ? options : {};
  const safeShop = shop && typeof shop === 'object' ? shop : {};
  const shopLabel = safeShop.shopAlias || safeShop.sellerName || safeShop.name || 'Ozon 店铺';
  const shopClientId = getOzonShopClientId(safeShop);
  const localShopKey = getOzonLocalProductPrimaryShopKey(safeShop);
  const productId = listItem.product_id ?? detail?.id;
  const offerId = detail?.offer_id || attributes?.offer_id || listItem.offer_id || '';
  const ozonSku = normalizeOzonId(detail?.sku ?? attributes?.sku ?? listItem.sku);
  const status = resolveOzonProductStatus(listItem, detail, requestStatusLabel, statusByProductId, productId);
  const stock = getOzonProductStock(detail, stockInfo);
  const warehouseIds = getWarehouseProductWarehouseIds(stockInfo);
  const priceValue = getOzonPriceValue(detail, priceInfo);
  const oldPriceValue = getOzonOldPriceValue(detail, priceInfo);
  const currencyCode = getOzonCurrency(detail, priceInfo);
  const commissionPercent = getOzonRealFbsCommissionPercent(priceInfo);
  const commissionStatus =
    priceInfo?.commission_status ||
    priceInfo?.commissionStatus ||
    (commissionPercent === null ? 'pending' : 'returned');
  const commissionProvenance = priceInfo?.commission_provenance || priceInfo?.commissionProvenance || null;
  const commissionRateSnapshot = resolveDailyCommissionRateSnapshot(
    {},
    {
      fallbackRate: commissionPercent,
      readAt: new Date(),
      mode: 'rFBS',
      source: OZON_RFBS_COMMISSION_RATE_SOURCE,
    }
  );
  const commissionAmountValue = getOzonCommissionAmount(detail, priceInfo, commissionPercent);
  const acquiringFeeValue = getOzonAcquiringFee(priceInfo);
  const acquiringStatus =
    priceInfo?.acquiring_status || priceInfo?.acquiringStatus || (acquiringFeeValue === null ? 'pending' : 'returned');
  const acquiringProvenance = priceInfo?.acquiring_provenance || priceInfo?.acquiringProvenance || null;
  const feeFields = buildOzonProductFeeFields({
    priceValue,
    currencyCode,
    commissionPercent,
    commissionAmountValue,
    acquiringFeeValue,
    rubToCnyRate: normalizeOptions.rubToCnyRate,
  });
  const images = getOzonImages(detail, attributes, pictures);
  const sourceWeightUnit =
    detail?.weight_unit ??
    detail?.weightUnit ??
    attributes?.weight_unit ??
    attributes?.weightUnit ??
    detail?.dimensions?.weight_unit ??
    attributes?.dimensions?.weight_unit ??
    'g';
  const sourceDimensionUnit =
    detail?.dimension_unit ??
    detail?.dimensionUnit ??
    attributes?.dimension_unit ??
    attributes?.dimensionUnit ??
    detail?.dimensions?.dimension_unit ??
    attributes?.dimensions?.dimension_unit ??
    'mm';

  return {
    productId,
    offerId,
    sku: offerId || '-',
    ozonSku,
    name:
      detail?.name ||
      attributes?.name ||
      listItem.name ||
      listItem.title ||
      listItem.offer_id ||
      `Ozon 商品 ${productId}`,
    category: getOzonCategoryName(detail, attributes, listItem),
    descriptionCategoryId:
      detail?.description_category_id ?? attributes?.description_category_id ?? listItem.description_category_id ?? '',
    typeId: detail?.type_id ?? attributes?.type_id ?? '',
    shop: shopLabel,
    shopName: shopLabel,
    storeName: shopLabel,
    shopId: safeShop.id || localShopKey,
    shopClientId: shopClientId || localShopKey,
    clientId: shopClientId || '',
    localShopKey,
    price: formatOzonPrice(priceValue, currencyCode),
    priceValue,
    oldPriceValue,
    currencyCode,
    stock,
    stockValue: stock,
    commissionPercent,
    commissionStatus,
    commissionProvenance,
    commissionText:
      commissionPercent === null
        ? ['unavailable', 'not_returned', 'contract_invalid'].includes(commissionStatus)
          ? 'Ozon 未返回'
          : '待确认'
        : commissionStatus === 'stale_previous'
          ? `${commissionPercent}%（上次）`
          : `${commissionPercent}%`,
    commissionRateMode: commissionRateSnapshot.mode || 'rFBS',
    commissionRateDate: commissionRateSnapshot.dateKey,
    commissionRateReadAt: commissionRateSnapshot.readAt,
    commissionRateSource: commissionRateSnapshot.source || OZON_RFBS_COMMISSION_RATE_SOURCE,
    commissionPercentDailyRates: commissionRateSnapshot.history,
    commissionAmountValue,
    commissionAmount: commissionAmountValue === null ? '待确认' : formatOzonPrice(commissionAmountValue, currencyCode),
    acquiringFeeValue,
    acquiringStatus,
    acquiringProvenance,
    acquiringFee:
      acquiringFeeValue === null
        ? ['unavailable', 'not_returned', 'contract_invalid'].includes(acquiringStatus)
          ? 'Ozon 未返回'
          : '待确认'
        : formatOzonPrice(acquiringFeeValue, currencyCode),
    ...feeFields,
    weight: getOzonDimensionValue(detail, attributes, ['weight', '重量', 'вес'], 'weight', sourceWeightUnit),
    length: getOzonDimensionValue(
      detail,
      attributes,
      ['depth', 'length', '长', 'длина'],
      'dimension',
      sourceDimensionUnit
    ),
    width: getOzonDimensionValue(detail, attributes, ['width', '宽', 'ширина'], 'dimension', sourceDimensionUnit),
    height: getOzonDimensionValue(detail, attributes, ['height', '高', 'высота'], 'dimension', sourceDimensionUnit),
    weightUnit: 'kg',
    dimensionUnit: 'cm',
    sourceWeightUnit,
    sourceDimensionUnit,
    warehouseId: warehouseIds[0] || getOzonWarehouseId(stockInfo),
    warehouseIds,
    vat: detail?.vat ?? attributes?.vat ?? '',
    minPrice: priceInfo?.price?.min_price ?? priceInfo?.min_price ?? '',
    status,
    tone: productStatusToneMap[status] || 'default',
    productSnapshotVisibility: listItem?.productSnapshotVisibility || '',
    productSnapshotVisibilities: getOzonLocalUniqueValues([
      listItem?.productSnapshotVisibility,
      ...(Array.isArray(listItem?.productSnapshotVisibilities) ? listItem.productSnapshotVisibilities : []),
      ...(Array.isArray(listItem?.snapshotVisibilities) ? listItem.snapshotVisibilities : []),
    ]),
    image: images[0] || '',
    images,
    attributes: getAttributeList(attributes),
    raw: { listItem, detail, attributes, pictures, priceInfo, stockInfo },
  };
}
