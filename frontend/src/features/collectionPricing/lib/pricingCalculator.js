const MONEY_SCALE = 100;
const BASIS_POINT_SCALE = 100;

export class CollectionPricingInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CollectionPricingInputError';
    this.code = code;
  }
}

function inputError(code, message) {
  throw new CollectionPricingInputError(code, message);
}

export function parsePricingNumber(value) {
  const text = String(value ?? '')
    .trim()
    .replace(',', '.')
    .replace(/[^\d.-]/g, '');
  if (!text || text === '-' || text === '.' || text === '-.') return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function toScaledInteger(value, field, scale, { required = false, defaultValue = 0 } = {}) {
  const parsed = parsePricingNumber(value);
  if (parsed === null) {
    if (required) inputError('COLLECTION_PRICING_REQUIRED', `请填写${field}。`);
    return defaultValue;
  }
  if (parsed < 0) inputError('COLLECTION_PRICING_NEGATIVE', `${field}不能为负数。`);
  const scaled = Math.round(parsed * scale);
  if (!Number.isSafeInteger(scaled)) {
    inputError('COLLECTION_PRICING_OUT_OF_RANGE', `${field}超出可核价范围。`);
  }
  return scaled;
}

export function buildCollectionPricingQuoteInput(draft = {}) {
  const currentPriceText = String(draft.currentPrice ?? '').trim();
  return {
    commissionBasisPoints: toScaledInteger(draft.ozonFeePercent, 'Ozon 佣金', BASIS_POINT_SCALE),
    currency: 'CNY',
    currentPriceMinor: currentPriceText
      ? toScaledInteger(draft.currentPrice, '当前售价', MONEY_SCALE, { required: true })
      : null,
    extraCostMinor: toScaledInteger(draft.extraCost, '其它成本', MONEY_SCALE),
    firstMileCostMinor: toScaledInteger(draft.firstMileCost, '头程 / 运费', MONEY_SCALE),
    purchaseCostMinor: toScaledInteger(draft.purchaseCost, '采购成本', MONEY_SCALE, { required: true }),
    targetMarginBasisPoints: toScaledInteger(draft.targetMarginPercent, '目标利润率', BASIS_POINT_SCALE),
  };
}

function minorToMoney(value) {
  return value === null ? null : value / MONEY_SCALE;
}

function basisPointsToPercent(value) {
  return value === null ? null : value / BASIS_POINT_SCALE;
}

export function createEmptyPricingPreview() {
  return {
    hasCost: false,
    totalCost: null,
    allInCost: null,
    commissionCost: null,
    feePercent: null,
    targetMarginPercent: null,
    breakEvenPrice: null,
    suggestedPrice: null,
    currentProfit: null,
    currentMargin: null,
  };
}

export function mapVerifiedCollectionPricingQuote(verified, normalizedInput) {
  if (
    !verified ||
    verified.signatureVerified !== true ||
    verified.capability !== 'collection-pricing.quote' ||
    verified.version !== 1 ||
    !['server-signed', 'offline-signed'].includes(verified.source)
  ) {
    inputError('COLLECTION_PRICING_RESULT_UNVERIFIED', '服务器核价结果未通过签名验证。');
  }
  const result = verified.result;
  if (!result || typeof result !== 'object') {
    inputError('COLLECTION_PRICING_RESULT_INVALID', '服务器核价结果不完整。');
  }
  const totalCost = minorToMoney(result.totalCostMinor);
  const currentPrice = minorToMoney(normalizedInput.currentPriceMinor);
  const currentProfit = minorToMoney(result.currentProfitMinor);
  const allInCost = currentPrice === null || currentProfit === null
    ? null
    : Number((currentPrice - currentProfit).toFixed(2));
  const commissionCost = allInCost === null
    ? null
    : Number(Math.max(0, allInCost - totalCost).toFixed(2));
  return {
    hasCost: true,
    totalCost,
    allInCost,
    commissionCost,
    feePercent: basisPointsToPercent(normalizedInput.commissionBasisPoints),
    targetMarginPercent: basisPointsToPercent(normalizedInput.targetMarginBasisPoints),
    breakEvenPrice: minorToMoney(result.breakEvenPriceMinor),
    suggestedPrice: minorToMoney(result.suggestedPriceMinor),
    currentProfit,
    currentMargin: basisPointsToPercent(result.currentMarginBasisPoints),
  };
}
