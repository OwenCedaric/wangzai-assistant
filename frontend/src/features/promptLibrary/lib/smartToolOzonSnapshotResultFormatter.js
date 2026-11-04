function text(value) {
  return String(value ?? '').trim();
}

function formatMetric(label, value) {
  const normalized = text(value);
  return normalized ? `${label} ${normalized}` : '';
}

function formatSnapshotRecord(record = {}, index = 0) {
  const identity = text(record.title) || text(record.id) || `记录 ${index + 1}`;
  const id = text(record.id) && text(record.id) !== identity ? `SKU ${text(record.id)}` : '';
  const metrics = [
    id,
    formatMetric('品牌', record.brand),
    formatMetric('类目', [...new Set([
      record.category1,
      record.category2,
      record.category3,
      record.category,
    ].map(text).filter(Boolean))].join(' / ')),
    formatMetric('卖家', record.seller),
    formatMetric('价格', record.price),
    formatMetric('Ozon Card', record.cardPrice),
    formatMetric('折扣', record.discount),
    formatMetric('销量', record.sales),
    formatMetric('订单', record.orders),
    formatMetric('GMV', record.revenue),
    formatMetric('GMV变化', record.growth),
    formatMetric('日均销售额', record.averageDailyRevenue),
    formatMetric('日均销量', record.averageDailyUnits),
    formatMetric('库存', record.stock),
    formatMetric('评分', record.rating),
    formatMetric('评价', record.reviews),
    formatMetric('浏览', record.views),
    formatMetric('转化', record.conversion),
    formatMetric('广告占比', record.adSpendShare),
    formatMetric('促销天数', record.promoDays),
    formatMetric('促销折扣', record.promoDiscount),
    formatMetric('促销销售占比', record.promoRevenueShare),
    formatMetric('付费推广天数', record.paidPromotionDays),
    formatMetric('商品卡浏览', record.productCardViews),
    formatMetric('商品卡加购率', record.productCardToCartRate),
    formatMetric('搜索目录浏览', record.searchCatalogViews),
    formatMetric('搜索目录加购率', record.searchCatalogToCartRate),
    formatMetric('展示下单率', record.impressionToOrderRate),
    formatMetric('点击率', record.clickThroughRate),
    formatMetric('发货模式', record.fulfillmentModel),
    formatMetric('核销率', record.redemptionRate),
    formatMetric('退货取消率', record.returnCancelRate),
    formatMetric('包裹尺寸', record.packageDimensions),
    formatMetric('包裹重量', record.packageWeight),
    formatMetric('上架时间', record.listedAt),
    formatMetric('上架天数', record.listingDays),
    formatMetric('跟卖数量', record.followSellerCount),
    formatMetric('跟卖最低价', record.followMinPrice),
    formatMetric('跟卖最高价', record.followMaxPrice),
  ].filter(Boolean);
  return `${index + 1}. ${identity}${metrics.length ? `｜${metrics.join('｜')}` : ''}`;
}

export function buildSmartToolOzonSnapshotSections({
  observerVersion = '',
  datasetLabels = [],
  endpointCount = 0,
  records = [],
  newestCaptureAt = '',
  captureMode = '',
  query = '',
  tokens = [],
  queryMatched = false,
  queryValues = [],
  queryAliases = [],
} = {}) {
  return [
    {
      title: '数据来源与完整性',
      rows: [
        `来源：Ozon 内置浏览器观察器 ${text(observerVersion) || ''}`.trim(),
        `数据集：${datasetLabels.join(' / ')}`,
        `已发现接口：${endpointCount} 个；去重记录：${records.length} 条`,
        newestCaptureAt ? `最近捕获：${newestCaptureAt}` : '最近捕获时间：未返回',
        captureMode === 'product-search' ? `后台查询：${text(query)}` : '',
        tokens.length
          ? queryMatched
            ? `输入筛选命中：${queryValues.join(' / ')}`
            : `输入未精确命中，已回退显示当前数据：${queryValues.join(' / ')}`
          : '未填写筛选词，按最新捕获顺序返回',
        queryAliases.length
          ? `中文查询已展开为俄文同义词：${queryAliases.slice(0, 6).join(' / ')}`
          : '',
      ].filter(Boolean),
    },
    {
      title: `真实数据明细（${records.length} 条）`,
      rows: records.length ? records.map(formatSnapshotRecord) : ['没有可展示的记录。'],
    },
  ];
}
