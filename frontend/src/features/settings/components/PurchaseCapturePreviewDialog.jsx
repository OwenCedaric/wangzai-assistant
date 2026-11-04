import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';

export function PurchaseCapturePreviewDialog({ controller }) {
  const mode = controller?.targetMode;
  const preview = mode?.capturePreview;
  if (!preview) return null;
  const capture = mode.captureResult || {};
  const changes = preview.changes?.override || {};
  return (
    <Dialog open onClose={mode.cancelCapture} maxWidth="sm" fullWidth>
      <DialogTitle>采购信息捕捉预览</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1}>
          <Typography variant="caption" color="text.secondary">
            目标阶段：{mode.targetPhase || 'capture-preview'} · 只有点击确认并完成回读后才会写入订单。
          </Typography>
          <Typography variant="body2">平台：{capture.platform || '未识别'}</Typography>
          <Typography variant="body2">采购单号：{capture.purchaseOrderNumber || '未识别'}</Typography>
          <Typography variant="body2">
            采购价格：{capture.purchasePrice ?? '未识别'} {capture.currency || 'CNY'}
          </Typography>
          <Typography variant="body2">货源链接：{capture.sourceUrl || '未识别'}</Typography>
          <Typography variant="subtitle2" sx={{ mt: 1 }}>
            回填差异
          </Typography>
          {Object.entries(changes).length ? (
            Object.entries(changes).map(([field, value]) => (
              <Typography key={field} variant="caption" color="text.secondary">
                {field}：{value === null || value === '' ? '清空' : String(value)}
              </Typography>
            ))
          ) : (
            <Typography variant="caption" color="text.secondary">
              没有可回填字段。
            </Typography>
          )}
          {preview.missingFields?.length ? (
            <Alert severity="warning">缺少字段：{preview.missingFields.join('、')}</Alert>
          ) : null}
          {preview.conflicts?.length ? (
            <Alert severity="warning">将覆盖：{preview.conflicts.join('、')}；请确认后继续。</Alert>
          ) : null}
          {mode.captureError ? <Alert severity="error">{mode.captureError}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={mode.cancelCapture}>取消</Button>
        <Button
          variant="contained"
          onClick={() => mode.confirmCapture({ acceptConflicts: Boolean(preview.conflicts?.length) })}
          disabled={mode.captureBusy || Boolean(preview.missingFields?.length)}
        >
          {mode.captureBusy ? '保存中…' : preview.conflicts?.length ? '确认覆盖并回填' : '确认回填'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
