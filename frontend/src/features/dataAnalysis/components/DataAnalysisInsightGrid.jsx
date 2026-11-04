import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

const TONES = Object.freeze({
  default: { background: '#f6f8fc', value: '#21395f' },
  warning: { background: '#fff8ec', value: '#9a5d05' },
  success: { background: '#effaf6', value: '#176b58' },
  danger: { background: '#fff5f5', value: '#b83232' },
});

export function DataAnalysisInsightGrid({ items = [], columns = 3, sx }) {
  const visibleItems = items.filter((item) => item && item.label);
  if (!visibleItems.length) return null;
  const resolvedColumns = Math.max(1, Math.min(Number(columns) || 3, visibleItems.length));
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: {
          xs: `repeat(${Math.min(resolvedColumns, 2)}, minmax(0, 1fr))`,
          md: `repeat(${resolvedColumns}, minmax(0, 1fr))`,
        },
        gap: 0.8,
        ...sx,
      }}
    >
      {visibleItems.map((item) => {
        const tone = TONES[item.tone] || TONES.default;
        return (
          <Box
            key={item.label}
            sx={{
              minWidth: 0,
              minHeight: 68,
              borderRadius: 2,
              bgcolor: tone.background,
              px: 1.1,
              py: 0.9,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
            }}
          >
            <Typography variant="caption" color="text.secondary" fontWeight={750} sx={{ fontSize: 12.5 }}>
              {item.label}
            </Typography>
            <Typography
              variant="body2"
              fontWeight={900}
              noWrap
              title={item.value}
              sx={{ color: tone.value, mt: 0.18, fontSize: 15.5, lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {item.value}
            </Typography>
            {item.detail ? (
              <Typography
                variant="caption"
                color="text.secondary"
                noWrap
                title={item.detail}
                sx={{ display: 'block', mt: 0.18, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis' }}
              >
                {item.detail}
              </Typography>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}
