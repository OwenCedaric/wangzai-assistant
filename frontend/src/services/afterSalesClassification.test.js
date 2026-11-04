import { describe, expect, it } from 'vitest';
import {
  AFTER_SALES_TYPE_POST_SHIP_CANCEL,
  AFTER_SALES_TYPE_PRE_SHIP_CANCEL,
  AFTER_SALES_TYPE_REJECTED_REFUND,
  AFTER_SALES_TYPE_SIGNED_REFUND,
  classifyAfterSalesOrder,
} from './afterSalesClassification';

describe('after-sales classification', () => {
  it('classifies Utilizing plus buyer refusal and cancelled original order as rejected refund', () => {
    const result = classifyAfterSalesOrder({
      afterSalesRow: {
        reason: 'buyer refused',
        logistics_status: 'Utilizing',
      },
      originalOrderRow: {
        status: 'cancelled',
        substatus: 'not_delivered',
      },
    });

    expect(result.type).toBe(AFTER_SALES_TYPE_REJECTED_REFUND);
    expect(result.typeLabel).toBe('拒收后退款');
    expect(result.reasonZh).toBe('买家拒收');
    expect(result.logisticsStatusZh).toBe('Ozon 处置中');
  });

  it('classifies UtilizedByOzon plus buyer not-picked-up and original cancellation as rejected refund', () => {
    const result = classifyAfterSalesOrder({
      afterSalesRow: {
        return_reason: 'not picked up',
        status: 'UtilizedByOzon',
      },
      originalOrderRow: {
        cancellation: { cancel_reason: '订单已取消' },
        delivery_status: '未签收',
      },
    });

    expect(result.type).toBe(AFTER_SALES_TYPE_REJECTED_REFUND);
    expect(result.typeLabel).toBe('拒收后退款');
    expect(result.reasonZh).toBe('买家未取件');
    expect(result.logisticsStatusZh).toBe('Ozon 已处置/销毁');
  });

  it('classifies not-shipped on-time cancellation as pre-shipment cancellation', () => {
    const result = classifyAfterSalesOrder({
      afterSalesRow: {
        cancellation_reason: 'You did not ship on time',
        status: 'cancelled',
      },
    });

    expect(result.type).toBe(AFTER_SALES_TYPE_PRE_SHIP_CANCEL);
    expect(result.typeLabel).toBe('发货前取消');
    expect(result.reasonZh).toBe('未按时发货');
  });

  it('classifies stockout before shipment as pre-shipment cancellation', () => {
    const result = classifyAfterSalesOrder({
      afterSalesRow: {
        reason: '仓库商品已售完',
        logistics_status: '未发货',
      },
    });

    expect(result.type).toBe(AFTER_SALES_TYPE_PRE_SHIP_CANCEL);
    expect(result.typeLabel).toBe('发货前取消');
    expect(result.reasonZh).toBe('仓库商品已售完');
  });

  it('classifies shipped cancellation without refusal or disposal evidence as post-shipment cancellation', () => {
    const result = classifyAfterSalesOrder({
      afterSalesRow: {
        status: 'cancelled_after_ship',
        delivery_status: 'shipped',
        reason: 'buyer cancelled order',
      },
    });

    expect(result.type).toBe(AFTER_SALES_TYPE_POST_SHIP_CANCEL);
    expect(result.typeLabel).toBe('发货后取消');
  });

  it('classifies delivered orders with finance refund evidence as signed refund', () => {
    const result = classifyAfterSalesOrder({
      afterSalesRow: {
        reason: 'buyer requested refund',
        originalOrderStatus: 'delivered',
        originalOrderDeliveredAt: '2026-06-10T08:00:00Z',
        financeRefundConfirmed: true,
        financeRefundEvidence: {
          checked: true,
          confirmed: true,
          signedRefundConfirmed: true,
        },
      },
    });

    expect(result.type).toBe(AFTER_SALES_TYPE_SIGNED_REFUND);
    expect(result.typeLabel).toBe('签收后退款');
    expect(result.classificationReason).toBe('原订单已签收且财务流水确认退款扣款，按签收后退款处理');
  });

  it('classifies delivered Ozon return records as signed refund without finance evidence', () => {
    const result = classifyAfterSalesOrder({
      afterSalesRow: {
        source: 'rfbs-return',
        return_id: '88788146',
        posting_number: '53034017-0326-1',
        status: 'UtilizedByOzon',
        state: { state: 'UtilizedByOzon', state_name: 'Утилизирован Ozon' },
        originalOrderStatus: 'delivered',
        originalOrderSubstatus: 'posting_received',
        reason: '商品不合适',
      },
    });

    expect(result.type).toBe(AFTER_SALES_TYPE_SIGNED_REFUND);
    expect(result.typeLabel).toBe('签收后退款');
    expect(result.classificationReason).toBe('Ozon 已签收且存在退货/退款记录，按签收后退款处理');
  });

  it('uses a wrong-item return reason as signed delivery evidence when the order cache is still delivering', () => {
    const result = classifyAfterSalesOrder({
      afterSalesRow: {
        source: 'rfbs-return',
        return_id: '94973757',
        posting_number: '91092007-0181-1',
        status: 'returned',
        refundStatus: '已退款给买家',
        return_reason: { name: '配送了错误的商品' },
        originalOrderStatus: 'delivering',
        originalOrderSubstatus: 'posting_in_pickup_point',
      },
    });

    expect(result.type).toBe(AFTER_SALES_TYPE_SIGNED_REFUND);
    expect(result.typeLabel).toBe('签收后退款');
    expect(result.evidenceMap.originalDelivered).toBe('配送了错误的商品');
    expect(result.classificationReason).toBe('退货原因确认买家已收到商品，且存在退货/退款记录，按签收后退款处理');
  });

  it('does not infer signed delivery from a wrong-item reason when refusal evidence is also present', () => {
    const result = classifyAfterSalesOrder({
      afterSalesRow: {
        source: 'rfbs-return',
        return_id: '94973757',
        reason: '配送了错误的商品，买家拒收',
        originalOrderStatus: 'not_delivered',
      },
    });

    expect(result.type).not.toBe(AFTER_SALES_TYPE_SIGNED_REFUND);
    expect(result.evidenceMap.originalDelivered).toBe('');
  });

  it('does not treat generic received evidence as buyer signed delivery', () => {
    const result = classifyAfterSalesOrder({
      afterSalesRow: {
        status: 'cancelled',
        reason: '货件未通过清关',
        originalOrderStatus: 'received',
        financeRefundConfirmed: true,
        financeRefundEvidence: {
          checked: true,
          confirmed: true,
        },
      },
    });

    expect(result.type).not.toBe(AFTER_SALES_TYPE_SIGNED_REFUND);
    expect(result.evidenceMap.originalDelivered).toBe('');
  });

  it('restores refused and disposal evidence without original cancellation as rejected refund', () => {
    const result = classifyAfterSalesOrder({
      afterSalesRow: {
        reason: 'Покупатель отказался при вручении',
        logistics_status: 'UtilizedByOzon',
      },
      originalOrderRow: {
        status: 'awaiting_deliver',
      },
    });

    expect(result.type).toBe(AFTER_SALES_TYPE_REJECTED_REFUND);
    expect(result.typeLabel).toBe('拒收后退款');
    expect(result.needsReadback).toBe(false);
    expect(result.classificationReason).toContain('拒收/拒签或商品销毁/处置');
  });

  it('keeps Russian reasons and English logistics statuses Chinese in the result', () => {
    const result = classifyAfterSalesOrder({
      afterSalesRow: {
        reason: 'Покупатель отказался при вручении',
        logistics_status: 'Utilizing',
      },
      originalOrderRow: {
        status: 'cancelled',
        delivery_status: 'not_delivered',
      },
    });

    expect(result.type).toBe(AFTER_SALES_TYPE_REJECTED_REFUND);
    expect(result.reasonZh).toBe('买家交付时拒收');
    expect(result.logisticsStatusZh).toBe('Ozon 处置中');
  });

  it('does not treat Russian refusal during handover as delivered evidence', () => {
    const result = classifyAfterSalesOrder({
      afterSalesRow: {
        source: 'rfbs-return',
        return_id: 'refused-during-handover',
        reason: 'Покупатель отказался при вручении: товар не подошел',
        status: 'returned',
        originalOrderStatus: 'cancelled',
        originalOrderSubstatus: 'posting_canceled',
        originalOrderDeliveredEvidence: 'Покупатель отказался при вручении: товар не подошел',
        financeRefundConfirmed: true,
        financeRefundEvidence: {
          checked: true,
          confirmed: true,
          signedRefundConfirmed: true,
          hasDeliveredSaleOperation: false,
        },
      },
      originalOrderRow: {
        status: 'cancelled',
        substatus: 'posting_canceled',
        cancellation: {
          cancel_reason: 'Покупатель отказался при вручении: товар не подошел',
        },
      },
    });

    expect(result.type).toBe(AFTER_SALES_TYPE_REJECTED_REFUND);
    expect(result.typeLabel).toBe('拒收后退款');
    expect(result.evidenceMap.originalDelivered).toBe('');
  });

  it('keeps delivered lifecycle authoritative when the return reason also says buyer refusal', () => {
    const result = classifyAfterSalesOrder({
      afterSalesRow: {
        source: 'rfbs-return',
        return_id: 'durably-delivered-return',
        reason: 'Покупатель отказался при вручении',
        status: 'returned',
        originalOrderStatus: 'delivered',
        originalOrderSubstatus: 'posting_received',
        financeRefundConfirmed: true,
        financeRefundEvidence: {
          checked: true,
          confirmed: true,
          signedRefundConfirmed: true,
          hasDeliveredSaleOperation: true,
        },
      },
    });

    expect(result.type).toBe(AFTER_SALES_TYPE_SIGNED_REFUND);
    expect(result.typeLabel).toBe('签收后退款');
    expect(result.evidenceMap.originalDelivered).toMatch(/delivered|posting_received/i);
    expect(result.classificationReason).toContain('签收状态优先于售后原因');
  });

  it('reads a nested original order when the explicit original-order argument is empty', () => {
    const result = classifyAfterSalesOrder({
      afterSalesRow: {
        source: 'rfbs-return',
        return_id: 'nested-delivered-order',
        return_reason: 'Покупатель отказался при вручении: недоволен качеством товара',
        originalOrder: {
          status: 'delivered',
          substatus: 'posting_received',
        },
      },
    });

    expect(result.type).toBe(AFTER_SALES_TYPE_SIGNED_REFUND);
    expect(result.reasonZh).toBe('买家交付时拒收：对商品质量不满意');
  });
});
