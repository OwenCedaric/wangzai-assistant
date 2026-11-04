import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TablePagination from '@mui/material/TablePagination';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import React from 'react';
import {
  formatMarketMoney,
  formatMarketNumber,
  formatMarketPercent,
  getVisibleMarketColumns,
  marketDatasetId,
  marketDatasetLabel,
  marketDatasetRecords,
  marketText,
  rawMarketDatasetRecords,
} from '../lib/dataAnalysisMarketView.js';
import { isProductPerformanceZeroAmountConflict } from '../lib/dataAnalysisMarketMetrics.js';
import { DataAnalysisEmptyState } from './DataAnalysisEmptyState.jsx';
import { DataAnalysisProductLink } from './DataAnalysisProductLink.jsx';

function MarketRecordName({ row, clickable = false, onProductLinkError }) {
  const secondaryText = row?.id ? `ID ${row.id}` : row?.date || '';
  const title = (
    <Typography
      component="span"
      variant="body2"
      fontWeight={850}
      title={marketText(row?.title, marketText(row?.id, '未返回名称'))}
      sx={{ display: 'block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
    >
      {marketText(row?.title, marketText(row?.id, '未返回名称'))}
    </Typography>
  );
  return (
    <Stack direction="row" spacing={1} alignItems="center" minWidth={0}>
      {row?.imageUrl ? (
        <Box
          component="img"
          src={row.imageUrl}
          alt=""
          loading="lazy"
          sx={{ width: 40, height: 40, flex: '0 0 auto', borderRadius: 1.25, objectFit: 'cover', bgcolor: '#f4f6fa' }}
        />
      ) : null}
      <Box sx={{ minWidth: 0, maxWidth: '100%', overflow: 'hidden' }}>
        {clickable ? (
          <DataAnalysisProductLink source={row} onError={onProductLinkError}>
            {title}
          </DataAnalysisProductLink>
        ) : title}
        {secondaryText ? (
          <Typography variant="caption" color="text.secondary" noWrap title={secondaryText} sx={{ display: 'block' }}>
            {secondaryText}
          </Typography>
        ) : null}
      </Box>
    </Stack>
  );
}

function MarketRecordPair({ primary, secondary }) {
  return (
    <Box sx={{ width: '100%', minWidth: 0, maxWidth: '100%' }}>
      <Typography variant="body2" noWrap title={marketText(primary)}>{marketText(primary)}</Typography>
      <Typography variant="caption" color="text.secondary" noWrap title={marketText(secondary)}>{marketText(secondary)}</Typography>
    </Box>
  );
}

function marketCategoryPath(row = {}) {
  return [...new Set([row.category1, row.category2, row.category3, row.category].map((value) => marketText(value, '')).filter(Boolean))].join(' / ');
}

function MarketDailyMetrics({ row }) {
  return (
    <Box sx={{ width: '100%', minWidth: 0 }}>
      <Typography variant="body2" noWrap title={formatMarketMoneyField(row, 'averageDailyRevenue')}>
        {formatMarketMoneyField(row, 'averageDailyRevenue')}
      </Typography>
      <Typography variant="caption" color="text.secondary" noWrap>
        {formatMarketNumber(row.averageDailyUnits)} 件/日
      </Typography>
    </Box>
  );
}

function MarketMetricLines({ items = [] }) {
  return (
    <Stack spacing={0.2} sx={{ width: '100%', minWidth: 0 }}>
      {items.map((item) => (
        <Typography
          key={item.label}
          variant="caption"
          noWrap
          title={`${item.label} ${item.value}`}
          sx={{ display: 'block', minWidth: 0, color: item.color || '#344765', lineHeight: 1.45 }}
        >
          <Box component="span" sx={{ mr: 0.4, color: '#7a879b', fontWeight: 750 }}>{item.label}</Box>
          <Box component="span" sx={{ fontWeight: 850, fontVariantNumeric: 'tabular-nums' }}>{item.value}</Box>
        </Typography>
      ))}
    </Stack>
  );
}

function marketDate(value) {
  const parsed = new Date(value);
  return !value || Number.isNaN(parsed.getTime()) ? marketText(value) : parsed.toISOString().slice(0, 10);
}

function MarketProductIdentity({ row }) {
  return (
    <Box sx={{ width: '100%', minWidth: 0 }}>
      <MarketRecordPair primary={row.brand} secondary={marketCategoryPath(row)} />
      {row.seller ? <Typography variant="caption" color="text.secondary" noWrap title={marketText(row.seller)}>卖家 {marketText(row.seller)}</Typography> : null}
      {row.article ? <Typography variant="caption" color="text.secondary" noWrap title={marketText(row.article)}>货号 {marketText(row.article)}</Typography> : null}
      {row.feature || row.recommendation ? <Typography variant="caption" color="text.secondary" noWrap title={marketText(row.feature, marketText(row.recommendation))}>特征 {marketText(row.feature, marketText(row.recommendation))}</Typography> : null}
      {row.searchPosition !== null && row.searchPosition !== undefined ? <Typography variant="caption" color="text.secondary" noWrap>搜索位置 {formatMarketNumber(row.searchPosition)}</Typography> : null}
    </Box>
  );
}

function MarketSalesPerformance({ row }) {
  const zeroAmountConflict = isProductPerformanceZeroAmountConflict(row);
  return <MarketMetricLines items={[
    { label: '销量', value: formatMarketNumber(row.orderedProducts ?? row.sales) },
    {
      label: '金额',
      value: zeroAmountConflict
        ? `${formatMarketMoneyField(row, 'orderAmount')} · Ozon原值`
        : formatMarketMoneyField(row, 'orderAmount'),
      color: zeroAmountConflict ? '#a15c18' : undefined,
    },
    { label: '均价', value: formatMarketMoneyField(row, 'averagePurchasePrice') },
    { label: '日均', value: `${formatMarketMoneyField(row, 'averageDailyRevenue')} / ${formatMarketNumber(row.averageDailyUnits)}件` },
    { label: '动态', value: formatMarketPercent(row.dynamics) },
  ]} />;
}

function MarketPromotionPerformance({ row }) {
  return <MarketMetricLines items={[
    { label: '广告', value: formatMarketPercent(row.adSpendShare) },
    { label: '促销', value: `${formatMarketNumber(row.promoDays)}天 / ${formatMarketPercent(row.promoDiscount)}` },
    { label: '促销销售', value: formatMarketPercent(row.promoRevenueShare) },
    { label: '付费推广', value: `${formatMarketNumber(row.paidPromotionDays)}天` },
  ]} />;
}

function MarketTrafficPerformance({ row }) {
  return <MarketMetricLines items={[
    { label: '商品卡', value: `${formatMarketNumber(row.productCardViews)} / 加购 ${formatMarketPercent(row.productCardToCartRate)}` },
    { label: '搜索目录', value: `${formatMarketNumber(row.searchCatalogViews)} / 加购 ${formatMarketPercent(row.searchCatalogToCartRate)}` },
  ]} />;
}

function MarketConversionPerformance({ row }) {
  return <MarketMetricLines items={[
    { label: '展示下单', value: formatMarketPercent(row.impressionToOrderRate) },
    { label: '点击', value: formatMarketPercent(row.clickThroughRate) },
    { label: '退货取消', value: formatMarketPercent(row.returnCancelRate) },
  ]} />;
}

function MarketFulfillmentPerformance({ row }) {
  return <MarketMetricLines items={[
    { label: '模式', value: marketText(row.fulfillmentModel) },
    { label: '尺寸', value: marketText(row.packageDimensions) },
    { label: '重量', value: marketText(row.packageWeight) },
    { label: 'rFBS', value: marketText(row.rfbsRate) },
  ]} />;
}

function MarketListingPerformance({ row }) {
  return <MarketMetricLines items={[
    { label: '上架', value: `${marketDate(row.listedAt)} / ${formatMarketNumber(row.listingDays)}天` },
    { label: '跟卖', value: formatMarketNumber(row.followSellerCount) },
    { label: '最低', value: formatMarketMoneyField(row, 'followMinPrice') },
    { label: '最高', value: formatMarketMoneyField(row, 'followMaxPrice') },
  ]} />;
}

function formatMarketMoneyField(row = {}, field) {
  if (row.currencyStatus === 'currency_unconfirmed' && row.currencyUnconfirmedFields?.includes(field)) {
    return '汇率未确认';
  }
  return formatMarketMoney(row[field]);
}

const GENERIC_COLUMNS = Object.freeze([
  { label: '记录', width: '30%', alwaysVisible: true, render: (row) => <MarketRecordName row={row} /> },
  { label: '类目', width: '18%', field: 'category', render: (row) => marketText(row.category) },
  { label: '品牌', width: '16%', field: 'brand', render: (row) => marketText(row.brand) },
  { label: 'GMV', width: '15%', field: 'revenue', render: (row) => formatMarketMoneyField(row, 'revenue') },
  { label: '销量', width: '11%', field: 'sales', render: (row) => formatMarketNumber(row.sales) },
  { label: '库存', width: '10%', field: 'stock', render: (row) => formatMarketNumber(row.stock) },
]);

function buildMarketColumns(id) {
  if (id === 'keywords') {
    return [
      { label: '搜索词', width: '37%', alwaysVisible: true, render: (row) => <MarketRecordName row={row} /> },
      { label: '搜索量', width: '12%', field: 'searches', render: (row) => formatMarketNumber(row.searches) },
      { label: '商品浏览', width: '10%', field: 'views', render: (row) => formatMarketNumber(row.views) },
      { label: '下单量', width: '10%', field: 'orders', render: (row) => formatMarketNumber(row.orders) },
      { label: 'GMV', width: '16%', field: 'revenue', render: (row) => formatMarketMoney(row.revenue) },
      { label: '搜索转化', width: '8%', field: 'conversion', render: (row) => formatMarketPercent(row.conversion) },
      { label: '卖家数', width: '7%', field: 'uniqueSellers', render: (row) => formatMarketNumber(row.uniqueSellers) },
    ];
  }
  if (id === 'missing-items') {
    return [
      { label: '机会商品', width: '25%', alwaysVisible: true, render: (row) => <MarketRecordName row={row} /> },
      { label: '品牌 / 类目', width: '18%', field: ['brand', 'category', 'category1', 'category2', 'category3'], render: (row) => <MarketRecordPair primary={row.brand} secondary={marketCategoryPath(row)} /> },
      { label: '市场销量', width: '9%', field: 'sales', render: (row) => formatMarketNumber(row.sales) },
      { label: '平均价格', width: '11%', field: 'averagePrice', render: (row) => formatMarketMoneyField(row, 'averagePrice') },
      { label: '日均表现', width: '13%', field: ['averageDailyRevenue', 'averageDailyUnits'], render: (row) => <MarketDailyMetrics row={row} /> },
      { label: '市场 GMV', width: '14%', field: 'revenue', render: (row) => formatMarketMoneyField(row, 'revenue') },
      { label: 'GMV 变化', width: '10%', field: 'growth', render: (row) => formatMarketPercent(row.growth) },
    ];
  }
  if (id === 'categories' || id === 'brands') {
    return [
      { label: id === 'categories' ? '类目机会' : '品牌机会', width: '30%', alwaysVisible: true, render: (row) => <MarketRecordName row={row} /> },
      { label: '机会商品', width: '12%', field: 'sourceRecordCount', render: (row) => formatMarketNumber(row.sourceRecordCount) },
      { label: '市场销量', width: '12%', field: 'sales', render: (row) => formatMarketNumber(row.sales) },
      { label: '平均价格', width: '14%', field: 'averagePrice', render: (row) => formatMarketMoneyField(row, 'averagePrice') },
      { label: '市场 GMV', width: '17%', field: 'revenue', render: (row) => formatMarketMoneyField(row, 'revenue') },
      { label: '平均 GMV 变化', width: '15%', field: 'growth', render: (row) => formatMarketPercent(row.growth) },
    ];
  }
  if (id === 'product-performance') {
    return [
      { label: '商品', width: '20%', alwaysVisible: true, render: (row) => <MarketRecordName row={row} /> },
      { label: '品牌 / 类目', width: '14%', field: ['brand', 'seller', 'article', 'feature', 'recommendation', 'searchPosition', 'category', 'category1', 'category2', 'category3'], render: (row) => <MarketProductIdentity row={row} /> },
      { label: '销售表现', width: '14%', field: ['orderedProducts', 'sales', 'orderAmount', 'averagePurchasePrice', 'averageDailyRevenue', 'averageDailyUnits', 'dynamics'], render: (row) => <MarketSalesPerformance row={row} /> },
      { label: '广告 / 促销', width: '13%', field: ['adSpendShare', 'promoDays', 'promoDiscount', 'promoRevenueShare', 'paidPromotionDays'], render: (row) => <MarketPromotionPerformance row={row} /> },
      { label: '商品卡 / 搜索', width: '13%', field: ['productCardViews', 'productCardToCartRate', 'searchCatalogViews', 'searchCatalogToCartRate'], render: (row) => <MarketTrafficPerformance row={row} /> },
      { label: '转化', width: '9%', field: ['impressionToOrderRate', 'clickThroughRate', 'returnCancelRate'], render: (row) => <MarketConversionPerformance row={row} /> },
      { label: '履约 / 包裹', width: '9%', field: ['fulfillmentModel', 'packageDimensions', 'packageWeight', 'rfbsRate'], render: (row) => <MarketFulfillmentPerformance row={row} /> },
      { label: '上架 / 跟卖', width: '8%', field: ['listedAt', 'listingDays', 'followSellerCount', 'followMinPrice', 'followMaxPrice'], render: (row) => <MarketListingPerformance row={row} /> },
    ];
  }
  return GENERIC_COLUMNS;
}

export function DataAnalysisMarketRecordTable({ dataset, onProductLinkError }) {
  const rawRows = rawMarketDatasetRecords(dataset);
  const allRows = marketDatasetRecords(dataset);
  const id = marketDatasetId(dataset);
  const isProductDataset = new Set(['market-products', 'products', 'product-performance', 'missing-items']).has(id);
  const [page, setPage] = React.useState(0);
  const [rowsPerPage, setRowsPerPage] = React.useState(100);

  React.useEffect(() => {
    setPage(0);
  }, [id, allRows.length]);

  if (!allRows.length) {
    return (
      <DataAnalysisEmptyState
        title={`${marketDatasetLabel(dataset)}暂无真实记录`}
        description="Ozon 当前没有返回可展示的记录。"
        sourceLabel="Ozon 内置浏览器插件"
        statusLabel="等待真实响应"
      />
    );
  }

  const safePage = Math.min(page, Math.max(0, Math.ceil(allRows.length / rowsPerPage) - 1));
  const rows = allRows.slice(safePage * rowsPerPage, (safePage + 1) * rowsPerPage);
  const columns = getVisibleMarketColumns(allRows, buildMarketColumns(id));
  const filteredKeywordCount = id === 'keywords' ? rawRows.length - allRows.length : 0;

  return (
    <Box>
      {filteredKeywordCount > 0 ? (
        <Alert severity="info" sx={{ mb: 1 }}>
          已隐藏 {formatMarketNumber(filteredKeywordCount)} 条只有名称、没有指标的目录行，表格只保留有搜索量、浏览、下单或 GMV 的真实记录。
        </Alert>
      ) : null}
      <TableContainer
        sx={{
          maxHeight: 560,
          width: '100%',
          minWidth: 0,
          maxWidth: '100%',
          boxSizing: 'border-box',
          border: '1px solid #edf1f6',
          borderRadius: '16px 16px 0 0',
          overflowX: 'hidden',
          overflowY: 'auto',
          scrollbarGutter: 'stable',
        }}
      >
        <Table
          stickyHeader
          size="small"
          aria-label={`${marketDatasetLabel(dataset)}真实数据`}
          sx={{ width: '100%', maxWidth: '100%', tableLayout: 'fixed' }}
        >
          <TableHead>
            <TableRow>
              {columns.map((column, columnIndex) => (
                <TableCell
                  key={column.label}
                  align={columnIndex > 0 ? 'right' : 'left'}
                  sx={{
                    width: column.width,
                    minWidth: 0,
                    overflow: 'hidden',
                    whiteSpace: 'normal',
                    overflowWrap: 'anywhere',
                    fontWeight: 900,
                    lineHeight: 1.25,
                    color: '#52647f',
                  }}
                >
                  {column.label}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row, rowIndex) => {
              const absoluteIndex = safePage * rowsPerPage + rowIndex;
              const rowKey = `${row.id || row.title || row.date || absoluteIndex}-${absoluteIndex}`;
              return (
                <TableRow key={rowKey} hover>
                  {columns.map((column, columnIndex) => (
                    <TableCell
                      key={column.label}
                      align={columnIndex > 0 ? 'right' : 'left'}
                      sx={{
                        py: 1.15,
                        minWidth: 0,
                        maxWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        verticalAlign: 'middle',
                        whiteSpace: 'nowrap',
                        fontVariantNumeric: columnIndex > 0 ? 'tabular-nums' : 'normal',
                      }}
                    >
                      {columnIndex === 0 && isProductDataset
                        ? <MarketRecordName row={row} clickable onProductLinkError={onProductLinkError} />
                        : column.render(row)}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
      <TablePagination
        component="div"
        count={allRows.length}
        page={safePage}
        rowsPerPage={rowsPerPage}
        rowsPerPageOptions={[50, 100, 200, 500]}
        onPageChange={(_event, nextPage) => setPage(nextPage)}
        onRowsPerPageChange={(event) => {
          setRowsPerPage(Number(event.target.value) || 100);
          setPage(0);
        }}
        labelRowsPerPage="每页"
        labelDisplayedRows={({ from, to, count }) => `${from}-${to} / 共 ${count} 条`}
        getItemAriaLabel={(type) => (
          type === 'previous' ? '上一页' : type === 'next' ? '下一页' : type === 'first' ? '第一页' : '最后一页'
        )}
        sx={{
          width: '100%',
          minWidth: 0,
          maxWidth: '100%',
          overflowX: 'hidden',
          boxSizing: 'border-box',
          border: '1px solid #edf1f6',
          borderTop: 0,
          borderRadius: '0 0 16px 16px',
          bgcolor: '#fbfcff',
          color: '#52647f',
          '.MuiTablePagination-toolbar': {
            minWidth: 0,
            flexWrap: 'wrap',
            justifyContent: 'flex-end',
            columnGap: 0.5,
            rowGap: 0.25,
            px: 1,
          },
          '.MuiTablePagination-spacer': { display: 'none' },
          '.MuiTablePagination-selectLabel, .MuiTablePagination-displayedRows': {
            flex: '0 1 auto',
            minWidth: 0,
            my: 0,
            fontWeight: 750,
            whiteSpace: 'nowrap',
          },
          '.MuiTablePagination-actions': { flex: '0 0 auto', ml: 0 },
        }}
      />
    </Box>
  );
}
