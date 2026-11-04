import { formatDataAnalysisMoney } from '../lib/dataAnalysisFormatter.js';
import { ChartFallback, LazyChart } from '../../../shared/ui/ChartSupport.jsx';
import { DataAnalysisEmptyState } from './DataAnalysisEmptyState.jsx';
import { DataAnalysisInsightGrid } from './DataAnalysisInsightGrid.jsx';
import { DataAnalysisPanelShell } from './DataAnalysisPanelShell.jsx';
import Stack from '@mui/material/Stack';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import React from 'react';

const CURRENCY_LABELS = Object.freeze({ CNY: '￥销售额', RUB: '₽销售额', USD: '$销售额', EUR: '€销售额' });
const SERIES_COLORS = ['#5d87ff', '#13b98f', '#f5a524', '#49a6ff'];

function getTrendMetrics(trend = []) {
  const currencies = [
    ...new Set(
      trend
        .flatMap((row) => (row.sales?.breakdown || []).map((item) => item.currency))
        .filter((item) => item && item !== 'UNKNOWN')
    ),
  ];
  return [
    ...currencies.map((currency, index) => ({
      id: `sales-${currency}`,
      label: CURRENCY_LABELS[currency] || `${currency}销售额`,
      currency,
      color: SERIES_COLORS[index % SERIES_COLORS.length],
      values: trend.map((row) => Number(row.sales?.breakdown?.find((item) => item.currency === currency)?.value) || 0),
    })),
    {
      id: 'effective-orders',
      label: '有效订单',
      currency: '',
      color: '#5d87ff',
      values: trend.map((row) => Number(row.effectiveOrderCount) || 0),
    },
    {
      id: 'all-orders',
      label: '全部下单',
      currency: '',
      color: '#f5a524',
      values: trend.map((row) => Number(row.orderCount) || 0),
    },
  ];
}

function buildTrendChart(trend, metric) {
  const isMoney = Boolean(metric.currency);
  return {
    series: [{ name: metric.label, data: metric.values }],
    options: {
      chart: {
        toolbar: { show: false },
        zoom: { enabled: false },
        fontFamily: 'inherit',
        animations: { speed: 260 },
      },
      colors: [metric.color],
      stroke: { width: 3, curve: 'smooth' },
      fill: {
        type: 'gradient',
        gradient: { shadeIntensity: 0.2, opacityFrom: 0.28, opacityTo: 0.03, stops: [0, 92, 100] },
      },
      dataLabels: { enabled: false },
      markers: { size: 0, hover: { size: 5 } },
      grid: { show: false, padding: { left: 8, right: 12 } },
      xaxis: {
        categories: trend.map((row) => row.date.slice(5).replace('-', '/')),
        axisBorder: { show: false },
        axisTicks: { show: false },
        labels: { rotate: 0, hideOverlappingLabels: true, style: { fontSize: '13px' } },
      },
      yaxis: {
        min: 0,
        labels: {
          style: { fontSize: '13px' },
          formatter: (value) =>
            isMoney
              ? formatDataAnalysisMoney(value, metric.currency, { maximumFractionDigits: 0 })
              : Math.round(value).toLocaleString('zh-CN'),
        },
      },
      legend: { show: false },
      tooltip: {
        y: {
          formatter: (value) =>
            isMoney
              ? formatDataAnalysisMoney(value, metric.currency)
              : `${Math.round(value).toLocaleString('zh-CN')} 单`,
        },
      },
    },
  };
}

function getTrendInsights(trend = [], metric = {}) {
  const values = Array.isArray(metric.values) ? metric.values : [];
  const activeIndexes = values
    .map((value, index) => ({ value: Number(value) || 0, index }))
    .filter((item) => item.value > 0);
  const peak = activeIndexes.reduce((current, item) => (!current || item.value > current.value ? item : current), null);
  const latest = activeIndexes.at(-1) || null;
  const formatValue = (value) => (
    metric.currency
      ? formatDataAnalysisMoney(value, metric.currency)
      : `${Math.round(value).toLocaleString('zh-CN')} 单`
  );
  return [
    { label: '有数据日期', value: `${activeIndexes.length} 天`, detail: `所选周期共 ${trend.length} 天` },
    { label: '周期峰值', value: peak ? formatValue(peak.value) : '—', detail: peak ? String(trend[peak.index]?.date || '').slice(5).replace('-', '/') : '暂无非零记录' },
    { label: '最近有数据', value: latest ? String(trend[latest.index]?.date || '').slice(5).replace('-', '/') : '—', detail: latest ? formatValue(latest.value) : '暂无非零记录' },
  ];
}

export function DataAnalysisTrendPanel({ trend = [] }) {
  const metrics = React.useMemo(() => getTrendMetrics(trend), [trend]);
  const [activeMetricId, setActiveMetricId] = React.useState(metrics[0]?.id || 'effective-orders');
  const activeMetric = metrics.find((item) => item.id === activeMetricId) || metrics[0];
  const chart = React.useMemo(() => buildTrendChart(trend, activeMetric), [activeMetric, trend]);
  const hasRows = trend.some(
    (row) => Number(row.orderCount) > 0 || row.sales?.breakdown?.some((item) => Number(item.value))
  );

  return (
    <DataAnalysisPanelShell
      title="销售与订单趋势"
      subtitle="销售额和有效订单均排除已取消订单；“全部下单”保留取消订单用于核对。"
      sourceLabel="平台订单"
      action={
        hasRows ? (
          <ToggleButtonGroup
            size="small"
            exclusive
            value={activeMetric.id}
            onChange={(_event, value) => value && setActiveMetricId(value)}
            aria-label="趋势指标"
            sx={{
              p: 0.3,
              borderRadius: 1.8,
              bgcolor: '#f4f6fa',
              '& .MuiToggleButtonGroup-grouped': {
                mx: 0.15,
                px: 1,
                py: 0.4,
                border: 0,
                borderRadius: '6px !important',
                color: 'text.secondary',
                fontSize: 12,
                fontWeight: 800,
                '&.Mui-selected': {
                  color: 'primary.main',
                  bgcolor: '#fff',
                  boxShadow: '0 3px 10px rgba(31, 52, 88, 0.08)',
                },
              },
            }}
          >
            {metrics.map((metric) => (
              <ToggleButton key={metric.id} value={metric.id} aria-label={metric.label}>
                {metric.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        ) : null
      }
    >
      {hasRows ? (
        <Stack spacing={1.2} sx={{ flex: 1, minHeight: 0 }}>
          <React.Suspense fallback={<ChartFallback height={250} />}>
            <LazyChart type="area" height={250} options={chart.options} series={chart.series} />
          </React.Suspense>
          <DataAnalysisInsightGrid columns={3} sx={{ mt: 'auto' }} items={getTrendInsights(trend, activeMetric)} />
        </Stack>
      ) : (
        <DataAnalysisEmptyState description="所选日期范围没有订单趋势数据。" sourceLabel="平台订单" />
      )}
    </DataAnalysisPanelShell>
  );
}
