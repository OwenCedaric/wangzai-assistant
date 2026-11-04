import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { RecoveryBackupCard } from './RecoveryBackupCard.jsx';

export function RecoveryStartupPage() {
  return (
    <Box
      data-recovery-startup-ready="true"
      sx={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        p: 2,
        bgcolor: '#f5f7fb',
      }}
    >
      <Stack spacing={2} sx={{ width: '100%', maxWidth: 680 }}>
        <Box>
          <Typography variant="h4">资料恢复模式</Typography>
          <Typography color="text.secondary" mt={0.75}>
            当前本机业务数据库不可用，恢复完成前不会打开普通业务页面。
          </Typography>
        </Box>
        <Alert severity="warning">
          请从服务器读取并校验恢复备份。此页面不包含登录、注册或授权购买入口。
        </Alert>
        <RecoveryBackupCard recoveryOnly />
      </Stack>
    </Box>
  );
}
