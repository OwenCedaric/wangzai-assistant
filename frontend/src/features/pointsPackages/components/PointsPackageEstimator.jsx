import AutoAwesomeRounded from '@mui/icons-material/AutoAwesomeRounded';
import ImageRounded from '@mui/icons-material/ImageRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import React from 'react';
import { formatPoints } from '../lib/pointsPackagePricing.js';

export function PointsPackageEstimator({
  imageModelId,
  onImageModelChange,
  imageCount,
  imageCounts,
  onImageCountChange,
  includeRetryReserve,
  onRetryChange,
  imageModel,
  pointsPerLink,
  imageModels,
}) {
  const enabledModelCount = imageModels.length;
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: {
          xs: '1fr',
          md: 'minmax(440px,1.8fr) minmax(220px,.78fr) minmax(190px,.65fr) minmax(180px,.58fr)',
        },
        gap: 1.5,
        p: 1.9,
        border: '1px solid #e7dfd2',
        borderRadius: 2.5,
        bgcolor: '#fffdfb',
        boxShadow: '0 12px 30px rgba(52,50,56,0.07)',
      }}
    >
      <Box
        sx={{
          p: 1.65,
          border: '1px solid #e7dfd2',
          borderRadius: 1.75,
          bgcolor: '#faf7f1',
        }}
      >
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1, mb: 1.15 }}>
          <Typography sx={{ color: '#343238', fontWeight: 900, fontSize: 16 }}>图片模型</Typography>
          <Chip
            size="small"
            label={`已启用 ${enabledModelCount} 个 · 按需切换`}
            sx={{ height: 25, color: '#7b5220', bgcolor: '#fff2d9', fontWeight: 800 }}
          />
        </Box>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,230px),1fr))',
            gap: 0.8,
          }}
        >
          {imageModels.map((model) => {
            const selected = imageModelId === model.id;
            return (
              <Button
                key={model.id}
                variant="text"
                onClick={() => onImageModelChange(model.id)}
                aria-pressed={selected}
                sx={{
                  display: 'flex',
                  alignItems: 'stretch',
                  justifyContent: 'flex-start',
                  gap: 1,
                  minHeight: 104,
                  px: 1.35,
                  py: 1.2,
                  textAlign: 'left',
                  border: `1px solid ${selected ? 'rgba(160,110,47,0.42)' : '#e7dfd2'}`,
                  borderRadius: 1.35,
                  bgcolor: selected ? '#fff2d9' : '#fffdfb',
                  color: '#343238',
                  '&:hover': { bgcolor: selected ? '#fff2d9' : '#faf7f1' },
                }}
              >
                <Box sx={{ display: 'flex', gap: 1, minWidth: 0, flex: 1 }}>
                  <Box
                    sx={{
                      display: 'grid',
                      placeItems: 'center',
                      flex: '0 0 42px',
                      width: 42,
                      height: 42,
                      borderRadius: 1.15,
                      color: selected ? '#a06e2f' : '#6d6870',
                      bgcolor: selected ? '#ffe7bc' : '#f8f4ed',
                    }}
                  >
                    <ImageRounded sx={{ fontSize: 24 }} />
                  </Box>
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}>
                      <Typography sx={{ fontWeight: 900, fontSize: 15 }}>{model.name}</Typography>
                      {selected ? (
                        <Typography sx={{ color: '#a06e2f', fontSize: 11, fontWeight: 900 }}>当前选择</Typography>
                      ) : null}
                    </Box>
                    <Typography sx={{ mt: 0.2, color: '#6d6870', fontSize: 12, lineHeight: 1.45 }}>
                      {model.description}
                    </Typography>
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.55, mt: 0.85 }}>
                      <Typography sx={{ px: 0.8, py: 0.25, borderRadius: 5, bgcolor: '#f5efe6', color: '#62554b', fontSize: 11, fontWeight: 800 }}>
                        {model.qualityLabel}
                      </Typography>
                      <Typography sx={{ px: 0.8, py: 0.25, borderRadius: 5, bgcolor: '#f5efe6', color: '#62554b', fontSize: 11, fontWeight: 800 }}>
                        {model.unitPoints ? `${model.unitPoints} 积分/张` : '按后台价格计费'}
                      </Typography>
                      {model.unitPriceCny ? (
                        <Typography sx={{ px: 0.8, py: 0.25, borderRadius: 5, bgcolor: '#fff2d9', color: '#7b5220', fontSize: 11, fontWeight: 900 }}>
                          ¥{model.unitPriceCny.toFixed(2)}/张
                        </Typography>
                      ) : null}
                    </Box>
                  </Box>
                </Box>
              </Button>
            );
          })}
        </Box>
        <Box
          sx={{
            display: 'flex',
            alignItems: { xs: 'flex-start', sm: 'center' },
            justifyContent: 'space-between',
            flexDirection: { xs: 'column', sm: 'row' },
            gap: 0.6,
            mt: 1,
            pt: 0.9,
            borderTop: '1px dashed #ddd2c3',
          }}
        >
          <Typography sx={{ color: '#62554b', fontSize: 12, fontWeight: 800 }}>
            适用：{imageModel.usageLabel}
          </Typography>
          <Typography sx={{ color: '#8a8078', fontSize: 11.5 }}>
            套餐不锁定模型，生成时仍可切换
          </Typography>
        </Box>
      </Box>

      <Box
        sx={{
          p: 1.65,
          border: '1px solid #e7dfd2',
          borderRadius: 1.75,
          bgcolor: '#faf7f1',
        }}
      >
        <Typography sx={{ color: '#343238', fontWeight: 900, fontSize: 16, mb: 1 }}>成品图片</Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 0.6 }}>
          {imageCounts.map((count) => {
            const selected = imageCount === count;
            return (
              <Button
                key={count}
                onClick={() => onImageCountChange(count)}
                aria-pressed={selected}
                sx={{
                  minHeight: 52,
                  border: `1px solid ${selected ? 'rgba(160,110,47,0.42)' : '#e7dfd2'}`,
                  borderRadius: 1.25,
                  bgcolor: selected ? '#fff2d9' : '#fffdfb',
                  color: selected ? '#7b5220' : '#6d6870',
                  fontSize: 15,
                  fontWeight: 900,
                  '&:hover': { bgcolor: '#fff2d9' },
                }}
              >
                {count} 张
              </Button>
            );
          })}
        </Box>
      </Box>

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          px: 1.75,
          border: '1px solid #e7dfd2',
          borderRadius: 1.75,
          bgcolor: '#faf7f1',
        }}
      >
        <FormControlLabel
          sx={{ m: 0, gap: 0.25, alignItems: 'center' }}
          control={
            <Switch
              checked={includeRetryReserve}
              onChange={(event) => onRetryChange(event.target.checked)}
              sx={{
                '& .MuiSwitch-switchBase.Mui-checked': {
                  color: '#a06e2f',
                  '& + .MuiSwitch-track': { bgcolor: '#a06e2f' },
                },
              }}
            />
          }
          label={
            <Box>
              <Typography sx={{ color: '#343238', fontWeight: 900, fontSize: 16 }}>重试空间</Typography>
              <Typography sx={{ color: '#6d6870', fontSize: 12 }}>预留 25% 图片重做</Typography>
            </Box>
          }
        />
      </Box>

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          flexDirection: 'column',
          justifyContent: 'center',
          p: 1.5,
          border: '1px solid rgba(160,110,47,0.42)',
          borderRadius: 1.75,
          bgcolor: '#fff2d9',
          textAlign: 'center',
        }}
      >
        <Typography sx={{ color: '#62554b', fontSize: 13 }}>单条链接预计</Typography>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.45, my: 0.15 }}>
          <Typography sx={{ color: '#7b5220', fontSize: 40, lineHeight: 1, fontWeight: 900 }}>
            {formatPoints(pointsPerLink)}
          </Typography>
          <Typography sx={{ color: '#7b5220', fontSize: 13 }}>积分</Typography>
        </Box>
        <Typography noWrap sx={{ maxWidth: '100%', color: '#62554b', fontSize: 12 }}>
          {imageModel.name} · {imageCount} 张 <AutoAwesomeRounded sx={{ verticalAlign: 'middle', fontSize: 12 }} />
        </Typography>
      </Box>
    </Box>
  );
}
