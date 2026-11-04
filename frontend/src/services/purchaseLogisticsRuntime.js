import { firstFilled } from '../entities/order/orderIdentityRules.jsx';
import { getCrossBorderPayloadObject } from '../entities/order/orderSourceLinkFields.jsx';
import {
  firstFiniteNumber,
  normalizeMaterialDimensionCm,
  normalizeMaterialWeightKg,
} from '../entities/product/productAttributes.jsx';
import { normalizeProductBusMatchValue } from './productBusMaterialService';
import { calculateLogisticsFreight } from './logisticsPricingService.js';
import {
  readSavedLogisticsPricingSettings,
} from './logisticsPricingSettingsRuntime.js';
import {
  resolveLogisticsPricingSelection,
} from './logisticsPricingSettingsStore.js';

export function normalizePurchaseOrderVolumeItem(item = {}) {
  const dimensionUnit =
    firstFilled(item.dimension_unit, item.dimensionUnit, item.size_unit, item.sizeUnit, item.unit) || 'cm';
  const weightUnit =
    firstFilled(item.weight_unit, item.weightUnit, item.gross_weight_unit, item.grossWeightUnit) || 'kg';
  const length = normalizeMaterialDimensionCm(
    firstFilled(item.length, item.long, item.l, item.lengthCm, item.length_cm),
    dimensionUnit
  );
  const width = normalizeMaterialDimensionCm(
    firstFilled(item.width, item.w, item.widthCm, item.width_cm),
    dimensionUnit
  );
  const height = normalizeMaterialDimensionCm(
    firstFilled(item.height, item.h, item.heightCm, item.height_cm),
    dimensionUnit
  );
  const grossWeight = normalizeMaterialWeightKg(
    firstFilled(item.gross_weight, item.grossWeight, item.weight, item.weightKg, item.weight_kg),
    weightUnit
  );
  if (!length && !width && !height && !grossWeight) return null;
  return {
    length,
    width,
    height,
    grossWeight,
    sizeText: length && width && height ? `${length} x ${width} x ${height} cm` : '',
    weightText: grossWeight ? `${grossWeight} kg` : '',
  };
}

export function getPurchaseOrderVolumeItems(outPayload = {}) {
  const outInfo = getCrossBorderPayloadObject(outPayload);
  const volumes = Array.isArray(outInfo.volume) ? outInfo.volume : [];
  const volumeItems = volumes.map(normalizePurchaseOrderVolumeItem).filter(Boolean);
  if (volumeItems.length) return volumeItems;
  return [normalizePurchaseOrderVolumeItem(outInfo)].filter(Boolean);
}

export function getNumbersFromText(value = '') {
  return (
    String(value || '')
      .match(/-?\d+(?:\.\d+)?/g)
      ?.map(Number)
      .filter((number) => Number.isFinite(number)) ?? []
  );
}

export function getGuooMaterialFromText(weightText = '', sizeText = '') {
  const weight = firstFiniteNumber(weightText);
  const dimensions = getNumbersFromText(sizeText);
  if (weight === null && dimensions.length < 3) return null;
  return {
    weightKg: weight,
    lengthCm: dimensions[0] ?? null,
    widthCm: dimensions[1] ?? null,
    heightCm: dimensions[2] ?? null,
  };
}

export function hasCompleteGuooMaterial(material = {}) {
  return ['weightKg', 'lengthCm', 'widthCm', 'heightCm'].every((field) => {
    const value = firstFiniteNumber(material?.[field]);
    return value !== null && value > 0;
  });
}

export function getGuooMaterialFromPurchaseOrder(order = {}, crossBorderRead = {}) {
  const sourceOrder = order.sourceOrder ?? {};
  const volumeItems = [
    ...(Array.isArray(crossBorderRead.volumeItems) ? crossBorderRead.volumeItems : []),
    ...(Array.isArray(order.volumeItems) ? order.volumeItems : []),
    ...(Array.isArray(sourceOrder.volumeItems) ? sourceOrder.volumeItems : []),
  ];
  const volumeMaterial = volumeItems
    .filter(Boolean)
    .map((item) => ({
      weightKg: firstFiniteNumber(item.grossWeight, item.weight, item.weightKg, item.weightText),
      lengthCm: firstFiniteNumber(item.length, item.lengthCm),
      widthCm: firstFiniteNumber(item.width, item.widthCm),
      heightCm: firstFiniteNumber(item.height, item.heightCm),
    }))
    .find(hasCompleteGuooMaterial);
  if (volumeMaterial) return volumeMaterial;

  const textMaterial = getGuooMaterialFromText(
    firstFilled(crossBorderRead.packageWeight, order.packageWeight, sourceOrder.packageWeight),
    firstFilled(crossBorderRead.packageSize, order.packageSize, sourceOrder.packageSize)
  );
  if (hasCompleteGuooMaterial(textMaterial)) return textMaterial;

  const products = [
    ...(Array.isArray(order.products) ? order.products : []),
    ...(Array.isArray(sourceOrder.products) ? sourceOrder.products : []),
  ];
  const product =
    products.find((item) => {
      const profile = item?.materialProfile ?? {};
      return ['weight', 'length', 'width', 'height'].every(
        (field) => firstFiniteNumber(profile[field], item?.[field]) !== null
      );
    }) ?? {};
  const profile = product.materialProfile ?? {};
  return {
    weightKg: firstFiniteNumber(profile.weight, product.weight),
    lengthCm: firstFiniteNumber(profile.length, product.length),
    widthCm: firstFiniteNumber(profile.width, product.width),
    heightCm: firstFiniteNumber(profile.height, product.height),
  };
}

function formatPurchaseMaterialMeasure(value, unit) {
  const number = firstFiniteNumber(value);
  return number !== null && number > 0 ? `${number} ${unit}` : '未返回';
}

export function getPurchaseOrderMaterialPresentation(order = {}, crossBorderRead = {}) {
  const material = getGuooMaterialFromPurchaseOrder(order, crossBorderRead) ?? {};
  const weightKg = firstFiniteNumber(material.weightKg);
  const lengthCm = firstFiniteNumber(material.lengthCm);
  const widthCm = firstFiniteNumber(material.widthCm);
  const heightCm = firstFiniteNumber(material.heightCm);
  const hasCompleteSize = [lengthCm, widthCm, heightCm].every((value) => value !== null && value > 0);
  return {
    weightKg,
    lengthCm,
    widthCm,
    heightCm,
    weightText: formatPurchaseMaterialMeasure(weightKg, 'kg'),
    lengthText: formatPurchaseMaterialMeasure(lengthCm, 'cm'),
    widthText: formatPurchaseMaterialMeasure(widthCm, 'cm'),
    heightText: formatPurchaseMaterialMeasure(heightCm, 'cm'),
    sizeText: hasCompleteSize ? `${lengthCm} x ${widthCm} x ${heightCm} cm` : '未返回',
  };
}

export function getGuooProductValueRubFromOrder(order = {}, options = {}) {
  const sourceOrder = order.sourceOrder ?? {};
  const raw = order.raw ?? sourceOrder.raw ?? {};
  const products = [
    ...(Array.isArray(order.products) ? order.products : []),
    ...(Array.isArray(sourceOrder.products) ? sourceOrder.products : []),
  ];
  const productValue = firstFiniteNumber(
    order.guooProductValueRub,
    order.productValueRub,
    order.orderValueRub,
    sourceOrder.guooProductValueRub,
    sourceOrder.productValueRub,
    raw.guoo_product_value_rub,
    raw.product_value_rub,
    raw.order_value_rub,
    ...products.flatMap((product) => [
      product.guooProductValueRub,
      product.productValueRub,
      product.valueRub,
      product.raw?.guoo_product_value_rub,
      product.raw?.product_value_rub,
      product.raw?.value_rub,
    ])
  );
  if (productValue !== null) return productValue;

  const orderAmountCny = firstFiniteNumber(
    order.amountValue,
    sourceOrder.amountValue,
    order.amount,
    sourceOrder.amount
  );
  const rubToCnyRate = firstFiniteNumber(options.rubToCnyRate, order.rubToCnyRate, order.exchangeRate?.rubToCnyRate);
  return orderAmountCny === null || rubToCnyRate === null || rubToCnyRate <= 0 ? null : orderAmountCny / rubToCnyRate;
}

export function getGuooRouteTextFromPurchaseOrder(order = {}, crossBorderRead = {}) {
  const sourceOrder = order.sourceOrder ?? {};
  const raw = order.raw ?? sourceOrder.raw ?? {};
  const sourceRaw = sourceOrder.raw ?? {};
  return [
    crossBorderRead.deliveryMethod,
    crossBorderRead.logistics,
    order.deliveryMethod,
    order.logistics,
    sourceOrder.deliveryMethod,
    sourceOrder.logistics,
    raw.delivery_method?.name,
    raw.delivery_method?.tpl_provider,
    raw.deliveryMethod?.name,
    raw.deliveryMethod?.tplProvider,
    raw.delivery_method_name,
    raw.deliveryMethodName,
    raw.delivery_schema,
    sourceRaw.delivery_method?.name,
    sourceRaw.delivery_method?.tpl_provider,
    sourceRaw.deliveryMethod?.name,
    sourceRaw.deliveryMethod?.tplProvider,
    sourceRaw.delivery_method_name,
    sourceRaw.deliveryMethodName,
    sourceRaw.delivery_schema,
    order.warehouse,
    order.channel,
  ]
    .filter(Boolean)
    .join(' ');
}

export const getLogisticsRouteTextFromPurchaseOrder = getGuooRouteTextFromPurchaseOrder;

export function hasConfirmedGuooRouteFromPurchaseOrder(order = {}, crossBorderRead = {}) {
  const sourceOrder = order.sourceOrder ?? {};
  const raw = order.raw ?? sourceOrder.raw ?? {};
  const sourceRaw = sourceOrder.raw ?? {};
  return [
    crossBorderRead.deliveryMethod,
    crossBorderRead.logistics,
    order.deliveryMethod,
    order.logistics,
    sourceOrder.deliveryMethod,
    sourceOrder.logistics,
    raw.delivery_method?.tpl_provider,
    raw.deliveryMethod?.tplProvider,
    raw.tpl_provider_name,
    sourceRaw.delivery_method?.tpl_provider,
    sourceRaw.deliveryMethod?.tplProvider,
    sourceRaw.tpl_provider_name,
  ].some((value) => /\bGUOO\b/i.test(String(value || '')));
}

export function getLogisticsProductValueCnyFromOrder(order = {}, options = {}) {
  const sourceOrder = order.sourceOrder ?? {};
  const raw = order.raw ?? sourceOrder.raw ?? {};
  const products = [
    ...(Array.isArray(order.products) ? order.products : []),
    ...(Array.isArray(sourceOrder.products) ? sourceOrder.products : []),
  ];
  return firstFiniteNumber(
    options.productValueCny,
    order.productValueCny,
    order.orderValueCny,
    order.amountValue,
    sourceOrder.productValueCny,
    sourceOrder.orderValueCny,
    sourceOrder.amountValue,
    raw.product_value_cny,
    raw.order_value_cny,
    ...products.flatMap((product) => [
      product.productValueCny,
      product.valueCny,
      product.raw?.product_value_cny,
      product.raw?.value_cny,
    ])
  );
}

function getLogisticsPricingOrderScope(order = {}, options = {}) {
  const sourceOrder = order.sourceOrder ?? {};
  return {
    accountId: firstFilled(
      options.accountId,
      options.shopClientId,
      order.accountId,
      order.shopClientId,
      order.clientId,
      sourceOrder.accountId,
      sourceOrder.shopClientId,
      sourceOrder.clientId
    ),
    shopId: firstFilled(
      options.shopId,
      order.shopId,
      order.shop_id,
      sourceOrder.shopId,
      sourceOrder.shop_id
    ),
  };
}

export function getLogisticsFreightForPurchaseOrder(order = {}, crossBorderRead = {}, options = {}) {
  const material = getGuooMaterialFromPurchaseOrder(order, crossBorderRead);
  const productValueRub = getGuooProductValueRubFromOrder(order, options);
  const productValueCny = getLogisticsProductValueCnyFromOrder(order, options);
  const savedSelection = resolveLogisticsPricingSelection(
    options.settings || readSavedLogisticsPricingSettings(),
    getLogisticsPricingOrderScope(order, options)
  );
  return calculateLogisticsFreight({
    ...material,
    productValueRub,
    productValueCny,
    routeText: getGuooRouteTextFromPurchaseOrder(order, crossBorderRead),
    providerId: options.providerId || savedSelection.providerId,
    market: options.market || savedSelection.market,
    serviceLevel: options.serviceLevel || savedSelection.serviceLevel,
    routeId: options.routeId || savedSelection.routeId,
  });
}

export function getGuooRealFbsFreightForPurchaseOrder(order = {}, crossBorderRead = {}, options = {}) {
  const result = getLogisticsFreightForPurchaseOrder(order, crossBorderRead, {
    ...options,
    providerId: 'guoo',
    market: options.market || 'RU',
  });
  return result.ok ? result : null;
}

export function getOrderCardLogisticsFeeValue(order = {}) {
  const sourceOrder = order.sourceOrder ?? {};
  const storedValue = firstFiniteNumber(
    order.freightCostValue,
    order.logisticsFreight?.amount,
    order.guooFreight?.amount,
    order.freightCost,
    order.shippingFeeValue,
    order.shippingFee,
    sourceOrder.freightCostValue,
    sourceOrder.logisticsFreight?.amount,
    sourceOrder.guooFreight?.amount,
    sourceOrder.freightCost,
    sourceOrder.shippingFeeValue,
    sourceOrder.shippingFee
  );
  if (storedValue !== null) return storedValue;
  const estimate = getLogisticsFreightForPurchaseOrder(order);
  return estimate.ok ? estimate.amount : null;
}

export function getOzonPostingFamilyKey(value = '') {
  const normalized = normalizeProductBusMatchValue(value).replace(/\s+/g, '');
  const match = normalized.match(/^(\d{6,}-\d{3,})(?:-\d+)?$/);
  return match?.[1] || '';
}
