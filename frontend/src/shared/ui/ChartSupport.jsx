import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';
import React from 'react';

const LazyCommunityChart = React.lazy(() => import('./CommunityChart.jsx'));

export function stabilizeChartOptions(options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  const chart = source.chart && typeof source.chart === 'object' ? source.chart : {};
  const animations = chart.animations && typeof chart.animations === 'object' ? chart.animations : {};
  return {
    ...source,
    chart: {
      ...chart,
      // Keep delayed callbacks disabled while cached workspaces switch.
      animations: {
        ...animations,
        enabled: false,
        dynamicAnimation: {
          ...(animations.dynamicAnimation && typeof animations.dynamicAnimation === 'object'
            ? animations.dynamicAnimation
            : {}),
          enabled: false,
        },
      },
    },
  };
}

export function LazyChart({ options, ...props }) {
  const stableOptions = React.useMemo(() => stabilizeChartOptions(options), [options]);
  return <LazyCommunityChart {...props} options={stableOptions} />;
}

export function ChartFallback({ height }) {
  return (
    <Box className="chart-fallback" sx={{ height }}>
      <LinearProgress />
      <Typography variant="body2" color="text.secondary">
        正在加载图表
      </Typography>
    </Box>
  );
}
