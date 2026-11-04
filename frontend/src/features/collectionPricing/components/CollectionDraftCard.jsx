import LanguageRounded from '@mui/icons-material/LanguageRounded';
import LinkRounded from '@mui/icons-material/LinkRounded';
import TravelExploreRounded from '@mui/icons-material/TravelExploreRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { collectionSourcePlatformOptions } from '../constants/collectionPricingRules.js';

function ModeButton({ active, icon, title, description, onClick }) {
  return (
    <ButtonBase
      onClick={onClick}
      aria-pressed={active}
      sx={{
        width: '100%',
        minHeight: 62,
        justifyContent: 'flex-start',
        gap: 1.25,
        px: 1.75,
        py: 1.1,
        textAlign: 'left',
        color: active ? '#24324a' : 'text.secondary',
        bgcolor: active ? '#f2f5f9' : '#fff',
        boxShadow: active ? 'inset 0 -2px 0 #344054' : 'none',
        transition: 'background-color 120ms ease, box-shadow 120ms ease',
        '&:hover': { bgcolor: active ? '#eef2f7' : '#f8fafc' },
        '&:focus-visible': { outline: '2px solid #98a2b3', outlineOffset: -2 },
      }}
    >
      <Box sx={{ display: 'grid', placeItems: 'center', color: active ? '#344054' : '#7b8798' }}>
        {icon}
      </Box>
      <Box>
        <Typography variant="body2" fontWeight={700} color="text.primary">{title}</Typography>
        <Typography component="span" variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 0.15 }}>
          {description}
        </Typography>
      </Box>
    </ButtonBase>
  );
}

export function CollectionDraftCard({
  collectionMode = 'browser',
  collectorDraft,
  browserState,
  onChangeMode,
  onChangeField,
  onOpenBrowser,
  onCaptureCurrent,
  onCollectLink,
}) {
  const busy = ['opening', 'capturing', 'link-collecting'].includes(browserState?.status);
  const selectedSourcePlatform = collectionSourcePlatformOptions.some(
    (option) => option.value === collectorDraft.sourcePlatform
  ) ? collectorDraft.sourcePlatform : '';

  return (
    <Paper variant="outlined" sx={{ borderRadius: 0.75, p: 2, borderColor: '#dfe5ee', boxShadow: 'none' }}>
      <Typography variant="h6" fontWeight={750}>采集方式</Typography>
      <Typography variant="body2" color="text.secondary" mt={0.25}>
        选择内置浏览器或商品链接，将资料加入本次采集列表。
      </Typography>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
          mt: 1.5,
          overflow: 'hidden',
          border: '1px solid #d7dde7',
          borderRadius: 0.75,
          '& > :last-child': {
            borderTop: { xs: '1px solid #d7dde7', md: 0 },
            borderLeft: { xs: 0, md: '1px solid #d7dde7' },
          },
        }}
      >
        <ModeButton active={collectionMode === 'browser'} icon={<LanguageRounded fontSize="small" />} title="内置浏览器采集" description="打开商品详情页后采集当前商品" onClick={() => onChangeMode?.('browser')} />
        <ModeButton active={collectionMode === 'link'} icon={<LinkRounded fontSize="small" />} title="复制链接采集" description="粘贴商品链接后打开并解析" onClick={() => onChangeMode?.('link')} />
      </Box>

      {collectionMode === 'browser' ? (
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} mt={1.25} alignItems={{ md: 'center' }}>
          <TextField
            select
            size="small"
            label="采集平台"
            value={selectedSourcePlatform}
            onChange={onChangeField('sourcePlatform')}
            sx={{ minWidth: 220, '& .MuiOutlinedInput-root': { borderRadius: 0.75 } }}
          >
            <MenuItem value="">请选择平台</MenuItem>
            {collectionSourcePlatformOptions.map((option) => (
              <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
            ))}
          </TextField>
          <Button variant="outlined" color="inherit" disabled={busy || !selectedSourcePlatform} onClick={() => onOpenBrowser?.('source')} startIcon={<LanguageRounded />} sx={{ borderRadius: 0.75, borderColor: '#cfd6e1' }}>
            打开内置浏览器
          </Button>
          <Button variant="contained" disabled={busy} onClick={onCaptureCurrent} startIcon={<TravelExploreRounded />} sx={{ borderRadius: 0.75, bgcolor: '#344054', '&:hover': { bgcolor: '#273142' } }}>
            {browserState?.status === 'capturing' ? '采集中…' : '采集当前商品'}
          </Button>
        </Stack>
      ) : (
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} mt={1.25}>
          <TextField
            fullWidth
            size="small"
            label="商品链接"
            placeholder="粘贴 1688、淘宝、天猫、拼多多或 Ozon 商品详情链接"
            value={collectorDraft.sourceUrl}
            onChange={onChangeField('sourceUrl')}
            sx={{ '& .MuiOutlinedInput-root': { borderRadius: 0.75 } }}
          />
          <Button
            variant="contained"
            disabled={busy || !String(collectorDraft.sourceUrl || '').trim()}
            onClick={onCollectLink}
            startIcon={<LinkRounded />}
            sx={{ minWidth: 150, borderRadius: 0.75, bgcolor: '#344054', '&:hover': { bgcolor: '#273142' } }}
          >
            {browserState?.status === 'link-collecting' ? '采集中…' : '采集链接'}
          </Button>
        </Stack>
      )}

      {browserState?.error || browserState?.message ? (
        <Alert severity={browserState.error ? 'error' : browserState.status === 'success' ? 'success' : 'info'} sx={{ mt: 1.25 }}>
          {browserState.error || browserState.message}
        </Alert>
      ) : null}
    </Paper>
  );
}
