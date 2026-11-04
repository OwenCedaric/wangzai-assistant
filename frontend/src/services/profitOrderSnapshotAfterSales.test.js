import { describe, expect, it } from 'vitest';
import { shouldReadAfterSalesOriginalOrderDetail } from '../entities/marketing/marketingOrderFields.jsx';
import {
  dedupeAfterSalesRowsByBusinessKey,
  recalculateAfterSalesMergedClassification,
} from '../entities/order/orderAsyncRules.jsx';
import {
  summarizeAfterSalesRefundFinanceOperations,
  upgradeAfterSalesClassificationRow,
} from '../entities/profit/profitAfterSalesRules.jsx';
import { buildOzonAfterSalesRowsFromCancelledOrderBase } from '../entities/profit/profitAfterSalesSnapshot.jsx';
import { dedupeRowsById, normalizeOzonAfterSalesRow } from '../entities/profit/profitOrderSnapshot.jsx';

describe('profit order after-sales snapshot', () => {
  it('uses Ozon cancelled order cancel reason as the after-sales refund reason', () => {
    const row = normalizeOzonAfterSalesRow(
      {
        posting_number: '49225228-0329-1',
        order_id: '49225228',
        status: 'cancelled',
        substatus: 'posting_canceled',
        cancellation: {
          cancel_reason: '货件未通过清关',
          cancellation_type: 'ozon',
          cancelled_at: '2026-06-19T17:40:00Z',
        },
        products: [
          {
            offer_id: 'mz-cancel-reason-test',
            name: '取消原因测试商品',
            quantity: 1,
            price: '37',
            currency_code: 'CNY',
          },
        ],
      },
      { source: 'order-cancelled', shop: { id: 'shop-a', clientId: 'client-a', name: 'Ozon 1店' } }
    );

    expect(row.salesOrder).toBe('49225228-0329-1');
    expect(row.reason).toBe('货件未通过清关');
    expect(row.note).toBe('货件未通过清关');
    expect(row.raw.cancellation.cancel_reason).toBe('货件未通过清关');
    expect(row.refundStatus).toBe('已退款');
    expect(row.refundTime).toBe('2026-06-19T17:40:00Z');
  });

  it('does not use original posting number as the displayed after-sales id', () => {
    const row = normalizeOzonAfterSalesRow(
      {
        id: '14885060-0318-1',
        posting_number: '14885060-0318-1',
        status: 'Utilizing',
        return_reason: { name: 'Покупатель отказался при вручении: товар не подошел' },
        product: {
          offer_id: 'mz-26050718-475012',
          quantity: 1,
          price: '24',
          currency_code: 'CNY',
        },
      },
      { source: 'rfbs-return', shop: { id: 'shop-a', clientId: 'client-a', name: 'Ozon 1店' } }
    );

    expect(row.id).toBe('posting:14885060-0318-1');
    expect(row.returnId).toBe('');
    expect(row.afterSalesId).toBe('');
    expect(row.salesOrder).toBe('14885060-0318-1');
    expect(row.recordKey).toBe('posting:14885060-0318-1');
  });

  it('keeps multiple cancelled orders without return id as separate rows', () => {
    const rows = [
      normalizeOzonAfterSalesRow(
        {
          posting_number: '96606108-0082-2',
          status: 'cancelled',
          cancellation: { cancel_reason: 'Не удалось доставить заказ', cancellation_type: 'ozon' },
          product: { offer_id: 'wallpaper-a', quantity: 1, price: '61', currency_code: 'CNY' },
        },
        { source: 'order-cancelled', shop: { id: 'shop-a', clientId: 'client-a', name: 'Ozon 1店' } }
      ),
      normalizeOzonAfterSalesRow(
        {
          posting_number: '0215774275-0231-1',
          status: 'cancelled',
          cancellation: { cancel_reason: 'Покупатель отказался при вручении: товар не подошел' },
          product: { offer_id: 'wallpaper-b', quantity: 1, price: '61', currency_code: 'CNY' },
        },
        { source: 'order-cancelled', shop: { id: 'shop-a', clientId: 'client-a', name: 'Ozon 1店' } }
      ),
    ];

    const deduped = dedupeRowsById(rows);
    expect(deduped).toHaveLength(2);
    expect(deduped.map((row) => row.recordKey)).toEqual(['posting:96606108-0082-2', 'posting:0215774275-0231-1']);
  });

  it('keeps cancelled child postings under the same mother posting as separate after-sales rows', () => {
    const rows = ['09362844-0405-1', '09362844-0405-2', '09362844-0405-3'].map((postingNumber) =>
      normalizeOzonAfterSalesRow(
        {
          id: '09362844-0405',
          posting_number: postingNumber,
          status: 'cancelled',
          cancellation: { cancel_reason: '仓库商品已售完', cancellation_type: 'seller' },
          product: { offer_id: `offer-${postingNumber}`, quantity: 1, price: '24', currency_code: 'CNY' },
        },
        { source: 'order-cancelled', shop: { id: 'shop-a', clientId: 'client-a', name: 'Ozon 1店' } }
      )
    );

    expect(rows.every((row) => row.returnId === '')).toBe(true);
    const deduped = dedupeAfterSalesRowsByBusinessKey(rows);
    expect(deduped).toHaveLength(3);
    expect(deduped.map((row) => row.salesOrder)).toEqual([
      '09362844-0405-1',
      '09362844-0405-2',
      '09362844-0405-3',
    ]);
  });

  it('uses matched rFBS return id and reason when a cancelled order has return supplement', () => {
    const rows = buildOzonAfterSalesRowsFromCancelledOrderBase({
      cancelledItems: [
        {
          posting_number: '96606108-0082-2',
          status: 'cancelled',
          cancellation: {
            cancel_reason: '其他售后原因',
            cancelled_after_ship: true,
            cancelled_at: '2026-06-06T08:46:56Z',
          },
          product: {
            offer_id: 'mz-26050917-186129',
            name: 'Обои Синтетические 10 м, 0.5 м',
            quantity: 1,
            price: '61',
            currency_code: 'CNY',
          },
        },
      ],
      rfbsReturnItems: [
        {
          id: '92721057',
          return_id: '92721057',
          returnId: '92721057',
          posting_number: '96606108-0082-2',
          status: 'Utilizing',
          return_reason: { name: 'Не удалось доставить заказ' },
          product: {
            offer_id: 'mz-26050917-186129',
            name: 'Обои Синтетические 10 м, 0.5 м',
            quantity: 1,
            price: '61',
            currency_code: 'CNY',
          },
        },
      ],
      shop: { id: 'shop-a', clientId: 'client-a', name: 'Ozon 1店' },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].salesOrder).toBe('96606108-0082-2');
    expect(rows[0].returnId).toBe('92721057');
    expect(rows[0].afterSalesId).toBe('92721057');
    expect(rows[0].recordKey).toBe('return:92721057:posting:96606108-0082-2');
    expect(rows[0].reason).toBe('未能配送商品');
    expect(rows[0].source).toBe('rfbs-return');
  });

  it('dedupes a stale cancelled row when the refreshed row has a real return id', () => {
    const rows = dedupeAfterSalesRowsByBusinessKey([
      {
        source: 'order-cancelled',
        recordKey: 'posting:96606108-0082-2',
        salesOrder: '96606108-0082-2',
        status: '拒收后退款',
        type: '拒收后退款',
        reason: '其他售后原因',
        classificationVersion: 10,
      },
      {
        source: 'order-cancelled',
        id: '92721057',
        returnId: '92721057',
        return_id: '92721057',
        afterSalesId: '92721057',
        recordKey: 'return:92721057:posting:96606108-0082-2',
        salesOrder: '96606108-0082-2',
        status: '拒收后退款',
        type: '拒收后退款',
        reason: '未能配送商品',
        classificationVersion: 12,
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].returnId).toBe('92721057');
    expect(rows[0].recordKey).toBe('return:92721057:posting:96606108-0082-2');
    expect(rows[0].reason).toBe('未能配送商品');
  });

  it('keeps multiple real return ids under the same posting as separate after-sales rows', () => {
    const rows = dedupeAfterSalesRowsByBusinessKey([
      {
        source: 'rfbs-return',
        id: '84360443',
        returnId: '84360443',
        return_id: '84360443',
        afterSalesId: '84360443',
        recordKey: 'return:84360443:posting:44487710-0160-1',
        salesOrder: '44487710-0160-1',
        status: '?????',
        reason: '????',
      },
      {
        source: 'rfbs-return',
        id: '84360444',
        returnId: '84360444',
        return_id: '84360444',
        afterSalesId: '84360444',
        recordKey: 'return:84360444:posting:44487710-0160-1',
        salesOrder: '44487710-0160-1',
        status: '?????',
        reason: '????',
      },
      {
        source: 'order-cancelled',
        recordKey: 'posting:44487710-0160-1',
        salesOrder: '44487710-0160-1',
        status: '?????',
        reason: '??????',
      },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.returnId).sort()).toEqual(['84360443', '84360444']);
  });

  it('keeps child posting return ids under the same base order as separate after-sales rows', () => {
    const rows = dedupeAfterSalesRowsByBusinessKey([
      {
        source: 'rfbs-return',
        id: '86136070',
        returnId: '86136070',
        return_id: '86136070',
        afterSalesId: '86136070',
        recordKey: 'return:86136070:posting:0161421428-0139-4',
        salesOrder: '0161421428-0139-4',
        status: '?????',
        reason: '????',
      },
      {
        source: 'rfbs-return',
        id: '86136088',
        returnId: '86136088',
        return_id: '86136088',
        afterSalesId: '86136088',
        recordKey: 'return:86136088:posting:0161421428-0139-5',
        salesOrder: '0161421428-0139-5',
        status: '?????',
        reason: '????',
      },
      {
        source: 'order-cancelled',
        recordKey: 'posting:0161421428-0139',
        salesOrder: '0161421428-0139',
        status: '?????',
        reason: '?????',
      },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.returnId).sort()).toEqual(['86136070', '86136088']);
  });

  it('translates Ozon cancelled order customs failure reason returned by the original order', () => {
    const row = normalizeOzonAfterSalesRow(
      {
        posting_number: '49225228-0329-1',
        order_id: '36689417692',
        status: 'cancelled',
        substatus: 'posting_canceled',
        cancellation: {
          cancel_reason_id: 940,
          cancel_reason: 'Отправление не прошло таможенное оформление',
          cancellation_type: 'ozon',
          cancellation_initiator: 'Ozon',
          cancelled_at: '2026-06-19T17:40:00Z',
        },
        products: [
          {
            offer_id: 'mz-26051410-231198',
            name: 'Аптечка для рыбалки',
            quantity: 1,
            price: '37',
            currency_code: 'CNY',
          },
        ],
      },
      { source: 'order-cancelled', shop: { id: 'shop-a', clientId: 'client-a', name: 'Ozon 1店' } }
    );

    expect(row.reason).toBe('货件未通过清关');
    expect(row.note).toBe('货件未通过清关');
    expect(row.refundStatus).toBe('已退款');
    expect(row.refundTime).toBe('2026-06-19T17:40:00Z');
  });

  it('uses original order cancellation evidence over generic after-sales reason', () => {
    const row = normalizeOzonAfterSalesRow(
      {
        return_id: '86777870',
        posting_number: '49225228-0329-1',
        status: 'Utilized',
        state: { state_name: 'Утилизирован' },
        reason: '其他售后原因',
        originalOrderStatus: 'cancelled',
        originalOrderSubstatus: 'posting_canceled',
        originalOrderCancellationReason: 'Отправление не прошло таможенное оформление',
        originalOrderCancellation: {
          cancel_reason_id: 940,
          cancel_reason: 'Отправление не прошло таможенное оформление',
          cancellation_type: 'ozon',
          cancellation_initiator: 'Ozon',
          cancelled_at: '2026-06-19T17:40:00Z',
        },
        product: {
          offer_id: 'mz-26051410-231198',
          name: 'Аптечка для рыбалки',
          quantity: 1,
          price: '37',
          currency_code: 'CNY',
        },
      },
      { source: 'rfbs-return', shop: { id: 'shop-a', clientId: 'client-a', name: 'Ozon 1店' } }
    );

    expect(row.reason).toBe('货件未通过清关');
    expect(row.refundStatus).toBe('已退款');
    expect(row.refundTime).toBe('2026-06-19T17:40:00Z');
  });

  it('classifies rFBS return rows as signed refund when original order evidence says delivered', () => {
    const row = normalizeOzonAfterSalesRow(
      {
        return_id: '90652048',
        posting_number: '75064957-0486-1',
        status: 'returned',
        state: { state_name: 'Returned' },
        reason: '买家取消',
        originalOrderStatus: 'delivered',
        originalOrderDeliveredAt: '2026-06-10T08:00:00Z',
        product: {
          offer_id: 'mz-rfbs-keep-test',
          name: 'rFBS 已签收售后商品',
          quantity: 1,
          price: '10',
          currency_code: 'CNY',
        },
      },
      { source: 'rfbs-return', shop: { id: 'shop-a', clientId: 'client-a', name: 'Ozon 1店' } }
    );

    expect(row.status).toBe('签收后退款');
    expect(row.excludeFromAfterSales).toBe(false);
    expect(row.classificationReason).toBe('Ozon 已签收且存在退货/退款记录，按签收后退款处理');
  });

  it('classifies wrong-item return 94973757 as signed refund when the cached order is still delivering', () => {
    const row = normalizeOzonAfterSalesRow(
      {
        return_id: '94973757',
        posting_number: '91092007-0181-1',
        status: 'returned',
        state: { state: 'MoneyReturned', state_name: 'Деньги возвращены' },
        return_reason: { name: 'Привезли не тот товар' },
        originalOrderStatus: 'delivering',
        originalOrderSubstatus: 'posting_in_pickup_point',
        product: {
          offer_id: 'mzr-20260506-575191965-4884',
          name: 'Чехол на iphone XR',
          quantity: 1,
          price: '24',
          currency_code: 'CNY',
        },
      },
      { source: 'rfbs-return', shop: { id: 'shop-a', clientId: 'client-a', name: 'Ozon 1店' } }
    );

    expect(row.status).toBe('签收后退款');
    expect(row.reason).toBe('配送了错误的商品');
    expect(row.refundStatus).toBe('已退款给买家');
    expect(row.originalOrderDeliveredEvidence).toBe('Привезли не тот товар');
    expect(row.classificationReason).toBe('退货原因确认买家已收到商品，且存在退货/退款记录，按签收后退款处理');
  });

  it('upgrades a version 12 cached wrong-item return to signed refund', () => {
    const row = upgradeAfterSalesClassificationRow({
      id: '94973757',
      returnId: '94973757',
      return_id: '94973757',
      salesOrder: '91092007-0181-1',
      source: 'rfbs-return',
      status: '发货后取消',
      type: '发货后取消',
      reason: '配送了错误的商品',
      refundStatus: '已退款给买家',
      originalOrderStatus: 'delivering',
      originalOrderSubstatus: 'posting_in_pickup_point',
      classificationVersion: 12,
      raw: {
        return_id: '94973757',
        posting_number: '91092007-0181-1',
        status: 'returned',
        return_reason: { name: 'Привезли не тот товар' },
        originalOrderStatus: 'delivering',
        originalOrderSubstatus: 'posting_in_pickup_point',
      },
    });

    expect(row.status).toBe('签收后退款');
    expect(row.classificationVersion).toBe(15);
  });

  it('classifies delivered rows with confirmed finance return evidence as signed refund', () => {
    const row = normalizeOzonAfterSalesRow(
      {
        return_id: '90652048',
        posting_number: '75064957-0486-1',
        status: 'returned',
        state: { state_name: 'Returned' },
        reason: '买家申请退款',
        originalOrderStatus: 'delivered',
        originalOrderDeliveredAt: '2026-06-10T08:00:00Z',
        financeRefundConfirmed: true,
        financeRefundEvidence: {
          checked: true,
          confirmed: true,
          signedRefundConfirmed: true,
          reason: '财务流水已出现签收销售和退款扣款证据',
        },
        product: {
          offer_id: 'mz-signed-refund-test',
          name: '签收后退款商品',
          quantity: 1,
          price: '10',
          currency_code: 'CNY',
        },
      },
      { source: 'rfbs-return', shop: { id: 'shop-a', clientId: 'client-a', name: 'Ozon 1店' } }
    );

    expect(row.status).toBe('签收后退款');
    expect(row.excludeFromAfterSales).toBe(false);
    expect(row.classificationReason).toBe('原订单已签收且财务流水确认退款扣款，按签收后退款处理');
  });

  it('keeps the Ozon return reason above finance evidence wording for signed refunds', () => {
    const row = normalizeOzonAfterSalesRow(
      {
        return_id: '90652048',
        posting_number: '75064957-0486-1',
        status: 'returned',
        state: { state_name: 'Returned' },
        reason: '财务流水已出现签收销售和退款扣款证据',
        return_reason: { name: '配送了错误的商品' },
        originalOrderStatus: 'delivered',
        originalOrderDeliveredAt: '2026-06-10T08:00:00Z',
        financeRefundConfirmed: true,
        financeRefundEvidence: {
          checked: true,
          confirmed: true,
          signedRefundConfirmed: true,
          reason: '财务流水已出现签收销售和退款扣款证据',
        },
        product: {
          offer_id: 'mz-signed-refund-reason-test',
          name: '签收后退款原因优先级商品',
          quantity: 1,
          price: '22',
          currency_code: 'CNY',
        },
      },
      { source: 'rfbs-return', shop: { id: 'shop-a', clientId: 'client-a', name: 'Ozon 1店' } }
    );

    expect(row.status).toBe('签收后退款');
    expect(row.reason).toBe('配送了错误的商品');
    expect(row.classificationReason).toBe('原订单已签收且财务流水确认退款扣款，按签收后退款处理');
  });

  it('upgrades cached finance evidence wording back to the real Ozon return reason', () => {
    const row = upgradeAfterSalesClassificationRow({
      id: '90652048',
      returnId: '90652048',
      salesOrder: '75064957-0486-1',
      status: '签收后退款',
      type: '签收后退款',
      reason: '财务流水已出现签收销售和退款扣款证据；已同时核查母单 75064957-0486',
      return_reason: { name: '配送了错误的商品' },
      classificationVersion: 10,
      financeRefundConfirmed: true,
      financeRefundEvidence: {
        checked: true,
        confirmed: true,
        signedRefundConfirmed: true,
        reason: '财务流水已出现签收销售和退款扣款证据；已同时核查母单 75064957-0486',
      },
      raw: {
        return_id: '90652048',
        posting_number: '75064957-0486-1',
        return_reason: { name: '配送了错误的商品' },
      },
    });

    expect(row.reason).toBe('配送了错误的商品');
    expect(row.status).toBe('签收后退款');
  });

  it('does not classify Ozon generic received status as signed refund', () => {
    const row = normalizeOzonAfterSalesRow(
      {
        posting_number: '49225228-0329-1',
        order_id: '36689417692',
        status: 'cancelled',
        originalOrderStatus: 'received',
        financeRefundConfirmed: true,
        financeRefundEvidence: {
          checked: true,
          confirmed: true,
        },
        cancellation: {
          cancel_reason: 'Отправление не прошло таможенное оформление',
          cancellation_type: 'ozon',
          cancelled_at: '2026-06-19T17:40:00Z',
        },
        products: [
          {
            offer_id: 'mz-26051410-231198',
            name: 'Аптечка для рыбалки',
            quantity: 1,
            price: '37',
            currency_code: 'CNY',
          },
        ],
      },
      { source: 'order-cancelled', shop: { id: 'shop-a', clientId: 'client-a', name: 'Ozon 1店' } }
    );

    expect(row.status).not.toBe('签收后退款');
    expect(row.originalOrderDeliveredEvidence).toBe('');
    expect(row.reason).toBe('货件未通过清关');
  });

  it('does not treat acquiring redistribution as after-sales refund finance confirmation', () => {
    const summary = summarizeAfterSalesRefundFinanceOperations([
      {
        operation_type: 'MarketplaceRedistributionOfAcquiringOperation',
        operation_type_name: 'MarketplaceRedistributionOfAcquiringOperation',
        amount: -7.3,
        services: [{ name: 'MarketplaceRedistributionOfAcquiringOperation', price: -7.3 }],
      },
      {
        operation_type: 'MarketplaceRedistributionOfAcquiringOperation',
        operation_type_name: 'MarketplaceRedistributionOfAcquiringOperation',
        amount: 7.3,
        services: [{ name: 'MarketplaceRedistributionOfAcquiringOperation', price: 7.3 }],
      },
    ]);

    expect(summary.checked).toBe(true);
    expect(summary.confirmed).toBe(false);
    expect(summary.signedRefundConfirmed).toBe(false);
    expect(summary.hasAcquiringRedistributionOnly).toBe(true);
  });

  it('marks partial buyer compensation in finance evidence without confirming a full refund loop', () => {
    const summary = summarizeAfterSalesRefundFinanceOperations([
      {
        operation_type: 'OperationAgentDeliveredToCustomer',
        operation_type_name: 'Доставка покупателю',
        accruals_for_sale: 393,
        sale_commission: -47.16,
        amount: 345.84,
      },
      {
        operation_type: 'OperationMarketplaceServicePartialCompensationToClient',
        operation_type_name: 'Частичная компенсация покупателю',
        amount: -109,
      },
    ]);

    expect(summary.checked).toBe(true);
    expect(summary.confirmed).toBe(false);
    expect(summary.buyerCompensationConfirmed).toBe(true);
    expect(summary.buyerCompensationAmount).toBe(-109);
    expect(summary.buyerCompensationStatus).toBe('已补偿买家');
  });

  it('recalculates old cached rFBS return rows so they are no longer hidden', () => {
    const row = recalculateAfterSalesMergedClassification({
      salesOrder: '75064957-0486-1',
      source: 'rfbs-return',
      status: '发货后取消',
      excludeFromAfterSales: true,
      raw: {
        source: 'rfbs-return',
        posting_number: '75064957-0486-1',
        originalOrderStatus: 'delivered',
        originalOrderDeliveredAt: '2026-06-10T08:00:00Z',
      },
      originalOrderStatus: 'delivered',
      originalOrderDeliveredAt: '2026-06-10T08:00:00Z',
    });

    expect(row.status).toBe('签收后退款');
    expect(row.excludeFromAfterSales).toBe(false);
    expect(row.classificationReason).toBe('Ozon 已签收且存在退货/退款记录，按签收后退款处理');
  });

  it('classifies delivered Ozon return records as signed refund without requiring finance deduction rows', () => {
    const cases = [
      {
        return_id: '88421705',
        posting_number: '09869141-0270-1',
        status: 'UtilizingByOzon',
        state: { state: 'UtilizingByOzon', state_name: 'На утилизации Ozon' },
        originalOrderStatus: 'delivered',
        originalOrderSubstatus: 'posting_received',
        product: {
          offer_id: 'mz-26050513-463952',
          name: '09869141 签收后退货商品',
          quantity: 2,
          price: '25',
          currency_code: 'CNY',
        },
      },
      {
        return_id: '88788146',
        posting_number: '53034017-0326-1',
        status: 'UtilizedByOzon',
        state: { state: 'UtilizedByOzon', state_name: 'Утилизирован Ozon' },
        originalOrderStatus: 'delivered',
        originalOrderSubstatus: 'posting_received',
        product: {
          offer_id: 'mz-26051116-219911',
          name: '53034017 签收后退货商品',
          quantity: 1,
          price: '78',
          currency_code: 'CNY',
        },
      },
      {
        return_id: '90405404',
        posting_number: '0228223894-0179-1',
        status: 'PartialCompensationReturnedByOzon',
        state: { state: 'PartialCompensationReturnedByOzon', state_name: 'Компенсировали покупателю' },
        originalOrderStatus: 'delivered',
        originalOrderSubstatus: 'posting_received',
        product: {
          offer_id: 'mz-26050815-555538',
          name: '0228223894 签收后退货商品',
          quantity: 1,
          price: '37',
          currency_code: 'CNY',
        },
      },
    ];

    const rows = cases.map((item) =>
      normalizeOzonAfterSalesRow(item, {
        source: 'rfbs-return',
        shop: { id: 'shop-a', clientId: 'client-a', name: 'Ozon 1店' },
      })
    );

    expect(rows.map((row) => row.salesOrder)).toEqual(['09869141-0270-1', '53034017-0326-1', '0228223894-0179-1']);
    expect(rows.every((row) => row.status === '签收后退款')).toBe(true);
    expect(rows.every((row) => row.classificationReason === 'Ozon 已签收且存在退货/退款记录，按签收后退款处理')).toBe(
      true
    );
  });

  it('keeps delivered status above a refusal reason and preserves the complete translated Ozon reason', () => {
    const row = normalizeOzonAfterSalesRow(
      {
        return_id: '88421705',
        posting_number: '09869141-0270-1',
        status: 'UtilizingByOzon',
        return_reason: {
          name: 'Покупатель отказался при вручении: неполная комплектация',
        },
        originalOrderStatus: 'delivered',
        originalOrderSubstatus: 'posting_received',
      },
      { source: 'rfbs-return', shop: { id: 'shop-a', clientId: 'client-a', name: 'Ozon 1店' } }
    );

    expect(row.status).toBe('签收后退款');
    expect(row.reason).toBe('买家交付时拒收：商品配件不全');
    expect(row.reasonRaw).toBe('Покупатель отказался при вручении: неполная комплектация');
    expect(row.classificationReason).toContain('签收状态优先于售后原因');
  });

  it('returns the complete Ozon quality reason instead of collapsing it to buyer refusal', () => {
    const row = normalizeOzonAfterSalesRow(
      {
        return_id: '89387592',
        posting_number: '75932990-1216-1',
        status: 'UtilizedByOzon',
        return_reason: {
          name: 'Покупатель отказался при вручении: недоволен качеством товара',
        },
      },
      { source: 'rfbs-return', shop: { id: 'shop-a', clientId: 'client-a', name: 'Ozon 1店' } }
    );

    expect(row.reason).toBe('买家交付时拒收：对商品质量不满意');
    expect(row.reasonRaw).toBe('Покупатель отказался при вручении: недоволен качеством товара');
  });

  it('upgrades an older generic cached reason from the complete Ozon source reason', () => {
    const row = upgradeAfterSalesClassificationRow({
      classificationVersion: 14,
      source: 'rfbs-return',
      return_id: '89387592',
      salesOrder: '75932990-1216-1',
      reason: '买家拒收',
      raw: {
        source: 'rfbs-return',
        return_id: '89387592',
        posting_number: '75932990-1216-1',
        return_reason: {
          name: 'Покупатель отказался при вручении: недоволен качеством товара',
        },
      },
    });

    expect(row.classificationVersion).toBe(15);
    expect(row.reason).toBe('买家交付时拒收：对商品质量不满意');
    expect(row.reasonRaw).toBe('Покупатель отказался при вручении: недоволен качеством товара');
  });

  it('maps Ozon card-description cancellation reason instead of falling back to other reason', () => {
    const row = normalizeOzonAfterSalesRow(
      {
        posting_number: '0247852266-0066-1',
        order_id: '36363723306',
        status: 'cancelled',
        substatus: 'posting_canceled',
        cancellation: {
          cancel_reason_id: 992,
          cancel_reason: 'Проверка товара на соответствие описанию в карточке',
          cancellation_type: 'ozon',
          cancellation_initiator: 'Ozon',
          cancelled_at: '2026-05-16T09:52:00Z',
        },
        products: [
          {
            offer_id: 'mz-26050511-554618',
            name: '2026Эксклюзивный держатель',
            quantity: 1,
            price: '48.73',
            currency_code: 'CNY',
          },
        ],
      },
      { source: 'order-cancelled', shop: { id: 'shop-a', clientId: 'client-a', name: 'Ozon 1店' } }
    );

    expect(row.reason).toBe('Ozon 检查商品是否符合商品卡描述');
    expect(row.reason).not.toBe('其他售后原因');
  });

  it('uses real return rows as primary rows and keeps cancelled orders only as fallback', () => {
    const rows = buildOzonAfterSalesRowsFromCancelledOrderBase({
      shop: { id: 'shop-a', clientId: 'client-a', name: 'Ozon 1?' },
      cancelledItems: [
        {
          posting_number: '49225228-0329-1',
          order_id: '36689417692',
          status: 'cancelled',
          substatus: 'posting_canceled',
          cancellation: {
            cancel_reason_id: 940,
            cancel_reason: '??????????? ?? ?????? ?????????? ??????????',
            cancellation_type: 'ozon',
            cancellation_initiator: 'Ozon',
            cancelled_at: '2026-06-19T17:40:00Z',
          },
          products: [
            {
              offer_id: 'mz-26051410-231198',
              name: '??????? ??? ???????',
              quantity: 1,
              price: '37',
              currency_code: 'CNY',
            },
          ],
        },
        {
          posting_number: '0247852266-0066-1',
          order_id: '36363723306',
          status: 'cancelled',
          substatus: 'posting_canceled',
          cancellation: {
            cancel_reason_id: 992,
            cancel_reason: '???????? ?????? ?? ???????????? ???????? ? ????????',
            cancellation_type: 'ozon',
            cancelled_at: '2026-05-16T09:52:00Z',
          },
        },
      ],
      returnItems: [
        {
          return_id: '86777870',
          posting_number: '49225228-0329-1',
          status: 'Utilized',
          state: { state_name: '????????????' },
          reason: '??????',
        },
      ],
      rfbsReturnItems: [],
      conditionalItems: [],
    });

    expect(rows).toHaveLength(2);

    const returnRow = rows.find((row) => row.returnId === '86777870');
    const fallbackRow = rows.find((row) => row.salesOrder === '0247852266-0066-1');

    expect(returnRow?.source).toBe('returns');
    expect(returnRow?.salesOrder).toBe('49225228-0329-1');
    expect(fallbackRow?.source).toBe('order-cancelled');
  });

  it('keeps unmatched return rows when Ozon cancelled orders do not contain the same posting', () => {
    const rows = buildOzonAfterSalesRowsFromCancelledOrderBase({
      shop: { id: 'shop-a', clientId: 'client-a', name: 'Ozon 1店' },
      cancelledItems: [
        {
          posting_number: '49225228-0329-1',
          status: 'cancelled',
          cancellation: { cancel_reason: 'Отправление не прошло таможенное оформление' },
        },
      ],
      returnItems: [
        {
          return_id: 'return-only-1',
          posting_number: '11111111-0001-1',
          status: 'Utilized',
          state: { state_name: 'Утилизирован' },
          reason: '买家拒收',
        },
      ],
    });

    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.salesOrder === '49225228-0329-1')?.source).toBe('order-cancelled');
    expect(rows.find((row) => row.salesOrder === '11111111-0001-1')?.source).toBe('returns');
  });

  it('checks original order evidence for rFBS returns even when Ozon already returns a reason', () => {
    const row = normalizeOzonAfterSalesRow(
      {
        return_id: '88788146',
        posting_number: '53034017-0326-1',
        state: { state: 'UtilizedByOzon', state_name: '已由 Ozon 销毁' },
        return_reason: { name: '商品不合适' },
        products: [
          {
            offer_id: 'mz-26051116-219911',
            name: '签收后退货测试商品',
            quantity: 1,
            price: '78',
            currency_code: 'CNY',
          },
        ],
      },
      { source: 'rfbs-return', shop: { id: 'shop-a', clientId: 'client-a', name: 'Ozon 1店' } }
    );

    expect(row.reason).toBe('商品不合适');
    expect(shouldReadAfterSalesOriginalOrderDetail(row)).toBe(true);
  });
});
