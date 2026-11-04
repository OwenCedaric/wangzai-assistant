export function isMissingAfterSalesReason(value) {
  const text = String(value ?? '').trim();
  return !text || text === '-' || text === '未返回' || text === '待确认' || text === '读取失败';
}

export function isLowPriorityAfterSalesReason(value) {
  const text = String(value ?? '').trim();
  return (
    isMissingAfterSalesReason(text) ||
    text === '其他售后原因' ||
    /财务流水.*(退款|扣款|冲正|核查|证据)|已同时核查母单/.test(text)
  );
}
