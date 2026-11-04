const REPORT_TERM_LABELS = Object.freeze({
  returnCancelRate: '退货取消率',
  returnCancellationRate: '退货取消率',
  averageReturnCancelRate: '平均退货取消率',
  productCardViews: '商品卡浏览量',
  searchCatalogViews: '搜索和目录浏览量',
  productCardToCartRate: '商品卡加购转化率',
  searchCatalogToCartRate: '搜索加购转化率',
  orderConversionRate: '下单转化率',
  impressionToOrderRate: '下单转化率',
  adSpendShare: '广告费用占比',
  averageDailyUnits: '日均销量',
  averageDailyRevenue: '日均销售额',
  categoryRanks: '类目排名',
  recordCount: '商品数量',
  totalSales: '总销量',
  totalRevenue: '总销售额',
  averagePrice: '平均价格',
  averageRating: '平均评分',
  totalStock: '总库存',
  estimatedUnitProfitRub: '预估单件基础利润',
  estimatedUnitProfitRate: '预估基础利润率',
  productCostRub: '商品成本',
  commissionRate: '平台佣金率',
  fulfillmentFeeRub: '履约费用',
  taxRate: '税费率',
  dataGaps: '待补充数据',
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

const REPORT_TERM_PATTERNS = Object.entries(REPORT_TERM_LABELS)
  .sort(([left], [right]) => right.length - left.length)
  .map(([key, label]) => [new RegExp(`\\b${escapeRegExp(key)}\\b`, 'gu'), label]);

export function sanitizeExternalOzonReportText(value) {
  let result = String(value ?? '').trim();
  if (!result) return '';
  result = result.replace(
    /\b(?:data|result|response|product|records|overview)(?:\.[A-Za-z_][A-Za-z0-9_]*)+\b/gu,
    (path) => REPORT_TERM_LABELS[path.split('.').at(-1)] || '相关数据项'
  );
  for (const [pattern, label] of REPORT_TERM_PATTERNS) result = result.replace(pattern, label);
  return result
    .replace(/\b(?:null|undefined|NaN)\b/giu, '暂无数据')
    .replace(/\/(?:api|v\d+)(?:\/[A-Za-z0-9_.{}-]+)+/giu, '相关数据来源')
    .replace(/(?:接口|API)(?:中|里)?(?:未|没有)(?:返回|提供)/gu, '当前暂无')
    .replace(/(?:接口|API)(?:返回|提供)的?/gu, '当前获取的')
    .replace(/(?:接口|API)数据/gu, '当前数据')
    .replace(/字段(?:缺失|未返回|未补齐|为空)/gu, '相关数据暂未补充')
    .replace(/字段/gu, '数据项')
    .replace(/\b[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b/gu, '相关数据项')
    .replace(/\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/gu, '相关数据项')
    .replace(/\s*(?:为|是)\s*暂无数据/gu, '暂无数据')
    .replace(/(?:也)?暂无数据(?:\s*也暂无数据)+/gu, '暂无数据')
    .replace(/相关数据项(?:\s*[、,，/]\s*相关数据项)+/gu, '相关数据项')
    .replace(/[ \t]{2,}/gu, ' ')
    .trim();
}

