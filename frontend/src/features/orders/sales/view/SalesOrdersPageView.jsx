import {
  formatOzonOrderDate,
  getOzonShopLabel,
} from '../../../../entities/order/orderShopScope.jsx';
import { getCrossBorderReadStatusDisplay } from '../../../../entities/order/crossBorderOrderApi.jsx';
import { getSalesOrderRecordKey } from '../../../../entities/order/orderRecordRules.jsx';
import { SourceLinkDropdownField } from '../../../../entities/order/orderSourceLinkFields.jsx';
import { SALES_ORDER_PAGE_SIZE_OPTIONS } from '../../../../shared/config/appConfigCore.jsx';
import { LazyHoverImagePreview } from '../../../../shared/ui/ImagePreview.jsx';
import { ReadProgressPanel } from '../../../../shared/ui/ReadProgressPanel.jsx';
import { salesOrderStatusTabs } from '../../../../entities/order/orderStatusRules.jsx';
import { SalesOrderProductImagePreview } from '../ui/SalesOrderProductImagePreview.jsx';
import { OzonProductWorkbench } from '../../purchase/components/OzonProductWorkbench.jsx';
import CalendarMonthRounded from '@mui/icons-material/CalendarMonthRounded';
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import SearchRounded from '@mui/icons-material/SearchRounded';
import SyncRounded from '@mui/icons-material/SyncRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import FormControl from '@mui/material/FormControl';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import Pagination from '@mui/material/Pagination';
import Popover from '@mui/material/Popover';
import Select from '@mui/material/Select';
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
import React from 'react';

const SalesOrderOperationDialog = React.lazy(() =>
  import('./SalesOrderOperationDialog.jsx').then((module) => ({ default: module.SalesOrderOperationDialog }))
);

function splitSalesOrderPaymentTime(value = '') {
  const text = String(value || '').trim() || '未返回';
  const match = text.match(/^(\d{4}[/-]\d{2}[/-]\d{2})(?:\s+(.+))?$/u);
  if (!match) return { date: text, time: '' };
  return { date: match[1], time: match[2] || '' };
}

export function SalesOrdersPageView({ model }) {
  const {
    viewTitle,
    viewDescription,
    readableShops,
    paymentStartDate,
    setPaymentStartDate,
    paymentEndDate,
    setPaymentEndDate,
    paymentDateAnchorEl,
    setPaymentDateAnchorEl,
    orderSync,
    salesOrderRefreshProgress,
    status,
    setStatus,
    shop,
    setShop,
    fulfillment,
    setFulfillment,
    keyword,
    setKeyword,
    salesOrderPageSize,
    setSalesOrderPageSize,
    setSalesOrderPage,
    setSelectedOrderId,
    selectedSalesOrderKeys,
    salesSupplementErrorText,
    salesNotice,
    setSalesNotice,
    salesOperation,
    paymentDateOpen,
    paymentDateText,
    filteredOrderTotal,
    salesOrderStatusCounts,
    salesOrderTotalPages,
    currentSalesOrderPage,
    visibleOrders,
    salesOrderRangeStart,
    salesOrderRangeEnd,
    visibleSalesOrderKeys,
    selectedSalesOrderCount,
    selectionLoading,
    allSalesOrderPageSelected,
    salesOrderPageSelectionIndeterminate,
    selectedCancellableOrders,
    selectedShippableOrders,
    handleRefreshSalesOrders,
    logisticsSync,
    handleSyncLogistics,
    resetSalesOrderListState,
    toggleSalesOrderSelection,
    toggleSalesOrderPageSelection,
    selectAllFilteredSalesOrders,
    clearSalesOrderSelection,
    selectedOrder,
    detailOrder,
    getSourceLinkRecord,
    getSourceSelectedSlot,
    getSourceLinkValue,
    detailSourceLink,
    detailSourceEntry,
    selectSourceSlot,
    updateSourceLink,
    saveSourceLink,
    detailCrossBorderInfo,
    detailPurchaseInfoSupport,
    openSalesPurchaseInfoWorkbench,
    openSalesOperation,
    openSalesBatchOperation,
    closeSalesOperation,
    updateSalesCancelReason,
    updateSalesSplitPackageQuantity,
    addSalesSplitPackage,
    removeSalesSplitPackage,
    executeSalesOperation,
    operationMeta,
    detailSplitLocked,
    detailSplitLockReason,
    canCancelDetailOrder,
    canShipDetailOrder,
    canSplitDetailOrder,
    operationOrders,
    isSplitSalesOperation,
    splitOperationOrder,
    splitPackages,
    splitValidation,
    canSubmitSalesOperation,
    salesOrderPartialErrorText,
    sideOrderSearch,
    stats,
    salesOzonProductWorkbench,
    openSalesOzonProductPage,
    openSalesPurchaseLink,
  } = model;
  // Keep the summary and controls interactive while React commits the richer current-page rows.
  // The data set remains the same SQLite page; only the non-essential row paint is interruptible.
  const renderedVisibleOrders = React.useDeferredValue(visibleOrders);
  const salesOrderSyncRunning = Boolean(orderSync.loading || orderSync.refreshing);
  const salesOrderCachedRows = Number(orderSync.data?.rows?.length) || 0;
  const salesOrderProgressMessage = orderSync.refreshing
    ? salesOrderRefreshProgress?.message || `后台正在同步 Ozon 销售订单，当前缓存 ${salesOrderCachedRows} 条`
    : salesOrderCachedRows > 0
      ? `正在读取 Ozon 销售订单，当前缓存 ${salesOrderCachedRows} 条`
      : '正在读取 Ozon 销售订单';
  const detailFirstProduct = detailOrder?.products?.[0] ?? {};
  const detailSourceImage =
    detailPurchaseInfoSupport?.sourceImage ||
    detailSourceEntry?.image ||
    detailSourceEntry?.imageUrl ||
    detailFirstProduct.sourceImage ||
    detailFirstProduct.image ||
    detailFirstProduct.imageUrl ||
    '';
  const detailPaymentTime = detailOrder?.paymentTime || '未返回';
  const detailPaymentAmount = detailOrder?.amount || '未返回';
  const detailSourceLinkText =
    detailPurchaseInfoSupport?.sourceLink || detailSourceLink || detailSourceEntry?.link || '未返回';
  const detailSourceLinkHref = /^https?:\/\//i.test(detailSourceLinkText) ? detailSourceLinkText : '';
  const detailSourceQty = String(detailPurchaseInfoSupport?.qty || detailFirstProduct.qty || '1').trim();
  const detailSourceQtyText = /^x/i.test(detailSourceQty) ? detailSourceQty : `x${detailSourceQty || 1}`;

  return (
    <>
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        alignItems={{ xs: 'stretch', md: 'center' }}
        justifyContent="space-between"
        spacing={2}
        mb={3}
      >
        <Box>
          <Typography variant="h4">{viewTitle}</Typography>
          <Typography color="text.secondary" mt={0.75}>
            {viewDescription}
          </Typography>
        </Box>
        <Stack spacing={0.75} alignItems={{ xs: 'stretch', md: 'flex-end' }} className="hero-actions">
          <Stack direction="row" spacing={1}>
            <Button
              variant="outlined"
              startIcon={<SyncRounded />}
              onClick={handleSyncLogistics}
              disabled={logisticsSync.running || salesOrderSyncRunning}
            >
              {logisticsSync.running ? '同步中' : '同步物流'}
            </Button>
            <Button
              variant="contained"
              startIcon={<RefreshRounded />}
              onClick={handleRefreshSalesOrders}
              disabled={!readableShops.length || salesOrderSyncRunning}
            >
              {salesOrderSyncRunning ? '读取中' : '刷新订单'}
            </Button>
          </Stack>
          <ReadProgressPanel
            visible={salesOrderSyncRunning}
            running={salesOrderSyncRunning}
            message={salesOrderProgressMessage}
            completed={salesOrderRefreshProgress?.completed}
            total={salesOrderRefreshProgress?.total}
            errors={salesOrderRefreshProgress?.errors}
            ariaLabel="销售订单读取进度"
          />
        </Stack>
      </Stack>

      <Box className="sales-order-stat-grid">
        {stats.map((item) => (
          <Card key={item.title} className={`order-preview-card preview-${item.tone}`}>
            <CardContent>
              <Typography variant="body2" color="text.secondary">
                {item.title}
              </Typography>
              <Typography variant="h5" mt={0.5}>
                {item.value}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {item.hint}
              </Typography>
            </CardContent>
          </Card>
        ))}
      </Box>

      <Card className="sales-order-filter-card">
        <CardContent>
          <Stack direction={{ xs: 'column', xl: 'row' }} spacing={1.5} alignItems={{ xs: 'stretch', xl: 'center' }}>
            <Box className="sales-order-filter-copy">
              <Typography variant="h6">订单状态</Typography>
              <Typography variant="body2" color="text.secondary">
                按履约节点快速查看订单
              </Typography>
            </Box>
            <Box className="sales-order-status-grid">
              {salesOrderStatusTabs.map((tab) => {
                const count = salesOrderStatusCounts[tab.value] ?? 0;
                return (
                  <Box
                    key={tab.value}
                    component="button"
                    type="button"
                    className={`status-tab status-${tab.tone}${status === tab.value ? ' active' : ''}`}
                    onClick={() => {
                      setStatus(tab.value);
                      resetSalesOrderListState();
                    }}
                  >
                    <span>{tab.label}</span>
                    <strong>{count}</strong>
                  </Box>
                );
              })}
            </Box>
          </Stack>
        </CardContent>
      </Card>

      <Box className="sales-orders-layout">
        <Card className="sales-orders-table-card">
          <CardContent>
            <Box className="sales-order-table-head">
              <Box className="sales-order-table-title">
                <Typography variant="h6">订单列表</Typography>
                <Typography variant="body2" color="text.secondary">
                  {orderSync.data?.fetchedAt
                    ? `已同步 ${formatOzonOrderDate(orderSync.data.fetchedAt)}`
                    : '等待读取 Ozon 订单'}
                </Typography>
              </Box>
              <Box className="sales-order-filter-toolbar">
                <TextField
                  size="small"
                  className="sales-order-search-field"
                  placeholder="搜索单号 / 货号 / SKU"
                  value={keyword}
                  onChange={(event) => {
                    setKeyword(event.target.value);
                    resetSalesOrderListState();
                  }}
                  InputProps={{
                    startAdornment: (
                      <InputAdornment position="start">
                        <SearchRounded />
                      </InputAdornment>
                    ),
                  }}
                />
                <FormControl size="small" className="filter-select sales-order-filter-select">
                  <Select
                    value={shop}
                    onChange={(event) => {
                      setShop(event.target.value);
                      resetSalesOrderListState();
                    }}
                  >
                    <MenuItem value="all">全部店铺</MenuItem>
                    {readableShops.map((item) => (
                      <MenuItem key={item.id} value={item.id}>
                        {getOzonShopLabel(item)}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <FormControl size="small" className="filter-select sales-order-filter-select">
                  <Select
                    value={fulfillment}
                    onChange={(event) => {
                      setFulfillment(event.target.value);
                      resetSalesOrderListState();
                    }}
                  >
                    <MenuItem value="all">全部履约</MenuItem>
                    <MenuItem value="FBS">FBS</MenuItem>
                    <MenuItem value="FBO">FBO</MenuItem>
                    <MenuItem value="rFBS">rFBS</MenuItem>
                  </Select>
                </FormControl>
                <Box
                  component="button"
                  type="button"
                  className={`sales-date-range-filter sales-date-range-trigger${paymentStartDate || paymentEndDate ? ' has-value' : ''}`}
                  onClick={(event) => setPaymentDateAnchorEl(event.currentTarget)}
                >
                  <Typography component="span" className="sales-date-range-label">
                    付款时间
                  </Typography>
                  <Typography component="span" className="sales-date-range-value">
                    {paymentDateText}
                  </Typography>
                  <CalendarMonthRounded className="sales-date-icon" />
                </Box>
                <Popover
                  open={paymentDateOpen}
                  anchorEl={paymentDateAnchorEl}
                  onClose={() => setPaymentDateAnchorEl(null)}
                  anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                  transformOrigin={{ vertical: 'top', horizontal: 'right' }}
                  PaperProps={{ className: 'sales-date-popover' }}
                >
                  <Box className="sales-date-popover-content">
                    <TextField
                      size="small"
                      type="date"
                      label="开始日期"
                      value={paymentStartDate}
                      onChange={(event) => {
                        setPaymentStartDate(event.target.value);
                        resetSalesOrderListState();
                      }}
                      inputProps={{ onKeyDown: (event) => event.preventDefault() }}
                      InputLabelProps={{ shrink: true }}
                    />
                    <TextField
                      size="small"
                      type="date"
                      label="结束日期"
                      value={paymentEndDate}
                      onChange={(event) => {
                        setPaymentEndDate(event.target.value);
                        resetSalesOrderListState();
                      }}
                      inputProps={{ onKeyDown: (event) => event.preventDefault() }}
                      InputLabelProps={{ shrink: true }}
                    />
                    <Box className="sales-date-popover-actions">
                      <Button
                        size="small"
                        variant="text"
                        onClick={() => {
                          setPaymentStartDate('');
                          setPaymentEndDate('');
                          resetSalesOrderListState();
                        }}
                      >
                        清空时间
                      </Button>
                      <Button size="small" variant="contained" onClick={() => setPaymentDateAnchorEl(null)}>
                        完成
                      </Button>
                    </Box>
                  </Box>
                </Popover>
              </Box>
            </Box>
            {orderSync.error ? (
              <Alert severity="warning" className="order-sync-alert">
                {String(orderSync.error?.message || orderSync.error)}
                {orderSync.stale ? '；当前暂时保留上一次成功读取的数据。' : ''}
              </Alert>
            ) : null}
            {salesOrderPartialErrorText ? (
              <Alert severity="info" className="order-sync-alert">
                部分接口失败：{salesOrderPartialErrorText}，已展示成功读取的数据。
              </Alert>
            ) : null}
            {salesSupplementErrorText ? (
              <Alert severity="info" className="order-sync-alert">
                当前页补充信息未完全返回：{salesSupplementErrorText}，订单基础信息已优先展示。
              </Alert>
            ) : null}

            <Box className="sales-order-selection-bar">
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                <Typography variant="body2" className="sales-order-selection-count">
                  已选 {selectedSalesOrderCount} 个
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {selectedSalesOrderCount === filteredOrderTotal && filteredOrderTotal > visibleOrders.length
                    ? `已选择当前筛选条件下全部 ${filteredOrderTotal} 个订单`
                    : `本页 ${visibleOrders.length} 条 / 当前筛选 ${filteredOrderTotal} 条`}
                </Typography>
                <Button
                  size="small"
                  variant="contained"
                  onClick={toggleSalesOrderPageSelection}
                  disabled={!visibleSalesOrderKeys.length}
                >
                  {allSalesOrderPageSelected ? '取消本页' : '全选本页'}
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={selectAllFilteredSalesOrders}
                  disabled={!filteredOrderTotal || selectedSalesOrderCount === filteredOrderTotal || selectionLoading}
                >
                  {selectionLoading ? '正在选择所有页…' : '全选所有页'}
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={clearSalesOrderSelection}
                  disabled={!selectedSalesOrderCount}
                >
                  清空
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  color="error"
                  onClick={() => openSalesBatchOperation('batchCancel', selectedCancellableOrders)}
                  disabled={!selectedCancellableOrders.length || salesOperation.loading}
                >
                  批量取消
                </Button>
                <Button
                  size="small"
                  variant="contained"
                  onClick={() => openSalesBatchOperation('batchShip', selectedShippableOrders)}
                  disabled={!selectedShippableOrders.length || salesOperation.loading}
                >
                  批量发货
                </Button>
              </Stack>
              <Typography variant="caption" color="text.secondary">
                只渲染当前页，打开更快
              </Typography>
            </Box>

            <TableContainer className="wide-table-container">
              <Table className="data-table sales-orders-table">
                <colgroup>
                  <col className="sales-order-col-select" />
                  <col className="sales-order-col-card" />
                  <col className="sales-order-col-order" />
                  <col className="sales-order-col-product" />
                  <col className="sales-order-col-shop" />
                  <col className="sales-order-col-commission" />
                  <col className="sales-order-col-amount" />
                  <col className="sales-order-col-status" />
                  <col className="sales-order-col-payment" />
                </colgroup>
                <TableHead>
                  <TableRow>
                    <TableCell padding="checkbox" className="sales-order-select-cell">
                      <Checkbox
                        size="small"
                        checked={allSalesOrderPageSelected}
                        indeterminate={salesOrderPageSelectionIndeterminate}
                        onChange={toggleSalesOrderPageSelection}
                        disabled={!visibleSalesOrderKeys.length}
                      />
                    </TableCell>
                    <TableCell align="center" className="sales-order-card-head-cell">
                      名片
                    </TableCell>
                    <TableCell>订单</TableCell>
                    <TableCell>商品</TableCell>
                    <TableCell align="center">店铺</TableCell>
                    <TableCell align="center">佣金</TableCell>
                    <TableCell align="center">金额</TableCell>
                    <TableCell align="center">状态</TableCell>
                    <TableCell align="center">付款时间</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {renderedVisibleOrders.map((order) => {
                    const firstProduct = order.products?.[0] ?? {};
                    const orderKey = getSalesOrderRecordKey(order);
                    const sourceLink = getSourceLinkValue(order);
                    const sourceRecord = getSourceLinkRecord(order);
                    const sourceSlot = getSourceSelectedSlot(order);
                    const paymentTimeParts = splitSalesOrderPaymentTime(order.paymentTime);
                    return (
                      <TableRow
                        key={getSalesOrderRecordKey(order)}
                        hover
                        className={
                          getSalesOrderRecordKey(selectedOrder) === getSalesOrderRecordKey(order) ? 'selected-row' : ''
                        }
                        onClick={() => {
                          setSelectedOrderId(getSalesOrderRecordKey(order));
                        }}
                      >
                        <TableCell
                          padding="checkbox"
                          className="sales-order-select-cell"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <Checkbox
                            size="small"
                            checked={selectedSalesOrderKeys.has(getSalesOrderRecordKey(order))}
                            onChange={() => toggleSalesOrderSelection(order)}
                          />
                        </TableCell>
                        <TableCell
                          key={`${orderKey}-card`}
                          align="center"
                          className="sales-order-card-cell"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <SalesOrderProductImagePreview order={order} />
                        </TableCell>
                        <TableCell className="sales-order-identity-cell">
                          <Typography variant="subtitle1" noWrap title={order.id}>
                            {order.id}
                          </Typography>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            display="block"
                            noWrap
                            title={`货号: ${firstProduct.offerId || order.sku || '未返回'}`}
                          >
                            货号: {firstProduct.offerId || order.sku || '未返回'}
                          </Typography>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            display="block"
                            noWrap
                            title={`SKU ID: ${firstProduct.skuId || '未返回'}`}
                          >
                            SKU ID: {firstProduct.skuId || '未返回'}
                          </Typography>
                        </TableCell>
                        <TableCell colSpan={2} className="sales-order-product-shop-cell">
                          <Box className="sales-order-product-shop-grid">
                            <Box className="sales-order-product-copy">
                              <Typography
                                component="button"
                                type="button"
                                variant="subtitle1"
                                className="sales-order-product-title ozon-product-title-button"
                                noWrap
                                title={`${order.product}｜打开 Ozon 商品页面`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  openSalesOzonProductPage(order, firstProduct);
                                }}
                              >
                                {order.product}
                              </Typography>
                              <Typography variant="caption" color="text.secondary" display="block">
                                订单数量: {order.items} 件
                              </Typography>
                            </Box>
                            <Typography
                              variant="body2"
                              className="sales-order-shop-value"
                              noWrap
                              title={order.shop}
                            >
                              {order.shop}
                            </Typography>
                            <Box
                              className="sales-source-link-row compact-source-link-row"
                              onClick={(event) => event.stopPropagation()}
                            >
                              <SourceLinkDropdownField
                                className="sales-source-link-input compact-source-link-input"
                                placeholder="粘贴货源链接"
                                value={sourceLink}
                                record={sourceRecord}
                                selectedIndex={sourceSlot}
                                onSelectSlot={(index) => selectSourceSlot(order, index)}
                                onChange={(value, slotIndex, sourceEntry) =>
                                  updateSourceLink(order, value, slotIndex, sourceEntry)
                                }
                              />
                              <Button
                                size="small"
                                variant="contained"
                                className="sales-source-save-button compact-source-save-button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  saveSourceLink(order);
                                }}
                                aria-label="保存货源"
                                title="保存货源"
                              >
                                保存
                              </Button>
                            </Box>
                          </Box>
                        </TableCell>
                        <TableCell align="center">
                          <Box className="sales-order-commission-cell">
                            <Chip
                              size="small"
                              label={order.commissionMode || 'rFBS'}
                              variant="outlined"
                              className="sales-order-fulfillment-chip"
                            />
                            <Typography variant="caption" color="text.secondary">
                              比例 {order.commissionPercent}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              金额 {order.commissionAmount}
                            </Typography>
                          </Box>
                        </TableCell>
                        <TableCell align="center" className="sales-order-amount-cell">
                          {order.amount}
                        </TableCell>
                        <TableCell align="center" className="sales-order-status-cell">
                          <Chip size="small" color={order.tone} label={order.status} variant="outlined" />
                        </TableCell>
                        <TableCell align="center" className="sales-order-time-cell">
                          <Box className="sales-order-time-stack" title={order.paymentTime || '未返回'}>
                            <span className="sales-order-time-date">{paymentTimeParts.date}</span>
                            {paymentTimeParts.time ? (
                              <span className="sales-order-time-clock">{paymentTimeParts.time}</span>
                            ) : null}
                          </Box>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {!orderSync.loading && filteredOrderTotal === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9}>
                        <Typography variant="body2" color="text.secondary" align="center">
                          {readableShops.length ? '暂未读取到符合条件的 Ozon 订单' : '请先在设置里配置 Ozon 店铺'}
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </TableContainer>
            {filteredOrderTotal > 0 ? (
              <Box className="sales-order-pagination">
                <Box className="sales-order-pagination-summary">
                  <Typography variant="body2" color="text.secondary">
                    共 {filteredOrderTotal} 条
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {salesOrderRangeStart}-{salesOrderRangeEnd}
                  </Typography>
                </Box>
                <Box className="sales-order-pagination-controls">
                  <Typography variant="body2" color="text.secondary">
                    每页
                  </Typography>
                  <FormControl size="small" className="sales-order-page-size-select">
                    <Select
                      value={String(salesOrderPageSize)}
                      onChange={(event) => {
                        setSalesOrderPageSize(Number(event.target.value));
                        setSalesOrderPage(1);
                      }}
                    >
                      {SALES_ORDER_PAGE_SIZE_OPTIONS.map((size) => (
                        <MenuItem key={size} value={String(size)}>
                          {size} / 页
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  <Pagination
                    size="small"
                    shape="rounded"
                    page={currentSalesOrderPage}
                    count={salesOrderTotalPages}
                    siblingCount={1}
                    boundaryCount={1}
                    onChange={(_, value) => {
                      setSalesOrderPage(value);
                    }}
                  />
                </Box>
              </Box>
            ) : null}
          </CardContent>
        </Card>

        <Box className="purchase-order-side-panel sales-order-side-panel" data-order-follow-panel="true">
          {sideOrderSearch}
          <Card className="purchase-order-detail-card sales-order-detail-card">
            <CardContent className="purchase-detail-content sales-detail-content">
              <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1.5} mb={2}>
                <Box>
                  <Typography variant="h6">订单详情</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {detailOrder?.id ?? '未选择订单'}
                  </Typography>
                </Box>
                {detailOrder ? (
                  <Chip size="small" color={detailOrder.tone} label={detailOrder.status} variant="outlined" />
                ) : null}
              </Stack>

              {detailOrder ? (
                <>
                  <Box className="detail-info-grid">
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        买家
                      </Typography>
                      <Typography variant="subtitle1">{detailOrder.buyer}</Typography>
                    </Box>
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        店铺
                      </Typography>
                      <Typography variant="subtitle1">{detailOrder.shop}</Typography>
                    </Box>
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        渠道
                      </Typography>
                      <Typography variant="subtitle1">{detailOrder.channel}</Typography>
                    </Box>
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        物流
                      </Typography>
                      <Typography variant="subtitle1">{detailOrder.logistics}</Typography>
                    </Box>
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        付款时间
                      </Typography>
                      <Typography variant="subtitle1">{detailPaymentTime}</Typography>
                    </Box>
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        付款金额
                      </Typography>
                      <Typography variant="subtitle1">{detailPaymentAmount}</Typography>
                    </Box>
                  </Box>

                  <Divider sx={{ my: 2 }} />

                  <Typography variant="subtitle1" mb={1}>
                    货源成本
                  </Typography>
                  <Stack spacing={1}>
                    {detailOrder.products.slice(0, 1).map((product) => (
                      <Box key={product.sku} className="detail-product-row sales-source-cost-row">
                        <Box className="detail-product-main">
                          <LazyHoverImagePreview
                            className="detail-product-image-hover sales-order-image-hover"
                            previewClassName="sales-order-image-preview"
                            imageUrl={detailSourceImage}
                            alt={detailPurchaseInfoSupport.sourceTitle || product.name || '货源图片'}
                          >
                            {detailSourceImage ? (
                              <Box
                                component="img"
                                src={detailSourceImage}
                                alt={detailPurchaseInfoSupport.sourceTitle || product.name || '货源图片'}
                                className="detail-product-thumb"
                                referrerPolicy="no-referrer"
                              />
                            ) : (
                              <Box className="detail-product-thumb detail-product-thumb-empty">
                                <Inventory2Rounded fontSize="small" />
                              </Box>
                            )}
                          </LazyHoverImagePreview>
                          <Box className="product-source-panel sales-source-readonly-panel">
                            <Box className="product-source-head">
                              <Typography
                                variant="subtitle1"
                                className="detail-product-name"
                                noWrap
                                title={detailPurchaseInfoSupport.sourceTitle || product.name || '未返回'}
                              >
                                {detailPurchaseInfoSupport.sourceTitle || product.name || '未返回'}
                              </Typography>
                            </Box>
                            <Box className="sales-source-readonly-facts">
                              <Typography variant="caption" color="text.secondary" noWrap>
                                平台 {detailPurchaseInfoSupport.platform || '未返回'}
                              </Typography>
                              {detailSourceLinkHref ? (
                                <Typography
                                  component="button"
                                  type="button"
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    openSalesPurchaseLink(detailSourceLinkHref, detailOrder, product);
                                  }}
                                  variant="caption"
                                  color="primary"
                                  noWrap
                                  title={detailSourceLinkText}
                                  sx={{
                                    display: 'block',
                                    width: '100%',
                                    padding: 0,
                                    border: 0,
                                    background: 'none',
                                    textAlign: 'left',
                                    cursor: 'pointer',
                                    textDecoration: 'none',
                                    '&:hover': { textDecoration: 'underline' },
                                  }}
                                >
                                  链接 {detailSourceLinkText}
                                </Typography>
                              ) : (
                                <Typography
                                  variant="caption"
                                  color="text.secondary"
                                  noWrap
                                  title={detailSourceLinkText}
                                  sx={{ display: 'block' }}
                                >
                                  链接 {detailSourceLinkText}
                                </Typography>
                              )}
                              <Typography variant="caption" color="text.secondary" noWrap>
                                商品ID {detailPurchaseInfoSupport.sourceProductId || '未返回'}
                              </Typography>
                            </Box>
                          </Box>
                        </Box>
                        <Box className="detail-product-meta">
                          <Typography variant="subtitle1" className="purchase-source-meta-value">
                            {detailPurchaseInfoSupport.cost || product.purchasePrice || '未返回'}
                          </Typography>
                          <Typography variant="subtitle1" className="purchase-source-meta-value">
                            {detailSourceQtyText}
                          </Typography>
                        </Box>
                      </Box>
                    ))}
                  </Stack>

                  <Divider sx={{ my: 2 }} />

                  <Typography variant="subtitle1" mb={1}>
                    跨境巴士信息
                  </Typography>
                  <Box className="sales-cross-border-grid">
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        order_id
                      </Typography>
                      <Typography variant="subtitle1">{detailCrossBorderInfo.orderId}</Typography>
                    </Box>
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        包裹重量
                      </Typography>
                      <Typography variant="subtitle1">{detailCrossBorderInfo.packageWeight}</Typography>
                    </Box>
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        包裹尺寸
                      </Typography>
                      <Typography variant="subtitle1">{detailCrossBorderInfo.packageSize}</Typography>
                    </Box>
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        读取状态
                      </Typography>
                      <Typography variant="subtitle1">
                        {getCrossBorderReadStatusDisplay(detailCrossBorderInfo.readStatus)}
                      </Typography>
                    </Box>
                  </Box>

                  {detailSplitLocked ? (
                    <Alert severity="info" className="sales-split-lock-alert">
                      {detailSplitLockReason || '该拆单父单未在 Ozon 当前回读中确认，仅保留只读展示。'}
                    </Alert>
                  ) : null}

                  <Stack direction="row" spacing={1} className="detail-actions">
                    <Button
                      variant="outlined"
                      size="small"
                      disabled={!detailOrder}
                      onClick={openSalesPurchaseInfoWorkbench}
                    >
                      采购信息
                    </Button>
                    <Button
                      variant="outlined"
                      size="small"
                      color="error"
                      disabled={!canCancelDetailOrder || salesOperation.loading}
                      onClick={() => openSalesOperation('cancel', detailOrder)}
                    >
                      取消订单
                    </Button>
                    <Button
                      variant="contained"
                      size="small"
                      disabled={!canShipDetailOrder || salesOperation.loading}
                      onClick={() => openSalesOperation('ship', detailOrder)}
                    >
                      确认发货
                    </Button>
                    <Button
                      variant="outlined"
                      size="small"
                      disabled={!canSplitDetailOrder || salesOperation.loading}
                      onClick={() => openSalesOperation('split', detailOrder)}
                    >
                      拆解订单
                    </Button>
                  </Stack>
                </>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  请选择左侧订单查看详情。
                </Typography>
              )}
            </CardContent>
          </Card>
        </Box>
      </Box>
      {salesOperation.open ? (
        <React.Suspense fallback={null}>
          <SalesOrderOperationDialog
            salesOperation={salesOperation}
            closeSalesOperation={closeSalesOperation}
            isSplitSalesOperation={isSplitSalesOperation}
            operationMeta={operationMeta}
            splitOperationOrder={splitOperationOrder}
            splitValidation={splitValidation}
            addSalesSplitPackage={addSalesSplitPackage}
            splitPackages={splitPackages}
            removeSalesSplitPackage={removeSalesSplitPackage}
            updateSalesSplitPackageQuantity={updateSalesSplitPackageQuantity}
            operationOrders={operationOrders}
            updateSalesCancelReason={updateSalesCancelReason}
            executeSalesOperation={executeSalesOperation}
            canSubmitSalesOperation={canSubmitSalesOperation}
          />
        </React.Suspense>
      ) : null}
      <OzonProductWorkbench controller={salesOzonProductWorkbench} />
      <Snackbar
        open={salesNotice.open}
        autoHideDuration={2600}
        onClose={() => setSalesNotice((current) => ({ ...current, open: false }))}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <Alert
          severity={salesNotice.severity}
          onClose={() => setSalesNotice((current) => ({ ...current, open: false }))}
          variant="filled"
        >
          {String(salesNotice.message?.message || salesNotice.message || '')}
        </Alert>
      </Snackbar>
    </>
  );
}
