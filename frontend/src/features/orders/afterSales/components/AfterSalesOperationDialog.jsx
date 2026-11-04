import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '../../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

export function AfterSalesOperationDialog({
  afterSalesOperationDialog,
  afterSalesOperationDetail,
  afterSalesOperationForm,
  setAfterSalesOperationForm,
  selectedAfterSalesOperation,
  selectedAfterSalesRejectionReason,
  afterSalesOperationSellerTarget,
  afterSalesDisplayId,
  openAfterSalesSellerDetail,
  closeAfterSalesOperationDialog,
  submitAfterSalesOperation,
}) {
  return (
    <Dialog
    open={afterSalesOperationDialog.open}
    onClose={closeAfterSalesOperationDialog}
    fullWidth
    maxWidth="md"
    >
    <DialogTitle>售后详情与处理</DialogTitle>
    <DialogContent>
    <Stack spacing={2} mt={0.5}>
    <Typography variant="body2" color="text.secondary">
    售后单：{afterSalesDisplayId || '未返回'}
    </Typography>
    
    {afterSalesOperationDetail.fields.length ? (
    <Box>
    <Typography variant="subtitle2" sx={{ mb: 1 }}>售后信息</Typography>
    <Box
    sx={{
    display: 'grid',
    gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))', md: 'repeat(3, minmax(0, 1fr))' },
    gap: 1,
    }}
    >
    {afterSalesOperationDetail.fields.map(([label, value]) => (
    <Box
    key={`${label}:${value}`}
    sx={{ p: 1.25, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}
    >
    <Typography variant="caption" color="text.secondary">{label}</Typography>
    <Typography variant="body2" sx={{ mt: 0.25, overflowWrap: 'anywhere' }}>{value}</Typography>
    </Box>
    ))}
    </Box>
    </Box>
    ) : null}
    
    {afterSalesOperationDetail.product.name || afterSalesOperationDetail.product.offerId ? (
    <Box>
    <Typography variant="subtitle2" sx={{ mb: 1 }}>商品信息</Typography>
    <Stack
    direction={{ xs: 'column', sm: 'row' }}
    spacing={1.5}
    sx={{ p: 1.25, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}
    >
    {afterSalesOperationDetail.product.image ? (
    <Box
    component="img"
    src={afterSalesOperationDetail.product.image}
    alt={afterSalesOperationDetail.product.name || '售后商品'}
    sx={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 1, flex: '0 0 auto' }}
    />
    ) : null}
    <Box sx={{ minWidth: 0 }}>
    <Typography variant="body2" fontWeight={700}>{afterSalesOperationDetail.product.name || '商品名称未返回'}</Typography>
    {afterSalesOperationDetail.product.offerId ? (
    <Typography variant="caption" color="text.secondary" display="block">
    货号：{afterSalesOperationDetail.product.offerId}
    </Typography>
    ) : null}
    {afterSalesOperationDetail.product.sku ? (
    <Typography variant="caption" color="text.secondary" display="block">
    SKU：{afterSalesOperationDetail.product.sku}
    </Typography>
    ) : null}
    {afterSalesOperationDetail.product.price ? (
    <Typography variant="caption" color="text.secondary" display="block">
    金额：{afterSalesOperationDetail.product.price}{afterSalesOperationDetail.product.currency ? ` ${afterSalesOperationDetail.product.currency}` : ''}
    </Typography>
    ) : null}
    </Box>
    </Stack>
    </Box>
    ) : null}
    
    {afterSalesOperationDetail.buyerComment ? (
    <Box sx={{ p: 1.25, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
    <Typography variant="caption" color="text.secondary">买家说明</Typography>
    <Typography variant="body2" sx={{ mt: 0.5, whiteSpace: 'pre-wrap' }}>
    {afterSalesOperationDetail.buyerComment}
    </Typography>
    </Box>
    ) : null}
    
    {afterSalesOperationDetail.clientPhotos.length ? (
    <Box>
    <Typography variant="subtitle2" sx={{ mb: 1 }}>买家上传图片</Typography>
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
    {afterSalesOperationDetail.clientPhotos.map((url, index) => (
    <Box
    component="img"
    key={url}
    src={url}
    alt={`买家售后凭证 ${index + 1}`}
    sx={{ width: 92, height: 92, objectFit: 'cover', borderRadius: 1, border: '1px solid', borderColor: 'divider' }}
    />
    ))}
    </Box>
    </Box>
    ) : null}
    
    {afterSalesOperationDialog.loading ? (
    <Alert severity="info">正在读取 Ozon 当前允许执行的售后操作…</Alert>
    ) : null}
    {afterSalesOperationDialog.error ? (
    <Alert severity="error">{afterSalesOperationDialog.error}</Alert>
    ) : null}
    {!afterSalesOperationDialog.loading && !afterSalesOperationDialog.plan?.actionable ? (
    <Alert severity="info">
    {afterSalesOperationDialog.plan?.message
    ? `${afterSalesOperationDialog.plan.message} `
    : '当前没有 Ozon 允许直接提交的操作。 '}
    仍可查看完整详情，或进入当前售后单上传图片和人工处理。
    </Alert>
    ) : null}
    
    {afterSalesOperationDialog.plan?.actions?.length ? (
    <TextField
    select
    fullWidth
    label="处理方式"
    value={afterSalesOperationForm.actionKey || ''}
    onChange={(event) => setAfterSalesOperationForm((current) => ({
    ...current,
    actionKey: event.target.value,
    }))}
    disabled={afterSalesOperationDialog.submitting}
    >
    {afterSalesOperationDialog.plan.actions.map((action) => (
    <MenuItem key={action.key} value={action.key}>
    {action.label}
    </MenuItem>
    ))}
    </TextField>
    ) : null}
    
    {selectedAfterSalesOperation?.kind === 'reject' ? (
    afterSalesOperationDialog.plan?.rejectionReasons?.length ? (
    <TextField
    select
    fullWidth
    label="拒绝原因"
    value={afterSalesOperationForm.rejectionReasonId ?? ''}
    onChange={(event) => setAfterSalesOperationForm((current) => ({
    ...current,
    rejectionReasonId: event.target.value,
    }))}
    helperText={selectedAfterSalesRejectionReason?.hint || ''}
    disabled={afterSalesOperationDialog.submitting}
    >
    {afterSalesOperationDialog.plan.rejectionReasons.map((reason) => (
    <MenuItem key={reason.id} value={reason.id}>
    {reason.name}
    </MenuItem>
    ))}
    </TextField>
    ) : (
    <Alert severity="warning">Ozon 没有返回可选的拒绝原因，已阻止拒绝操作。</Alert>
    )
    ) : null}
    
    {selectedAfterSalesOperation?.kind === 'compensate' ? (
    <TextField
    fullWidth
    label="补偿金额（卢布）"
    type="number"
    value={afterSalesOperationForm.compensationAmount || ''}
    onChange={(event) => setAfterSalesOperationForm((current) => ({
    ...current,
    compensationAmount: event.target.value,
    }))}
    inputProps={{ min: 0.01, step: 0.01 }}
    disabled={afterSalesOperationDialog.submitting}
    />
    ) : null}
    
    {selectedAfterSalesOperation?.kind === 'refund' ? (
    <TextField
    fullWidth
    label="退货运费补偿（卢布，没有则填 0）"
    type="number"
    value={afterSalesOperationForm.returnForBackWay ?? '0'}
    onChange={(event) => setAfterSalesOperationForm((current) => ({
    ...current,
    returnForBackWay: event.target.value,
    }))}
    inputProps={{ min: 0, step: 1 }}
    disabled={afterSalesOperationDialog.submitting}
    />
    ) : null}
    
    {selectedAfterSalesOperation?.kind === 'verify' ? (
    <TextField
    fullWidth
    label="退货方式说明"
    value={afterSalesOperationForm.returnMethodDescription || ''}
    onChange={(event) => setAfterSalesOperationForm((current) => ({
    ...current,
    returnMethodDescription: event.target.value,
    }))}
    disabled={afterSalesOperationDialog.submitting}
    />
    ) : null}
    
    {selectedAfterSalesOperation && !['receive'].includes(selectedAfterSalesOperation.kind) ? (
    <TextField
    fullWidth
    multiline
    minRows={2}
    label={selectedAfterSalesRejectionReason?.commentRequired ? '处理说明（必填）' : '处理说明（选填）'}
    value={afterSalesOperationForm.comment || ''}
    onChange={(event) => setAfterSalesOperationForm((current) => ({
    ...current,
    comment: event.target.value,
    }))}
    disabled={afterSalesOperationDialog.submitting}
    />
    ) : null}
    </Stack>
    </DialogContent>
    <DialogActions>
    <Button onClick={closeAfterSalesOperationDialog} disabled={afterSalesOperationDialog.submitting}>
    关闭
    </Button>
    {afterSalesOperationSellerTarget.url && !afterSalesOperationDialog.loading ? (
    <Button
    variant="outlined"
    onClick={() => {
    openAfterSalesSellerDetail(
    afterSalesOperationDialog.order,
    afterSalesOperationDialog.order?.products?.[0] || {}
    );
    closeAfterSalesOperationDialog();
    }}
    >
    {afterSalesOperationSellerTarget.targetKind === 'after-sales-detail'
    ? '上传图片 / 在 Ozon 处理'
    : '查看 Ozon 原订单'}
    </Button>
    ) : null}
    {afterSalesOperationDialog.plan?.actionable ? (
    <Button
    variant="contained"
    onClick={submitAfterSalesOperation}
    disabled={afterSalesOperationDialog.loading || afterSalesOperationDialog.submitting}
    >
    {afterSalesOperationDialog.submitting
    ? '提交中…'
    : selectedAfterSalesOperation?.label || '执行操作'}
    </Button>
    ) : null}
    </DialogActions>
    </Dialog>
  );
}
