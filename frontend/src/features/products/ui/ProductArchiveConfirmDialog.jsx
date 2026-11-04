import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';

export function ProductArchiveConfirmDialog({
  open,
  action,
  actionText,
  product = {},
  productLabel,
  saving,
  onClose,
  onConfirm,
}) {
  return (
    <Dialog
      open={open}
      onClose={saving ? undefined : onClose}
      maxWidth="xs"
      fullWidth
      className="product-save-confirm-dialog"
    >
      <DialogTitle>{`确认${actionText}`}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5}>
          <Alert severity={action === 'archive' ? 'warning' : 'info'}>
            {`将对这个商品执行${actionText}，确认后会进入写入安全门；本机 local-api 写入总开关开启时会真实写入 Ozon。`}
          </Alert>
          <Box className="product-save-confirm-summary">
            <Typography variant="caption" color="text.secondary">
              商品
            </Typography>
            <Typography variant="subtitle1" noWrap title={productLabel}>
              {productLabel}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Ozon 商品 ID：{product.productId || '未返回'}；当前状态：
              {product.statusLabel || product.status || product.visibility || '未返回'}
            </Typography>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          再检查一下
        </Button>
        <Button variant="contained" color={action === 'archive' ? 'error' : 'success'} onClick={onConfirm} disabled={saving}>
          {saving ? '提交中' : `确认${actionText}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
