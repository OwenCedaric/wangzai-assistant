import { formatDataAnalysisTime } from '../lib/dataAnalysisFormatter.js';
import AnalyticsRounded from '@mui/icons-material/AnalyticsRounded';
import AutoGraphRounded from '@mui/icons-material/AutoGraphRounded';
import AutoAwesomeRounded from '@mui/icons-material/AutoAwesomeRounded';
import InfoOutlined from '@mui/icons-material/InfoOutlined';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

function getCurrencyHint(status, meta = {}) {
  if (status === 'loading') return '正在为数据分析读取卢布兑人民币汇率';
  if (status === 'partial') return '部分金额已按对应日期汇率折算人民币';
  if (status === 'success' && (meta?.totalRows || meta?.status === 'confirmed')) return '数据分析金额已按对应日期汇率折算人民币';
  return '快速判断流量、销售、商品和履约状态';
}

export function DataAnalysisHeader({
  updatedAt,
  loading,
  currencyStatus,
  currencyMeta,
  onRebuild,
  onOpenInfo,
  onOpenAnalysis,
}) {
  return (
    <Stack
      direction={{ xs: 'column', md: 'row' }}
      alignItems={{ xs: 'stretch', md: 'center' }}
      justifyContent="space-between"
      spacing={1.5}
    >
      <Stack direction="row" spacing={1.25} alignItems="center" minWidth={0}>
        <Box
          sx={{
            width: 40,
            height: 40,
            display: 'grid',
            placeItems: 'center',
            flex: '0 0 auto',
            borderRadius: 2.5,
            color: 'primary.main',
            bgcolor: 'rgba(93, 135, 255, 0.1)',
          }}
        >
          <AnalyticsRounded />
        </Box>
        <Box minWidth={0}>
          <Stack direction="row" spacing={1} alignItems="baseline" flexWrap="wrap" useFlexGap>
            <Typography variant="h4" fontWeight={900} sx={{ fontSize: { xs: 22, md: 26 } }}>
              数据分析
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {getCurrencyHint(currencyStatus, currencyMeta)}
            </Typography>
          </Stack>
          <Typography variant="caption" color="text.secondary">
            数据更新于 {formatDataAnalysisTime(updatedAt, '待读取')}
          </Typography>
        </Box>
      </Stack>
      <Stack direction="row" spacing={1} alignItems="center" justifyContent={{ xs: 'flex-end', md: 'flex-start' }}>
        <Button size="small" variant="text" startIcon={<InfoOutlined />} onClick={onOpenInfo}>
          数据说明
        </Button>
        <Button size="small" variant="text" startIcon={<AutoAwesomeRounded />} onClick={onOpenAnalysis}>
          数据分析
        </Button>
        <Button
          size="small"
          variant="contained"
          startIcon={<AutoGraphRounded />}
          disabled={loading}
          onClick={onRebuild}
        >
          {loading ? '计算中' : '重新计算'}
        </Button>
      </Stack>
    </Stack>
  );
}
