import {
  getOzonReadableShops,
  getOzonShopLabel,
  getOzonSnapshotSourceKey,
} from '../../entities/order/orderShopScope.jsx';
import { isRendererTreeTelemetryEnabled, markRendererTreeRender } from '../../app/performance/rendererTreeTelemetry.js';
import { safeWarn } from '../../services/safeLog';
import {
  getOzonPushRealtimeShopId,
  OZON_PUSH_REALTIME_BROWSER_EVENT,
} from '../../services/ozonPushRealtime.js';
import { isSettingsInteractionPaused } from '../../shared/lib/settingsInteractionRuntime.js';
import {
  createDashboardEmptySummary,
  dashboardSummaryHasRows,
} from './lib/dashboardSummary.js';
import {
  createDashboardHotProductRows,
  createDashboardStorePerformanceRows,
  createDashboardTodoRows,
  createDashboardTrendChart,
} from '../../services/dashboardMetricsRuntime.jsx';
import { DashboardTrendChart } from './components/DashboardTrendChart.jsx';
import { useSettingsInteractionPause } from './model/useSettingsInteractionPause.js';
import { readDashboardOverviewSnapshot } from './services/dashboardOverviewService.js';
import {
  createEmptyDashboardPromotionSummary,
  readDashboardPromotionSummary,
} from './services/dashboardPromotionService.js';
import AddShoppingCartRounded from '@mui/icons-material/AddShoppingCartRounded';
import CampaignRounded from '@mui/icons-material/CampaignRounded';
import HeadsetMicRounded from '@mui/icons-material/HeadsetMicRounded';
import LocalShippingRounded from '@mui/icons-material/LocalShippingRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import TrendingUpRounded from '@mui/icons-material/TrendingUpRounded';
import WarningAmberRounded from '@mui/icons-material/WarningAmberRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import FormControl from '@mui/material/FormControl';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import React from 'react';

const DASHBOARD_CHART_LAYOUT_SETTLE_MS = 340;

function firstFilled(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return '';
}

function toFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatDashboardInteger(value) {
  const parsed = toFiniteNumber(value);
  return parsed === null ? '0' : Math.round(parsed).toLocaleString('zh-CN');
}

function formatDashboardCurrencyValue(value) {
  if (typeof value === 'string' && /^[¥₽$€£]|^[A-Z]{3}\s/u.test(value.trim())) return value.trim();
  const parsed = toFiniteNumber(value);
  if (parsed === null) return typeof value === 'string' && value.trim() ? value : '待确认';
  return `¥${parsed.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatShortTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 5) || '—';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function formatLastSyncedAt(value) {
  if (!value) return '等待更新';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '等待更新';
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function resolveOrderProductName(row = {}) {
  const products = Array.isArray(row.products) ? row.products : Array.isArray(row.items) ? row.items : [];
  const firstProduct = products[0] || {};
  return String(
    firstFilled(
      row.productName,
      row.product_name,
      row.name,
      firstProduct.name,
      firstProduct.productName,
      firstProduct.offer_id,
      firstProduct.sku,
      '订单商品待读取'
    )
  );
}

function resolveOrderStatusTone(status = '') {
  const text = String(status);
  if (/取消|关闭|退款|售后|异常|失败/.test(text)) return 'error';
  if (/等待|备货|发货中|待处理|超时/.test(text)) return 'warning';
  if (/已发货|成功|完成|完结/.test(text)) return 'success';
  return 'info';
}

function createLatestOrderRows(summary = {}) {
  const rows = Array.isArray(summary.salesRows) ? summary.salesRows.slice(0, 4) : [];
  if (!rows.length) {
    return [
      {
        id: summary.loaded ? '暂无订单' : '正在更新',
        shop: summary.scopeLabel || '当前范围',
        product: summary.loaded ? '当前范围暂无订单记录' : '正在更新最近订单',
        amount: '—',
        status: summary.loaded ? '暂无记录' : '正在更新',
        tone: 'default',
        time: '—',
      },
    ];
  }

  return rows.map((row, index) => {
    const status = String(firstFilled(row.statusText, row.statusLabel, row.status, row.substatus, '已同步'));
    const amount = firstFilled(
      row.amountDisplay,
      row.totalAmountDisplay,
      row.priceDisplay,
      row.totalPrice,
      row.total_price,
      row.order_price,
      row.price,
      row.in_process_at ? '' : summary.averageOrderDisplay
    );

    return {
      id: String(
        firstFilled(row.posting_number, row.postingNumber, row.order_number, row.orderId, row.id, `OZ-${index + 1}`)
      ),
      shop: String(firstFilled(row.shopAlias, row.shopName, row.sellerName, row.shop, '当前店铺')),
      product: resolveOrderProductName(row),
      amount: formatDashboardCurrencyValue(amount),
      status,
      tone: resolveOrderStatusTone(status),
      time: formatShortTime(
        firstFilled(row.in_process_at, row.created_at, row.shipment_date, row.updated_at, row.date)
      ),
    };
  });
}

function createMetricCards(summary = {}, loadStatus = 'loading') {
  const readable = loadStatus === 'data' && summary.loaded;
  const pendingValue = readable ? formatDashboardInteger(summary.waitingDeliveryCount) : '—';
  const stockValue = readable ? formatDashboardInteger(summary.stockWarningCount) : '—';
  return [
    {
      title: `${summary.rangeLabel || '今日'}销售额`,
      value: readable ? summary.salesTotalDisplay : '—',
      delta:
        readable && summary.salesDeltaPercent !== null && summary.salesDeltaPercent !== undefined && Number.isFinite(Number(summary.salesDeltaPercent))
          ? `较上期 ${Number(summary.salesDeltaPercent) >= 0 ? '+' : ''}${Number(summary.salesDeltaPercent).toFixed(1)}%`
          : readable
            ? '较上期暂无可比数据'
            : '正在更新',
      tone: 'primary',
      icon: <AddShoppingCartRounded />,
      hint: readable ? `客单价 ${summary.averageOrderDisplay}` : '正在更新销售数据',
    },
    {
      title: `${summary.rangeLabel || '今日'}有效订单`,
      value: readable ? formatDashboardInteger(summary.salesOrderCount) : '—',
      delta: readable ? `取消 ${formatDashboardInteger(summary.cancelledOrderCount)}` : '正在更新',
      tone: 'primary',
      icon: <AddShoppingCartRounded />,
      hint: readable ? `全部订单 ${formatDashboardInteger(summary.allOrderCount)}` : '正在更新订单数据',
    },
    {
      title: `${summary.rangeLabel || '今日'}实际净利润`,
      value: readable ? summary.netProfitDisplay || '等待核算' : '—',
      delta: readable ? `覆盖 ${summary.profitCoverageDisplay}` : '正在更新',
      tone: 'success',
      icon: <TrendingUpRounded />,
      hint: readable
        ? `已核算 ${formatDashboardInteger(summary.profitReadyCount)} / ${formatDashboardInteger(summary.profitOrderCount)} 笔`
        : '正在更新利润结果',
    },
    {
      title: '待备货/发货',
      value: pendingValue,
      delta: readable ? `${formatDashboardInteger(summary.pendingPurchaseCount)} 待拍单` : '正在更新',
      tone: 'warning',
      icon: <LocalShippingRounded />,
      hint: readable ? '请优先处理临近发货时限订单' : '正在更新履约状态',
    },
    {
      title: '售后处理中',
      value: readable ? formatDashboardInteger(summary.afterSalesTodoCount) : '—',
      delta: readable ? '需处理' : '正在更新',
      tone: 'success',
      icon: <HeadsetMicRounded />,
      hint: readable ? '及时处理可减少售后积压' : '正在更新售后状态',
    },
    {
      title: '库存预警',
      value: stockValue,
      delta: readable ? `${formatDashboardInteger(summary.productIssueCount)} 校验异常` : '正在更新',
      tone: 'error',
      icon: <WarningAmberRounded />,
      hint: readable
        ? `缺货 ${formatDashboardInteger(summary.outOfStockCount)} / 低库存 ${formatDashboardInteger(summary.lowStockCount)}`
        : '正在更新库存状态',
    },
  ];
}

function createTaskProgressRows(todoRows = []) {
  const rows = todoRows;
  const maxCount = Math.max(1, ...rows.map((row) => Number(row.count) || 0));
  const hasAnyCount = rows.some((row) => Number(row.count) > 0);
  return rows.map((row) => ({
    ...row,
    progress: hasAnyCount ? Math.max(10, Math.round(((Number(row.count) || 0) / maxCount) * 100)) : 0,
    displayValue: `${formatDashboardInteger(row.count)} 项`,
  }));
}

function MetricCard({ metric }) {
  return (
    <Card className={`dashboard-kpi-card tone-${metric.tone}`} data-testid="dashboard-kpi-card">
      <CardContent>
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
          <Box className={`dashboard-kpi-icon tone-${metric.tone}`}>{metric.icon}</Box>
          <Chip label={metric.delta} color={metric.tone} size="small" variant="outlined" />
        </Stack>
        <Typography variant="body2" color="text.secondary" mt={1.35} noWrap>
          {metric.title}
        </Typography>
        <Typography variant="h4" mt={0.3} noWrap>
          {metric.value}
        </Typography>
        <Typography variant="caption" color="text.secondary" noWrap>
          {metric.hint}
        </Typography>
      </CardContent>
    </Card>
  );
}

function DashboardRenderTreeEnd({ startedAt }) {
  markRendererTreeRender('dashboard:page-view', startedAt);
  return null;
}

function DashboardPageContent({ shops = [], sidebarOpen = true, isActive = true }) {
  const treeTelemetryEnabled = isRendererTreeTelemetryEnabled();
  const treeTelemetryStartedAt = treeTelemetryEnabled && typeof performance !== 'undefined' ? performance.now() : 0;
  const previousSidebarOpen = React.useRef(sidebarOpen);
  const isActiveRef = React.useRef(isActive);
  const settingsOverlayOpenRef = React.useRef(isSettingsInteractionPaused());
  const settingsResumeTimerRef = React.useRef(null);
  const pendingSummaryRef = React.useRef(null);
  isActiveRef.current = isActive;
  const [chartLayoutRevision, setChartLayoutRevision] = React.useState(0);
  const readableShops = React.useMemo(() => getOzonReadableShops(shops), [shops]);
  const readableShopsSourceKey = React.useMemo(() => getOzonSnapshotSourceKey(readableShops), [readableShops]);
  const readableShopsLabelKey = React.useMemo(
    () => readableShops.map((shop) => `${shop.id || ''}:${getOzonShopLabel(shop)}`).join('|'),
    [readableShops]
  );
  const [range, setRange] = React.useState('today');
  const [selectedShopId, setSelectedShopId] = React.useState('all');
  const [refreshToken, setRefreshToken] = React.useState(0);
  const [loadStatus, setLoadStatus] = React.useState('loading');
  const [loadError, setLoadError] = React.useState(null);
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [trendMetric, setTrendMetric] = React.useState('sales');
  const [promotionSummary, setPromotionSummary] = React.useState(() =>
    createEmptyDashboardPromotionSummary('loading', '正在更新推广数据')
  );
  const [promotionStatus, setPromotionStatus] = React.useState('loading');
  const scopedReadableShops = React.useMemo(
    () =>
      selectedShopId === 'all'
        ? readableShops
        : readableShops.filter((shop) => String(shop.id || '') === selectedShopId),
    [readableShops, selectedShopId]
  );
  const [dashboardSummary, setDashboardSummary] = React.useState(() =>
    createDashboardEmptySummary(readableShops, { rangeKey: 'today' })
  );

  React.useEffect(() => {
    const readableShopIds = new Set(readableShops.map((shop) => String(shop?.id || '').trim()).filter(Boolean));
    const handleOzonPushRefresh = (event) => {
      const detail = event?.detail && typeof event.detail === 'object' ? event.detail : {};
      if (detail.stage !== 'refreshed' || !['orders', 'products'].includes(detail.domain)) return;
      const shopId = getOzonPushRealtimeShopId(event);
      if (!shopId || !readableShopIds.has(shopId)) return;
      if (selectedShopId !== 'all' && selectedShopId !== shopId) return;
      setRefreshToken((current) => current + 1);
    };
    globalThis.addEventListener?.(OZON_PUSH_REALTIME_BROWSER_EVENT, handleOzonPushRefresh);
    return () => globalThis.removeEventListener?.(OZON_PUSH_REALTIME_BROWSER_EVENT, handleOzonPushRefresh);
  }, [readableShops, selectedShopId]);

  React.useEffect(() => {
    if (selectedShopId === 'all') return;
    if (readableShops.some((shop) => String(shop.id || '') === selectedShopId)) return;
    setSelectedShopId('all');
  }, [readableShops, selectedShopId]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const clearResumeTimer = () => {
      if (settingsResumeTimerRef.current !== null) {
        globalThis.clearTimeout(settingsResumeTimerRef.current);
        settingsResumeTimerRef.current = null;
      }
    };
    const handleSettingsOpen = () => {
      clearResumeTimer();
      settingsOverlayOpenRef.current = true;
    };
    const handleSettingsClosed = () => {
      clearResumeTimer();
      settingsResumeTimerRef.current = globalThis.setTimeout(() => {
        settingsResumeTimerRef.current = null;
        settingsOverlayOpenRef.current = false;
        if (!isActiveRef.current || !pendingSummaryRef.current) return;
        const pending = pendingSummaryRef.current;
        pendingSummaryRef.current = null;
        React.startTransition(() => {
          setDashboardSummary(pending.summary);
          setLoadStatus('data');
        });
      }, 500);
    };
    window.addEventListener('wangzai-settings-open', handleSettingsOpen);
    window.addEventListener('wangzai-settings-closed', handleSettingsClosed);
    return () => {
      clearResumeTimer();
      window.removeEventListener('wangzai-settings-open', handleSettingsOpen);
      window.removeEventListener('wangzai-settings-closed', handleSettingsClosed);
    };
  }, []);

  React.useEffect(() => {
    if (!isActive || settingsOverlayOpenRef.current || !pendingSummaryRef.current) return;
    const pending = pendingSummaryRef.current;
    pendingSummaryRef.current = null;
    React.startTransition(() => {
      setDashboardSummary(pending.summary);
      setLoadStatus('data');
    });
  }, [isActive]);

  React.useEffect(() => {
    if (previousSidebarOpen.current === sidebarOpen) return undefined;
    previousSidebarOpen.current = sidebarOpen;

    const timer = globalThis.setTimeout(() => {
      // 主区域宽度动画结束后重新创建图表，让 ApexCharts 用最终容器宽度计算鼠标坐标和时间指示线。
      setChartLayoutRevision((current) => current + 1);
    }, DASHBOARD_CHART_LAYOUT_SETTLE_MS);

    return () => globalThis.clearTimeout(timer);
  }, [sidebarOpen]);

  React.useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    if (!scopedReadableShops.length) {
      setDashboardSummary(createDashboardEmptySummary([], { rangeKey: range }));
      setLoadStatus('empty');
      setLoadError(null);
      setIsRefreshing(false);
      return () => controller.abort();
    }
    setIsRefreshing(true);
    setLoadError(null);
    setLoadStatus((current) => (current === 'data' ? current : 'loading'));
    readDashboardOverviewSnapshot(readableShops, {
      selectedShopId,
      rangeKey: range,
      refreshToken,
      signal: controller.signal,
    })
      .then((summary) => {
        if (cancelled) return;
        if (isActiveRef.current && !settingsOverlayOpenRef.current) {
          React.startTransition(() => {
            setDashboardSummary(summary);
            setLoadStatus('data');
          });
        } else {
          pendingSummaryRef.current = { summary };
        }
        setIsRefreshing(false);
      })
      .catch((error) => {
        if (cancelled || error?.name === 'AbortError') return;
        safeWarn('[旺崽汇总] SQLite 首页聚合读取失败', error);
        setLoadError(error);
        setIsRefreshing(false);
        setDashboardSummary((current) => {
          if (dashboardSummaryHasRows(current)) {
            setLoadStatus('data');
            return current;
          }
          setLoadStatus('error');
          return createDashboardEmptySummary(scopedReadableShops, { rangeKey: range });
        });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [range, readableShops, readableShopsSourceKey, readableShopsLabelKey, refreshToken, scopedReadableShops, selectedShopId]);

  React.useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    if (!scopedReadableShops.length) {
      setPromotionSummary(createEmptyDashboardPromotionSummary('empty', '当前没有可读取的店铺'));
      setPromotionStatus('empty');
      return () => controller.abort();
    }
    const rangeValues = dashboardSummary.range;
    if (!rangeValues?.startDate || !rangeValues?.endDate) return () => controller.abort();
    setPromotionStatus('loading');
    readDashboardPromotionSummary(
      {
        shops: scopedReadableShops,
        selectedShopId,
        dateFrom: rangeValues.startDate,
        dateTo: rangeValues.endDate,
        refresh: refreshToken > 0,
      },
      { signal: controller.signal }
    )
      .then((summary) => {
        if (cancelled) return;
        setPromotionSummary(summary);
        setPromotionStatus(summary.status);
      })
      .catch((error) => {
        if (cancelled || error?.name === 'AbortError') return;
        safeWarn('[旺崽汇总] 推广数据读取失败', error);
        setPromotionSummary((current) =>
          current.status === 'data'
            ? { ...current, partial: true, message: '推广数据更新失败，保留上次结果' }
            : createEmptyDashboardPromotionSummary('unavailable', '推广数据暂不可用')
        );
        setPromotionStatus((current) => (current === 'data' ? current : 'unavailable'));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [dashboardSummary.range, refreshToken, scopedReadableShops, selectedShopId]);

  const operatingTrendChart = React.useMemo(
    () => createDashboardTrendChart(dashboardSummary, trendMetric),
    [dashboardSummary, trendMetric]
  );
  const todoRows = React.useMemo(() => createDashboardTodoRows(dashboardSummary), [dashboardSummary]);
  const todoTotal = todoRows.reduce((sum, row) => sum + (Number(row.count) || 0), 0);
  const taskProgressRows = React.useMemo(() => createTaskProgressRows(todoRows), [todoRows]);
  const hotProductRows = React.useMemo(() => createDashboardHotProductRows(dashboardSummary), [dashboardSummary]);
  const storePerformanceRows = React.useMemo(
    () => createDashboardStorePerformanceRows(dashboardSummary),
    [dashboardSummary]
  );
  const metricCards = React.useMemo(() => createMetricCards(dashboardSummary, loadStatus), [dashboardSummary, loadStatus]);
  const latestOrderRows = React.useMemo(() => createLatestOrderRows(dashboardSummary), [dashboardSummary]);
  const promotionByShopId = React.useMemo(
    () => new Map((promotionSummary.byShop || []).map((row) => [String(row.shopId), row])),
    [promotionSummary.byShop]
  );
  const storeComparisonRows = React.useMemo(
    () =>
      storePerformanceRows.slice(0, 5).map((store) => {
        const promotion = promotionByShopId.get(String(store.shopId)) || {};
        return {
          ...store,
          promotionSpent:
            promotion.spentCny !== null && promotion.spentCny !== undefined
              ? formatDashboardCurrencyValue(promotion.spentCny)
              : promotion.spentRub !== null && promotion.spentRub !== undefined
                ? `₽${Number(promotion.spentRub).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`
                : '暂无数据',
          acos:
            promotion.acos !== null && promotion.acos !== undefined && Number.isFinite(Number(promotion.acos))
              ? `${Number(promotion.acos).toFixed(1)}%`
              : '暂无数据',
          todo: `${formatDashboardInteger(store.currentTasks?.total || 0)} 项`,
        };
      }),
    [promotionByShopId, storePerformanceRows]
  );
  const visibleStoreComparisonRows = React.useMemo(() => {
    if (storeComparisonRows.length) return storeComparisonRows;
    return scopedReadableShops.slice(0, 5).map((shop) => ({
      shopId: shop.id,
      name: getOzonShopLabel(shop) || '当前店铺',
      sales: '暂无数据',
      orderCount: 0,
      netProfit: '等待核算',
      promotionSpent: '暂无数据',
      acos: '暂无数据',
      todo: '暂无数据',
    }));
  }, [scopedReadableShops, storeComparisonRows]);
  const promotionMetrics = React.useMemo(() => {
    const isPresentNumber = (value) =>
      value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
    const money = (cnyValue, rubValue) => {
      if (isPresentNumber(cnyValue)) return formatDashboardCurrencyValue(cnyValue);
      if (isPresentNumber(rubValue)) {
        return `₽${Number(rubValue).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      }
      return '暂无数据';
    };
    const number = (value) => (isPresentNumber(value) ? formatDashboardInteger(value) : '暂无数据');
    const ratio = (value, suffix = '') =>
      isPresentNumber(value) ? `${Number(value).toFixed(2)}${suffix}` : '暂无数据';
    return [
      { label: `${dashboardSummary.rangeLabel || '今日'}推广消耗`, value: money(promotionSummary.spentCny, promotionSummary.spentRub) },
      { label: '推广订单', value: number(promotionSummary.orders) },
      { label: '推广销售额', value: money(promotionSummary.revenueCny, promotionSummary.revenueRub) },
      { label: '推广费占比', value: ratio(promotionSummary.acos, '%') },
      { label: '推广投入产出比', value: ratio(promotionSummary.roas) },
      { label: '可用预算', value: money(promotionSummary.balanceCny, promotionSummary.balanceRub) },
    ];
  }, [dashboardSummary.rangeLabel, promotionSummary]);
  const insightRows = React.useMemo(() => {
    const rows = [];
    if (dashboardSummary.stockWarningCount > 0) {
      rows.push({ tone: 'error', title: '库存预警较高', detail: `${formatDashboardInteger(dashboardSummary.stockWarningCount)} 个商品需核对库存` });
    }
    if (dashboardSummary.afterSalesTodoCount > 0) {
      rows.push({ tone: 'warning', title: '售后积压需处理', detail: `${formatDashboardInteger(dashboardSummary.afterSalesTodoCount)} 项正在处理中` });
    }
    if (
      promotionSummary.roas !== null &&
      promotionSummary.roas !== undefined &&
      Number.isFinite(Number(promotionSummary.roas))
    ) {
      rows.push({
        tone: Number(promotionSummary.roas) >= 3 ? 'success' : 'warning',
        title: Number(promotionSummary.roas) >= 3 ? '推广投入产出正常' : '推广投入产出偏低',
        detail: `推广费占比 ${Number(promotionSummary.acos || 0).toFixed(1)}% · 推广投入产出比 ${Number(promotionSummary.roas).toFixed(2)}`,
      });
    }
    if (!rows.length) rows.push({ tone: 'success', title: '当前经营状态平稳', detail: '暂未发现需要优先处理的异常' });
    return rows.slice(0, 3);
  }, [dashboardSummary.afterSalesTodoCount, dashboardSummary.stockWarningCount, promotionSummary.acos, promotionSummary.roas]);

  const handleRefresh = () => {
    setRefreshToken((current) => current + 1);
  };

  return (
    <Box className="dashboard-board dashboard-classic-board" data-testid="dashboard-overview-root">
      <Stack direction={{ xs: 'column', md: 'row' }} alignItems={{ xs: 'stretch', md: 'center' }} justifyContent="space-between" spacing={2} className="dashboard-classic-header">
        <Box className="dashboard-classic-title">
          <Stack direction="row" spacing={1} alignItems="center" mb={1}>
            <Chip size="small" variant="outlined" label={dashboardSummary.scopeLabel || '全部店铺'} />
            <Chip
              size="small"
              variant="outlined"
              color={loadError ? 'warning' : 'default'}
              label={
                loadError
                  ? '数据更新失败，已保留上次结果'
                  : `数据更新于 ${formatLastSyncedAt(dashboardSummary.sourceUpdatedAt)}`
              }
            />
          </Stack>
          <Typography variant="h4">旺崽汇总</Typography>
          <Typography color="text.secondary" mt={0.75}>
            订单、利润、库存与推广经营概览
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} className="hero-actions dashboard-classic-actions">
          <FormControl size="small" sx={{ minWidth: 150 }}>
            <Select
              value={selectedShopId}
              onChange={(event) => setSelectedShopId(event.target.value)}
              inputProps={{ 'aria-label': '首页统计店铺' }}
            >
              <MenuItem value="all">全部店铺</MenuItem>
              {readableShops.map((shop) => (
                <MenuItem key={shop.id} value={shop.id}>
                  {getOzonShopLabel(shop)}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small">
            <Select value={range} onChange={(event) => setRange(event.target.value)}>
              <MenuItem value="today">今日</MenuItem>
              <MenuItem value="week">近 7 天</MenuItem>
              <MenuItem value="month">本月</MenuItem>
            </Select>
          </FormControl>
          <Button variant="contained" startIcon={<RefreshRounded />} onClick={handleRefresh} disabled={isRefreshing}>
            {isRefreshing ? '正在更新' : '更新数据'}
          </Button>
        </Stack>
      </Stack>

      <Box className="dashboard-kpi-grid">
        {metricCards.map((metric) => (
          <MetricCard key={metric.title} metric={metric} />
        ))}
      </Box>

      <Card className="dashboard-promotion-strip" data-testid="dashboard-promotion-strip">
        <CardContent>
          <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2} mb={1.25}>
            <Stack direction="row" alignItems="center" spacing={1} minWidth={0}>
              <CampaignRounded color="primary" />
              <Typography variant="h6">付费推广</Typography>
              <Typography variant="caption" color="text.secondary" noWrap>
                {promotionStatus === 'loading'
                  ? '正在更新'
                  : promotionSummary.message || `数据更新于 ${formatShortTime(promotionSummary.updatedAt)}`}
              </Typography>
            </Stack>
            <Chip
              size="small"
              variant="outlined"
              color={promotionSummary.status === 'data' && !promotionSummary.partial ? 'success' : 'default'}
              label={promotionSummary.status === 'unconfigured' ? '尚未配置' : `${formatDashboardInteger(promotionSummary.accountCount)} 个推广账号`}
            />
          </Stack>
          <Box className="dashboard-promotion-metrics">
            {promotionMetrics.map((metric) => (
              <Box key={metric.label} className="dashboard-promotion-metric">
                <Typography variant="caption" color="text.secondary" noWrap>{metric.label}</Typography>
                <Typography variant="h6" noWrap>{metric.value}</Typography>
              </Box>
            ))}
          </Box>
        </CardContent>
      </Card>

      <Box className="dashboard-classic-main-grid">
        <Card className="dashboard-classic-sales-card">
          <CardContent>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              justifyContent="space-between"
              alignItems={{ xs: 'flex-start', sm: 'center' }}
              spacing={1.5}
              mb={1.25}
            >
              <Box>
                <Typography variant="h6">销售与利润趋势</Typography>
                <Typography variant="body2" color="text.secondary">
                  {dashboardSummary.rangeLabel}经营变化
                </Typography>
              </Box>
              <Stack direction="row" spacing={0.5} alignItems="center" className="dashboard-trend-tabs">
                {[['sales', '销售额'], ['orders', '订单量'], ['profit', '净利润']].map(([key, label]) => (
                  <Button key={key} size="small" variant={trendMetric === key ? 'contained' : 'text'} onClick={() => setTrendMetric(key)}>
                    {label}
                  </Button>
                ))}
              </Stack>
            </Stack>
            <DashboardTrendChart
              chart={operatingTrendChart}
              layoutRevision={chartLayoutRevision}
              isActive={isActive}
            />
          </CardContent>
        </Card>

        <Card className="dashboard-operations-card" data-testid="dashboard-operations-card">
          <CardContent>
            <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1.25}>
              <Box>
                <Typography variant="h6">经营待办</Typography>
                <Typography variant="body2" color="text.secondary">当前需处理事项</Typography>
              </Box>
              <Chip size="small" color={todoTotal ? 'error' : 'success'} variant="outlined" label={`${formatDashboardInteger(todoTotal)} 项`} />
            </Stack>
            <Box className="dashboard-operations-head"><span>事项</span><span>数量</span><span>占比</span></Box>
            <Stack spacing={0}>
              {taskProgressRows.map((task) => (
                <Box key={task.item} className="dashboard-operation-row">
                  <Stack direction="row" alignItems="center" spacing={1} minWidth={0}>
                    <Box className={`dashboard-operation-dot tone-${task.color}`} />
                    <Typography variant="body2" noWrap>{task.item === '价格异常' ? '商品校验异常' : task.item}</Typography>
                  </Stack>
                  <Typography variant="subtitle2">{formatDashboardInteger(task.count)}</Typography>
                  <Box className="dashboard-operation-share">
                    <LinearProgress variant="determinate" color={task.color} value={task.progress} className="dashboard-classic-progress" />
                    <Typography variant="caption">{todoTotal ? `${((Number(task.count) / todoTotal) * 100).toFixed(1)}%` : '0.0%'}</Typography>
                  </Box>
                </Box>
              ))}
            </Stack>
          </CardContent>
        </Card>
      </Box>

      <Box className="dashboard-compare-grid">
        <Card className="dashboard-store-compare-card" data-testid="dashboard-store-compare-card">
          <CardContent>
            <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1.5} mb={1.2}>
              <Box>
                <Typography variant="h6">店铺经营对比</Typography>
                <Typography variant="body2" color="text.secondary">同一口径横向比较店铺表现</Typography>
              </Box>
            </Stack>
            <TableContainer>
              <Table className="dashboard-classic-table dashboard-store-table">
                <TableHead>
                  <TableRow>
                    <TableCell>店铺</TableCell>
                    <TableCell align="right">销售额</TableCell>
                    <TableCell align="right">订单</TableCell>
                    <TableCell align="right">净利润</TableCell>
                    <TableCell align="right">推广消耗</TableCell>
                    <TableCell align="right">推广费占比</TableCell>
                    <TableCell align="right">待处理</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {visibleStoreComparisonRows.map((row) => (
                    <TableRow key={row.shopId || row.name} hover>
                      <TableCell><Typography variant="subtitle1" noWrap>{row.name}</Typography></TableCell>
                      <TableCell align="right">{row.sales}</TableCell>
                      <TableCell align="right">{formatDashboardInteger(row.orderCount)}</TableCell>
                      <TableCell align="right">{row.netProfit || '等待核算'}</TableCell>
                      <TableCell align="right">{row.promotionSpent}</TableCell>
                      <TableCell align="right">{row.acos}</TableCell>
                      <TableCell align="right">{row.todo}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </CardContent>
        </Card>

        <Card className="dashboard-insight-card">
          <CardContent>
            <Typography variant="h6">经营提示</Typography>
            <Stack spacing={1.5} mt={1.5}>
              {insightRows.map((row) => (
                <Stack key={row.title} direction="row" spacing={1.2} alignItems="flex-start" className={`dashboard-insight-row tone-${row.tone}`}>
                  <WarningAmberRounded />
                  <Box minWidth={0}>
                    <Typography variant="subtitle2">{row.title}</Typography>
                    <Typography variant="caption" color="text.secondary">{row.detail}</Typography>
                  </Box>
                </Stack>
              ))}
            </Stack>
          </CardContent>
        </Card>
      </Box>

      <Card className="dashboard-classic-orders-card">
        <CardContent>
          <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1.5} mb={1.2}>
            <Box>
              <Typography variant="h6">最新订单</Typography>
              <Typography variant="body2" color="text.secondary">按最新更新时间排序</Typography>
            </Box>
            <Typography variant="caption" color="text.secondary">热销商品：{hotProductRows[0]?.name || '暂无订单商品'}</Typography>
          </Stack>
          <TableContainer>
            <Table className="dashboard-classic-table">
              <TableHead><TableRow><TableCell>订单</TableCell><TableCell>店铺</TableCell><TableCell>商品</TableCell><TableCell align="right">金额</TableCell><TableCell>状态</TableCell><TableCell>时间</TableCell></TableRow></TableHead>
              <TableBody>
                {latestOrderRows.map((row) => (
                  <TableRow key={`${row.id}-${row.time}`} hover>
                    <TableCell><Typography variant="subtitle1">{row.id}</Typography></TableCell>
                    <TableCell>{row.shop}</TableCell>
                    <TableCell className="dashboard-classic-product-cell">{row.product}</TableCell>
                    <TableCell align="right">{row.amount}</TableCell>
                    <TableCell><Chip size="small" color={row.tone} label={row.status} variant="outlined" /></TableCell>
                    <TableCell>{row.time}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>
      {treeTelemetryEnabled ? <DashboardRenderTreeEnd startedAt={treeTelemetryStartedAt} /> : null}
    </Box>
  );
}

const MemoizedDashboardPageContent = React.memo(DashboardPageContent);

function DashboardPage(props) {
  const settingsInteractionPaused = useSettingsInteractionPause();
  const contentActivatedRef = React.useRef(!settingsInteractionPaused);
  if (!settingsInteractionPaused) contentActivatedRef.current = true;

  if (!contentActivatedRef.current) {
    return (
      <Box className="dashboard-board dashboard-classic-board" role="status" aria-live="polite">
        <Box className="page-loading-fallback">
          <span className="page-loading-spinner" aria-hidden="true" />
          <span>设置操作结束后继续准备旺崽汇总…</span>
        </Box>
      </Box>
    );
  }

  return <MemoizedDashboardPageContent {...props} />;
}

function dashboardPagePropsEqual(previous, next) {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  keys.delete('isActive');
  return [...keys].every((key) => Object.is(previous[key], next[key]));
}

// The dashboard is the fixed first workspace and completes its bounded local aggregate
// on initial activation. Keep that immutable snapshot tree warm afterwards; visibility is
// owned by WorkspacePageSlot, so activity-only switches must not rebuild the complete MUI tree.
const MemoizedDashboardPage = React.memo(DashboardPage, dashboardPagePropsEqual);

export { MemoizedDashboardPage as DashboardPage };
export default MemoizedDashboardPage;
