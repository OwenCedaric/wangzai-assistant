import RefreshRounded from '@mui/icons-material/RefreshRounded';
import SearchRounded from '@mui/icons-material/SearchRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { augmentMarketOpportunityDatasetViews } from '../lib/dataAnalysisMarketOpportunity.js';
import {
  buildMarketSourceSummary,
  countHiddenMarketDatasets,
  EMPTY_MARKET_DATASETS,
  formatMarketMoney,
  formatMarketNumber,
  formatMarketTime,
  getPrimaryMarketDatasetViews,
  marketDatasetId,
  marketDatasetLabel,
  marketDatasetRecordCount,
} from '../lib/dataAnalysisMarketView.js';
import { DataAnalysisEmptyState } from './DataAnalysisEmptyState.jsx';
import { DataAnalysisInsightGrid } from './DataAnalysisInsightGrid.jsx';
import { DataAnalysisMarketRecordTable } from './DataAnalysisMarketRecordTable.jsx';
import { DataAnalysisPanelShell } from './DataAnalysisPanelShell.jsx';

const SOURCE_ACTIONS = Object.freeze([
  { id: 'products', label: '商品' },
  { id: 'traffic', label: '流量' },
  { id: 'sales', label: '销售' },
]);

function MarketSearchActions({ marketState, refreshing, searching, onReadMarketData, onSearchMarketData }) {
  const query = marketState.query || '';
  const search = () => onSearchMarketData?.(query);
  return (
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={0.75}>
      <TextField
        size="small"
        value={query}
        onChange={(event) => marketState.setQuery?.(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') search();
        }}
        placeholder="输入关键词搜索 Ozon"
        inputProps={{ 'aria-label': 'Ozon 市场搜索关键词' }}
        sx={{ minWidth: { sm: 230 } }}
      />
      <Button
        size="small"
        variant="contained"
        disabled={searching || refreshing}
        startIcon={searching ? <CircularProgress size={14} color="inherit" /> : <SearchRounded />}
        onClick={search}
      >
        {searching ? '正在搜索' : '搜索 Ozon'}
      </Button>
      <Button
        size="small"
        variant="outlined"
        disabled={refreshing || searching}
        startIcon={refreshing ? <CircularProgress size={14} color="inherit" /> : <RefreshRounded />}
        onClick={() => onReadMarketData?.()}
      >
        {refreshing ? '正在刷新' : '刷新数据'}
      </Button>
    </Stack>
  );
}

function MarketDatasetTab({ active, label, onClick, count }) {
  return (
    <Box
      component="button"
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      sx={{
        position: 'relative',
        flex: '0 0 auto',
        minWidth: 0,
        minHeight: 48,
        px: { xs: 1.25, md: 1.8 },
        border: 0,
        borderBottom: '3px solid',
        borderColor: active ? 'primary.main' : 'transparent',
        bgcolor: 'transparent',
        color: active ? 'primary.main' : '#61718c',
        fontSize: { xs: 13.5, md: 14.5 },
        fontWeight: active ? 900 : 750,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        transition: 'color 160ms ease, border-color 160ms ease, background-color 160ms ease',
        '&:hover': { bgcolor: '#f4f7ff', color: 'primary.main' },
      }}
    >
      {label}
      <Typography component="span" sx={{ ml: 0.55, fontSize: 12, fontWeight: 850, opacity: 0.75 }}>
        {formatMarketNumber(count)}
      </Typography>
    </Box>
  );
}

function MarketMetricCards({ metrics = [] }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', md: 'repeat(4, minmax(0, 1fr))' }, gap: 1 }}>
      {metrics.map((metric, index) => {
        const showDetail = Boolean(metric.detail) && (
          metric.aggregation === 'weighted-average'
          || !['', 'confirmed'].includes(String(metric.status || ''))
        );
        return (
          <Box
            key={`${metric.label}-${index}`}
            title={metric.detail || ''}
            sx={{
              minWidth: 0,
              p: { xs: 1.25, md: 1.5 },
              borderRadius: 2.25,
              bgcolor: index === 0 ? '#f2f6ff' : '#f7f9fc',
              border: '1px solid',
              borderColor: index === 0 ? '#dce6ff' : '#edf1f6',
            }}
          >
            <Typography variant="caption" color="text.secondary" fontWeight={800}>{metric.label}</Typography>
            <Typography sx={{ mt: 0.45, color: '#1f365f', fontSize: { xs: 20, md: 24 }, fontWeight: 950, lineHeight: 1.15 }}>
              {metric.kind === 'money'
                ? metric.status === 'currency_unconfirmed' ? '汇率未确认' : formatMarketMoney(metric.value)
                : `${formatMarketNumber(metric.value)}${metric.unit || ''}`}
            </Typography>
            {showDetail ? (
              <Typography
                variant="caption"
                noWrap
                sx={{
                  display: 'block',
                  mt: 0.45,
                  color: metric.status === 'partial' ? '#a15c18' : 'text.secondary',
                  fontWeight: metric.status === 'partial' ? 750 : 600,
                }}
              >
                {metric.detail}
              </Typography>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

function MarketDatasetEmptyState({ hiddenDatasetCount }) {
  const hasHiddenData = hiddenDatasetCount > 0;
  return (
    <DataAnalysisEmptyState
      title={hasHiddenData ? '暂未返回可用机会数据' : '暂无 Ozon 可用数据'}
      description={hasHiddenData
        ? '已收到基础列表、价格带或趋势记录，但这些内容不再作为主分析标签；等待关键词、竞品、类目、品牌、缺货或流量转化数据。'
        : '刷新后只展示插件实际捕获且有真实记录的可用数据集。'}
      sourceLabel="Ozon 浏览器插件"
      statusLabel={hasHiddenData ? '已捕获基础数据，等待可用数据' : '等待真实响应'}
    />
  );
}

export function DataAnalysisMarketPanel({
  sources = [],
  onOpenModule,
  marketState = {},
  onReadMarketData,
  onSearchMarketData,
  onProductLinkError,
}) {
  const [activeDatasetId, setActiveDatasetId] = React.useState('');
  const marketData = marketState.data || null;
  const capturedDatasets = Array.isArray(marketData?.datasetViews)
    ? marketData.datasetViews
    : EMPTY_MARKET_DATASETS;
  const datasets = React.useMemo(
    () => getPrimaryMarketDatasetViews(augmentMarketOpportunityDatasetViews(capturedDatasets)),
    [capturedDatasets],
  );
  const selectedDataset = datasets.find((dataset) => marketDatasetId(dataset) === activeDatasetId)
    || datasets[0]
    || null;
  const selectedDatasetId = marketDatasetId(selectedDataset);
  const hiddenDatasetCount = countHiddenMarketDatasets(capturedDatasets);
  const searching = marketState.activeAction === 'search' || marketState.status === 'searching';
  const refreshing = marketState.activeAction === 'manual'
    || (marketState.status === 'refreshing' && marketState.activeAction !== 'search');
  const refreshFeedback = marketData?.refreshInProgress
    ? '正在获取全部分类'
    : marketData?.refreshOutcomeLabel || marketState.statusLabel || '';

  return (
    <Stack spacing={1.5}>
      <DataAnalysisPanelShell
        title="Ozon 市场分析"
        subtitle="只展示插件实际捕获的商品表现、关键词、竞品、类目、品牌、缺货和流量转化数据；没有真实记录的内容不占位。"
        sourceLabel="Ozon 内置浏览器插件"
        action={(
          <MarketSearchActions
            marketState={marketState}
            refreshing={refreshing}
            searching={searching}
            onReadMarketData={onReadMarketData}
            onSearchMarketData={onSearchMarketData}
          />
        )}
      >
        {['error', 'error-with-cache'].includes(marketState.status) ? (
          <Alert severity="warning">{marketState.error?.message || '读取浏览器插件数据失败。'}</Alert>
        ) : null}
        {marketData ? (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mt: 0.25, textAlign: { xs: 'left', sm: 'right' } }}
          >
            最近获取 {formatMarketTime(marketData.lastCaptureAt || marketData.updatedAt)}
            {marketData.lastCompletedAt ? ` · 刷新完成 ${formatMarketTime(marketData.lastCompletedAt)}` : ''}
            {refreshFeedback ? ` · ${refreshFeedback}` : ''}
          </Typography>
        ) : null}
        {datasets.length ? (
          <Box
            role="tablist"
            aria-label="Ozon 市场数据标签"
            sx={{
              display: 'flex',
              width: '100%',
              minWidth: 0,
              flexWrap: 'wrap',
              gap: 0.25,
              overflowX: 'hidden',
              borderBottom: '1px solid #e8edf4',
              mt: 0.5,
            }}
          >
            {datasets.map((dataset) => {
              const id = marketDatasetId(dataset);
              return (
                <MarketDatasetTab
                  key={id}
                  active={selectedDatasetId === id}
                  label={marketDatasetLabel(dataset)}
                  count={marketDatasetRecordCount(dataset)}
                  onClick={() => setActiveDatasetId(id)}
                />
              );
            })}
          </Box>
        ) : (
          <MarketDatasetEmptyState hiddenDatasetCount={hiddenDatasetCount} />
        )}
      </DataAnalysisPanelShell>

      {selectedDataset ? (
        <DataAnalysisPanelShell
          title={marketDatasetLabel(selectedDataset)}
          subtitle={`真实记录 ${formatMarketNumber(marketDatasetRecordCount(selectedDataset))} 条 · 最近捕获 ${formatMarketTime(selectedDataset.newestCapturedAt)}`}
          sourceLabel="Ozon 真实响应"
        >
          <MarketMetricCards metrics={selectedDataset.metrics || []} />
          <DataAnalysisMarketRecordTable dataset={selectedDataset} onProductLinkError={onProductLinkError} />
        </DataAnalysisPanelShell>
      ) : null}

      <DataAnalysisPanelShell
        title="当前店内可用数据"
        subtitle="以下数量来自已同步的店内官方数据，不用于推算 Ozon 市场规模。"
        sourceLabel="店内业务数据缓存"
        dense
      >
        <DataAnalysisInsightGrid columns={3} items={buildMarketSourceSummary(sources)} />
        <Stack direction="row" gap={0.75} flexWrap="wrap" sx={{ mt: 1 }}>
          {SOURCE_ACTIONS.map((action) => (
            <Button key={action.id} size="small" variant="outlined" onClick={() => onOpenModule?.(action.id)}>
              查看{action.label}分析
            </Button>
          ))}
        </Stack>
      </DataAnalysisPanelShell>
    </Stack>
  );
}
