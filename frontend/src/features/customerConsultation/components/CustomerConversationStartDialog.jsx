import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import MenuItem from '@mui/material/MenuItem';

function getPostingNumber(order = {}) {
  const raw = order?.raw && typeof order.raw === 'object' ? order.raw : {};
  return String(order.postingNumber || order.posting_number || order.id || raw.posting_number || '').trim();
}

function getOrderLabel(order = {}) {
  const postingNumber = getPostingNumber(order);
  const status = String(order.statusLabel || order.status || order.orderStatus || '').trim();
  return status ? `${postingNumber} · ${status}` : postingNumber;
}

export function CustomerConversationStartDialog({ state, onClose, onChange, onPreview, onConfirm, onRetryReadback }) {
  const working = ['previewing', 'confirming', 'readingBack'].includes(state.status);
  const completed = state.status === 'success' || state.status === 'pending';
  return (
    <Dialog open={Boolean(state.open)} onClose={working ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>新建买家会话</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5}>
          <Alert severity="info">
            Ozon 仅允许符合套餐、履约方式和时效条件的订单主动发起会话；不符合时会直接返回原因。
          </Alert>
          <TextField
            select
            autoFocus
            label="选择真实订单"
            value={state.postingNumber}
            onChange={(event) => onChange(event.target.value)}
            disabled={working || completed || state.ordersStatus === 'loading'}
            fullWidth
            helperText={
              state.ordersStatus === 'loading' ? '正在读取当前店铺最近订单…' : '只显示当前店铺本地已同步的真实订单'
            }
          >
            {state.postingNumber &&
            !(state.orders || []).some((order) => getPostingNumber(order) === state.postingNumber) ? (
              <MenuItem value={state.postingNumber}>{state.postingNumber}</MenuItem>
            ) : null}
            {(state.orders || []).map((order) => {
              const postingNumber = getPostingNumber(order);
              return (
                <MenuItem key={postingNumber} value={postingNumber}>
                  {getOrderLabel(order)}
                </MenuItem>
              );
            })}
          </TextField>
          {state.ordersStatus === 'success' && !(state.orders || []).length ? (
            <Alert severity="info">当前店铺还没有已同步的真实订单，暂时不能新建买家会话。</Alert>
          ) : null}
          {working ? (
            <Stack direction="row" alignItems="center" spacing={1}>
              <CircularProgress size={18} />
              <Typography variant="body2">
                {state.status === 'previewing'
                  ? '正在创建预览…'
                  : state.status === 'readingBack'
                    ? '正在只回读新会话，不会重复新建…'
                    : '正在提交并回读新会话…'}
              </Typography>
            </Stack>
          ) : null}
          {state.error ? <Alert severity="error">{state.error}</Alert> : null}
          {state.status === 'ready' ? (
            <Alert severity="warning">已核对当前店铺订单 {state.postingNumber}。确认后才会向 Ozon 提交新会话。</Alert>
          ) : null}
          {state.status === 'success' ? <Alert severity="success">Ozon 已回读确认新会话。</Alert> : null}
          {state.status === 'pending' ? <Alert severity="info">Ozon 已受理，尚未回读确认。</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={working}>
          关闭
        </Button>
        {!state.preview ? (
          <Button variant="contained" onClick={onPreview} disabled={working || !state.postingNumber.trim()}>
            创建预览
          </Button>
        ) : null}
        {state.status === 'ready' ? (
          <Button variant="contained" color="warning" onClick={onConfirm}>
            确认新建
          </Button>
        ) : null}
        {state.status === 'pending' ? (
          <Button variant="contained" onClick={onRetryReadback} disabled={!state.result?.readBack?.chatId}>
            只重新回读
          </Button>
        ) : null}
      </DialogActions>
    </Dialog>
  );
}
