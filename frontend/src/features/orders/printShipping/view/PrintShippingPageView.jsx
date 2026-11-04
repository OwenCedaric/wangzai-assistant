import { formatOzonOrderDate, getOzonShopLabel } from '../../../../entities/order/orderShopScope.jsx';
import { getSalesOrderRecordKey } from '../../../../entities/order/orderRecordRules.jsx';
import { SALES_ORDER_PAGE_SIZE_OPTIONS } from '../../../../shared/config/appConfigCore.jsx';
import { ReadProgressPanel } from '../../../../shared/ui/ReadProgressPanel.jsx';
import { resolvePrintShippingOrderFields } from '../lib/printShippingOrderFields.js';
import {
  DEFAULT_PRINT_SHIPPING_FILTERS,
  hasActivePrintShippingFilters,
  normalizePrintShippingFacetOptions,
} from '../lib/printShippingFilters.js';
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
import FormControl from '@mui/material/FormControl';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import Pagination from '@mui/material/Pagination';
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

const TABLE_HEAD_CELL_SX = {
  py: 1.35,
  px: 1.25,
  color: '#334155',
  fontWeight: 700,
  fontSize: 13,
  whiteSpace: 'nowrap',
  backgroundColor: '#f6f8fc',
  borderBottom: '1px solid #e8edf5',
};

const TABLE_BODY_CELL_SX = {
  py: 1.25,
  px: 1.25,
  verticalAlign: 'middle',
  borderBottom: '1px solid #edf1f7',
};

function getFirstProduct(order = {}) {
  return Array.isArray(order.products) && order.products.length ? order.products[0] : {};
}

function compactValue(value, fallback) {
  const text = String(value ?? '').trim();
  return text && text !== '未返回' ? text : fallback;
}

export function PrintShippingPageView({ model }) {
  const {
    viewTitle,
    viewDescription,
    readableShops,
    orderSync,
    salesOrderRefreshProgress,
    shop,
    setShop,
    fulfillment,
    setFulfillment,
    status,
    setStatus,
    keyword,
    setKeyword,
    printShippingFilters,
    setPrintShippingFilters,
    salesOrderPageSize,
    setSalesOrderPageSize,
    setSalesOrderPage,
    selectedSalesOrderKeys,
    salesNotice,
    setSalesNotice,
    filteredOrderTotal,
    salesOrderTotalPages,
    currentSalesOrderPage,
    visibleOrders,
    salesOrderRangeStart,
    salesOrderRangeEnd,
    visibleSalesOrderKeys,
    selectedSalesOrderCount,
    allSalesOrderPageSelected,
    salesOrderPageSelectionIndeterminate,
    handleRefreshSalesOrders,
    logisticsSync,
    handleSyncLogistics,
    refreshPurchaseShippingInfo,
    resetSalesOrderListState,
    toggleSalesOrderSelection,
    toggleSalesOrderPageSelection,
    clearSalesOrderSelection,
    getOrderPurchaseShippingInfo,
    openSalesOzonProductPage,
  } = model;
  const renderedOrders = React.useDeferredValue(visibleOrders);
  const salesOrderSyncRunning = Boolean(orderSync.loading || orderSync.refreshing);
  const activePrintShippingFilters = printShippingFilters || DEFAULT_PRINT_SHIPPING_FILTERS;
  const warehouseOptions = React.useMemo(
    () => normalizePrintShippingFacetOptions(orderSync.data?.printShippingFacets?.warehouses),
    [orderSync.data?.printShippingFacets?.warehouses]
  );
  const deliveryMethodOptions = React.useMemo(
    () => normalizePrintShippingFacetOptions(orderSync.data?.printShippingFacets?.deliveryMethods),
    [orderSync.data?.printShippingFacets?.deliveryMethods]
  );

  const updatePrintShippingFilter = React.useCallback((key, value) => {
    setPrintShippingFilters((current) => ({
      ...(current || DEFAULT_PRINT_SHIPPING_FILTERS),
      [key]: value,
    }));
    resetSalesOrderListState();
  }, [resetSalesOrderListState, setPrintShippingFilters]);

  const resetPrintShippingFilters = React.useCallback(() => {
    setPrintShippingFilters(DEFAULT_PRINT_SHIPPING_FILTERS);
    setStatus('等待发货');
    resetSalesOrderListState();
  }, [resetSalesOrderListState, setPrintShippingFilters, setStatus]);

  const handleRefresh = React.useCallback(async () => {
    await Promise.allSettled([
      Promise.resolve(handleRefreshSalesOrders()),
      Promise.resolve(refreshPurchaseShippingInfo()),
    ]);
  }, [handleRefreshSalesOrders, refreshPurchaseShippingInfo]);

  const handleLogisticsSync = React.useCallback(async () => {
    await handleSyncLogistics();
    await refreshPurchaseShippingInfo().catch(() => undefined);
  }, [handleSyncLogistics, refreshPurchaseShippingInfo]);

  return (
    <Stack spacing={2.25}>
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        alignItems={{ xs: 'stretch', md: 'center' }}
        justifyContent="space-between"
        spacing={2}
      >
        <Box>
          <Typography variant="h4">{viewTitle}</Typography>
          <Typography color="text.secondary" mt={0.5}>
            {viewDescription}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button
            variant="outlined"
            startIcon={<SyncRounded />}
            onClick={handleLogisticsSync}
            disabled={logisticsSync.running || salesOrderSyncRunning}
          >
            {logisticsSync.running ? '同步中' : '同步物流'}
          </Button>
          <Button
            variant="contained"
            startIcon={<RefreshRounded />}
            onClick={handleRefresh}
            disabled={!readableShops.length || salesOrderSyncRunning}
          >
            {salesOrderSyncRunning ? '读取中' : '刷新订单'}
          </Button>
        </Stack>
      </Stack>

      {salesOrderSyncRunning ? (
        <ReadProgressPanel
          visible
          running
          message={salesOrderRefreshProgress?.message || '正在读取待打单订单'}
          completed={salesOrderRefreshProgress?.completed}
          total={salesOrderRefreshProgress?.total}
          errors={salesOrderRefreshProgress?.errors}
          ariaLabel="待打单订单读取进度"
        />
      ) : null}
      <Card sx={{ borderRadius: 3, overflow: 'hidden' }}>
        <CardContent sx={{ p: 0, '&:last-child': { pb: 0 } }}>
          <Box sx={{ px: 2, py: 1.75, borderBottom: '1px solid #edf1f7' }}>
            <Stack
              direction={{ xs: 'column', xl: 'row' }}
              alignItems={{ xs: 'stretch', xl: 'center' }}
              justifyContent="space-between"
              spacing={1.5}
            >
              <Stack direction="row" alignItems="baseline" spacing={1.25}>
                <Typography variant="h6">待打单发货列表</Typography>
                <Typography variant="body2" color="text.secondary">
                  {orderSync.data?.fetchedAt
                    ? `已同步 ${formatOzonOrderDate(orderSync.data.fetchedAt)}`
                    : '等待读取 Ozon 订单'}
                </Typography>
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <TextField
                size="small"
                placeholder="搜索订单号 / 货号 / SKU"
                value={keyword}
                onChange={(event) => {
                  setKeyword(event.target.value);
                  resetSalesOrderListState();
                }}
                sx={{ width: { xs: '100%', sm: 320 } }}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchRounded fontSize="small" />
                    </InputAdornment>
                  ),
                }}
              />
              <FormControl size="small" sx={{ minWidth: 150 }}>
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
              <FormControl size="small" sx={{ minWidth: 120 }}>
                <Select
                  value={fulfillment}
                  onChange={(event) => {
                    setFulfillment(event.target.value);
                    resetSalesOrderListState();
                  }}
                >
                  <MenuItem value="all">全部履约</MenuItem>
                  <MenuItem value="FBS">FBS</MenuItem>
                  <MenuItem value="rFBS">rFBS</MenuItem>
                </Select>
              </FormControl>
              </Stack>
            </Stack>

            <Box
              sx={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 1,
                mt: 1.25,
              }}
            >
              <FormControl size="small" sx={{ minWidth: 132 }}>
                <Select
                  value={status}
                  inputProps={{ 'aria-label': '订单状态筛选' }}
                  onChange={(event) => {
                    setStatus(event.target.value);
                    resetSalesOrderListState();
                  }}
                >
                  <MenuItem value="等待发货">等待发货</MenuItem>
                  <MenuItem value="等待备货">等待备货</MenuItem>
                  <MenuItem value="即将超时">即将超时</MenuItem>
                  <MenuItem value="发货超时">发货超时</MenuItem>
                </Select>
              </FormControl>
              <FormControl size="small" sx={{ minWidth: 170 }}>
                <Select
                  value={activePrintShippingFilters.warehouse}
                  displayEmpty
                  inputProps={{ 'aria-label': '仓库筛选' }}
                  onChange={(event) => updatePrintShippingFilter('warehouse', event.target.value)}
                >
                  <MenuItem value="">全部仓库</MenuItem>
                  {warehouseOptions.map((item) => (
                    <MenuItem key={item.value} value={item.value}>{item.value}（{item.total}）</MenuItem>
                  ))}
                  <MenuItem value="__missing__">仓库未返回</MenuItem>
                </Select>
              </FormControl>
              <FormControl size="small" sx={{ minWidth: 170 }}>
                <Select
                  value={activePrintShippingFilters.deliveryMethod}
                  displayEmpty
                  inputProps={{ 'aria-label': '物流方式筛选' }}
                  onChange={(event) => updatePrintShippingFilter('deliveryMethod', event.target.value)}
                >
                  <MenuItem value="">全部物流方式</MenuItem>
                  {deliveryMethodOptions.map((item) => (
                    <MenuItem key={item.value} value={item.value}>{item.value}（{item.total}）</MenuItem>
                  ))}
                  <MenuItem value="__missing__">物流方式未返回</MenuItem>
                </Select>
              </FormControl>
              <FormControl size="small" sx={{ minWidth: 150 }}>
                <Select
                  value={activePrintShippingFilters.deadlineScope}
                  displayEmpty
                  inputProps={{ 'aria-label': '发货时限筛选' }}
                  onChange={(event) => updatePrintShippingFilter('deadlineScope', event.target.value)}
                >
                  <MenuItem value="">全部发货时限</MenuItem>
                  <MenuItem value="overdue">已经超时</MenuItem>
                  <MenuItem value="within24h">24 小时内</MenuItem>
                  <MenuItem value="later">24 小时后</MenuItem>
                  <MenuItem value="missing">时限未返回</MenuItem>
                </Select>
              </FormControl>
              <FormControl size="small" sx={{ minWidth: 158 }}>
                <Select
                  value={activePrintShippingFilters.trackingState}
                  displayEmpty
                  inputProps={{ 'aria-label': 'Ozon物流单号筛选' }}
                  onChange={(event) => updatePrintShippingFilter('trackingState', event.target.value)}
                >
                  <MenuItem value="">全部 Ozon 单号</MenuItem>
                  <MenuItem value="available">已有 Ozon 单号</MenuItem>
                  <MenuItem value="missing">缺少 Ozon 单号</MenuItem>
                </Select>
              </FormControl>
              <FormControl size="small" sx={{ minWidth: 150 }}>
                <Select
                  value={activePrintShippingFilters.carriageState}
                  displayEmpty
                  inputProps={{ 'aria-label': '交接批次筛选' }}
                  onChange={(event) => updatePrintShippingFilter('carriageState', event.target.value)}
                >
                  <MenuItem value="">全部交接状态</MenuItem>
                  <MenuItem value="assigned">已加入交接</MenuItem>
                  <MenuItem value="unassigned">未加入交接</MenuItem>
                </Select>
              </FormControl>
              <Button
                size="small"
                variant="text"
                onClick={resetPrintShippingFilters}
                disabled={!hasActivePrintShippingFilters(activePrintShippingFilters) && status === '等待发货'}
              >
                重置筛选
              </Button>
            </Box>
          </Box>

          {orderSync.error ? (
            <Alert severity="warning" sx={{ m: 2, mb: 0 }}>
              {String(orderSync.error?.message || orderSync.error)}
              {orderSync.stale ? '；当前保留上一次成功读取的数据。' : ''}
            </Alert>
          ) : null}

          <Stack
            direction="row"
            alignItems="center"
            spacing={1}
            sx={{ px: 2, py: 1.25, minHeight: 52, borderBottom: '1px solid #edf1f7' }}
          >
            <Typography variant="body2" fontWeight={700}>
              已选 {selectedSalesOrderCount} 个
            </Typography>
            <Typography variant="body2" color="text.secondary">
              本页 {visibleOrders.length} 条 / 共 {filteredOrderTotal} 条
            </Typography>
            <Button size="small" variant="outlined" onClick={toggleSalesOrderPageSelection} disabled={!visibleSalesOrderKeys.length}>
              {allSalesOrderPageSelected ? '取消本页' : '全选本页'}
            </Button>
            <Button size="small" variant="text" onClick={clearSalesOrderSelection} disabled={!selectedSalesOrderCount}>
              清空
            </Button>
          </Stack>

          <TableContainer sx={{ width: '100%', overflowX: 'auto' }}>
            <Table size="small" sx={{ minWidth: 1320, tableLayout: 'fixed' }} aria-label="待打单发货订单列表">
              <colgroup>
                <col style={{ width: 48 }} />
                <col style={{ width: 170 }} />
                <col style={{ width: 270 }} />
                <col style={{ width: 110 }} />
                <col style={{ width: 105 }} />
                <col style={{ width: 155 }} />
                <col style={{ width: 160 }} />
                <col style={{ width: 165 }} />
                <col style={{ width: 120 }} />
              </colgroup>
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox" sx={TABLE_HEAD_CELL_SX}>
                    <Checkbox
                      size="small"
                      checked={allSalesOrderPageSelected}
                      indeterminate={salesOrderPageSelectionIndeterminate}
                      onChange={toggleSalesOrderPageSelection}
                      disabled={!visibleSalesOrderKeys.length}
                    />
                  </TableCell>
                  <TableCell sx={TABLE_HEAD_CELL_SX}>Ozon 订单</TableCell>
                  <TableCell sx={TABLE_HEAD_CELL_SX}>商品</TableCell>
                  <TableCell sx={TABLE_HEAD_CELL_SX}>店铺</TableCell>
                  <TableCell sx={TABLE_HEAD_CELL_SX}>来源平台</TableCell>
                  <TableCell sx={TABLE_HEAD_CELL_SX}>国内采购单号</TableCell>
                  <TableCell sx={TABLE_HEAD_CELL_SX}>国内物流单号</TableCell>
                  <TableCell sx={TABLE_HEAD_CELL_SX}>Ozon 物流单号</TableCell>
                  <TableCell sx={TABLE_HEAD_CELL_SX}>状态</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {renderedOrders.map((order) => {
                  const orderKey = getSalesOrderRecordKey(order);
                  const firstProduct = getFirstProduct(order);
                  const fields = resolvePrintShippingOrderFields(
                    order,
                    getOrderPurchaseShippingInfo(order)
                  );
                  return (
                    <TableRow key={orderKey} hover sx={{ height: 72 }}>
                      <TableCell padding="checkbox" sx={TABLE_BODY_CELL_SX}>
                        <Checkbox
                          size="small"
                          checked={selectedSalesOrderKeys.has(orderKey)}
                          onChange={() => toggleSalesOrderSelection(order)}
                        />
                      </TableCell>
                      <TableCell sx={TABLE_BODY_CELL_SX}>
                        <Typography variant="body2" fontWeight={700} noWrap title={order.id}>
                          {order.id}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" noWrap display="block">
                          {order.fulfillment || 'FBS'} · {order.deadline || '未返回'}
                        </Typography>
                      </TableCell>
                      <TableCell sx={TABLE_BODY_CELL_SX}>
                        <Typography
                          component="button"
                          type="button"
                          variant="body2"
                          noWrap
                          title={`${order.product || '未返回'}｜打开 Ozon 商品页面`}
                          onClick={() => openSalesOzonProductPage(order, firstProduct)}
                          sx={{
                            display: 'block',
                            width: '100%',
                            p: 0,
                            border: 0,
                            background: 'none',
                            color: '#1f2937',
                            fontWeight: 700,
                            textAlign: 'left',
                            cursor: 'pointer',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            '&:hover': { color: 'primary.main' },
                          }}
                        >
                          {order.product || '未返回'}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" noWrap display="block">
                          {compactValue(firstProduct.offerId, order.sku || '未返回')} · x{order.items || 1}
                        </Typography>
                      </TableCell>
                      <TableCell sx={TABLE_BODY_CELL_SX}>
                        <Typography variant="body2" noWrap title={order.shop}>
                          {order.shop}
                        </Typography>
                      </TableCell>
                      <TableCell sx={TABLE_BODY_CELL_SX}>
                        <Typography variant="body2" noWrap title={fields.sourcePlatform}>
                          {fields.sourcePlatform}
                        </Typography>
                      </TableCell>
                      <TableCell sx={TABLE_BODY_CELL_SX}>
                        <Typography variant="body2" noWrap title={fields.purchaseOrderNumber}>
                          {fields.purchaseOrderNumber}
                        </Typography>
                      </TableCell>
                      <TableCell sx={TABLE_BODY_CELL_SX}>
                        <Typography variant="body2" noWrap title={fields.domesticTrackingNumber}>
                          {fields.domesticTrackingNumber}
                        </Typography>
                      </TableCell>
                      <TableCell sx={TABLE_BODY_CELL_SX}>
                        <Typography variant="body2" noWrap title={fields.ozonTrackingNumber}>
                          {fields.ozonTrackingNumber}
                        </Typography>
                      </TableCell>
                      <TableCell sx={TABLE_BODY_CELL_SX}>
                        <Chip size="small" color={order.tone} label={order.status} variant="outlined" />
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!orderSync.loading && filteredOrderTotal === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} sx={{ py: 7, border: 0 }}>
                      <Typography variant="body2" color="text.secondary" align="center">
                        {readableShops.length ? '当前没有待打单发货的订单' : '请先在设置里配置 Ozon 店铺'}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </TableContainer>

          {filteredOrderTotal > 0 ? (
            <Stack
              direction="row"
              alignItems="center"
              justifyContent="space-between"
              sx={{ px: 2, py: 1.5, borderTop: '1px solid #edf1f7' }}
            >
              <Typography variant="body2" color="text.secondary">
                共 {filteredOrderTotal} 条，当前 {salesOrderRangeStart}-{salesOrderRangeEnd}
              </Typography>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Typography variant="body2" color="text.secondary">每页</Typography>
                <FormControl size="small" sx={{ minWidth: 92 }}>
                  <Select
                    value={String(salesOrderPageSize)}
                    onChange={(event) => {
                      setSalesOrderPageSize(Number(event.target.value));
                      setSalesOrderPage(1);
                    }}
                  >
                    {SALES_ORDER_PAGE_SIZE_OPTIONS.map((size) => (
                      <MenuItem key={size} value={String(size)}>{size} / 页</MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <Pagination
                  size="small"
                  shape="rounded"
                  page={currentSalesOrderPage}
                  count={salesOrderTotalPages}
                  onChange={(_, value) => setSalesOrderPage(value)}
                />
              </Stack>
            </Stack>
          ) : null}
        </CardContent>
      </Card>

      <Snackbar
        open={Boolean(salesNotice.open)}
        autoHideDuration={4500}
        onClose={() => setSalesNotice((current) => ({ ...current, open: false }))}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity={salesNotice.severity || 'success'}
          variant="filled"
          onClose={() => setSalesNotice((current) => ({ ...current, open: false }))}
        >
          {salesNotice.message}
        </Alert>
      </Snackbar>
    </Stack>
  );
}
