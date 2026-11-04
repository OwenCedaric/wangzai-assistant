import { describe, expect, it } from 'vitest';
import {
  doesProfitOrderMatchTab,
  getProfitOrderActualValue,
  getProfitOrderBestValue,
  getProfitOrderEstimatedValue,
  getProfitOrderProfitLossInfo,
  getProfitOrderProfitLossValue,
  getProfitTabCount,
  hasProfitCalculationResult,
  sortProfitOrdersByPaymentDateDesc,
} from './profitOrderView.js';

describe('profitOrderView', () => {
  const rows = [
    { id: 'raw-only' },
    { id: 'estimated-profit', estimatedProfitValue: 47.18, profitLossValue: 47.18 },
    { id: 'estimated-zero', estimatedProfitValue: 0, profitLossValue: 0 },
    { id: 'actual-loss', actualProfitValue: -6.5, profitLossValue: -6.5 },
  ];

  it('keeps mixed calculation on the full order list', () => {
    expect(getProfitTabCount(rows, 'all', 'mixed')).toBe(4);
    expect(doesProfitOrderMatchTab(rows[0], 'all', 'mixed')).toBe(true);
    expect(doesProfitOrderMatchTab(rows[1], 'all', 'mixed')).toBe(true);
  });

  it('keeps estimated, actual, profit, and loss tabs on their own value sources', () => {
    expect(getProfitTabCount(rows, 'estimated', 'mixed')).toBe(2);
    expect(getProfitTabCount(rows, 'actual', 'mixed')).toBe(1);
    expect(getProfitTabCount(rows, 'profit', 'mixed')).toBe(1);
    expect(getProfitTabCount(rows, 'loss', 'mixed')).toBe(1);
  });

  it('allows closed orders to show actual loss when the ledger is finalized', () => {
    const closedLossOrder = {
      id: 'closed-loss',
      status: '关闭订单',
      profitLedger: {
        results: {
          actualProfitCny: { status: 'ready', value: -7.7 },
          bestProfitCny: { status: 'ready', value: -7.7 },
        },
      },
    };

    expect(getProfitOrderActualValue(closedLossOrder)).toBe(-7.7);
    expect(getProfitOrderBestValue(closedLossOrder)).toBe(-7.7);
    expect(getProfitTabCount([closedLossOrder], 'actual', 'mixed')).toBe(1);
    expect(getProfitTabCount([closedLossOrder], 'loss', 'mixed')).toBe(1);
    expect(doesProfitOrderMatchTab(closedLossOrder, 'loss', 'mixed')).toBe(true);
  });

  it('uses the active non-mixed calculation mode for comprehensive all counts', () => {
    expect(hasProfitCalculationResult(rows[1], 'actual')).toBe(false);
    expect(hasProfitCalculationResult(rows[3], 'actual')).toBe(true);
    expect(getProfitTabCount(rows, 'all', 'actual')).toBe(1);
    expect(getProfitTabCount(rows, 'all', 'estimated')).toBe(2);
  });

  it('does not treat pending placeholders as zero-profit results', () => {
    const pendingRows = [
      { id: 'pending-cn', estimatedProfitValue: '待确认', actualProfitValue: '未返回', profitLossValue: '' },
      { id: 'pending-text', estimatedProfitValue: '读取失败', actualProfitValue: 'pending', profitLossValue: '待确认' },
    ];

    expect(getProfitTabCount(pendingRows, 'estimated', 'mixed')).toBe(0);
    expect(getProfitTabCount(pendingRows, 'actual', 'mixed')).toBe(0);
    expect(getProfitTabCount(pendingRows, 'profit', 'mixed')).toBe(0);
    expect(getProfitTabCount(pendingRows, 'loss', 'mixed')).toBe(0);
    expect(hasProfitCalculationResult(pendingRows[0], 'estimated')).toBe(false);
  });

  it('uses profit ledger values even when copied display fields are missing', () => {
    const ledgerOnly = {
      id: 'ledger-only',
      profitLedger: {
        results: {
          estimatedProfitCny: { status: 'ready', value: 8.25 },
          actualProfitCny: { status: 'pending', value: null },
          bestProfitCny: { status: 'ready', value: 8.25 },
        },
      },
    };

    expect(getProfitOrderEstimatedValue(ledgerOnly)).toBe(8.25);
    expect(getProfitOrderActualValue(ledgerOnly)).toBeNull();
    expect(getProfitOrderBestValue(ledgerOnly)).toBe(8.25);
    expect(getProfitTabCount([ledgerOnly], 'estimated', 'mixed')).toBe(1);
    expect(getProfitTabCount([ledgerOnly], 'profit', 'mixed')).toBe(1);
    expect(doesProfitOrderMatchTab(ledgerOnly, 'all', 'estimated')).toBe(true);
  });

  it('ignores dirty pending ledger result values from old cache', () => {
    const dirtyPending = {
      id: 'dirty-pending',
      profitLedger: {
        results: {
          estimatedProfitCny: { status: 'pending', value: 11 },
          actualProfitCny: { status: 'pending', value: -2 },
          bestProfitCny: { status: 'pending', value: 9 },
        },
      },
    };

    expect(getProfitOrderEstimatedValue(dirtyPending)).toBeNull();
    expect(getProfitOrderActualValue(dirtyPending)).toBeNull();
    expect(getProfitOrderBestValue(dirtyPending)).toBeNull();
    expect(getProfitTabCount([dirtyPending], 'estimated', 'mixed')).toBe(0);
    expect(getProfitTabCount([dirtyPending], 'actual', 'mixed')).toBe(0);
    expect(getProfitTabCount([dirtyPending], 'profit', 'mixed')).toBe(0);
  });

  it('does not fall back to stale copied actual values when ledger marks actual profit pending', () => {
    const shippingOrder = {
      id: 'shipping-with-stale-actual',
      actualProfitValue: 11.56,
      actualProfit: '+ ¥11.56',
      profitLossValue: 11.56,
      profitLedger: {
        results: {
          estimatedProfitCny: { status: 'ready', value: 2.66 },
          actualProfitCny: { status: 'pending', value: null, reason: '订单未完成，实际利润待确认' },
          bestProfitCny: { status: 'ready', value: 2.66 },
        },
      },
    };

    expect(getProfitOrderEstimatedValue(shippingOrder)).toBe(2.66);
    expect(getProfitOrderActualValue(shippingOrder)).toBeNull();
    expect(getProfitOrderBestValue(shippingOrder)).toBe(2.66);
    expect(getProfitTabCount([shippingOrder], 'actual', 'mixed')).toBe(0);
    expect(doesProfitOrderMatchTab(shippingOrder, 'actual', 'mixed')).toBe(false);
  });

  it('does not fall back to stale copied best values when ledger marks best profit pending', () => {
    const pendingOrder = {
      id: 'pending-with-stale-best',
      actualProfitValue: 9,
      profitLossValue: 9,
      profitLedger: {
        results: {
          actualProfitCny: { status: 'pending', value: null },
          bestProfitCny: { status: 'pending', value: null },
        },
      },
    };

    expect(getProfitOrderActualValue(pendingOrder)).toBeNull();
    expect(getProfitOrderBestValue(pendingOrder)).toBeNull();
    expect(getProfitTabCount([pendingOrder], 'profit', 'mixed')).toBe(0);
    expect(hasProfitCalculationResult(pendingOrder, 'actual')).toBe(false);
  });

  it('prefers ledger values over stale copied order fields', () => {
    const row = {
      id: 'stale-copy',
      estimatedProfitValue: 1,
      actualProfitValue: 2,
      profitLossValue: 3,
      profitLedger: {
        results: {
          estimatedProfitCny: { status: 'ready', value: 11 },
          actualProfitCny: { status: 'ready', value: 12 },
          bestProfitCny: { status: 'ready', value: 13 },
        },
      },
    };

    expect(getProfitOrderEstimatedValue(row)).toBe(11);
    expect(getProfitOrderActualValue(row)).toBe(12);
    expect(getProfitOrderBestValue(row)).toBe(13);
  });

  it('uses actual profit for displayed profit/loss and falls back to estimated with a source marker', () => {
    const actualReady = {
      id: 'actual-ready',
      profitLedger: {
        results: {
          estimatedProfitCny: { status: 'ready', value: 50 },
          actualProfitCny: { status: 'ready', value: -4.5 },
          bestProfitCny: { status: 'ready', value: 50 },
        },
      },
    };
    const estimatedFallback = {
      id: 'estimated-fallback',
      profitLedger: {
        results: {
          estimatedProfitCny: { status: 'ready', value: 12.3 },
          actualProfitCny: { status: 'pending', value: null },
          bestProfitCny: { status: 'ready', value: 12.3 },
        },
      },
    };

    expect(getProfitOrderProfitLossValue(actualReady)).toBe(-4.5);
    expect(getProfitOrderProfitLossInfo(actualReady)).toMatchObject({
      value: -4.5,
      source: 'actual',
      isEstimatedFallback: false,
    });
    expect(getProfitOrderProfitLossValue(estimatedFallback)).toBe(12.3);
    expect(getProfitOrderProfitLossInfo(estimatedFallback)).toMatchObject({
      value: 12.3,
      source: 'estimated',
      isEstimatedFallback: true,
    });
  });

  it('sorts profit rows by original payment time instead of recent completion or cache update time', () => {
    const sorted = sortProfitOrdersByPaymentDateDesc([
      {
        id: 'old-completed-recently',
        paymentDate: '2026-05-10T09:00:00.000Z',
        updatedAt: '2026-06-27T12:00:00.000Z',
      },
      {
        id: 'newer-order',
        paymentDate: '2026-06-10T15:41:02.000Z',
        updatedAt: '2026-06-11T12:00:00.000Z',
      },
      {
        id: 'same-parent-3',
        paymentDate: '2026-06-10T15:41:02.000Z',
        posting: '0122157650-0182-3',
      },
      {
        id: 'same-parent-1',
        paymentDate: '2026-06-10T15:41:02.000Z',
        posting: '0122157650-0182-1',
      },
    ]);

    expect(sorted.map((row) => row.id)).toEqual([
      'same-parent-1',
      'same-parent-3',
      'newer-order',
      'old-completed-recently',
    ]);
  });
});
