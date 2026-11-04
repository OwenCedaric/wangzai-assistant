import {
  firstFilled,
  formatOzonOrderDate,
  getOzonShopLabel,
} from '../../../../entities/order/orderShopScope.jsx';
import { getSourcePlatformClassName } from '../../../../entities/order/orderSourceLinks.jsx';
import { SourceLinkDropdownField } from '../../../../entities/order/orderSourceLinkFields.jsx';
import { PURCHASE_SOURCE_PLATFORMS, SALES_ORDER_PAGE_SIZE_OPTIONS } from '../../../../shared/config/appConfigCore.jsx';
import { LazyHoverImagePreview, OrderImagePreviewSlot } from '../../../../shared/ui/ImagePreview.jsx';
import { OrderSideSearch } from '../../../../shared/ui/OrderSideSearch.jsx';
import { ReadProgressPanel } from '../../../../shared/ui/ReadProgressPanel.jsx';
import { getPurchaseOrderRecordKey, purchaseOrderStageTabs } from '../lib/purchaseMarketingApi.jsx';
import {
  getPurchaseOrderDisplayOrderId,
  getPurchaseOrderListProfit,
  getPurchaseOrderListSyncLabels,
  getPurchaseOrderPreviewImages,
  getPurchaseOrderProfitSummaryItems,
  getPurchaseOrderShortStatus,
  getPurchaseSourceProductPreviewImageUrl,
  getPurchaseSourceProductImageUrl,
  getPurchaseSourceCardAmount,
  getPurchaseSourceCardQty,
  getPurchaseSourceProductTitle,
} from '../lib/purchaseImageRules.jsx';
import CalendarMonthRounded from '@mui/icons-material/CalendarMonthRounded';
import ChevronLeftRounded from '@mui/icons-material/ChevronLeftRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded';
import KeyboardArrowRightRounded from '@mui/icons-material/KeyboardArrowRightRounded';
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
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import Pagination from '@mui/material/Pagination';
import Popover from '@mui/material/Popover';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { PurchaseOrdersDialogs } from './PurchaseOrdersDialogs.jsx';
export function PurchaseOrdersPageView({ model }) {
  const {
    readableShops,
    paymentStartDate,
    setPaymentStartDate,
    paymentEndDate,
    setPaymentEndDate,
    paymentDateAnchorEl,
    setPaymentDateAnchorEl,
    orderSync,
    purchaseImageErrorText,
    status,
    setStatus,
    shop,
    setShop,
    fulfillment,
    setFulfillment,
    keyword,
    setKeyword,
    purchaseOrderPageSize,
    setPurchaseOrderPageSize,
    setPurchaseOrderPage,
    setSelectedOrderId,
    selectedPurchaseOrderKeys,
    setSelectedPurchaseOrderKeys,
    manualPurchaseDraft,
    manualPurchaseAnchorEl,
    purchaseOrdersLayoutRef,
    setSelectedProductIndex,
    setSelectedSourceSlot,
    setSelectedPurchaseSearchImage,
    purchasePlatformExpanded,
    paymentDateOpen,
    paymentDateText,
    filteredOrders,
    purchaseOrderStageCounts,
    purchaseOrderTotalPages,
    currentPurchaseOrderPage,
    visibleOrders,
    purchaseOrderRangeStart,
    purchaseOrderRangeEnd,
    filteredPurchaseOrderKeys,
    visiblePurchaseOrderKeys,
    selectedPurchaseOrderCount,
    purchaseBatchCancelCount,
    purchaseBatchCancelExcludedCount,
    allPurchasePageSelected,
    purchasePageSelectionIndeterminate,
    purchaseSupplierSync,
    handleFullSupplierSync,
    handleRefreshPurchaseOrders,
    selectedOrder,
    hasSelectedOrder,
    selectedProducts,
    safeSelectedProductIndex,
    selectedProduct,
    selectedSourceRecord,
    safeSelectedSourceSlot,
    selectedSourceEntry,
    selectedSourceLink,
    selectedActionState,
    selectedActionFlags,
    selectedVolumeItems,
    selectedPackageSize,
    selectedPackageWeight,
    selectedPackageLength,
    selectedPackageWidth,
    selectedPackageHeight,
    selectedLogisticsRouteText,
    selectedReadStatus,
    selectedDomesticCarrier,
    selectedDomesticTrackingNumber,
    selectedDomesticLogisticsStatus,
    manualPurchaseEditorOpen,
    manualPurchaseSummaryPlatform,
    manualPurchaseSummaryOrderNo,
    manualPurchaseSummaryPrice,
    purchaseOrderPartialErrorText,
    togglePurchaseOrderSelection,
    togglePurchaseOrderPageSelection,
    selectAllFilteredPurchaseOrders,
    clearPurchaseOrderSelection,
    resetPurchaseOrderListState,
    handleOpenSourceLink,
    handleQuickOrderSourceLink,
    handleSaveSourceLink,
    updateSelectedSourceLink,
    setSelectedSourceAsPrimary,
    openSourceSearchDialog,
    openPurchaseOzonProduct,
    updateManualPurchaseDraftField,
    openManualPurchaseEditor,
    closeManualPurchaseEditor,
    handleSaveManualPurchaseInfo,
    selectPurchaseSearchImage,
    handleBatchReadCrossBorder,
    openPurchaseBatchCancel,
    purchaseOperation,
    selectedOrderActionItems,
    stats,
  } = model;
  const purchaseOrderSyncRunning = Boolean(orderSync.loading || orderSync.refreshing);
  const purchaseOrderIncomplete = orderSync.data?.complete === false;
  const purchaseSupplierSyncRunning = Boolean(purchaseSupplierSync?.running);
  const purchasePageBusy = purchaseOrderSyncRunning || purchaseOrderIncomplete || purchaseSupplierSyncRunning;
  const purchaseOrderCachedRows = Number(orderSync.data?.rows?.length) || 0;
  const purchaseOrderProgressMessage = purchaseOrderIncomplete
      ? `已显示首批 ${purchaseOrderCachedRows} 条订单，仍在读取剩余数据；统计和全选将在完整读取后可用`
      : orderSync.refreshing
      ? `后台正在同步 Ozon 拍单订单，当前缓存 ${purchaseOrderCachedRows} 条`
      : purchaseOrderCachedRows > 0
        ? `正在读取 Ozon 拍单订单，当前缓存 ${purchaseOrderCachedRows} 条`
        : '正在读取 Ozon 拍单订单';

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
          <Typography variant="h4">拍单管理</Typography>
          <Typography color="text.secondary" mt={0.75}>
            管理采购拍单、预报、发货和售后处理进度
          </Typography>
        </Box>
        <Stack spacing={0.75} alignItems={{ xs: 'stretch', md: 'flex-end' }} className="hero-actions">
          <Stack direction="row" spacing={1}>
            <Button
              variant="outlined"
              startIcon={<SyncRounded />}
              onClick={handleFullSupplierSync}
              disabled={!readableShops.length || purchasePageBusy}
            >
              {purchaseSupplierSyncRunning
                ? `同步中 ${purchaseSupplierSync.completed}/${purchaseSupplierSync.total}`
                : '同步物流'}
            </Button>
            <Button
              variant="contained"
              startIcon={<RefreshRounded />}
              onClick={handleRefreshPurchaseOrders}
              disabled={!readableShops.length || purchaseOrderSyncRunning || purchaseSupplierSyncRunning}
            >
              {purchaseOrderSyncRunning ? '读取中' : '刷新订单'}
            </Button>
          </Stack>
          <ReadProgressPanel
            visible={purchaseOrderSyncRunning}
            running={purchaseOrderSyncRunning}
            message={purchaseOrderProgressMessage}
            ariaLabel="拍单订单读取进度"
          />
        </Stack>
      </Stack>

      <Box className="purchase-order-stat-grid">
        {stats.map((item) => (
          <Card key={item.title} className={`order-preview-card preview-${item.tone}`}>
            <CardContent>
              <Typography variant="body2" color="text.secondary">
                {item.title}
              </Typography>
              <Typography variant="h5" mt={0.5}>
                {purchaseOrderIncomplete || (purchaseOrderSyncRunning && !orderSync.data) ? '读取中' : item.value}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {item.hint}
              </Typography>
            </CardContent>
          </Card>
        ))}
      </Box>

      <Card className="purchase-order-filter-card">
        <CardContent>
          <Stack direction={{ xs: 'column', xl: 'row' }} spacing={1.5} alignItems={{ xs: 'stretch', xl: 'center' }}>
            <Box className="purchase-order-filter-copy">
              <Typography variant="h6">拍单状态</Typography>
              <Typography variant="body2" color="text.secondary">
                按采购履约节点查看拍单
              </Typography>
            </Box>
            <Box className="purchase-order-status-grid">
              {purchaseOrderStageTabs.map((tab) => {
                const count = purchaseOrderStageCounts[tab.value] ?? 0;
                return (
                  <Box
                    key={tab.value}
                    component="button"
                    type="button"
                    className={`status-tab status-${tab.tone}${status === tab.value ? ' active' : ''}`}
                    onClick={() => {
                      setStatus(tab.value);
                      resetPurchaseOrderListState();
                    }}
                  >
                    <span>{tab.label}</span>
                    <strong>{purchaseOrderIncomplete || (purchaseOrderSyncRunning && !orderSync.data) ? '…' : count}</strong>
                  </Box>
                );
              })}
            </Box>
          </Stack>
        </CardContent>
      </Card>

      <Box className="purchase-orders-layout" ref={purchaseOrdersLayoutRef}>
        <Card className="purchase-orders-table-card">
          <CardContent>
            <Box className="sales-order-table-head purchase-order-table-head">
              <Box className="sales-order-table-title">
                <Typography variant="h6">拍单列表</Typography>
                <Typography variant="body2" color="text.secondary">
                  {purchaseOrderIncomplete
                    ? '首批订单已显示，完整列表仍在读取'
                    : orderSync.data?.fetchedAt
                    ? `已同步 ${formatOzonOrderDate(orderSync.data.fetchedAt)}`
                    : '等待读取 Ozon 订单'}
                </Typography>
              </Box>
              <Box className="sales-order-filter-toolbar purchase-order-filter-toolbar">
                <TextField
                  size="small"
                  className="sales-order-search-field"
                  placeholder="搜索单号 / 货号 / SKU"
                  value={keyword}
                  onChange={(event) => {
                    setKeyword(event.target.value);
                    resetPurchaseOrderListState();
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
                      resetPurchaseOrderListState();
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
                      resetPurchaseOrderListState();
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
                        resetPurchaseOrderListState();
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
                        resetPurchaseOrderListState();
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
                          resetPurchaseOrderListState();
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
                {orderSync.error}
              </Alert>
            ) : null}
            {purchaseOrderPartialErrorText ? (
              <Alert severity="info" className="order-sync-alert">
                部分接口失败：{purchaseOrderPartialErrorText}，已展示成功读取的数据。
              </Alert>
            ) : null}
            {purchaseImageErrorText ? (
              <Alert severity="info" className="order-sync-alert">
                补充信息未完全返回：{purchaseImageErrorText}，订单基础信息已优先展示。
              </Alert>
            ) : null}
            {purchaseOrderIncomplete ? (
              <Alert severity={orderSync.error ? 'warning' : 'info'} className="order-sync-alert">
                当前只显示已读取的首批订单，搜索结果和统计尚不完整。
                {orderSync.error ? '剩余数据读取失败，请点击刷新订单重试。' : '剩余数据正在读取，请稍候；完整后可全选所有页。'}
              </Alert>
            ) : null}

            <Box className="sales-order-selection-bar purchase-order-selection-bar">
              <Stack
                direction="row"
                spacing={1}
                alignItems="center"
                className="purchase-order-selection-actions"
              >
                <Typography variant="body2" className="sales-order-selection-count">
                  已选 {selectedPurchaseOrderCount} 个
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  本页 {visiblePurchaseOrderKeys.length} 条 / {purchaseOrderIncomplete ? '已读取范围内筛选' : '当前筛选'} {filteredOrders.length} 条
                </Typography>
                <Button
                  size="small"
                  variant="contained"
                  onClick={togglePurchaseOrderPageSelection}
                  disabled={!visiblePurchaseOrderKeys.length}
                >
                  {allPurchasePageSelected ? '取消本页' : '全选本页'}
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={selectAllFilteredPurchaseOrders}
                  disabled={
                    purchaseOrderIncomplete || !filteredPurchaseOrderKeys.length || selectedPurchaseOrderCount === filteredPurchaseOrderKeys.length
                  }
                >
                  全选所有页
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={clearPurchaseOrderSelection}
                  disabled={!selectedPurchaseOrderCount}
                >
                  清空
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={handleBatchReadCrossBorder}
                  disabled={!selectedPurchaseOrderCount}
                >
                  批量回查巴士
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  color="error"
                  onClick={openPurchaseBatchCancel}
                  disabled={!purchaseBatchCancelCount || purchaseOperation.loading}
                  title={
                    purchaseBatchCancelExcludedCount
                      ? `可取消 ${purchaseBatchCancelCount} 个，已排除 ${purchaseBatchCancelExcludedCount} 个`
                      : `可取消 ${purchaseBatchCancelCount} 个`
                  }
                >
                  批量取消
                </Button>
              </Stack>
              <Typography variant="caption" color="text.secondary" className="purchase-order-selection-hint">
                只渲染当前页，打开更快
              </Typography>
            </Box>

            <TableContainer className="wide-table-container">
              <Table className="data-table purchase-orders-table">
                <colgroup>
                  <col className="purchase-order-col-select" />
                  <col className="purchase-order-col-image" />
                  <col className="purchase-order-col-image" />
                  <col className="purchase-order-col-order" />
                  <col className="purchase-order-col-product" />
                  <col className="purchase-order-col-shop" />
                  <col className="purchase-order-col-sales" />
                  <col className="purchase-order-col-profit" />
                  <col className="purchase-order-col-sync" />
                  <col className="purchase-order-col-status" />
                </colgroup>
                <TableHead>
                  <TableRow>
                    <TableCell padding="checkbox" className="purchase-order-select-cell">
                      <Checkbox
                        size="small"
                        checked={allPurchasePageSelected}
                        indeterminate={purchasePageSelectionIndeterminate}
                        onChange={togglePurchaseOrderPageSelection}
                        disabled={!visiblePurchaseOrderKeys.length}
                      />
                    </TableCell>
                    <TableCell align="center" className="purchase-order-image-head-cell">
                      下单图
                    </TableCell>
                    <TableCell align="center" className="purchase-order-image-head-cell">
                      Ozon主图
                    </TableCell>
                    <TableCell className="purchase-order-id-head-cell">单号</TableCell>
                    <TableCell className="purchase-order-product-head-cell">商品</TableCell>
                    <TableCell align="center" className="purchase-order-shop-head-cell">
                      店铺
                    </TableCell>
                    <TableCell align="center" className="purchase-order-money-head-cell">
                      销售金额
                    </TableCell>
                    <TableCell align="center" className="purchase-order-profit-head-cell">
                      预估利润
                    </TableCell>
                    <TableCell align="center" className="purchase-order-sync-head-cell">
                      同步状态
                    </TableCell>
                    <TableCell align="center" className="purchase-order-status-head-cell">
                      状态
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {visibleOrders.map((order) => {
                    const productNo =
                      firstFilled(order.productNo, order.sku, order.products?.[0]?.offerId, order.products?.[0]?.sku) ||
                      '未返回';
                    const profit = getPurchaseOrderListProfit(order);
                    const syncLabels = getPurchaseOrderListSyncLabels(order);
                    const orderKey = getPurchaseOrderRecordKey(order) || order.id;
                    const orderImagePreviews = getPurchaseOrderPreviewImages(order);
                    return (
                      <TableRow
                        key={order.id}
                        hover
                        className={selectedOrder.id === order.id ? 'selected-row' : ''}
                        onClick={() => {
                          setSelectedOrderId(order.id);
                          setSelectedPurchaseSearchImage({ orderId: '', imageUrl: '', slot: '' });
                        }}
                      >
                        <TableCell
                          padding="checkbox"
                          className="purchase-order-select-cell"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <Checkbox
                            size="small"
                            checked={selectedPurchaseOrderKeys.has(getPurchaseOrderRecordKey(order))}
                            onChange={() => togglePurchaseOrderSelection(order)}
                          />
                        </TableCell>
                        <TableCell
                          key={`${orderKey}-image1`}
                          align="center"
                          className="purchase-order-image-cell"
                          onClick={(event) => {
                            event.stopPropagation();
                            selectPurchaseSearchImage(order, orderImagePreviews[0], 'image1');
                          }}
                        >
                          <OrderImagePreviewSlot preview={orderImagePreviews[0]} variant="purchase" />
                        </TableCell>
                        <TableCell
                          key={`${orderKey}-image2`}
                          align="center"
                          className="purchase-order-image-cell"
                          onClick={(event) => {
                            event.stopPropagation();
                            selectPurchaseSearchImage(order, orderImagePreviews[1], 'image2');
                          }}
                        >
                          <OrderImagePreviewSlot preview={orderImagePreviews[1]} variant="purchase" />
                        </TableCell>
                        <TableCell className="purchase-order-id-cell">
                          <Typography variant="subtitle1" noWrap title={order.id}>
                            {order.id}
                          </Typography>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            display="block"
                            noWrap
                            title={`货号: ${productNo}`}
                          >
                            货号: {productNo}
                          </Typography>
                        </TableCell>
                        <TableCell className="purchase-order-product-cell">
                          <Typography
                            component="button"
                            type="button"
                            variant="subtitle1"
                            className="ozon-product-title-button"
                            noWrap
                            title={`${order.product}｜打开 Ozon 商品页面`}
                            onClick={(event) => {
                              event.stopPropagation();
                              openPurchaseOzonProduct(order, order.products?.[0] || {});
                            }}
                          >
                            {order.product}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" display="block" noWrap>
                            订单数量: {order.items} 件
                          </Typography>
                        </TableCell>
                        <TableCell align="center" className="purchase-order-shop-cell" title={order.shop}>
                          {order.shop}
                        </TableCell>
                        <TableCell align="center" className="purchase-order-money-cell">
                          {order.amount}
                        </TableCell>
                        <TableCell align="center" className="purchase-order-profit-cell">
                          <Typography
                            variant="body2"
                            className={`purchase-order-profit-value ${profit.tone || ''}`.trim()}
                            noWrap
                            title={profit.value}
                          >
                            {profit.value}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" display="block" noWrap>
                            {profit.hint}
                          </Typography>
                        </TableCell>
                        <TableCell align="center" className="purchase-order-sync-cell">
                          <Typography variant="body2" noWrap title={syncLabels.ozon}>
                            {syncLabels.ozon}
                          </Typography>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            display="block"
                            noWrap
                            title={syncLabels.crossBorder}
                          >
                            {syncLabels.crossBorder}
                          </Typography>
                        </TableCell>
                        <TableCell align="center" className="purchase-order-status-cell">
                          <Stack spacing={0.5} alignItems="center">
                            <Chip
                              size="small"
                              color={order.tone}
                              label={getPurchaseOrderShortStatus(order.status)}
                              variant="outlined"
                            />
                            {order.manualClassified ? (
                              <Chip size="small" color="info" label="人工归类" variant="outlined" />
                            ) : null}
                          </Stack>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {!orderSync.loading && !orderSync.refreshing && filteredOrders.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={10}>
                        <Typography variant="body2" color="text.secondary" align="center">
                          {purchaseOrderIncomplete ? '订单尚未完整读取，暂不能判断是否有符合条件的订单' : readableShops.length ? '暂未读取到符合条件的 Ozon 订单' : '请先在设置里配置 Ozon 店铺'}
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </TableContainer>
            {filteredOrders.length > 0 ? (
              <Box className="sales-order-pagination purchase-order-pagination">
                <Box className="sales-order-pagination-summary">
                  <Typography variant="body2" color="text.secondary">
                    {purchaseOrderIncomplete ? '当前已读取范围' : '共'} {filteredOrders.length} 条
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {purchaseOrderRangeStart}-{purchaseOrderRangeEnd}
                  </Typography>
                </Box>
                <Box className="sales-order-pagination-controls">
                  <Typography variant="body2" color="text.secondary">
                    每页
                  </Typography>
                  <FormControl size="small" className="sales-order-page-size-select">
                    <Select
                      value={String(purchaseOrderPageSize)}
                      onChange={(event) => {
                        setPurchaseOrderPageSize(Number(event.target.value));
                        setPurchaseOrderPage(1);
                        setSelectedPurchaseOrderKeys(new Set());
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
                    page={currentPurchaseOrderPage}
                    count={purchaseOrderTotalPages}
                    siblingCount={1}
                    boundaryCount={1}
                    onChange={(_, value) => {
                      setPurchaseOrderPage(value);
                      setSelectedPurchaseOrderKeys(new Set());
                      const nextOrder = filteredOrders[(value - 1) * purchaseOrderPageSize];
                      if (nextOrder) setSelectedOrderId(nextOrder.id);
                    }}
                  />
                </Box>
              </Box>
            ) : null}
          </CardContent>
        </Card>

        <Box className="purchase-order-side-panel" data-order-follow-panel="true">
          <OrderSideSearch
            value={keyword}
            onChange={(event) => {
              setKeyword(event.target.value);
              resetPurchaseOrderListState();
            }}
          />
          <Card className="purchase-order-detail-card">
            <CardContent className="purchase-detail-content">
              <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1.5} mb={2}>
                <Box>
                  <Typography variant="h6">订单信息</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {selectedOrder.id || '暂无订单'}
                  </Typography>
                </Box>
                <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" justifyContent="flex-end">
                  {selectedOrder.manualClassified ? (
                    <Chip size="small" color="info" label="人工归类" variant="outlined" />
                  ) : null}
                  <Chip size="small" color={selectedOrder.tone} label={selectedOrder.status} variant="outlined" />
                </Stack>
              </Stack>

              <Box className="detail-info-grid purchase-order-core-grid">
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    货号
                  </Typography>
                  <Typography variant="subtitle1" noWrap title={selectedOrder.productNo}>
                    {selectedOrder.productNo}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    Ozon 订单 ID
                  </Typography>
                  <Typography variant="subtitle1" noWrap title={selectedOrder.ozonOrderId}>
                    {selectedOrder.ozonOrderId}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    店铺
                  </Typography>
                  <Typography variant="subtitle1" noWrap title={selectedOrder.shop}>
                    {selectedOrder.shop}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    销售金额
                  </Typography>
                  <Typography variant="subtitle1" noWrap title={selectedOrder.amount}>
                    {selectedOrder.amount}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    买家平台
                  </Typography>
                  <Typography
                    variant="subtitle1"
                    className={`purchase-platform-text ${getSourcePlatformClassName(selectedOrder.buyerPlatform)}`}
                    noWrap
                    title={selectedOrder.buyerPlatform}
                  >
                    {selectedOrder.buyerPlatform}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    采购订单号
                  </Typography>
                  <Typography
                    variant="subtitle1"
                    className={`purchase-platform-text ${getSourcePlatformClassName(selectedOrder.buyerPlatform)}`}
                    noWrap
                    title={selectedOrder.purchaseOrderNo || '待补录'}
                  >
                    {selectedOrder.purchaseOrderNo || '待补录'}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    Ozon 状态
                  </Typography>
                  <Typography variant="subtitle1" noWrap title={selectedOrder.ozonStatusLabel}>
                    {selectedOrder.ozonStatusLabel}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    付款时间
                  </Typography>
                  <Typography variant="subtitle1" noWrap title={selectedOrder.paymentTime || '未返回'}>
                    {selectedOrder.paymentTime || '未返回'}
                  </Typography>
                </Box>
              </Box>

              <Box
                sx={{
                  mt: 1.5,
                  width: 500,
                  maxWidth: '100%',
                  minHeight: 38,
                  px: 1,
                  py: 0.5,
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: 1.5,
                  bgcolor: '#fbfcff',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.5,
                  overflow: 'hidden',
                }}
              >
                <Chip
                  size="small"
                  label="补录"
                  sx={{
                    height: 26,
                    minWidth: 54,
                    bgcolor: 'rgba(93, 135, 255, 0.1)',
                    color: 'primary.main',
                    fontWeight: 800,
                  }}
                />
                <Stack direction="row" spacing={0.25} alignItems="center" sx={{ width: 82, minWidth: 0 }}>
                  <Typography variant="caption" color="text.secondary" sx={{ width: 24, flex: '0 0 auto' }}>
                    平台
                  </Typography>
                  <Typography
                    variant="subtitle2"
                    noWrap
                    title={manualPurchaseSummaryPlatform}
                    sx={{ width: 54, minWidth: 0 }}
                  >
                    {manualPurchaseSummaryPlatform}
                  </Typography>
                </Stack>
                <Stack direction="row" spacing={0.25} alignItems="center" sx={{ width: 136, minWidth: 0 }}>
                  <Typography variant="caption" color="text.secondary" sx={{ width: 24, flex: '0 0 auto' }}>
                    单号
                  </Typography>
                  <Typography
                    variant="subtitle2"
                    noWrap
                    title={manualPurchaseSummaryOrderNo}
                    sx={{ width: 108, minWidth: 0 }}
                  >
                    {manualPurchaseSummaryOrderNo}
                  </Typography>
                </Stack>
                <Stack direction="row" spacing={0.25} alignItems="center" sx={{ width: 92, minWidth: 0 }}>
                  <Typography variant="caption" color="text.secondary" sx={{ width: 24, flex: '0 0 auto' }}>
                    成本
                  </Typography>
                  <Typography
                    variant="subtitle2"
                    noWrap
                    title={manualPurchaseSummaryPrice}
                    sx={{ width: 64, minWidth: 0 }}
                  >
                    {manualPurchaseSummaryPrice}
                  </Typography>
                </Stack>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={openManualPurchaseEditor}
                  disabled={!hasSelectedOrder}
                  sx={{
                    flex: '0 0 auto',
                    minWidth: 42,
                    height: 30,
                    px: 0.75,
                    borderRadius: 1.5,
                    fontWeight: 800,
                  }}
                >
                  编辑
                </Button>
              </Box>

              <Popover
                open={manualPurchaseEditorOpen}
                anchorEl={manualPurchaseAnchorEl}
                onClose={closeManualPurchaseEditor}
                anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
                transformOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                PaperProps={{
                  sx: {
                    width: 640,
                    maxWidth: 'calc(100vw - 32px)',
                    p: 1.5,
                    borderRadius: 2,
                    border: '1px solid',
                    borderColor: 'divider',
                    boxShadow: '0 18px 45px rgba(15, 23, 42, 0.16)',
                  },
                }}
              >
                <Stack spacing={1.25}>
                  <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
                    <Typography variant="subtitle2" fontWeight={800}>
                      补录信息
                    </Typography>
                    <IconButton size="small" onClick={closeManualPurchaseEditor}>
                      <CloseRounded fontSize="small" />
                    </IconButton>
                  </Stack>
                  <Box
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: { xs: '1fr', sm: '1.05fr 1.15fr 0.8fr auto' },
                      gap: 1,
                      alignItems: 'center',
                    }}
                  >
                    <TextField
                      size="small"
                      label="平台"
                      value={manualPurchaseDraft.manualBuyerPlatform}
                      onChange={updateManualPurchaseDraftField('manualBuyerPlatform')}
                      placeholder="拼多多 / 1688"
                      fullWidth
                    />
                    <TextField
                      size="small"
                      label="采购单号"
                      value={manualPurchaseDraft.manualPurchaseOrderNo}
                      onChange={updateManualPurchaseDraftField('manualPurchaseOrderNo')}
                      placeholder="采购订单号"
                      fullWidth
                    />
                    <TextField
                      size="small"
                      label="成本"
                      value={manualPurchaseDraft.manualPurchasePrice}
                      onChange={updateManualPurchaseDraftField('manualPurchasePrice')}
                      placeholder="0.00"
                      fullWidth
                      InputProps={{
                        startAdornment: <InputAdornment position="start">¥</InputAdornment>,
                      }}
                      inputProps={{
                        inputMode: 'decimal',
                      }}
                    />
                    <Button
                      variant="contained"
                      size="small"
                      onClick={handleSaveManualPurchaseInfo}
                      disabled={!hasSelectedOrder}
                      sx={{ minWidth: 88, height: 40, fontWeight: 800 }}
                    >
                      保存
                    </Button>
                  </Box>
                </Stack>
              </Popover>

              <Divider sx={{ my: 2 }} />

              <Stack
                direction="row"
                alignItems="center"
                justifyContent="space-between"
                className="purchase-product-source-title"
              >
                <Typography variant="subtitle1">商品货源</Typography>
                {selectedProducts.length > 1 ? (
                  <Stack direction="row" spacing={0.5} alignItems="center">
                    <IconButton
                      size="small"
                      onClick={() => setSelectedProductIndex((current) => Math.max(current - 1, 0))}
                      disabled={safeSelectedProductIndex === 0}
                    >
                      <ChevronLeftRounded fontSize="small" />
                    </IconButton>
                    <Typography variant="caption" color="text.secondary">
                      商品 {safeSelectedProductIndex + 1} / {selectedProducts.length}
                    </Typography>
                    <IconButton
                      size="small"
                      onClick={() =>
                        setSelectedProductIndex((current) => Math.min(current + 1, selectedProducts.length - 1))
                      }
                      disabled={safeSelectedProductIndex >= selectedProducts.length - 1}
                    >
                      <KeyboardArrowRightRounded fontSize="small" />
                    </IconButton>
                  </Stack>
                ) : null}
              </Stack>
              <Stack spacing={1}>
                {selectedProduct
                  ? (() => {
                      const product = selectedProduct;
                      const sourceProductImageUrl = getPurchaseSourceProductImageUrl(selectedSourceEntry);
                      const sourceProductPreviewImageUrl =
                        getPurchaseSourceProductPreviewImageUrl(selectedSourceEntry) || sourceProductImageUrl;
                      const productSourceTitle = getPurchaseSourceProductTitle(product, selectedSourceEntry);
                      const sourceCardAmount = getPurchaseSourceCardAmount(product, selectedOrder, selectedSourceEntry);
                      const sourceCardQty = getPurchaseSourceCardQty(product, selectedOrder, selectedSourceEntry);

                      return (
                        <Box key={product.sku} className="detail-product-row">
                          <Box className="detail-product-main">
                            <LazyHoverImagePreview
                              className="detail-product-image-hover purchase-order-image-hover"
                              previewClassName="purchase-order-image-preview"
                              imageUrl={sourceProductPreviewImageUrl}
                              alt={productSourceTitle}
                            >
                              {sourceProductImageUrl ? (
                                <Box
                                  component="img"
                                  src={sourceProductImageUrl}
                                  alt={productSourceTitle}
                                  className="detail-product-thumb"
                                  referrerPolicy="no-referrer"
                                />
                              ) : (
                                <Box className="detail-product-thumb detail-product-thumb-empty">
                                  <Inventory2Rounded fontSize="small" />
                                </Box>
                              )}
                            </LazyHoverImagePreview>
                            <Box className="product-source-panel">
                              <Box className="product-source-head">
                                <Typography
                                  variant="subtitle1"
                                  className="detail-product-name"
                                  noWrap
                                  title={productSourceTitle}
                                >
                                  {productSourceTitle}
                                </Typography>
                              </Box>
                              <SourceLinkDropdownField
                                className="source-link-input product-source-link-input"
                                value={selectedSourceLink}
                                record={selectedSourceRecord}
                                selectedIndex={safeSelectedSourceSlot}
                                onSelectSlot={(index) => setSelectedSourceSlot(index)}
                                onChange={updateSelectedSourceLink}
                                placeholder="粘贴拼多多 / 1688 / 淘宝 / 天猫链接"
                              />
                              <Stack direction="row" spacing={1} className="source-link-actions">
                                <Button
                                  className="source-link-action"
                                  variant="outlined"
                                  size="small"
                                  onClick={handleOpenSourceLink}
                                >
                                  打开操作台
                                </Button>
                                <Button
                                  className="source-link-action"
                                  variant="contained"
                                  size="small"
                                  onClick={handleSaveSourceLink}
                                >
                                  保存货源
                                </Button>
                                <Button
                                  className="source-link-action"
                                  variant="outlined"
                                  size="small"
                                  disabled={!selectedSourceLink.trim()}
                                  onClick={setSelectedSourceAsPrimary}
                                >
                                  设主货源
                                </Button>
                                <Button
                                  className="source-link-action quick-order-action"
                                  variant="contained"
                                  size="small"
                                  onClick={handleQuickOrderSourceLink}
                                >
                                  一键下单
                                </Button>
                              </Stack>
                            </Box>
                          </Box>
                          <Box className="detail-product-meta">
                            <Typography variant="subtitle1" className="purchase-source-meta-value">
                              {sourceCardAmount}
                            </Typography>
                            <Typography variant="subtitle1" className="purchase-source-meta-value">
                              {sourceCardQty}
                            </Typography>
                          </Box>
                        </Box>
                      );
                    })()
                  : null}
                {!selectedProducts.length ? (
                  <Typography variant="body2" color="text.secondary">
                    暂无商品货源
                  </Typography>
                ) : null}
              </Stack>

              <Divider sx={{ my: 2 }} />

              <Box className="purchase-domestic-logistics-section">
                <Typography variant="subtitle1" className="purchase-logistics-section-title">
                  国内物流
                </Typography>
                <Box className="purchase-domestic-logistics-grid">
                  <Box className="purchase-logistics-field">
                    <Typography variant="caption" color="text.secondary">
                      快递公司
                    </Typography>
                    <Typography variant="subtitle1" noWrap title={selectedDomesticCarrier}>
                      {selectedDomesticCarrier}
                    </Typography>
                  </Box>
                  <Box className="purchase-logistics-field">
                    <Typography variant="caption" color="text.secondary">
                      快递单号
                    </Typography>
                    <Typography variant="subtitle1" noWrap title={selectedDomesticTrackingNumber}>
                      {selectedDomesticTrackingNumber}
                    </Typography>
                  </Box>
                  <Box className="purchase-logistics-field">
                    <Typography variant="caption" color="text.secondary">
                      物流状态
                    </Typography>
                    <Typography variant="subtitle1" noWrap title={selectedDomesticLogisticsStatus}>
                      {selectedDomesticLogisticsStatus}
                    </Typography>
                  </Box>
                </Box>
              </Box>

              <Divider className="purchase-logistics-section-divider" />

              <Typography variant="subtitle1" className="purchase-logistics-section-title">
                物流包裹
              </Typography>
              <Box className="detail-info-grid purchase-logistics-grid">
                <Box className="purchase-logistics-field">
                  <Typography variant="caption" color="text.secondary">
                    order_id
                  </Typography>
                  <Typography
                    variant="subtitle1"
                    noWrap
                    title={getPurchaseOrderDisplayOrderId(selectedOrder) || '未返回'}
                  >
                    {getPurchaseOrderDisplayOrderId(selectedOrder) || '未返回'}
                  </Typography>
                </Box>
                <Box className="purchase-logistics-field">
                  <Typography variant="caption" color="text.secondary">
                    读取状态
                  </Typography>
                  <Typography variant="subtitle1" noWrap title={selectedReadStatus}>
                    {selectedReadStatus}
                  </Typography>
                </Box>
                <Box className="purchase-logistics-field">
                  <Typography variant="caption" color="text.secondary">
                    包裹重量
                  </Typography>
                  <Typography variant="subtitle1" noWrap title={selectedPackageWeight}>
                    {selectedPackageWeight}
                  </Typography>
                </Box>
                <Box className="purchase-logistics-field">
                  <Typography variant="caption" color="text.secondary">
                    长度
                  </Typography>
                  <Typography variant="subtitle1" noWrap title={selectedPackageLength}>
                    {selectedPackageLength}
                  </Typography>
                </Box>
                <Box className="purchase-logistics-field">
                  <Typography variant="caption" color="text.secondary">
                    高度
                  </Typography>
                  <Typography variant="subtitle1" noWrap title={selectedPackageHeight}>
                    {selectedPackageHeight}
                  </Typography>
                </Box>
                <Box className="purchase-logistics-field">
                  <Typography variant="caption" color="text.secondary">
                    宽度
                  </Typography>
                  <Typography variant="subtitle1" noWrap title={selectedPackageWidth}>
                    {selectedPackageWidth}
                  </Typography>
                </Box>
              </Box>

              <Box className="purchase-material-size-row">
                <Typography variant="caption" color="text.secondary">
                  材积尺寸
                </Typography>
                <Typography variant="subtitle1" noWrap title={selectedPackageSize}>
                  {selectedPackageSize}
                </Typography>
              </Box>

              {(selectedVolumeItems.length > 0 || selectedLogisticsRouteText !== '路线待确认') && (
                <Box className="purchase-volume-list">
                  <Box className="purchase-volume-row">
                    <Typography variant="body2" noWrap title={selectedLogisticsRouteText}>
                      {selectedLogisticsRouteText}
                    </Typography>
                  </Box>
                </Box>
              )}

              <Box className="purchase-profit-summary">
                {getPurchaseOrderProfitSummaryItems(selectedOrder).map((item) => (
                  <Box key={item.label} className={`purchase-profit-item${item.tone ? ` ${item.tone}` : ''}`}>
                    <Typography variant="caption" color="text.secondary">
                      {item.label}
                    </Typography>
                    <Typography variant="subtitle1" noWrap title={item.value}>
                      {item.value}
                    </Typography>
                  </Box>
                ))}
              </Box>

              <Stack direction="row" spacing={1} className="detail-actions" flexWrap="wrap" useFlexGap>
                {selectedOrderActionItems.map((action) => (
                  <Button
                    key={action.key}
                    variant={action.variant}
                    color={action.color}
                    size="small"
                    disabled={action.disabled}
                    onClick={action.onClick}
                  >
                    {action.label}
                  </Button>
                ))}
              </Stack>
              {purchasePlatformExpanded && selectedActionFlags.status === '待拍单' ? (
                <Stack direction="row" spacing={1} className="purchase-platform-actions" flexWrap="wrap" useFlexGap>
                  {PURCHASE_SOURCE_PLATFORMS.map((platform) => (
                    <Button
                      key={platform}
                      size="small"
                      variant="outlined"
                      className={`purchase-platform-action platform-${platform}`}
                      onClick={() => openSourceSearchDialog(platform)}
                    >
                      {platform === 'Ozon买家' ? 'Ozon' : platform}
                    </Button>
                  ))}
                </Stack>
              ) : null}
              <Typography variant="caption" color="text.secondary" className="detail-action-reason">
                {selectedActionState.canPurchase || selectedActionState.canForecast
                  ? selectedActionState.forecastMode === 'repair'
                    ? '当前可补录预报，不会重复 Ozon 备货，写入仍需单独确认。'
                    : '写入操作需要单独确认后执行。'
                  : selectedActionState.purchaseReason || selectedActionState.forecastReason}
              </Typography>
            </CardContent>
          </Card>
        </Box>
      </Box>

      <PurchaseOrdersDialogs model={model} />
    </>
  );
}
