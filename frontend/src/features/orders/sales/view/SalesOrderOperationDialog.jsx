import {
  formatSalesOrderSplitPlan,
  getSalesOrderSplitOfferText,
  getSalesOrderSplitProductTitle,
  getSalesPostingNumber,
} from '../../../../entities/marketing/marketingOrderFields.jsx';
import { SalesOrderProductImagePreview } from '../ui/SalesOrderProductImagePreview.jsx';
import AddRounded from '@mui/icons-material/AddRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import RemoveRounded from '@mui/icons-material/RemoveRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { MinimizableDialogTitle } from '../../../../shared/ui/minimizedTasks/MinimizableDialogTitle.jsx';
import { useMinimizableDialogTask } from '../../../../shared/ui/minimizedTasks/useMinimizableDialogTask.js';

/** Loaded only after an operator opens an Ozon write-operation dialog. */
export function SalesOrderOperationDialog({
  salesOperation,
  closeSalesOperation,
  isSplitSalesOperation,
  operationMeta,
  splitOperationOrder,
  splitValidation,
  addSalesSplitPackage,
  splitPackages,
  removeSalesSplitPackage,
  updateSalesSplitPackageQuantity,
  operationOrders,
  updateSalesCancelReason,
  executeSalesOperation,
  canSubmitSalesOperation,
}) {
  const taskSubtitle = operationOrders.length > 1
    ? `${operationOrders.length} 个订单`
    : getSalesPostingNumber(salesOperation.order) || '';
  const dialogTask = useMinimizableDialogTask({
    open: salesOperation.open,
    kind: 'sales-order-operation',
    title: operationMeta.title || '销售订单操作',
    subtitle: taskSubtitle,
    onClose: closeSalesOperation,
  });

  return (
    <Dialog
      open={dialogTask.visibleOpen}
      onClose={dialogTask.close}
      maxWidth={isSplitSalesOperation ? 'md' : 'xs'}
      fullWidth
      className={isSplitSalesOperation ? 'sales-order-split-dialog' : undefined}
    >
      <MinimizableDialogTitle
        title={operationMeta.title}
        subtitle={taskSubtitle}
        disabled={salesOperation.loading}
        onMinimize={dialogTask.minimize}
        onClose={dialogTask.close}
        minimizeLabel="最小化销售订单弹窗"
        closeLabel="关闭销售订单弹窗"
      />
      <DialogContent>
        {isSplitSalesOperation ? (
          <Stack spacing={2} mt={0.5} className="sales-split-dialog-body">
            <Box className="sales-split-source-card">
              <Box className="sales-split-source-product">
                <SalesOrderProductImagePreview order={splitOperationOrder || {}} />
                <Box minWidth={0}>
                  <Typography variant="subtitle1" noWrap title={getSalesOrderSplitProductTitle(splitOperationOrder)}>
                    {getSalesOrderSplitProductTitle(splitOperationOrder)}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" display="block" noWrap>
                    订单号：{getSalesPostingNumber(splitOperationOrder) || '未返回'} · 货号：
                    {getSalesOrderSplitOfferText(splitOperationOrder)}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" display="block">
                    原订单数量 {splitValidation.total || 0} 件，拆单后不会自动备货、取消、拍单或跨境巴士预报。
                  </Typography>
                </Box>
              </Box>
              <Chip
                size="small"
                color={splitValidation.valid ? 'success' : 'warning'}
                variant="outlined"
                label={`已分配 ${splitValidation.sum || 0}/${splitValidation.total || 0}`}
              />
            </Box>

            <Box className="sales-split-package-board">
              <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} mb={1.25}>
                <Box>
                  <Typography variant="subtitle1">拆单货件</Typography>
                  <Typography variant="caption" color="text.secondary">
                    点击“新增货件”后，系统会从数量最多的货件中划出 1 件。
                  </Typography>
                </Box>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<AddRounded />}
                  onClick={addSalesSplitPackage}
                  disabled={salesOperation.loading || splitPackages.length >= splitValidation.total}
                >
                  新增货件
                </Button>
              </Stack>
              <Box className="sales-split-package-list">
                {splitPackages.map((quantity, index) => (
                  <Box className="sales-split-package-card" key={`${index}-${quantity}`}>
                    <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
                      <Box>
                        <Typography variant="subtitle1">第 {index + 1} 单</Typography>
                        <Typography variant="caption" color="text.secondary">
                          Ozon 将生成独立货件
                        </Typography>
                      </Box>
                      <IconButton
                        size="small"
                        onClick={() => removeSalesSplitPackage(index)}
                        disabled={salesOperation.loading || splitPackages.length <= 1}
                        aria-label={`移除第 ${index + 1} 单`}
                      >
                        <CloseRounded fontSize="small" />
                      </IconButton>
                    </Stack>
                    <Box className="sales-split-quantity-row">
                      <Typography variant="body2" color="text.secondary">
                        数量
                      </Typography>
                      <Box className="sales-split-stepper">
                        <IconButton
                          size="small"
                          onClick={() => updateSalesSplitPackageQuantity(index, quantity - 1)}
                          disabled={salesOperation.loading || quantity <= 1 || splitPackages.length <= 1}
                        >
                          <RemoveRounded fontSize="small" />
                        </IconButton>
                        <TextField
                          size="small"
                          type="number"
                          value={quantity}
                          onChange={(event) => updateSalesSplitPackageQuantity(index, event.target.value)}
                          inputProps={{ min: 1, step: 1 }}
                        />
                        <IconButton
                          size="small"
                          onClick={() => updateSalesSplitPackageQuantity(index, quantity + 1)}
                          disabled={salesOperation.loading || splitPackages.length <= 1}
                        >
                          <AddRounded fontSize="small" />
                        </IconButton>
                      </Box>
                    </Box>
                  </Box>
                ))}
              </Box>
            </Box>

            <Alert severity={splitValidation.valid ? 'success' : 'warning'} className="sales-split-validation-alert">
              {splitValidation.valid
                ? `可提交：${formatSalesOrderSplitPlan(splitValidation.parts)}。`
                : splitValidation.reason}
            </Alert>
            {salesOperation.error ? (
              <Alert severity="error">{String(salesOperation.error?.message || salesOperation.error)}</Alert>
            ) : null}
          </Stack>
        ) : (
          <Stack spacing={2} mt={0.5}>
            <Alert severity="warning">{operationMeta.body}</Alert>
            <Box>
              <Typography variant="caption" color="text.secondary">
                {operationOrders.length > 1 ? '订单数量' : '订单号'}
              </Typography>
              <Typography variant="subtitle1">
                {operationOrders.length > 1
                  ? `${operationOrders.length} 个订单`
                  : getSalesPostingNumber(salesOperation.order) || '未返回'}
              </Typography>
            </Box>
            {salesOperation.type === 'cancel' || salesOperation.type === 'batchCancel' ? (
              <TextField
                select
                size="small"
                label="取消原因"
                value={salesOperation.cancelReasonId}
                onChange={updateSalesCancelReason}
                disabled={salesOperation.cancelReasonsLoading || Boolean(salesOperation.cancelReasonsError)}
                helperText={
                  salesOperation.cancelReasonsLoading
                    ? '正在读取 Ozon 可用取消原因...'
                    : salesOperation.cancelReasonsError || '会按 Ozon 返回的取消原因提交。'
                }
                fullWidth
              >
                <MenuItem value="" disabled>
                  {salesOperation.cancelReasonsLoading ? '正在读取取消原因' : '请选择取消原因'}
                </MenuItem>
                {salesOperation.cancelReasons.map((reason) => (
                  <MenuItem key={reason.id} value={reason.id}>
                    {reason.label}
                  </MenuItem>
                ))}
              </TextField>
            ) : null}
            {salesOperation.error ? (
              <Alert severity="error">{String(salesOperation.error?.message || salesOperation.error)}</Alert>
            ) : null}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={closeSalesOperation} disabled={salesOperation.loading}>
          先不操作
        </Button>
        <Button
          variant="contained"
          color={operationMeta.color}
          onClick={executeSalesOperation}
          disabled={salesOperation.loading || !canSubmitSalesOperation}
        >
          {salesOperation.loading ? '提交中' : operationMeta.confirmText}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
