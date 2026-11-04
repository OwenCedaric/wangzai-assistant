export const ORDER_CARD_ACQUIRING_RATE = 0.02;
export const OZON_MILEAGE_FEE_RUB = 15;
export const GUOO_REALFBS_VOLUME_DIVISOR = 12000;

const FEE_REASON = {
  missingWeight: '\u7f3a\u5c11\u91cd\u91cf',
  missingDimensions: '\u7f3a\u5c11\u957f\u5bbd\u9ad8',
  missingRoutePrice: '\u7f3a\u5c11\u7ebf\u8def\u4ef7\u683c',
  missingVolumeDivisor: '\u7f3a\u5c11\u4f53\u79ef\u91cd\u7cfb\u6570',
  missingParcels: '\u7f3a\u5c11\u5305\u88f9',
};

export function toFeeNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (!text) return null;
  const normalized = text.includes(',') && !text.includes('.') ? text.replace(',', '.') : text.replace(/,/g, '');
  const numericText = normalized.replace(/[^\d.-]/g, '');
  if (!numericText || numericText === '-' || numericText === '.' || numericText === '-.') return null;
  const number = Number(numericText);
  return Number.isFinite(number) ? number : null;
}

export function normalizeEstimatedCommissionPercent(value) {
  const percent = toFeeNumber(value);
  if (percent === null || percent <= 0 || percent > 100) return null;
  return percent;
}

function toNegativeFee(value) {
  const number = toFeeNumber(value);
  return number === null ? null : -number;
}

export function normalizeFeeCurrencyCode(currencyCode) {
  const raw = String(currencyCode || '').trim();
  const code = raw.toUpperCase();
  if (!code) return '';
  if (['CNY', 'RMB', 'CNH'].includes(code) || raw === '\u00a5' || raw === '\uffe5' || raw === '\u5143') {
    return 'CNY';
  }
  if (['RUB', 'RUR', 'RUB.'].includes(code) || raw === '\u20bd' || code.startsWith('\u0420\u0423\u0411')) {
    return 'RUB';
  }
  return code;
}

export function normalizeRubToCnyRate(value) {
  const rate = toFeeNumber(value);
  return rate !== null && rate > 0 ? rate : null;
}

export function convertFeeAmountToCny(value, currencyCode, options = {}) {
  const amount = toFeeNumber(value);
  if (amount === null) return null;
  const code = normalizeFeeCurrencyCode(currencyCode);
  if (code === 'CNY') return amount;
  if (amount === 0) return 0;
  if (code === 'RUB') {
    const rate = normalizeRubToCnyRate(options.rubToCnyRate);
    return rate === null ? null : amount * rate;
  }
  return null;
}

export function sumRequiredFees(values = []) {
  if (!Array.isArray(values) || values.some((value) => value === null || value === undefined)) return null;
  let total = 0;
  for (const value of values) {
    const number = toFeeNumber(value);
    if (number === null) return null;
    total += number;
  }
  return total;
}

export function calculateCommissionFeeCny({
  orderAmount,
  orderCurrency = 'CNY',
  orderAmountCny,
  commissionPercent,
  rubToCnyRate,
} = {}) {
  const amountCny = toFeeNumber(orderAmountCny) ?? convertFeeAmountToCny(orderAmount, orderCurrency, { rubToCnyRate });
  const percent = toFeeNumber(commissionPercent);
  if (amountCny === null || percent === null) return null;
  return (amountCny * percent) / 100;
}

export function calculateAcquiringFeeCny({
  orderPaymentAmount,
  orderPaymentCurrency = 'CNY',
  orderPaymentCny,
  acquiringRate = ORDER_CARD_ACQUIRING_RATE,
  rubToCnyRate,
} = {}) {
  const amountCny =
    toFeeNumber(orderPaymentCny) ?? convertFeeAmountToCny(orderPaymentAmount, orderPaymentCurrency, { rubToCnyRate });
  const rate = toFeeNumber(acquiringRate);
  if (amountCny === null || rate === null) return null;
  return amountCny * rate;
}

export function calculateDeliveryServiceFeeCny({ deliveryServiceFeeRub = OZON_MILEAGE_FEE_RUB, rubToCnyRate } = {}) {
  return convertFeeAmountToCny(deliveryServiceFeeRub, 'RUB', { rubToCnyRate });
}

export function calculateCrossBorderBusFeeCny({ labelFeeUnit, rechargeAmount, giftAmount = 0, forecastOrderFee } = {}) {
  const label = toFeeNumber(labelFeeUnit);
  const recharge = toFeeNumber(rechargeAmount);
  const gift = toFeeNumber(giftAmount) ?? 0;
  const forecast = toFeeNumber(forecastOrderFee);
  if (label === null || recharge === null || forecast === null || recharge + gift <= 0) return null;
  return ((label + forecast) * recharge) / (recharge + gift);
}

export function calculateGuooParcelFreightCny({
  weightKg,
  lengthCm,
  widthCm,
  heightCm,
  kgFee,
  ticketFee,
  extraKgFee = 0,
  useVolumeWeight = false,
  volumeDivisor = GUOO_REALFBS_VOLUME_DIVISOR,
} = {}) {
  const weight = toFeeNumber(weightKg);
  const length = toFeeNumber(lengthCm);
  const width = toFeeNumber(widthCm);
  const height = toFeeNumber(heightCm);
  const kgPrice = toFeeNumber(kgFee);
  const ticket = toFeeNumber(ticketFee);
  const extraKgPrice = toFeeNumber(extraKgFee) ?? 0;
  const divisor = toFeeNumber(volumeDivisor);

  if (weight === null || weight <= 0) return { ok: false, reason: FEE_REASON.missingWeight, amount: null };
  if (length === null || width === null || height === null || length <= 0 || width <= 0 || height <= 0) {
    return { ok: false, reason: FEE_REASON.missingDimensions, amount: null };
  }
  if (kgPrice === null || ticket === null) return { ok: false, reason: FEE_REASON.missingRoutePrice, amount: null };
  if (useVolumeWeight && (divisor === null || divisor <= 0)) {
    return { ok: false, reason: FEE_REASON.missingVolumeDivisor, amount: null };
  }

  const volumeWeight = useVolumeWeight ? (length * width * height) / divisor : 0;
  const chargeWeight = useVolumeWeight ? Math.max(weight, volumeWeight) : weight;
  return {
    ok: true,
    reason: '',
    amount: chargeWeight * (kgPrice + extraKgPrice) + ticket,
    chargeWeight,
    actualWeight: weight,
    volumeWeight,
    kgFee: kgPrice,
    extraKgFee: extraKgPrice,
    ticketFee: ticket,
  };
}

export function calculateGuooFreightCny(input = {}) {
  const parcels = Array.isArray(input.parcels) ? input.parcels : null;
  if (!parcels) return calculateGuooParcelFreightCny(input);
  if (!parcels.length) return { ok: false, reason: FEE_REASON.missingParcels, amount: null, parcels: [] };

  const results = parcels.map((parcel) => calculateGuooParcelFreightCny({ ...input, ...parcel }));
  const failed = results.find((result) => !result.ok);
  if (failed) return { ok: false, reason: failed.reason, amount: null, parcels: results };

  return {
    ok: true,
    reason: '',
    amount: results.reduce((total, result) => total + result.amount, 0),
    parcels: results,
  };
}

export function calculateOrderPreDeductionFeeCny({
  commissionFeeCny,
  acquiringFeeCny,
  deliveryServiceFeeCny,
  crossBorderBusFeeCny,
} = {}) {
  return sumRequiredFees([commissionFeeCny, acquiringFeeCny, deliveryServiceFeeCny, crossBorderBusFeeCny]);
}

export function calculateEstimatedProfitCny({
  orderPaymentCny,
  sourcePurchaseCostCny,
  commissionFeeCny,
  acquiringFeeCny,
  deliveryServiceFeeCny,
  crossBorderBusFeeCny,
  logisticsFeeCny,
} = {}) {
  return sumRequiredFees([
    orderPaymentCny,
    toNegativeFee(sourcePurchaseCostCny),
    toNegativeFee(commissionFeeCny),
    toNegativeFee(acquiringFeeCny),
    toNegativeFee(deliveryServiceFeeCny),
    toNegativeFee(crossBorderBusFeeCny),
    toNegativeFee(logisticsFeeCny),
  ]);
}

export function calculateActualProfitCny({
  orderPaymentCny,
  sourcePurchaseCostCny,
  platformRealDeductionTotalCny,
  crossBorderBusFeeCny,
} = {}) {
  return sumRequiredFees([
    orderPaymentCny,
    toNegativeFee(sourcePurchaseCostCny),
    toNegativeFee(platformRealDeductionTotalCny),
    toNegativeFee(crossBorderBusFeeCny),
  ]);
}

export function calculateRefundLossCny({ sourcePurchaseCostCny, crossBorderBusFeeCny, orderDeductionFeeCny = 0 } = {}) {
  return sumRequiredFees([sourcePurchaseCostCny, crossBorderBusFeeCny, orderDeductionFeeCny]);
}
