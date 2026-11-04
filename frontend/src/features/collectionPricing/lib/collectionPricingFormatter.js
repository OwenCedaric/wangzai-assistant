export function formatPricingMoney(value) {
  if (!Number.isFinite(value)) return '未填写';
  return `¥ ${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
}

export function formatPricingPercent(value) {
  if (!Number.isFinite(value)) return '未填写';
  return `${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}%`;
}

export function buildCollectionPricingCopyText({ collectorDraft, pricingDraft, pricingPreview, listingDraft = {} }) {
  return [
    '# 采集核价草稿',
    '',
    '执行边界：采集、核价和上架都需人工触发；上架必须先预览、后确认、再等待 Ozon 回读。',
    '',
    '## 采集目标',
    `- 关键词/商品：${collectorDraft.keyword || '未填写'}`,
    `- 货源平台：${collectorDraft.sourcePlatform || '未填写'}`,
    `- 货源链接：${collectorDraft.sourceUrl || '未填写'}`,
    `- 竞品链接：${collectorDraft.competitorUrl || '未填写'}`,
    `- 包裹重量：${collectorDraft.weightG ? `${collectorDraft.weightG} g` : '未填写'}`,
    `- 包裹尺寸：${
      collectorDraft.packageLengthCm || collectorDraft.packageWidthCm || collectorDraft.packageHeightCm
        ? `${collectorDraft.packageLengthCm || '-'} × ${collectorDraft.packageWidthCm || '-'} × ${collectorDraft.packageHeightCm || '-'} cm`
        : '未填写'
    }`,
    `- 备注：${collectorDraft.note || '未填写'}`,
    '',
    '## 核价输入',
    `- 采购成本：${pricingDraft.purchaseCost || '未填写'} 元`,
    `- 物流 / 头程：${pricingDraft.firstMileCost || '未填写'} 元`,
    `- 其它成本：${pricingDraft.extraCost || '未填写'} 元`,
    `- Ozon 佣金：${pricingDraft.ozonFeePercent || '未填写'}%`,
    `- 预期利润 / 单：${pricingDraft.expectedProfitCny || '未填写'} 元`,
    `- 当前售价：${pricingDraft.currentPrice || '未填写'} 元`,
    '',
    '## 服务器验签核价',
    `- 总成本：${formatPricingMoney(pricingPreview.totalCost)}`,
    `- 佣金比例：${formatPricingPercent(pricingPreview.feePercent)}`,
    `- 实际利润率：${formatPricingPercent(pricingPreview.currentMargin)}`,
    `- 保本售价：${formatPricingMoney(pricingPreview.breakEvenPrice)}`,
    `- 建议售价：${formatPricingMoney(pricingPreview.suggestedPrice)}`,
    `- 当前价利润：${formatPricingMoney(pricingPreview.currentProfit)}`,
    `- 当前价利润率：${formatPricingPercent(pricingPreview.currentMargin)}`,
    '',
    '## Ozon 上架草稿',
    `- 店铺 ID：${listingDraft.shopId || '未填写'}`,
    `- offer_id：${listingDraft.offerId || '未填写'}`,
    `- 标题：${listingDraft.title || '未填写'}`,
    `- 类目 / 类型：${listingDraft.descriptionCategoryId || '-'} / ${listingDraft.typeId || '-'}`,
    `- 售价 / 划线价 / 最低价（人民币）：${listingDraft.priceCny || listingDraft.price || '-'} / ${listingDraft.oldPriceCny || listingDraft.oldPrice || '-'} / ${listingDraft.minPriceCny || listingDraft.minPrice || '-'}`,
    `- 库存 / 仓库：${listingDraft.stock || '未设置'} / ${listingDraft.warehouseId || '未设置'}`,
  ].join('\n');
}
