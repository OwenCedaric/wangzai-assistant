import Alert from '@mui/material/Alert';
import React from 'react';

export function PurchaseBrowserRecoveryBanner({ controller }) {
  if (controller?.status !== 'failed' || !controller?.tab) return null;
  return <Alert severity="warning">内置浏览器会话异常，请点击“强制刷新”；账号登录状态会保留。</Alert>;
}
