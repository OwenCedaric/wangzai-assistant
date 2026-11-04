import { DataAnalysisDiagnosticsPanel } from './DataAnalysisDiagnosticsPanel.jsx';
import { DataAnalysisMetricGrid } from './DataAnalysisMetricGrid.jsx';
import { DataAnalysisOverviewProductRanking } from './DataAnalysisOverviewCommercePanels.jsx';
import { DataAnalysisTrafficFunnel } from './DataAnalysisTrafficPanels.jsx';
import { DataAnalysisTrendPanel } from './DataAnalysisTrendPanel.jsx';
import { DataAnalysisShopCoveragePanel } from './DataAnalysisShopCoveragePanel.jsx';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';

const OVERVIEW_METRIC_IDS = Object.freeze([
  'trafficSessionCount',
  'trafficOrderCount',
  'trafficOrderConversionRate',
  'salesAmount',
  'financeNetAmount',
  'outOfStockCount',
]);

function selectOverviewMetrics(dashboard) {
  const metrics = [...(dashboard.overview?.metrics || []), ...(dashboard.finance?.metrics || [])];
  const metricById = new Map(metrics.map((metric) => [metric.id, metric]));
  return OVERVIEW_METRIC_IDS.map((id) => metricById.get(id)).filter(Boolean);
}

function OverviewGrid({ children, secondaryWidth = 0.72 }) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: {
          xs: 'minmax(0, 1fr)',
          md: `minmax(0, 1.6fr) minmax(290px, ${secondaryWidth}fr)`,
        },
        gap: 1.5,
        alignItems: 'stretch',
        '& > .MuiCard-root': {
          height: '100%',
        },
      }}
    >
      {children}
    </Box>
  );
}

export function DataAnalysisOverviewContent({ dashboard, onOpenModule, onProductLinkError }) {
  return (
    <Stack spacing={1.5}>
      <DataAnalysisMetricGrid
        metrics={selectOverviewMetrics(dashboard)}
        onDrillDown={onOpenModule}
        columns={6}
        ariaLabel="核心经营指标"
      />
      <DataAnalysisShopCoveragePanel quality={dashboard.dataQuality || {}} />
      <OverviewGrid>
        <DataAnalysisTrafficFunnel funnel={dashboard.traffic?.funnel || []} coverage={dashboard.traffic?.coverage} />
        <DataAnalysisDiagnosticsPanel rows={dashboard.diagnostics || []} onOpenModule={onOpenModule} />
      </OverviewGrid>
      <OverviewGrid secondaryWidth={0.9}>
        <DataAnalysisTrendPanel trend={dashboard.overview?.trend || []} />
        <DataAnalysisOverviewProductRanking
          rows={dashboard.sales?.productRanking || []}
          onOpenModule={onOpenModule}
          onProductLinkError={onProductLinkError}
        />
      </OverviewGrid>
    </Stack>
  );
}
