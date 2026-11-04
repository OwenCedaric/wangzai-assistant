function normalizeText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

export const OZON_RETURN_REASON_LABELS = Object.freeze({
  20: '配件或商品不完整',
  22: '配送了错误的商品',
  32: '商品不合适',
  79: '买家收货时拒收：商品不合适',
  352: '仓库商品已售完',
  402: '卖家取消订单',
  506: '买家取消订单：找到了更便宜的商品',
  505: '买家取消订单：配送时效不符合预期',
  508: '买家取消订单',
  512: '未能配送商品',
  537: '买家未取件',
  578: '买家收货时拒收：商品不合适',
  587: '买家拒收：对商品质量不满意',
  665: '买家未取件',
  685: '买家应您的请求取消订单',
  686: '您未按时发货',
  710: '买家取消订单',
  940: '货件未通过清关',
  992: 'Ozon 检查商品是否符合商品卡描述',
});

export const OZON_RETURN_STATUS_LABELS = Object.freeze({
  Utilizing: 'Ozon 处置中',
  UtilizingByOzon: 'Ozon 处置中',
  Utilized: 'Ozon 已处置/销毁',
  UtilizedByOzon: 'Ozon 已处置/销毁',
  MoneyReturned: '已退款给买家',
  PartialCompensationReturnedByOzon: 'Ozon 已部分补偿',
});

export const OZON_FINANCE_OPERATION_LABELS = Object.freeze({
  MarketplaceRedistributionOfAcquiringOperation: '收单费用调整',
  OperationAgentDeliveredToCustomer: '销售收入',
  OperationMarketplaceAgencyFeeAggregator3PLGlobal: '国际配送服务费',
  MarketplaceRedistributionOfDeliveryServicesOperation: '配送服务费',
  DefectFineCancellation: '错误指数超标：取消罚款',
  ClientReturnAgentOperation: '退货退款',
  SetOffNonResident: '非居民结算调整',
  OperationMarketplaceServicePartialCompensationToClient: '买家部分补偿',
});

export function getOzonReturnReasonId(source = {}) {
  const rawReason = source?.return_reason ?? source?.returnReason ?? source?.raw?.return_reason;
  const reasonId = rawReason && typeof rawReason === 'object'
    ? rawReason.id ?? rawReason.reason_id ?? rawReason.reasonId
    : source?.return_reason_id ?? source?.returnReasonId;
  return normalizeText(reasonId);
}

export function getOzonReturnReasonLabel(source = {}) {
  const reasonId = getOzonReturnReasonId(source);
  return reasonId ? OZON_RETURN_REASON_LABELS[reasonId] || '' : '';
}

export function getOzonReturnStatusCode(source = {}) {
  const state = source?.state;
  return normalizeText(
    (state && typeof state === 'object' ? state.state ?? state.status : state) ??
      source?.status ??
      source?.return_status
  );
}

export function getOzonReturnStatusLabel(source = {}) {
  const code = getOzonReturnStatusCode(source);
  return code ? OZON_RETURN_STATUS_LABELS[code] || '' : '';
}

export function getOzonFinanceOperationLabel(operationType = '', fallback = '') {
  const code = normalizeText(operationType);
  return OZON_FINANCE_OPERATION_LABELS[code] || normalizeText(fallback);
}
