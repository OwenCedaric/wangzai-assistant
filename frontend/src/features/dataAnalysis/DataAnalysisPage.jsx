import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import React from 'react';
import { DataAnalysisHeader } from './components/DataAnalysisHeader.jsx';
import { DataAnalysisInsightDialog } from './components/DataAnalysisInsightDialog.jsx';
import { DataAnalysisInfoDrawer } from './components/DataAnalysisInfoDrawer.jsx';
import { DataAnalysisModuleContent } from './components/DataAnalysisModuleContent.jsx';
import { DataAnalysisModuleNav } from './components/DataAnalysisModuleNav.jsx';
import { DataAnalysisErrorState, DataAnalysisLoadingState } from './components/DataAnalysisStatusBanner.jsx';
import { DataAnalysisToolbar } from './components/DataAnalysisToolbar.jsx';
import { useDataAnalysisCenter } from './model/useDataAnalysisCenter.js';
import { useDataAnalysisCurrency } from './model/useDataAnalysisCurrency.js';
import { useDataAnalysisPerformance } from './model/useDataAnalysisPerformance.js';
import { useDataAnalysisInsight } from './model/useDataAnalysisInsight.js';
import { useDataAnalysisMarket } from './model/useDataAnalysisMarket.js';
import {
  getOzonPushRealtimeShopId,
  OZON_PUSH_REALTIME_BROWSER_EVENT,
} from '../../services/ozonPushRealtime.js';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';

function getShopName(shops = [], shopId = '') {
  const shop = shops.find((item) => item.id === shopId) || {};
  return shop.shopAlias || shop.alias || shop.name || shopId || '全部店铺';
}

export function DataAnalysisPage({ shops = [], activeShopId = '', isActive = true, skillConfig = {} }) {
  const [infoOpen, setInfoOpen] = React.useState(false);
  const [analysisOpen, setAnalysisOpen] = React.useState(false);
  const [productLinkError, setProductLinkError] = React.useState('');
  const center = useDataAnalysisCenter({ shops, activeShopId, isActive });
  const centerRefresh = center.refresh;
  const centerShopId = center.filters.shopId;
  React.useEffect(() => {
    const readableShopIds = new Set((Array.isArray(shops) ? shops : [])
      .map((shop) => String(shop?.id || '').trim())
      .filter(Boolean));
    const handleOzonPushRefresh = (event) => {
      const detail = event?.detail && typeof event.detail === 'object' ? event.detail : {};
      if (detail.stage !== 'refreshed' || !['orders', 'products'].includes(detail.domain)) return;
      const shopId = getOzonPushRealtimeShopId(event);
      if (!shopId || !readableShopIds.has(shopId)) return;
      if (centerShopId && centerShopId !== 'all' && centerShopId !== shopId) return;
      if (isActive) void centerRefresh({ keepStatus: true }).catch(() => undefined);
    };
    globalThis.addEventListener?.(OZON_PUSH_REALTIME_BROWSER_EVENT, handleOzonPushRefresh);
    return () => globalThis.removeEventListener?.(OZON_PUSH_REALTIME_BROWSER_EVENT, handleOzonPushRefresh);
  }, [centerRefresh, centerShopId, isActive, shops]);
  const performance = useDataAnalysisPerformance({
    enabled: isActive && center.activeModuleId === 'advertising',
    shopId: center.filters.shopId,
    shopName: getShopName(shops, center.filters.shopId),
    dateFrom: center.filters.startDate,
    dateTo: center.filters.endDate,
  });
  const market = useDataAnalysisMarket({
    enabled: isActive && center.activeModuleId === 'market',
  });
  const currency = useDataAnalysisCurrency({
    dashboard: center.payload.dashboard,
    marketData: market.data,
    endDate: center.filters.endDate,
  });
  const dashboard = currency.dashboard;
  const insight = useDataAnalysisInsight({
    filters: center.filters,
    dashboard,
    promptConfig: skillConfig,
    enabled: isActive,
  });
  const convertedMarketState = React.useMemo(
    () => ({ ...market, data: currency.marketData }),
    [currency.marketData, market]
  );
  const loading = ['loading', 'refreshing', 'rebuilding'].includes(center.status) || currency.status === 'loading';
  const analyzeInsight = insight.analyze;
  const openAnalysis = React.useCallback(() => {
    setAnalysisOpen(true);
    void analyzeInsight();
  }, [analyzeInsight]);

  return (
    <Box component="main" data-testid="data-analysis-main" className="data-analysis-page" sx={{ minWidth: 0 }}>
      <Stack spacing={1.5}>
        <DataAnalysisHeader
          updatedAt={center.payload.updatedAt}
          loading={loading}
          currencyStatus={currency.status}
          currencyMeta={dashboard?.currencyConversion || dashboard?.finance?.currencyConversion}
          onRebuild={() => center.rebuild()}
          onOpenInfo={() => setInfoOpen(true)}
          onOpenAnalysis={openAnalysis}
        />
        <DataAnalysisToolbar
          shops={shops}
          filters={center.filters}
          loading={loading}
          onShopChange={center.setShopId}
          onPresetChange={center.setPreset}
          onRangeChange={center.setCustomRange}
          onRefresh={() => center.refreshOfficialData()}
        />
        <DataAnalysisModuleNav activeModuleId={center.activeModuleId} onChange={center.setActiveModuleId} />
        {!dashboard && (center.status === 'loading' || currency.status === 'loading') ? <DataAnalysisLoadingState /> : null}
        {!dashboard && center.status === 'error' ? (
          <DataAnalysisErrorState error={center.error} onRetry={() => center.refresh()} />
        ) : null}
        {dashboard ? (
          <DataAnalysisModuleContent
            activeModuleId={center.activeModuleId}
            dashboard={dashboard}
            performanceState={performance}
            onOpenModule={center.setActiveModuleId}
            onSyncTraffic={center.refreshOfficialData}
            isRefreshing={center.status === 'refreshing'}
            marketState={convertedMarketState}
            onReadMarketData={convertedMarketState.refresh}
            onSearchMarketData={convertedMarketState.search}
            onProductLinkError={setProductLinkError}
          />
        ) : null}
      </Stack>
      <DataAnalysisInfoDrawer
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
        sources={dashboard?.sources || []}
        dataPolicy={dashboard?.dataPolicy || {}}
      />
      <DataAnalysisInsightDialog
        open={analysisOpen}
        onClose={() => setAnalysisOpen(false)}
        dashboard={dashboard}
        filters={center.filters}
        state={insight}
        modelOptions={insight.modelOptions}
        selectedModelId={insight.selectedModelId}
        modelSelection={insight.modelSelection}
        onModelChange={insight.setSelectedModelId}
        onAnalyze={insight.analyze}
      />
      <Snackbar
        open={Boolean(productLinkError)}
        autoHideDuration={4200}
        onClose={() => setProductLinkError('')}
      >
        <Alert severity="error" variant="filled" onClose={() => setProductLinkError('')}>
          {productLinkError}
        </Alert>
      </Snackbar>
    </Box>
  );
}
