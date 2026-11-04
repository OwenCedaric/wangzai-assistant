import CheckCircleOutlineRounded from '@mui/icons-material/CheckCircleOutlineRounded';
import PendingActionsRounded from '@mui/icons-material/PendingActionsRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { normalizeCollectionListingErrorMessage } from '../lib/collectionListingErrorMessage.js';

const WRITE_STATUS_LABELS = Object.freeze({
  dry_run_recorded: '仅记录，未写入',
  readback_merged: 'Ozon 已写入',
  submitted_waiting_readback: '等待 Ozon 回读',
  readback_mismatch: 'Ozon 回读不一致',
  write_failed_after_accept: 'Ozon 导入失败',
  write_failed: 'Ozon 写入失败',
});

const READBACK_STATUS_LABELS = Object.freeze({
  merged: '回读一致',
  pending: '等待回读',
  mismatch: '回读不一致',
  failed: '已停止',
});

const SHOP_RESULT_LABELS = Object.freeze({
  completed: '上传完成',
  partial: '部分完成',
  pending_readback: '等待 Ozon 回读',
  preview_failed: '预览失败',
  failed: '上传失败',
  error: '上传失败',
});

export function getListingTaskResultStatusLabel(item = {}) {
  if (item?.response?.error?.code === 'OZON_PRODUCT_DAILY_CREATION_LIMIT_EXCEEDED') {
    return '今日创建额度已用完 / 已停止';
  }
  const writeStatus = WRITE_STATUS_LABELS[item.writeStatus] || (item.writeStatus ? 'Ozon 状态异常' : '未写入');
  const readBackStatus = READBACK_STATUS_LABELS[item.readBackStatus] || (item.readBackStatus ? '回读状态异常' : '未回读');
  return `${writeStatus} / ${readBackStatus}`;
}

export function ListingTaskStatusCard({ listingState }) {
  const result = listingState?.result;
  const completed = listingState?.status === 'completed';
  const failed = listingState?.status === 'failed' || listingState?.status === 'error';
  const partial = listingState?.status === 'partial';
  const shopResults = Array.isArray(result?.shopResults) ? result.shopResults : [];
  return (
    <Paper variant="outlined" sx={{ borderRadius: 1.25, p: 2 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Stack direction="row" spacing={1} alignItems="center">
          {completed ? <CheckCircleOutlineRounded color="success" /> : <PendingActionsRounded color="action" />}
          <Box>
            <Typography variant="subtitle1" fontWeight={700}>上架任务与 Ozon 回读</Typography>
            <Typography variant="caption" color="text.secondary">接口受理不等于完成，此处只认 merged。</Typography>
          </Box>
        </Stack>
        <Chip
          size="small"
          color={completed ? 'success' : partial ? 'warning' : failed ? 'error' : 'default'}
          label={completed ? '已完成' : partial ? '部分完成' : failed ? '已停止' : '尚未完成'}
        />
      </Stack>
      {listingState?.error ? <Alert severity="error" sx={{ mt: 1.5 }}>{listingState.error}</Alert> : null}
      {listingState?.message && !listingState.error ? <Alert severity={completed ? 'success' : 'info'} sx={{ mt: 1.5 }}>{listingState.message}</Alert> : null}
      {shopResults.length ? (
        <Stack spacing={0.75} mt={1.5}>
          {shopResults.map((item) => {
            const itemCompleted = item.completed === true;
            const itemMessage = item.error
              ? normalizeCollectionListingErrorMessage(item.error)
              : item.result?.message;
            return (
              <Paper key={item.shopId} variant="outlined" sx={{ px: 1.25, py: 1, borderRadius: 1 }}>
                <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
                  <Typography variant="body2" fontWeight={750}>{item.shopLabel || item.shopId}</Typography>
                  <Chip
                    size="small"
                    color={itemCompleted ? 'success' : 'error'}
                    label={SHOP_RESULT_LABELS[item.status] || (itemCompleted ? '上传完成' : '未完成')}
                  />
                </Stack>
                {itemMessage ? (
                  <Typography variant="caption" color={itemCompleted ? 'text.secondary' : 'error.main'} display="block" mt={0.5}>
                    {itemMessage}
                  </Typography>
                ) : null}
              </Paper>
            );
          })}
        </Stack>
      ) : null}
      {result?.results?.length ? (
        <Stack spacing={0.75} mt={1.5}>
          {result.results.map((item) => (
            <Stack key={item.kind} direction="row" alignItems="center" justifyContent="space-between" sx={{ px: 1, py: 0.75, borderRadius: 1, bgcolor: 'grey.50' }}>
              <Typography variant="body2" fontWeight={650}>{item.label}</Typography>
              <Typography variant="caption" color={item.readBackStatus === 'merged' ? 'success.main' : 'warning.main'}>
                {getListingTaskResultStatusLabel(item)}
              </Typography>
            </Stack>
          ))}
        </Stack>
      ) : (
        <Typography variant="caption" color="text.secondary" display="block" mt={1.5}>
          生成预览并人工确认后，这里会逐步显示商品卡、价格和库存的写入/回读状态。
        </Typography>
      )}
    </Paper>
  );
}
