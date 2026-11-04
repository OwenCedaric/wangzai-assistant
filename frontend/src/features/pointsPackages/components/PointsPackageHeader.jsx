import AccountBalanceWalletRounded from '@mui/icons-material/AccountBalanceWalletRounded';
import TuneRounded from '@mui/icons-material/TuneRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';
import { POINTS_PACKAGE_TABS } from '../constants/pointsPackageCatalog.js';
import { formatPoints } from '../lib/pointsPackagePricing.js';

export function PointsPackageHeader({
  activeTab,
  onTabChange,
  wallet,
  loading,
  onRefresh,
  onOpenModelPreset,
  enabledModelCount,
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 2,
        px: 0.5,
        pb: 1.25,
        borderBottom: '1px solid #e7dfd2',
      }}
    >
      <Stack direction="row" alignItems="center" spacing={1.25} sx={{ minWidth: 220 }}>
        <Box>
          <Typography sx={{ color: '#343238', fontWeight: 800, fontSize: 19, lineHeight: 1.1 }}>积分套餐</Typography>
          <Typography sx={{ color: '#6d6870', fontSize: 13 }}>按生成规格购买积分</Typography>
        </Box>
      </Stack>

      <Stack
        direction="row"
        role="tablist"
        aria-label="积分套餐模块"
        spacing={0.5}
        sx={{
          p: 0.5,
          border: '1px solid #e7dfd2',
          borderRadius: 1.75,
          bgcolor: '#faf7f1',
        }}
      >
        {POINTS_PACKAGE_TABS.map((tab) => {
          const selected = activeTab === tab.id;
          return (
            <Button
              key={tab.id}
              role="tab"
              aria-selected={selected}
              onClick={() => onTabChange(tab.id)}
              sx={{
                minWidth: { xs: 96, md: 150 },
                px: { xs: 1.5, md: 2.5 },
                py: 1.05,
                borderRadius: 1.25,
                color: selected ? '#7b5220' : '#6d6870',
                bgcolor: selected ? '#fffdfb' : 'transparent',
                boxShadow: selected ? '0 3px 12px rgba(52,50,56,0.07)' : 'none',
                fontSize: { xs: 13, md: 16 },
                fontWeight: 800,
                '&:hover': { bgcolor: selected ? '#fffdfb' : '#f8f4ed' },
              }}
            >
              {tab.label}
            </Button>
          );
        })}
      </Stack>

      <Stack direction="row" alignItems="center" spacing={0.9} sx={{ flexShrink: 0 }}>
        <Button
          variant="outlined"
          startIcon={<TuneRounded />}
          onClick={onOpenModelPreset}
          sx={{
            minWidth: 118,
            minHeight: 34,
            px: 1.2,
            color: '#7b5220',
            borderColor: '#d7c4a8',
            whiteSpace: 'nowrap',
            fontWeight: 900,
            '&:hover': { borderColor: '#a06e2f', bgcolor: '#fff9ed' },
          }}
        >
          模型预设{enabledModelCount ? ` · ${enabledModelCount}` : ''}
        </Button>
        <Chip
          icon={loading ? <CircularProgress size={15} /> : <AccountBalanceWalletRounded sx={{ fontSize: 18 }} />}
          label={loading ? '积分余额加载中' : `积分余额：${formatPoints(wallet?.balance_points || 0)}`}
          onClick={onRefresh}
          disabled={loading}
          sx={{
            minWidth: 132,
            justifyContent: 'flex-start',
            color: '#343238',
            bgcolor: 'transparent',
            border: '1px solid #e7dfd2',
            '& .MuiChip-icon': { color: '#a06e2f' },
            '& .MuiChip-label': { fontSize: 14, fontWeight: 900 },
            cursor: 'pointer',
          }}
        />
      </Stack>
    </Box>
  );
}
