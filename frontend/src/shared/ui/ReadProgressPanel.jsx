import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';

const READ_PROGRESS_PANEL_HEIGHT = 44;

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(100, Math.max(0, number));
}

function getProgressPercent({ percent, completed, total }) {
  if (percent !== undefined && percent !== null) return clampPercent(percent);
  const done = Number(completed);
  const count = Number(total);
  if (!Number.isFinite(done) || !Number.isFinite(count) || count <= 0) return 0;
  return clampPercent(Math.round((done / count) * 100));
}

export function ReadProgressPanel({
  visible = false,
  running = false,
  message = '',
  completed = 0,
  total = 0,
  errors = 0,
  percent,
  runningText = '读取中',
  ariaLabel = '读取进度',
  width = 280,
}) {
  const safeTotal = Number(total) > 0 ? Number(total) : 0;
  const safeCompleted = Math.max(0, Number(completed) || 0);
  const progressPercent = getProgressPercent({ percent, completed: safeCompleted, total: safeTotal });
  const hasKnownTotal = running && safeTotal > 0;
  const progressVariant = running && !hasKnownTotal ? 'indeterminate' : 'determinate';
  const progressText = hasKnownTotal
    ? `${Math.min(safeCompleted, safeTotal)}/${safeTotal} · ${progressPercent}%`
    : running
      ? runningText
      : '';
  const statusText = message || (running ? '正在读取数据' : '');
  const errorText = Number(errors) > 0 ? `异常 ${errors}` : '';

  return (
    <Box
      aria-label={ariaLabel}
      title={[statusText, progressText, errorText].filter(Boolean).join(' ')}
      sx={{
        width: { xs: '100%', md: width },
        height: READ_PROGRESS_PANEL_HEIGHT,
        flexShrink: 0,
        visibility: visible ? 'visible' : 'hidden',
        opacity: visible ? 1 : 0,
        transition: 'opacity 160ms ease',
      }}
    >
      <Box
        sx={{
          height: '100%',
          boxSizing: 'border-box',
          border: '1px solid',
          borderColor: errors > 0 ? 'warning.light' : 'primary.light',
          borderRadius: 1,
          px: 1.25,
          py: 0.75,
          bgcolor: 'background.paper',
          boxShadow: '0 8px 22px rgba(31, 64, 120, 0.08)',
        }}
      >
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} mb={0.5}>
          <Typography variant="caption" color="text.secondary" noWrap>
            {statusText}
          </Typography>
          <Typography
            variant="caption"
            color={errors > 0 ? 'warning.main' : 'primary.main'}
            noWrap
            sx={{ flexShrink: 0 }}
          >
            {errorText || progressText}
          </Typography>
        </Stack>
        <LinearProgress
          variant={progressVariant}
          value={progressVariant === 'determinate' ? progressPercent : undefined}
          sx={{
            height: 5,
            borderRadius: 999,
            bgcolor: 'action.hover',
            '& .MuiLinearProgress-bar': {
              borderRadius: 999,
            },
          }}
        />
      </Box>
    </Box>
  );
}
