import {
  getLogisticsPricingProvider,
  LOGISTICS_PRICING_PRESET_VERSION,
  LOGISTICS_PRICING_PROVIDERS,
  LOGISTICS_PRICING_ROUTES,
} from '../shared/config/logisticsPricingPresets.js';

const CATEGORY_ALIASES = Object.freeze({
  'extra-small': ['extrasmall', '超级轻小件', '超小件'],
  budget: ['budget', '低客单价标准件', '低客单轻小件', '低客单小件', '低客单'],
  'premium-small': ['premiumsmall', '高客单价轻小件', '高客单价小件', '高客单轻小件', '高客单标准小件'],
  'premium-big': ['premiumbig', '高客单价大件', '高客单大件', '高客单标准大件'],
  'china-post': ['chinapost', 'epacket', '中国邮政', 'eub'],
  hk: ['expresshk', '香港空运', '中国香港'],
  small: ['small', '标准小件', '轻小件', '小件'],
  big: ['big', '标准大件', '大件'],
});

const SERVICE_ALIASES = Object.freeze({
  express: ['express', '特快', '空运特快'],
  standard: ['standard', '标准', '陆空联运'],
  economy: ['economy', '经济', '陆运'],
  hk: ['expresshk', '香港空运'],
});

const MARKET_ALIASES = Object.freeze({
  RU: ['russia', 'russian', '俄罗斯'],
  KZ: ['kazakhstan', '哈萨克斯坦', '哈萨克'],
  BY: ['belarus', '白俄罗斯', '白俄'],
  KG: ['kyrgyzstan', '吉尔吉斯斯坦', '吉尔吉斯'],
  UZ: ['uzbekistan', '乌兹别克斯坦', '乌兹别克'],
});

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || String(value).trim() === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

export function normalizeLogisticsMatchText(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();
}

function getDimensionProfile(input = {}, divisor = 12000) {
  const dimensions = [input.lengthCm, input.widthCm, input.heightCm]
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => right - left);
  if (dimensions.length !== 3) return null;
  return {
    longest: dimensions[0],
    middle: dimensions[1],
    shortest: dimensions[2],
    sum: dimensions.reduce((total, value) => total + value, 0),
    volumeWeight: dimensions.reduce((total, value) => total * value, 1) / divisor,
  };
}

export function normalizeLogisticsPricingInput(input = {}) {
  return {
    weightKg: firstFiniteNumber(input.weightKg, input.weight, input.grossWeight, input.grossWeightKg),
    lengthCm: firstFiniteNumber(input.lengthCm, input.length, input.long),
    widthCm: firstFiniteNumber(input.widthCm, input.width),
    heightCm: firstFiniteNumber(input.heightCm, input.height),
    productValueRub: firstFiniteNumber(input.productValueRub, input.valueRub, input.orderValueRub),
    productValueCny: firstFiniteNumber(input.productValueCny, input.valueCny, input.orderValueCny),
    routeText: String(input.routeText || input.deliveryMethod || input.logistics || ''),
    providerId: String(input.providerId || input.provider || 'auto').trim().toLowerCase(),
    market: String(input.market || '').trim().toUpperCase(),
    serviceLevel: String(input.serviceLevel || input.service || 'auto').trim().toLowerCase(),
    routeId: String(input.routeId || '').trim(),
  };
}

function detectSingleToken(text, aliasMap) {
  const matches = Object.entries(aliasMap)
    .map(([key, aliases]) => ({
      key,
      length: aliases.reduce((longest, alias) => {
        const normalizedAlias = normalizeLogisticsMatchText(alias);
        return text.includes(normalizedAlias) ? Math.max(longest, normalizedAlias.length) : longest;
      }, 0),
    }))
    .filter((match) => match.length > 0)
    .sort((left, right) => right.length - left.length);
  if (!matches.length || matches[0].length === matches[1]?.length) return '';
  return matches[0].key;
}

function detectProviderId(text) {
  const matches = LOGISTICS_PRICING_PROVIDERS.filter((provider) =>
    provider.aliases.some((alias) => text.includes(normalizeLogisticsMatchText(alias)))
  );
  return matches.length === 1 ? matches[0].id : '';
}

function isWithinLowerBound(value, min, inclusive = true) {
  if (min === undefined || min === null) return true;
  return inclusive ? value >= min : value > min;
}

function roundWeightUp(value, step) {
  if (!step || step <= 0) return value;
  const precision = Math.max(0, String(step).split('.')[1]?.length || 0);
  return Number((Math.ceil((value - Number.EPSILON) / step) * step).toFixed(precision));
}

function roundAmount(value, mode) {
  if (mode === 'ceil-cent') return Math.ceil((value - Number.EPSILON) * 100) / 100;
  return Number(value.toFixed(6));
}

function invalidRouteResult(route, reason) {
  return {
    ok: false,
    route,
    providerId: route.providerId,
    routeId: route.id,
    reason,
    amount: null,
  };
}

export function calculateLogisticsRouteFreight(route = {}, sourceInput = {}, options = {}) {
  const input = normalizeLogisticsPricingInput(sourceInput);
  const exactRoute = options.exactRoute === true;
  const dimensions = getDimensionProfile(input, route.volumeDivisor || 12000);
  if (input.weightKg === null || input.weightKg <= 0) return invalidRouteResult(route, '缺少重量');
  if (!dimensions) return invalidRouteResult(route, '缺少长宽高');

  if (!exactRoute && !isWithinLowerBound(input.weightKg, route.minWeightKg, route.minWeightInclusive)) {
    return invalidRouteResult(route, '重量低于线路范围');
  }
  // When Ozon has already returned an exact route name (or the user selected a
  // concrete route id), that route is the source of truth.  The preset bounds
  // are selection rules for choosing a route locally; applying them again to
  // an Ozon-confirmed route incorrectly turns slightly overweight/oversized
  // real parcels into "待确认" instead of pricing their actual charge weight.
  if (!exactRoute && route.maxWeightKg !== undefined && input.weightKg > route.maxWeightKg) {
    return invalidRouteResult(route, '重量超出线路范围');
  }
  if (!exactRoute && (route.minValueRub !== undefined || route.maxValueRub !== undefined)) {
    if (input.productValueRub === null) return invalidRouteResult(route, '缺少卢布货值');
    if (route.minValueRub !== undefined && input.productValueRub < route.minValueRub) {
      return invalidRouteResult(route, '货值低于线路范围');
    }
    if (route.maxValueRub !== undefined && input.productValueRub > route.maxValueRub) {
      return invalidRouteResult(route, '货值超出线路范围');
    }
  }
  if (!exactRoute && (route.minValueCny !== undefined || route.maxValueCny !== undefined)) {
    if (input.productValueCny === null) return invalidRouteResult(route, '缺少人民币货值');
    if (route.minValueCny !== undefined && input.productValueCny < route.minValueCny) {
      return invalidRouteResult(route, '货值低于线路范围');
    }
    if (route.maxValueCny !== undefined && input.productValueCny > route.maxValueCny) {
      return invalidRouteResult(route, '货值超出线路范围');
    }
  }
  if (!exactRoute && route.maxDimensionSumCm !== undefined && dimensions.sum > route.maxDimensionSumCm) {
    return invalidRouteResult(route, '三边和超出线路范围');
  }
  if (!exactRoute && route.maxLongestCm !== undefined && dimensions.longest > route.maxLongestCm) {
    return invalidRouteResult(route, '最长边超出线路范围');
  }
  if (!exactRoute && route.maxMiddleCm !== undefined && dimensions.middle > route.maxMiddleCm) {
    return invalidRouteResult(route, '第二边超出线路范围');
  }
  if (!exactRoute && route.maxShortestCm !== undefined && dimensions.shortest > route.maxShortestCm) {
    return invalidRouteResult(route, '第三边超出线路范围');
  }

  const shouldUseVolumeWeight = Boolean(route.useVolumeWeight) && (
    route.volumeWeightWhenSumExceedsCm === null ||
    route.volumeWeightWhenSumExceedsCm === undefined ||
    dimensions.sum > route.volumeWeightWhenSumExceedsCm
  );
  const appliedVolumeWeight = shouldUseVolumeWeight ? dimensions.volumeWeight : 0;
  const minimumBillingWeight = exactRoute ? Number(route.minimumBillingWeightKg || 0) : 0;
  const unroundedChargeWeight = Math.max(input.weightKg, appliedVolumeWeight, minimumBillingWeight);
  const chargeWeight = roundWeightUp(unroundedChargeWeight, route.weightRoundingKg);
  if (
    !exactRoute &&
    route.maxChargeWeightKg !== null &&
    route.maxChargeWeightKg !== undefined &&
    chargeWeight > route.maxChargeWeightKg
  ) {
    return invalidRouteResult(route, '计费重量超出线路范围');
  }
  const amount = roundAmount(chargeWeight * Number(route.kgFee) + Number(route.ticketFee), route.amountRounding);
  return {
    ok: true,
    providerId: route.providerId,
    providerLabel: route.providerLabel,
    route,
    routeId: route.id,
    routeLabel: route.label,
    matchedBy: options.matchedBy || 'rule',
    confidence: options.confidence ?? 0.75,
    amount,
    display: `¥${amount.toFixed(2)}`,
    actualWeight: input.weightKg,
    volumeWeight: dimensions.volumeWeight,
    chargeWeight,
    billedWeight: chargeWeight,
    kgFee: route.kgFee,
    ticketFee: route.ticketFee,
    productValueRub: input.productValueRub,
    productValueCny: input.productValueCny,
    routeConfirmed: exactRoute,
    pricingVersion: LOGISTICS_PRICING_PRESET_VERSION,
    candidates: [],
  };
}

function getExactAliasMatches(routes, normalizedText) {
  if (!normalizedText) return [];
  return routes.filter((route) =>
    route.aliases.some((alias) => {
      const normalizedAlias = normalizeLogisticsMatchText(alias);
      return normalizedAlias.length >= 6 && normalizedText.includes(normalizedAlias);
    })
  );
}

function toCandidateSummary(result) {
  return {
    providerId: result.providerId,
    routeId: result.routeId,
    routeLabel: result.route?.label || '',
    amount: result.amount,
    serviceLevel: result.route?.serviceLevel || '',
    category: result.route?.category || '',
  };
}

function failedPricingResult(reason, candidates = [], extra = {}) {
  return {
    ok: false,
    providerId: extra.providerId || '',
    routeId: '',
    matchedBy: extra.matchedBy || 'none',
    confidence: 0,
    amount: null,
    actualWeight: extra.actualWeight ?? null,
    volumeWeight: null,
    chargeWeight: null,
    kgFee: null,
    ticketFee: null,
    pricingVersion: LOGISTICS_PRICING_PRESET_VERSION,
    reason,
    ambiguous: reason === '匹配到多条物流线路',
    candidates: candidates.map(toCandidateSummary),
  };
}

export function calculateLogisticsFreight(sourceInput = {}) {
  const input = normalizeLogisticsPricingInput(sourceInput);
  const normalizedText = normalizeLogisticsMatchText(input.routeText);
  const requestedProviderId = getLogisticsPricingProvider(input.providerId)?.id || '';
  const detectedProviderId = requestedProviderId || detectProviderId(normalizedText);
  const detectedMarket = input.market || detectSingleToken(normalizedText, MARKET_ALIASES) || 'RU';
  const detectedServiceLevel = input.serviceLevel !== 'auto' ? input.serviceLevel : detectSingleToken(normalizedText, SERVICE_ALIASES);
  const detectedCategory = detectSingleToken(normalizedText, CATEGORY_ALIASES);

  let routes = LOGISTICS_PRICING_ROUTES.filter((route) =>
    (!detectedProviderId || route.providerId === detectedProviderId) && route.market === detectedMarket
  );
  if (input.routeId) {
    const explicitRoute = routes.find((route) => route.id === input.routeId);
    if (!explicitRoute) return failedPricingResult('指定物流线路不存在', [], { providerId: detectedProviderId, actualWeight: input.weightKg });
    return calculateLogisticsRouteFreight(explicitRoute, input, {
      exactRoute: true,
      matchedBy: 'route-id',
      confidence: 1,
    });
  }

  const exactMatches = getExactAliasMatches(routes, normalizedText);
  if (exactMatches.length === 1) {
    return calculateLogisticsRouteFreight(exactMatches[0], input, {
      exactRoute: true,
      matchedBy: 'exact-alias',
      confidence: 1,
    });
  }
  if (exactMatches.length > 1) {
    const calculated = exactMatches
      .map((route) => calculateLogisticsRouteFreight(route, input, { exactRoute: true }))
      .filter((result) => result.ok);
    return failedPricingResult('匹配到多条物流线路', calculated, {
      providerId: detectedProviderId,
      matchedBy: 'exact-alias',
      actualWeight: input.weightKg,
    });
  }

  if (detectedServiceLevel) routes = routes.filter((route) => route.serviceLevel === detectedServiceLevel);
  if (detectedCategory) routes = routes.filter((route) => route.category === detectedCategory);
  const routeResults = routes
    .map((route) => calculateLogisticsRouteFreight(route, input, {
      matchedBy: detectedCategory || detectedServiceLevel ? 'classification' : 'rule',
      confidence: detectedCategory && detectedServiceLevel ? 0.95 : detectedCategory || detectedServiceLevel ? 0.85 : 0.7,
    }));
  const calculated = routeResults
    .filter((result) => result.ok)
    .sort((left, right) => left.amount - right.amount);

  if (calculated.length === 1) return calculated[0];
  if (calculated.length > 1) {
    return failedPricingResult('匹配到多条物流线路', calculated, {
      providerId: detectedProviderId,
      matchedBy: detectedCategory || detectedServiceLevel ? 'classification' : 'rule',
      actualWeight: input.weightKg,
    });
  }
  const invalidReasons = [...new Set(routeResults.map((result) => result.reason).filter(Boolean))];
  const missingReason = ['缺少重量', '缺少长宽高', '缺少卢布货值', '缺少人民币货值']
    .find((value) => invalidReasons.includes(value));
  const reason = missingReason || (!detectedProviderId && !normalizedText
    ? '缺少物流服务商或线路名称'
    : '没有符合重量、货值和尺寸限制的线路');
  return failedPricingResult(reason, [], { providerId: detectedProviderId, actualWeight: input.weightKg });
}
