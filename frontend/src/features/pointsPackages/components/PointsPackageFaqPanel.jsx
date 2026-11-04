import CheckRounded from '@mui/icons-material/CheckRounded';
import HelpOutlineRounded from '@mui/icons-material/HelpOutlineRounded';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded';
import React from 'react';
import { POINTS_FAQ_ITEMS } from '../constants/pointsPackageCatalog.js';

export function PointsPackageFaqPanel({ expandedIndex, onToggle }) {
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
            常见问题
          </Typography>
        </Box>
        <Typography sx={{ maxWidth: 520, color: '#6d6870', fontSize: 13, lineHeight: 1.6, textAlign: 'right' }}>
          点击问题即可展开，再次点击收起。
        </Typography>
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '340px minmax(0,1fr)' }, gap: 1.75 }}>
        <Box
          sx={{
            minHeight: 400,
            p: 2.5,
            border: '1px solid rgba(160,110,47,0.42)',
            borderRadius: 2.25,
            bgcolor: '#faf7f1',
          }}
        >
          <Box
            sx={{
              display: 'grid',
              placeItems: 'center',
              width: 56,
              height: 56,
              borderRadius: 1.75,
              color: '#fff',
              bgcolor: '#a06e2f',
              boxShadow: '0 10px 25px rgba(160,110,47,.16)',
            }}
          >
            <HelpOutlineRounded />
          </Box>
          <Typography sx={{ mt: 2, mb: 0.8, fontSize: 22, fontWeight: 900 }}>购买前说明</Typography>
          <Typography sx={{ color: '#6d6870', fontSize: 14, lineHeight: 1.8 }}>
            套餐到账的是软件积分，预计链接数量会随图片模型和生成规格变化。
          </Typography>
          <Stack spacing={0.8} sx={{ mt: 2.2 }}>
            {['金额清晰', '积分清晰', '到账后可用'].map((item) => (
              <Typography
                key={item}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.7,
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
        <Stack spacing={0.8}>
          {POINTS_FAQ_ITEMS.map((item, index) => (
            <Accordion
              key={item.question}
              expanded={expandedIndex === index}
              onChange={() => onToggle(index)}
              disableGutters
              elevation={0}
              sx={{
                border: '1px solid #e7dfd2',
                borderRadius: '14px !important',
                bgcolor: '#fffdfb',
                '&::before': { display: 'none' },
              }}
            >
              <AccordionSummary
                expandIcon={<ExpandMoreRounded />}
                sx={{ minHeight: 66, px: 2, '& .MuiAccordionSummary-content': { my: 1.2 } }}
              >
                <Typography sx={{ color: '#343238', fontSize: 15, fontWeight: 900 }}>{item.question}</Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ px: 1.75, pt: 0, pb: 1.7 }}>
                <Typography sx={{ color: '#6d6870', fontSize: 13, lineHeight: 1.75 }}>{item.answer}</Typography>
              </AccordionDetails>
            </Accordion>
          ))}
        </Stack>
      </Box>
    </Stack>
  );
}
