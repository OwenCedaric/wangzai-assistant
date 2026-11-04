import ApiRounded from '@mui/icons-material/ApiRounded';
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded';
import ErrorOutlineRounded from '@mui/icons-material/ErrorOutlineRounded';
import StarRounded from '@mui/icons-material/StarRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Radio from '@mui/material/Radio';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';
import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';

const STATUS_META = Object.freeze({
  available: { label: 'API 可用', color: 'success' },
  busy: { label: 'API 繁忙', color: 'warning' },
  cooling: { label: 'API 冷却中', color: 'warning' },
  unavailable: { label: 'API 不可用', color: 'default' },
});

function ModelCard({ item, enabled, isDefault, disableLast, onToggle, onDefault }) {
  const status = STATUS_META[item.apiStatus] || STATUS_META.unavailable;
  return (
    <Box
      sx={{
        minWidth: 0,
        p: 1.4,
        border: `1px solid ${enabled ? 'rgba(160,110,47,0.5)' : '#e7dfd2'}`,
        borderRadius: 1.6,
        bgcolor: enabled ? '#fff9ed' : '#fff',
        opacity: item.canEnable ? 1 : 0.62,
      }}
    >
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={1}>
        <Box sx={{ minWidth: 0 }}>
          <Typography noWrap sx={{ color: '#343238', fontWeight: 900, fontSize: 15 }}>
            {item.displayName}
          </Typography>
          <Typography noWrap title={item.modelCode} sx={{ color: '#807980', fontSize: 11.5 }}>
            {item.modelCode}
          </Typography>
        </Box>
        <Checkbox
          checked={enabled}
          disabled={!item.canEnable || disableLast}
          onChange={() => onToggle(item.modelCode)}
          inputProps={{ 'aria-label': `启用 ${item.displayName}` }}
          sx={{ p: 0.2, color: '#b39b7f', '&.Mui-checked': { color: '#a06e2f' } }}
        />
      </Stack>
      <Stack direction="row" alignItems="center" spacing={0.7} useFlexGap flexWrap="wrap" sx={{ mt: 1 }}>
        <Chip
          size="small"
          color={status.color}
          variant="outlined"
          label={status.label}
          icon={item.apiStatus === 'available' ? <CheckCircleRounded /> : <ErrorOutlineRounded />}
          sx={{ height: 24, '& .MuiChip-label': { px: 0.7, fontSize: 11.5, fontWeight: 800 } }}
        />
        <Chip
          size="small"
          variant="outlined"
          icon={<ApiRounded />}
          label={`${item.availableApiCount}/${item.configuredApiCount} 个 API`}
          sx={{ height: 24, '& .MuiChip-label': { px: 0.7, fontSize: 11.5, fontWeight: 800 } }}
        />
        {item.pricedCapabilityCount < item.totalCapabilityCount ? (
          <Chip
            size="small"
            variant="outlined"
            label={`已计价 ${item.pricedCapabilityCount}/${item.totalCapabilityCount}`}
            sx={{ height: 24, '& .MuiChip-label': { px: 0.7, fontSize: 11.5 } }}
          />
        ) : null}
      </Stack>
      {item.unavailableReason ? (
        <Typography sx={{ mt: 0.8, color: '#b35b45', fontSize: 11.5, lineHeight: 1.45 }}>
          {item.unavailableReason}
        </Typography>
      ) : null}
      {enabled ? (
        <Button
          size="small"
          startIcon={<StarRounded />}
          onClick={() => onDefault(item.modelCode)}
          disabled={isDefault}
          sx={{ mt: 0.9, minHeight: 28, px: 0.8, color: isDefault ? '#a06e2f' : '#6d6870' }}
        >
          <Radio checked={isDefault} size="small" sx={{ display: 'none' }} />
          {isDefault ? '当前默认模型' : '设为默认模型'}
        </Button>
      ) : null}
    </Box>
  );
}

export function PointsPackageModelPresetDialog({ model }) {
  return (
    <Dialog
      open={model.modelPresetOpen}
      onClose={model.modelPresetSaving ? undefined : model.closeModelPreset}
      fullWidth
      maxWidth="md"
      PaperProps={{ sx: { borderRadius: 2.5, overflow: 'hidden' } }}
    >
      <DialogTitle sx={{ px: 2.5, pt: 2.2, pb: 1.3 }}>
        <Typography component="div" sx={{ color: '#343238', fontSize: 21, fontWeight: 900 }}>
          模型预设与生效 API
        </Typography>
        <Typography sx={{ mt: 0.35, color: '#6d6870', fontSize: 13 }}>
          设置只跟当前软件账号走，不按 Ozon 店铺拆分。启用模型后，系统会自动调度该模型下全部可用 API Key。
        </Typography>
      </DialogTitle>
      <Divider />
      <DialogContent sx={{ px: 2.5, py: 2, minHeight: 360 }}>
        {model.modelPresetLoading ? (
          <Box sx={{ minHeight: 300, display: 'grid', placeItems: 'center' }}>
            <CircularProgress sx={{ color: '#a06e2f' }} />
          </Box>
        ) : (
          <Stack spacing={2}>
            {model.modelPresetError ? <Alert severity="error">{model.modelPresetError}</Alert> : null}
            {model.modelPresetGroups.map((group) => (
              <Box key={group.capabilityKind}>
                <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                  <Box>
                    <Typography sx={{ color: '#343238', fontSize: 17, fontWeight: 900 }}>{group.label}</Typography>
                    <Typography sx={{ color: '#807980', fontSize: 12 }}>
                      {group.capabilityKind === 'image'
                        ? '图片生成已固定使用 已配置的图片服务 的 gpt-image-2。'
                        : `已启用 ${group.enabledModels.length} 个；每次调用优先使用默认模型。`}
                    </Typography>
                  </Box>
                  <Chip
                    size="small"
                    label={`默认：${group.defaultModel || '未设置'}`}
                    sx={{ maxWidth: 250, bgcolor: '#fff2d9', color: '#7b5220', fontWeight: 800 }}
                  />
                </Stack>
                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', sm: 'repeat(2,minmax(0,1fr))' },
                    gap: 1,
                  }}
                >
                  {group.models.map((item) => {
                    const enabled = group.enabledModels.includes(item.modelCode);
                    return (
                      <ModelCard
                        key={item.modelCode}
                        item={item}
                        enabled={enabled}
                        isDefault={group.defaultModel === item.modelCode}
                        disableLast={enabled && group.enabledModels.length === 1}
                        onToggle={(modelCode) => model.toggleModelPreset(group.capabilityKind, modelCode)}
                        onDefault={(modelCode) => model.setDefaultPresetModel(group.capabilityKind, modelCode)}
                      />
                    );
                  })}
                </Box>
              </Box>
            ))}
            {!model.modelPresetGroups.length && !model.modelPresetError ? (
              <Alert severity="info">管理后台还没有可用并已计价的模型。</Alert>
            ) : null}
          </Stack>
        )}
      </DialogContent>
      <Divider />
      <DialogActions sx={{ px: 2.5, py: 1.5 }}>
        <Button onClick={model.closeModelPreset} disabled={model.modelPresetSaving} color="inherit">
          取消
        </Button>
        <Button
          variant="contained"
          onClick={model.saveModelPreset}
          disabled={model.modelPresetLoading || model.modelPresetSaving || !model.modelPresetGroups.length}
          sx={{ minWidth: 118, bgcolor: '#a06e2f', '&:hover': { bgcolor: '#87591f' } }}
        >
          {model.modelPresetSaving ? <CircularProgress size={18} color="inherit" /> : '保存并立即生效'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
