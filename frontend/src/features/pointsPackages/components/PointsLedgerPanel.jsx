import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';
import { formatPoints } from '../lib/pointsPackagePricing.js';

const EVENT_LABELS = Object.freeze({
  admin_credit: '后台充值',
  admin_debit: '后台扣减',
  expired: '积分到期',
  paid_capability_spent: '内置能力扣分',
  purchase_credit: '套餐到账',
  refunded: '退款返还',
  spent: '积分支出',
});

function formatTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function PointsLedgerPanel({ ledger = [], wallet = null }) {
  return (
    <Box
      sx={{
        p: 1.8,
        border: '1px solid #e7dfd2',
        borderRadius: 2,
        bgcolor: '#fffdfb',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, mb: 1.25 }}>
        <Box>
          <Typography sx={{ fontSize: 18, fontWeight: 900 }}>最近积分流水</Typography>
          <Typography sx={{ color: '#6d6870', fontSize: 12 }}>充值、实际扣分、退款和到期都以服务端账本为准</Typography>
        </Box>
        <Stack direction="row" spacing={0.75}>
          <Chip size="small" label={`可用 ${formatPoints(wallet?.available_points || 0)}`} />
          {Number(wallet?.reserved_points || 0) > 0 ? (
            <Chip size="small" color="warning" label={`处理中 ${formatPoints(wallet.reserved_points)}`} />
          ) : null}
        </Stack>
      </Box>
      {ledger.length ? (
        <Stack spacing={0.65}>
          {ledger.slice(0, 20).map((entry) => {
            const delta = Number(entry?.delta_points || 0);
            return (
              <Box
                key={entry.id}
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr auto', md: '180px minmax(0,1fr) 110px 130px' },
                  alignItems: 'center',
                  gap: 1,
                  px: 1.15,
                  py: 0.9,
                  borderRadius: 1.25,
                  bgcolor: '#faf7f1',
                }}
              >
                <Typography sx={{ color: '#6d6870', fontSize: 12 }}>{formatTime(entry.created_at)}</Typography>
                <Box sx={{ minWidth: 0 }}>
                  <Typography noWrap sx={{ fontSize: 13, fontWeight: 900 }}>
                    {EVENT_LABELS[entry.event_type] || '积分变动'}
                  </Typography>
                  <Typography noWrap sx={{ color: '#8b7e89', fontSize: 11 }}>
                    {entry.reason || '服务端账本记录'}
                  </Typography>
                </Box>
                <Typography
                  sx={{
                    color: delta > 0 ? '#168766' : '#b04b3f',
                    textAlign: 'right',
                    fontSize: 14,
                    fontWeight: 900,
                  }}
                >
                  {delta > 0 ? '+' : ''}
                  {formatPoints(delta)}
                </Typography>
                <Typography sx={{ color: '#6d6870', textAlign: 'right', fontSize: 12 }}>
                  余额 {formatPoints(entry.balance_after)}
                </Typography>
              </Box>
            );
          })}
        </Stack>
      ) : (
        <Typography sx={{ py: 2, color: '#8b7e89', textAlign: 'center', fontSize: 13 }}>暂无积分流水</Typography>
      )}
    </Box>
  );
}
