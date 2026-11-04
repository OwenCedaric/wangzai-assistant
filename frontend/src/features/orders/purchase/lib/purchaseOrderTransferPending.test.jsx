import { describe, expect, it } from 'vitest';
import { applyPurchaseTransferPendingOverride } from './purchaseOrderNormalize.jsx';

describe('purchase transfer-to-pending override', () => {
  it('explicitly clears purchase placement aliases while preserving bus and profit evidence', () => {
    const result = applyPurchaseTransferPendingOverride(
      {
        purchasePlatform: '1688',
        manualBuyerPlatform: '1688',
        purchaseOrderNumber: 'purchase-old',
        manualPurchaseOrderNo: 'purchase-old',
        purchaseOrderUrl: 'https://detail.example/purchase-old',
        sourceCostCny: 28.5,
        manualPurchasePrice: '28.5',
        manualPurchaseOrderStatus: '已付款',
        packageOrderId: 'bus-must-remain',
        packageWeight: '0.156 kg',
        manualProfitLogisticsFeeCny: 4.2,
      },
      { purchaseOrderNo: 'purchase-old' }
    );

    expect(result.clearFields).toEqual([
      'purchasePlatform',
      'purchaseOrderNumber',
      'purchaseOrderUrl',
      'sourceCostCny',
      'manualStatus',
    ]);
    [
      'purchasePlatform',
      'manualBuyerPlatform',
      'purchaseOrderNumber',
      'manualPurchaseOrderNo',
      'purchaseOrderUrl',
      'sourceCostCny',
      'manualPurchasePrice',
      'manualPurchaseOrderStatus',
    ].forEach((field) => expect(result).not.toHaveProperty(field));
    expect(result).toMatchObject({
      forcePurchaseStatus: '待拍单',
      purchaseRecordStatus: 'none',
      voidedPurchaseOrderNo: 'purchase-old',
      packageOrderId: 'bus-must-remain',
      packageWeight: '0.156 kg',
      manualProfitLogisticsFeeCny: 4.2,
    });
  });
});
