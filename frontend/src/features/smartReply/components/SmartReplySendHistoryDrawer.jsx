import CloseRounded from '@mui/icons-material/CloseRounded';
import HistoryRounded from '@mui/icons-material/HistoryRounded';
import MarkEmailReadRounded from '@mui/icons-material/MarkEmailReadRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';
import { smartReplyScenes } from '../constants/smartReplyScenes.js';
import { smartReplyTaskStatusLabels } from '../services/smartReplyAutomationService.js';

const sceneTitles = Object.freeze(Object.fromEntries(
  smartReplyScenes.map((scene) => [scene.value, scene.title]),
));

function formatTime(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
    : '—';
}

function taskScene(task, rules = []) {
  const direct = String(task?.scene || '').trim();
  if (direct) return direct;
  return String(rules.find((rule) => rule.ruleId === task?.ruleId)?.scene || '').trim();
}

function taskSceneTitle(task, rules) {
  return sceneTitles[taskScene(task, rules)] || '其他智能回复';
}

function statusColor(status) {
  if (status === 'sent') return 'success.main';
  if (['failed', 'manual_review', 'sent_unconfirmed'].includes(status)) return 'error.main';
  if (['processing', 'opening_chat', 'sending', 'readback_processing'].includes(status)) return 'primary.main';
  return 'text.secondary';
}

function SendHistoryRow({ automation, task }) {
  const category = taskSceneTitle(task, automation.rules);
  const statusLabel = smartReplyTaskStatusLabels[task.status] || task.status || '状态待确认';
  const retrying = automation.busyAction === `retry:${task.taskId}`;

  return (
    <Box
      component="article"
      data-testid="smart-reply-send-history-row"
      sx={{ px: 2.5, py: 2.25, borderBottom: '1px solid', borderColor: 'divider' }}
    >
      <Stack direction="row" spacing={1.5} alignItems="flex-start">
        <Box
          sx={{
            width: 40,
            height: 40,
            display: 'grid',
            placeItems: 'center',
            flexShrink: 0,
            borderRadius: '6px',
            bgcolor: 'rgba(84, 130, 255, 0.10)',
            color: 'primary.main',
          }}
        >
          <MarkEmailReadRounded fontSize="small" />
        </Box>

        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1.5}>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="subtitle1" fontWeight={800} noWrap>
                {task.postingNumber || '未返回订单号'}
              </Typography>
              <Typography variant="body2" color="text.secondary" noWrap>
                {task.shopName || task.clientId || '未返回店铺'}
              </Typography>
            </Box>
            <Box
              sx={{
                px: 1,
                py: 0.5,
                border: '1px solid',
                borderColor: 'primary.light',
                borderRadius: '5px',
                bgcolor: 'rgba(84, 130, 255, 0.06)',
                color: 'primary.main',
                flexShrink: 0,
              }}
            >
              <Typography variant="caption" fontWeight={800}>{category}</Typography>
            </Box>
          </Stack>

          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
              gap: 1.25,
              mt: 1.5,
            }}
          >
            <Box>
              <Typography variant="caption" color="text.secondary">发送类型</Typography>
              <Typography variant="body2" fontWeight={700}>{category}</Typography>
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">发送状态</Typography>
              <Typography variant="body2" fontWeight={700} sx={{ color: statusColor(task.status) }}>
                {statusLabel}
              </Typography>
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">执行模式</Typography>
              <Typography variant="body2">
                {automation.executionMode === 'local' ? '本地模式' : '云端模式'}
              </Typography>
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">发送时间</Typography>
              <Typography variant="body2">{formatTime(task.sentAt || task.scheduledFor || task.createdAt)}</Typography>
            </Box>
          </Box>

          {task.errorMessage ? (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1.25, overflowWrap: 'anywhere' }}>
              {task.errorMessage}
            </Typography>
          ) : null}

          {task.status === 'failed' ? (
            <Button
              size="small"
              variant="outlined"
              disabled={retrying}
              onClick={() => automation.retryTask(task.taskId)}
              sx={{ mt: 1.25, borderRadius: '5px !important' }}
            >
              {retrying ? '正在重试' : '重试发送'}
            </Button>
          ) : null}
        </Box>
      </Stack>
    </Box>
  );
}

export function SmartReplySendHistoryDrawer({ automation, onClose, open }) {
  const refresh = automation.refresh;
  React.useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const tasks = Array.isArray(automation.tasks) ? automation.tasks : [];
  const total = Math.max(tasks.length, Number(automation.taskTotal) || 0);

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      aria-label="发送记录侧边栏"
      slotProps={{
        paper: {
          sx: {
            width: { xs: '100vw', sm: 560, xl: 620 },
            maxWidth: '100vw',
            borderRadius: '8px 0 0 8px',
            overflow: 'hidden',
            bgcolor: 'background.paper',
          },
        },
      }}
    >
      <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <Stack
          direction="row"
          alignItems="center"
          spacing={1.5}
          sx={{ px: 2.5, py: 2.25, borderBottom: '1px solid', borderColor: 'divider' }}
        >
          <Box
            sx={{
              width: 42,
              height: 42,
              display: 'grid',
              placeItems: 'center',
              borderRadius: '6px',
              bgcolor: 'rgba(84, 130, 255, 0.10)',
              color: 'primary.main',
            }}
          >
            <HistoryRounded />
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="h6" component="h2" fontWeight={800}>发送记录</Typography>
            <Typography variant="body2" color="text.secondary">
              查看订单发送类型、执行结果和发送时间
            </Typography>
          </Box>
          <IconButton aria-label="关闭发送记录" onClick={onClose} sx={{ borderRadius: '6px' }}>
            <CloseRounded />
          </IconButton>
        </Stack>

        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          spacing={2}
          sx={{ px: 2.5, py: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}
        >
          <Box>
            <Typography variant="subtitle2" fontWeight={800}>全部记录</Typography>
            <Typography variant="caption" color="text.secondary">共 {total} 条</Typography>
          </Box>
          <Button
            size="small"
            startIcon={<RefreshRounded />}
            disabled={automation.status === 'loading'}
            onClick={() => void automation.refresh()}
            sx={{ borderRadius: '5px !important' }}
          >
            {automation.status === 'loading' ? '刷新中' : '刷新'}
          </Button>
        </Stack>

        <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {tasks.length ? (
            tasks.map((task) => (
              <SendHistoryRow key={task.taskId} automation={automation} task={task} />
            ))
          ) : (
            <Stack alignItems="center" justifyContent="center" spacing={1} sx={{ minHeight: 260, px: 3 }}>
              <HistoryRounded color="disabled" sx={{ fontSize: 42 }} />
              <Typography variant="subtitle1" fontWeight={800}>暂无发送记录</Typography>
              <Typography variant="body2" color="text.secondary" textAlign="center">
                新订单命中已开启的规则后，会在这里显示发送类型和执行结果。
              </Typography>
            </Stack>
          )}
        </Box>
      </Box>
    </Drawer>
  );
}

export const smartReplySendHistorySceneTitles = sceneTitles;
