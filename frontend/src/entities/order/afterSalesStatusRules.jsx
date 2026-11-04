export const AFTER_SALES_REFUSED_REFUND_STATUS = '拒收后退款';

export const AFTER_SALES_SIGNED_REFUND_STATUS = '签收后退款';

export const AFTER_SALES_LEGACY_SIGNED_REFUND_STATUS = AFTER_SALES_SIGNED_REFUND_STATUS;

export const AFTER_SALES_CLASSIFICATION_VERSION = 15;

export const OZON_AFTER_SALES_SNAPSHOT_RULE_VERSION = `rules-v${AFTER_SALES_CLASSIFICATION_VERSION}-return-id-primary-v1`;

export function normalizeAfterSalesStatus(status) {
  return String(status || '').trim();
}

export function isAfterSalesRefundLossStatus(status) {
  return normalizeAfterSalesStatus(status) === AFTER_SALES_REFUSED_REFUND_STATUS;
}

export function isAfterSalesSignedRefundStatus(status) {
  return normalizeAfterSalesStatus(status) === AFTER_SALES_SIGNED_REFUND_STATUS;
}

export function getAfterSalesTone(status) {
  const normalizedStatus = normalizeAfterSalesStatus(status);
  if (normalizedStatus === AFTER_SALES_REFUSED_REFUND_STATUS) return 'success';
  if (normalizedStatus === AFTER_SALES_SIGNED_REFUND_STATUS) return 'error';
  if (normalizedStatus === '发货后取消') return 'error';
  if (normalizedStatus === '发货前取消') return 'warning';
  if (normalizedStatus === '待核对') return 'warning';
  return 'default';
}
