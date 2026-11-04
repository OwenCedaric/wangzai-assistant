import { safeImageUrl } from '../../../../entities/product/productWriteHelpers.jsx';
import { purchaseOrderManualClassifyOptions, purchaseOrderStatusTones } from '../lib/purchaseMarketingApi.jsx';
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormLabel from '@mui/material/FormLabel';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Popover from '@mui/material/Popover';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { MinimizableDialogTitle } from '../../../../shared/ui/minimizedTasks/MinimizableDialogTitle.jsx';
import { useMinimizableDialogTask } from '../../../../shared/ui/minimizedTasks/useMinimizableDialogTask.js';
import { PurchaseOrderWorkbenchDialog } from '../components/PurchaseOrderWorkbenchDialog.jsx';
import { PurchaseForecastStepper } from '../components/PurchaseForecastStepper.jsx';

export function PurchaseOrdersDialogs({ model }) {
  const {
    status,
    purchaseNotice,
    setPurchaseNotice,
    purchaseOperation,
    setPurchaseOperation,
    transferPendingDialog,
    setTransferPendingDialog,
    manualClassifyDialog,
    setManualClassifyDialog,
    sourceSearchDialog,
    selectedOrder,
    closeSourceSearchDialog,
    openSourceSearchUrl,
    copySourceSearchImageUrl,
    downloadSourceSearchImage,
    closePurchaseOperation,
    updatePurchaseOperationField,
    updatePurchaseCancelReason,
    applyTransferOrderToPending,
    handleManualClassifySelect,
    confirmManualClassifyPending,
    purchaseOperationMeta,
    canSubmitPurchaseOperation,
    purchaseForecastFlow,
    purchaseForecastExecutionMode,
    canPreparePurchaseForecastOzon,
    canCheckPurchaseForecastLabel,
    canSubmitPurchaseForecast,
    canRunPurchaseForecastAuto,
    updatePurchaseForecastExecutionMode,
    executePurchaseForecastOzonPrepare,
    executePurchaseForecastLabelCheck,
    executePurchaseForecastSubmit,
    executePurchaseForecastAuto,
    executePurchaseOperation,
    purchaseOrderWorkbenchDialog,
    startPurchaseOrderWorkbenchBrowser,
    closePurchaseOrderWorkbench,
    minimizePurchaseOrderWorkbench,
    retryPurchaseOrderWorkbench,
    navigatePurchaseOrderWorkbench,
    runPurchaseOrderWorkbenchToolbarAction,
    readPurchaseOrderWorkbenchPaymentInfo,
    refreshPurchaseOrderWorkbenchStatus,
    savePurchaseOrderWorkbenchInfo,
  } = model;
  const isPurchaseBatchCancel = purchaseOperation.type === 'ozonBatchCancel';
  const isPurchaseForecast = purchaseOperation.type === 'createForecast';
  const purchaseForecastServiceOptions = Array.isArray(purchaseOperation.fields?.forecastServiceOptions)
    ? purchaseOperation.fields.forecastServiceOptions
    : [];
  const purchaseForecastRequiredServices = purchaseForecastServiceOptions.filter(
    (option) => option.selectionType === 'required',
  );
  const purchaseForecastOptionalServices = purchaseForecastServiceOptions.filter(
    (option) => option.selectionType === 'optional',
  );
  const purchaseForecastOptionalServiceIds = Array.isArray(purchaseOperation.fields?.optionalServiceIds)
    ? purchaseOperation.fields.optionalServiceIds.map(String)
    : [];
  const purchaseOperationOrders = Array.isArray(purchaseOperation.orders) ? purchaseOperation.orders : [];
  const purchaseBatchOrderPreview = purchaseOperationOrders
    .slice(0, 3)
    .map((order) => order?.id)
    .filter(Boolean)
    .join('、');
  const selectedOrderNumber = String(
    purchaseOperation.order?.id
    || selectedOrder.id
    || transferPendingDialog.order?.id
    || '',
  ).trim();
  const sourceSearchTask = useMinimizableDialogTask({
    open: sourceSearchDialog.open,
    kind: 'purchase-source-search',
    title: `${sourceSearchDialog.platform || '采购平台'} 搜款`,
    subtitle: String(selectedOrder.id || '').trim(),
    onClose: closeSourceSearchDialog,
  });
  const purchaseOperationTask = useMinimizableDialogTask({
    open: purchaseOperation.open,
    kind: 'purchase-operation',
    title: purchaseOperationMeta.title || '采购操作',
    subtitle: isPurchaseBatchCancel
      ? `${purchaseOperationOrders.length} 个订单`
      : selectedOrderNumber,
    onClose: closePurchaseOperation,
  });
  const transferPendingTask = useMinimizableDialogTask({
    open: transferPendingDialog.open,
    kind: 'purchase-transfer-pending',
    title: '转待拍单',
    subtitle: String(transferPendingDialog.order?.id || '').trim(),
    onClose: () => setTransferPendingDialog({ open: false, order: null }),
  });

  return (
    <>
      <PurchaseOrderWorkbenchDialog
        dialog={purchaseOrderWorkbenchDialog}
        onClose={closePurchaseOrderWorkbench}
        onMinimize={minimizePurchaseOrderWorkbench}
        onViewportReady={startPurchaseOrderWorkbenchBrowser}
        onRetry={retryPurchaseOrderWorkbench}
        onNavigate={navigatePurchaseOrderWorkbench}
        onToolbarAction={runPurchaseOrderWorkbenchToolbarAction}
        onReadPaymentInfo={readPurchaseOrderWorkbenchPaymentInfo}
        onRefreshOrderStatus={refreshPurchaseOrderWorkbenchStatus}
        onSavePurchaseInfo={savePurchaseOrderWorkbenchInfo}
      />

      <Dialog open={sourceSearchTask.visibleOpen} onClose={sourceSearchTask.close} maxWidth="sm" fullWidth>
        <MinimizableDialogTitle
          title={`${sourceSearchDialog.platform || '采购平台'} 搜款`}
          subtitle={String(selectedOrder.id || '').trim()}
          onMinimize={sourceSearchTask.minimize}
          onClose={sourceSearchTask.close}
          minimizeLabel="最小化搜款弹窗"
          closeLabel="关闭搜款弹窗"
        />
        <DialogContent>
          <Stack spacing={1.5} mt={0.5}>
            <Alert severity={sourceSearchDialog.severity || 'info'}>{sourceSearchDialog.title}</Alert>
            {sourceSearchDialog.loading ? <LinearProgress /> : null}
            {sourceSearchDialog.imageUrl ? (
              <Box className="source-search-image-preview">
                <Box component="img" src={sourceSearchDialog.imageUrl} alt="搜款图片" />
                <Typography variant="caption" color="text.secondary">
                  当前使用商品图搜款，不使用 Ozon 标题搜索。
                </Typography>
              </Box>
            ) : null}
            <Stack spacing={1}>
              {sourceSearchDialog.results.map((item, index) => {
                const resultImage = safeImageUrl(item.image);
                return (
                  <Box key={`${item.title}-${index}`} className="source-search-result-row">
                    {resultImage ? (
                      <Box component="img" src={resultImage} alt="" loading="lazy" referrerPolicy="no-referrer" />
                    ) : (
                      <Box className="source-search-result-image-empty">
                        <Inventory2Rounded fontSize="small" />
                      </Box>
                    )}
                    <Box flex={1} minWidth={0}>
                      <Typography variant="subtitle1" noWrap title={item.title}>
                        {item.title}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {item.hint}
                      </Typography>
                    </Box>
                    <Button
                      size="small"
                      variant="outlined"
                      disabled={!item.link}
                      onClick={() => openSourceSearchUrl(item.link)}
                    >
                      打开商品
                    </Button>
                  </Box>
                );
              })}
              {!sourceSearchDialog.loading && !sourceSearchDialog.results.length ? (
                <Typography variant="body2" color="text.secondary">
                  {sourceSearchDialog.externalOnly
                    ? '已打开平台页面，请使用当前商品图进行以图搜款；软件不会自动下单或付款。'
                    : '暂无可展示商品结果。请按提示处理，不会自动下单或付款。'}
                </Typography>
              ) : null}
            </Stack>
          </Stack>
        </DialogContent>
        <DialogActions>
          {sourceSearchDialog.imageUrl ? (
            <>
              <Button onClick={copySourceSearchImageUrl}>复制图片链接</Button>
              <Button onClick={downloadSourceSearchImage}>下载图片</Button>
            </>
          ) : null}
          <Button onClick={closeSourceSearchDialog}>关闭</Button>
          <Button
            variant="contained"
            disabled={!sourceSearchDialog.searchUrl}
            onClick={() => openSourceSearchUrl(sourceSearchDialog.searchUrl)}
          >
            打开完整搜索页
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={purchaseOperationTask.visibleOpen}
        onClose={purchaseOperationTask.close}
        maxWidth={isPurchaseForecast ? 'md' : 'sm'}
        fullWidth
      >
        <MinimizableDialogTitle
          title={purchaseOperationMeta.title}
          subtitle={isPurchaseBatchCancel ? `${purchaseOperationOrders.length} 个订单` : selectedOrderNumber}
          disabled={purchaseOperation.loading || purchaseOperation.autoRunning}
          onMinimize={purchaseOperationTask.minimize}
          onClose={purchaseOperationTask.close}
          minimizeLabel="最小化采购操作弹窗"
          closeLabel="关闭采购操作弹窗"
        />
        <DialogContent>
          <Stack spacing={2} mt={0.5}>
            {!isPurchaseForecast ? (
              <Alert severity={purchaseOperationMeta.color === 'error' ? 'error' : 'warning'}>
                {purchaseOperationMeta.body}
              </Alert>
            ) : null}
            <Box>
              <Typography variant="caption" color="text.secondary">
                {isPurchaseBatchCancel ? '本次批量订单' : '当前订单'}
              </Typography>
              <Typography variant="subtitle1">
                {isPurchaseBatchCancel
                  ? `已选 ${purchaseOperation.selectedCount || purchaseOperationOrders.length} 个，可提交 ${purchaseOperationOrders.length} 个`
                  : purchaseOperation.order?.id || selectedOrder.id || '未返回'}
              </Typography>
              {isPurchaseBatchCancel && purchaseBatchOrderPreview ? (
                <Typography variant="body2" color="text.secondary">
                  {purchaseBatchOrderPreview}
                  {purchaseOperationOrders.length > 3 ? ` 等 ${purchaseOperationOrders.length} 个订单` : ''}
                </Typography>
              ) : null}
            </Box>
            {isPurchaseBatchCancel && purchaseOperation.excludedCount ? (
              <Alert severity="info">
                已排除 {purchaseOperation.excludedCount} 个不满足状态、拆单或店铺归属核验的订单，这些订单不会提交。
              </Alert>
            ) : null}

            {purchaseOperation.type === 'createForecast' ? (
              <>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                  <TextField
                    size="small"
                    label="Ozon 货件号"
                    value={purchaseOperation.fields.orderNumber || ''}
                    InputProps={{ readOnly: true }}
                    helperText="用于防重和预报，不允许手改"
                    fullWidth
                  />
                  <TextField
                    size="small"
                    label="目的国家"
                    value={purchaseOperation.fields.country || ''}
                    onChange={updatePurchaseOperationField('country')}
                    fullWidth
                  />
                </Stack>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                  <TextField
                    select
                    size="small"
                    label="创建类型"
                    value={purchaseOperation.fields.dataStatus || '1'}
                    onChange={updatePurchaseOperationField('dataStatus')}
                    disabled
                    fullWidth
                  >
                    <MenuItem value="1">正式单</MenuItem>
                  </TextField>
                  <TextField
                    select
                    size="small"
                    label="采购平台"
                    value={purchaseOperation.fields.purchasePlatform || '3'}
                    onChange={updatePurchaseOperationField('purchasePlatform')}
                    fullWidth
                  >
                    <MenuItem value="">请选择采购平台</MenuItem>
                    <MenuItem value="3">拼多多</MenuItem>
                    <MenuItem value="1">1688</MenuItem>
                    <MenuItem value="2">淘宝</MenuItem>
                  </TextField>
                </Stack>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                  <TextField
                    size="small"
                    label="采购订单号"
                    value={purchaseOperation.fields.purchaseOrderNo || ''}
                    onChange={updatePurchaseOperationField('purchaseOrderNo')}
                    fullWidth
                  />
                  <TextField
                    size="small"
                    label="国内快递单号"
                    value={purchaseOperation.fields.logisticsOrder || ''}
                    onChange={updatePurchaseOperationField('logisticsOrder')}
                    fullWidth
                  />
                </Stack>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                  <TextField
                    size="small"
                    label="包裹数量"
                    value={purchaseOperation.fields.packageQty || ''}
                    onChange={updatePurchaseOperationField('packageQty')}
                    fullWidth
                  />
                  <TextField
                    size="small"
                    label="包裹说明"
                    value={purchaseOperation.fields.packageDesc || ''}
                    onChange={updatePurchaseOperationField('packageDesc')}
                    fullWidth
                  />
                </Stack>
                <TextField
                  size="small"
                  label="备注"
                  value={purchaseOperation.fields.remark || ''}
                  onChange={updatePurchaseOperationField('remark')}
                  fullWidth
                />
                <Box className="purchase-forecast-service-options">
                  <Typography variant="subtitle1" fontWeight={700}>预报服务选择</Typography>
                  <Typography variant="body2" color="text.secondary">
                    必选服务只能选择一项；增值服务可按本次订单多选。实际提交前仍需勾选确认真实写入。
                  </Typography>
                  {purchaseOperation.serviceOptionsLoading ? (
                    <Alert severity="info" sx={{ mt: 1.5 }}>正在读取当前仓库的实时服务选项…</Alert>
                  ) : null}
                  {purchaseOperation.serviceOptionsError ? (
                    <Alert severity="error" sx={{ mt: 1.5 }}>
                      读取服务选项失败：{purchaseOperation.serviceOptionsError}
                    </Alert>
                  ) : null}
                  {!purchaseOperation.serviceOptionsLoading && !purchaseOperation.serviceOptionsError ? (
                    <Stack spacing={1.5} mt={1.5}>
                      <FormControl disabled={purchaseOperation.loading || purchaseOperation.autoRunning}>
                        <FormLabel>必选打包服务</FormLabel>
                        <RadioGroup
                          value={purchaseOperation.fields?.requiredServiceId || ''}
                          onChange={(event) => setPurchaseOperation((current) => ({
                            ...current,
                            fields: { ...current.fields, requiredServiceId: event.target.value },
                          }))}
                        >
                          {purchaseForecastRequiredServices.map((option) => (
                            <FormControlLabel
                              key={option.id}
                              value={option.id}
                              control={<Radio size="small" />}
                              label={option.label}
                            />
                          ))}
                        </RadioGroup>
                      </FormControl>
                      <FormControl disabled={purchaseOperation.loading || purchaseOperation.autoRunning}>
                        <FormLabel>可选增值服务</FormLabel>
                        <Stack spacing={0.25} mt={0.5}>
                          {purchaseForecastOptionalServices.length ? purchaseForecastOptionalServices.map((option) => (
                            <FormControlLabel
                              key={option.id}
                              control={(
                                <Checkbox
                                  size="small"
                                  checked={purchaseForecastOptionalServiceIds.includes(option.id)}
                                  onChange={(event) => setPurchaseOperation((current) => {
                                    const currentIds = Array.isArray(current.fields?.optionalServiceIds)
                                      ? current.fields.optionalServiceIds.map(String)
                                      : [];
                                    const optionalServiceIds = event.target.checked
                                      ? [...new Set([...currentIds, option.id])]
                                      : currentIds.filter((id) => id !== option.id);
                                    return {
                                      ...current,
                                      fields: { ...current.fields, optionalServiceIds },
                                    };
                                  })}
                                />
                              )}
                              label={option.label}
                            />
                          )) : (
                            <Typography variant="body2" color="text.secondary">当前仓库没有返回可选增值服务。</Typography>
                          )}
                        </Stack>
                      </FormControl>
                    </Stack>
                  ) : null}
                </Box>
              </>
            ) : null}

            {purchaseOperation.type === 'updateSheet' ? (
              <>
                <TextField
                  size="small"
                  label="巴士订单号"
                  value={purchaseOperation.fields.orderNumber || ''}
                  onChange={updatePurchaseOperationField('orderNumber')}
                  fullWidth
                />
                <TextField
                  size="small"
                  label="新面单号"
                  value={purchaseOperation.fields.sheetOrderSn || ''}
                  onChange={updatePurchaseOperationField('sheetOrderSn')}
                  fullWidth
                />
                <TextField
                  size="small"
                  label="面单文件链接"
                  value={purchaseOperation.fields.sheetUrl || ''}
                  onChange={updatePurchaseOperationField('sheetUrl')}
                  fullWidth
                />
              </>
            ) : null}

            {purchaseOperation.type === 'updatePackage' ? (
              <>
                <TextField
                  size="small"
                  label="巴士订单 ID"
                  value={purchaseOperation.fields.orderId || ''}
                  onChange={updatePurchaseOperationField('orderId')}
                  fullWidth
                />
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                  <TextField
                    select
                    size="small"
                    label="采购平台"
                    value={purchaseOperation.fields.purchasePlatform || '3'}
                    onChange={updatePurchaseOperationField('purchasePlatform')}
                    fullWidth
                  >
                    <MenuItem value="">请选择采购平台</MenuItem>
                    <MenuItem value="3">拼多多</MenuItem>
                    <MenuItem value="1">1688</MenuItem>
                    <MenuItem value="2">淘宝</MenuItem>
                  </TextField>
                  <TextField
                    size="small"
                    label="包裹数量"
                    value={purchaseOperation.fields.packageQty || ''}
                    onChange={updatePurchaseOperationField('packageQty')}
                    fullWidth
                  />
                </Stack>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                  <TextField
                    size="small"
                    label="采购订单号"
                    value={purchaseOperation.fields.purchaseOrderNo || ''}
                    onChange={updatePurchaseOperationField('purchaseOrderNo')}
                    fullWidth
                  />
                  <TextField
                    size="small"
                    label="国内快递单号"
                    value={purchaseOperation.fields.logisticsOrder || ''}
                    onChange={updatePurchaseOperationField('logisticsOrder')}
                    fullWidth
                  />
                </Stack>
                <TextField
                  size="small"
                  label="包裹说明"
                  value={purchaseOperation.fields.packageDesc || ''}
                  onChange={updatePurchaseOperationField('packageDesc')}
                  fullWidth
                />
              </>
            ) : null}

            {purchaseOperation.type === 'cancelCrossBorder' ? (
              <TextField
                size="small"
                label="巴士订单号"
                value={purchaseOperation.fields.orderNumber || ''}
                onChange={updatePurchaseOperationField('orderNumber')}
                fullWidth
              />
            ) : null}

            {['ozonCancel', 'ozonBatchCancel'].includes(purchaseOperation.type) ? (
              <TextField
                select
                size="small"
                label="取消原因"
                value={purchaseOperation.fields.cancelReasonId || ''}
                onChange={updatePurchaseCancelReason}
                disabled={purchaseOperation.cancelReasonsLoading || Boolean(purchaseOperation.cancelReasonsError)}
                helperText={
                  purchaseOperation.cancelReasonsLoading
                    ? '正在读取可用取消原因'
                    : purchaseOperation.cancelReasonsError || '请选择平台允许的取消原因'
                }
                fullWidth
              >
                <MenuItem value="" disabled>
                  {purchaseOperation.cancelReasonsLoading ? '正在读取' : '请选择取消原因'}
                </MenuItem>
                {purchaseOperation.cancelReasons.map((reason) => (
                  <MenuItem key={reason.id} value={reason.id}>
                    {reason.label}
                  </MenuItem>
                ))}
              </TextField>
            ) : null}

            {isPurchaseForecast ? (
              <Box sx={{ order: -1 }}>
                <PurchaseForecastStepper
                  flow={purchaseForecastFlow}
                  executionMode={purchaseForecastExecutionMode}
                  loading={purchaseOperation.loading}
                  autoRunning={purchaseOperation.autoRunning}
                  activeStep={purchaseOperation.activeForecastStep}
                  confirmed={purchaseOperation.confirmed}
                  message={purchaseOperation.forecastMessage}
                  canPrepare={canPreparePurchaseForecastOzon}
                  canCheckLabel={canCheckPurchaseForecastLabel}
                  canSubmit={canSubmitPurchaseForecast}
                  canRunAuto={canRunPurchaseForecastAuto}
                  onExecutionModeChange={updatePurchaseForecastExecutionMode}
                  onPrepare={executePurchaseForecastOzonPrepare}
                  onCheckLabel={executePurchaseForecastLabelCheck}
                  onSubmit={executePurchaseForecastSubmit}
                  onAutoRun={executePurchaseForecastAuto}
                />
              </Box>
            ) : null}

            <FormControlLabel
              control={
                <Checkbox
                  checked={purchaseOperation.confirmed}
                  onChange={(event) =>
                    setPurchaseOperation((current) => ({
                      ...current,
                      confirmed: event.target.checked,
                    }))
                  }
                  disabled={purchaseOperation.loading || purchaseOperation.autoRunning}
                />
              }
              label={isPurchaseBatchCancel ? '我确认逐个提交这些订单到 Ozon' : '我确认执行这次真实写入'}
            />
            {purchaseOperation.error ? <Alert severity="error">{purchaseOperation.error}</Alert> : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closePurchaseOperation} disabled={purchaseOperation.loading || purchaseOperation.autoRunning}>
            先不操作
          </Button>
          {!isPurchaseForecast ? (
            <Button
              variant="contained"
              color={purchaseOperationMeta.color}
              onClick={executePurchaseOperation}
              disabled={!canSubmitPurchaseOperation}
            >
              {purchaseOperation.loading ? '提交中' : purchaseOperationMeta.confirmText}
            </Button>
          ) : null}
        </DialogActions>
      </Dialog>

      <Dialog
        open={transferPendingTask.visibleOpen}
        onClose={transferPendingTask.close}
        maxWidth="xs"
        fullWidth
      >
        <MinimizableDialogTitle
          title="转待拍单"
          subtitle={String(transferPendingDialog.order?.id || '').trim()}
          onMinimize={transferPendingTask.minimize}
          onClose={transferPendingTask.close}
          minimizeLabel="最小化转待拍单弹窗"
          closeLabel="关闭转待拍单弹窗"
        />
        <DialogContent>
          <Stack spacing={2} mt={0.5}>
            <Alert severity="warning">
              当前订单已有采购记录。请先确认采购平台订单已经退款或关闭；确认后只作废本地采购记录，并转回待拍单。
            </Alert>
            <Box>
              <Typography variant="caption" color="text.secondary">
                采购订单号
              </Typography>
              <Typography variant="subtitle1">{transferPendingDialog.order?.purchaseOrderNo || '未返回'}</Typography>
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setTransferPendingDialog({ open: false, order: null })}>先不操作</Button>
          <Button
            variant="contained"
            color="warning"
            onClick={() => {
              const order = transferPendingDialog.order;
              setTransferPendingDialog({ open: false, order: null });
              if (order) applyTransferOrderToPending(order);
            }}
          >
            我已退款，转待拍单
          </Button>
        </DialogActions>
      </Dialog>

      <Popover
        open={manualClassifyDialog.open}
        anchorEl={manualClassifyDialog.anchorEl}
        onClose={() => setManualClassifyDialog({ open: false, order: null, anchorEl: null, pendingOption: null })}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        PaperProps={{
          sx: {
            width: 360,
            maxWidth: 'calc(100vw - 32px)',
            p: 2,
            borderRadius: 2,
            boxShadow: '0 18px 45px rgba(15, 23, 42, 0.18)',
          },
        }}
      >
        <Stack spacing={1.5}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
            <Typography variant="subtitle1" fontWeight={800}>
              手动归类
            </Typography>
            <Button
              size="small"
              onClick={() => setManualClassifyDialog({ open: false, order: null, anchorEl: null, pendingOption: null })}
            >
              取消
            </Button>
          </Stack>
          <Alert severity={manualClassifyDialog.pendingOption ? 'warning' : 'info'} sx={{ py: 0.75 }}>
            {manualClassifyDialog.pendingOption
              ? '这是高风险归类，只改本地标签，不会修改 Ozon 或跨境巴士。'
              : '只修改旺崽助手本地标签显示，不修改 Ozon 状态，不修改跨境巴士订单。'}
          </Alert>
          <Box>
            <Typography variant="caption" color="text.secondary">
              Ozon 真实状态
            </Typography>
            <Typography variant="subtitle2" fontWeight={800}>
              {manualClassifyDialog.order?.ozonStatusLabel || '未返回'}
            </Typography>
          </Box>
          {manualClassifyDialog.pendingOption ? (
            <Stack spacing={1}>
              <Typography variant="body2" color="text.secondary">
                确认人工归类到「{manualClassifyDialog.pendingOption.value}」？
              </Typography>
              <Stack direction="row" spacing={1}>
                <Button
                  fullWidth
                  variant="outlined"
                  onClick={() => setManualClassifyDialog((current) => ({ ...current, pendingOption: null }))}
                >
                  返回
                </Button>
                <Button fullWidth variant="contained" color="warning" onClick={confirmManualClassifyPending}>
                  确认归类
                </Button>
              </Stack>
            </Stack>
          ) : (
            <Stack spacing={1}>
              {purchaseOrderManualClassifyOptions.map((option) => (
                <Button
                  key={option.value}
                  variant={manualClassifyDialog.order?.status === option.value ? 'contained' : 'outlined'}
                  color={
                    purchaseOrderStatusTones[option.value] === 'default'
                      ? 'primary'
                      : purchaseOrderStatusTones[option.value] || 'primary'
                  }
                  onClick={() => handleManualClassifySelect(option.value)}
                  fullWidth
                >
                  {option.label}
                </Button>
              ))}
            </Stack>
          )}
        </Stack>
      </Popover>

      <Snackbar
        open={purchaseNotice.open}
        autoHideDuration={3200}
        onClose={() => setPurchaseNotice((current) => ({ ...current, open: false }))}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity={purchaseNotice.severity}
          onClose={() => setPurchaseNotice((current) => ({ ...current, open: false }))}
          variant="filled"
        >
          {purchaseNotice.message}
        </Alert>
      </Snackbar>
    </>
  );
}
