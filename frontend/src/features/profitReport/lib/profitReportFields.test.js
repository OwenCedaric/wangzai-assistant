import { describe, expect, it } from 'vitest';

import {
  buildProfitReportBalanceRows,
  buildProfitReportTotals,
  convertProfitReportRows,
  countReturnedReportAmounts,
  formatProfitReportMoney,
  PROFIT_REPORT_AMOUNT_COLUMNS,
} from './profitReportFields.js';
import { getProfitReportErrorMessage } from '../services/profitReportService.js';

describe('profit report fields', () => {
  it('keeps missing monetary facts unavailable instead of formatting zero', () => {
    expect(formatProfitReportMoney(null, 'RUB')).toBe('未返回');
    expect(formatProfitReportMoney(0, 'RUB')).toBe('0.00 RUB');
  });

  it('combines the latest statement with the latest current balance by exact shop', () => {
    const rows = buildProfitReportBalanceRows({
      balances: [{ shopId: 'shop-a', balanceAmount: 90, currencyCode: 'RUB' }],
      rows: [
        { shopId: 'shop-a', periodEnd: '2026-08-15', beginBalanceAmount: 10, endBalanceAmount: 20, invoiceTransfer: 30, payment: 4 },
        { shopId: 'shop-a', periodEnd: '2026-08-01', beginBalanceAmount: 1, endBalanceAmount: 2 },
      ],
    }, [{ id: 'shop-a', alias: '主店' }]);
    expect(rows[0]).toMatchObject({ shopName: '主店', currentBalance: 90, beginBalanceAmount: 10, endBalanceAmount: 20 });
  });

  it('reports exact completeness across the visible statement columns', () => {
    const complete = Object.fromEntries(PROFIT_REPORT_AMOUNT_COLUMNS.map((column) => [column.key, 0]));
    expect(countReturnedReportAmounts(complete)).toBe(PROFIT_REPORT_AMOUNT_COLUMNS.length);
    expect(countReturnedReportAmounts({ invoiceTransfer: 1 })).toBe(1);
  });

  it('translates Ozon balance validation failures instead of exposing internal protobuf errors', () => {
    expect(getProfitReportErrorMessage('invalid GetFinanceBalanceV1Request.DateFrom: value does not match regex'))
      .toBe('Ozon 余额接口日期格式校验失败，请重新选择日期后重试。');
  });

  it('converts every returned RUB amount with the row period rate and preserves missing facts', () => {
    const rows = convertProfitReportRows([
      { id: 'a', periodEnd: '2026-08-15', currencyCode: 'RUB', ordersAmount: 100, returnsAmount: null },
      { id: 'b', periodEnd: '2026-08-25', currencyCode: 'RUB', ordersAmount: 50, returnsAmount: -5 },
    ], {
      mode: 'cny',
      getRate: (row) => ({ rubToCnyRate: row.id === 'a' ? 0.09 : 0.1, source: 'cbr-official' }),
    });
    expect(rows[0]).toMatchObject({ currencyCode: 'CNY', ordersAmount: 9, returnsAmount: null, exchangeRate: 0.09 });
    expect(rows[1]).toMatchObject({ currencyCode: 'CNY', ordersAmount: 5, returnsAmount: -0.5, exchangeRate: 0.1 });
    expect(buildProfitReportTotals(rows)).toMatchObject({ currencyCode: 'CNY', ordersAmount: 14, ordersAmountReturnedRows: 2, returnsAmount: -0.5, returnsAmountReturnedRows: 1 });
  });

  it('marks conversion unavailable when a RUB rate is missing instead of using a fixed fallback', () => {
    const [row] = convertProfitReportRows([{ currencyCode: 'RUB', invoiceTransfer: 100 }], { mode: 'cny' });
    expect(row.invoiceTransfer).toBeNull();
    expect(row.exchangeRateMissing).toBe(true);
    expect(row.exchangeRate).toBeNull();
  });
});
