import ArrowForwardRounded from '@mui/icons-material/ArrowForwardRounded';
import CheckRounded from '@mui/icons-material/CheckRounded';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';
import { PointsLedgerPanel } from './PointsLedgerPanel.jsx';

const steps = [
  ['01', '先选择生成规格', '选择图片模型、10/13/16 张成品图，以及是否预留图片重做空间。'],
  ['02', '查看单条链接积分', '规格变化后，单条链接积分和每个套餐可完成的链接数量会同步更新。'],
  ['03', '充值后开始使用', '支付确认并完成积分入账后，软件内余额才会更新并可用于生成任务。'],
];

export function PointsPackageBillingPanel({ ledger, wallet }) {
  return (
    <Stack spacing={2}>
      <Box sx={{ display: 'flex', alignItems: 'end', justifyContent: 'space-between', gap: 2, px: 0.5 }}>
        <Box>
          <Typography
            component="h1"
            sx={{
              mt: 0,
              color: '#343238',
              fontSize: { xs: 24, md: 30 },
              lineHeight: 1.2,
              fontWeight: 800,
            }}
          >
            计费规则与到账流程
          </Typography>
        </Box>
        <Typography sx={{ maxWidth: 520, color: '#6d6870', fontSize: 13, lineHeight: 1.6, textAlign: 'right' }}>
          页面只展示用户需要了解的扣分方式和到账流程。
        </Typography>
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3,1fr)' }, gap: 1.25 }}>
        {steps.map(([number, title, body]) => (
          <Box
            key={number}
            sx={{
              minHeight: 154,
              p: 2,
              border: '1px solid #e7dfd2',
              borderRadius: 2,
              bgcolor: '#fffdfb',
              boxShadow: '0 10px 26px rgba(52,50,56,0.07)',
            }}
          >
            <Box
              sx={{
                display: 'grid',
                placeItems: 'center',
                width: 36,
                height: 36,
                borderRadius: 1.1,
                color: '#7b5220',
                bgcolor: '#fff2d9',
                fontSize: 12,
                fontWeight: 900,
              }}
            >
              {number}
            </Box>
            <Typography sx={{ mt: 1, mb: 0.5, fontSize: 18, fontWeight: 900 }}>{title}</Typography>
            <Typography sx={{ color: '#6d6870', fontSize: 13, lineHeight: 1.7 }}>{body}</Typography>
          </Box>
        ))}
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3,1fr)' }, gap: 1.25 }}>
        <Box
          sx={{
            p: 1.8,
            border: '1px solid #e7dfd2',
            borderRadius: 2,
            bgcolor: '#fffdfb',
          }}
        >
          <Typography sx={{ mb: 0.9, fontSize: 17, fontWeight: 900 }}>一条完整链接包含</Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.6 }}>
            {['商品标题', '商品属性', '俄语文案', '主图', '详情图'].map((item) => (
              <Box
                key={item}
                sx={{
                  px: 1.1,
                  py: 0.65,
                  borderRadius: 1,
                  color: '#7b5220',
                  bgcolor: '#fff2d9',
                  fontSize: 12,
                }}
              >
                {item}
              </Box>
            ))}
          </Box>
        </Box>
        <Box
          sx={{
            p: 1.8,
            border: '1px solid #e7dfd2',
            borderRadius: 2,
            bgcolor: '#fffdfb',
          }}
        >
          <Typography sx={{ mb: 0.9, fontSize: 17, fontWeight: 900 }}>影响积分的项目</Typography>
          <Stack spacing={0.55}>
            {['图片模型规格', '成品图片数量', '是否预留重试空间'].map((item) => (
              <Typography
                key={item}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.6,
                  color: '#62554b',
                  fontSize: 13,
                }}
              >
                <CheckRounded sx={{ color: '#9b6a2e', fontSize: 18 }} />
                {item}
              </Typography>
            ))}
          </Stack>
        </Box>
        <Box
          sx={{
            p: 1.8,
            border: '1px solid #e7dfd2',
            borderRadius: 2,
            bgcolor: '#fffdfb',
          }}
        >
          <Typography sx={{ mb: 0.9, fontSize: 17, fontWeight: 900 }}>到账确认标准</Typography>
          <Typography sx={{ color: '#6d6870', fontSize: 13, lineHeight: 1.7 }}>
            以服务端支付确认和积分账本写入成功为准，未入账不会显示充值完成。
          </Typography>
        </Box>
      </Box>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: '1fr 28px 1fr 28px 1fr',
          alignItems: 'center',
          gap: 1,
          p: 1.8,
          border: '1px solid rgba(160,110,47,0.42)',
          borderRadius: 2,
          bgcolor: '#faf7f1',
        }}
      >
        {['选择套餐', '扫码支付', '积分到账'].map((item, index) => (
          <React.Fragment key={item}>
            <Box sx={{ textAlign: 'center' }}>
              <Typography sx={{ fontSize: 15, fontWeight: 900 }}>{item}</Typography>
              <Typography sx={{ color: '#6d6870', fontSize: 12 }}>
                {['确认金额与到账积分', '等待服务端确认结果', '余额更新后即可使用'][index]}
              </Typography>
            </Box>
            {index < 2 ? <ArrowForwardRounded sx={{ color: '#a06e2f' }} /> : null}
          </React.Fragment>
        ))}
      </Box>
      <PointsLedgerPanel ledger={ledger} wallet={wallet} />
    </Stack>
  );
}
