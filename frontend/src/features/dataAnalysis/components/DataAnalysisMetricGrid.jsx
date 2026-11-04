import {
  formatDataAnalysisDelta,
  formatDataAnalysisChineseText,
  formatDataAnalysisMetric,
  formatDataAnalysisTime,
  getMetricTone,
} from '../lib/dataAnalysisFormatter.js';
import ArrowDownwardRounded from '@mui/icons-material/ArrowDownwardRounded';
import ArrowUpwardRounded from '@mui/icons-material/ArrowUpwardRounded';
import InfoOutlined from '@mui/icons-material/InfoOutlined';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

const TONE_STYLES = Object.freeze({
  primary: { accent: '#5d87ff', value: '#1f365f', background: 'transparent' },
  success: { accent: '#13b98f', value: '#176b58', background: 'rgba(19, 185, 143, 0.035)' },
  warning: { accent: '#f5a524', value: '#a45b00', background: '#fffaf2' },
  danger: { accent: '#ef5b5b', value: '#b83232', background: '#fff6f6' },
  muted: { accent: '#a8b3c7', value: '#5d6b84', background: '#f7f8fa' },
});

function getMetricModuleId(metricId = '') {
  if (['trafficSessionCount', 'trafficProductViewCount', 'trafficCartAddCount', 'trafficCartConversionRate', 'trafficOrderCount', 'trafficOrderConversionRate', 'trafficMatchedOrderCount', 'trafficRevenueRub'].includes(metricId)) {
    return 'traffic';
  }
  if (['orderCount', 'effectiveOrderCount', 'salesAmount', 'averageOrderValue', 'cancelledCount'].includes(metricId)) return 'sales';
  if (['activeProductCount'].includes(metricId)) return 'products';
  if (['stockUnits', 'archivedStockUnits', 'outOfStockCount', 'inSaleOutOfStockCount', 'lowStockCount'].includes(metricId)) return 'inventory';
  if (['returnCount', 'returnOrderCount'].includes(metricId)) return 'after-sales';
  if (['financeNetAmount', 'financeIncomeAmount', 'financeDeductionAmount', 'financeCurrencyCoverage', 'confirmedPurchaseCost', 'purchaseCostCoverage', 'actualNetProfit'].includes(metricId)) {
    return 'profit';
  }
  return '';
}

function MetricInfo({ metric }) {
  const source = metric.source || {};
  const tooltip = [
    formatDataAnalysisChineseText(metric.detail),
    source.label ? `来源：${formatDataAnalysisChineseText(source.label)}` : '',
    source.syncedAt ? `更新：${formatDataAnalysisTime(source.syncedAt)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <Tooltip
      title={<span style={{ whiteSpace: 'pre-line' }}>{tooltip || '指标说明暂未登记'}</span>}
      arrow
      disableInteractive
      enterDelay={120}
    >
      <InfoOutlined sx={{ fontSize: 16, color: 'text.disabled', cursor: 'help' }} />
    </Tooltip>
  );
}

function DataAnalysisMetricCard({ metric, onDrillDown }) {
  const tone = getMetricTone(metric);
  const style = TONE_STYLES[tone] || TONE_STYLES.primary;
  const delta = formatDataAnalysisDelta(metric);
  const moduleId = getMetricModuleId(metric.id);
  const interactive = Boolean(moduleId && onDrillDown);
  const formattedValue = formatDataAnalysisMetric(metric);
  const longValue = formattedValue.length > 17;
  return (
    <ButtonBase
      component={interactive ? 'button' : 'div'}
      disableRipple={!interactive}
      onClick={interactive ? () => onDrillDown(moduleId) : undefined}
      aria-label={interactive ? `${metric.label}，打开详情` : undefined}
      data-testid="overview-kpi-card"
      data-metric-id={metric.id}
      className="data-analysis-kpi-card"
      sx={{
        position: 'relative',
        display: 'block',
        minWidth: 0,
        width: '100%',
        height: '100%',
        minHeight: 122,
        p: { xs: 1.6, md: 1.75 },
        overflow: 'hidden',
        textAlign: 'left',
        borderRadius: 2.25,
        border: 0,
        bgcolor: style.background,
        cursor: interactive ? 'pointer' : 'default',
        boxShadow: 'none',
        transform: 'none',
        transition: 'background-color 160ms ease, box-shadow 160ms ease',
        '&:hover': interactive
          ? {
              transform: 'none',
              bgcolor: tone === 'warning' || tone === 'danger' ? style.background : '#f7f9fd',
            }
          : undefined,
      }}
    >
      <Stack spacing={0.8} height="100%" minWidth={0}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
          <Stack direction="row" spacing={0.7} alignItems="center" minWidth={0}>
            <Box sx={{ width: 7, height: 7, flex: '0 0 auto', borderRadius: '50%', bgcolor: style.accent }} />
            <Typography color="text.secondary" fontWeight={750} variant="body2" noWrap sx={{ fontSize: { xs: 13.5, md: 14.5 } }}>
              {formatDataAnalysisChineseText(metric.label)}
            </Typography>
          </Stack>
          <MetricInfo metric={metric} />
        </Stack>
        <Typography
          fontWeight={900}
          sx={{
            color: style.value,
            fontSize: longValue ? 'clamp(1.18rem, 1.5vw, 1.52rem)' : 'clamp(1.6rem, 2.05vw, 2.1rem)',
            lineHeight: 1.16,
            overflowWrap: 'anywhere',
          }}
        >
          {formattedValue}
        </Typography>
        <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={0.75} mt="auto">
          <Stack
            direction="row"
            spacing={0.35}
            alignItems="center"
            minWidth={0}
            sx={{
              color:
                delta.tone === 'positive'
                  ? 'success.main'
                  : delta.tone === 'negative'
                    ? 'error.main'
                    : 'text.secondary',
            }}
          >
            {delta.direction === 'up' ? <ArrowUpwardRounded sx={{ fontSize: 14 }} /> : null}
            {delta.direction === 'down' ? <ArrowDownwardRounded sx={{ fontSize: 14 }} /> : null}
            <Typography variant="caption" fontWeight={750} noWrap sx={{ fontSize: 12.5 }}>
              {delta.text}
            </Typography>
          </Stack>
        </Stack>
      </Stack>
    </ButtonBase>
  );
}

export function DataAnalysisMetricGrid({
  metrics = [],
  onDrillDown,
  minCardWidth = 188,
  ariaLabel = '经营指标',
  embedded = false,
  columns = 0,
}) {
  const resolvedColumns = Math.max(0, Math.min(Number(columns) || 0, Math.max(metrics.length, 1)));
  return (
    <Box
      component="section"
      aria-label={ariaLabel}
      sx={{
        display: 'grid',
        gridTemplateColumns: resolvedColumns
          ? {
              xs: 'minmax(0, 1fr)',
              sm: `repeat(${Math.min(resolvedColumns, 2)}, minmax(0, 1fr))`,
              md: `repeat(${resolvedColumns}, minmax(0, 1fr))`,
            }
          : `repeat(auto-fit, minmax(min(100%, ${minCardWidth}px), 1fr))`,
        gap: embedded ? 0.25 : 0.35,
        p: embedded ? 0 : 0.75,
        borderRadius: 3,
        bgcolor: embedded ? 'transparent' : '#fff',
        boxShadow: embedded ? 'none' : '0 10px 30px rgba(31, 52, 88, 0.055)',
      }}
    >
      {metrics.map((metric) => (
        <DataAnalysisMetricCard key={metric.id} metric={metric} onDrillDown={onDrillDown} />
      ))}
    </Box>
  );
}
