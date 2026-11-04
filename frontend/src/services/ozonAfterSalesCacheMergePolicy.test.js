import { describe, expect, it } from 'vitest';
import {
  mergeAfterSalesFinanceEvidenceValue,
  normalizeAfterSalesCachedClassificationFields,
  shouldKeepAfterSalesStrongField,
} from './ozonAfterSalesCacheMergePolicy.js';

describe('ozonAfterSalesCacheMergePolicy', () => {
  it('lets fresh after-sales snapshot clear stale signed-refund finance confirmation', () => {
    const currentFields = {
      status: '签收后退款',
      type: '签收后退款',
      classificationVersion: 9,
      originalOrderCancelledEvidence: 'cancelled_after_ship',
      originalOrderDeliveredEvidence: '',
      financeRefundChecked: true,
      financeRefundConfirmed: true,
      financeRefundEvidence: { checked: true, confirmed: true },
    };
    const freshFields = {
      status: '发货后取消',
      type: '发货后取消',
      classificationVersion: 10,
      classificationConfidence: 85,
      originalOrderCancelledEvidence: 'cancelled_after_ship',
      originalOrderDeliveredEvidence: '',
      financeRefundChecked: true,
      financeRefundConfirmed: false,
      financeRefundEvidence: { checked: true, confirmed: false },
    };

    expect(shouldKeepAfterSalesStrongField(currentFields, 'status', freshFields.status)).toBe(false);
    expect(shouldKeepAfterSalesStrongField(currentFields, 'financeRefundConfirmed', false)).toBe(false);
    expect(
      mergeAfterSalesFinanceEvidenceValue(
        currentFields.financeRefundEvidence,
        freshFields.financeRefundEvidence,
        currentFields,
        freshFields
      )
    ).toMatchObject({
      checked: true,
      confirmed: false,
    });
  });

  it('does not keep stale signed-refund status when fresh snapshot has newer classification evidence', () => {
    const currentFields = {
      status: '签收后退款',
      type: '签收后退款',
      classificationVersion: 8,
      originalOrderDeliveredEvidence: 'delivered',
      financeRefundChecked: true,
      financeRefundConfirmed: true,
      financeRefundEvidence: {
        checked: true,
        confirmed: true,
        signedRefundConfirmed: true,
      },
    };

    expect(shouldKeepAfterSalesStrongField(currentFields, 'status', '发货后取消')).toBe(false);
    expect(shouldKeepAfterSalesStrongField(currentFields, 'type', '发货后取消')).toBe(false);
    expect(shouldKeepAfterSalesStrongField(currentFields, 'tone', 'error')).toBe(false);
  });

  it('clears stale after-sales classification evidence when a newer classification omits it', () => {
    const currentFields = {
      status: '发货后取消',
      classificationVersion: 3,
      originalOrderDeliveredEvidence: 'вручен',
    };
    const freshFields = {
      status: '拒收后退款',
      type: '拒收后退款',
      classificationVersion: 4,
      refusedEvidence: 'buyer refused delivery',
      destroyedEvidence: 'Utilized',
      originalOrderCancelledEvidence: 'cancelled_after_ship',
      originalOrderDeliveredEvidence: '',
      financeRefundChecked: true,
      financeRefundConfirmed: true,
      financeRefundEvidence: { checked: true, confirmed: true },
    };

    expect(shouldKeepAfterSalesStrongField(currentFields, 'originalOrderDeliveredEvidence', '')).toBe(false);
    expect(normalizeAfterSalesCachedClassificationFields(freshFields)).toMatchObject({
      changed: false,
      fields: {
        status: '拒收后退款',
        type: '拒收后退款',
        refusedEvidence: 'buyer refused delivery',
        destroyedEvidence: 'Utilized',
        originalOrderCancelledEvidence: 'cancelled_after_ship',
        originalOrderDeliveredEvidence: '',
      },
    });
  });

  it('keeps refused-refund cache rows when refusal or disposal evidence is present', () => {
    const refusedRefund = '\u62d2\u6536\u540e\u9000\u6b3e';

    const normalized = normalizeAfterSalesCachedClassificationFields({
      recordKey: 'shop-a:return-1',
      shopClientId: 'shop-a',
      id: 'return-1',
      status: refusedRefund,
      type: refusedRefund,
      tone: 'success',
      classificationVersion: 5,
      classificationReason: '旧缓存误把处置状态当成拒收后退款',
      refusedEvidence: '',
      destroyedEvidence: 'Utilizing',
      originalOrderCancelledEvidence: '',
      originalOrderDeliveredEvidence: '',
      financeRefundChecked: false,
      financeRefundConfirmed: false,
      products: [],
    });

    expect(normalized.changed).toBe(false);
    expect(normalized.fields).toMatchObject({
      status: refusedRefund,
      type: refusedRefund,
      tone: 'success',
      financeRefundConfirmed: false,
      destroyedEvidence: 'Utilizing',
    });
  });
});
