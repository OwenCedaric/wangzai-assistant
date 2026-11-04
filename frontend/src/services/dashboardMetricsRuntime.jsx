import {
  appendOzonSnapshotScopeKey,
  getOzonRowShopScopeValues,
  getOzonShopClientId,
  getOzonShopLabel,
  getOzonStableShopSourceKey,
} from '../entities/order/orderShopScope.jsx';
import { getSalesOrderRecordKey } from '../entities/order/orderRecordRules.jsx';
import { getOzonLocalUniqueValues } from '../entities/product/productLocalData.jsx';
import { formatOzonPrice } from '../entities/product/productPriceRules.jsx';
import { firstFiniteNumber } from '../entities/product/productAttributes.jsx';
import { createProfitOrderFromLedgerRow } from '../entities/profit/profitDisplayRules.jsx';
import {
  getOzonSnapshotRowActivityDateKey,
  getOzonSnapshotRowActivityTime,
} from '../entities/profit/profitAfterSalesRules.jsx';
import { getProfitOrderRecordKey } from '../entities/profit/profitOrderRecordRules.jsx';
import { rowMatchesShopScope } from './localMirrorDataset';
import { readOzonSnapshotFromLocalStore } from './ozonLocalDataLayer';
import {
  getProfitLedgerSnapshotCacheKeyCandidates,
  readProfitLedgerSnapshotFromStore,
} from './profitLedgerService';
import { getProfitOrderBestValue as getProfitOrderBestValueByResult } from './profitOrderView';
import { formatDashboardInteger } from '../shared/lib/dashboardNumberFormat';
import BarChartRounded from '@mui/icons-material/BarChartRounded';
import CalculateRounded from '@mui/icons-material/CalculateRounded';
import PriceCheckRounded from '@mui/icons-material/PriceCheckRounded';
import TrendingUpRounded from '@mui/icons-material/TrendingUpRounded';

export const trendMetricTabs = ['销售额', '净支付金额', '订单数', '毛利', '毛利率'];

export const dashboardTrendCategories = [
  '00:00',
  '02:00',
  '04:00',
  '06:00',
  '08:00',
  '10:00',
  '12:00',
  '14:00',
  '16:00',
  '18:00',
  '20:00',
  '22:00',
  '24:00',
];

export function createDashboardTrendChart(summary = {}, metricKey = 'sales') {
  const categories = Array.isArray(summary.trendCategories) && summary.trendCategories.length
    ? summary.trendCategories
    : dashboardTrendCategories;
  const salesData = Array.isArray(summary.trendSalesData)
    ? summary.trendSalesData
    : categories.map(() => 0);
  const profitData = Array.isArray(summary.trendProfitData)
    ? summary.trendProfitData
    : categories.map(() => null);
  const orderData = Array.isArray(summary.trendOrderData)
    ? summary.trendOrderData
    : categories.map(() => 0);
  const primarySeries = metricKey === 'orders'
    ? { name: '有效订单（单）', data: orderData, unit: 'count' }
    : metricKey === 'profit'
      ? { name: '已确认实际净利润（人民币）', data: profitData, unit: 'money' }
      : { name: `有效订单金额（${summary.salesCurrency === 'CNY' ? '人民币' : summary.salesCurrency || '人民币'}）`, data: salesData, unit: 'money' };
  const secondarySeries = metricKey === 'sales'
    ? { name: '已确认实际净利润（人民币）', data: profitData, unit: 'money' }
    : { name: '', data: categories.map(() => null), unit: metricKey === 'orders' ? 'count' : 'money' };
  const finiteValues = [...primarySeries.data, ...secondarySeries.data]
    .filter((value) => Number.isFinite(Number(value)))
    .map(Number);
  const rawMin = Math.min(0, ...finiteValues);
  const rawMax = Math.max(0, ...finiteValues);
  const span = Math.max(1, rawMax - rawMin);
  const yAxisMin = rawMin < 0 ? Math.floor((rawMin - span * 0.08) / 10) * 10 : 0;
  const yAxisMax = Math.max(1, Math.ceil((rawMax + span * 0.08) / 10) * 10);
  return {
    metricKey,
    series: [primarySeries, secondarySeries],
    options: {
      chart: {
        toolbar: { show: false },
        zoom: { enabled: false },
        animations: { enabled: false },
        fontFamily: 'inherit',
        sparkline: { enabled: false },
      },
      colors: ['#2563ff', '#13c38b'],
      dataLabels: { enabled: false },
      stroke: { curve: 'smooth', width: [3.2, 3] },
      markers: {
        size: 0,
        hover: { size: 6 },
      },
      fill: {
        type: 'gradient',
        gradient: {
          shadeIntensity: 0.18,
          opacityFrom: 0.24,
          opacityTo: 0.03,
          stops: [0, 90, 100],
        },
      },
      grid: {
        borderColor: '#eef1f6',
        strokeDashArray: 0,
        padding: { left: 8, right: 18, top: 0, bottom: 0 },
      },
      xaxis: {
        categories,
        labels: {
          hideOverlappingLabels: true,
          style: { colors: '#5a6a85' },
        },
        axisBorder: { show: false },
        axisTicks: { show: false },
        tooltip: { enabled: false },
      },
      yaxis: {
        min: yAxisMin,
        max: yAxisMax,
        tickAmount: 3,
        labels: {
          minWidth: 42,
          maxWidth: 46,
          style: { colors: '#8b9ab3' },
          formatter: (value) => `${Math.round(value).toLocaleString()}`,
        },
      },
      legend: {
        show: false,
      },
      tooltip: {
        theme: 'light',
        marker: { show: true },
        y: { formatter: (value) => `¥${Number(value).toLocaleString()}` },
      },
    },
  };
}

export { formatDashboardInteger };

export function formatDashboardCny(value, fallback = '¥0.00') {
  const number = firstFiniteNumber(value);
  return number === null ? fallback : formatOzonPrice(number, 'CNY');
}

export function formatDashboardPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0.0%';
  return `${number.toFixed(1)}%`;
}

export function getDashboardOrderAmountValue(order = {}) {
  return firstFiniteNumber(order.amountValue, order.salesAmountValue, order.amount, order.salesAmount);
}

export function getDashboardRefundAmountValue(order = {}) {
  return firstFiniteNumber(order.refundAmountValue, order.refundAmount, order.amountValue, order.amount);
}

export function getDashboardProductQuantity(product = {}) {
  return Math.max(1, Number(firstFiniteNumber(product.qty, product.quantity, product.count)) || 1);
}

export function sumDashboardValues(rows = [], getter = (row) => row) {
  return (Array.isArray(rows) ? rows : []).reduce((sum, row) => {
    const value = firstFiniteNumber(getter(row));
    return value === null ? sum : sum + value;
  }, 0);
}

export function readDashboardOzonSnapshotRows(store = {}, snapshotKeys = []) {
  return readOzonSnapshotFromLocalStore(store, snapshotKeys)?.rows ?? [];
}

export function filterDashboardRowsByDate(rows = [], timeScope = null, getDateKey = getOzonSnapshotRowActivityDateKey) {
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const dateKey = getDateKey(row);
    const matchStart = !timeScope?.startDateKey || !dateKey || dateKey >= timeScope.startDateKey;
    const matchEnd = !timeScope?.endDateKey || !dateKey || dateKey <= timeScope.endDateKey;
    return matchStart && matchEnd;
  });
}

export function getDashboardShopScope(shop = {}) {
  return getOzonLocalUniqueValues([
    getOzonShopClientId(shop),
    shop?.id,
    getOzonShopLabel(shop),
    getOzonStableShopSourceKey(shop),
  ]);
}

export function dashboardRowMatchesShop(row = {}, shop = {}) {
  const scopeValues = getDashboardShopScope(shop);
  if (!scopeValues.length) return false;
  const rowValues = getOzonRowShopScopeValues(row);
  return rowMatchesShopScope(row, scopeValues, {
    getRowShop: () => rowValues,
  });
}

export function getDashboardProfitValue(order = {}, getter = getProfitOrderBestValueByResult) {
  const value = getter(order);
  return firstFiniteNumber(value);
}

export function buildDashboardProfitRows(store = {}, readableShops = [], timeScope = null) {
  const legacyKeys = getProfitLedgerSnapshotCacheKeyCandidates(readableShops);
  const snapshotKeys = [...legacyKeys.map((key) => appendOzonSnapshotScopeKey(key, timeScope)), ...legacyKeys];
  const snapshot = readProfitLedgerSnapshotFromStore(store, snapshotKeys);
  return (snapshot?.rows ?? []).map(createProfitOrderFromLedgerRow).filter(Boolean);
}

export function getDashboardTrendBucketIndex(order = {}) {
  const time = getOzonSnapshotRowActivityTime(order);
  if (!time) return -1;
  const hour = new Date(time).getHours();
  return Math.min(dashboardTrendCategories.length - 1, Math.floor(hour / 2));
}

export function buildDashboardTrendData(salesRows = [], profitRows = []) {
  const salesData = dashboardTrendCategories.map(() => 0);
  const profitData = dashboardTrendCategories.map(() => 0);
  const profitByOrderKey = new Map();
  profitRows.forEach((row) => {
    const key = getProfitOrderRecordKey(row);
    const profit = getDashboardProfitValue(row);
    if (key && profit !== null) profitByOrderKey.set(key, profit);
  });
  salesRows.forEach((row) => {
    const bucketIndex = getDashboardTrendBucketIndex(row);
    if (bucketIndex < 0) return;
    const salesAmount = getDashboardOrderAmountValue(row);
    if (salesAmount !== null) salesData[bucketIndex] += Number(salesAmount.toFixed(2));
    const key = getSalesOrderRecordKey(row);
    const profit = key ? profitByOrderKey.get(key) : null;
    if (profit !== null && profit !== undefined) profitData[bucketIndex] += Number(profit.toFixed(2));
  });
  return { salesData, profitData };
}

export function createDashboardConversionRows(summary = {}) {
  return [
    { label: '访客', amount: '未读取', rate: '—', delta: '—', trend: 'neutral' },
    { label: '加购买家', amount: '未读取', rate: '—', delta: '—', trend: 'neutral' },
    {
      label: '支付买家',
      amount: formatDashboardInteger(summary.salesOrderCount),
      rate: '—',
      delta: '—',
      trend: 'neutral',
    },
    { label: '支付金额', amount: summary.salesTotalDisplay || '¥0.00', rate: '—', delta: '—', trend: 'neutral' },
  ];
}

export function createDashboardTodoRows(summary = {}) {
  return [
    { level: '高', item: '待拍单', count: summary.pendingPurchaseCount || 0, color: 'error' },
    { level: '高', item: '待发货', count: summary.waitingDeliveryCount || 0, color: 'error' },
    { level: '中', item: '售后待处理', count: summary.afterSalesTodoCount || 0, color: 'warning' },
    { level: '中', item: '库存预警', count: summary.stockWarningCount || 0, color: 'warning' },
    { level: '低', item: '价格异常', count: summary.productIssueCount || 0, color: 'primary' },
  ];
}

export function createDashboardHotProductRows(summary = {}) {
  const rows = Array.isArray(summary.hotProductRows) ? summary.hotProductRows : [];
  return rows.length ? rows : [{ rank: 1, name: '暂无本地订单商品', sku: '未读取', sales: 0, profit: '待确认' }];
}

export function createDashboardStorePerformanceRows(summary = {}) {
  return Array.isArray(summary.storePerformanceRows) ? summary.storePerformanceRows : [];
}

export function createDashboardProfitSummaryCards(summary = {}) {
  return [
    {
      label: '净支付金额',
      value: summary.netSalesDisplay || '¥0.00',
      delta: '—',
      trend: 'neutral',
      tone: 'primary',
      icon: <PriceCheckRounded />,
    },
    {
      label: '总成本',
      value: summary.totalCostDisplay || '待确认',
      delta: '—',
      trend: 'neutral',
      tone: 'warning',
      icon: <CalculateRounded />,
    },
    {
      label: '净利润',
      value: summary.netProfitDisplay || '待确认',
      delta: '—',
      trend: 'neutral',
      tone: 'success',
      icon: <TrendingUpRounded />,
    },
    {
      label: '利润率',
      value: summary.profitRateDisplay || '0.0%',
      delta: '—',
      trend: 'neutral',
      tone: 'secondary',
      icon: <BarChartRounded />,
    },
  ];
}
