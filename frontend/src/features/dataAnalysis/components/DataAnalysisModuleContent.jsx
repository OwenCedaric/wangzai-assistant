import { DataAnalysisAdvertisingPanel } from './DataAnalysisAdvertisingPanel.jsx';
import { DataAnalysisRecentReturnsTable, DataAnalysisReturnReasonTable } from './DataAnalysisAfterSalesTables.jsx';
import { DataAnalysisBreakdownPanel } from './DataAnalysisBreakdownPanel.jsx';
import { DataAnalysisFinanceOperationTable, DataAnalysisFinanceReconciliationPanel, DataAnalysisLargestDeductionsTable } from './DataAnalysisFinanceTables.jsx';
import { DataAnalysisActivityProductTable, DataAnalysisActivityTable } from './DataAnalysisMarketingTables.jsx';
import { DataAnalysisMetricGrid } from './DataAnalysisMetricGrid.jsx';
import { DataAnalysisOverviewContent } from './DataAnalysisOverviewContent.jsx';
import { DataAnalysisQualityPanel } from './DataAnalysisQualityPanel.jsx';
import { DataAnalysisProductRankingTable, DataAnalysisStockRiskTable } from './DataAnalysisRankingTable.jsx';
import { DataAnalysisMarketPanel } from './DataAnalysisMarketPanel.jsx';
import { DataAnalysisTrendPanel } from './DataAnalysisTrendPanel.jsx';
import { DataAnalysisTrafficCoveragePanel, DataAnalysisTrafficFunnel, DataAnalysisTrafficTrend } from './DataAnalysisTrafficPanels.jsx';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

function ResponsiveTwoColumn({ children, wideLeft = false, equalHeight = true }) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: {
          xs: 'minmax(0, 1fr)',
          md: wideLeft ? 'minmax(0, 1.35fr) minmax(320px, 0.65fr)' : 'repeat(2, minmax(0, 1fr))',
        },
        gap: 1.5,
        alignItems: equalHeight ? 'stretch' : 'start',
        '& > .MuiCard-root': {
          height: equalHeight ? '100%' : 'auto',
        },
      }}
    >
      {children}
    </Box>
  );
}

function ResponsiveMasonryColumns({ left, right }) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
        gap: 1.5,
        alignItems: 'stretch',
      }}
    >
      <Stack
        spacing={1.5}
        minWidth={0}
        sx={{
          height: '100%',
          minHeight: 0,
          '& > .MuiCard-root:last-of-type': {
            flex: '1 0 auto',
            minHeight: 0,
          },
        }}
      >
        {left}
      </Stack>
      <Stack
        spacing={1.5}
        minWidth={0}
        sx={{
          height: '100%',
          minHeight: 0,
          '& > .MuiCard-root:last-of-type': {
            flex: '1 0 auto',
            minHeight: 0,
          },
        }}
      >
        {right}
      </Stack>
    </Box>
  );
}

function SalesContent({ dashboard, onProductLinkError }) {
  const sales = dashboard.sales || {};
  return (
    <Stack spacing={1.5}>
      <DataAnalysisMetricGrid metrics={sales.metrics || []} columns={4} />
      <DataAnalysisTrendPanel trend={sales.trend || []} />
      <ResponsiveTwoColumn>
        <DataAnalysisBreakdownPanel
          title="订单状态分布"
          subtitle="按平台订单状态映射为可读名称。"
          rows={sales.statusBreakdown || []}
          sourceLabel="平台订单状态"
        />
        <DataAnalysisBreakdownPanel
          title="履约方式分布"
          subtitle="按订单履约方式和订单来源分组。"
          rows={sales.fulfillmentBreakdown || []}
          sourceLabel="平台订单履约字段"
        />
      </ResponsiveTwoColumn>
      <DataAnalysisProductRankingTable rows={sales.productRanking || []} onProductLinkError={onProductLinkError} />
    </Stack>
  );
}

function ProductContent({ dashboard, onProductLinkError }) {
  const products = dashboard.products || {};
  const metricIds = new Set([
    'productCount',
    'activeProductCount',
    'inSaleProductCount',
    'toSupplyProductCount',
    'archivedProductCount',
    'productErrorCount',
    'averageProductPrice',
  ]);
  return (
    <Stack spacing={1.5}>
      <DataAnalysisMetricGrid
        metrics={(products.metrics || []).filter((metric) => metricIds.has(metric.id))}
        columns={7}
      />
      <ResponsiveMasonryColumns
        left={
          <>
            <DataAnalysisQualityPanel quality={products.quality || {}} showFieldGaps />
            <DataAnalysisBreakdownPanel
              title="价格带分布"
              subtitle="只统计可经营候选商品的有效价格；不使用归档商品或竞品价格。"
              rows={products.priceBands || []}
              labelKey="label"
              sourceLabel="平台商品价格本地数据"
            />
          </>
        }
        right={
          <>
            <DataAnalysisBreakdownPanel
              title="商品状态分布"
              subtitle="使用平台商品状态代码，避免历史乱码状态名称。"
              rows={products.visibilityBreakdown || []}
              sourceLabel="平台商品状态"
            />
            <DataAnalysisBreakdownPanel
              title="类目覆盖"
              subtitle="类目未返回会单独保留，不归入虚构类目。"
              rows={products.categoryBreakdown || []}
              labelKey="category"
              sourceLabel="平台商品类目字段"
            />
          </>
        }
      />
      <DataAnalysisProductRankingTable
        rows={dashboard.sales?.productRanking || []}
        title="商品销售表现"
        onProductLinkError={onProductLinkError}
      />
    </Stack>
  );
}

function ProfitContent({ dashboard }) {
  const finance = dashboard.finance || {};
  const metricIds = new Set([
    'financeNetAmount',
    'financeIncomeAmount',
    'financeDeductionAmount',
    'financeTransactionCount',
    'financeCurrencyCoverage',
    'confirmedPurchaseCost',
    'actualNetProfit',
    'actualNetProfitCoverage',
  ]);
  return (
    <Stack spacing={1.5}>
      <DataAnalysisMetricGrid metrics={(finance.metrics || []).filter((metric) => metricIds.has(metric.id))} columns={4} />
      <ResponsiveTwoColumn>
        <DataAnalysisFinanceOperationTable
          rows={finance.operationBreakdown || []}
          flowSummary={finance.flowSummary || {}}
        />
        <DataAnalysisLargestDeductionsTable rows={finance.largestDeductions || []} />
      </ResponsiveTwoColumn>
      <DataAnalysisFinanceReconciliationPanel metrics={finance.metrics || []} />
    </Stack>
  );
}

function InventoryContent({ dashboard, onProductLinkError }) {
  const products = dashboard.products || {};
  const metricIds = new Set([
    'activeProductCount',
    'inSaleProductCount',
    'stockUnits',
    'archivedStockUnits',
    'outOfStockCount',
    'inSaleOutOfStockCount',
    'lowStockCount',
  ]);
  return (
    <Stack spacing={1.5}>
      <DataAnalysisMetricGrid metrics={(products.metrics || []).filter((metric) => metricIds.has(metric.id))} columns={7} />
      <ResponsiveTwoColumn wideLeft>
        <DataAnalysisStockRiskTable rows={products.stockRiskRows || []} onProductLinkError={onProductLinkError} />
        <DataAnalysisQualityPanel quality={products.inventoryQuality || products.quality || {}} showFieldGaps />
      </ResponsiveTwoColumn>
      <DataAnalysisProductRankingTable
        rows={products.replenishmentRanking || []}
        title="补货参考销量排行"
        subtitle="销量来自所选期间真实订单；当前不在样本不足时生成建议补货数量。"
        emptyDescription="所选期间有效订单商品均不属于当前可经营候选，未生成补货排行。"
        onProductLinkError={onProductLinkError}
      />
    </Stack>
  );
}

function AfterSalesContent({ dashboard, onProductLinkError }) {
  const afterSales = dashboard.afterSales || {};
  return (
    <Stack spacing={1.5}>
      <DataAnalysisMetricGrid metrics={afterSales.metrics || []} columns={5} />
      <ResponsiveTwoColumn>
        <DataAnalysisBreakdownPanel
          title="售后状态分布"
          subtitle="按平台售后状态代码映射。"
          rows={afterSales.statusBreakdown || []}
          sourceLabel="平台售后状态"
        />
        <DataAnalysisReturnReasonTable
          rows={afterSales.reasonCodeBreakdown || []}
          quality={afterSales.dataQuality || {}}
        />
      </ResponsiveTwoColumn>
      <DataAnalysisRecentReturnsTable rows={afterSales.recentRows || []} onProductLinkError={onProductLinkError} />
    </Stack>
  );
}

function MarketingContent({ dashboard, onProductLinkError }) {
  const marketing = dashboard.marketing || {};
  return (
    <Stack spacing={1.5}>
      <DataAnalysisMetricGrid metrics={marketing.metrics || []} columns={4} />
      <ResponsiveTwoColumn>
        <DataAnalysisActivityTable rows={marketing.activityRows || []} />
        <DataAnalysisActivityProductTable rows={marketing.productRows || []} onProductLinkError={onProductLinkError} />
      </ResponsiveTwoColumn>
    </Stack>
  );
}

function TrafficContent({ dashboard, onSyncTraffic, syncingTraffic = false }) {
  const traffic = dashboard.traffic || {};
  if (!traffic.rowCount) {
    return (
      <Stack spacing={1.5}>
        <Box sx={{ borderRadius: 3, bgcolor: '#fff', boxShadow: '0 10px 30px rgba(31, 52, 88, 0.05)', p: { xs: 2.5, md: 3.25 }, textAlign: 'center' }}>
          <Stack spacing={1.1} alignItems="center" maxWidth={560} mx="auto">
            <Typography fontWeight={900} variant="h6">还没有官方流量快照</Typography>
            <Typography color="text.secondary" variant="body2">
              同步后读取访问、商品浏览、加购、下单件数和官方成交额；不会用订单数伪造流量数据。
            </Typography>
            <Button variant="contained" disabled={syncingTraffic} onClick={onSyncTraffic}>
              {syncingTraffic ? '正在同步官方流量' : '同步官方流量数据'}
            </Button>
          </Stack>
        </Box>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' }, gap: 1.5 }}>
          <Box sx={{ borderRadius: 2.75, bgcolor: '#fff', boxShadow: '0 10px 30px rgba(31, 52, 88, 0.055)', p: 2 }}>
            <Stack spacing={1}>
              <Typography fontWeight={900}>同步范围</Typography>
              <Typography color="text.secondary" variant="body2">按工具栏选择的店铺和日期读取官方日粒度流量数据。</Typography>
              <Stack direction="row" gap={0.75} flexWrap="wrap">
                {['访问', '浏览', '加购', '成交额'].map((item) => <Chip key={item} label={item} size="small" sx={{ bgcolor: '#f1f5ff', color: 'primary.main', fontWeight: 750 }} />)}
              </Stack>
            </Stack>
          </Box>
          <Box sx={{ borderRadius: 2.75, bgcolor: '#fff', boxShadow: '0 10px 30px rgba(31, 52, 88, 0.055)', p: 2 }}>
            <Stack spacing={1}>
              <Typography fontWeight={900}>展示原则</Typography>
              <Typography color="text.secondary" variant="body2">只有接口实际返回的日期才参与趋势和漏斗；缺失日期不会用订单或估算值填充。</Typography>
              <Chip label="当前等待官方数据" size="small" sx={{ alignSelf: 'flex-start', bgcolor: '#f5f7fb', color: 'text.secondary', fontWeight: 750 }} />
            </Stack>
          </Box>
        </Box>
      </Stack>
    );
  }
  return (
    <Stack spacing={1.5}>
      <DataAnalysisMetricGrid metrics={traffic.metrics || []} columns={4} />
      <ResponsiveTwoColumn wideLeft equalHeight={false}>
        <DataAnalysisTrafficTrend trend={traffic.dailyTrend || []} coverage={traffic.coverage} />
        <DataAnalysisTrafficFunnel
          funnel={traffic.funnel || []}
          coverage={traffic.coverage}
          showExtendedInsights
        />
      </ResponsiveTwoColumn>
      <DataAnalysisTrafficCoveragePanel coverage={traffic.coverage} sourceSyncedAt={traffic.sourceSyncedAt} />
    </Stack>
  );
}

export function DataAnalysisModuleContent({
  activeModuleId,
  dashboard,
  performanceState,
  onOpenModule,
  onSyncTraffic,
  isRefreshing = false,
  marketState,
  onReadMarketData,
  onSearchMarketData,
  onProductLinkError,
}) {
  if (activeModuleId === 'overview') {
    return (
      <DataAnalysisOverviewContent
        dashboard={dashboard}
        onOpenModule={onOpenModule}
        onProductLinkError={onProductLinkError}
      />
    );
  }
  if (activeModuleId === 'sales') return <SalesContent dashboard={dashboard} onProductLinkError={onProductLinkError} />;
  if (activeModuleId === 'products') return <ProductContent dashboard={dashboard} onProductLinkError={onProductLinkError} />;
  if (activeModuleId === 'traffic') {
    return <TrafficContent dashboard={dashboard} onSyncTraffic={onSyncTraffic} syncingTraffic={isRefreshing} />;
  }
  if (activeModuleId === 'market') {
    return (
      <DataAnalysisMarketPanel
        sources={dashboard.sources || []}
        onOpenModule={onOpenModule}
        marketState={marketState}
        onReadMarketData={onReadMarketData}
        onSearchMarketData={onSearchMarketData}
        onProductLinkError={onProductLinkError}
      />
    );
  }
  if (activeModuleId === 'advertising') return <DataAnalysisAdvertisingPanel state={performanceState} />;
  if (activeModuleId === 'profit') return <ProfitContent dashboard={dashboard} />;
  if (activeModuleId === 'inventory') return <InventoryContent dashboard={dashboard} onProductLinkError={onProductLinkError} />;
  if (activeModuleId === 'after-sales') return <AfterSalesContent dashboard={dashboard} onProductLinkError={onProductLinkError} />;
  if (activeModuleId === 'marketing') return <MarketingContent dashboard={dashboard} onProductLinkError={onProductLinkError} />;
  return null;
}
