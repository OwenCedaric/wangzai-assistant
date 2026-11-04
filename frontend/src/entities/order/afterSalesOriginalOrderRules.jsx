export function hasAfterSalesOriginalOrderCheck(row = {}) {
  const raw = row.raw && typeof row.raw === 'object' ? row.raw : {};
  return Boolean(
    row.originalOrder ||
    raw.originalOrder ||
    row.originalOrderDetail ||
    raw.originalOrderDetail ||
    row.originalOrderStatus ||
    raw.originalOrderStatus ||
    row.originalOrderSubstatus ||
    raw.originalOrderSubstatus ||
    row.originalOrderDeliveredAt ||
    raw.originalOrderDeliveredAt ||
    row.originalOrderCancellation ||
    raw.originalOrderCancellation ||
    row.originalOrderCancelledEvidence ||
    raw.originalOrderCancelledEvidence ||
    row.originalOrderDeliveredEvidence ||
    raw.originalOrderDeliveredEvidence ||
    row.originalOrderEvidenceChecked ||
    raw.originalOrderEvidenceChecked ||
    Object.prototype.hasOwnProperty.call(row, 'originalOrderCancelledAfterShip') ||
    Object.prototype.hasOwnProperty.call(raw, 'originalOrderCancelledAfterShip')
  );
}
