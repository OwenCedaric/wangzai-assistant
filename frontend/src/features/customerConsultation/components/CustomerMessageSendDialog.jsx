import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

export function CustomerMessageSendDialog({ state, onClose, onConfirm, onRetryReadback }) {
  const working = ['previewing', 'confirming', 'readingBack'].includes(state.status);
  const ready = state.status === 'ready';

  return (
    <Dialog open={Boolean(state.open)} onClose={working ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>发送回复确认</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5}>
          {working ? (
            <Stack direction="row" alignItems="center" spacing={1} className="customer-message-send-progress">
              <CircularProgress size={18} />
              <Typography variant="body2">
                {state.status === 'previewing'
                  ? '正在创建发送预览…'
                  : state.status === 'readingBack'
                    ? '正在只回读 Ozon 消息，不会重复发送…'
                    : '正在提交 Ozon 并回读消息…'}
              </Typography>
            </Stack>
          ) : null}

          {state.error ? <Alert severity="error">{state.error}</Alert> : null}
          {state.status === 'success' ? <Alert severity="success">Ozon 已回读到这条回复，发送完成。</Alert> : null}
          {state.status === 'pending' ? (
            <Alert severity="info">回复已提交，尚未从 Ozon 回读确认，当前不会显示为发送完成。</Alert>
          ) : null}

          {state.conversation ? (
            <Box className="customer-message-send-target">
              <Typography variant="caption" color="text.secondary">
                发送对象
              </Typography>
              <Typography variant="subtitle2">{state.conversation.title}</Typography>
              <Typography variant="caption" color="text.secondary">
                Chat ID：{state.conversation.chatId}
              </Typography>
            </Box>
          ) : null}

          {state.text ? (
            <Box className="customer-message-send-content">
              <Typography variant="caption" color="text.secondary">
                回复内容
              </Typography>
              <Typography variant="body2">{state.text}</Typography>
            </Box>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        {ready ? (
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
