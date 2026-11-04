export function getProfitActualStatusText(order = {}, afterSalesRows = []) {
  return [
    order.status,
    order.statusLabel,
    order.detailStatus,
    order.ozonStatus,
    order.ozonStatusLabel,
    order.rawStatus,
    order.ozonRawStatus,
    order.rawSubstatus,
    order.rawPostingStatus,
    order.substatus,
    order.afterSalesStatus,
    ...afterSalesRows.flatMap((row) => [row.status, row.type, row.reason]),
    order.raw?.status,
    order.raw?.substatus,
    order.raw?.posting_status,
    order.raw?.postingStatus,
    order.raw?.analytics_data?.status,
    order.raw?.financial_data?.status,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function isProfitFinalZeroAllowedStatus(statusText = '') {
  return /拒收后退款|已退款|退款|关闭订单|已关闭|关闭|已取消|取消|posting_canceled|cancel|canceled|cancelled|not_accepted|refus|reject/.test(
    statusText
  );
}
