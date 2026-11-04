import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';

const TARGET_PHASE_LABELS = Object.freeze({
  idle: '未锁定',
  'target-selecting': '正在锁定',
  'target-locked': '已锁定',
  capturing: '正在捕捉',
  'capture-preview': '等待确认',
  confirming: '正在确认',
  saving: '正在保存',
  readback: '正在回读',
  completed: '已完成',
  error: '需要重试',
});

export function PurchaseBrowserTargetBar({ controller }) {
  const target = controller?.targetMode?.target;
  const phase = controller?.targetMode?.targetPhase || (target ? 'target-locked' : 'idle');
  const phaseLabel = TARGET_PHASE_LABELS[phase] || phase;
  const busy =
    controller?.targetMode?.captureBusy ||
    ['target-selecting', 'capturing', 'confirming', 'saving', 'readback'].includes(phase);
  return (
    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" sx={{ mt: 1 }}>
      <Chip
        size="small"
        color={phase === 'error' ? 'error' : target ? 'primary' : 'default'}
        variant={target ? 'filled' : 'outlined'}
        label={target ? `目标模式：${phaseLabel} · ${target.orderKey}` : `目标模式：${phaseLabel}`}
      />
      {target?.productTitle ? (
        <Typography variant="caption" color="text.secondary">
          {target.productTitle}
        </Typography>
      ) : null}
      <Typography variant="caption" color={phase === 'error' ? 'error.main' : 'text.secondary'}>
        {phase === 'capture-preview' ? '请在预览中核对平台、采购单号、价格和货源链接。' : ''}
      </Typography>
      <Button size="small" onClick={controller?.targetMode?.clearTarget} disabled={!target || busy}>
        解除目标
      </Button>
    </Stack>
  );
}
