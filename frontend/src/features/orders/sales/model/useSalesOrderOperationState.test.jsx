import { describe, expect, it } from 'vitest';
import { formatSalesOrderPartialErrorItem } from './useSalesOrderOperationState.jsx';

describe('sales order partial sync errors', () => {
  it('shows a blocked shop directly instead of reducing it to a generic FBO failure', () => {
    expect(
      formatSalesOrderPartialErrorItem({
        label: 'FBO 订单列表',
        error: new Error('Ozon 3店被 Ozon 封禁，无法刷新订单。'),
      })
    ).toBe('Ozon 3店被 Ozon 封禁，无法刷新订单。');
  });

  it('keeps the existing compact status for unrelated endpoint failures', () => {
    expect(
      formatSalesOrderPartialErrorItem({
        label: 'FBO 订单列表',
        error: new Error('HTTP 429'),
      })
    ).toBe('FBO 订单列表 HTTP 429');
  });
});
