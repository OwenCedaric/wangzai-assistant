export const LOGISTICS_PRICING_PRESET_VERSION = '2026-07-29.v1';

const CATEGORY_LABELS = Object.freeze({
  'extra-small': 'Extra Small 超级轻小件',
  budget: 'Budget 低客单标准件',
  small: 'Small 轻小件',
  big: 'Big 大件',
  'premium-small': 'Premium Small 高客单轻小件',
  'premium-big': 'Premium Big 高客单大件',
  hk: '中国香港',
  'china-post': '中国邮政',
});

const SERVICE_LABELS = Object.freeze({
  express: 'Express 特快',
  standard: 'Standard 标准',
  economy: 'Economy 经济',
  hk: '香港空运',
});

const MARKET_LABELS = Object.freeze({
  RU: '俄罗斯',
  KZ: '哈萨克斯坦',
  BY: '白俄罗斯',
  KG: '吉尔吉斯斯坦',
  UZ: '乌兹别克斯坦',
});

const PROVIDER_DEFINITIONS = [
  {
    id: 'cel',
    label: 'CEL',
    aliases: ['CEL', 'CELDT', 'CEL Express', 'CEL Standard', 'CEL Economy'],
    source: 'CEL产品资费表 V7.24.xlsx',
    markets: ['RU', 'KZ', 'BY'],
  },
  {
    id: 'guoo',
    label: 'GUOO',
    aliases: ['GUOO'],
    source: 'GUOO产品资费测算表【2026.7.18更新】.xlsx',
    markets: ['RU', 'KZ', 'BY', 'KG', 'UZ'],
  },
  {
    id: 'zto',
    label: 'ZTO 中通',
    aliases: ['ZTO', 'ZTO-rFBS', '中通', '中通云仓'],
    source: 'ZTO-rFBS物流综合服务报价表v6.7（260724起）(2).xlsx',
    markets: ['RU'],
  },
  {
    id: 'ural',
    label: 'URAL',
    aliases: ['URAL', 'Ural', '乌拉尔'],
    source: '新选品表ural(10).xlsx',
    markets: ['RU'],
  },
  {
    id: 'xingyuan',
    label: '兴远国际',
    aliases: ['XY', 'Xingyuan', 'Xing Yuan', '兴远', '兴远国际'],
    source: '兴远rFBS全渠道计算器2026-07-17.xlsx',
    markets: ['RU', 'KG', 'KZ', 'BY'],
  },
];

export const LOGISTICS_PRICING_PROVIDERS = Object.freeze(
  PROVIDER_DEFINITIONS.map((provider) => Object.freeze({
    ...provider,
    marketOptions: Object.freeze(provider.markets.map((value) => Object.freeze({ value, label: MARKET_LABELS[value] }))),
  }))
);

function titleCategory(category) {
  return category
    .split('-')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function routeId(providerId, market, category, serviceLevel) {
  if (providerId === 'guoo' && market === 'RU') return `guoo-${serviceLevel}-${category}`;
  return [providerId, market.toLowerCase(), serviceLevel, category].filter(Boolean).join('-');
}

function createRoute({
  providerId,
  market = 'RU',
  category,
  serviceLevel,
  routeName,
  aliases = [],
  kgFee,
  ticketFee,
  minWeightKg = 0.001,
  minWeightInclusive = true,
  maxWeightKg,
  minimumBillingWeightKg,
  minValueRub,
  maxValueRub,
  minValueCny,
  maxValueCny,
  maxDimensionSumCm,
  maxLongestCm,
  maxMiddleCm,
  maxShortestCm,
  useVolumeWeight = false,
  volumeDivisor = 12000,
  volumeWeightWhenSumExceedsCm = null,
  maxChargeWeightKg = null,
  weightRoundingKg = null,
  amountRounding = 'none',
  priceModel = 'per-kg-plus-ticket',
  sourceSheet,
  notes = '',
}) {
  const provider = PROVIDER_DEFINITIONS.find((item) => item.id === providerId);
  const categoryLabel = CATEGORY_LABELS[category] || category;
  const serviceLabel = SERVICE_LABELS[serviceLevel] || serviceLevel;
  const canonicalRouteName = routeName || `${provider?.label || providerId} ${serviceLabel} ${categoryLabel}`;
  return Object.freeze({
    id: routeId(providerId, market, category, serviceLevel),
    providerId,
    providerLabel: provider?.label || providerId,
    market,
    marketLabel: MARKET_LABELS[market] || market,
    category,
    categoryLabel,
    productType: categoryLabel,
    serviceLevel,
    serviceLabel,
    transport: serviceLevel === 'express' ? '空运' : serviceLevel === 'standard' ? '陆空联运' : '陆运',
    label: canonicalRouteName,
    aliases: Object.freeze([
      canonicalRouteName,
      ...aliases,
    ].filter(Boolean)),
    categoryAliases: Object.freeze([categoryLabel, titleCategory(category), category]),
    serviceAliases: Object.freeze([serviceLabel, serviceLevel]),
    kgFee,
    ticketFee,
    minWeightKg,
    minWeightInclusive,
    maxWeightKg,
    minimumBillingWeightKg: minimumBillingWeightKg ?? minWeightKg,
    minValueRub,
    maxValueRub,
    minValueCny,
    maxValueCny,
    maxDimensionSumCm,
    maxLongestCm,
    maxMiddleCm,
    maxShortestCm,
    useVolumeWeight,
    volumeDivisor,
    volumeWeightWhenSumExceedsCm,
    maxChargeWeightKg,
    weightRoundingKg,
    amountRounding,
    priceModel,
    source: provider?.source || '',
    sourceSheet: sourceSheet || '',
    notes,
  });
}

const COMMON_RU_CATEGORY_RULES = Object.freeze({
  'extra-small': { maxWeightKg: 0.5, minValueRub: 1, maxValueRub: 1500, maxDimensionSumCm: 90, maxLongestCm: 60 },
  budget: { minWeightKg: 0.5, minWeightInclusive: false, maxWeightKg: 30, minValueRub: 1, maxValueRub: 1500, maxDimensionSumCm: 150, maxLongestCm: 60 },
  small: { maxWeightKg: 2, minValueRub: 1500, maxValueRub: 7000, maxDimensionSumCm: 150, maxLongestCm: 60 },
  big: { minWeightKg: 2, minWeightInclusive: false, maxWeightKg: 30, minValueRub: 1500, maxValueRub: 7000, maxDimensionSumCm: 310, maxLongestCm: 150, useVolumeWeight: true },
  'premium-small': { maxWeightKg: 5, minValueRub: 7001, maxValueRub: 250000, maxDimensionSumCm: 250, maxLongestCm: 150 },
  'premium-big': { minWeightKg: 5, minWeightInclusive: false, maxWeightKg: 30, minValueRub: 7001, maxValueRub: 250000, maxDimensionSumCm: 310, maxLongestCm: 150, useVolumeWeight: true },
});

function createMatrixRoutes({ providerId, market = 'RU', sheet, rows, ruleOverrides = {}, routeName }) {
  return rows.map(([category, serviceLevel, kgFee, ticketFee, aliases = [], extra = {}]) => createRoute({
    providerId,
    market,
    category,
    serviceLevel,
    kgFee,
    ticketFee,
    ...COMMON_RU_CATEGORY_RULES[category],
    ...ruleOverrides[category],
    ...extra,
    routeName: routeName?.({ category, serviceLevel, market }) || `${providerId.toUpperCase()} ${titleCategory(serviceLevel)} ${titleCategory(category)}`,
    aliases,
    sourceSheet: sheet,
  }));
}

const CEL_RU_ROUTES = createMatrixRoutes({
  providerId: 'cel',
  sheet: 'OZON-rFBS',
  rows: [
    ['extra-small', 'express', 50.5, 3.37], ['extra-small', 'standard', 39.3, 3.37], ['extra-small', 'economy', 28.1, 3.37],
    ['budget', 'express', 37.1, 25.83], ['budget', 'standard', 28.1, 25.83], ['budget', 'economy', 19.1, 25.83],
    ['small', 'express', 50.5, 17.97], ['small', 'standard', 39.3, 17.97], ['small', 'economy', 28.1, 17.97],
    ['big', 'standard', 28.1, 40.44], ['big', 'economy', 19.1, 40.44],
    ['premium-small', 'express', 50.5, 24.71], ['premium-small', 'standard', 39.3, 24.71], ['premium-small', 'economy', 28.1, 24.71],
    ['premium-big', 'standard', 31.4, 69.64], ['premium-big', 'economy', 25.8, 69.64],
  ],
  ruleOverrides: {
    big: { maxChargeWeightKg: 31 },
    'premium-big': { maxMiddleCm: 80, maxShortestCm: 80, maxChargeWeightKg: 80 },
  },
  routeName: ({ category, serviceLevel }) => `CEL ${titleCategory(serviceLevel)} ${titleCategory(category)}`,
});

const CEL_HK_ROUTE = createRoute({
  providerId: 'cel', market: 'RU', category: 'hk', serviceLevel: 'hk', routeName: 'CEL Express HK',
  aliases: ['CEL 香港空运', 'CEL HK'], kgFee: 96, ticketFee: 19, maxWeightKg: 25,
  minValueRub: 1, maxValueRub: 500000, maxDimensionSumCm: 310, maxLongestCm: 150,
  useVolumeWeight: true, volumeDivisor: 6000, volumeWeightWhenSumExceedsCm: 60,
  weightRoundingKg: 0.1, sourceSheet: 'OZON-rFBS', notes: '三边和超过60cm才计体积重；计费重量按100克向上进位。',
});

function createCelCisRoutes(market) {
  const country = MARKET_LABELS[market];
  return createMatrixRoutes({
    providerId: 'cel', market, sheet: 'OZON CIS 独联体国家',
    rows: [
      ['extra-small', 'standard', 36.4, 3.12], ['extra-small', 'economy', 26, 3.12],
      ['budget', 'standard', 26, 23.92], ['budget', 'economy', 17.68, 23.92],
      ['small', 'standard', 36.4, 16.64], ['small', 'economy', 26, 16.64],
      ['big', 'standard', 26, 37.44], ['big', 'economy', 17.68, 37.44],
      ['premium-small', 'standard', 36.4, 22.88], ['premium-small', 'economy', 26, 22.88],
      ['premium-big', 'standard', 29.12, 64.48], ['premium-big', 'economy', 23.92, 64.48],
    ],
    ruleOverrides: {
      'premium-small': { maxValueRub: 18000 },
      'premium-big': { maxValueRub: 18000 },
    },
    routeName: ({ category, serviceLevel }) => `CEL ${country} ${titleCategory(serviceLevel)} ${titleCategory(category)}`,
  });
}

const GUOO_RU_ROUTES = createMatrixRoutes({
  providerId: 'guoo',
  sheet: 'GUOO realFBS资费试算表',
  rows: [
    ['extra-small', 'express', 50.55, 3.37], ['extra-small', 'standard', 39.3, 3.37], ['extra-small', 'economy', 28.1, 3.37],
    ['budget', 'standard', 26, 23.92], ['budget', 'economy', 19.1, 25.83],
    ['small', 'express', 50.5, 17.97], ['small', 'standard', 39.3, 17.97], ['small', 'economy', 28.1, 17.97],
    ['big', 'standard', 28.1, 40.44], ['big', 'economy', 19.1, 40.44],
    ['premium-small', 'express', 50.5, 24.71], ['premium-small', 'standard', 39.3, 24.71], ['premium-small', 'economy', 28.1, 24.71],
    ['premium-big', 'standard', 31.4, 69.64], ['premium-big', 'economy', 25.8, 69.64],
  ],
  ruleOverrides: {
    budget: { minWeightKg: 0.5, minWeightInclusive: false },
    big: { maxDimensionSumCm: 310, maxLongestCm: 150, maxMiddleCm: 80, maxShortestCm: 80 },
    'premium-small': { maxMiddleCm: 50, maxShortestCm: 50 },
    'premium-big': { maxMiddleCm: 80, maxShortestCm: 80 },
  },
  routeName: ({ category, serviceLevel }) => `GUOO ${titleCategory(serviceLevel)} ${titleCategory(category)}`,
});

function createGuooCisRoutes(market, { maxWeightKg = 35, premiumMinValueRub = 7001, premiumMaxValueRub = 500000, serviceLevels = ['standard', 'economy'], volumeBig = true } = {}) {
  const countryEnglish = { KZ: 'Kazakhstan', BY: 'Belarus', KG: 'Kyrgyzstan', UZ: 'Uzbekistan' }[market];
  const standardRates = {
    'extra-small': [36.4, 3.12], budget: [26, 23.92], small: [36.4, 16.64], big: [26, 37.44],
    'premium-small': [36.4, 22.88], 'premium-big': [29.12, 64.48],
  };
  const economyRates = {
    'extra-small': [26, 3.12], budget: [17.68, 23.92], small: [26, 16.64], big: [17.68, 37.44],
    'premium-small': [26, 22.88], 'premium-big': [23.92, 64.48],
  };
  const rows = Object.keys(COMMON_RU_CATEGORY_RULES).flatMap((category) => serviceLevels.map((serviceLevel) => {
    const [kgFee, ticketFee] = (serviceLevel === 'standard' ? standardRates : economyRates)[category];
    const canonicalCategory = market === 'KG' && category === 'premium-small'
      ? 'Premium Big'
      : market === 'KG' && category === 'premium-big'
        ? 'Premium Small'
        : titleCategory(category);
    return [category, serviceLevel, kgFee, ticketFee, [`GUOO ${countryEnglish} ${titleCategory(serviceLevel)} ${canonicalCategory}`]];
  }));
  const sheet = market === 'KZ' ? '哈萨克斯坦专线' : market === 'BY' ? '白俄专线' : market === 'KG' ? '吉尔吉斯斯坦' : '乌兹别克斯坦';
  return createMatrixRoutes({
    providerId: 'guoo', market, sheet, rows,
    ruleOverrides: {
      budget: { maxWeightKg }, big: { maxWeightKg, useVolumeWeight: volumeBig },
      'premium-small': { minValueRub: premiumMinValueRub, maxValueRub: premiumMaxValueRub },
      'premium-big': { minWeightKg: 5, minWeightInclusive: false, maxWeightKg, minValueRub: premiumMinValueRub, maxValueRub: premiumMaxValueRub, useVolumeWeight: volumeBig },
    },
    routeName: ({ category, serviceLevel }) => `GUOO ${countryEnglish} ${titleCategory(serviceLevel)} ${titleCategory(category)}`,
  });
}

const ZTO_RU_ROUTES = createMatrixRoutes({
  providerId: 'zto', sheet: 'rFBS',
  rows: [
    ['extra-small', 'express', 50.5, 3.37], ['extra-small', 'standard', 39.3, 3.37], ['extra-small', 'economy', 28.1, 3.37],
    ['budget', 'express', 37.1, 25.83], ['budget', 'standard', 28.1, 25.83],
    ['small', 'express', 50.5, 17.97], ['small', 'standard', 39.3, 17.97], ['small', 'economy', 28.1, 17.97],
    ['big', 'standard', 28.1, 40.44],
    ['premium-small', 'express', 50.5, 24.71], ['premium-small', 'standard', 39.3, 24.71], ['premium-small', 'economy', 28.1, 24.71],
    ['premium-big', 'standard', 31.4, 69.64], ['premium-big', 'economy', 25.8, 69.64],
  ],
  ruleOverrides: {
    big: { maxDimensionSumCm: 250 },
  },
  routeName: ({ category, serviceLevel }) => `ZTO ${titleCategory(serviceLevel)} ${titleCategory(category)}`,
});

const ZTO_VOLUME_ROUTE_IDS = new Map([
  ['express:budget', 12000], ['express:small', 12000], ['express:premium-small', 12000],
  ['standard:budget', 12000], ['standard:small', 12000], ['standard:big', 12000],
  ['standard:premium-small', 12000], ['standard:premium-big', 12000],
  ['economy:small', 12000], ['economy:premium-small', 24000], ['economy:premium-big', 12000],
]);

const ZTO_ROUTES_WITH_MODELS = ZTO_RU_ROUTES.map((route) => {
  const divisor = ZTO_VOLUME_ROUTE_IDS.get(`${route.serviceLevel}:${route.category}`);
  return Object.freeze({ ...route, useVolumeWeight: Boolean(divisor), volumeDivisor: divisor || 12000, weightRoundingKg: 0.001 });
});

const URAL_RU_ROUTES = createMatrixRoutes({
  providerId: 'ural', sheet: '135元以下 / 135-620元 / 620元以上',
  rows: [
    ['extra-small', 'economy', 26, 3.12], ['budget', 'economy', 26, 23.92],
    ['small', 'economy', 26, 16.64], ['big', 'economy', 26, 37.44],
    ['premium-small', 'economy', 26, 22.88], ['premium-big', 'economy', 29, 64.48],
  ],
  ruleOverrides: {
    budget: { minWeightKg: 0.5, minWeightInclusive: true },
    big: { maxDimensionSumCm: 250 },
  },
  routeName: ({ category }) => `URAL ${titleCategory(category)}`,
});

const XINGYUAN_RU_RULES = {
  'extra-small': { maxWeightKg: 0.55, maxValueRub: 1600 },
  budget: { minWeightKg: 0.55, minWeightInclusive: false, maxValueRub: 1600 },
  small: { maxWeightKg: 2.2, minValueRub: 1501, maxValueRub: 7200 },
  big: { minWeightKg: 2.2, minWeightInclusive: false, minValueRub: 1501, maxValueRub: 7200 },
  'premium-small': { maxWeightKg: 5.5, minValueRub: 7001 },
  'premium-big': { minWeightKg: 5.5, minWeightInclusive: false, minValueRub: 7001 },
};

const XINGYUAN_RU_ROUTES = createMatrixRoutes({
  providerId: 'xingyuan', sheet: '兴远渠道计算',
  rows: [
    ['extra-small', 'economy', 28.1, 3.37], ['extra-small', 'standard', 39.3, 3.37, ['XY Extra Small Standard']],
    ['budget', 'economy', 19.1, 25.83], ['budget', 'standard', 28.1, 25.83],
    ['small', 'economy', 28.1, 17.97], ['small', 'standard', 39.3, 17.97],
    ['big', 'economy', 19.1, 40.44], ['big', 'standard', 28.1, 40.44],
    ['premium-small', 'economy', 28.1, 24.71], ['premium-small', 'standard', 39.3, 24.71],
    ['premium-big', 'economy', 25.8, 69.64], ['premium-big', 'standard', 31.4, 69.64],
  ],
  ruleOverrides: XINGYUAN_RU_RULES,
  routeName: ({ category, serviceLevel }) => `XY ${titleCategory(serviceLevel)} ${titleCategory(category)}`,
});

const XINGYUAN_CHINA_POST_ROUTES = [
  createRoute({ providerId: 'xingyuan', market: 'RU', category: 'china-post', serviceLevel: 'economy', routeName: 'ePacket Economy Track', aliases: ['中国邮政 EUB特惠'], kgFee: 30, ticketFee: 12, maxWeightKg: 5, maxValueCny: 1000, maxDimensionSumCm: 90, maxLongestCm: 60, weightRoundingKg: 0.001, amountRounding: 'ceil-cent', sourceSheet: '兴远渠道计算 / 兴远吉尔吉斯渠道计算' }),
  createRoute({ providerId: 'xingyuan', market: 'KZ', category: 'china-post', serviceLevel: 'economy', routeName: 'China Post ePacket Economy Track CIS', aliases: ['中国邮政 哈萨克斯坦'], kgFee: 33, ticketFee: 1.6, maxWeightKg: 5, maxDimensionSumCm: 90, maxLongestCm: 60, weightRoundingKg: 0.001, amountRounding: 'ceil-cent', sourceSheet: '兴远渠道计算 / 兴远吉尔吉斯渠道计算' }),
  createRoute({ providerId: 'xingyuan', market: 'BY', category: 'china-post', serviceLevel: 'economy', routeName: 'China Post ePacket Economy Belarus', aliases: ['中国邮政 白俄罗斯'], kgFee: 30, ticketFee: 13, maxWeightKg: 5, maxDimensionSumCm: 90, maxLongestCm: 60, weightRoundingKg: 0.001, amountRounding: 'ceil-cent', sourceSheet: '兴远渠道计算 / 兴远吉尔吉斯渠道计算' }),
];

const XINGYUAN_KG_ROUTES = createMatrixRoutes({
  providerId: 'xingyuan', market: 'KG', sheet: '兴远吉尔吉斯渠道计算',
  rows: [
    ['extra-small', 'standard', 39.3, 3.37, ['Xingyuan Kyrgysztan Standard Extra Small']],
    ['budget', 'standard', 28.1, 23.83, ['Xingyuan Kyrgysztan Standard Budget']],
    ['small', 'standard', 39.3, 17.97, ['Xingyuan Kyrgysztan Standard Small']],
    ['big', 'standard', 28.1, 40.44, ['Xingyuan Kyrgysztan Standard Big']],
    ['premium-small', 'standard', 39.3, 24.71, ['Xingyuan Kyrgysztan Standard Premium Small']],
    ['premium-big', 'standard', 31.4, 69.64, ['Xingyuan Kyrgysztan Standard Premium Big']],
  ],
  ruleOverrides: {
    budget: { maxValueRub: 1600 }, small: { minValueRub: 1501, maxValueRub: 7200 },
    big: { minValueRub: 1501, maxValueRub: 7200 },
    'premium-small': { minValueRub: 7000, maxValueRub: 18000 },
    'premium-big': { minValueRub: 7000, maxValueRub: 18000 },
  },
  routeName: ({ category }) => `Xingyuan Kyrgyzstan Standard ${titleCategory(category)}`,
});

function withXingyuanRounding(routes) {
  return routes.map((route) => Object.freeze({ ...route, weightRoundingKg: 0.001, amountRounding: 'ceil-cent' }));
}

export const LOGISTICS_PRICING_ROUTES = Object.freeze([
  ...CEL_RU_ROUTES,
  CEL_HK_ROUTE,
  ...createCelCisRoutes('KZ'),
  ...createCelCisRoutes('BY'),
  ...GUOO_RU_ROUTES,
  ...createGuooCisRoutes('KZ'),
  ...createGuooCisRoutes('BY'),
  ...createGuooCisRoutes('KG', { maxWeightKg: 30, premiumMinValueRub: 7000, premiumMaxValueRub: 18000, serviceLevels: ['economy'], volumeBig: false }),
  ...createGuooCisRoutes('UZ', { maxWeightKg: 30, premiumMinValueRub: 7000, premiumMaxValueRub: 18000, serviceLevels: ['economy'], volumeBig: false }),
  ...ZTO_ROUTES_WITH_MODELS,
  ...URAL_RU_ROUTES.map((route) => Object.freeze({
    ...route,
    // URAL 原表只把抛重作为选品参考，运费单元格始终使用实重。
    useVolumeWeight: false,
    weightRoundingKg: 0.001,
  })),
  ...withXingyuanRounding(XINGYUAN_RU_ROUTES),
  ...withXingyuanRounding(XINGYUAN_KG_ROUTES),
  ...XINGYUAN_CHINA_POST_ROUTES,
]);

export function getLogisticsPricingProvider(providerId = '') {
  return LOGISTICS_PRICING_PROVIDERS.find((provider) => provider.id === providerId) || null;
}

export function getLogisticsPricingRoutes(providerId = '', market = '') {
  return LOGISTICS_PRICING_ROUTES.filter((route) =>
    (!providerId || route.providerId === providerId) && (!market || route.market === market)
  );
}
