import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateCrossBorderOrderCharges,
  createCrossBorderChargePhysicalIdentity,
  inferCrossBorderChargeDirection,
  summarizeCrossBorderLedger,
} from './crossBorderChargeAccounting.js';
import {
  createCrossBorderRechargePolicy,
  resolveCrossBorderCashRate,
} from './crossBorderChargeConversion.js';

test('refund business reasons override the incorrect provider expense type', () => {
  assert.equal(inferCrossBorderChargeDirection({ type: '支出', reason: '退还订单系统服务费', money: 0.1 }), 'income');
  assert.equal(inferCrossBorderChargeDirection({ type: '支出', reason: '取消发货,退回费用', money: 1.5 }), 'income');
  assert.equal(inferCrossBorderChargeDirection({ type: '支出', reason: '订单发货费用', money: 1.5 }), 'expense');
  assert.equal(inferCrossBorderChargeDirection({ type: '支出', reason: '补收费用', money: 4 }), 'expense');
});

test('a fully refunded collection has a real zero actual fee', () => {
  const ledger = summarizeCrossBorderLedger([
    { type: '支出', reason: '订单发货费用', money: 1.5 },
    { type: '支出', reason: '取消发货,退回费用', money: 1.5 },
  ]);
  assert.deepEqual({
    statementCount: ledger.statementCount,
    expenseCny: ledger.expenseCny,
    incomeCny: ledger.incomeCny,
    ledgerNetCny: ledger.ledgerNetCny,
    cashNetCny: ledger.cashNetCny,
    actualFeeCny: ledger.actualFeeCny,
  }, {
    statementCount: 2,
    expenseCny: 1.5,
    incomeCny: 1.5,
    ledgerNetCny: 0,
    cashNetCny: 0,
    actualFeeCny: 0,
  });
});

test('variable recharge gifts use the rate effective at each debit and refund at the original debit rate', () => {
  const policy = createCrossBorderRechargePolicy({
    activeId: 'bus',
    plans: [{
      id: 'bus',
      name: '跨境巴士费用',
      settings: {
        platform: 'crossBorderBus',
        rechargeAmount: '500',
        giftAmount: '100',
        rechargeRateHistory: [
          { id: 'first', effectiveAt: '2026-07-01T00:00:00.000Z', rechargeAmount: '300', giftAmount: '100' },
          { id: 'second', effectiveAt: '2026-08-01T00:00:00.000Z', rechargeAmount: '500', giftAmount: '100' },
        ],
      },
    }],
  }, { updatedAt: '2026-08-01T00:00:00.000Z' });
  const ledger = summarizeCrossBorderLedger([
    { type: '支出', reason: '订单发货费用', money: 1.5, time: '2026-07-20T00:00:00.000Z' },
    { type: '支出', reason: '取消发货,退回费用', money: 1.5, time: '2026-08-02T00:00:00.000Z' },
    { type: '支出', reason: '订单发货费用', money: 1.5, time: '2026-08-03T00:00:00.000Z' },
  ], {
    resolveCashRate: (occurredAt) => resolveCrossBorderCashRate(policy, occurredAt),
  });
  assert.equal(ledger.ledgerNetCny, 1.5);
  assert.equal(ledger.cashExpenseCny, 2.375);
  assert.equal(ledger.cashIncomeCny, 1.125);
  assert.equal(ledger.cashNetCny, 1.25);
  assert.equal(ledger.actualFeeCny, 1.25);
  assert.equal(ledger.conversions[1].allocations[0].source, 'original-expense');
  assert.equal(ledger.conversions[1].allocations[0].rate, 0.75);
});

test('300 paid plus 100 gift converts the screenshot order balance debit 1.60 to cash cost 1.20', () => {
  const policy = createCrossBorderRechargePolicy({
    activeId: 'bus',
    plans: [{ id: 'bus', settings: { platform: 'crossBorderBus', rechargeAmount: '300', giftAmount: '100' } }],
  }, { updatedAt: '2026-07-15T08:32:25.979Z' });
  const ledger = summarizeCrossBorderLedger([
    { type: '支出', reason: '支付订单系统服务费', money: 0.1, time: '1782125509' },
    { type: '支出', reason: '支付订单系统服务费', money: 0.1, time: '1782125792' },
    { type: '支出', reason: '退还订单系统服务费', money: 0.1, time: '1782385826' },
    { type: '支出', reason: '订单发货费用', money: 1.5, time: '1782385826' },
    { type: '支出', reason: '取消发货,退回费用', money: 1.5, time: '1782385840' },
    { type: '支出', reason: '订单发货费用', money: 1.5, time: '1782385840' },
  ], { resolveCashRate: (occurredAt) => resolveCrossBorderCashRate(policy, occurredAt) });
  assert.equal(ledger.ledgerNetCny, 1.6);
  assert.equal(ledger.cashNetCny, 1.2);
  assert.equal(ledger.actualFeeCny, 1.2);
});

test('physical statement identity does not change when a wrong direction is corrected', () => {
  const source = {
    oid: '484189',
    time: '1782385840',
    money: 1.5,
    after_money: 61.7,
    reason: '取消发货,退回费用',
    warehouse: '2311济南七号仓',
    serviceCompany: 'GUOO',
  };
  assert.deepEqual(
    createCrossBorderChargePhysicalIdentity({ ...source, direction: 'expense' }),
    createCrossBorderChargePhysicalIdentity({ ...source, direction: 'income' }),
  );
});

test('multiple collection numbers aggregate once per shop and Ozon order before zero clamping', () => {
  const rows = [
    {
      matchStatus: 'exact', shopId: 'shop-a', ozonOrderKey: 'ORDER-1', postingNumber: 'ORDER-1',
      collectionNumber: '483558', internalOrderId: '49483557', statementCount: 1,
      expenseCny: 0.1, incomeCny: 0, ledgerNetCny: 0.1, actualFeeCny: 0.1,
    },
    {
      matchStatus: 'exact', shopId: 'shop-a', ozonOrderKey: 'ORDER-1', postingNumber: 'ORDER-1',
      collectionNumber: '484189', internalOrderId: '49484188', statementCount: 5,
      expenseCny: 3.1, incomeCny: 1.6, ledgerNetCny: 1.5, actualFeeCny: 1.5,
    },
    {
      matchStatus: 'exact', shopId: 'shop-b', ozonOrderKey: 'ORDER-1', postingNumber: 'ORDER-1',
      collectionNumber: 'other-shop', statementCount: 1,
      expenseCny: 9, incomeCny: 0, ledgerNetCny: 9, actualFeeCny: 9,
    },
  ];
  const groups = aggregateCrossBorderOrderCharges(rows);
  assert.equal(groups.length, 2);
  const shopA = groups.find((row) => row.shopId === 'shop-a');
  assert.equal(shopA.actualFeeCny, 1.6);
  assert.equal(shopA.statementCount, 6);
  assert.deepEqual(shopA.collectionNumbers, ['483558', '484189']);
});
