import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import {
  formatDataBackupBytes,
  formatDataBackupCount,
  formatDataBackupTime,
} from '../lib/dataBackupPresentation.js';

export function DataBackupOverviewPanel({ shop, loading = false }) {
  return (
    <Card variant="outlined" sx={{ height: '100%' }}>
      <CardContent>
        <Stack spacing={2}>
          <Box>
            <Typography variant="h6" fontWeight={800}>不可重建数据概览</Typography>
          </Box>

          {loading && !shop ? (
            <Stack direction="row" spacing={1} alignItems="center" color="text.secondary">
              <CircularProgress size={18} />
              <Typography variant="body2">正在读取不可重建数据…</Typography>
            </Stack>
          ) : null}

          {!loading && !shop ? <Alert severity="info">当前账号/店铺没有可展示的备份概览。</Alert> : null}

          {shop ? (
            <>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
                <Typography fontWeight={800} sx={{ flex: 1 }}>{shop.displayName || shop.shopId}</Typography>
                <Chip color="primary" label={`${formatDataBackupCount(shop.totalRecords)} 条用户事实`} />
              </Stack>
              {shop.domains.length ? (
                <Box sx={{ overflowX: 'auto' }}>
                  <Table size="small" aria-label="不可重建数据领域">
                    <TableHead>
                      <TableRow>
                        <TableCell>数据名称</TableCell>
                        <TableCell align="right">记录数</TableCell>
                        <TableCell align="right">预计体积</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {shop.domains.map((domain) => (
                        <TableRow key={domain.domain || domain.label}>
                          <TableCell>{domain.label}</TableCell>
                          <TableCell align="right">{formatDataBackupCount(domain.recordCount)}</TableCell>
                          <TableCell align="right">{formatDataBackupBytes(domain.logicalBytes)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Box>
              ) : (
                <Alert severity="success">当前账号/店铺没有不可重建的用户事实。</Alert>
              )}
              {shop.latestVerifiedBackup ? (
                <Alert
                  severity={shop.latestVerifiedBackup.coversCurrentData ? 'success' : 'warning'}
                  icon={shop.latestVerifiedBackup.coversCurrentData
                    ? <CheckCircleRounded fontSize="inherit" />
                    : undefined}
                >
                  最近一次已验证备份：{formatDataBackupTime(shop.latestVerifiedBackup.completedAt)}。
                  {shop.latestVerifiedBackup.coversCurrentData
                    ? ' 已覆盖当前数据。'
                    : shop.latestVerifiedBackup.coverageMode === 'partial'
                      ? ' 这是按选项导出的部分备份，不覆盖未勾选数据。'
                      : ' 当前数据已变化，请重新导出。'}
                </Alert>
              ) : null}
            </>
          ) : null}
        </Stack>
      </CardContent>
    </Card>
  );
}
