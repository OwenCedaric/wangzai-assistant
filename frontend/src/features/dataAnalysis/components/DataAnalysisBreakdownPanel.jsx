import { ChartFallback, LazyChart } from '../../../shared/ui/ChartSupport.jsx';
import { formatDataAnalysisChineseText, formatDataAnalysisCount } from '../lib/dataAnalysisFormatter.js';
import { DataAnalysisEmptyState } from './DataAnalysisEmptyState.jsx';
import { DataAnalysisInsightGrid } from './DataAnalysisInsightGrid.jsx';
import { DataAnalysisPanelShell } from './DataAnalysisPanelShell.jsx';
import Stack from '@mui/material/Stack';
import React from 'react';

export function DataAnalysisBreakdownPanel({
  title,
  subtitle,
  rows = [],
  labelKey = 'key',
  valueKey = 'count',
  sourceLabel,
  maxRows = 12,
  height = 300,
  dense = false,
}) {
  const visibleRows = rows.slice(0, maxRows);
  const total = visibleRows.reduce((sum, row) => sum + (Number(row?.[valueKey]) || 0), 0);
  const leadingRow = [...visibleRows].sort((left, right) => (Number(right?.[valueKey]) || 0) - (Number(left?.[valueKey]) || 0))[0] || null;
  const leadingValue = Number(leadingRow?.[valueKey]) || 0;
  const chartHeight = Math.min(height, Math.max(152, visibleRows.length * 42 + 72));
  const chart = React.useMemo(
    () => ({
      series: [{ name: '数量', data: visibleRows.map((row) => Number(row[valueKey]) || 0) }],
      options: {
        chart: { toolbar: { show: false }, fontFamily: 'inherit', animations: { speed: 240 } },
        colors: ['#5d87ff'],
        dataLabels: { enabled: false },
        plotOptions: { bar: { horizontal: true, borderRadius: 5, barHeight: '58%' } },
        grid: { show: false },
        xaxis: {
          categories: visibleRows.map((row) => formatDataAnalysisChineseText(row[labelKey], '未返回')),
          axisBorder: { show: false },
          axisTicks: { show: false },
          labels: { style: { fontSize: '13px' } },
        },
        yaxis: { labels: { style: { fontSize: '13px' } } },
        tooltip: { y: { formatter: (value) => Math.round(value).toLocaleString('zh-CN') } },
      },
    }),
    [labelKey, valueKey, visibleRows]
  );
  return (
    <DataAnalysisPanelShell title={title} subtitle={subtitle} sourceLabel={sourceLabel} dense={dense}>
      {visibleRows.length ? (
        <Stack spacing={1.2} sx={{ flex: 1, minHeight: 0 }}>
          <React.Suspense fallback={<ChartFallback height={chartHeight} />}>
            <LazyChart type="bar" height={chartHeight} options={chart.options} series={chart.series} />
          </React.Suspense>
          <DataAnalysisInsightGrid
            columns={4}
            sx={{ mt: 'auto' }}
            items={[
              { label: '合计数量', value: formatDataAnalysisCount(total) },
              { label: '分类数量', value: `${visibleRows.length} 类` },
              { label: '主要项', value: formatDataAnalysisChineseText(leadingRow?.[labelKey], '未返回') },
              { label: '主要项占比', value: total > 0 ? `${((leadingValue / total) * 100).toFixed(1)}%` : '—' },
            ]}
          />
        </Stack>
      ) : (
        <DataAnalysisEmptyState sourceLabel={sourceLabel} />
      )}
    </DataAnalysisPanelShell>
  );
}
