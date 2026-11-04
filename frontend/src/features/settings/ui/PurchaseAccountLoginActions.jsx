import OpenInBrowserRounded from '@mui/icons-material/OpenInBrowserRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import React from 'react';

export function PurchaseAccountLoginActions({ controller }) {
  const browserShown = Boolean(
    controller.panelOpen
    && ['opening', 'loading', 'ready', 'checking', 'checked'].includes(controller.status)
  );
  return (
    <Box className="purchase-account-login-control">
      <Stack className="purchase-account-login-actions" direction="row" spacing={1} alignItems="center">
        <Chip size="small" color={controller.statusColor} variant="outlined" label={controller.statusLabel} />
        <Button
          size="small"
          variant="outlined"
          startIcon={<OpenInBrowserRounded />}
          disabled={!controller.enabled || (!browserShown && controller.busy)}
          title={controller.disabledReason}
          onClick={browserShown ? controller.restoreLogin : controller.openLogin}
        >
          {controller.status === 'opening'
            ? '正在打开'
            : browserShown
              ? '恢复登录窗口'
              : controller.status === 'saved'
                ? '重新登录'
                : '打开登录窗口'}
        </Button>
        {browserShown ? (
          <Button
            size="small"
            color="inherit"
            variant="text"
            startIcon={<CloseRounded />}
            onClick={controller.hideLogin}
          >
            关闭窗口
          </Button>
        ) : null}
      </Stack>
      {controller.errorMessage ? (
        <Alert severity="error" sx={{ mt: 1 }}>
          {controller.errorMessage}
        </Alert>
      ) : null}
    </Box>
  );
}

export default PurchaseAccountLoginActions;
