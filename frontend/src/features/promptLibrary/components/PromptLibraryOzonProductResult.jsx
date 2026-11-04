import ArrowUpwardRounded from '@mui/icons-material/ArrowUpwardRounded';
import Inventory2Outlined from '@mui/icons-material/Inventory2Outlined';
import LocalOfferOutlined from '@mui/icons-material/LocalOfferOutlined';
import SellOutlined from '@mui/icons-material/SellOutlined';
import StorefrontOutlined from '@mui/icons-material/StorefrontOutlined';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Chip from '@mui/material/Chip';
import Pagination from '@mui/material/Pagination';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TableSortLabel from '@mui/material/TableSortLabel';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import { parseOzonProductMetric } from '../lib/smartToolOzonProductAnalysis.js';

const PAGE_SIZE = 20;

const RUB_FORMATTER = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const NUMBER_FORMATTER = new Intl.NumberFormat('zh-CN', {
  maximumFractionDigits: 2,
});

const SUPPORTED_PRICE_CURRENCIES = new Set(['RUB', 'CNY', 'USD', 'KZT', 'AMD', 'BYN', 'EUR']);
const PRICE_FORMATTERS = new Map([['RUB', RUB_FORMATTER]]);

function metric(value) {
  return parseOzonProductMetric(value);
}

function formatRuble(value) {
  const parsed = metric(value);
  return parsed === null ? '—' : RUB_FORMATTER.format(parsed);
}

function formatPriceCurrency(value, currency = 'RUB') {
  const parsed = metric(value);
  if (parsed === null) return '—';
  const normalized = SUPPORTED_PRICE_CURRENCIES.has(String(currency || '').toUpperCase())
    ? String(currency).toUpperCase()
    : 'RUB';
  if (!PRICE_FORMATTERS.has(normalized)) {
    PRICE_FORMATTERS.set(normalized, new Intl.NumberFormat(normalized === 'CNY' ? 'zh-CN' : 'ru-RU', {
      style: 'currency',
      currency: normalized,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }));
  }
  return PRICE_FORMATTERS.get(normalized).format(parsed);
}

function formatCompactRuble(value) {
  const parsed = metric(value);
  if (parsed === null) return '—';
  if (Math.abs(parsed) >= 100_000_000) return `${NUMBER_FORMATTER.format(parsed / 100_000_000)} 亿 ₽`;
  if (Math.abs(parsed) >= 10_000) return `${NUMBER_FORMATTER.format(parsed / 10_000)} 万 ₽`;
  return RUB_FORMATTER.format(parsed);
}

function formatNumber(value, suffix = '') {
  const parsed = metric(value);
  return parsed === null ? '—' : `${NUMBER_FORMATTER.format(parsed)}${suffix}`;
}

function formatPercent(value) {
  const parsed = metric(value);
  return parsed === null ? '—' : `${NUMBER_FORMATTER.format(parsed)}%`;
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
}

function formatTargetMoney(value, currency = 'CNY') {
  const parsed = metric(value);
  if (parsed === null) return '—';
  return currency === 'RUB'
    ? `${NUMBER_FORMATTER.format(parsed)} ₽`
    : `¥${NUMBER_FORMATTER.format(parsed)}`;
}

function hasTextValue(value) {
  const normalized = String(value ?? '').trim();
  return Boolean(normalized)
    && !['-', '—', '未返回', '暂无', 'null', 'undefined'].includes(normalized.toLowerCase());
}

function formatText(value) {
  return hasTextValue(value) ? String(value).trim() : '—';
}

function ProductMetricList({ items = [], tone = 'default', taxonomy = false }) {
  const visibleItems = items.filter((item) => item?.visible !== false && item?.value);
  if (!visibleItems.length) return null;
  return (
    <Box
      component="dl"
      className={`prompt-library-ozon-core-metrics is-${tone}${taxonomy ? ' is-taxonomy' : ''}`}
    >
      {visibleItems.map((item) => (
        <Box component="div" className="prompt-library-ozon-core-metric" key={item.label}>
          <Typography component="dt" variant="caption">{item.label}</Typography>
          <Typography component="dd" variant="body2" title={item.value}>{item.value}</Typography>
        </Box>
      ))}
    </Box>
  );
}

function ProductExpandedSection({ title, items = [] }) {
  const visibleItems = items.filter((item) => item?.visible !== false && item?.value);
  if (!visibleItems.length) return null;
  return (
    <Box component="section" className="prompt-library-ozon-expanded-section">
      <Box className="prompt-library-ozon-expanded-section-head">
        <Typography variant="subtitle2">{title}</Typography>
      </Box>
      <Box component="dl" className="prompt-library-ozon-expanded-values">
        {visibleItems.map((item) => (
          <Box component="div" className="prompt-library-ozon-expanded-value" key={item.label}>
            <Typography component="dt" variant="caption">{item.label}</Typography>
            <Typography component="dd" variant="body2" title={item.value}>{item.value}</Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function ProductExpandedData({ record, coverage }) {
  return (
    <Box className="prompt-library-ozon-expanded-grid">
      <ProductExpandedSection
        title="广告与促销"
        items={[
          { label: '广告占比', value: formatPercent(record.adSpendShare), visible: coverage.adSpendShare && metric(record.adSpendShare) !== null },
          { label: '促销天数', value: formatNumber(record.promoDays, ' 天'), visible: coverage.promoDays && metric(record.promoDays) !== null },
          { label: '促销折扣', value: formatPercent(record.promoDiscount), visible: coverage.promoDiscount && metric(record.promoDiscount) !== null },
          { label: '促销销售占比', value: formatPercent(record.promoRevenueShare), visible: coverage.promoRevenueShare && metric(record.promoRevenueShare) !== null },
          { label: '付费推广天数', value: formatNumber(record.paidPromotionDays, ' 天'), visible: coverage.paidPromotionDays && metric(record.paidPromotionDays) !== null },
        ]}
      />
      <ProductExpandedSection
        title="浏览与下单"
        items={[
          { label: '商品卡浏览量', value: formatNumber(record.productCardViews), visible: coverage.productCardViews && metric(record.productCardViews) !== null },
          { label: '商品页加购率', value: formatPercent(record.productCardToCartRate), visible: coverage.productCardToCartRate && metric(record.productCardToCartRate) !== null },
          { label: '搜索页浏览量', value: formatNumber(record.searchCatalogViews), visible: coverage.searchCatalogViews && metric(record.searchCatalogViews) !== null },
          { label: '搜索页加购率', value: formatPercent(record.searchCatalogToCartRate), visible: coverage.searchCatalogToCartRate && metric(record.searchCatalogToCartRate) !== null },
          { label: '浏览后下单率', value: formatPercent(record.impressionToOrderRate), visible: coverage.impressionToOrderRate && metric(record.impressionToOrderRate) !== null },
          { label: '点击率', value: formatPercent(record.clickThroughRate), visible: coverage.clickThroughRate && metric(record.clickThroughRate) !== null },
        ]}
      />
      <ProductExpandedSection
        title="退货与包裹"
        items={[
          { label: '发货模式', value: formatText(record.fulfillmentModel), visible: coverage.fulfillmentModel && hasTextValue(record.fulfillmentModel) },
          { label: '订单完成率', value: formatPercent(record.redemptionRate), visible: coverage.redemptionRate && metric(record.redemptionRate) !== null },
          { label: '退货取消率', value: formatPercent(record.returnCancelRate), visible: coverage.returnCancelRate && metric(record.returnCancelRate) !== null },
          { label: '包裹尺寸', value: formatText(record.packageDimensions), visible: coverage.packageDimensions && hasTextValue(record.packageDimensions) },
          { label: '包裹重量', value: formatText(record.packageWeight), visible: coverage.packageWeight && hasTextValue(record.packageWeight) },
        ]}
      />
      <ProductExpandedSection
        title="上架与跟卖"
        items={[
          { label: '上架日期', value: formatDate(record.listedAt), visible: coverage.listedAt && Boolean(record.listedAt) },
          { label: '上架天数', value: formatNumber(record.listingDays, ' 天'), visible: coverage.listingDays && metric(record.listingDays) !== null },
          { label: '跟卖数量', value: formatNumber(record.followSellerCount, ' 个'), visible: coverage.followSellerCount && metric(record.followSellerCount) !== null },
          { label: '跟卖最低价', value: formatRuble(record.followMinPrice), visible: coverage.followMinPrice && metric(record.followMinPrice) !== null },
          { label: '跟卖最高价', value: formatRuble(record.followMaxPrice), visible: coverage.followMaxPrice && metric(record.followMaxPrice) !== null },
          { label: 'rFBS 佣金', value: formatText(record.rfbsRate), visible: coverage.rfbsRate && hasTextValue(record.rfbsRate) },
          { label: 'FBP 佣金', value: formatText(record.fbpRate), visible: coverage.fbpRate && hasTextValue(record.fbpRate) },
        ]}
      />
    </Box>
  );
}

function categoryPath(record = {}) {
  return [...new Set([
    record.category1,
    record.category2,
    record.category3,
    record.category,
  ].map((value) => String(value ?? '').trim()).filter(Boolean))].join(' / ');
}

function formatCaptureTime(value) {
  if (!value) return '暂无更新时间';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function SummaryCard({ icon, label, value, hint, tone = 'blue' }) {
  return (
    <Box className={`prompt-library-ozon-summary-card is-${tone}`}>
      <Box className="prompt-library-ozon-summary-icon">{icon}</Box>
      <Box minWidth={0}>
        <Typography variant="caption">{label}</Typography>
        <Typography variant="h6" title={value}>{value}</Typography>
        <Typography
          variant="caption"
          className="prompt-library-ozon-summary-hint"
          title={hint}
        >
          {hint}
        </Typography>
      </Box>
    </Box>
  );
}

function DecisionSignalList({ title, items = [], tone = 'positive', emptyText }) {
  const visibleItems = items.slice(0, 3);
  return (
    <Box className={`prompt-library-ozon-decision-signals is-${tone}`}>
      <Typography variant="caption">{title}</Typography>
      {visibleItems.length ? (
        <Stack spacing={0.7}>
          {visibleItems.map((item) => (
            <Box className="prompt-library-ozon-decision-signal" key={item.key}>
              <Box className="prompt-library-ozon-decision-signal-dot" />
              <Box minWidth={0}>
                <Typography variant="subtitle2">{item.title}</Typography>
                <Typography variant="body2">{item.detail}</Typography>
              </Box>
            </Box>
          ))}
        </Stack>
      ) : (
        <Typography variant="body2" className="prompt-library-ozon-decision-empty">
          {emptyText}
        </Typography>
      )}
    </Box>
  );
}

function OzonProductDecisionPanel({ decision = {} }) {
  const opportunity = decision?.opportunity;
  if (!opportunity) return null;
  const score = Number.isFinite(opportunity.score) ? opportunity.score : null;
  return (
    <Box component="section" className="prompt-library-ozon-decision-panel">
      <Box className="prompt-library-ozon-decision-head">
        <Box>
          <Typography variant="subtitle1">选品决策</Typography>
          <Typography variant="caption">综合查看销量变化、市场竞争、下单、库存、退货和跟卖情况</Typography>
        </Box>
        <Stack direction="row" spacing={0.7} alignItems="center">
          <Chip size="small" label={opportunity.label} className={`is-score-${score === null ? 'unknown' : score >= 60 ? 'positive' : score >= 45 ? 'watch' : 'risk'}`} />
          <Chip size="small" variant="outlined" label={`${opportunity.confidenceLabel} · 数据 ${opportunity.evidenceCoveragePercent}%`} />
        </Stack>
      </Box>

      <Box className="prompt-library-ozon-decision-main">
        <Box className="prompt-library-ozon-decision-score">
          <Typography variant="caption">选品参考分</Typography>
          <Box className="prompt-library-ozon-decision-score-value">
            <Typography variant="h3">{score ?? '—'}</Typography>
            <Typography variant="caption">/ 100</Typography>
          </Box>
          <Typography variant="body2">{opportunity.recommendation}</Typography>
          <Typography variant="caption">
            已有 {opportunity.availableDimensionCount}/{opportunity.totalDimensionCount} 项数据可判断
          </Typography>
        </Box>
        <DecisionSignalList
          title="值得关注"
          items={opportunity.reasons}
          emptyText="暂时没有看出明显优势。"
        />
        <DecisionSignalList
          title="需要注意"
          tone="risk"
          items={opportunity.risks}
          emptyText="暂时没有发现明显风险。"
        />
      </Box>

      <Box className="prompt-library-ozon-decision-dimensions">
        {(opportunity.breakdown || []).map((item) => (
          <Box className={`prompt-library-ozon-decision-dimension is-${item.tone || 'neutral'}`} key={item.key}>
            <Box className="prompt-library-ozon-decision-dimension-head">
              <Typography variant="caption">{item.label}</Typography>
              <Typography variant="caption">{Number.isFinite(item.score) ? item.score : '—'}</Typography>
            </Box>
            <Box className="prompt-library-ozon-decision-dimension-track">
              <Box sx={{ width: `${Number.isFinite(item.score) ? item.score : 0}%` }} />
            </Box>
            <Typography variant="body2" title={item.detail}>{item.detail}</Typography>
          </Box>
        ))}
      </Box>

      {opportunity.actions?.length ? (
        <Box className="prompt-library-ozon-decision-actions">
          <Typography variant="caption">接下来怎么做</Typography>
          <Box>
            {opportunity.actions.map((action, index) => (
              <Typography variant="body2" key={`${index}-${action}`}>
                <strong>{index + 1}</strong>{action}
              </Typography>
            ))}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

function sortRecords(records, sortKey, direction) {
  const factor = direction === 'asc' ? 1 : -1;
  return records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => {
      const leftValue = metric(left.record?.[sortKey]);
      const rightValue = metric(right.record?.[sortKey]);
      if (leftValue === null && rightValue === null) return left.index - right.index;
      if (leftValue === null) return 1;
      if (rightValue === null) return -1;
      return (leftValue - rightValue) * factor || left.index - right.index;
    })
    .map(({ record }) => record);
}

function SortableHeading({ field, label, sortKey, direction, onSort, align = 'left' }) {
  return (
    <TableCell align={align} sortDirection={sortKey === field ? direction : false}>
      <TableSortLabel
        active={sortKey === field}
        direction={sortKey === field ? direction : 'desc'}
        onClick={() => onSort(field)}
      >
        {label}
      </TableSortLabel>
    </TableCell>
  );
}

function TargetProductCard({ product, title = '目标商品' }) {
  if (!product) return null;
  const rows = [
    { label: product.priceKind || '链接价格', value: formatTargetMoney(product.capturedPrice, product.currency) },
    { label: '建议销售价', value: formatTargetMoney(product.suggestedSalePriceRub, 'RUB') },
    { label: '长宽高', value: product.dimensions || '待补充' },
    { label: '重量', value: product.weightKg ? `${NUMBER_FORMATTER.format(product.weightKg)} kg` : product.packageWeight || '待补充' },
    { label: '预估佣金', value: product.estimatedCommissionRub == null
      ? '暂无类目费率'
      : `${formatTargetMoney(product.estimatedCommissionRub, 'RUB')} · ${formatPercent(product.commissionPercent)}` },
    { label: '预估平台费用', value: product.estimatedPlatformFeesRub == null
      ? '还缺费率数据'
      : formatTargetMoney(product.estimatedPlatformFeesRub, 'RUB') },
  ];
  return (
    <Box className="prompt-library-ozon-target-product">
      {product.imageUrl ? (
        <Box component="img" src={product.imageUrl} alt="" className="prompt-library-ozon-target-image" />
      ) : (
        <Box className="prompt-library-ozon-target-image is-empty">商品</Box>
      )}
      <Box className="prompt-library-ozon-target-copy">
        <Stack direction="row" spacing={0.75} alignItems="center">
          <Typography variant="subtitle1">{title}</Typography>
          <Chip size="small" variant="outlined" label={product.platform || '已解析'} />
        </Stack>
        <Typography variant="body2" title={product.productTitle || ''}>
          {product.productTitle || '链接商品资料'}
        </Typography>
        <Typography variant="caption">
          {product.sourceProductId ? `商品 ID ${product.sourceProductId} · ` : ''}{product.logisticsEstimateStatus}
        </Typography>
      </Box>
      <Box component="dl" className="prompt-library-ozon-target-metrics">
        {rows.map((row) => (
          <Box component="div" key={row.label}>
            <Typography component="dt" variant="caption">{row.label}</Typography>
            <Typography component="dd" variant="body2">{row.value}</Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function ProductSelectionSupport({ result }) {
  if (result?.viewType !== 'product-selection') return null;
  const seerfar = result?.seerfarReview;
  return (
    <Stack spacing={1.25}>
      {result?.sourceProductLinkStatus?.status === 'error' ? (
        <Alert severity="warning">{result.sourceProductLinkStatus.message}</Alert>
      ) : null}
      <TargetProductCard product={result?.sourceProduct} title="1688 候选货源" />
      {seerfar ? (
        <Alert severity={seerfar.status === 'ready' ? 'success' : seerfar.status === 'skipped' ? 'info' : 'warning'}>
          <Typography variant="subtitle2">Seerfar 市场复核：{seerfar.statusLabel}</Typography>
          <Typography variant="body2">{seerfar.summary}</Typography>
        </Alert>
      ) : null}
    </Stack>
  );
}

export function PromptLibraryOzonProductResult({ result, onOpenProduct = null }) {
  const analysis = result?.productAnalysis;
  const records = React.useMemo(
    () => (Array.isArray(analysis?.records) ? analysis.records : []),
    [analysis]
  );
  const fieldCoverage = React.useMemo(
    () => (analysis?.fieldCoverage || []).filter((item) => Number(item?.count) > 0),
    [analysis]
  );
  const coverage = React.useMemo(
    () => Object.fromEntries(fieldCoverage.map((item) => [item.key, Number(item.count) > 0])),
    [fieldCoverage]
  );
  const hasRevenue = Number(analysis?.revenueStats?.count) > 0;
  const hasPriceGroup = coverage.price || coverage.cardPrice;
  const hasSalesGroup = coverage.sales || coverage.orders || coverage.averageDailyUnits;
  const hasRevenueGroup = coverage.revenue || coverage.growth || coverage.averageDailyRevenue;
  const hasReputationGroup = coverage.stock || coverage.rating || coverage.reviews;
  const hasMarketMetricsGroup = [
    'adSpendShare',
    'promoDays',
    'promoDiscount',
    'promoRevenueShare',
    'paidPromotionDays',
    'productCardViews',
    'productCardToCartRate',
    'searchCatalogViews',
    'searchCatalogToCartRate',
    'impressionToOrderRate',
    'clickThroughRate',
  ].some((key) => coverage[key]);
  const hasFulfillmentGroup = [
    'fulfillmentModel',
    'redemptionRate',
    'returnCancelRate',
    'packageDimensions',
    'packageWeight',
    'listedAt',
    'listingDays',
    'followSellerCount',
    'followMinPrice',
    'followMaxPrice',
    'rfbsRate',
    'fbpRate',
  ].some((key) => coverage[key]);
  const hasExpandedProductData = hasMarketMetricsGroup || hasFulfillmentGroup;
  const primaryColumnCount = 2 + [
    hasPriceGroup,
    hasSalesGroup,
    hasRevenueGroup,
    hasReputationGroup,
  ].filter(Boolean).length;
  const initialSortKey = hasRevenue
    ? 'revenue'
    : coverage.sales
      ? 'sales'
      : coverage.price
        ? 'price'
        : coverage.growth
          ? 'growth'
          : 'id';
  const [page, setPage] = React.useState(1);
  const [sortKey, setSortKey] = React.useState(initialSortKey);
  const [direction, setDirection] = React.useState('desc');

  React.useEffect(() => {
    setPage(1);
    setSortKey(initialSortKey);
    setDirection('desc');
  }, [analysis, initialSortKey]);

  const sortedRecords = React.useMemo(
    () => sortRecords(records, sortKey, direction),
    [direction, records, sortKey]
  );
  const pageCount = Math.max(1, Math.ceil(sortedRecords.length / PAGE_SIZE));
  const pageRows = sortedRecords.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const topPriceBand = [...(analysis?.priceBands || [])].sort((left, right) => right.count - left.count)[0];

  const handleSort = (field) => {
    if (field === sortKey) {
      setDirection((current) => (current === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortKey(field);
      setDirection('desc');
    }
    setPage(1);
  };

  const hasMarketRecords = Boolean(analysis && records.length);
  const hasProductLinkResult = Boolean(
    result?.targetProduct
      || result?.productLinkStatus
      || result?.sourceProduct
      || result?.sourceProductLinkStatus
  );

  if (!hasMarketRecords) {
    if (!hasProductLinkResult) return null;
    return (
      <Box className="prompt-library-ozon-result is-target-only">
        <Box className="prompt-library-ozon-result-head">
          <Box minWidth={0}>
            <Typography variant="h6">商品链接分析</Typography>
            <Typography variant="body2" color="text.secondary">
              商品资料与市场对比结果。
            </Typography>
          </Box>
        </Box>
        {result?.productLinkStatus?.status === 'error' ? (
          <Alert severity="warning">{result.productLinkStatus.message}</Alert>
        ) : null}
        <TargetProductCard product={result?.targetProduct} />
        <ProductSelectionSupport result={result} />
        <Alert severity={result?.targetProduct ? 'info' : 'warning'}>
          {result?.targetProduct
            ? `已经找到商品资料，但暂时没有找到可对比的 Ozon 市场商品。${result?.marketSearchWarning || ''}`
            : result?.summary || '暂时没有找到商品资料。'}
        </Alert>
      </Box>
    );
  }

  return (
    <Box className="prompt-library-ozon-result">
      <Box className="prompt-library-ozon-result-head">
        <Box minWidth={0}>
          <Typography variant="h6">商品市场分析</Typography>
          <Typography variant="body2" color="text.secondary">
            {analysis.query ? `查询：${analysis.query} · ` : ''}更新时间：{formatCaptureTime(analysis.capturedAt)}
          </Typography>
          {result?.browserData?.queryPlan?.categoryPath ? (
            <Typography variant="caption" color="text.secondary">
              类目匹配：{result.browserData.queryPlan.categoryPath}
            </Typography>
          ) : null}
        </Box>
      </Box>
      {result.refreshWarning ? (
        <Alert severity="warning" sx={{ mb: 1.5 }}>
          本次更新没有成功，下面显示上一次保存的数据。{result.refreshWarning}
        </Alert>
      ) : null}

      {result?.productLinkStatus?.status === 'error' ? (
        <Alert severity="warning">{result.productLinkStatus.message}</Alert>
      ) : null}
      <TargetProductCard product={result?.targetProduct} />
      <ProductSelectionSupport result={result} />

      <Box className="prompt-library-ozon-summary-grid">
        <SummaryCard
          icon={<Inventory2Outlined />}
          label="商品数量"
          value={NUMBER_FORMATTER.format(analysis.recordCount)}
          hint="已按 SKU 去重"
          tone="blue"
        />
        {analysis.priceStats?.count ? (
          <SummaryCard
            icon={<LocalOfferOutlined />}
            label="中间售价"
            value={formatCompactRuble(analysis.priceStats?.median)}
            hint={`${analysis.priceStats.count} 款有有效售价`}
            tone="violet"
          />
        ) : null}
        {analysis.salesStats?.count ? (
          <SummaryCard
            icon={<SellOutlined />}
            label="总销量"
            value={formatNumber(analysis.salesStats?.total, ' 件')}
            hint={`${analysis.salesStats.count} 款有有效销量`}
            tone="orange"
          />
        ) : null}
        {analysis.revenueStats?.count ? (
          <SummaryCard
            icon={<ArrowUpwardRounded />}
            label="总销售额"
            value={formatCompactRuble(analysis.revenueStats?.total)}
            hint={`${analysis.revenueStats.count} 款有销售额数据`}
            tone="green"
          />
        ) : null}
        {analysis.growthStats?.count ? (
          <SummaryCard
            icon={<ArrowUpwardRounded />}
            label="销售额变化"
            value={formatPercent(analysis.growthStats?.median)}
            hint={`${analysis.growthStats.count} 款有变化数据`}
            tone="green"
          />
        ) : null}
        {analysis.brandCount ? (
          <SummaryCard
            icon={<SellOutlined />}
            label="品牌数量"
            value={NUMBER_FORMATTER.format(analysis.brandCount)}
            hint={topPriceBand?.count ? `常见售价：${topPriceBand.label}` : '按品牌名称去重'}
            tone="orange"
          />
        ) : null}
        {analysis.decision?.followSellerPressure?.count ? (
          <SummaryCard
            icon={<StorefrontOutlined />}
            label="有跟卖的商品"
            value={NUMBER_FORMATTER.format(analysis.decision.followSellerPressure.followedProductCount)}
            hint={`${NUMBER_FORMATTER.format(analysis.decision.followSellerPressure.count)} 款有数据 · 常见跟卖数 ${formatNumber(analysis.decision.followSellerPressure.median)}`}
            tone="slate"
          />
        ) : analysis.sellerCount ? (
          <SummaryCard
            icon={<StorefrontOutlined />}
            label="卖家数量"
            value={NUMBER_FORMATTER.format(analysis.sellerCount)}
            hint="按卖家名称去重"
            tone="slate"
          />
        ) : null}
      </Box>

      <OzonProductDecisionPanel decision={analysis.decision} />

      <Box className="prompt-library-ozon-analysis-grid">
        <Box className="prompt-library-ozon-panel prompt-library-ozon-insights-panel">
          <Box className="prompt-library-ozon-panel-head">
            <Box>
              <Typography variant="subtitle1">市场情况</Typography>
              <Typography variant="caption">根据现有商品数据整理</Typography>
            </Box>
          </Box>
          <Box className="prompt-library-ozon-insight-list">
            {(analysis.insights || []).map((item, index) => (
              <Box key={item.key} className={`prompt-library-ozon-insight is-${item.tone || 'neutral'}`}>
                <Box className="prompt-library-ozon-insight-index">{index + 1}</Box>
                <Box minWidth={0}>
                  <Typography variant="subtitle2">{item.title}</Typography>
                  <Typography variant="body2">{item.detail}</Typography>
                </Box>
              </Box>
            ))}
          </Box>
        </Box>

        <Box className="prompt-library-ozon-panel prompt-library-ozon-distribution-panel">
          <Box className="prompt-library-ozon-panel-head">
            <Box>
              <Typography variant="subtitle1">商品价格分布</Typography>
              <Typography variant="caption">看看商品主要卖在哪些价位</Typography>
            </Box>
          </Box>
          <Stack spacing={1.05}>
            {(analysis.priceBands || []).map((band) => (
              <Box key={band.key} className="prompt-library-ozon-band-row">
                <Typography variant="caption">{band.label}</Typography>
                <Box className="prompt-library-ozon-band-track">
                  <Box className="prompt-library-ozon-band-fill" sx={{ width: `${band.percent}%` }} />
                </Box>
                <Typography variant="caption">{band.count} 款</Typography>
              </Box>
            ))}
          </Stack>
          {analysis.topBrands?.length ? (
            <Box className="prompt-library-ozon-brand-block">
              <Typography variant="caption" className="prompt-library-ozon-brand-label">常见品牌</Typography>
              <Stack direction="row" spacing={0.65} flexWrap="wrap" useFlexGap>
                {analysis.topBrands.slice(0, 6).map((brand) => (
                  <Chip key={brand.name} size="small" variant="outlined" label={`${brand.name} · ${brand.count}`} />
                ))}
              </Stack>
            </Box>
          ) : null}
        </Box>
      </Box>

      <Box className="prompt-library-ozon-panel prompt-library-ozon-table-panel">
        <Box className="prompt-library-ozon-panel-head prompt-library-ozon-table-headline">
          <Box>
            <Typography variant="subtitle1">商品明细</Typography>
            <Typography variant="caption">价格、销量、销售额、库存和跟卖情况</Typography>
          </Box>
          <Typography variant="caption">
            第 {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, sortedRecords.length)} 条，共 {sortedRecords.length} 条
          </Typography>
        </Box>
        <TableContainer className="prompt-library-ozon-table-wrap">
          <Table size="small" stickyHeader aria-label="Ozon 商品市场结果">
            <TableHead>
              <TableRow>
                <TableCell>商品</TableCell>
                <TableCell>类目 / 品牌</TableCell>
                {hasPriceGroup ? <SortableHeading field={coverage.price ? 'price' : 'cardPrice'} label="价格" sortKey={sortKey} direction={direction} onSort={handleSort} align="right" /> : null}
                {hasSalesGroup ? <SortableHeading field={coverage.sales ? 'sales' : coverage.orders ? 'orders' : 'averageDailyUnits'} label="销售" sortKey={sortKey} direction={direction} onSort={handleSort} align="right" /> : null}
                {hasRevenueGroup ? <SortableHeading field={coverage.revenue ? 'revenue' : coverage.averageDailyRevenue ? 'averageDailyRevenue' : 'growth'} label="销售额" sortKey={sortKey} direction={direction} onSort={handleSort} align="right" /> : null}
                {hasReputationGroup ? <SortableHeading field={coverage.stock ? 'stock' : coverage.rating ? 'rating' : 'reviews'} label="库存与口碑" sortKey={sortKey} direction={direction} onSort={handleSort} align="right" /> : null}
              </TableRow>
            </TableHead>
            <TableBody>
              {pageRows.map((record, index) => {
                const rowNumber = (page - 1) * PAGE_SIZE + index + 1;
                const rowKey = `${record.id || record.title || 'record'}-${rowNumber}`;
                return (
                  <React.Fragment key={rowKey}>
                    <TableRow className="prompt-library-ozon-product-row" hover>
                      <TableCell>
                        <Stack direction="row" spacing={1} alignItems="center" minWidth={0}>
                          {record.imageUrl ? (
                            <Box
                              component="img"
                              src={record.imageUrl}
                              alt=""
                              className="prompt-library-ozon-product-image"
                              onError={(event) => { event.currentTarget.style.visibility = 'hidden'; }}
                            />
                          ) : (
                            <Box className="prompt-library-ozon-product-image is-empty">{rowNumber}</Box>
                          )}
                          <Box minWidth={0}>
                            <Tooltip title={record.title || '暂无商品标题'} placement="top-start">
                              {typeof onOpenProduct === 'function' ? (
                                <ButtonBase
                                  className="prompt-library-ozon-product-link"
                                  aria-label={`打开商品操作台：${record.title || record.id || rowNumber}`}
                                  onClick={() => onOpenProduct(record)}
                                >
                                  <Typography variant="body2" className="prompt-library-ozon-product-title">
                                    {record.title || '暂无商品标题'}
                                  </Typography>
                                </ButtonBase>
                              ) : (
                                <Typography variant="body2" className="prompt-library-ozon-product-title">
                                  {record.title || '暂无商品标题'}
                                </Typography>
                              )}
                            </Tooltip>
                            <Typography variant="caption" className="prompt-library-ozon-product-sku">
                              SKU {record.id || '—'}
                            </Typography>
                          </Box>
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <ProductMetricList
                          taxonomy
                          items={[
                            { label: '类目', value: categoryPath(record) || '未分类' },
                            { label: '品牌', value: record.brand, visible: Boolean(record.brand) },
                            { label: '卖家', value: record.seller, visible: Boolean(record.seller) },
                          ]}
                        />
                      </TableCell>
                      {hasPriceGroup ? (
                        <TableCell align="right">
                          <ProductMetricList items={[
                            { label: '当前售价', value: formatRuble(record.price), visible: coverage.price && metric(record.price) !== null },
                            { label: 'Ozon Card 价', value: formatPriceCurrency(record.cardPrice, record.cardPriceCurrency), visible: coverage.cardPrice && metric(record.cardPrice) !== null },
                          ]} />
                        </TableCell>
                      ) : null}
                      {hasSalesGroup ? (
                        <TableCell align="right">
                          <ProductMetricList items={[
                            { label: '销量', value: formatNumber(record.sales, ' 件'), visible: coverage.sales && metric(record.sales) !== null },
                            { label: '订单量', value: formatNumber(record.orders, ' 单'), visible: coverage.orders && metric(record.orders) !== null },
                            { label: '日均销量', value: formatNumber(record.averageDailyUnits, ' 件'), visible: coverage.averageDailyUnits && metric(record.averageDailyUnits) !== null },
                          ]} />
                        </TableCell>
                      ) : null}
                      {hasRevenueGroup ? (
                        <TableCell align="right">
                          <ProductMetricList tone="gmv" items={[
                            { label: '销售额', value: formatRuble(record.revenue), visible: coverage.revenue && metric(record.revenue) !== null },
                            { label: '日均销售额', value: formatRuble(record.averageDailyRevenue), visible: coverage.averageDailyRevenue && metric(record.averageDailyRevenue) !== null },
                            { label: '销售额变化', value: formatPercent(record.growth), visible: coverage.growth && metric(record.growth) !== null },
                          ]} />
                        </TableCell>
                      ) : null}
                      {hasReputationGroup ? (
                        <TableCell align="right">
                          <ProductMetricList items={[
                            { label: '可售库存', value: formatNumber(record.stock, ' 件'), visible: coverage.stock && metric(record.stock) !== null },
                            { label: '商品评分', value: formatNumber(record.rating, ' 分'), visible: coverage.rating && metric(record.rating) !== null },
                            { label: '评价数量', value: formatNumber(record.reviews, ' 条'), visible: coverage.reviews && metric(record.reviews) !== null },
                            { label: '跟卖数量', value: formatNumber(record.followSellerCount, ' 个'), visible: coverage.followSellerCount && metric(record.followSellerCount) !== null },
                          ]} />
                        </TableCell>
                      ) : null}
                    </TableRow>
                    {hasExpandedProductData ? (
                      <TableRow className="prompt-library-ozon-expanded-row">
                        <TableCell colSpan={primaryColumnCount}>
                          <ProductExpandedData record={record} coverage={coverage} />
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </React.Fragment>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
        {pageCount > 1 ? (
          <Box className="prompt-library-ozon-pagination">
            <Pagination
              size="small"
              shape="rounded"
              count={pageCount}
              page={page}
              onChange={(_event, nextPage) => setPage(nextPage)}
            />
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
