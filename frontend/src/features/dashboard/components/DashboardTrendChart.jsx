import Box from '@mui/material/Box';
import React from 'react';

import { resolveDashboardTrendHover } from './dashboardTrendInteraction.js';

const CHART_HEIGHT = 268;
const VIEWBOX_WIDTH = 1000;
const VIEWBOX_HEIGHT = 300;
const PLOT = Object.freeze({ left: 58, top: 20, right: 980, bottom: 250 });

function toPercent(value) {
  return `${Math.max(0, Math.min(100, value * 100))}%`;
}

function getTrendSeriesValue(series = {}, index) {
  const values = series?.data || [];
  const value = values?.[index];
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const formatted = Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  return series.unit === 'money' ? `¥${formatted}` : formatted;
}

function createSeriesGeometry(values, pointCount, minValue, maxValue) {
  const width = PLOT.right - PLOT.left;
  const height = PLOT.bottom - PLOT.top;
  const span = Math.max(1, maxValue - minValue);
  const toY = (value) => PLOT.bottom - height * ((value - minValue) / span);
  const points = Array.from({ length: pointCount }, (_item, index) => {
    const ratio = pointCount <= 1 ? 0.5 : index / (pointCount - 1);
    const rawValue = values?.[index];
    const value = rawValue === null || rawValue === undefined || !Number.isFinite(Number(rawValue))
      ? null
      : Number(rawValue);
    return {
      x: PLOT.left + width * ratio,
      y: value === null ? null : toY(value),
      value,
    };
  });
  const segments = [];
  let current = [];
  points.forEach((point) => {
    if (point.value === null) {
      if (current.length) segments.push(current);
      current = [];
      return;
    }
    current.push(point);
  });
  if (current.length) segments.push(current);
  const zeroY = toY(Math.max(minValue, Math.min(maxValue, 0)));
  const linePath = segments
    .map((segment) => segment.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' '))
    .join(' ');
  const areaPaths = segments
    .filter((segment) => segment.length > 1)
    .map((segment) => {
      const segmentPath = segment.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
      return `${segmentPath} L ${segment.at(-1).x} ${zeroY} L ${segment[0].x} ${zeroY} Z`;
    });
  return { areaPaths, linePath, points };
}

export function DashboardTrendChart({ chart, layoutRevision }) {
  const [hover, setHover] = React.useState(null);
  const categories = chart.options.xaxis?.categories || [];
  const series = React.useMemo(() => chart.series || [], [chart.series]);
  const geometry = React.useMemo(() => {
    const pointCount = Math.max(categories.length, ...series.map((item) => item.data?.length || 0), 1);
    const finiteValues = series
      .flatMap((item) => item.data || [])
      .filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value)))
      .map(Number);
    const minValue = Number(chart.options.yaxis?.min);
    const maxValue = Number(chart.options.yaxis?.max);
    const resolvedMin = Number.isFinite(minValue) ? minValue : Math.min(0, ...finiteValues);
    const resolvedMax = Number.isFinite(maxValue) ? maxValue : Math.max(1, ...finiteValues);
    return {
      pointCount,
      sales: createSeriesGeometry(series[0]?.data || [], pointCount, resolvedMin, resolvedMax),
      profit: createSeriesGeometry(series[1]?.data || [], pointCount, resolvedMin, resolvedMax),
    };
  }, [categories.length, chart.options.yaxis?.max, chart.options.yaxis?.min, series]);

  const handlePointerMove = (event) => {
    const nextHover = resolveDashboardTrendHover({
      clientX: event.clientX,
      rect: event.currentTarget.getBoundingClientRect(),
      pointCount: categories.length,
    });
    if (!nextHover) return;
    setHover((current) => (current?.index === nextHover.index ? current : nextHover));
  };

  const activeCategory = hover ? categories[hover.index] || '—' : '—';
  const salesValue = hover ? getTrendSeriesValue(series[0], hover.index) : '0';
  const profitValue = hover ? getTrendSeriesValue(series[1], hover.index) : '0';
  const tooltipAlignRight = hover && hover.ratio > 0.68;
  const labelStep = Math.max(1, Math.ceil(categories.length / 7));

  return (
    <Box
      className="dashboard-trend-chart-frame"
      sx={{ height: CHART_HEIGHT }}
      data-layout-revision={layoutRevision}
    >
      <svg
        className="dashboard-native-trend-chart"
        viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="经营趋势图"
      >
        <defs>
          <linearGradient id="dashboard-sales-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#2563ff" stopOpacity="0.24" />
            <stop offset="100%" stopColor="#2563ff" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id="dashboard-profit-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#13c38b" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#13c38b" stopOpacity="0.01" />
          </linearGradient>
        </defs>
        {Array.from({ length: 5 }, (_item, index) => {
          const y = PLOT.top + ((PLOT.bottom - PLOT.top) * index) / 4;
          return <line key={y} x1={PLOT.left} x2={PLOT.right} y1={y} y2={y} className="dashboard-native-grid-line" />;
        })}
        {geometry.sales.areaPaths.map((path, index) => (
          <path key={`sales-area-${index}`} d={path} fill="url(#dashboard-sales-area)" />
        ))}
        {geometry.profit.areaPaths.map((path, index) => (
          <path key={`profit-area-${index}`} d={path} fill="url(#dashboard-profit-area)" />
        ))}
        <path d={geometry.sales.linePath} className="dashboard-native-sales-line" />
        <path d={geometry.profit.linePath} className="dashboard-native-profit-line" />
        {geometry.sales.points.filter((point) => point.value !== null).map((point, index) => (
          <circle key={`sales-${index}`} cx={point.x} cy={point.y} r="3.5" className="dashboard-native-sales-point" />
        ))}
        {geometry.profit.points.filter((point) => point.value !== null).map((point, index) => (
          <circle key={`profit-${index}`} cx={point.x} cy={point.y} r="3.5" className="dashboard-native-profit-point" />
        ))}
        {categories.map((category, index) => {
          if (index % labelStep !== 0 && index !== categories.length - 1) return null;
          const ratio = categories.length <= 1 ? 0.5 : index / (categories.length - 1);
          const x = PLOT.left + (PLOT.right - PLOT.left) * ratio;
          return (
            <text key={`${category}-${index}`} x={x} y="286" textAnchor="middle" className="dashboard-native-axis-label">
              {category}
            </text>
          );
        })}
      </svg>
      <Box
        className="dashboard-trend-interaction-layer"
        data-dashboard-point-count={categories.length}
        data-dashboard-categories={categories.join('|')}
        style={{
          left: `${(PLOT.left / VIEWBOX_WIDTH) * 100}%`,
          top: `${(PLOT.top / VIEWBOX_HEIGHT) * 100}%`,
          width: `${((PLOT.right - PLOT.left) / VIEWBOX_WIDTH) * 100}%`,
          height: `${((PLOT.bottom - PLOT.top) / VIEWBOX_HEIGHT) * 100}%`,
        }}
        onPointerLeave={() => setHover(null)}
        onPointerMove={handlePointerMove}
        aria-label="经营趋势时间节点"
      >
        {hover ? (
          <>
            <Box className="dashboard-trend-crosshair" style={{ left: toPercent(hover.ratio) }} />
            <Box
              className={`dashboard-trend-tooltip${tooltipAlignRight ? ' align-right' : ''}`}
              style={{ left: toPercent(hover.ratio) }}
            >
              <strong>{activeCategory}</strong>
              <span><i className="dashboard-trend-tooltip-dot sales" />{series[0]?.name || '经营数据'}：{salesValue}</span>
              {series[1]?.name ? (
                <span><i className="dashboard-trend-tooltip-dot profit" />{series[1].name}：{profitValue}</span>
              ) : null}
            </Box>
          </>
        ) : null}
      </Box>
    </Box>
  );
}
