const INTERNAL_FIELD_LABELS = Object.freeze({
  'market.metrics.followSellerCount': '跟卖卖家数量',
  'market.metrics.recentSalesChange': '近期销量变化',
  'market.metrics.returnCancelRate': '退货取消率',
  'market.metrics.averageDailyUnits': '日均销量',
  'market.metrics.revenue30d': '近30天销售额',
  'market.metrics.sales30d': '近30天销量',
  'market.metrics.priceRub': '市场售价',
  'market.metrics.stock': '市场库存',
  'market.metrics.rating': '商品评分',
  'market.metrics.reviews': '评价数量',
  'market.metrics.listingDays': '上架天数',
  'market.record.category': '外部市场类目',
  'record.category': '外部市场类目',
  'product.category': '店内商品类目',
  'product.imageUrl': '商品主图',
  'product.productId': 'Ozon商品ID',
  'product.offerId': '商品货号',
  'product.title': '商品名称',
  'product.sku': 'Ozon SKU',
  'profit.modeLabel': '利润口径',
  'profit.revenue': '订单收入',
  'profit.profit': '订单利润',
  'profit.margin': '利润率',
  'profit.formula': '利润计算方式',
  'ownProduct.orderCount': '同商品历史订单数',
  'ownProduct.readyProfitCount': '同商品可核算订单数',
  'ownProduct.lossOrderCount': '同商品亏损订单数',
  'ownProduct.totalRevenue': '同商品累计收入',
  'ownProduct.totalProfit': '同商品累计利润',
  'ownProduct.averageProfit': '同商品平均利润',
  'ownProduct.margin': '同商品历史利润率',
});

const LAST_SEGMENT_LABELS = Object.freeze({
  stock: '库存数据',
  followSellerCount: '跟卖卖家数量',
  recentSalesChange: '近期销量变化',
  category: '商品类目',
  imageUrl: '商品主图',
  rating: '商品评分',
  reviews: '评价数量',
  sales30d: '近30天销量',
  revenue30d: '近30天销售额',
  averageDailyUnits: '日均销量',
  returnCancelRate: '退货取消率',
  listingDays: '上架天数',
  orderNumber: '订单号',
  title: '商品名称',
  sku: 'Ozon SKU',
  offerId: '商品货号',
  productId: 'Ozon商品ID',
  margin: '利润率',
  revenue: '订单收入',
  profit: '订单利润',
});

const INTERNAL_PATH_PATTERN = /\b(?:market|product|profit|order|ownProduct|record|analysis)(?:\.[A-Za-z][A-Za-z0-9_]*)+/gu;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function formatProfitOrderReviewUserText(value) {
  let output = String(value ?? '').trim();
  Object.entries(INTERNAL_FIELD_LABELS)
    .sort(([left], [right]) => right.length - left.length)
    .forEach(([field, label]) => {
      output = output.replace(new RegExp(escapeRegExp(field), 'gu'), label);
    });
  output = output.replace(INTERNAL_PATH_PATTERN, (path) => {
    const lastSegment = path.split('.').at(-1);
    return LAST_SEGMENT_LABELS[lastSegment] || '对应数据';
  });
  return output
    .replace(/profit-ledger-sqlite/giu, '本机利润账本')
    .replace(/profit-ledger-v\d+[A-Za-z0-9_-]*/giu, '当前利润账本规则')
    .replace(/actualIncome-source-commission-penalty-acquiring-delivery-logistics-bus/giu, '实际利润完整计算方式')
    .replace(/-?\d+\.\d{3,}/gu, (match) => Number(match).toFixed(2));
}

