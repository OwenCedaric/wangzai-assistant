import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { formatDataAnalysisUserMessage } from '../lib/dataAnalysisFormatter.js';
import { DataAnalysisInsightReport } from './DataAnalysisInsightReport.jsx';

function getInsightErrorMessage(error) {
  const rawMessage = String(error?.payload?.error?.message || error?.message || '').trim();
  if (!rawMessage) return '';
  if (/超时|timeout|timed\s*out/iu.test(rawMessage)) {
    return '分析响应时间较长，本次数据已经保留，请点击“重新分析”。';
  }
  return formatDataAnalysisUserMessage(rawMessage, '店铺报表分析暂时失败，请稍后重试。');
}

export function DataAnalysisInsightDialog({
  open = false,
  onClose,
  dashboard = null,
  filters = {},
  state = {},
  modelOptions = [],
  selectedModelId = 'auto',
  modelSelection = null,
  onModelChange,
  onAnalyze,
}) {
  const loading = state.status === 'loading';
  const preparing = state.status === 'idle';
  const modelLabel = state.model || modelOptions.find((item) => item.id === selectedModelId)?.model || '文本模型';
  const errorMessage = getInsightErrorMessage(state.error);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="data-analysis-insight-dialog"
      minimizeTaskTitle="店铺经营分析报告"
      maxWidth={false}
      PaperProps={{
        className: 'data-analysis-insight-dialog-paper',
        sx: {
          width: 'min(1460px, calc(100vw - 40px))',
          height: 'min(920px, calc(100vh - 40px))',
          maxWidth: 'none',
          borderRadius: '10px',
          overflow: 'hidden',
          bgcolor: '#f5f7fb',
          boxShadow: '0 24px 70px rgba(24, 39, 75, 0.2)',
        },
      }}
    >
      <DialogTitle
        component="div"
        className="data-analysis-insight-dialog-header"
        sx={{ px: { xs: 2, md: 2.5 }, py: 1.7, bgcolor: '#fff', borderBottom: '1px solid #e7ebf2' }}
      >
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.25} alignItems={{ xs: 'stretch', md: 'center' }} justifyContent="space-between">
          <Stack direction="row" spacing={1.1} alignItems="center" minWidth={0}>
            <Box minWidth={0}>
              <Typography variant="h6" fontWeight={900}>店铺经营分析报告</Typography>
              <Typography variant="caption" color="text.secondary">
                {filters.shopId || '全部店铺'} · {filters.startDate || '未指定'} 至 {filters.endDate || '未指定'}
              </Typography>
            </Box>
          </Stack>
          <Stack
            className="data-analysis-insight-dialog-actions"
            direction="row"
            spacing={0.75}
            alignItems="center"
            justifyContent="flex-end"
            minWidth={0}
          >
            <FormControl size="small" sx={{ width: { xs: '100%', md: 320 }, minWidth: 0 }}>
              <Select
                value={selectedModelId}
                onChange={(event) => onModelChange(event.target.value)}
                aria-label="报表分析文本模型"
                sx={{ bgcolor: '#f5f7fb', borderRadius: '7px' }}
              >
                {modelOptions.length ? modelOptions.map((item) => (
                  <MenuItem key={item.id} value={item.id} disabled={!item.ready}>
                    {item.label} · {item.statusLabel}
                  </MenuItem>
                )) : <MenuItem value="auto">未读取到文本模型</MenuItem>}
              </Select>
            </FormControl>
            <Button
              variant="contained"
              disabled={loading || !modelSelection?.ready || !dashboard}
              onClick={onAnalyze}
              sx={{ minWidth: 104, flex: '0 0 auto', borderRadius: '7px', whiteSpace: 'nowrap' }}
            >
              {loading ? <><CircularProgress size={15} color="inherit" sx={{ mr: 0.75 }} />分析中</> : state.status === 'success' ? '重新分析' : '开始分析'}
            </Button>
          </Stack>
        </Stack>
      </DialogTitle>

      <DialogContent className="data-analysis-insight-dialog-content" sx={{ p: { xs: 1.5, md: 2 }, overflowY: 'auto' }}>
        <Stack className="data-analysis-insight-dialog-content-stack" spacing={1.5}>
          {!dashboard ? <Alert severity="info">当前还没有可分析的店铺数据，请先重新计算。</Alert> : null}
          {errorMessage ? <Alert severity="error" sx={{ borderRadius: '7px' }}>{errorMessage}</Alert> : null}

          {loading || preparing ? (
            <Box sx={{ minHeight: 420, display: 'grid', placeItems: 'center', p: 3, borderRadius: '8px', bgcolor: '#fff', boxShadow: '0 10px 30px rgba(31, 52, 88, 0.055)' }}>
              <Stack spacing={1.2} alignItems="center" textAlign="center">
                <CircularProgress size={30} />
                <Typography fontWeight={900}>正在分析当前店铺</Typography>
                <Typography variant="body2" color="text.secondary">正在读取销售、库存、利润、售后和营销数据，并生成经营诊断。</Typography>
              </Stack>
            </Box>
          ) : state.status === 'error' ? (
            <Box sx={{ minHeight: 280, display: 'grid', placeItems: 'center', p: 3, borderRadius: '8px', bgcolor: '#fff', boxShadow: '0 10px 30px rgba(31, 52, 88, 0.055)' }}>
              <Stack spacing={1.2} alignItems="center" textAlign="center">
                <Typography fontWeight={900}>本次分析没有完成</Typography>
                <Typography variant="body2" color="text.secondary">请检查文本模型配置后点击“重新分析”。</Typography>
                <Button variant="outlined" disabled={!modelSelection?.ready || !dashboard} onClick={onAnalyze}>重新分析</Button>
              </Stack>
            </Box>
          ) : state.status === 'success' && dashboard ? (
            <DataAnalysisInsightReport
              dashboard={dashboard}
              filters={filters}
              state={state}
              modelLabel={modelLabel}
              loading={loading}
              modelReady={Boolean(modelSelection?.ready)}
              onAnalyze={onAnalyze}
            />
          ) : null}
        </Stack>
      </DialogContent>
    </Dialog>
  );
}
