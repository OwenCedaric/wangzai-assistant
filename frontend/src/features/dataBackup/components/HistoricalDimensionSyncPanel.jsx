import FactCheckRounded from '@mui/icons-material/FactCheckRounded';
import SyncRounded from '@mui/icons-material/SyncRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

const DIMENSION_LABELS = Object.freeze({
  lengthCm: ['长', 'cm'],
  widthCm: ['宽', 'cm'],
  heightCm: ['高', 'cm'],
  weightKg: ['重', 'kg'],
});

function formatDimensions(value = {}) {
  const parts = Object.entries(DIMENSION_LABELS).flatMap(([field, [label, unit]]) => {
    const number = Number(value?.[field]);
    return Number.isFinite(number) && number > 0 ? [`${label} ${number} ${unit}`] : [];
  });
  return parts.length ? parts.join(' / ') : '暂无数据';
}

function readbackLabel(item = {}) {
  if (item.readbackVerified) return '回读成功';
  const status = String(item.readbackStatus || '').toLowerCase();
  if (['failed', 'mismatch', 'error'].includes(status)) return '回读失败';
  if (['pending', 'running', 'submitted'].includes(status)) return '等待回读';
  return '未完成回读';
}

export function HistoricalDimensionSyncPanel({ model }) {
  const working = model.status === 'previewing' || model.status === 'confirming';
  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          <Box>
            <Typography variant="h6" fontWeight={800}>可选：回传 Ozon 长宽高/重量</Typography>
            <Typography variant="body2" color="text.secondary" mt={0.5}>
              历史订单已经独立保存。本操作默认暂不回传，只有勾选商品、预览差异并人工确认后才会写入 Ozon。
            </Typography>
          </Box>

          <Alert severity="warning">
            这是独立的 Ozon 写入操作。请先核对当前值、拟回传值和历史订单来源；未确认不会执行。
          </Alert>
          {model.message ? <Alert severity={model.message.severity}>{model.message.text}</Alert> : null}

          {model.candidates.length ? (
            <Stack spacing={1}>
              <Typography variant="subtitle2" fontWeight={800}>选择需要回传的商品（默认不选）</Typography>
              {model.candidates.map((candidate) => (
                <Box
                  key={candidate.selectionKey}
                  sx={{ p: 1.25, border: 1, borderColor: 'divider', borderRadius: 2 }}
                >
                  <FormControlLabel
                    sx={{ alignItems: 'flex-start', m: 0 }}
                    control={(
                      <Checkbox
                        checked={model.selectedKeys.includes(candidate.selectionKey)}
                        disabled={working}
                        onChange={() => model.toggleCandidate(candidate.selectionKey)}
                      />
                    )}
                    label={(
                      <Box pt={0.5}>
                        <Typography fontWeight={800}>{candidate.productName}</Typography>
                        <Typography variant="body2" color="text.secondary">
                          来源订单：{candidate.orderNumber || '未知'} · 拟回传：{formatDimensions(candidate.values)}
                        </Typography>
                      </Box>
                    )}
                  />
                </Box>
              ))}
            </Stack>
          ) : (
            <Alert severity="info">本次历史订单导入没有可回传的长宽高或重量数据。</Alert>
          )}

          <Stack direction="row" justifyContent="flex-end">
            <Button
              variant="outlined"
              startIcon={model.status === 'previewing'
                ? <CircularProgress size={16} color="inherit" />
                : <FactCheckRounded />}
              disabled={!model.canPreview}
              onClick={model.runPreview}
            >
              {model.status === 'previewing' ? '正在读取 Ozon 当前值' : '预览新旧值与来源'}
            </Button>
          </Stack>

          {model.preview ? (
            <Stack spacing={1}>
              <Typography variant="subtitle2" fontWeight={800}>回传预览</Typography>
              {model.preview.items.map((item, index) => (
                <Box
                  key={item.selectionKey || `${item.productId}-${index}`}
                  sx={{ p: 1.25, borderRadius: 2, bgcolor: 'action.hover' }}
                >
                  <Typography fontWeight={800}>{item.productName}</Typography>
                  <Typography variant="body2">Ozon 当前值：{formatDimensions(item.currentValues)}</Typography>
                  <Typography variant="body2" color="primary.main">
                    拟回传值：{formatDimensions(item.proposedValues)}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    来源：{item.source?.label || '历史订单本地数据'} · 订单 {item.source?.orderNumber || item.orderNumber || '未知'}
                  </Typography>
                </Box>
              ))}
            </Stack>
          ) : null}

          <Stack direction="row" justifyContent="flex-end">
            <Button
              color="warning"
              variant="contained"
              startIcon={model.status === 'confirming'
                ? <CircularProgress size={16} color="inherit" />
                : <SyncRounded />}
              disabled={!model.canConfirm}
              onClick={model.runConfirm}
            >
              {model.status === 'confirming' ? '正在回传并回读' : '人工确认回传 Ozon'}
            </Button>
          </Stack>

          {model.result ? (
            <Stack spacing={1}>
              <Typography variant="subtitle2" fontWeight={800}>Ozon 回读结果</Typography>
              {model.result.items.map((item, index) => (
                <Box
                  key={item.selectionKey || `${item.productId}-${index}`}
                  sx={{ p: 1.25, border: 1, borderColor: 'divider', borderRadius: 2 }}
                >
                  <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                    <Typography fontWeight={800}>{item.productName}</Typography>
                    <Chip
                      size="small"
                      color={item.readbackVerified ? 'success' : 'warning'}
                      label={readbackLabel(item)}
                    />
                  </Stack>
                  <Typography variant="body2" color="text.secondary" mt={0.5}>
                    Ozon 回读值：{formatDimensions(item.readbackValues)}
                  </Typography>
                </Box>
              ))}
            </Stack>
          ) : null}
        </Stack>
      </CardContent>
    </Card>
  );
}
