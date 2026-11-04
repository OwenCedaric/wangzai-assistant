import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

function formatFileSize(size) {
  return size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(2)} MB` : `${Math.max(1, Math.ceil(size / 1024))} KB`;
}

export function CustomerFileSendDialog({ state, onClose, onConfirm, onRetryReadback }) {
  const working = ['previewing', 'confirming', 'readingBack'].includes(state.status);
  return (
    <Dialog open={Boolean(state.open)} onClose={working ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>发送附件确认</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5}>
          {working ? (
            <Stack direction="row" spacing={1} alignItems="center">
              <CircularProgress size={18} />
              <Typography variant="body2">
                {state.status === 'previewing'
                  ? '正在安全暂存并创建预览…'
                  : state.status === 'readingBack'
                    ? '正在只回读 Ozon 附件，不会重复上传…'
                    : '正在提交 Ozon 并回读附件…'}
              </Typography>
            </Stack>
          ) : null}
          {state.error ? <Alert severity="error">{state.error}</Alert> : null}
          {state.status === 'success' ? <Alert severity="success">Ozon 已回读到该附件，发送完成。</Alert> : null}
          {state.status === 'pending' ? (
            <Alert severity="info">附件已提交，尚未回读确认，不显示为发送完成。</Alert>
          ) : null}
          {state.conversation ? <Typography variant="body2">发送对象：{state.conversation.title}</Typography> : null}
          {state.file ? (
            <Typography variant="body2">
              附件：{state.file.name}（{formatFileSize(state.file.size)}）
            </Typography>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        {state.status === 'ready' ? (
          <>
            <Button color="inherit" onClick={onClose}>
              返回修改
            </Button>
            <Button variant="contained" onClick={onConfirm}>
              确认发送
            </Button>
          </>
        ) : state.status === 'pending' ? (
          <>
            <Button color="inherit" onClick={onClose}>
              关闭
            </Button>
            <Button variant="contained" onClick={onRetryReadback}>
              只重新回读
            </Button>
          </>
        ) : (
          <Button onClick={onClose} disabled={working}>
            关闭
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
