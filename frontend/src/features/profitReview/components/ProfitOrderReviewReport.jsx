import AutoAwesomeRounded from '@mui/icons-material/AutoAwesomeRounded';
import CheckCircleOutlineRounded from '@mui/icons-material/CheckCircleOutlineRounded';
import HistoryRounded from '@mui/icons-material/HistoryRounded';
import QueryStatsRounded from '@mui/icons-material/QueryStatsRounded';
import ReceiptLongRounded from '@mui/icons-material/ReceiptLongRounded';
import TaskAltRounded from '@mui/icons-material/TaskAltRounded';
import TravelExploreRounded from '@mui/icons-material/TravelExploreRounded';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { formatSmartToolModelDisplayName } from '../../promptLibrary/services/smartToolModelService.js';
import { normalizeProfitReviewPresentation } from '../../promptLibrary/lib/smartToolProfitReviewConfig.js';
import { formatProfitOrderReviewUserText } from '../lib/profitOrderReviewText.js';

function finite(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function money(value, currency = 'CNY') {
  const number = finite(value);
  if (number === null) return '待确认';
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(number);
}

function number(value, suffix = '') {
  const parsed = finite(value);
  return parsed === null ? '暂无' : `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(parsed)}${suffix}`;
}

function reportText(value) {
  return formatProfitOrderReviewUserText(value);
}

function formulaText(value, mode = '') {
  const raw = String(value ?? '').trim();
  const source = reportText(value);
  if (/actualIncome|source|commission|acquiring|delivery|logistics|bus/iu.test(raw)) {
    return '实际收入－采购成本－佣金－罚款－收单费－配送服务费－物流费－巴士费';
  }
  if (source) return source;
  return mode === 'actual'
    ? '实际收入－采购成本－平台实际扣费－物流及跨境费用'
    : '销售收入－采购成本－预估平台费用－物流及跨境费用';
}

function Metric({ label, value, note = '', tone = 'slate', showNote = true }) {
  return (
    <Box className={`profit-order-review-metric is-${tone}`}>
      <Typography component="span">{label}</Typography>
      <Typography component="strong">{value}</Typography>
      {showNote && note ? <Typography component="small">{reportText(note)}</Typography> : null}
    </Box>
  );
}

function SectionHeading({ icon: Icon, title, description = '', tone = 'slate', showIcon = true }) {
  return (
    <Box className={`profit-order-review-section-heading is-${tone}`}>
      {showIcon ? <Box component="span" aria-hidden="true"><Icon fontSize="small" /></Box> : null}
      <Box>
        <Typography component="h2">{title}</Typography>
        {description ? <Typography component="p">{description}</Typography> : null}
      </Box>
    </Box>
  );
}

function ReportItems({ items = [] }) {
  if (!items.length) return null;
  return (
    <Box component="ol" className="profit-order-review-list">
      {items.map((item, index) => {
        const normalized = typeof item === 'string' ? { title: item } : item || {};
        return (
          <Box component="li" key={`${normalized.title || index}-${index}`}>
            <Typography component="h3">{reportText(normalized.title) || `建议 ${index + 1}`}</Typography>
            {normalized.evidence ? <Typography component="p">{reportText(normalized.evidence)}</Typography> : null}
            {normalized.action ? (
              <Typography component="p" className="profit-order-review-action-text">
                建议动作：{reportText(normalized.action)}
              </Typography>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

function EvidenceRow({ label, value }) {
  return (
    <Box className="profit-order-review-evidence-row">
      <Typography component="span">{label}</Typography>
      <Typography component="strong">{value}</Typography>
    </Box>
  );
}

function marginBarWidth(value, scale) {
  const parsed = finite(value);
  if (parsed === null || parsed <= 0) return 0;
  return Math.max(4, Math.min(100, (parsed / scale) * 100));
}

function MarginComparison({ current, history }) {
  const currentValue = finite(current);
  const historyValue = finite(history);
  if (currentValue === null && historyValue === null) return null;
  const scale = Math.max(20, Math.ceil(Math.max(currentValue || 0, historyValue || 0) / 10) * 10);
  const comparisonText = currentValue !== null && historyValue !== null
    ? `当前订单比历史${currentValue >= historyValue ? '高' : '低'} ${number(Math.abs(currentValue - historyValue), ' 个百分点')}`
    : '利润率数据尚未完整';
  return (
    <Box className="profit-order-review-comparison" aria-label="当前订单与历史利润率对比">
      <Box className="profit-order-review-comparison-copy">
        <Typography component="span">利润率对比</Typography>
        <Typography component="strong">{comparisonText}</Typography>
      </Box>
      <Box className="profit-order-review-comparison-bars">
        <Box className="profit-order-review-comparison-row">
          <Typography component="span">当前订单</Typography>
          <Box><Box style={{ width: `${marginBarWidth(currentValue, scale)}%` }} /></Box>
          <Typography component="strong">{number(currentValue, '%')}</Typography>
        </Box>
        <Box className="profit-order-review-comparison-row is-history">
          <Typography component="span">历史平均</Typography>
          <Box><Box style={{ width: `${marginBarWidth(historyValue, scale)}%` }} /></Box>
          <Typography component="strong">{number(historyValue, '%')}</Typography>
        </Box>
      </Box>
    </Box>
  );
}

export function ProfitOrderReviewReport({ result, presentation: presentationValue = null }) {
  const analysis = result?.analysis || {};
  const profit = analysis.profit || {};
  const history = analysis.ownProduct || {};
  const market = analysis.market || {};
  const decision = analysis.decision || {};
  const ai = result?.ai || {};
  const presentation = normalizeProfitReviewPresentation(presentationValue);
  const report = ai.report || null;
  const decisionLabel = decision.label || '等待判断';
  const summary = report?.executiveSummary
    || report?.investmentDecision
    || decision.reasons?.join(' ')
    || result?.statusLabel;
  const actions = report?.optimizationActions?.length
    ? report.optimizationActions
    : (analysis.actions || []).map((item) => ({ title: item }));
  const gaps = [...(report?.dataGaps || []), ...(analysis.dataGaps || [])]
    .map(reportText)
    .filter((item, index, list) => item && list.indexOf(item) === index);
  const marketPeriod = [market.statisticStartDate, market.statisticEndDate].filter(Boolean).join(' 至 ');
  const decisionTone = ['success', 'primary', 'warning', 'error'].includes(decision.tone)
    ? decision.tone
    : 'warning';
  const marketSignalLabel = {
    strong: '市场需求较强',
    neutral: '市场表现一般',
    weak: '市场信号偏弱',
    unknown: '市场数据待补',
  }[decision.marketSignal] || '市场数据待补';
  const displayedMarketSignal = market.status === 'skipped' ? '未使用市场数据' : marketSignalLabel;
  const marketStatusLabel = market.status === 'ready'
    ? '市场数据已返回'
    : (market.status === 'skipped' ? '本次未使用 Seerfar' : '市场数据待补');
  const knownExpenseTotal = (profit.expenses || []).reduce((total, item) => {
    const value = finite(item.value);
    return value === null ? total : total + Math.abs(value);
  }, 0);

  return (
    <Box
      component="article"
      className={`profit-order-review-report is-${decisionTone} is-density-${presentation.density}${presentation.paragraphIndent ? ' is-paragraph-indented' : ''}`}
    >
      <Box component="header" className="profit-order-review-report-header">
        {presentation.showAssistantBrand || presentation.showMarketSignal ? (
          <Box className="profit-order-review-header-topline">
            {presentation.showAssistantBrand ? (
              <Box className="profit-order-review-report-brand">
                <Box component="span" aria-hidden="true"><AutoAwesomeRounded /></Box>
                <Box>
                  <Typography component="strong">{presentation.assistantName}</Typography>
                  <Typography component="small">{presentation.assistantSubtitle}</Typography>
                </Box>
              </Box>
            ) : <Box />}
            {presentation.showMarketSignal ? (
              <Box className={`profit-order-review-market-signal is-${decision.marketSignal || 'unknown'}`}>
                <Box component="span" aria-hidden="true" />
                <Typography component="small">市场信号</Typography>
                <Typography component="strong">{displayedMarketSignal}</Typography>
              </Box>
            ) : null}
          </Box>
        ) : null}
        <Box className="profit-order-review-header-copy">
          <Typography component="p" className="profit-order-review-eyebrow">
            订单复核 · {analysis.order?.orderNumber || '订单号待确认'}
          </Typography>
          <Typography component="p" className="profit-order-review-verdict-label">经营判断</Typography>
          <Typography component="h1">{reportText(decisionLabel)}</Typography>
          <Typography component="p" className="profit-order-review-lead">{reportText(summary)}</Typography>
          <Box className="profit-order-review-product-line">
            <Typography component="strong">{analysis.product?.title || '当前订单商品'}</Typography>
            {analysis.product?.sku ? <Typography component="span">SKU {analysis.product.sku}</Typography> : null}
            {analysis.product?.offerId ? <Typography component="span">货号 {analysis.product.offerId}</Typography> : null}
            {analysis.order?.shop ? <Typography component="span">{analysis.order.shop}</Typography> : null}
          </Box>
        </Box>
        <Box className="profit-order-review-meta">
          <Box component="span"><CheckCircleOutlineRounded />{profit.modeLabel || '利润待确认'}</Box>
          <Box component="span"><TravelExploreRounded />{marketStatusLabel}</Box>
          {presentation.showModel && ai.status === 'ready' ? (
            <Box component="span"><AutoAwesomeRounded />{formatSmartToolModelDisplayName(ai.model || '已配置')}</Box>
          ) : null}
        </Box>
      </Box>

      <Box className="profit-order-review-metrics" aria-label="订单核心指标">
        <Metric showNote={presentation.showMetricNotes} tone="blue" label="订单收入" value={money(profit.revenue)} note="本单实际入账金额" />
        <Metric showNote={presentation.showMetricNotes} tone={finite(profit.profit) !== null && Number(profit.profit) < 0 ? 'red' : 'green'} label={profit.modeLabel || '订单利润'} value={money(profit.profit)} note={profit.profit === null ? '数据待补充' : '账本已核算'} />
        <Metric showNote={presentation.showMetricNotes} tone="violet" label="利润率" value={number(profit.margin, '%')} note="按当前账本口径" />
        <Metric showNote={presentation.showMetricNotes} tone="amber" label="同商品历史" value={`${history.readyProfitCount || 0}/${history.orderCount || 0} 笔`} note={`累计利润 ${money(history.totalProfit)}`} />
      </Box>

      <Box component="section" className="profit-order-review-report-section">
        <SectionHeading
          icon={ReceiptLongRounded}
          showIcon={presentation.showSectionIcons}
          tone="green"
          title="利润与费用复核"
          description={formulaText(profit.formula, profit.mode)}
        />
        <Box className="profit-order-review-expense-table">
          <Box className="profit-order-review-expense-head">
            <Typography>费用项目</Typography>
            <Typography>费用占比</Typography>
            <Typography>账本金额</Typography>
            <Typography>数据状态</Typography>
          </Box>
          {profit.expenses?.map((item) => {
            const expenseValue = finite(item.value);
            const share = expenseValue === null || !knownExpenseTotal
              ? 0
              : Math.min(100, (Math.abs(expenseValue) / knownExpenseTotal) * 100);
            const isBiggest = item.key === profit.biggestDrag?.key;
            return (
              <Box className={`profit-order-review-expense-row${isBiggest ? ' is-biggest' : ''}`} key={item.key}>
                <Typography>{item.label}</Typography>
                <Box className="profit-order-review-expense-share" aria-label={`${item.label}占已知费用 ${number(share, '%')}`}>
                  <Box style={{ width: `${share}%` }} />
                </Box>
                <Typography>{money(item.value)}</Typography>
                <Typography>{item.value === null ? '待确认' : '已读取'}</Typography>
              </Box>
            );
          })}
        </Box>
        {profit.biggestDrag ? (
          <Typography component="p" className="profit-order-review-key-note">
            当前最大已知费用项是 <strong>{profit.biggestDrag.label}</strong>，金额 {money(profit.biggestDrag.value)}。
          </Typography>
        ) : null}
        <ReportItems items={report?.profitDiagnosis || []} />
      </Box>

      <Box component="section" className="profit-order-review-report-section">
        <SectionHeading
          icon={HistoryRounded}
          showIcon={presentation.showSectionIcons}
          tone="violet"
          title="同 SKU 店内表现"
          description="用同商品历史订单判断这次低利润是偶发问题，还是持续性问题。"
        />
        <MarginComparison current={profit.margin} history={history.margin} />
        <Box className="profit-order-review-evidence-grid">
          <EvidenceRow label="历史订单" value={`${history.orderCount || 0} 笔`} />
          <EvidenceRow label="可核算订单" value={`${history.readyProfitCount || 0} 笔`} />
          <EvidenceRow label="亏损订单" value={`${history.lossOrderCount || 0} 笔`} />
          <EvidenceRow label="历史平均利润" value={money(history.averageProfit)} />
          <EvidenceRow label="历史利润率" value={number(history.margin, '%')} />
          <EvidenceRow label="历史累计利润" value={money(history.totalProfit)} />
        </Box>
      </Box>

      <Box component="section" className="profit-order-review-report-section">
        <SectionHeading
          icon={QueryStatsRounded}
          showIcon={presentation.showSectionIcons}
          tone="blue"
          title="商品市场表现"
          description={market.status === 'ready'
            ? `数据来源 Seerfar${marketPeriod ? ` · ${marketPeriod}` : ' · 近 30 天'}`
            : reportText(market.message)}
        />
        {market.status === 'ready' ? (
          <>
            <Box className="profit-order-review-evidence-grid">
              <EvidenceRow label="近30天销量" value={number(market.metrics?.sales30d, ' 件')} />
              <EvidenceRow label="近30天销售额" value={money(market.metrics?.revenue30d, 'RUB')} />
              <EvidenceRow label="日均销量" value={number(market.metrics?.averageDailyUnits, ' 件')} />
              <EvidenceRow label="当前评分" value={number(market.metrics?.rating)} />
              <EvidenceRow label="近7天变化" value={number(market.metrics?.recentSalesChange, '%')} />
              <EvidenceRow label="退货取消率" value={number(market.metrics?.returnCancelRate, '%')} />
            </Box>
            {report?.marketAssessment ? (
              <Typography component="p" className="profit-order-review-prose">{reportText(report.marketAssessment)}</Typography>
            ) : null}
          </>
        ) : (
          <Typography component="p" className="profit-order-review-empty-note">
            {market.status === 'skipped'
              ? '本次已按选择跳过 Seerfar，报告仅根据订单利润和同 SKU 店内历史生成。'
              : '当前没有足够市场数据，投入判断已按保守口径输出，不会猜测销量和趋势。'}
          </Typography>
        )}
      </Box>

      <Box component="section" className="profit-order-review-report-section">
        <SectionHeading
          icon={TaskAltRounded}
          showIcon={presentation.showSectionIcons}
          tone="amber"
          title="建议执行顺序"
          description="按影响利润的优先级处理，完成后再决定是否扩大补货和广告投入。"
        />
        <ReportItems items={actions} />
      </Box>

      {gaps.length ? (
        <Box component="section" className="profit-order-review-report-section profit-order-review-gaps">
          <Typography component="h2">仍需确认的数据</Typography>
          <Box component="ul">
            {gaps.map((item) => <Typography component="li" key={item}>{item}</Typography>)}
          </Box>
        </Box>
      ) : null}

      <Box component="footer" className="profit-order-review-footer">
        <Typography>
          {market.status === 'skipped'
            ? '利润金额来自完整利润账本；本次未调用 Seerfar。该报告只读，不修改订单和金额。'
            : '利润金额来自完整利润账本；市场指标来自 Seerfar。该报告只读，不修改订单和金额。'}
        </Typography>
        {ai.status !== 'ready' ? <Typography>{reportText(ai.message)}</Typography> : null}
      </Box>
    </Box>
  );
}
