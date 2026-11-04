import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const sourcePath = join(process.cwd(), 'src', 'features', 'paidPromotion', 'PaidPromotionPage.jsx');
const tablesSourcePath = join(
  process.cwd(),
  'src',
  'features',
  'paidPromotion',
  'components',
  'PaidPromotionTables.jsx'
);
const formattersSourcePath = join(
  process.cwd(),
  'src',
  'features',
  'paidPromotion',
  'lib',
  'paidPromotionFormatters.js'
);
const appSourcePath = join(process.cwd(), 'src', 'App.jsx');
const stylesPath = join(process.cwd(), 'src', 'styles.css');
const source = [sourcePath, tablesSourcePath, formattersSourcePath]
  .map((filePath) => readFileSync(filePath, 'utf8'))
  .join('\n');
const appSource = readFileSync(appSourcePath, 'utf8');
const styles = readFileSync(stylesPath, 'utf8');
const finalVisualBaseline = (styles.split('付费推广最终视觉基线')[1] || '').split('付费推广最终视觉基线结束')[0];

describe('付费推广视觉基线', () => {
  it('keeps page and write dialog controls on the same small-radius system', () => {
    expect(finalVisualBaseline).toContain('.paid-promotion-page .MuiButton-root');
    expect(finalVisualBaseline).toContain('.paid-promotion-write-dialog .MuiButton-root');
    expect(finalVisualBaseline).toContain('.paid-promotion-page .MuiChip-root');
    expect(finalVisualBaseline).toContain('border-radius: 7px !important');
    expect(finalVisualBaseline).toContain('border-radius: 6px !important');
    expect(source).toContain('className="paid-promotion-write-dialog"');
  });

  it('uses flat enterprise surfaces instead of glass gradients and hover lifting', () => {
    expect(finalVisualBaseline).toContain('backdrop-filter: none !important');
    expect(finalVisualBaseline).toContain('background: var(--promotion-surface) !important');
    expect(finalVisualBaseline).toContain('transform: none !important');
    expect(finalVisualBaseline).not.toContain('linear-gradient');
  });

  it('removes nested outlines and keeps the plan management column readable', () => {
    expect(finalVisualBaseline).toContain('.paid-promotion-overview-card');
    expect(finalVisualBaseline).toContain('border: 0 !important');
    expect(finalVisualBaseline).toContain('minmax(420px, 0.68fr)');
    expect(finalVisualBaseline).toContain('min-height: 78px');
    expect(finalVisualBaseline).toContain('.paid-promotion-campaign-row.active::before');
    expect(finalVisualBaseline).toContain('display: none');
  });

  it('uses fixed plan rows while keeping the list and detail cards the same height', () => {
    expect(finalVisualBaseline).toContain('.paid-promotion-workspace-grid.compact-workspace.tab-plans');
    expect(finalVisualBaseline).toMatch(
      /\.paid-promotion-workspace-grid\.compact-workspace\.tab-plans\s*\{\s*align-items: stretch;/u
    );
    expect(finalVisualBaseline).toContain('.paid-promotion-workspace-grid.tab-plans .paid-promotion-campaign-table-shell');
    expect(finalVisualBaseline).toContain('height: 794px');
    expect(finalVisualBaseline).toContain('flex: 0 0 794px');
    expect(finalVisualBaseline).toContain('grid-template-rows: 50px repeat(12, 62px)');
    expect(finalVisualBaseline).toContain('grid-auto-rows: 62px');
    expect(finalVisualBaseline).toContain('align-content: start');
    expect(finalVisualBaseline).not.toContain('minmax(62px, 1fr)');
    expect(finalVisualBaseline).toMatch(
      /\.paid-promotion-workspace-grid\.compact-workspace\.tab-plans \.paid-promotion-list-card\s*\{\s*height: 100%;/u
    );
    expect(finalVisualBaseline).toMatch(
      /\.paid-promotion-workspace-grid\.tab-plans \.paid-promotion-pagination-bar\s*\{\s*margin-top: auto;/u
    );
  });

  it('uses plain Chinese metric names and exposes advertising ROI', () => {
    expect(source).toContain("label: '广告投产比'");
    expect(source).toContain("value: formatPromotionMetric(summary, 'roas', formatMetric),");
    expect(source).not.toContain("' 倍'");
    expect(source).toContain("label: '广告费占比'");
    expect(source).toContain("label: '点击率'");
    expect(source).toContain("label: '单次点击成本'");
    expect(source).toContain('推荐 · 竞争 · 最低订单出价 · 最低点击出价');
    expect(source).not.toContain("{ label: 'ROAS'");
    expect(source).not.toContain("{ label: 'ACOS'");
    expect(source).not.toContain('<Typography>CTR</Typography>');
    expect(source).not.toContain('<Typography>CPC</Typography>');
    expect(source).not.toContain('Search Promo');
    expect(source).not.toContain('商品名 / 货号 / SKU');
  });

  it('widens the plan list and exposes the full decision metric groups without raw API fields', () => {
    expect(finalVisualBaseline).toContain('minmax(0, 1.72fr) minmax(420px, 0.68fr)');
    expect(finalVisualBaseline).toContain('.paid-promotion-campaign-metric-cell');
    expect(source).toContain('展示 · 点击 · 点击率');
    expect(source).toContain('花费 · 单次点击成本');
    expect(source).toContain('订单 · 销售额 · 费比 · 投产比');
    expect(source).toContain("formatCampaignMetric(campaign, 'revenue', formatMoney, rubToCnyRate)");
    expect(source).toContain("formatCampaignMetric(campaign, 'acos', formatPercent)");
    expect(source).toContain("formatCampaignMetric(campaign, 'roas', formatMetric)");
  });

  it('calculates optional ratio metrics from base facts and never exposes API-field jargon', () => {
    expect(source).toContain("formatPromotionMetric(summary, 'roas', formatMetric)");
    expect(source).toContain("formatPromotionMetric(summary, 'acos', formatPercent)");
    expect(source).toContain("formatPromotionMetric(summary, 'ctr', formatPercent)");
    expect(source).toContain("formatPromotionMetric(summary, 'cpc', formatMoney, rubToCnyRate)");
    expect(source).toContain("return '未读取';");
    expect(source).not.toContain("return '接口未提供';");
    expect(source).toContain("selectedCampaign.budgetRemainingSource === 'calculated' ? '剩余（计算）' : '剩余'");
  });

  it('uses stable high-contrast colors to distinguish every compound campaign metric', () => {
    for (const tone of ['impressions', 'clicks', 'ctr', 'spent', 'cpc', 'orders', 'revenue', 'acos', 'roas']) {
      expect(source).toContain(`tone="${tone}"`);
      expect(finalVisualBaseline).toContain(`.paid-promotion-campaign-metric-value.tone-${tone}`);
    }
    expect(source).toContain('function CampaignMetricValue');
    expect(finalVisualBaseline).toContain('font-size: 14px');
    expect(finalVisualBaseline).toContain('font-weight: 700');
    expect(finalVisualBaseline).toContain('text-rendering: auto');
    expect(finalVisualBaseline).toContain('grid-template-rows: 24px 22px');
    expect(finalVisualBaseline).toContain('align-items: baseline');
    expect(finalVisualBaseline).toContain('align-self: baseline');
    expect(finalVisualBaseline).toContain('.paid-promotion-campaign-metric-value {');
    expect(finalVisualBaseline).toMatch(/\.paid-promotion-campaign-metric-value \{[\s\S]*?border: 0;[\s\S]*?background: transparent;/u);
    expect(finalVisualBaseline).toMatch(/\.paid-promotion-campaign-metric-value\.tone-impressions \{\s*color: #1e40af;/u);
    expect(finalVisualBaseline).toMatch(/\.paid-promotion-campaign-metric-value\.tone-acos \{\s*color: #b42318;/u);
    expect(finalVisualBaseline).toContain('text-overflow: ellipsis');
  });

  it('uses the native Windows text rasterizer with integer sizes and real font weights', () => {
    expect(finalVisualBaseline).toContain('--promotion-font-family: "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif');
    expect(finalVisualBaseline).toContain('font-family: var(--promotion-font-family) !important');
    expect(finalVisualBaseline).toContain('font-synthesis: none');
    expect(finalVisualBaseline).toContain('-webkit-font-smoothing: auto');
    expect(finalVisualBaseline).toContain('text-rendering: auto');
    expect(finalVisualBaseline).toContain('font-variant-numeric: tabular-nums');
    expect(finalVisualBaseline).not.toMatch(/font-size:\s*\d+\.\d+px/u);
    expect(finalVisualBaseline).not.toMatch(/font-weight:\s*(650|750|800|900|950)/u);
    expect(finalVisualBaseline).not.toContain('text-rendering: optimizeLegibility');
    expect(finalVisualBaseline).not.toContain('letter-spacing: 0.01em');
  });

  it('distinguishes missing values from a real zero returned by Performance API', () => {
    expect(source).toContain('function isMissingMetricValue(value)');
    expect(source).toContain("if (isMissingMetricValue(value)) return '未返回';");
    expect(source).toContain('if (number === 0) return formatCnyAmount(0);');
  });

  it('shows real RUB values while an official CNY rate is delayed and warms from the local official-rate cache', () => {
    expect(source).toContain('listRubCnyRateCache({ limit: 30, timeoutMs: 5000 })');
    expect(source).toContain('getLatestCachedRubCnyRate(cachedPayload)');
    expect(source).toContain("return `${number.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 卢布`;");
    expect(source).toContain('timeoutMs: 30000');
  });

  it('keeps internal API payloads and read stages out of user-facing navigation', () => {
    expect(source).not.toContain("{ value: 'data', label: '全部数据' }");
    expect(source).not.toContain("{ value: 'status', label: '读取状态' }");
    expect(source).toContain("{ value: 'stats', label: '统计报表' }");
    expect(source).toContain('className="paid-promotion-report-switcher"');
    expect(source).not.toContain('paid-promotion-verification-line');
    expect(styles).not.toContain('.paid-promotion-verification-line');
  });

  it('loads all paid-promotion order report rows only inside the dedicated report view', () => {
    expect(source).toContain("{ value: 'orders', label: '推广订单' }");
    expect(source).toContain('readPerformanceOrders(');
    expect(source).toContain('<PromotionOrderTable');
    expect(source).toContain('共 {rows.length} 条推广订单记录');
    expect(source).toContain('const pageSize = 20;');
  });

  it('keeps every visible Ozon report option connected and shows its precise empty reason', () => {
    for (const [value, label] of [
      ['trend', '日报趋势'],
      ['orders', '推广订单'],
      ['products', '商品效果'],
      ['expense', '花费明细'],
      ['media', '媒体统计'],
      ['allSkuOrders', '全店订单'],
      ['allSkuProducts', '全店商品'],
      ['phrases', '搜索词'],
      ['attribution', '归因统计'],
      ['video', '视频统计'],
      ['vendorTraffic', '外部流量'],
      ['vendorOrders', '外部订单'],
    ]) {
      expect(source).toContain(`{ value: '${value}', label: '${label}' }`);
    }
    expect(source).toContain('readPerformanceAdvancedReport(');
    expect(source).toContain("emptyMessage={activeAdvancedReport?.message || ''}");
  });

  it('uses bounded campaign pagination instead of an endless plan list', () => {
    expect(source).toContain('const pageSize = 12;');
    expect(source).not.toContain('--campaign-page-row-count');
    expect(source).toContain('<Pagination');
    expect(source).toContain('className="paid-promotion-pagination-bar"');
    expect(finalVisualBaseline).toContain('.paid-promotion-campaign-table-shell');
  });

  it('shows the complete cross-plan promoted product catalog without a silent row cap', () => {
    expect(source).toContain("readDepth: 'products'");
    expect(source).toContain('当前店铺全部推广商品');
    expect(source).toContain('formatPromotionCampaignAssignment(product)');
    expect(source).toContain('第 {page} / {pageCount} 页 · 共 {rows.length} 条');
    expect(source).toContain('const pageSize = 20;');
    expect(source).toContain('const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);');
  });

  it('groups product metrics like the plan list and keeps integer-pixel crisp typography', () => {
    expect(source).toContain('className="paid-promotion-product-metric-head"');
    expect(source).toContain('className="paid-promotion-product-metric-cell"');
    expect(source).toContain('className="paid-promotion-product-metric-cell conversion"');
    expect(source).toContain("formatPromotionMetric(product, 'impressions', formatPlainNumber)");
    expect(source).toContain("formatPromotionMetric(product, 'revenue', formatMoney, rubToCnyRate)");
    expect(source).toContain("formatPromotionMetric(product, 'roas', formatMetric)");
    expect(source).toContain('tone="bid"');
    expect(finalVisualBaseline).toContain('.paid-promotion-product-table.mode-products .paid-promotion-product-row');
    expect(finalVisualBaseline).toContain('.paid-promotion-product-metric-head');
    expect(finalVisualBaseline).toContain('.paid-promotion-product-metric-cell');
    expect(finalVisualBaseline).toContain('font-variant-numeric: tabular-nums');
    expect(finalVisualBaseline).toContain('-webkit-font-smoothing: auto');
    expect(finalVisualBaseline).toContain('text-rendering: auto');
    expect(finalVisualBaseline).toContain('.paid-promotion-campaign-metric-value.tone-bid');
  });

  it('keeps a separate operation plan selector while product rows remain cross-plan', () => {
    expect(source).toContain('label="写入目标计划"');
    expect(source).toContain('只决定加商品、移除和调价写入哪个计划');
    expect(finalVisualBaseline).toContain('minmax(240px, 0.72fr)');
  });

  it('completes objects search and reports with the same grouped decision metrics', () => {
    expect(source).toContain("includeBidInsights: activePromotionTab === 'search'");
    expect(source).toContain('function PromotionMetricSummary');
    expect(source).toContain('function CampaignObjectTable');
    expect(source).toContain('function TrendTable');
    expect(source).toContain('function ExpenseTable');
    expect(source).toContain('function MediaStatsTable');
    expect(source).toContain('推荐 · 竞争 · 最低订单出价 · 最低点击出价');
    expect(source).toContain('metricKey="minimumCpcBid"');
    expect(finalVisualBaseline).toContain('grid-template-columns: repeat(4, minmax(0, 1fr))');
    expect(source).toContain('当前计划接口明确没有投放对象');
    expect(source).toContain('接口明确没有日报记录');
    expect(source).toContain('接口明确没有花费明细');
    expect(source).toContain('接口明确没有媒体广告记录');
    expect(source).toContain('getPromotionDataSetsAvailability([');
    expect(source).toContain('label="选择计划"');
    expect(source).toContain('label="选择商品"');
    expect(source).toContain('rows={displayedObjects}');
    expect(source).toContain('label="查看计划"');
    expect(source).toContain('label="统计范围"');
    expect(source).toContain('label="筛选商品"');
    expect(source).toContain("{selectedReportCampaign?.title || '全部计划'}");
    expect(finalVisualBaseline).toContain('.paid-promotion-metric-summary');
    expect(finalVisualBaseline).toContain('.paid-promotion-scope-toolbar');
    expect(finalVisualBaseline).toContain('.paid-promotion-report-head-actions');
    expect(finalVisualBaseline).toContain('.paid-promotion-report-head-product-filter');
    expect(finalVisualBaseline).not.toContain('.paid-promotion-report-product-filter-row');
    expect(finalVisualBaseline).toContain('.paid-promotion-product-table.mode-search');
    expect(finalVisualBaseline).toContain('.paid-promotion-object-row');
    expect(finalVisualBaseline).toContain('.paid-promotion-trend-row');
    expect(finalVisualBaseline).toContain('.paid-promotion-expense-row.expense-only');
  });

  it('keeps every report scoped, complete, and newest-first without silent row caps', () => {
    expect(source).toContain('sortPromotionRowsNewestFirst(');
    expect(source).toContain('mergePromotionExpenseRows(scopedExpenseRows, scopedDailyRows)');
    expect(source).toContain('getPromotionScopedDataAvailability(');
    expect(source).not.toContain('getSelectedCampaignTrend(selectedCampaign, overview).slice(-7)');
    expect(source).not.toContain('expenseStatsRows.slice(0, 80)');
    expect(source).not.toContain('mediaStatsRows.slice(0, 80)');
    expect(source).not.toContain('rows.slice(0, 120).map((row');
  });

  it('fills the remaining scaled viewport and keeps product paging at the card bottom', () => {
    expect(appSource).toContain("currentPage === 'paid-promotion' ? ' paid-promotion-content-shell' : ''");
    expect(finalVisualBaseline).toContain('.content-shell.paid-promotion-content-shell');
    expect(finalVisualBaseline).toMatch(
      /\.content-shell\.paid-promotion-content-shell\s*\{\s*width: 100%;\s*padding-right: 0;\s*padding-left: 0;/u
    );
    expect(finalVisualBaseline).toContain('width: min(1384px, calc(100% - 56px))');
    expect(finalVisualBaseline).toContain('justify-self: center');
    expect(finalVisualBaseline).toContain('height: calc(var(--workspace-design-height, 100vh) - 134px)');
    expect(finalVisualBaseline).toContain('max-height: calc(var(--workspace-design-height, 100vh) - 134px)');
    expect(finalVisualBaseline).toContain('overflow-y: auto');
    expect(finalVisualBaseline).not.toContain('overflow-y: hidden');
    expect(finalVisualBaseline).toContain('.paid-promotion-workspace-grid.tab-products .paid-promotion-product-table-shell');
    expect(finalVisualBaseline).toContain('grid-template-rows: minmax(0, 1fr) auto');
    expect(finalVisualBaseline).toContain('.paid-promotion-workspace-grid.tab-products .paid-promotion-product-table');
    expect(finalVisualBaseline).toContain('max-height: none');
  });
});
