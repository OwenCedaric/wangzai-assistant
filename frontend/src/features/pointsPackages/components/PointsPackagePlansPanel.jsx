import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';
import { PointsPackageCard } from './PointsPackageCard.jsx';
import { PointsPackageEstimator } from './PointsPackageEstimator.jsx';

export function PointsPackagePlansPanel({ model }) {
  return (
    <Stack spacing={{ xs: 1.5, md: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, px: 0.5 }}>
        <Box>
          <Typography
            component="h1"
            sx={{
              mt: 0,
              color: '#343238',
              fontSize: { xs: 24, md: 30 },
              lineHeight: 1.2,
              fontWeight: 900,
            }}
          >
            选择积分套餐
          </Typography>
          <Typography sx={{ mt: 0.5, color: '#6d6870', fontSize: 13 }}>
            标题、属性、俄语文案和商品图统一使用积分结算
          </Typography>
        </Box>
        <Typography
          sx={{
            maxWidth: 460,
            color: '#6d6870',
            fontSize: 13,
            lineHeight: 1.6,
            textAlign: 'right',
          }}
        >
          可根据图片模型、图片数量和重试空间预估每个套餐可完成的链接数量。
        </Typography>
      </Box>
      {model.loadError ? (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => model.refreshAccount()}>
              重新加载
            </Button>
          }
        >
          {model.loadError}
        </Alert>
      ) : null}
      <PointsPackageEstimator
        imageModelId={model.imageModelId}
        onImageModelChange={model.setImageModelId}
        imageCount={model.imageCount}
        imageCounts={model.imageCounts}
        onImageCountChange={model.setImageCount}
        includeRetryReserve={model.includeRetryReserve}
        onRetryChange={model.setIncludeRetryReserve}
        imageModel={model.imageModel}
        pointsPerLink={model.pointsPerLink}
        imageModels={model.imageModels}
      />
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, px: 0.5 }}>
        <Typography component="h2" sx={{ fontSize: 25, fontWeight: 900 }}>
          充值套餐
        </Typography>
        <Typography sx={{ color: '#6d6870', fontSize: 14 }}>
          {model.includeRetryReserve ? '已包含 25% 重试空间' : '按单次生成成功估算'}，数量仅作预估
        </Typography>
      </Box>
      {model.loading ? (
        <Box sx={{ display: 'grid', placeItems: 'center', minHeight: 220 }}>
          <CircularProgress sx={{ color: '#a06e2f' }} />
        </Box>
      ) : (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(3, minmax(0, 1fr))' },
            gap: 1.5,
          }}
        >
          {model.packages.map((packageItem) => (
            <PointsPackageCard key={packageItem.id} packageItem={packageItem} onSelect={model.openPayment} />
          ))}
        </Box>
      )}
      {!model.loading && !model.loadError && model.packages.length === 0 ? (
        <Alert severity="info">
          管理后台还没有已上架积分套餐。新增或编辑积分套餐并开启“在线销售”后，旺崽助手会自动同步显示。
        </Alert>
      ) : null}
    </Stack>
  );
}
