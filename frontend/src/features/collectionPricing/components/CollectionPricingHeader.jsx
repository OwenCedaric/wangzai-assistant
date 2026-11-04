import DeleteSweepRounded from '@mui/icons-material/DeleteSweepRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

export function CollectionPricingHeader({ collectionCount = 0, onClear }) {
  return (
    <Stack
      direction={{ xs: 'column', md: 'row' }}
      justifyContent="space-between"
      alignItems={{ xs: 'stretch', md: 'center' }}
      spacing={1}
      sx={{ pb: 1.5, mb: 1.5, borderBottom: '1px solid', borderColor: '#dfe5ee' }}
    >
      <Box>
        <Stack direction="row" spacing={1.25} alignItems="baseline" flexWrap="wrap" useFlexGap>
          <Typography variant="h5" fontWeight={750}>商品采集</Typography>
          <Typography variant="body2" color="text.secondary">采购来源商品与图片资料</Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.35 }}>
          {collectionCount ? `本次已采集 ${collectionCount} 件` : '本次还没有采集商品'}
        </Typography>
      </Box>
      <Button
        size="small"
        color="inherit"
        disabled={!collectionCount}
        startIcon={<DeleteSweepRounded />}
        onClick={onClear}
        sx={{
          alignSelf: { xs: 'flex-start', md: 'center' },
          borderRadius: 0.75,
          color: 'text.secondary',
          px: 1,
          '&:hover': { bgcolor: '#f2f4f7', color: 'text.primary' },
        }}
      >
        清空本次列表
      </Button>
    </Stack>
  );
}
