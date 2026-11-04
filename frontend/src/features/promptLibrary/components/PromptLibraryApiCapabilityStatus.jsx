import ApiRounded from '@mui/icons-material/ApiRounded';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

function bindingTone(binding = {}) {
  if (binding.compileStatus === 'executable') return 'success';
  if (binding.compileStatus === 'guarded' || binding.compileStatus === 'missing_configuration') return 'warning';
  if (binding.compileStatus === 'unsupported') return 'error';
  return 'default';
}

export function PromptLibraryApiCapabilityStatus({ match, compact = false, showRegistryTotal = false }) {
  if (!match?.totalCount) return null;
  const plan = match.executionPlan || null;

  return (
    <Box
      className="prompt-library-api-capability-status"
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1.5,
        p: compact ? 1.15 : 1.5,
        bgcolor: 'background.paper',
      }}
    >
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} sx={{ mb: 1 }}>
        <Stack direction="row" alignItems="center" spacing={0.75}>
          <ApiRounded color="primary" fontSize="small" />
          <Typography variant="subtitle2">Skill 执行计划</Typography>
        </Stack>
        <Chip
          size="small"
          color={
            plan?.unsupportedCount
              ? 'error'
              : plan?.missingConfigurationCount || plan?.guardedCount
                ? 'warning'
                : 'success'
          }
          variant="outlined"
          label={
            plan
              ? `${plan.executableCount}/${plan.totalCount} 可执行`
              : `${match.readyCount}/${match.totalCount} 已配置`
          }
        />
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {plan?.summaryLabel || match.summaryLabel}
        {showRegistryTotal ? `；底层已预装 ${match.registryEndpointCount} 个平台接口定义。` : '。'}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        这里只统计有真实执行器的步骤；点击运行后，以结果里的“本次步骤执行记录”为准。
      </Typography>
      <Stack spacing={0.65}>
        {match.bindings.map((binding) => {
          const compiled = plan?.steps?.find((item) => item.id === binding.id) || binding;
          return (
            <Stack key={binding.id} direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
              <Typography variant="body2" noWrap title={binding.label}>
                {binding.label}
                {binding.endpointCount ? ` · ${binding.endpointCount} 个接口` : ''}
              </Typography>
              <Chip
                size="small"
                color={bindingTone(compiled)}
                variant="outlined"
                label={compiled.compileStatusLabel || binding.statusLabel}
              />
            </Stack>
          );
        })}
      </Stack>
      {match.guardedCount ? (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          写入步骤必须经过预览、确认、提交、平台回读和审计，不能由模型直接写入。
        </Typography>
      ) : null}
    </Box>
  );
}
