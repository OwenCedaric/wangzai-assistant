import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';

const RESULT_PAGE_SIZE = 25;

function finite(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatNumber(value, suffix = '') {
  const parsed = finite(value);
  return parsed === null
    ? '—'
    : `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(parsed)}${suffix}`;
}

function formatMoney(value) {
  const rendered = formatNumber(value);
  return rendered === '—' ? rendered : `${rendered} ₽`;
}

function text(value) {
  return String(value ?? '').trim();
}

function ProductRow({ product = {}, onOpenProduct = null }) {
  const sku = text(product.sku || product.productId || product.id);
  const title = text(product.title || product.name) || (sku ? `Ozon 商品 ${sku}` : 'Ozon 商品');
  return (
    <Box className="prompt-library-external-product-row">
      <ButtonBase
        className="prompt-library-external-product-main"
        disabled={!sku || typeof onOpenProduct !== 'function'}
        onClick={() => onOpenProduct?.(product)}
        aria-label={`打开商品操作台：${title}`}
      >
        {product.imageUrl ? <img src={product.imageUrl} alt="" loading="lazy" /> : null}
        <Box minWidth={0}>
          <Typography variant="body2" title={title}>{title}</Typography>
          <Typography variant="caption">{sku ? `SKU ${sku}` : '无 SKU'}</Typography>
        </Box>
      </ButtonBase>
      <Typography variant="body2">{formatMoney(product.price)}</Typography>
      <Typography variant="body2">{formatNumber(product.sales)}</Typography>
      <Typography variant="body2">{formatMoney(product.revenue)}</Typography>
      <Typography variant="body2">{formatNumber(product.stock)}</Typography>
      <Typography variant="body2">
        {formatNumber(product.rating)} / {formatNumber(product.reviews)}
      </Typography>
      <Typography variant="body2" title={text(product.seller)}>{text(product.seller) || '—'}</Typography>
      <Typography variant="body2" title={text(product.fulfillmentModel)}>
        {text(product.fulfillmentModel) || '—'}
      </Typography>
      <Typography variant="body2">{formatNumber(product.returnCancelRate, '%')}</Typography>
    </Box>
  );
}

function TrendRows({ trends = [] }) {
  const visible = trends.slice(-30);
  if (!visible.length) return null;
  return (
    <Box className="prompt-library-external-trend-section">
      <Typography variant="subtitle2">每日趋势（近 {visible.length} 天）</Typography>
      <Box className="prompt-library-external-trend-head">
        <Typography variant="caption">日期</Typography>
        <Typography variant="caption">销量</Typography>
        <Typography variant="caption">销售额</Typography>
        <Typography variant="caption">价格</Typography>
        <Typography variant="caption">库存</Typography>
        <Typography variant="caption">评分</Typography>
      </Box>
      {visible.map((row, index) => (
        <Box className="prompt-library-external-trend-row" key={`${row?.date || 'date'}-${index}`}>
          <Typography variant="body2">{text(row?.date) || '—'}</Typography>
          <Typography variant="body2">{formatNumber(row?.sales)}</Typography>
          <Typography variant="body2">{formatMoney(row?.revenue)}</Typography>
          <Typography variant="body2">{formatMoney(row?.price)}</Typography>
          <Typography variant="body2">{formatNumber(row?.stock)}</Typography>
          <Typography variant="body2">{formatNumber(row?.reviewRating)}</Typography>
        </Box>
      ))}
    </Box>
  );
}

function CategoryRankRows({ records = [] }) {
  const ranks = Array.isArray(records[0]?.categoryRanks) ? records[0].categoryRanks.slice(-30) : [];
  if (!ranks.length) return null;
  return (
    <Box className="prompt-library-external-rank-section">
      <Typography variant="subtitle2">类目排名（近 {ranks.length} 条）</Typography>
      <Box className="prompt-library-external-rank-head">
        <Typography variant="caption">日期</Typography>
        <Typography variant="caption">排名</Typography>
        <Typography variant="caption">同类商品数</Typography>
      </Box>
      {ranks.map((row, index) => (
        <Box className="prompt-library-external-rank-row" key={`${row?.date || 'rank'}-${index}`}>
          <Typography variant="body2">{text(row?.date) || '—'}</Typography>
          <Typography variant="body2">{formatNumber(row?.rank)}</Typography>
          <Typography variant="body2">{formatNumber(row?.count)}</Typography>
        </Box>
      ))}
    </Box>
  );
}

export function PromptLibraryExternalProductResult({ result = {}, onOpenProduct = null }) {
  const analysis = result?.externalAnalysis || {};
  const overview = analysis.overview || {};
  const records = React.useMemo(
    () => (Array.isArray(analysis.records) ? analysis.records : []),
    [analysis.records],
  );
  const totalPages = Math.max(1, Math.ceil(records.length / RESULT_PAGE_SIZE));
  const [page, setPage] = React.useState(1);
  React.useEffect(() => setPage(1), [records]);
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * RESULT_PAGE_SIZE;
  const visible = records.slice(start, start + RESULT_PAGE_SIZE);

  if (!records.length) return null;

  return (
    <Stack className="prompt-library-external-product-result" spacing={1.25}>
      <Box className="prompt-library-external-product-overview">
        <Box><Typography variant="caption">商品数</Typography><Typography variant="subtitle2">{formatNumber(overview.recordCount)}</Typography></Box>
        <Box><Typography variant="caption">总销量</Typography><Typography variant="subtitle2">{formatNumber(overview.totalSales)}</Typography></Box>
        <Box><Typography variant="caption">总销售额</Typography><Typography variant="subtitle2">{formatMoney(overview.totalRevenue)}</Typography></Box>
        <Box><Typography variant="caption">平均价格</Typography><Typography variant="subtitle2">{formatMoney(overview.averagePrice)}</Typography></Box>
        <Box><Typography variant="caption">平均评分</Typography><Typography variant="subtitle2">{formatNumber(overview.averageRating)}</Typography></Box>
        <Box><Typography variant="caption">总库存</Typography><Typography variant="subtitle2">{formatNumber(overview.totalStock)}</Typography></Box>
        <Box><Typography variant="caption">平均退货取消</Typography><Typography variant="subtitle2">{formatNumber(overview.averageReturnCancelRate, '%')}</Typography></Box>
      </Box>

      {Array.isArray(analysis.insights) && analysis.insights.length ? (
        <Box className="prompt-library-external-product-insights">
          <Typography variant="caption">
            {analysis.analysisModeLabel ? `${analysis.analysisModeLabel}结果` : '数据分析'}
          </Typography>
          {analysis.insights.map((insight, index) => (
            <Typography variant="body2" key={`${insight}-${index}`}>{insight}</Typography>
          ))}
        </Box>
      ) : null}

      <Box className="prompt-library-external-product-table">
        <Box className="prompt-library-external-product-head">
          <Typography variant="caption">商品</Typography>
          <Typography variant="caption">价格</Typography>
          <Typography variant="caption">销量</Typography>
          <Typography variant="caption">销售额</Typography>
          <Typography variant="caption">库存</Typography>
          <Typography variant="caption">评分 / 评价</Typography>
          <Typography variant="caption">卖家</Typography>
          <Typography variant="caption">配送</Typography>
          <Typography variant="caption">退货取消</Typography>
        </Box>
        {visible.map((product, index) => (
          <ProductRow
            key={`${product?.sku || product?.id || 'product'}-${start + index}`}
            product={product}
            onOpenProduct={onOpenProduct}
          />
        ))}
      </Box>

      {totalPages > 1 ? (
        <Stack className="prompt-library-external-result-pagination" direction="row" alignItems="center">
          <Typography variant="caption">
            {start + 1}-{Math.min(start + RESULT_PAGE_SIZE, records.length)} / {records.length}
          </Typography>
          <Button size="small" disabled={safePage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</Button>
          <Typography variant="caption">第 {safePage} / {totalPages} 页</Typography>
          <Button size="small" disabled={safePage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>下一页</Button>
        </Stack>
      ) : null}

      <TrendRows trends={Array.isArray(analysis.trends) ? analysis.trends : []} />
      <CategoryRankRows records={records} />
    </Stack>
  );
}
