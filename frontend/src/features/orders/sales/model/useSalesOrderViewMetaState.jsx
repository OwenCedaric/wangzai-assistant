import { OrderSideSearch } from '../../../../shared/ui/OrderSideSearch.jsx';
import React from 'react';

export function useSalesOrderViewMetaState({
  keyword,
  setKeyword,
  resetSalesOrderListState,
  salesOrderCountRows,
  orderSync,
  totalAmount,
  salesOrderSummary,
} = {}) {
  const sideOrderSearch = (
    <OrderSideSearch
      value={keyword}
      onChange={(event) => {
        setKeyword(event.target.value);
        resetSalesOrderListState();
      }}
      placeholder="搜索单号 / 货号 / SKU"
      className="sales-order-side-search"
    />
  );
  const stats = React.useMemo(
    () => {
      const statusCounts = salesOrderSummary?.salesStatusCounts || {};
      const total = Number(salesOrderSummary?.total) || salesOrderCountRows.length;
      const awaiting = (Number(statusCounts['等待备货']) || 0) + (Number(statusCounts['等待发货']) || 0) + (Number(statusCounts['即将超时']) || 0);
      const overdue = Number(statusCounts['发货超时']) || 0;
      return [
      {
        title: '销售订单',
        value: String(total),
        hint: orderSync.loading ? '正在读取' : '首次读取 / 手动刷新',
        tone: 'primary',
      },
      {
        title: '备货/发货中',
        value: String(awaiting),
        hint: '需要运营跟进',
        tone: 'warning',
      },
      {
        title: '发货超时',
        value: String(overdue),
        hint: '需人工确认',
        tone: 'error',
      },
      {
        title: '销售金额',
        value: totalAmount > 0 ? totalAmount.toFixed(2) : '未返回',
        hint: '按已返回金额汇总',
        tone: 'success',
      },
    ];
    },
    [orderSync.loading, salesOrderCountRows.length, salesOrderSummary, totalAmount]
  );

  return {
    sideOrderSearch,
    stats,
  };
}
