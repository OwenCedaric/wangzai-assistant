import CheckRounded from '@mui/icons-material/CheckRounded';
import LockRounded from '@mui/icons-material/LockRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import React from 'react';

const PREPARED_STAGES = new Set([
  'ozon_prepared',
  'label_waiting',
  'label_ready',
  'forecast_submitting',
  'completed',
]);
const LABEL_READY_STAGES = new Set(['label_ready', 'forecast_submitting', 'completed']);

function getStepState({ done, running, enabled }) {
  if (done) return 'done';
  if (running) return 'running';
  if (enabled) return 'ready';
  return 'locked';
}

function StepIcon({ index, state }) {
  const color = state === 'done' ? 'success.main' : state === 'ready' || state === 'running' ? 'primary.main' : 'grey.400';
  return (
    <Box
      sx={{
        width: 34,
        height: 34,
        borderRadius: '50%',
        bgcolor: state === 'done' || state === 'ready' ? color : 'background.paper',
        border: '2px solid',
        borderColor: color,
        color: state === 'done' || state === 'ready' ? 'common.white' : color,
        display: 'grid',
        placeItems: 'center',
        position: 'relative',
        zIndex: 1,
      }}
    >
      {state === 'done' ? <CheckRounded sx={{ fontSize: 21 }} /> : null}
      {state === 'running' ? <CircularProgress size={22} thickness={5} /> : null}
      {state === 'ready' ? <Typography variant="caption" fontWeight={800}>{index + 1}</Typography> : null}
      {state === 'locked' ? <LockRounded sx={{ fontSize: 17 }} /> : null}
    </Box>
  );
}

function ForecastStep({ index, title, state, stateText, buttonText, onClick, disabled, manual }) {
  return (
    <Stack alignItems="center" spacing={0.7} sx={{ minWidth: 0, position: 'relative', zIndex: 1 }}>
      <StepIcon index={index} state={state} />
      <Typography variant="subtitle2" fontWeight={800} textAlign="center">
        {title}
      </Typography>
      <Typography
        variant="caption"
        color={state === 'done' ? 'success.main' : state === 'ready' || state === 'running' ? 'primary.main' : 'text.secondary'}
        textAlign="center"
      >
        {stateText}
      </Typography>
      {manual ? (
        <Button
          size="small"
          variant={state === 'ready' ? 'contained' : 'outlined'}
          color={state === 'done' ? 'success' : 'primary'}
          onClick={onClick}
          disabled={disabled || state === 'done' || state === 'locked' || state === 'running'}
          sx={{ borderRadius: 1, minWidth: 150, mt: 0.4 }}
        >
          {buttonText}
        </Button>
      ) : null}
    </Stack>
  );
}

export function PurchaseForecastStepper({
  flow = {},
  executionMode = 'manual',
  loading = false,
  autoRunning = false,
  activeStep = '',
  confirmed = false,
  message = '',
  canPrepare = false,
  canCheckLabel = false,
  canSubmit = false,
  canRunAuto = false,
  onExecutionModeChange = () => {},
  onPrepare = () => {},
  onCheckLabel = () => {},
  onSubmit = () => {},
  onAutoRun = () => {},
}) {
  const stage = String(flow.stage || 'idle');
  const automatic = executionMode === 'auto';
  const prepared = PREPARED_STAGES.has(stage);
  const labelReady = LABEL_READY_STAGES.has(stage);
  const completed = stage === 'completed';
  const busy = loading || autoRunning;
  const waitingText = automatic ? '等待自动执行' : '等待手动执行';
  const steps = [
    {
      title: 'Ozon 备货',
      state: getStepState({ done: prepared, running: activeStep === 'ozon', enabled: !prepared && !busy }),
      stateText: prepared ? '备货已完成' : activeStep === 'ozon' ? '正在提交备货' : waitingText,
      buttonText: prepared ? '备货已完成' : activeStep === 'ozon' ? '备货处理中…' : '执行第一步',
      onClick: onPrepare,
      disabled: !canPrepare,
    },
    {
      title: '获取并核对面单',
      state: getStepState({ done: labelReady, running: activeStep === 'label', enabled: prepared && !labelReady && !busy }),
      stateText: labelReady ? '面单已生成' : activeStep === 'label' ? '正在监控面单' : prepared ? waitingText : '等待上一步',
      buttonText: labelReady ? '面单已生成' : stage === 'label_waiting' ? '继续监控面单' : '获取并核对面单',
      onClick: onCheckLabel,
      disabled: !canCheckLabel,
    },
    {
      title: '预报跨境订单',
      state: getStepState({ done: completed, running: activeStep === 'forecast', enabled: labelReady && !completed && !busy }),
      stateText: completed ? '预报已完成' : activeStep === 'forecast' ? '正在提交预报' : labelReady ? waitingText : '等待上一步',
      buttonText: completed ? '预报已完成' : activeStep === 'forecast' ? '预报处理中…' : '预报订单',
      onClick: onSubmit,
      disabled: !canSubmit,
    },
  ];
  const completedSegments = labelReady ? 2 : prepared ? 1 : 0;

  return (
    <Box
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        p: { xs: 1.5, sm: 2 },
        bgcolor: 'background.paper',
      }}
    >
      <Stack spacing={2}>
        <Stack direction="row" alignItems="center" justifyContent="flex-end" spacing={1}>
          <Typography variant="caption" color="text.secondary">执行模式</Typography>
          <Switch
            size="small"
            checked={automatic}
            disabled={busy || completed}
            onChange={(event) => onExecutionModeChange(event.target.checked ? 'auto' : 'manual')}
            slotProps={{ input: { 'aria-label': '切换预报执行模式' } }}
          />
          <Typography variant="body2" fontWeight={700} color={automatic ? 'primary.main' : 'text.secondary'}>
            {automatic ? '自动模式' : '手动模式'}
          </Typography>
        </Stack>

        <Box sx={{ position: 'relative', px: { xs: 0, sm: 2 } }}>
          <Box
            sx={{
              display: { xs: 'none', sm: 'grid' },
              gridTemplateColumns: '1fr 1fr',
              position: 'absolute',
              top: 15,
              left: '18%',
              right: '18%',
              gap: 0,
            }}
          >
            {[0, 1].map((index) => (
              <Box key={index} sx={{ height: 3, bgcolor: completedSegments > index ? 'success.main' : 'divider' }} />
            ))}
          </Box>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' },
              gap: { xs: 2, sm: 1 },
            }}
          >
            {steps.map((step, index) => (
              <ForecastStep key={step.title} index={index} manual={!automatic} {...step} />
            ))}
          </Box>
        </Box>

        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          alignItems={{ xs: 'stretch', sm: 'center' }}
          justifyContent="space-between"
          spacing={1.5}
          sx={{
            bgcolor: completed ? 'rgba(32, 183, 122, 0.08)' : 'rgba(91, 134, 255, 0.08)',
            borderRadius: 1,
            px: 1.5,
            py: 1.25,
          }}
        >
          <Box minWidth={0}>
            <Typography variant="body2" fontWeight={700}>
              {completed
                ? '全部步骤已经完成，状态已保存。'
                : message || (automatic
                  ? '自动模式会按顺序完成备货、面单核对和订单预报。'
                  : '手动模式下，每一步完成后再手动执行下一步。')}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {!confirmed
                ? '请先勾选下方真实写入确认。'
                : automatic
                  ? '中途失败会停在当前节点，不会重复执行已经完成的步骤。'
                  : '未完成的节点保持锁定，避免跳步和重复提交。'}
            </Typography>
          </Box>
          {automatic && !completed ? (
            <Button
              variant="contained"
              onClick={onAutoRun}
              disabled={!canRunAuto || busy}
              sx={{ borderRadius: 1, minWidth: 150, flexShrink: 0 }}
            >
              {autoRunning ? '自动处理中…' : prepared || labelReady ? '继续自动处理' : '开始自动处理'}
            </Button>
          ) : null}
        </Stack>

        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 0.5, sm: 2 }}>
          <Typography variant="caption" color="text.secondary">
            Ozon 状态：{flow.ozonStatus || '待检查'}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            面单：{flow.sheetOrderSn || '尚未生成'}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            最近检查：{flow.lastCheckedAt
              ? new Date(flow.lastCheckedAt).toLocaleString('zh-CN', { hour12: false })
              : '尚未检查'}
          </Typography>
        </Stack>
      </Stack>
    </Box>
  );
}
