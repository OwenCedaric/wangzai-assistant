import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';

const RESULT_PAGE_SIZE = 25;

const MARKET_METRICS = Object.freeze([
  ['searchVolume', '月搜热度', 'number'],
  ['count30GrowthRate', '月搜增长', 'percent'],
  ['count90GrowthRate', '90 天增长', 'percent'],
  ['sales', '月销量', 'number'],
  ['revenue', '月销售额', 'money'],
  ['productCount', '商品数', 'number'],
  ['competingProducts', '竞品数', 'number'],
  ['sellers', '卖家数', 'number'],
  ['avgPrice', '平均价格', 'money'],
  ['ratings', '平均评分', 'number'],
  ['reviews', '评论数', 'number'],
  ['itemsViews', '商品可见度', 'number'],
  ['viewSharing', '浏览集中度', 'percent'],
  ['conversionSharing', '转化集中度', 'percent'],
  ['searchUsersToOrdUsers', '搜索下单转化', 'percent'],
  ['marketSpace', '市场空间', 'number'],
  ['uniqQueriesWCa', '加购数', 'number'],
  ['ca', '加购转化率', 'percent'],
  ['returnCancellationRate', '退货取消率', 'percent'],
  ['margin', '市场余量', 'number'],
  ['volume', '体量', 'number'],
  ['weight', '权重', 'number'],
  ['relevancy', '相关度', 'number'],
  ['titleDensity', '标题密度', 'number'],
  ['wordCount', '字数', 'number'],
  ['naturalRank', '自然排名', 'number'],
  ['adRank', '广告排名', 'number'],
  ['exposure', '曝光', 'number'],
  ['conversion', '转化', 'percent'],
  ['opportunityScore', '机会指数', 'number'],
]);

function text(value) {
  return String(value ?? '').trim();
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value));
}

function formatNumber(value) {
  if (!hasValue(value)) return '';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(Number(value));
}

function formatMetric(value, type) {
  const formatted = formatNumber(value);
  if (!formatted) return '';
  if (type === 'percent') return `${formatted}%`;
  if (type === 'money') return `${formatted} ₽`;
  return formatted;
}

function platformLabel(value) {
  return Number(value) === 1 ? 'Wildberries' : 'Ozon';
}

function categoryRows(record = {}) {
  const fromInfo = (Array.isArray(record.categoryInfos) ? record.categoryInfos : []).map((item) => ({
    id: text(item?.id),
    path: text(item?.cnTitlePath || item?.titleCn || item?.titlePath || item?.titleRu || item?.enTitlePath || item?.titleEn),
    alternatePaths: [...new Set([
      item?.titlePath,
      item?.titleRu,
      item?.enTitlePath,
      item?.titleEn,
    ].map(text).filter((value) => value && value !== text(item?.cnTitlePath || item?.titleCn)))],
    crossBorderSellable: item?.crossBorderSellable,
  }));
  const known = new Set(fromInfo.map((item) => item.id).filter(Boolean));
  const ids = (Array.isArray(record.categories) ? record.categories : [])
    .map(text)
    .filter((id) => id && !known.has(id))
    .map((id) => ({ id, path: '', alternatePaths: [], crossBorderSellable: undefined }));
  return [...fromInfo, ...ids];
}

function topProducts(record = {}) {
  const sfKeywordContext = {
    query: text(record.query),
    queryCn: text(record.queryCn),
    searchVolume: record.searchVolume,
    count30GrowthRate: record.count30GrowthRate,
    competingProducts: record.competingProducts,
    sellers: record.sellers,
    avgPrice: record.avgPrice,
    searchUsersToOrdUsers: record.searchUsersToOrdUsers,
  };
  return (Array.isArray(record.products) ? record.products : []).map((item) => {
    const sku = text(item?.sku || item?.ozonId);
    return {
      ...item,
      sku,
      ozonId: text(item?.ozonId),
      title: text(item?.title) || (sku ? `Ozon 商品 ${sku}` : 'Ozon 商品'),
      productUrl: sku ? `https://www.ozon.ru/product/${sku}/` : '',
      sfEnrich: true,
      sfSource: 'seerfar-open-api',
      sfKeywordContext,
    };
  });
}

function MarketKeywordCard({ record, index, onOpenProduct }) {
  const metrics = MARKET_METRICS.map(([field, label, type]) => ({
    field,
    label,
    value: formatMetric(record?.[field], type),
  })).filter((item) => item.value);
  const categories = categoryRows(record);
  const products = topProducts(record);
  const query = text(record?.query) || `关键词 ${index + 1}`;
  const queryCn = text(record?.queryCn);
  const metadata = [
    text(record?.queryTime) ? `数据日期 ${text(record.queryTime)}` : '',
    text(record?.createTime) ? `收录时间 ${text(record.createTime)}` : '',
    typeof record?.withinThesaurus === 'boolean'
      ? `词库收录 ${record.withinThesaurus ? '是' : '否'}`
      : '',
  ].filter(Boolean);

  return (
    <Box className="prompt-library-market-keyword-card">
      <Stack className="prompt-library-market-keyword-card-head" direction="row" alignItems="flex-start">
        <Box minWidth={0} flex={1}>
          <Typography variant="subtitle2" title={query}>{query}</Typography>
          {queryCn ? <Typography variant="body2">{queryCn}</Typography> : null}
        </Box>
        <Chip size="small" label={platformLabel(record?.platform)} />
      </Stack>

      <Box className="prompt-library-market-keyword-metrics">
        {metrics.map((item) => (
          <Box className="prompt-library-market-keyword-metric" key={item.field}>
            <Typography component="span" variant="caption">{item.label}</Typography>
            <Typography component="strong" variant="body2">{item.value}</Typography>
          </Box>
        ))}
      </Box>

      {metadata.length ? (
        <Typography className="prompt-library-market-keyword-metadata" variant="caption">
          {metadata.join(' · ')}
        </Typography>
      ) : null}

      {categories.length ? (
        <Box className="prompt-library-market-keyword-subsection">
          <Typography variant="caption">相关类目</Typography>
          <Stack spacing={0.35}>
            {categories.map((item, categoryIndex) => (
              <Box key={`${item.id}-${categoryIndex}`}>
                <Typography variant="body2" title={item.path || item.id}>
                  {[item.path, item.id ? `ID ${item.id}` : '', item.crossBorderSellable === true ? '可跨境销售' : '']
                    .filter(Boolean)
                    .join(' · ')}
                </Typography>
                {item.alternatePaths?.length ? (
                  <Typography className="prompt-library-market-keyword-category-alt" variant="caption">
                    {item.alternatePaths.join(' · ')}
                  </Typography>
                ) : null}
              </Box>
            ))}
          </Stack>
        </Box>
      ) : null}

      {products.length ? (
        <Box className="prompt-library-market-keyword-subsection">
          <Typography variant="caption">Top 商品</Typography>
          <Box className="prompt-library-market-keyword-products">
            {products.map((product, productIndex) => (
              <ButtonBase
                className="prompt-library-market-keyword-product"
                key={`${product.sku}-${productIndex}`}
                disabled={typeof onOpenProduct !== 'function' || !product.sku}
                onClick={() => onOpenProduct?.(product)}
                aria-label={`打开商品操作台：${product.title}`}
              >
                {product.imageUrl ? (
                  <img src={product.imageUrl} alt="" loading="lazy" />
                ) : null}
                <Box minWidth={0}>
                  <Typography variant="body2" title={product.title}>{product.title}</Typography>
                  <Typography variant="caption">
                    {[
                      product.sku ? `SKU ${product.sku}` : '',
                      product.ozonId && product.ozonId !== product.sku ? `Ozon ID ${product.ozonId}` : '',
                      Number(product.advert) === 1 ? '广告商品' : '自然商品',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Typography>
                </Box>
              </ButtonBase>
            ))}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

export function PromptLibraryMarketKeywordResult({ result = {}, onOpenProduct = null }) {
  const analysis = result?.keywordAnalysis || result?.marketKeywordAnalysis || {};
  const overview = analysis.overview || {};
  const records = React.useMemo(
    () => (Array.isArray(analysis.records) ? analysis.records : []),
    [analysis.records],
  );
  const totalPages = Math.max(1, Math.ceil(records.length / RESULT_PAGE_SIZE));
  const [page, setPage] = React.useState(1);

  React.useEffect(() => { setPage(1); }, [records]);

  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * RESULT_PAGE_SIZE;
  const visible = records.slice(start, start + RESULT_PAGE_SIZE);

  return (
    <Stack className="prompt-library-market-keyword-result" spacing={1.25}>
      <Box className="prompt-library-market-keyword-overview">
        <Box><Typography variant="caption">已读取</Typography><Typography variant="subtitle2">{formatNumber(records.length)} 条</Typography></Box>
        <Box><Typography variant="caption">总搜索量</Typography><Typography variant="subtitle2">{formatNumber(overview.totalSearchVolume) || '暂无'}</Typography></Box>
        <Box><Typography variant="caption">平均增长</Typography><Typography variant="subtitle2">{formatNumber(overview.averageGrowth) ? `${formatNumber(overview.averageGrowth)}%` : '暂无'}</Typography></Box>
        <Box><Typography variant="caption">平均竞品</Typography><Typography variant="subtitle2">{formatNumber(overview.averageCompetition) || '暂无'}</Typography></Box>
        <Box><Typography variant="caption">平均卖家</Typography><Typography variant="subtitle2">{formatNumber(overview.averageSellers) || '暂无'}</Typography></Box>
        <Box><Typography variant="caption">相关类目</Typography><Typography variant="subtitle2">{formatNumber(analysis.categoryCount || 0)}</Typography></Box>
        <Box><Typography variant="caption">Top 商品</Typography><Typography variant="subtitle2">{formatNumber(analysis.topProductCount || 0)}</Typography></Box>
      </Box>

      {Array.isArray(analysis.insights) && analysis.insights.length ? (
        <Box className="prompt-library-market-keyword-insights">
          <Typography variant="caption">数据分析</Typography>
          {analysis.insights.map((insight, index) => (
            <Typography key={`${insight}-${index}`} variant="body2">{insight}</Typography>
          ))}
        </Box>
      ) : null}

      {analysis.querySummary ? (
        <Typography className="prompt-library-market-keyword-query" variant="caption">
          {analysis.querySummary}
        </Typography>
      ) : null}

      <Stack spacing={1}>
        {visible.map((record, index) => (
          <MarketKeywordCard
            key={`${record?.id || record?.query || 'keyword'}-${start + index}`}
            record={record}
            index={start + index}
            onOpenProduct={onOpenProduct}
          />
        ))}
      </Stack>

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
    </Stack>
  );
}
