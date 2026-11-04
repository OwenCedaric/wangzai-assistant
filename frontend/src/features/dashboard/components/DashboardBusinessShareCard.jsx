import { ChartFallback, LazyChart } from '../../../shared/ui/ChartSupport.jsx';
import { createDashboardBusinessSharePresentation } from '../lib/dashboardBusinessSharePresentation.js';
import { useSettingsInteractionPause } from '../model/useSettingsInteractionPause.js';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';

function formatCount(value) {
  return Math.max(0, Math.round(Number(value) || 0)).toLocaleString('zh-CN');
}

export function DashboardBusinessShareCard({ businessShareState, layoutRevision = 0, scopeLabel = '当前范围' }) {
  const settingsInteractionPaused = useSettingsInteractionPause();
  const presentation = React.useMemo(
    () => createDashboardBusinessSharePresentation(businessShareState),
    [businessShareState]
  );

  return (
    <Card
      className="dashboard-classic-channel-card"
      data-testid="dashboard-business-share"
      data-dashboard-business-status={presentation.status}
      data-dashboard-business-series={presentation.values.join(',')}
      data-dashboard-business-chart-series={presentation.series.join(',')}
      data-dashboard-business-visual-state={presentation.hasData ? 'chart' : presentation.status}
      data-dashboard-business-total={String(presentation.total)}
    >
      <CardContent>
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
          <Typography variant="h6">当前经营待办</Typography>
          <Chip
            size="small"
            variant="outlined"
            label={presentation.status === 'data' ? '本地数据' : presentation.centerLabel}
            sx={{ color: presentation.statusColor, borderColor: presentation.statusColor }}
          />
        </Stack>
        <Typography variant="body2" sx={{ color: '#334155' }} mb={0.5}>
          {scopeLabel} · 当前状态，不受日期筛选影响
        </Typography>
        <Typography
          data-testid="dashboard-business-share-status"
          variant="caption"
          aria-live="polite"
          sx={{ color: presentation.statusColor, fontWeight: 700 }}
        >
          {presentation.statusText}
        </Typography>
        <Box mt={0.75} data-testid="dashboard-business-share-chart">
          {presentation.hasData && !settingsInteractionPaused ? (
            <React.Suspense fallback={<ChartFallback height={244} />}>
              <LazyChart
                key={`dashboard-business-share-${layoutRevision}`}
                options={presentation.options}
                series={presentation.series}
                type="donut"
                height={244}
              />
            </React.Suspense>
          ) : presentation.hasData ? (
            <ChartFallback height={244} />
          ) : (
            <Box
              className={`dashboard-business-state-ring state-${presentation.status}`}
              data-testid="dashboard-business-share-state-ring"
              aria-label={presentation.stateLabel}
            >
              <Typography
                data-testid="dashboard-business-share-center-label"
                variant="subtitle1"
                sx={{ color: '#334155', fontWeight: 700 }}
              >
                {presentation.centerLabel}
              </Typography>
              <Typography
                data-testid="dashboard-business-share-center-total"
                variant="h4"
                sx={{ color: '#172554', fontWeight: 800 }}
              >
                {presentation.centerTotal}
              </Typography>
            </Box>
          )}
        </Box>
        <Stack spacing={1.2} mt={2}>
          {presentation.items.map((item) => (
            <Stack key={item.key} direction="row" alignItems="center" spacing={1.25}>
              <Box className="dashboard-classic-legend-dot" sx={{ backgroundColor: item.color }} />
              <Typography variant="body2" flex={1} sx={{ color: '#334155' }}>
                {item.label}
              </Typography>
              <Typography
                data-testid={`dashboard-business-share-${item.key}`}
                variant="subtitle1"
                sx={{ color: '#172554', fontWeight: 800 }}
              >
                {presentation.status === 'loading' || presentation.status === 'error' ? '—' : formatCount(item.value)}
              </Typography>
            </Stack>
          ))}
        </Stack>
      </CardContent>
    </Card>
  );
}
