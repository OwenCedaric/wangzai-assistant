import BackupRounded from '@mui/icons-material/BackupRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { formatDataBackupCount, formatDataBackupTime } from '../../../dataBackup/lib/dataBackupPresentation.js';
import { canUseAccountRemovalRecentBackup } from '../lib/accountRemovalPresentation.js';

function authorizationLabel(outcome) {
  if (outcome === 'exported') return '本次新备份已验证';
  if (outcome === 'recent-verified') return '已选择覆盖当前数据的最近备份';
  if (outcome === 'explicitly-skipped') return '已明确选择跳过备份';
  return '备份审阅已完成';
}

export function AccountRemovalBackupGate({
  review,
  authorization,
  busy,
  errorMessage,
  onUseRecentBackup,
  onOpenSkip,
}) {
  if (review?.required !== true) {
    return (
      <Alert severity="info" variant="outlined">
        当前账号没有必须单独备份的数据，可以继续核对删除范围。
      </Alert>
    );
  }

  if (authorization) {
    return (
      <Alert severity={authorization.outcome === 'explicitly-skipped' ? 'warning' : 'success'}>
        {authorizationLabel(authorization.outcome)}。请继续核对下方范围，再确认永久删除。
      </Alert>
    );
  }

  const recentBackupReady = canUseAccountRemovalRecentBackup(review);
  return (
    <Box sx={{ border: '1px solid', borderColor: 'warning.light', borderRadius: 2, p: 1.75, bgcolor: 'warning.50' }}>
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1} alignItems="center">
          <BackupRounded color="warning" />
          <Box sx={{ flex: 1 }}>
            <Typography fontWeight={800}>删除前先确认是否需要备份</Typography>
            <Typography variant="body2" color="text.secondary">
              当前有 {formatDataBackupCount(review.totalRecords)} 条数据无法通过重新同步恢复。
            </Typography>
          </Box>
        </Stack>
        {errorMessage ? <Alert severity="error">{errorMessage}</Alert> : null}
        <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
          {review.domains.map((domain) => (
            <Chip
              key={domain.domain || domain.label}
              size="small"
              variant="outlined"
              label={`${domain.label} ${formatDataBackupCount(domain.recordCount)} 条`}
            />
          ))}
        </Stack>
        {review.latestVerifiedBackup ? (
          <Alert severity={recentBackupReady ? 'success' : 'warning'} variant="outlined">
            最近备份：{formatDataBackupTime(review.latestVerifiedBackup.verifiedAt)}。
            {recentBackupReady ? '已校验、覆盖当前数据，并会在删号后保留。' : '未覆盖当前数据或删号后不会保留，不能直接使用。'}
          </Alert>
        ) : null}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between">
          <Button
            size="small"
            variant="outlined"
            disabled={!recentBackupReady || busy}
            onClick={onUseRecentBackup}
          >
            使用最近已验证备份
          </Button>
          <Button size="small" color="error" variant="text" disabled={busy} onClick={onOpenSkip}>
            跳过备份并永久删除
          </Button>
        </Stack>
      </Stack>
    </Box>
  );
}
