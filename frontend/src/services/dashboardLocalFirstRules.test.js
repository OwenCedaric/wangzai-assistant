import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSplitAppSource } from '../test/appSource';

const appSource = readSplitAppSource();
const stylesSource = readFileSync(join(process.cwd(), 'src/styles.css'), 'utf8');
const dashboardOverviewSource = readFileSync(
  join(process.cwd(), 'src/features/dashboard/services/dashboardOverviewService.js'),
  'utf8'
);

describe('dashboard local-first rules', () => {
  it('builds the dashboard from one compact SQLite aggregate instead of the legacy renderer mirror', () => {
    expect(dashboardOverviewSource).toContain("getDomainCache('dashboard-overview', request.query");
    expect(appSource).toContain('readDashboardOverviewSnapshot(readableShops');
    expect(dashboardOverviewSource).toContain('createDashboardSummaryFromOverview(payload, request.scopedShops');
    expect(dashboardOverviewSource).toContain("source !== 'sqlite'");
    expect(appSource).not.toContain('readLocalDataFile(LOCAL_OZON_DATA_LAYER_FILE_KEY)');
    expect(appSource).toContain(
      '<DashboardPage shops={readableOzonShops} sidebarOpen={sidebarOpen} isActive={isActive} />'
    );
  });

  it('does not keep fixed dashboard business figures', () => {
    expect(appSource).not.toContain('const conversionRows = [');
    expect(appSource).not.toContain('const todoRows = [');
    expect(appSource).not.toContain('const hotProductRows = [');
    expect(appSource).not.toContain('const storePerformanceRows = [');
    expect(appSource).not.toContain("value: '¥18,642'");
    expect(appSource).not.toContain("amount: '12,842'");
    expect(appSource).not.toContain("sku: '1001-BK'");
    expect(appSource).not.toContain('Ozon 4店');
    expect(appSource).not.toContain('<Typography variant="subtitle2">904</Typography>');
  });

  it('shows explicit range and current-state metric definitions without developer storage wording', () => {
    expect(appSource).toContain("`${summary.rangeLabel || '今日'}销售额`");
    expect(appSource).toContain('待备货/发货');
    expect(appSource).toContain('实际净利润');
    expect(appSource).toContain('付费推广');
    expect(appSource).toContain('按最新更新时间排序');
    expect(appSource).not.toContain('最近同步记录，不受日期筛选影响');
    expect(appSource).not.toContain('label="本地 SQLite"');
    expect(appSource).not.toContain('label="本地数据"');
  });

  it('connects every visible homepage metric and exposes Chinese business labels only', () => {
    [
      'summary.salesTotalDisplay',
      'summary.salesOrderCount',
      'summary.netProfitDisplay',
      'summary.waitingDeliveryCount',
      'summary.afterSalesTodoCount',
      'summary.stockWarningCount',
      'promotionSummary.spentCny',
      'promotionSummary.orders',
      'promotionSummary.revenueCny',
      'promotionSummary.acos',
      'promotionSummary.roas',
      'promotionSummary.balanceCny',
      'store.currentTasks?.total',
    ].forEach((binding) => expect(appSource).toContain(binding));
    expect(appSource).toContain("{ label: '推广费占比'");
    expect(appSource).toContain("{ label: '推广投入产出比'");
    expect(appSource).toContain('<TableCell align="right">推广费占比</TableCell>');
    expect(appSource).not.toContain("{ label: 'ACOS'");
    expect(appSource).not.toContain("{ label: 'ROAS'");
    expect(appSource).not.toContain('<TableCell align="right">ACOS</TableCell>');
  });

  it('uses compact small-radius homepage tags instead of capsule chips', () => {
    expect(stylesSource).toContain('.dashboard-classic-board .MuiChip-root');
    expect(stylesSource).toContain('border-radius: 6px !important;');
  });

  it('keeps the last dashboard summary when the SQLite aggregate read fails', () => {
    const pageStart = appSource.indexOf('function DashboardPage');
    const pageEnd = appSource.indexOf('const operatingMatrixGroups', pageStart);
    const pageSource = appSource.slice(pageStart, pageEnd);
    const catchStart = pageSource.indexOf('.catch((error) => {');
    const catchSource = pageSource.slice(catchStart);

    expect(appSource).toContain('function dashboardSummaryHasRows(summary = {})');
    expect(catchSource).toContain('setDashboardSummary((current) =>');
    expect(catchSource).toContain('if (dashboardSummaryHasRows(current))');
    expect(catchSource).toContain('return createDashboardEmptySummary(scopedReadableShops');
  });

  it('rebuilds dashboard charts after the navigation width transition and keeps donut labels readable', () => {
    expect(appSource).toContain('const DASHBOARD_CHART_LAYOUT_SETTLE_MS = 340');
    expect(appSource).toContain('function DashboardPageContent({ shops = [], sidebarOpen = true, isActive = true })');
    expect(appSource).toContain("keys.delete('isActive')");
    expect(appSource).toContain('React.memo(DashboardPage, dashboardPagePropsEqual)');
    expect(appSource).toContain('setChartLayoutRevision((current) => current + 1)');
    expect(appSource).toContain('<DashboardTrendChart');
    expect(appSource).toContain('isActive={isActive}');
    expect(appSource).toContain('resolveDashboardTrendHover');
    expect(appSource).toContain('enabled: false');
    expect(appSource).toContain('className="dashboard-operations-card"');
  });

});
