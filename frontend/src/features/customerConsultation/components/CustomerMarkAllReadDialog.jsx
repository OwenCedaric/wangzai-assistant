import { translateCustomerError } from '../lib/customerConsultationLocale.js';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

function getFailureRows(state) {
  return Array.isArray(state?.result?.failures) ? state.result.failures : [];
}

function getPreviewRows(state) {
  return Array.isArray(state?.previewRows) ? state.previewRows : [];
}

function getFailureTitle(previewRows, chatId) {
  return previewRows.find((row) => row.chatId === String(chatId ?? '').trim())?.title || '未命名会话';
}

export function CustomerMarkAllReadDialog({ state, onClose, onConfirm }) {
  const working = state?.status === 'previewing' || state?.status === 'confirming';
  const ready = state?.status === 'ready';
  const failures = getFailureRows(state);
  const previewRows = getPreviewRows(state);

  if (!state?.open) return null;

  return (
    <Dialog open onClose={working ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{state.scope === 'single' ? '标记当前会话为已读' : '全部标记为已读'}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5}>
          {working ? (
            <Stack direction="row" alignItems="center" spacing={1}>
              <CircularProgress size={18} />
              <Typography variant="body2">
                {state.status === 'previewing' ? '正在创建标记已读预览…' : '正在逐个提交 Ozon，并回读确认…'}
              </Typography>
            </Stack>
          ) : null}

          {state.status === 'success' ? (
            <Alert severity="success">
              {state.scope === 'single'
                ? `Ozon 已回读确认${state.targetTitle ? `「${state.targetTitle}」` : '当前会话'}已读。`
                : `Ozon 已回读确认全部 ${state.chats.length} 个会话已读。`}
            </Alert>
          ) : null}
          {state.status === 'success' && state.readOnlyUnreadMessages ? (
            <Alert severity="info">
              另有 {state.readOnlyUnreadMessages} 条 Ozon 自动消息/信息推送为只读，未提交 chat.read。
            </Alert>
          ) : null}
          {state.status === 'pending' ? (
            <Alert severity="info">已提交 Ozon，但还没有回读确认，当前不会显示为全部完成。</Alert>
          ) : null}
          {state.status === 'readonly' ? <Alert severity="info">{state.error}</Alert> : null}
          {state.status === 'partial' ? (
            <Alert severity="warning">部分会话没有确认成功，请按下面的失败会话重试。</Alert>
          ) : null}
          {state.error && !['pending', 'partial', 'readonly'].includes(state.status) ? (
            <Alert severity="error">{state.error}</Alert>
          ) : null}
          {state.status === 'partial' && state.error ? <Alert severity="error">{state.error}</Alert> : null}

          {ready || state.status === 'previewing' || state.status === 'confirming' ? (
            <Box>
              <Typography variant="body2">
                {state.scope === 'single' ? '将把当前会话的 ' : '将把 '}
                <strong>{state.unreadMessages}</strong> 条未读消息标记为已读。
              </Typography>
              <Typography variant="caption" color="text.secondary">
                只会提交当前预览中的会话；完成条件是 Ozon 回读每个会话的未读数为 0。
              </Typography>
              {state.readOnlyUnreadMessages ? (
                <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                  另有 {state.readOnlyUnreadMessages} 条 Ozon 自动消息/信息推送为只读，不会提交 chat.read。
                </Typography>
              ) : null}
            </Box>
          ) : null}

          {previewRows.length && state.status !== 'success' ? (
            <Box>
              <Typography variant="caption" color="text.secondary">
                会话预览
              </Typography>
              <Stack spacing={0.75} sx={{ mt: 0.75 }}>
                {previewRows.slice(0, 5).map((row) => (
                  <Box key={row.chatId} className="customer-chat-read-preview-row">
                    <Box minWidth={0}>
                      <Typography variant="body2" fontWeight={800} noWrap title={row.title}>
                        {row.title}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" noWrap title={row.subtitle}>
                        {[row.categoryLabel, row.subtitle].filter(Boolean).join(' · ')}
                      </Typography>
                    </Box>
                    <Typography variant="caption" color="primary.main" fontWeight={800} noWrap>
                      未读 {row.unreadCount} 条
                    </Typography>
                  </Box>
                ))}
                {previewRows.length > 5 ? (
                  <Typography variant="caption" color="text.secondary">
                    另有 {previewRows.length - 5} 个会话
                  </Typography>
                ) : null}
              </Stack>
            </Box>
          ) : null}

          {failures.length ? (
            <>
              <Divider />
              <Typography variant="subtitle2">未确认的会话</Typography>
              <Stack spacing={0.5}>
                {failures.slice(0, 8).map((failure) => (
                  <Typography
                    key={`${failure.chatId}-${failure.error?.code || 'failure'}`}
                    variant="body2"
                    color="error.main"
                    sx={{ overflowWrap: 'anywhere' }}
                  >
                    {getFailureTitle(previewRows, failure.chatId)}：
                    {translateCustomerError(failure.error, 'Ozon 未回读为已读。')}
                  </Typography>
                ))}
                {failures.length > 8 ? (
                  <Typography variant="caption" color="text.secondary">
                    还有 {failures.length - 8} 个会话未确认。
                  </Typography>
                ) : null}
              </Stack>
            </>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        {ready ? (
          <>
            <Button color="inherit" onClick={onClose}>
              取消
            </Button>
            <Button variant="contained" onClick={onConfirm}>
              {state.scope === 'single' ? '确认当前会话已读' : '确认全部已读'}
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
