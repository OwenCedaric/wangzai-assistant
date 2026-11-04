import { PRODUCT_PAGE_SIZE_OPTIONS } from '../../../entities/product/productLocalData.jsx';
import { productStatusTabs } from '../../../shared/ozon/ozonRuntime.jsx';
import { ReadProgressPanel } from '../../../shared/ui/ReadProgressPanel.jsx';
import { ProductTableRows } from './ProductTableRows.jsx';
import { scheduleProductRenderTask } from './progressiveProductRender.js';
import {
  isRendererTreeTelemetryEnabled,
  markRendererTreeRender,
} from '../../../app/performance/rendererTreeTelemetry.js';
import React from 'react';
import FilterAltRounded from '@mui/icons-material/FilterAltRounded';
import KeyboardArrowDownRounded from '@mui/icons-material/KeyboardArrowDownRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import SearchRounded from '@mui/icons-material/SearchRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import FormControl from '@mui/material/FormControl';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import Pagination from '@mui/material/Pagination';
import Select from '@mui/material/Select';
import Skeleton from '@mui/material/Skeleton';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

const ProductEditDialog = React.lazy(() =>
  import('../ui/ProductEditDialog.jsx').then(({ ProductEditDialog: Component }) => ({ default: Component }))
);
const ProductAdvancedFilterPopover = React.lazy(() =>
  import('../ui/ProductAdvancedFilterPopover.jsx').then(({ ProductAdvancedFilterPopover: Component }) => ({
    default: Component,
  }))
);
const ProductBatchPopover = React.lazy(() =>
  import('../ui/ProductBatchPopover.jsx').then(({ ProductBatchPopover: Component }) => ({ default: Component }))
);
const ProductBatchDialog = React.lazy(() =>
  import('../ui/ProductBatchDialog.jsx').then(({ ProductBatchDialog: Component }) => ({ default: Component }))
);
const ProductArchiveConfirmDialog = React.lazy(() =>
  import('../ui/ProductArchiveConfirmDialog.jsx').then(({ ProductArchiveConfirmDialog: Component }) => ({
    default: Component,
  }))
);

function ProductRenderTreeEnd({ metric, startedAt }) {
  markRendererTreeRender(metric, startedAt);
  return null;
}

function ProductRenderTreeBoundary({ metric, children }) {
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return (
    <>
      {children}
      <ProductRenderTreeEnd metric={metric} startedAt={startedAt} />
    </>
  );
}

function ProductDataReadyCommitTelemetry({ startedAt }) {
  React.useInsertionEffect(() => {
    markRendererTreeRender('products:data-ready-commit', startedAt);
  }, [startedAt]);
  return null;
}

export function isInitialProductDataReady({ totalRows, renderedRows, pageSize = 20, productLoadError } = {}) {
  const normalizedTotalRows = Math.max(0, Number(totalRows) || 0);
  const normalizedPageSize = Math.max(1, Number(pageSize) || 20);
  const expectedRows = Math.min(normalizedTotalRows, normalizedPageSize);
  return (
    normalizedTotalRows > 0 &&
    Number(renderedRows) === expectedRows &&
    !String(productLoadError || '').trim()
  );
}

export function ProductListPageView({ model, routeModelPreparedAt = 0 }) {
  const initialDataReadyStartedAtRef = React.useRef(
    typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
  );
  if (isRendererTreeTelemetryEnabled()) {
    markRendererTreeRender('products:view-start-delay', routeModelPreparedAt);
  }
  const {
    shops,
    activeShop,
    canReadOzon,
    shop,
    setShop,
    status,
    setStatus,
    keyword,
    setKeyword,
    loading,
    productLoadError,
    editingProduct,
    setEditingProduct,
    savingProductId,
    productNotice,
    setProductNotice,
    page,
    pageSize,
    setPageSize,
    selectedProductKeys,
    batchAnchorEl,
    setBatchAnchorEl,
    batchDialog,
    setBatchDialog,
    archiveConfirmDialog,
    batchSaving,
    advancedFilterAnchorEl,
    setAdvancedFilterAnchorEl,
    advancedFilters,
    productRefreshProgress,
    handleRefreshProducts,
    advancedFilterOpen,
    hasAdvancedFilters,
    advancedFilterGroups,
    toggleAdvancedFilterValue,
    removeAdvancedFilterValue,
    resetAdvancedFilters,
    advancedFilterChips,
    renderHeaderLabel,
    renderSortableHeader,
    visibleProductStatusCounts,
    filteredProducts,
    productPagination,
    totalPages,
    renderedPageProducts,
    pageProductKeys,
    selectedProducts,
    allPageSelected,
    pageSelectionIndeterminate,
    batchPopoverOpen,
    toggleProductSelection,
    togglePageSelection,
    handleEditProduct,
    getProductSourceRecord,
    getProductSourceSelectedSlot,
    getProductSourceLinkValue,
    selectProductSourceSlot,
    updateProductSourceLink,
    saveProductSourceLink,
    handleReadProductBusMeasurement,
    handleSaveProduct,
    handleProductArchiveAction,
    closeArchiveConfirmDialog,
    getProductArchiveOperationKey,
    pendingProductArchiveKeys,
    handleConfirmProductArchiveAction,
    activeBatchMeta,
    batchWarehouseOptions,
    batchWarehouseLoading,
    batchWarehouseError,
    archiveConfirmActionText,
    archiveConfirmProduct,
    archiveConfirmProductLabel,
    archiveConfirmSaving,
    openBatchDialog,
    handleConfirmBatchAction,
    productRefreshPercent,
    productThinProgressVisible,
    productTablePageBusy,
    handleProductPageChange,
    handleOpenOzonProductPage,
  } = model;
  const initialProductDataReady = isInitialProductDataReady({
    totalRows: productPagination.totalRows,
    renderedRows: renderedPageProducts.length,
    pageSize,
    productLoadError,
  });
  const [tableSurfaceMounted, setTableSurfaceMounted] = React.useState(false);
  React.useEffect(() => {
    if (!model.isVisible || tableSurfaceMounted) return undefined;
    return scheduleProductRenderTask(() => setTableSurfaceMounted(true));
  }, [model.isVisible, tableSurfaceMounted]);
  const expectedProductPageRows = Math.min(
    pageSize,
    Math.max(0, productPagination.totalRows - (page - 1) * pageSize),
  );
  const reservedProductPageRows = productPagination.totalRows > 0
    ? expectedProductPageRows
    : loading || productTablePageBusy
      ? pageSize
      : 0;
  const reservedProductTableHeight = 38 + reservedProductPageRows * 108;

  const content = (
    <>
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        alignItems={{ xs: 'stretch', md: 'center' }}
        justifyContent="space-between"
        spacing={2}
        mb={3}
      >
        <Box>
          <Typography variant="h4">商品列表</Typography>
          <Typography color="text.secondary" mt={0.75}>
            管理商品基础信息、库存状态、价格和利润表现
          </Typography>
        </Box>
        <Stack spacing={0.75} alignItems={{ xs: 'stretch', md: 'flex-end' }} className="hero-actions">
          <Stack direction="row" spacing={1}>
            <Button
              variant={hasAdvancedFilters ? 'contained' : 'outlined'}
              startIcon={<FilterAltRounded />}
              onClick={(event) => setAdvancedFilterAnchorEl(event.currentTarget)}
            >
              高级筛选
            </Button>
            <Button
              variant="contained"
              startIcon={<RefreshRounded />}
              disabled={loading || productRefreshProgress.blocking}
              onClick={handleRefreshProducts}
            >
              {productRefreshProgress.blocking ? '提交中' : loading ? '读取中' : '刷新商品'}
            </Button>
          </Stack>
          <ReadProgressPanel
            visible={productThinProgressVisible || loading || productTablePageBusy}
            running={productRefreshProgress.running || loading || productTablePageBusy}
            message={productRefreshProgress.message || (productTablePageBusy ? '正在读取商品列表' : '')}
            completed={productRefreshProgress.completed}
            total={productRefreshProgress.total}
            errors={productRefreshProgress.errors}
            percent={productRefreshPercent}
            ariaLabel="商品读取进度"
          />
        </Stack>
      </Stack>

      <Card className="product-status-card">
        <CardContent>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ xs: 'stretch', md: 'center' }}>
            <Box>
              <Typography variant="h6">商品状态</Typography>
              <Typography variant="body2" color="text.secondary">
                按状态快速查看商品列表
              </Typography>
            </Box>
            <Box className="status-tab-grid">
              {productStatusTabs.map((tab) => {
                const count = visibleProductStatusCounts[tab.label] ?? 0;
                const active = status === tab.label;
                return (
                  <Box
                    key={tab.label}
                    component="button"
                    type="button"
                    className={`status-tab status-${tab.tone}${active ? ' active' : ''}`}
                    onClick={() => setStatus(tab.label)}
                  >
                    <span>{tab.label}</span>
                    {loading && count === 0 ? (
                      <Skeleton
                        animation={false}
                        className="status-count-skeleton"
                        variant="rounded"
                        width={34}
                        height={28}
                      />
                    ) : (
                      <strong>{count}</strong>
                    )}
                  </Box>
                );
              })}
            </Box>
          </Stack>
        </CardContent>
      </Card>
      {tableSurfaceMounted ? (
      <Card className="product-table-card">
        <CardContent>
          <Stack
            direction={{ xs: 'column', lg: 'row' }}
            alignItems={{ xs: 'stretch', lg: 'center' }}
            justifyContent="space-between"
            spacing={1.5}
            mb={2}
          >
            <Box>
              <Typography variant="h6">商品明细</Typography>
            </Box>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} className="table-actions">
              <TextField
                size="small"
                placeholder="搜索货号 / 商品 / 类目"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchRounded />
                    </InputAdornment>
                  ),
                }}
              />
              <FormControl size="small" className="filter-select">
                <Select value={shop} onChange={(event) => setShop(event.target.value)}>
                  <MenuItem value="all">全部店铺</MenuItem>
                  {shops.map((item) => (
                    <MenuItem key={item.id} value={item.id}>
                      {item.shopAlias || item.sellerName || 'Ozon 店铺'}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl size="small" className="filter-select">
                <Select value={status} onChange={(event) => setStatus(event.target.value)}>
                  {productStatusTabs.map((tab) => (
                    <MenuItem key={tab.label} value={tab.label}>
                      {tab.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Stack>
          </Stack>

          {advancedFilterChips.length ? (
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap mb={2}>
              <Typography variant="body2" color="text.secondary" fontWeight={700}>
                筛选：
              </Typography>
              {advancedFilterChips.map((chip) => (
                <Chip
                  key={chip.key}
                  size="small"
                  label={chip.label}
                  onDelete={() => removeAdvancedFilterValue(chip.filterKey, chip.value)}
                  variant="outlined"
                />
              ))}
              <Button size="small" onClick={resetAdvancedFilters}>
                清空
              </Button>
            </Stack>
          ) : null}

          <Box className="product-list-bulk-row">
            <Stack direction="row" spacing={1} alignItems="center" className="product-list-selection-actions">
              <Button
                variant="outlined"
                className="product-select-page-button"
                onClick={togglePageSelection}
                disabled={pageProductKeys.length === 0 || Boolean(savingProductId)}
              >
                <Checkbox
                  size="small"
                  checked={allPageSelected}
                  indeterminate={pageSelectionIndeterminate}
                  tabIndex={-1}
                  disableRipple
                />
                全选本页
              </Button>
              <Typography variant="body2" color="text.secondary">
                已选 {selectedProducts.length} / 本页 {renderedPageProducts.length}
              </Typography>
              <Button
                variant="outlined"
                className="product-batch-button"
                endIcon={<KeyboardArrowDownRounded />}
                disabled={selectedProducts.length === 0 || Boolean(savingProductId)}
                onClick={(event) => setBatchAnchorEl(event.currentTarget)}
              >
                批量操作
              </Button>
            </Stack>
            <Stack direction="row" spacing={1} alignItems="center" className="product-list-pagination-controls">
              <FormControl size="small" className="product-page-size-select">
                <Select
                  value={pageSize}
                  onChange={(event) => setPageSize(Number(event.target.value))}
                  renderValue={(value) => `每页 ${value}`}
                >
                  {PRODUCT_PAGE_SIZE_OPTIONS.map((option) => (
                    <MenuItem key={option} value={option}>
                      {option} 条
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <Typography variant="body2" color="text.secondary">
                共 {productPagination.totalRows} 条
              </Typography>
              <Pagination
                className="product-list-pagination"
                count={totalPages}
                page={page}
                onChange={handleProductPageChange}
                shape="rounded"
                siblingCount={1}
                boundaryCount={1}
              />
            </Stack>
          </Box>

          <TableContainer
            className="wide-table-container"
            style={{ minHeight: `${reservedProductTableHeight}px` }}
          >
            <Table className="data-table product-list-table">
              <colgroup>
                <col className="product-col-select" />
                <col className="product-col-name" />
                <col className="product-col-offer" />
                <col className="product-col-category" />
                <col className="product-col-shop" />
                <col className="product-col-price" />
                <col className="product-col-stock" />
                <col className="product-col-fee" />
                <col className="product-col-profit" />
                <col className="product-col-weight" />
                <col className="product-col-status" />
                <col className="product-col-actions" />
              </colgroup>
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox" className="product-list-head-cell product-list-head-select"></TableCell>
                  <TableCell className="product-list-head-cell">{renderHeaderLabel('商品名')}</TableCell>
                  <TableCell className="product-list-head-cell">{renderHeaderLabel('货号')}</TableCell>
                  <TableCell className="product-list-head-cell">{renderHeaderLabel('类目')}</TableCell>
                  <TableCell className="product-list-head-cell">{renderHeaderLabel('店铺名')}</TableCell>
                  <TableCell className="product-list-head-cell">{renderSortableHeader('price', '售价')}</TableCell>
                  <TableCell className="product-list-head-cell">{renderSortableHeader('stock', '库存')}</TableCell>
                  <TableCell className="product-list-head-cell">{renderSortableHeader('fee', '佣金/费用')}</TableCell>
                  <TableCell className="product-list-head-cell">{renderSortableHeader('profit', '预估利润')}</TableCell>
                  <TableCell className="product-list-head-cell">{renderSortableHeader('weight', '产品重量')}</TableCell>
                  <TableCell className="product-list-head-cell">{renderSortableHeader('status', '状态')}</TableCell>
                  <TableCell className="product-list-head-cell">{renderHeaderLabel('操作')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                <ProductTableRows
                  products={renderedPageProducts}
                  renderEnabled={model.isVisible}
                  selectedProductKeys={selectedProductKeys}
                  toggleProductSelection={toggleProductSelection}
                  savingProductId={savingProductId}
                  getProductSourceLinkValue={getProductSourceLinkValue}
                  getProductSourceRecord={getProductSourceRecord}
                  getProductSourceSelectedSlot={getProductSourceSelectedSlot}
                  selectProductSourceSlot={selectProductSourceSlot}
                  updateProductSourceLink={updateProductSourceLink}
                  saveProductSourceLink={saveProductSourceLink}
                  getProductArchiveOperationKey={getProductArchiveOperationKey}
                  pendingProductArchiveKeys={pendingProductArchiveKeys}
                  canReadOzon={canReadOzon}
                  handleEditProduct={handleEditProduct}
                  handleProductArchiveAction={handleProductArchiveAction}
                  handleOpenOzonProductPage={handleOpenOzonProductPage}
                />
                {!loading && productLoadError ? (
                  <TableRow>
                    <TableCell colSpan={12}>
                      <Typography variant="body2" color="warning.main" align="center">
                        {productLoadError}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ) : null}
                {!productTablePageBusy && !productLoadError && filteredProducts.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={12}>
                      <Typography variant="body2" color="text.secondary" align="center">
                        没有匹配的商品
                      </Typography>
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>
      ) : (
        <div className="product-table-card product-table-card-deferred" aria-busy="true">
          <strong>商品明细</strong>
        </div>
      )}
      {advancedFilterOpen ? (
        <React.Suspense fallback={null}>
          <ProductAdvancedFilterPopover
            open
            anchorEl={advancedFilterAnchorEl}
            onClose={() => setAdvancedFilterAnchorEl(null)}
            groups={advancedFilterGroups}
            filters={advancedFilters}
            onToggleValue={toggleAdvancedFilterValue}
            onReset={resetAdvancedFilters}
          />
        </React.Suspense>
      ) : null}
      {batchPopoverOpen ? (
        <React.Suspense fallback={null}>
          <ProductBatchPopover
            open
            anchorEl={batchAnchorEl}
            onClose={() => setBatchAnchorEl(null)}
            selectedCount={selectedProducts.length}
            onOpenDialog={openBatchDialog}
          />
        </React.Suspense>
      ) : null}
      {batchDialog.open ? (
        <React.Suspense fallback={null}>
          <ProductBatchDialog
            open
            batchDialog={batchDialog}
            activeBatchMeta={activeBatchMeta}
            selectedCount={selectedProducts.length}
            batchSaving={batchSaving}
            batchWarehouseLoading={batchWarehouseLoading}
            batchWarehouseError={batchWarehouseError}
            batchWarehouseOptions={batchWarehouseOptions}
            onChangeDialog={setBatchDialog}
            onClose={setBatchDialog}
            onConfirm={handleConfirmBatchAction}
          />
        </React.Suspense>
      ) : null}
      {archiveConfirmDialog.open ? (
        <React.Suspense fallback={null}>
          <ProductArchiveConfirmDialog
            open
            action={archiveConfirmDialog.action}
            actionText={archiveConfirmActionText}
            product={archiveConfirmProduct}
            productLabel={archiveConfirmProductLabel}
            saving={archiveConfirmSaving}
            onClose={closeArchiveConfirmDialog}
            onConfirm={handleConfirmProductArchiveAction}
          />
        </React.Suspense>
      ) : null}
      {editingProduct ? (
        <React.Suspense fallback={null}>
          <ProductEditDialog
            open
            product={editingProduct}
            shop={activeShop}
            saving={Boolean(savingProductId)}
            onClose={() => {
              if (!savingProductId) setEditingProduct(null);
            }}
            onSave={handleSaveProduct}
            onReadBus={handleReadProductBusMeasurement}
          />
        </React.Suspense>
      ) : null}
      <Snackbar
        open={productNotice.open}
        autoHideDuration={4200}
        onClose={() => setProductNotice((current) => ({ ...current, open: false }))}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <Alert
          severity={productNotice.severity}
          variant="filled"
          onClose={() => setProductNotice((current) => ({ ...current, open: false }))}
        >
          {productNotice.message}
        </Alert>
      </Snackbar>
      {initialProductDataReady ? (
        <ProductDataReadyCommitTelemetry startedAt={initialDataReadyStartedAtRef.current} />
      ) : null}
    </>
  );
  if (!isRendererTreeTelemetryEnabled()) return content;
  return <ProductRenderTreeBoundary metric="products:page-view">{content}</ProductRenderTreeBoundary>;
}
