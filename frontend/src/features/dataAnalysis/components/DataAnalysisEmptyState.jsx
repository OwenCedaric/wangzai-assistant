import { formatDataAnalysisChineseText } from '../lib/dataAnalysisFormatter.js';
import FactCheckOutlined from '@mui/icons-material/FactCheckOutlined';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

export function DataAnalysisEmptyState({ title = '暂无真实数据', description, sourceLabel, statusLabel = '未返回' }) {
  return (
    <Box
      sx={{
        p: { xs: 2.5, md: 3.5 },
        borderRadius: 2.75,
        bgcolor: '#f7f9fc',
        textAlign: 'center',
      }}
    >
      <Stack spacing={0.9} alignItems="center">
        <Box
          sx={{
            width: 42,
            height: 42,
            display: 'grid',
            placeItems: 'center',
            borderRadius: '50%',
            color: 'primary.main',
            bgcolor: 'rgba(93, 135, 255, 0.1)',
          }}
        >
          <FactCheckOutlined />
        </Box>
        <Typography fontWeight={900} sx={{ fontSize: 17 }}>{formatDataAnalysisChineseText(title)}</Typography>
        <Typography color="text.secondary" variant="body2" maxWidth={660} sx={{ fontSize: 14.5, lineHeight: 1.6 }}>
          {formatDataAnalysisChineseText(description || '当前数据源没有返回可展示内容，因此不会生成示例值。')}
        </Typography>
        <Typography variant="caption" color="text.disabled" sx={{ fontSize: 12.5 }}>
          {[sourceLabel ? `来源：${formatDataAnalysisChineseText(sourceLabel)}` : '', statusLabel]
            .filter(Boolean)
            .join(' · ')}
        </Typography>
      </Stack>
    </Box>
  );
}
