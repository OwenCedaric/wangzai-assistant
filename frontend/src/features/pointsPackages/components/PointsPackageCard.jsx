import ArrowForwardRounded from '@mui/icons-material/ArrowForwardRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';
import { formatMoney, formatPoints } from '../lib/pointsPackagePricing.js';

export function PointsPackageCard({ packageItem, onSelect }) {
  return (
    <Paper
      component="article"
      elevation={0}
      sx={{
        position: 'relative',
        display: 'grid',
        gridTemplateRows: 'auto auto 1fr auto',
        gap: 0.7,
        minHeight: 272,
        p: 2.25,
        overflow: 'hidden',
        border: `1px solid ${packageItem.featured ? 'rgba(160,110,47,0.42)' : '#e7dfd2'}`,
        borderRadius: 2.25,
        bgcolor: '#fffdfb',
        boxShadow: packageItem.featured ? '0 8px 22px rgba(160,110,47,0.12)' : '0 6px 18px rgba(52,50,56,0.045)',
      }}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ position: 'relative' }}>
        <Box>
          <Chip
            label={packageItem.tag}
            size="small"
            sx={{
              height: 28,
              color: packageItem.featured ? '#7b5220' : '#6d6870',
              bgcolor: packageItem.featured ? '#fff2d9' : '#f8f4ed',
              fontSize: 12,
              fontWeight: 900,
            }}
          />
          <Typography sx={{ mt: 0.8, color: '#343238', fontWeight: 900, fontSize: 24, letterSpacing: '-.02em' }}>
            {packageItem.name}
          </Typography>
        </Box>
        {packageItem.featured ? (
          <Chip
            label="最受欢迎"
            size="small"
            sx={{ height: 28, color: '#fff', bgcolor: '#a06e2f', fontSize: 12, fontWeight: 900 }}
          />
        ) : null}
      </Stack>
      <Typography
        noWrap
        sx={{
          position: 'relative',
          overflow: 'hidden',
          color: '#6d6870',
          fontSize: 14,
          textOverflow: 'ellipsis',
        }}
      >
        {packageItem.caption}
      </Typography>
      <Stack direction="row" alignItems="center" spacing={1.5} sx={{ position: 'relative', py: 0.8 }}>
        <Box sx={{ minWidth: 130 }}>
          <Typography component="span" sx={{ color: '#6d6870', fontSize: 13 }}>
            ¥
          </Typography>
          <Typography component="strong" sx={{ color: '#343238', fontSize: 46, lineHeight: 1, fontWeight: 900 }}>
            {packageItem.price % 1 === 0 ? packageItem.price.toFixed(0) : packageItem.price.toFixed(1)}
          </Typography>
          <Typography component="span" sx={{ color: '#6d6870', fontSize: 12 }}>
            {' '}
            / {packageItem.validityDays}天
          </Typography>
        </Box>
        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', flex: 1, gap: 0.6 }}>
          <Box
            sx={{
              p: 1.1,
              border: '1px solid #e7dfd2',
              borderRadius: 1.25,
              bgcolor: '#faf7f1',
            }}
          >
            <Typography sx={{ color: '#6d6870', fontSize: 12 }}>到账积分</Typography>
            <Typography noWrap sx={{ color: '#343238', fontSize: 20, fontWeight: 900 }}>
              {formatPoints(packageItem.points)}
            </Typography>
          </Box>
          <Box
            sx={{
              p: 1.1,
              border: '1px solid #e7dfd2',
              borderRadius: 1.25,
              bgcolor: '#faf7f1',
            }}
          >
            <Typography sx={{ color: '#6d6870', fontSize: 12 }}>预计链接</Typography>
            <Typography noWrap sx={{ color: '#343238', fontSize: 20, fontWeight: 900 }}>
              {packageItem.estimatedLinks}
              <Typography component="span" sx={{ fontSize: 12 }}>
                {' '}
                条
              </Typography>
            </Typography>
          </Box>
        </Box>
      </Stack>
      <Button
        fullWidth
        variant={packageItem.featured ? 'contained' : 'outlined'}
        onClick={() => onSelect(packageItem.id)}
        endIcon={<ArrowForwardRounded />}
        sx={{
          position: 'relative',
          minHeight: 52,
          borderRadius: 1.25,
          color: packageItem.featured ? '#fff' : '#7b5220',
          bgcolor: packageItem.featured ? '#a06e2f' : 'transparent',
          borderColor: 'rgba(160,110,47,0.42)',
          boxShadow: packageItem.featured ? '0 8px 20px rgba(160,110,47,0.16) !important' : 'none',
          fontSize: 15,
          fontWeight: 900,
          '&:hover': {
            bgcolor: packageItem.featured ? '#7b5220' : '#fff2d9',
            borderColor: '#a06e2f',
          },
        }}
      >
        选择套餐 · {formatMoney(packageItem.price)}
      </Button>
    </Paper>
  );
}
