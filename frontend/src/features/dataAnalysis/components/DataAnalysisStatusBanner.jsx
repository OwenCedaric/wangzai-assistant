import ErrorOutlineRounded from '@mui/icons-material/ErrorOutlineRounded';
import { formatDataAnalysisUserMessage } from '../lib/dataAnalysisFormatter.js';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

export function DataAnalysisLoadingState() {
  return (
    <Box sx={{ py: 8, textAlign: 'center' }}>
      <Stack alignItems="center" spacing={1.5}>
        <CircularProgress size={36} />
        <Typography fontWeight={900}>正在读取本地真实数据</Typography>
        <Typography color="text.secondary" variant="body2">
          正在从订单、商品、财务、售后、活动和人工确认成本的本地数据生成经营分析。
        </Typography>
      </Stack>
    </Box>
  );
}

export function DataAnalysisErrorState({ error, onRetry }) {
  const message = formatDataAnalysisUserMessage(
    error?.payload?.error?.message || error?.message,
    '本地数据服务没有返回可用分析结果，请重新读取。'
  );
  return (
    <Box sx={{ p: 3, borderRadius: 3, bgcolor: 'error.lighter' }}>
      <Stack spacing={1.2} alignItems="flex-start">
        <Stack direction="row" spacing={1} alignItems="center">
          <ErrorOutlineRounded color="error" />
          <Typography fontWeight={900}>数据分析读取失败</Typography>
        </Stack>
        <Typography color="text.secondary">{message}</Typography>
        <Button variant="text" color="error" onClick={onRetry}>
          重新读取
        </Button>
      </Stack>
    </Box>
  );
}
