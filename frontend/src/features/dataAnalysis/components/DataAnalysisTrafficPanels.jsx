import {
  formatDataAnalysisCount,
  formatDataAnalysisMoney,
  toFiniteDataAnalysisNumber,
} from '../lib/dataAnalysisFormatter.js';
import { ChartFallback, LazyChart } from '../../../shared/ui/ChartSupport.jsx';
import { DataAnalysisEmptyState } from './DataAnalysisEmptyState.jsx';
import { DataAnalysisInsightGrid } from './DataAnalysisInsightGrid.jsx';
import { DataAnalysisPanelShell } from './DataAnalysisPanelShell.jsx';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import React from 'react';

const METRICS = Object.freeze([
  { id: 'sessions', label: '访问次数', field: 'visitorSessions', color: '#5d87ff', unit: 'count' },
  { id: 'views', label: '商品浏览', field: 'productViews', color: '#7699ff', unit: 'count' },
  { id: 'cart', label: '加购次数', field: 'cartAdds', color: '#13b98f', unit: 'count' },
  { id: 'orders', label: '下单件数', field: 'orderedUnits', color: '#f5a524', unit: 'count' },
  { id: 'revenue', label: '成交额', field: 'revenueCny', color: '#e56666', unit: 'money' },
]);

function toTrafficNumber(value) {
  return toFiniteDataAnalysisNumber(value);
}

export function buildTrafficTrendSeries(rows = [], field = '') {
  return (Array.isArray(rows) ? rows : []).map((row) => toTrafficNumber(row?.[field]));
}

function formatCoverage(coverage = {}) {
  if (!coverage?.startDate || !coverage?.endDate) return '当前快照范围未返回';
  const startDate = String(coverage.startDate).slice(5).replace('-', '/');
  const endDate = String(coverage.endDate).slice(5).replace('-', '/');
  const dayCount = Number(coverage.dayCount) || 0;
  return `${startDate} - ${endDate}${dayCount ? ` · ${dayCount} 天` : ''}`;
}

function buildOptions(rows, metric) {
  const isMoney = metric.unit === 'money';
  return {
    series: [{ name: metric.label, data: buildTrafficTrendSeries(rows, metric.field) }],
    options: {
      chart: { toolbar: { show: false }, zoom: { enabled: false }, fontFamily: 'inherit', animations: { speed: 260 } },
      colors: [metric.color],
      stroke: { width: 3, curve: 'smooth' },
      fill: { type: 'gradient', gradient: { shadeIntensity: 0.15, opacityFrom: 0.24, opacityTo: 0.02, stops: [0, 92, 100] } },
      dataLabels: { enabled: false },
      markers: { size: 0, hover: { size: 4 } },
      grid: { show: false, padding: { left: 8, right: 12 } },
      xaxis: {
        categories: rows.map((row) => String(row.date || '').slice(5).replace('-', '/')),
        axisBorder: { show: false },
        axisTicks: { show: false },
        labels: { rotate: 0, hideOverlappingLabels: true, style: { fontSize: '13px' } },
      },
      yaxis: {
        min: 0,
        labels: {
          style: { fontSize: '13px' },
          formatter: (value) => (isMoney ? formatDataAnalysisMoney(value, 'CNY', { maximumFractionDigits: 0 }) : formatDataAnalysisCount(Math.round(value))),
        },
      },
      tooltip: {
        y: { formatter: (value) => (isMoney ? formatDataAnalysisMoney(value, 'CNY') : `${formatDataAnalysisCount(Math.round(value))} 次`) },
      },
      legend: { show: false },
    },
  };
}

function getTrafficTrendInsights(rows = [], metric = {}) {
  const returnedRows = rows
    .map((row) => ({ row, value: toTrafficNumber(row?.[metric.field]) }))
    .filter((item) => item.value !== null);
  const peak = returnedRows.reduce((current, item) => (!current || item.value > current.value ? item : current), null);
  const latest = returnedRows.at(-1) || null;
  const formatValue = (value) => (
    metric.unit === 'money'
      ? formatDataAnalysisMoney(value, 'CNY')
      : formatDataAnalysisCount(Math.round(value))
  );
  return [
    { label: '已返回日期', value: `${returnedRows.length} 天`, detail: `官方快照共 ${rows.length} 天` },
    { label: '周期峰值', value: peak ? formatValue(peak.value) : '—', detail: peak ? String(peak.row?.date || '').slice(5).replace('-', '/') : '暂无已返回记录' },
    { label: '最近已返回', value: latest ? String(latest.row?.date || '').slice(5).replace('-', '/') : '—', detail: latest ? formatValue(latest.value) : '暂无已返回记录' },
  ];
}

export function DataAnalysisTrafficFunnel({ funnel = [], coverage, showExtendedInsights = false }) {
  const normalizedFunnel = funnel.map((row) => ({ ...row, numericValue: toTrafficNumber(row.value) }));
  const returnedValues = normalizedFunnel
    .map((row) => row.numericValue)
    .filter((value) => value !== null);
  const max = Math.max(...returnedValues, 1);
  const valueById = new Map(normalizedFunnel.map((row) => [row.id, row.numericValue]));
  const sessions = valueById.get('sessions') ?? null;
  const views = valueById.get('views') ?? null;
  const cartAdds = valueById.get('cart') ?? null;
  const orders = valueById.get('orders') ?? null;
  const formatRate = (numerator, denominator) => (
    numerator !== null && denominator !== null && denominator > 0
      ? `${((numerator / denominator) * 100).toFixed(2)}%`
      : '—'
  );
  const insights = [
    { label: '浏览深度', value: views !== null && sessions !== null && sessions > 0 ? `${(views / sessions).toFixed(2)} 次` : '—', detail: '平均每次访问的浏览次数' },
    { label: '浏览到加购', value: formatRate(cartAdds, views), detail: '商品浏览后加入购物车的比例' },
    { label: '加购到下单件', value: formatRate(orders, cartAdds), detail: '官方下单件数 ÷ 加购次数' },
  ];
  const extendedInsights = [
    { label: '访问到加购', value: formatRate(cartAdds, sessions), detail: '加购次数 ÷ 官方访问次数' },
    { label: '访问到下单件', value: formatRate(orders, sessions), detail: '官方下单件数 ÷ 官方访问次数' },
    { label: '浏览到下单件', value: formatRate(orders, views), detail: '官方下单件数 ÷ 商品浏览次数' },
  ];
  const visibleInsights = showExtendedInsights ? [...insights, ...extendedInsights] : insights;
  return (
    <DataAnalysisPanelShell
      title="流量转化漏斗"
      subtitle={`从访问、浏览、加购到下单 · ${formatCoverage(coverage)}`}
      sourceLabel="平台官方流量快照"
    >
      {funnel.length ? (
        <Stack spacing={1.35} py={0.4}>
          <Box sx={{ display: 'grid', gap: 1.35 }}>
            {normalizedFunnel.map((row, index) => {
              const hasValue = row.numericValue !== null;
              const width = hasValue ? (row.numericValue / max) * 100 : 0;
              return (
                <Box
                  key={row.id || row.label}
                  data-testid={`traffic-funnel-row-${row.id || index}`}
                  sx={{ display: 'grid', gridTemplateColumns: '86px minmax(0, 1fr) auto', gap: 1, alignItems: 'center' }}
                >
                  <Typography variant="body2" color="text.secondary" fontWeight={750} noWrap sx={{ fontSize: 14.5 }}>
                    {row.label}
                  </Typography>
                  <Box sx={{ height: 25, borderRadius: 99, bgcolor: '#f2f5fa', overflow: 'hidden' }}>
                    <Box
                      sx={{
                        width: `${width}%`,
                        minWidth: hasValue ? (row.numericValue === 0 ? 6 : 26) : 0,
                        height: '100%',
                        borderRadius: 99,
                        bgcolor: index < 2 ? '#6d90f5' : index === 2 ? '#22b89b' : '#f1a233',
                        transition: 'width 260ms ease',
                      }}
                    />
                  </Box>
                  <Box textAlign="right" minWidth={78}>
                    <Typography variant="body2" fontWeight={900} sx={{ fontSize: 15.5 }}>
                      {formatDataAnalysisCount(row.value)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {row.id === 'sessions'
                        ? '基准'
                        : row.id === 'views'
                          ? row.numericValue !== null && sessions !== null && sessions > 0
                            ? `${(row.numericValue / sessions).toFixed(2)} 次/访问`
                            : '—'
                          : row.rate === null || row.rate === undefined
                            ? '—'
                            : `${Number(row.rate).toFixed(2)}%`}
                    </Typography>
                  </Box>
                </Box>
              );
            })}
          </Box>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' }, gap: 0.8 }}>
            {visibleInsights.map((item) => (
              <Box key={item.label} sx={{ minWidth: 0, borderRadius: 1.9, bgcolor: '#f6f8fc', px: 1.1, py: 0.8 }}>
                <Typography variant="caption" color="text.secondary" fontWeight={700}>{item.label}</Typography>
                <Typography variant="body2" fontWeight={900} mt={0.12}>{item.value}</Typography>
                <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block', mt: 0.08, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {item.detail}
                </Typography>
              </Box>
            ))}
          </Box>
        </Stack>
      ) : (
        <DataAnalysisEmptyState description="尚未形成官方流量快照。" sourceLabel="平台官方流量分析" />
      )}
    </DataAnalysisPanelShell>
  );
}

export function DataAnalysisTrafficTrend({ trend = [], coverage }) {
  const [activeId, setActiveId] = React.useState('sessions');
  const metric = METRICS.find((item) => item.id === activeId) || METRICS[0];
  const chart = React.useMemo(() => buildOptions(trend, metric), [metric, trend]);
  const hasRows = trend.some((row) => METRICS.some((item) => toTrafficNumber(row?.[item.field]) !== null));
  return (
    <DataAnalysisPanelShell
      title="流量与转化趋势"
      subtitle={`官方日粒度流量快照 · ${formatCoverage(coverage)}；成交额已按日汇率折算人民币。`}
      sourceLabel="平台官方流量快照"
      action={
        hasRows ? (
          <ToggleButtonGroup
            size="small"
            exclusive
            value={metric.id}
            onChange={(_event, value) => value && setActiveId(value)}
            aria-label="流量趋势指标"
            sx={{
              p: 0.3,
              borderRadius: 1.8,
              bgcolor: '#f4f6fa',
              '& .MuiToggleButtonGroup-grouped': {
                mx: 0.15,
                px: 0.9,
                py: 0.4,
                border: 0,
                borderRadius: '6px !important',
                color: 'text.secondary',
                fontSize: 13,
                fontWeight: 800,
                '&.Mui-selected': { color: 'primary.main', bgcolor: '#fff', boxShadow: '0 3px 10px rgba(31, 52, 88, 0.08)' },
              },
            }}
          >
            {METRICS.map((item) => (
              <ToggleButton key={item.id} value={item.id} aria-label={item.label}>
                {item.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        ) : null
      }
    >
      {hasRows ? (
        <Stack spacing={1.2} sx={{ flex: 1, minHeight: 0 }}>
          <React.Suspense fallback={<ChartFallback height={280} />}>
            <LazyChart type="area" height={280} options={chart.options} series={chart.series} />
          </React.Suspense>
          <DataAnalysisInsightGrid columns={3} sx={{ mt: 'auto' }} items={getTrafficTrendInsights(trend, metric)} />
        </Stack>
      ) : (
        <DataAnalysisEmptyState description="所选日期范围没有官方流量趋势。" sourceLabel="平台官方流量分析" />
      )}
    </DataAnalysisPanelShell>
  );
}

export function DataAnalysisTrafficCoveragePanel({ coverage, sourceSyncedAt }) {
  const refreshedAt = sourceSyncedAt ? String(sourceSyncedAt).replace('T', ' ').slice(0, 16) : '暂未返回';
  return (
    <DataAnalysisPanelShell
      title="流量数据范围与口径"
      subtitle="只按已返回的官方日快照统计；下单件数直接使用平台分析接口，不用本地订单替代。"
      sourceLabel="平台官方流量快照"
      dense
    >
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' },
          gap: 1,
        }}
      >
        {[
          { label: '可用日期', value: formatCoverage(coverage) },
          { label: '下单口径', value: '平台官方下单件数' },
          { label: '最近同步', value: refreshedAt },
        ].map((item) => (
          <Box key={item.label} sx={{ minWidth: 0, borderRadius: 2, bgcolor: '#f6f8fc', px: 1.35, py: 1.1 }}>
            <Typography variant="caption" color="text.secondary" fontWeight={700}>
              {item.label}
            </Typography>
            <Typography variant="body2" fontWeight={850} mt={0.25} noWrap title={item.value}>
              {item.value}
            </Typography>
          </Box>
        ))}
      </Box>
    </DataAnalysisPanelShell>
  );
}
