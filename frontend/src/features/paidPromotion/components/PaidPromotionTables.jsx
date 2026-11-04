import CampaignRounded from '@mui/icons-material/CampaignRounded';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Pagination from '@mui/material/Pagination';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';
import { formatPromotionCampaignAssignment } from '../lib/paidPromotionProductRows.js';
import { getPromotionBidDisplayState } from '../lib/paidPromotionReportRows.js';
import {
  formatCampaignMetric,
  formatMetric,
  formatMoney,
  formatPercent,
  formatPlainNumber,
  formatPromotionMetric,
  getStatusTone,
  normalizeText,
} from '../lib/paidPromotionFormatters.js';

function CampaignListTable({ rows = [], selectedCampaignId = '', onSelect, rubToCnyRate = null }) {
  const pageSize = 12;
  const [page, setPage] = React.useState(1);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));

  React.useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);

  React.useEffect(() => {
    setPage(1);
  }, [rows]);

  if (!rows.length) {
    return (
      <Box className="paid-promotion-empty-state compact">
        <CampaignRounded color="disabled" />
        <Typography variant="body2">当前筛选条件下没有推广计划。</Typography>
      </Box>
    );
  }
  const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);
  return (
    <Box className="paid-promotion-campaign-table-shell">
      <Box className="paid-promotion-campaign-list compact-list full-height">
        <Box className="paid-promotion-campaign-header">
          <Typography>计划</Typography>
          <Typography>状态</Typography>
          <Box className="paid-promotion-campaign-metric-head">
            <Typography component="span">流量</Typography>
            <Typography component="span">展示 · 点击 · 点击率</Typography>
          </Box>
          <Box className="paid-promotion-campaign-metric-head">
            <Typography component="span">成本</Typography>
            <Typography component="span">花费 · 单次点击成本</Typography>
          </Box>
          <Box className="paid-promotion-campaign-metric-head">
            <Typography component="span">转化</Typography>
            <Typography component="span">订单 · 销售额 · 费比 · 投产比</Typography>
          </Box>
        </Box>
        {pageRows.map((campaign) => (
          <Box
            key={campaign.id}
            component="button"
            type="button"
            className={`paid-promotion-campaign-row${campaign.id === selectedCampaignId ? ' active' : ''}`}
            onClick={() => onSelect(campaign.id)}
          >
            <Box className="paid-promotion-campaign-main">
              <Typography variant="subtitle1" noWrap title={campaign.title}>
                {campaign.title}
              </Typography>
              <Typography variant="caption" color="text.secondary" noWrap title={`${campaign.id} · ${campaign.type}`}>
                {campaign.id} · {campaign.type} · 商品 {formatPlainNumber(campaign.productCount)}
              </Typography>
            </Box>
            <Chip size="small" color={getStatusTone(campaign)} label={campaign.statusLabel} variant="outlined" />
            <Box className="paid-promotion-campaign-metric-cell">
              <Box className="paid-promotion-campaign-metric-line primary">
                <CampaignMetricValue
                  label="展示"
                  tone="impressions"
                  value={formatCampaignMetric(campaign, 'impressions', formatPlainNumber)}
                />
                <span className="paid-promotion-campaign-metric-separator">/</span>
                <CampaignMetricValue
                  label="点击"
                  tone="clicks"
                  value={formatCampaignMetric(campaign, 'clicks', formatPlainNumber)}
                />
              </Box>
              <Box className="paid-promotion-campaign-metric-line secondary">
                <span className="paid-promotion-campaign-metric-label">点击率</span>
                <CampaignMetricValue
                  label="点击率"
                  tone="ctr"
                  value={formatCampaignMetric(campaign, 'ctr', formatPercent)}
                />
              </Box>
            </Box>
            <Box className="paid-promotion-campaign-metric-cell">
              <Box className="paid-promotion-campaign-metric-line primary">
                <CampaignMetricValue
                  label="花费"
                  tone="spent"
                  value={formatCampaignMetric(campaign, 'spent', formatMoney, rubToCnyRate)}
                />
              </Box>
              <Box className="paid-promotion-campaign-metric-line secondary">
                <span className="paid-promotion-campaign-metric-label">单次点击</span>
                <CampaignMetricValue
                  label="单次点击成本"
                  tone="cpc"
                  value={formatCampaignMetric(campaign, 'cpc', formatMoney, rubToCnyRate)}
                />
              </Box>
            </Box>
            <Box className="paid-promotion-campaign-metric-cell conversion">
              <Box className="paid-promotion-campaign-metric-line primary">
                <CampaignMetricValue
                  label="订单"
                  tone="orders"
                  value={`${formatCampaignMetric(campaign, 'orders', formatPlainNumber)} 单`}
                />
                <span className="paid-promotion-campaign-metric-separator">·</span>
                <CampaignMetricValue
                  label="销售额"
                  tone="revenue"
                  value={formatCampaignMetric(campaign, 'revenue', formatMoney, rubToCnyRate)}
                />
              </Box>
              <Box className="paid-promotion-campaign-metric-line secondary conversion-ratios">
                <span className="paid-promotion-campaign-metric-label">费比</span>
                <CampaignMetricValue
                  label="广告费比"
                  tone="acos"
                  value={formatCampaignMetric(campaign, 'acos', formatPercent)}
                />
                <span className="paid-promotion-campaign-metric-separator">·</span>
                <span className="paid-promotion-campaign-metric-label">投产比</span>
                <CampaignMetricValue
                  label="投产比"
                  tone="roas"
                  value={formatCampaignMetric(campaign, 'roas', formatMetric)}
                />
              </Box>
            </Box>
          </Box>
        ))}
      </Box>
      <Box className="paid-promotion-pagination-bar">
        <Typography variant="caption" color="text.secondary">
          第 {page} / {pageCount} 页 · 共 {rows.length} 个计划
        </Typography>
        <Pagination
          count={pageCount}
          page={page}
          onChange={(_, nextPage) => setPage(nextPage)}
          size="small"
          shape="rounded"
          siblingCount={1}
          boundaryCount={1}
        />
      </Box>
    </Box>
  );
}

function CampaignMetricValue({ label = '', tone = 'default', value = '' }) {
  const displayValue = String(value ?? '未读取');
  return (
    <span
      className={`paid-promotion-campaign-metric-value tone-${tone}`}
      title={`${label}：${displayValue}`}
      aria-label={`${label} ${displayValue}`}
    >
      {displayValue}
    </span>
  );
}

function BidInsightValue({ product = {}, metricKey = '', label = '', rubToCnyRate = null }) {
  const result = getPromotionBidDisplayState(product, metricKey);
  const displayValue = result.state === 'value' ? formatMoney(result.value, rubToCnyRate) : result.label;
  return (
    <Box className={`paid-promotion-bid-reference-item state-${result.state}`} title={`${label}：${displayValue}`}>
      <span>{label}</span>
      <CampaignMetricValue label={label} tone="bid" value={displayValue} />
    </Box>
  );
}

function PromotionMetricSummary({ summary = {}, rubToCnyRate = null }) {
  const metrics = [
    { label: '展示', tone: 'impressions', value: formatPlainNumber(summary.impressions) },
    { label: '点击', tone: 'clicks', value: formatPlainNumber(summary.clicks) },
    { label: '点击率', tone: 'ctr', value: formatPromotionMetric(summary, 'ctr', formatPercent) },
    { label: '花费', tone: 'spent', value: formatMoney(summary.spent, rubToCnyRate) },
    { label: '单次点击成本', tone: 'cpc', value: formatPromotionMetric(summary, 'cpc', formatMoney, rubToCnyRate) },
    { label: '订单', tone: 'orders', value: formatPlainNumber(summary.orders) },
    { label: '销售额', tone: 'revenue', value: formatMoney(summary.revenue, rubToCnyRate) },
    { label: '广告费占比', tone: 'acos', value: formatPromotionMetric(summary, 'acos', formatPercent) },
    { label: '投产比', tone: 'roas', value: formatPromotionMetric(summary, 'roas', formatMetric) },
  ];
  return (
    <Box className="paid-promotion-metric-summary" aria-label="当前分区汇总">
      {metrics.map((metric) => (
        <Box key={metric.label} className="paid-promotion-metric-summary-item">
          <Typography component="span">{metric.label}</Typography>
          <CampaignMetricValue label={metric.label} tone={metric.tone} value={metric.value} />
        </Box>
      ))}
    </Box>
  );
}

function CampaignProductTable({ rows = [], mode = 'products', rubToCnyRate = null, availability = null }) {
  const [page, setPage] = React.useState(1);
  const pageSize = 20;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  React.useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);
  React.useEffect(() => {
    setPage(1);
  }, [mode]);

  if (!rows.length) {
    return (
      <Typography color="text.secondary" className="paid-promotion-inline-empty">
        {availability?.status === 'empty' ? '当前统计范围接口明确没有明细记录。' : '当前分区尚未读取到明细数据。'}
      </Typography>
    );
  }
  const isProducts = mode === 'products';
  const isSearch = mode === 'search';
  const isStats = mode === 'stats';
  const isProductMetrics = isProducts || isStats;
  const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);
  return (
    <Box className={`paid-promotion-product-table-shell mode-${mode}`}>
      <Box className={`paid-promotion-product-table compact-table mode-${mode}`}>
        <Box className="paid-promotion-product-row header">
          <Typography>商品</Typography>
          {isProductMetrics ? (
            <>
              <Typography>状态</Typography>
              <Typography>出价</Typography>
              <Box className="paid-promotion-product-metric-head">
                <Typography component="span">流量</Typography>
                <Typography component="span">展示 · 点击 · 点击率</Typography>
              </Box>
              <Box className="paid-promotion-product-metric-head">
                <Typography component="span">成本</Typography>
                <Typography component="span">花费 · 单次点击成本</Typography>
              </Box>
              <Box className="paid-promotion-product-metric-head">
                <Typography component="span">转化</Typography>
                <Typography component="span">订单 · 销售额 · 费比 · 投产比</Typography>
              </Box>
            </>
          ) : isSearch ? (
            <>
              <Typography>状态</Typography>
              <Typography>当前出价</Typography>
              <Box className="paid-promotion-product-metric-head bid-reference">
                <Typography component="span">出价参考</Typography>
                <Typography component="span">推荐 · 竞争 · 最低订单出价 · 最低点击出价</Typography>
              </Box>
              <Box className="paid-promotion-product-metric-head">
                <Typography component="span">流量</Typography>
                <Typography component="span">展示 · 点击 · 点击率</Typography>
              </Box>
              <Box className="paid-promotion-product-metric-head">
                <Typography component="span">成本</Typography>
                <Typography component="span">花费 · 单次点击成本</Typography>
              </Box>
              <Box className="paid-promotion-product-metric-head">
                <Typography component="span">转化</Typography>
                <Typography component="span">订单 · 销售额 · 费比 · 投产比</Typography>
              </Box>
            </>
          ) : null}
        </Box>
        {pageRows.map((product, index) => {
          const title = product.title || product.campaignTitle || product.name || product.sku || '未返回商品';
          const key =
            product.aggregationKey || product.id || `${product.campaignId || 'campaign'}:${product.sku || index}`;
          const campaignAssignment = mode === 'products' ? formatPromotionCampaignAssignment(product) : '';
          return (
            <Box key={key} className="paid-promotion-product-row">
              <Box className="paid-promotion-product-main">
                <Typography variant="body2" fontWeight={700} noWrap title={title}>
                  {title}
                </Typography>
                <Typography variant="caption" color="text.secondary" noWrap>
                  商品编号：{product.sku || '未返回'} {product.offerId ? `· 货号：${product.offerId}` : ''}
                  {campaignAssignment ? ` · 计划：${campaignAssignment}` : ''}
                </Typography>
              </Box>
              {isProductMetrics ? (
                <>
                  <Chip
                    className="paid-promotion-product-status-chip"
                    size="small"
                    label={product.statusLabel || product.status || '已加入推广计划'}
                    variant="outlined"
                  />
                  <Box className="paid-promotion-product-bid-cell">
                    <CampaignMetricValue label="出价" tone="bid" value={formatMoney(product.bid, rubToCnyRate)} />
                  </Box>
                  <Box className="paid-promotion-product-metric-cell">
                    <Box className="paid-promotion-product-metric-line primary">
                      <CampaignMetricValue
                        label="展示"
                        tone="impressions"
                        value={formatPromotionMetric(product, 'impressions', formatPlainNumber)}
                      />
                      <span className="paid-promotion-product-metric-separator">/</span>
                      <CampaignMetricValue
                        label="点击"
                        tone="clicks"
                        value={formatPromotionMetric(product, 'clicks', formatPlainNumber)}
                      />
                    </Box>
                    <Box className="paid-promotion-product-metric-line secondary">
                      <span className="paid-promotion-product-metric-label">点击率</span>
                      <CampaignMetricValue
                        label="点击率"
                        tone="ctr"
                        value={formatPromotionMetric(product, 'ctr', formatPercent)}
                      />
                    </Box>
                  </Box>
                  <Box className="paid-promotion-product-metric-cell">
                    <Box className="paid-promotion-product-metric-line primary">
                      <CampaignMetricValue
                        label="花费"
                        tone="spent"
                        value={formatPromotionMetric(product, 'spent', formatMoney, rubToCnyRate)}
                      />
                    </Box>
                    <Box className="paid-promotion-product-metric-line secondary">
                      <span className="paid-promotion-product-metric-label">单次点击</span>
                      <CampaignMetricValue
                        label="单次点击成本"
                        tone="cpc"
                        value={formatPromotionMetric(product, 'cpc', formatMoney, rubToCnyRate)}
                      />
                    </Box>
                  </Box>
                  <Box className="paid-promotion-product-metric-cell conversion">
                    <Box className="paid-promotion-product-metric-line primary">
                      <CampaignMetricValue
                        label="订单"
                        tone="orders"
                        value={formatPromotionMetric(product, 'orders', formatPlainNumber)}
                      />
                      <span className="paid-promotion-product-metric-separator">·</span>
                      <CampaignMetricValue
                        label="销售额"
                        tone="revenue"
                        value={formatPromotionMetric(product, 'revenue', formatMoney, rubToCnyRate)}
                      />
                    </Box>
                    <Box className="paid-promotion-product-metric-line secondary conversion-ratios">
                      <span className="paid-promotion-product-metric-label">费比</span>
                      <CampaignMetricValue
                        label="广告费占比"
                        tone="acos"
                        value={formatPromotionMetric(product, 'acos', formatPercent)}
                      />
                      <span className="paid-promotion-product-metric-separator">·</span>
                      <span className="paid-promotion-product-metric-label">投产比</span>
                      <CampaignMetricValue
                        label="投产比"
                        tone="roas"
                        value={formatPromotionMetric(product, 'roas', formatMetric)}
                      />
                    </Box>
                  </Box>
                </>
              ) : isSearch ? (
                <>
                  <Chip
                    className="paid-promotion-product-status-chip"
                    size="small"
                    label={product.statusLabel || product.status || '未返回'}
                    variant="outlined"
                  />
                  <Box className="paid-promotion-product-bid-cell">
                    <CampaignMetricValue label="当前出价" tone="bid" value={formatMoney(product.bid, rubToCnyRate)} />
                  </Box>
                  <Box className="paid-promotion-bid-reference-cell">
                    <BidInsightValue
                      product={product}
                      metricKey="recommendedBid"
                      label="推荐"
                      rubToCnyRate={rubToCnyRate}
                    />
                    <BidInsightValue
                      product={product}
                      metricKey="competitiveBid"
                      label="竞争"
                      rubToCnyRate={rubToCnyRate}
                    />
                    <BidInsightValue product={product} metricKey="minCpoBid" label="最低" rubToCnyRate={rubToCnyRate} />
                    <BidInsightValue
                      product={product}
                      metricKey="minimumCpcBid"
                      label="最低点击"
                      rubToCnyRate={rubToCnyRate}
                    />
                  </Box>
                  <Box className="paid-promotion-product-metric-cell">
                    <Box className="paid-promotion-product-metric-line primary">
                      <CampaignMetricValue
                        label="展示"
                        tone="impressions"
                        value={formatPromotionMetric(product, 'impressions', formatPlainNumber)}
                      />
                      <span className="paid-promotion-product-metric-separator">/</span>
                      <CampaignMetricValue
                        label="点击"
                        tone="clicks"
                        value={formatPromotionMetric(product, 'clicks', formatPlainNumber)}
                      />
                    </Box>
                    <Box className="paid-promotion-product-metric-line secondary">
                      <span className="paid-promotion-product-metric-label">点击率</span>
                      <CampaignMetricValue
                        label="点击率"
                        tone="ctr"
                        value={formatPromotionMetric(product, 'ctr', formatPercent)}
                      />
                    </Box>
                  </Box>
                  <Box className="paid-promotion-product-metric-cell">
                    <Box className="paid-promotion-product-metric-line primary">
                      <CampaignMetricValue
                        label="花费"
                        tone="spent"
                        value={formatPromotionMetric(product, 'spent', formatMoney, rubToCnyRate)}
                      />
                    </Box>
                    <Box className="paid-promotion-product-metric-line secondary">
                      <span className="paid-promotion-product-metric-label">单次点击</span>
                      <CampaignMetricValue
                        label="单次点击成本"
                        tone="cpc"
                        value={formatPromotionMetric(product, 'cpc', formatMoney, rubToCnyRate)}
                      />
                    </Box>
                  </Box>
                  <Box className="paid-promotion-product-metric-cell conversion">
                    <Box className="paid-promotion-product-metric-line primary">
                      <CampaignMetricValue
                        label="订单"
                        tone="orders"
                        value={formatPromotionMetric(product, 'orders', formatPlainNumber)}
                      />
                      <span className="paid-promotion-product-metric-separator">·</span>
                      <CampaignMetricValue
                        label="销售额"
                        tone="revenue"
                        value={formatPromotionMetric(product, 'revenue', formatMoney, rubToCnyRate)}
                      />
                    </Box>
                    <Box className="paid-promotion-product-metric-line secondary conversion-ratios">
                      <span className="paid-promotion-product-metric-label">费比</span>
                      <CampaignMetricValue
                        label="广告费占比"
                        tone="acos"
                        value={formatPromotionMetric(product, 'acos', formatPercent)}
                      />
                      <span className="paid-promotion-product-metric-separator">·</span>
                      <span className="paid-promotion-product-metric-label">投产比</span>
                      <CampaignMetricValue
                        label="投产比"
                        tone="roas"
                        value={formatPromotionMetric(product, 'roas', formatMetric)}
                      />
                    </Box>
                  </Box>
                </>
              ) : null}
            </Box>
          );
        })}
      </Box>
      {pageCount > 1 ? (
        <Box className="paid-promotion-pagination-bar product-pagination">
          <Typography variant="caption" color="text.secondary">
            第 {page} / {pageCount} 页 · 共 {rows.length} 条{isStats ? '商品效果' : '推广商品'}
          </Typography>
          <Pagination
            count={pageCount}
            page={page}
            onChange={(_, nextPage) => setPage(nextPage)}
            size="small"
            shape="rounded"
          />
        </Box>
      ) : null}
    </Box>
  );
}

function TrendTable({ rows = [], rubToCnyRate = null, availability = null }) {
  if (!rows.length) {
    return (
      <Typography color="text.secondary" className="paid-promotion-inline-empty">
        {availability?.status === 'empty' ? '当前统计范围内接口明确没有日报记录。' : '当前统计范围内尚未返回日报趋势。'}
      </Typography>
    );
  }
  return (
    <Box className="paid-promotion-trend-list report">
      <Box className="paid-promotion-trend-row header">
        <Typography>日期</Typography>
        <Box className="paid-promotion-product-metric-head">
          <Typography component="span">流量</Typography>
          <Typography component="span">展示 · 点击 · 点击率</Typography>
        </Box>
        <Box className="paid-promotion-product-metric-head">
          <Typography component="span">成本</Typography>
          <Typography component="span">花费 · 单次点击成本</Typography>
        </Box>
        <Box className="paid-promotion-product-metric-head">
          <Typography component="span">转化</Typography>
          <Typography component="span">订单 · 销售额 · 费比 · 投产比</Typography>
        </Box>
      </Box>
      {rows.map((row) => {
        const noRecord = row.availabilityState === 'no-record';
        return (
          <Box
            key={`${row.date}-${row.campaignId || 'all'}`}
            className={`paid-promotion-trend-row${noRecord ? ' no-record' : ''}`}
          >
            <Box className="paid-promotion-trend-date">
              <Typography variant="body2">{row.date || '未返回'}</Typography>
              {noRecord ? <Typography variant="caption">当日无返回记录</Typography> : null}
            </Box>
            {noRecord ? (
              <Typography className="paid-promotion-no-record-span">—</Typography>
            ) : (
              <>
                <Box className="paid-promotion-product-metric-cell">
                  <Box className="paid-promotion-product-metric-line primary">
                    <CampaignMetricValue
                      label="展示"
                      tone="impressions"
                      value={formatPromotionMetric(row, 'impressions', formatPlainNumber)}
                    />
                    <span className="paid-promotion-product-metric-separator">/</span>
                    <CampaignMetricValue
                      label="点击"
                      tone="clicks"
                      value={formatPromotionMetric(row, 'clicks', formatPlainNumber)}
                    />
                  </Box>
                  <Box className="paid-promotion-product-metric-line secondary">
                    <span className="paid-promotion-product-metric-label">点击率</span>
                    <CampaignMetricValue
                      label="点击率"
                      tone="ctr"
                      value={formatPromotionMetric(row, 'ctr', formatPercent)}
                    />
                  </Box>
                </Box>
                <Box className="paid-promotion-product-metric-cell">
                  <Box className="paid-promotion-product-metric-line primary">
                    <CampaignMetricValue
                      label="花费"
                      tone="spent"
                      value={formatPromotionMetric(row, 'spent', formatMoney, rubToCnyRate)}
                    />
                  </Box>
                  <Box className="paid-promotion-product-metric-line secondary">
                    <span className="paid-promotion-product-metric-label">单次点击</span>
                    <CampaignMetricValue
                      label="单次点击成本"
                      tone="cpc"
                      value={formatPromotionMetric(row, 'cpc', formatMoney, rubToCnyRate)}
                    />
                  </Box>
                </Box>
                <Box className="paid-promotion-product-metric-cell conversion">
                  <Box className="paid-promotion-product-metric-line primary">
                    <CampaignMetricValue
                      label="订单"
                      tone="orders"
                      value={formatPromotionMetric(row, 'orders', formatPlainNumber)}
                    />
                    <span className="paid-promotion-product-metric-separator">·</span>
                    <CampaignMetricValue
                      label="销售额"
                      tone="revenue"
                      value={formatPromotionMetric(row, 'revenue', formatMoney, rubToCnyRate)}
                    />
                  </Box>
                  <Box className="paid-promotion-product-metric-line secondary conversion-ratios">
                    <span className="paid-promotion-product-metric-label">费比</span>
                    <CampaignMetricValue
                      label="广告费占比"
                      tone="acos"
                      value={formatPromotionMetric(row, 'acos', formatPercent)}
                    />
                    <span className="paid-promotion-product-metric-separator">·</span>
                    <span className="paid-promotion-product-metric-label">投产比</span>
                    <CampaignMetricValue
                      label="投产比"
                      tone="roas"
                      value={formatPromotionMetric(row, 'roas', formatMetric)}
                    />
                  </Box>
                </Box>
              </>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

function CampaignObjectTable({ rows = [], rubToCnyRate = null, availability = null, emptyMessage = '' }) {
  if (!rows.length) {
    return (
      <Typography color="text.secondary" className="paid-promotion-inline-empty">
        {emptyMessage ||
          (availability?.status === 'empty' ? '当前计划接口明确没有投放对象。' : '当前计划尚未返回投放对象。')}
      </Typography>
    );
  }
  return (
    <Box className="paid-promotion-object-table compact-table">
      <Box className="paid-promotion-object-row header">
        <Typography>投放对象</Typography>
        <Typography>状态</Typography>
        <Typography>出价</Typography>
        <Box className="paid-promotion-product-metric-head">
          <Typography component="span">流量</Typography>
          <Typography component="span">展示 · 点击 · 点击率</Typography>
        </Box>
        <Box className="paid-promotion-product-metric-head">
          <Typography component="span">成本</Typography>
          <Typography component="span">花费 · 单次点击成本</Typography>
        </Box>
        <Box className="paid-promotion-product-metric-head">
          <Typography component="span">转化</Typography>
          <Typography component="span">订单 · 销售额 · 费比</Typography>
        </Box>
        <Typography>审核信息</Typography>
      </Box>
      {rows.slice(0, 120).map((object, index) => (
        <Box
          key={object.id || `${object.campaignId}:${object.objectId || index}`}
          className="paid-promotion-object-row"
        >
          <Box>
            <Typography variant="body2" fontWeight={700} noWrap title={object.title || object.objectId}>
              {object.title || object.objectId || '未返回对象'}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              商品编号：{object.sku || '未返回'} {object.offerId ? `· 货号：${object.offerId}` : ''} ·{' '}
              {object.type || '商品'}
            </Typography>
          </Box>
          <Box className="paid-promotion-object-status-cell">
            <Chip
              className="paid-promotion-product-status-chip"
              size="small"
              label={object.statusLabel || object.status || '未返回'}
              variant="outlined"
            />
            {object.statusSource === 'campaign' ? <Typography variant="caption">计划状态</Typography> : null}
          </Box>
          <Box className="paid-promotion-product-bid-cell">
            <CampaignMetricValue label="出价" tone="bid" value={formatMoney(object.bid, rubToCnyRate)} />
          </Box>
          <Box className="paid-promotion-product-metric-cell">
            <Box className="paid-promotion-product-metric-line primary">
              <CampaignMetricValue
                label="展示"
                tone="impressions"
                value={formatPromotionMetric(object, 'impressions', formatPlainNumber)}
              />
              <span className="paid-promotion-product-metric-separator">/</span>
              <CampaignMetricValue
                label="点击"
                tone="clicks"
                value={formatPromotionMetric(object, 'clicks', formatPlainNumber)}
              />
            </Box>
            <Box className="paid-promotion-product-metric-line secondary">
              <span className="paid-promotion-product-metric-label">点击率</span>
              <CampaignMetricValue
                label="点击率"
                tone="ctr"
                value={formatPromotionMetric(object, 'ctr', formatPercent)}
              />
            </Box>
          </Box>
          <Box className="paid-promotion-product-metric-cell">
            <Box className="paid-promotion-product-metric-line primary">
              <CampaignMetricValue
                label="花费"
                tone="spent"
                value={formatPromotionMetric(object, 'spent', formatMoney, rubToCnyRate)}
              />
            </Box>
            <Box className="paid-promotion-product-metric-line secondary">
              <span className="paid-promotion-product-metric-label">单次点击</span>
              <CampaignMetricValue
                label="单次点击成本"
                tone="cpc"
                value={formatPromotionMetric(object, 'cpc', formatMoney, rubToCnyRate)}
              />
            </Box>
          </Box>
          <Box className="paid-promotion-product-metric-cell conversion">
            <Box className="paid-promotion-product-metric-line primary">
              <CampaignMetricValue
                label="订单"
                tone="orders"
                value={formatPromotionMetric(object, 'orders', formatPlainNumber)}
              />
              <span className="paid-promotion-product-metric-separator">·</span>
              <CampaignMetricValue
                label="销售额"
                tone="revenue"
                value={formatPromotionMetric(object, 'revenue', formatMoney, rubToCnyRate)}
              />
            </Box>
            <Box className="paid-promotion-product-metric-line secondary">
              <span className="paid-promotion-product-metric-label">费比</span>
              <CampaignMetricValue
                label="广告费占比"
                tone="acos"
                value={formatPromotionMetric(object, 'acos', formatPercent)}
              />
            </Box>
          </Box>
          <Typography
            className="paid-promotion-review-reason"
            variant="body2"
            noWrap
            title={object.reviewReason || 'Ozon 未返回审核原因'}
          >
            {object.reviewReason || '未返回审核原因'}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

const advancedReportFieldLabels = {
  date: '日期',
  day: '日期',
  campaignId: '计划 ID',
  campaignName: '计划',
  title: '名称',
  sku: 'SKU',
  offerId: '货号',
  phrase: '搜索词',
  query: '搜索词',
  impressions: '展示',
  views: '展示',
  clicks: '点击',
  ctr: '点击率',
  cpc: '单次点击成本',
  spent: '花费',
  expense: '花费',
  orders: '订单',
  revenue: '销售额',
  source: '来源',
  type: '类型',
  bid: '出价',
};

function formatAdvancedReportValue(value) {
  if (value === null || value === undefined || value === '') return '未返回';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'object') {
    const text = JSON.stringify(value);
    return text.length > 120 ? `${text.slice(0, 117)}...` : text;
  }
  return String(value);
}

function AdvancedPerformanceReportTable({ rows = [], loading = false, error = '', emptyMessage = '' }) {
  if (loading && !rows.length) {
    return (
      <Stack direction="row" spacing={1} alignItems="center" className="paid-promotion-inline-empty">
        <CircularProgress size={18} />
        <Typography color="text.secondary">正在生成并读取 Ozon 官方报表。</Typography>
      </Stack>
    );
  }
  if (error && !rows.length) {
    return <Typography className="paid-promotion-dialog-error">{error}</Typography>;
  }
  if (!rows.length) {
    return (
      <Typography className="paid-promotion-inline-empty">
        {emptyMessage || '当前范围 Ozon 明确没有返回记录。'}
      </Typography>
    );
  }
  const preferredFields = Object.keys(advancedReportFieldLabels);
  const availableFields = [...new Set(rows.flatMap((row) => Object.keys(row || {})))];
  const columns = [
    ...preferredFields.filter((field) => availableFields.includes(field)),
    ...availableFields.filter((field) => !preferredFields.includes(field)),
  ].slice(0, 8);
  const gridTemplateColumns = `repeat(${Math.max(1, columns.length)}, minmax(90px, 1fr))`;
  return (
    <Box className="paid-promotion-order-table-shell">
      <Box className="paid-promotion-order-table">
        <Box className="paid-promotion-order-row header" sx={{ gridTemplateColumns }}>
          {columns.map((field) => (
            <Typography key={field}>{advancedReportFieldLabels[field] || field}</Typography>
          ))}
        </Box>
        {rows.map((row, index) => (
          <Box
            key={normalizeText(row?.id || row?.sku || row?.campaignId || `${index}`)}
            className="paid-promotion-order-row"
            sx={{ gridTemplateColumns }}
          >
            {columns.map((field) => (
              <Typography key={field} variant="body2" title={formatAdvancedReportValue(row?.[field])}>
                {formatAdvancedReportValue(row?.[field])}
              </Typography>
            ))}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function ExpenseTable({ rows = [], rubToCnyRate = null, availability = null }) {
  if (!rows.length) {
    return (
      <Typography color="text.secondary" className="paid-promotion-inline-empty">
        {availability?.status === 'empty' ? '当前统计范围接口明确没有花费明细。' : '当前统计范围尚未返回花费明细。'}
      </Typography>
    );
  }
  return (
    <Box className="paid-promotion-expense-table compact-table expense-only">
      <Box className="paid-promotion-expense-row header expense-only">
        <Typography>日期 / 计划</Typography>
        <Typography>总花费</Typography>
        <Box className="paid-promotion-product-metric-head">
          <Typography component="span">资金构成</Typography>
          <Typography component="span">奖金花费 · 预付款花费</Typography>
        </Box>
      </Box>
      {rows.map((row, index) => (
        <Box
          key={row.id || `${row.campaignId || 'all'}:${row.date || index}`}
          className="paid-promotion-expense-row expense-only"
        >
          <Box>
            <Typography variant="body2" fontWeight={700} noWrap title={row.campaignTitle || row.campaignId}>
              {row.date || '未返回日期'}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {row.campaignTitle || row.campaignId || '全部计划'}
            </Typography>
          </Box>
          <CampaignMetricValue label="总花费" tone="spent" value={formatMoney(row.spent, rubToCnyRate)} />
          <Box className="paid-promotion-expense-split-cell">
            <Box>
              <span>奖金</span>
              <CampaignMetricValue label="奖金花费" tone="bonus" value={formatMoney(row.bonusSpent, rubToCnyRate)} />
            </Box>
            <Box>
              <span>预付款</span>
              <CampaignMetricValue
                label="预付款花费"
                tone="prepayment"
                value={formatMoney(row.prepaymentSpent, rubToCnyRate)}
              />
            </Box>
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function PromotionOrderTable({
  rows = [],
  loading = false,
  error = '',
  rubToCnyRate = null,
  availability = null,
  verificationMessage = '',
}) {
  const [page, setPage] = React.useState(1);
  const pageSize = 20;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  React.useEffect(() => {
    setPage(1);
  }, [rows]);
  React.useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);

  if (loading && !rows.length) {
    return (
      <Stack direction="row" spacing={1} alignItems="center" className="paid-promotion-inline-empty">
        <CircularProgress size={18} />
        <Typography color="text.secondary">正在生成并读取 Ozon 推广订单报表。</Typography>
      </Stack>
    );
  }
  if (error && !rows.length) {
    return (
      <Typography color="error" className="paid-promotion-inline-empty">
        {error}
      </Typography>
    );
  }
  if (!rows.length) {
    return (
      <Typography
        color={availability?.status === 'mismatch' || availability?.status === 'unverified' ? 'warning.main' : 'text.secondary'}
        className="paid-promotion-inline-empty"
      >
        {verificationMessage ||
          (availability?.status === 'empty'
            ? 'Ozon 统计汇总和订单明细均确认当前日期范围内没有推广订单。'
            : '当前日期范围尚未返回可查验的推广订单明细。')}
      </Typography>
    );
  }

  const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);
  return (
    <Box className="paid-promotion-order-table-shell">
      {verificationMessage ? (
        <Typography color="warning.main" variant="caption">
          {verificationMessage}
        </Typography>
      ) : null}
      {error ? (
        <Typography color="warning.main" variant="caption">
          {error} 已保留上次读取结果。
        </Typography>
      ) : null}
      <Box className="paid-promotion-order-table compact-table">
        <Box className="paid-promotion-order-row header">
          <Typography>订单 / 时间</Typography>
          <Typography>商品</Typography>
          <Typography>推广计划</Typography>
          <Typography>数量</Typography>
          <Typography>销售额</Typography>
          <Typography>推广花费</Typography>
        </Box>
        {pageRows.map((row, index) => (
          <Box key={row.id || `${row.orderId || 'order'}:${row.sku || index}`} className="paid-promotion-order-row">
            <Box>
              <Typography variant="body2" fontWeight={700} noWrap title={row.orderId || ''}>
                {row.orderId || '接口未提供订单号'}
              </Typography>
              <Typography variant="caption" color="text.secondary" noWrap title={row.orderDate || ''}>
                {row.orderDate || '未返回下单时间'}
                {row.orderNumber ? ` · ${row.orderNumber}` : ''}
              </Typography>
            </Box>
            <Box>
              <Typography variant="body2" fontWeight={700} noWrap title={row.productTitle || ''}>
                {row.productTitle || row.sku || row.offerId || '未返回商品'}
              </Typography>
              <Typography variant="caption" color="text.secondary" noWrap>
                SKU：{row.sku || '未返回'}
                {row.offerId ? ` · 货号：${row.offerId}` : ''}
              </Typography>
            </Box>
            <Box>
              <Typography variant="body2" noWrap title={row.campaignTitle || row.campaignId || ''}>
                {row.campaignTitle || row.campaignId || row.source || '按订单付费推广'}
              </Typography>
              {row.campaignTitle && row.campaignId ? (
                <Typography variant="caption" color="text.secondary" noWrap>
                  {row.campaignId}
                </Typography>
              ) : null}
            </Box>
            <Typography variant="body2">{formatPlainNumber(row.quantity)}</Typography>
            <Typography variant="body2">{formatMoney(row.revenue, rubToCnyRate)}</Typography>
            <Typography variant="body2">{formatMoney(row.spent, rubToCnyRate)}</Typography>
          </Box>
        ))}
      </Box>
      <Box className="paid-promotion-pagination-bar product-pagination">
        <Typography variant="caption" color="text.secondary">
          第 {page} / {pageCount} 页 · 共 {rows.length} 条推广订单记录
        </Typography>
        <Pagination
          count={pageCount}
          page={page}
          onChange={(_, nextPage) => setPage(nextPage)}
          size="small"
          shape="rounded"
        />
      </Box>
    </Box>
  );
}

function MediaStatsTable({ rows = [], rubToCnyRate = null, availability = null }) {
  if (!rows.length) {
    return (
      <Typography color="text.secondary" className="paid-promotion-inline-empty">
        {availability?.status === 'empty'
          ? '当前统计范围接口明确没有媒体广告记录。'
          : '当前统计范围尚未返回媒体广告统计。'}
      </Typography>
    );
  }
  return (
    <Box className="paid-promotion-expense-table compact-table">
      <Box className="paid-promotion-expense-row header">
        <Typography>媒体 / 计划</Typography>
        <Box className="paid-promotion-product-metric-head">
          <Typography component="span">流量</Typography>
          <Typography component="span">展示 · 点击 · 点击率</Typography>
        </Box>
        <Box className="paid-promotion-product-metric-head">
          <Typography component="span">成本</Typography>
          <Typography component="span">花费 · 单次点击成本</Typography>
        </Box>
        <Box className="paid-promotion-product-metric-head">
          <Typography component="span">转化</Typography>
          <Typography component="span">订单 · 销售额 · 费比 · 投产比</Typography>
        </Box>
      </Box>
      {rows.map((row, index) => (
        <Box key={row.id || `${row.campaignId || 'media'}:${row.date || index}`} className="paid-promotion-expense-row">
          <Box>
            <Typography variant="body2" fontWeight={700} noWrap title={row.campaignTitle || row.mediaType}>
              {row.mediaType || '媒体广告'}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {row.campaignTitle || row.campaignId || row.date || '未返回计划'}
            </Typography>
          </Box>
          <Box className="paid-promotion-product-metric-cell">
            <Box className="paid-promotion-product-metric-line primary">
              <CampaignMetricValue
                label="展示"
                tone="impressions"
                value={formatPromotionMetric(row, 'impressions', formatPlainNumber)}
              />
              <span className="paid-promotion-product-metric-separator">/</span>
              <CampaignMetricValue
                label="点击"
                tone="clicks"
                value={formatPromotionMetric(row, 'clicks', formatPlainNumber)}
              />
            </Box>
            <Box className="paid-promotion-product-metric-line secondary">
              <span className="paid-promotion-product-metric-label">点击率</span>
              <CampaignMetricValue label="点击率" tone="ctr" value={formatPromotionMetric(row, 'ctr', formatPercent)} />
            </Box>
          </Box>
          <Box className="paid-promotion-product-metric-cell">
            <Box className="paid-promotion-product-metric-line primary">
              <CampaignMetricValue
                label="花费"
                tone="spent"
                value={formatPromotionMetric(row, 'spent', formatMoney, rubToCnyRate)}
              />
            </Box>
            <Box className="paid-promotion-product-metric-line secondary">
              <span className="paid-promotion-product-metric-label">单次点击</span>
              <CampaignMetricValue
                label="单次点击成本"
                tone="cpc"
                value={formatPromotionMetric(row, 'cpc', formatMoney, rubToCnyRate)}
              />
            </Box>
          </Box>
          <Box className="paid-promotion-product-metric-cell conversion">
            <Box className="paid-promotion-product-metric-line primary">
              <CampaignMetricValue
                label="订单"
                tone="orders"
                value={formatPromotionMetric(row, 'orders', formatPlainNumber)}
              />
              <span className="paid-promotion-product-metric-separator">·</span>
              <CampaignMetricValue
                label="销售额"
                tone="revenue"
                value={formatPromotionMetric(row, 'revenue', formatMoney, rubToCnyRate)}
              />
            </Box>
            <Box className="paid-promotion-product-metric-line secondary conversion-ratios">
              <span className="paid-promotion-product-metric-label">费比</span>
              <CampaignMetricValue
                label="广告费占比"
                tone="acos"
                value={formatPromotionMetric(row, 'acos', formatPercent)}
              />
              <span className="paid-promotion-product-metric-separator">·</span>
              <span className="paid-promotion-product-metric-label">投产比</span>
              <CampaignMetricValue
                label="投产比"
                tone="roas"
                value={formatPromotionMetric(row, 'roas', formatMetric)}
              />
            </Box>
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function DetailItem({ label, value }) {
  return (
    <Box className="paid-promotion-detail-item">
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="subtitle1" title={String(value ?? '')} noWrap>
        {value ?? '未返回'}
      </Typography>
    </Box>
  );
}

export {
  CampaignListTable,
  PromotionMetricSummary,
  CampaignProductTable,
  TrendTable,
  CampaignObjectTable,
  AdvancedPerformanceReportTable,
  ExpenseTable,
  PromotionOrderTable,
  MediaStatsTable,
  DetailItem,
};
