export const emptyCollectorDraft = Object.freeze({
  keyword: '',
  sourcePlatform: '',
  sourceUrl: '',
  competitorUrl: '',
  weightG: '',
  packageLengthCm: '',
  packageWidthCm: '',
  packageHeightCm: '',
  note: '',
});

export const emptyPricingDraft = Object.freeze({
  purchaseCost: '',
  firstMileCost: '',
  extraCost: '',
  ozonFeePercent: '',
  expectedProfitCny: '',
  // 老草稿兼容字段；新界面按“每单预期利润”工作。
  targetMarginPercent: '',
  currentPrice: '',
});

export const collectionSourcePlatformOptions = Object.freeze([
  Object.freeze({ value: 'ozon-buyer', label: 'Ozon 竞品' }),
  Object.freeze({ value: '1688', label: '1688' }),
  Object.freeze({ value: 'pdd', label: '拼多多' }),
  Object.freeze({ value: 'taobao', label: '淘宝' }),
  Object.freeze({ value: 'tmall', label: '天猫' }),
]);

export const collectionSourceHomeUrls = Object.freeze({
  'ozon-buyer': 'https://www.ozon.ru/',
  '1688': 'https://www.1688.com/',
  pdd: 'https://mobile.yangkeduo.com/',
  taobao: 'https://www.taobao.com/',
  tmall: 'https://www.tmall.com/',
  jd: 'https://www.jd.com/',
  wildberries: 'https://www.wildberries.ru/',
  amazon: 'https://www.amazon.com/',
  temu: 'https://www.temu.com/',
  aliexpress: 'https://www.aliexpress.com/',
});

export const pricingDraftFieldGroups = Object.freeze([
  Object.freeze({
    title: '成本',
    fields: Object.freeze([
      Object.freeze({ field: 'purchaseCost', label: '采购成本', unit: '元', required: true }),
      Object.freeze({ field: 'firstMileCost', label: '物流 / 头程', unit: '元' }),
      Object.freeze({ field: 'extraCost', label: '其它成本', unit: '元' }),
    ]),
  }),
  Object.freeze({
    title: '平台扣费与利润',
    fields: Object.freeze([
      Object.freeze({ field: 'ozonFeePercent', label: '类目扣点', unit: '%' }),
      Object.freeze({ field: 'expectedProfitCny', label: '预期利润 / 单', unit: '元', required: true }),
      Object.freeze({ field: 'currentPrice', label: '当前售价', unit: '元' }),
    ]),
  }),
]);
