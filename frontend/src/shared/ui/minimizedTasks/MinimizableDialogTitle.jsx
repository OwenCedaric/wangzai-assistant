import CloseRounded from '@mui/icons-material/CloseRounded';
import MinimizeRounded from '@mui/icons-material/MinimizeRounded';
import Box from '@mui/material/Box';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';

export function MinimizableDialogTitle({
  title,
  subtitle = '',
  titleId,
  actions = null,
  onMinimize = () => {},
  onClose = () => {},
  disabled = false,
  minimizeLabel = '最小化订单弹窗',
  closeLabel = '关闭订单弹窗',
}) {
  return (
    <DialogTitle component="div" className="minimizable-dialog-title">
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2}>
        <Box minWidth={0}>
          <Typography id={titleId} variant="h6" noWrap>{title}</Typography>
          {subtitle ? <Typography variant="body2" color="text.secondary" noWrap>{subtitle}</Typography> : null}
        </Box>
        {actions ? <Box className="minimizable-dialog-title-actions">{actions}</Box> : null}
        <Stack direction="row" alignItems="center" spacing={0.5}>
          <IconButton
            size="small"
            className="global-dialog-control global-dialog-minimize-control"
            aria-label={minimizeLabel}
            disabled={disabled}
            onClick={onMinimize}
          >
            <MinimizeRounded />
          </IconButton>
          <IconButton
            size="small"
            className="global-dialog-control global-dialog-close-control"
            aria-label={closeLabel}
            disabled={disabled}
            onClick={onClose}
          >
            <CloseRounded />
          </IconButton>
        </Stack>
      </Stack>
    </DialogTitle>
  );
}
