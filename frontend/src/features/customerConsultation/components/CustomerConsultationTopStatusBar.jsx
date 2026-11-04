import StorefrontRounded from '@mui/icons-material/StorefrontRounded';
import { safeImageUrl } from '../../../shared/lib/imageUrlRules.js';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';

function normalizeText(value) {
  return String(value ?? '').trim();
}

function getShopName(shop = {}, index = 0) {
  return normalizeText(shop.sellerName || shop.shopAlias || shop.name || shop.alias) || `Ozon 店铺 ${index + 1}`;
}

function getAccountHint(shop = {}) {
  const clientId = normalizeText(shop.clientId || shop.client_id);
  if (clientId) return `Client ID ${clientId}`;
  if (shop.hasClientId) return 'Client ID 已安全保存';
  return '账号信息待配置';
}

export const CustomerConsultationTopStatusBar = React.memo(function CustomerConsultationTopStatusBar({
  shops = [],
  activeShopId = '',
  onActiveShopChange,
  syncLabel = '等待读取',
  syncTone = 'default',
  stats = [],
  shopProfile = null,
}) {
  const activeShop = shops.find((shop) => shop.id === activeShopId) || null;
  const activeShopIndex = activeShop ? shops.indexOf(activeShop) : 0;
  const activeShopName = activeShop
    ? normalizeText(shopProfile?.sellerName) || getShopName(activeShop, activeShopIndex)
    : '尚未选择 Ozon 店铺';
  const logoUrl = safeImageUrl(shopProfile?.logoUrl);
  const [logoFailed, setLogoFailed] = React.useState(false);

  React.useEffect(() => {
    setLogoFailed(false);
  }, [activeShopId, logoUrl]);

  return (
    <Box className="customer-consultation-topbar">
      <Stack direction="row" alignItems="center" spacing={1.25} className="customer-consultation-shop-summary">
        <Avatar
          className="customer-consultation-shop-avatar"
          src={logoUrl && !logoFailed ? logoUrl : undefined}
          imgProps={{
            alt: `${activeShopName} Ozon 店铺 Logo`,
            referrerPolicy: 'no-referrer',
            onError: () => setLogoFailed(true),
          }}
        >
          {activeShop ? activeShopName.slice(0, 1).toUpperCase() : <StorefrontRounded fontSize="small" />}
        </Avatar>
        <Box minWidth={0}>
          <Typography variant="subtitle1" fontWeight={800} noWrap title={activeShopName}>
            {activeShopName}
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            noWrap
            title={activeShop ? getAccountHint(activeShop) : '请选择店铺 / 账号后读取客服数据'}
          >
            {activeShop ? getAccountHint(activeShop) : '请选择店铺 / 账号后读取客服数据'}
          </Typography>
        </Box>
      </Stack>

      <FormControl size="small" className="customer-consultation-shop-select">
        <InputLabel id="customer-consultation-shop-label">Ozon 店铺 / 账号</InputLabel>
        <Select
          labelId="customer-consultation-shop-label"
          value={shops.some((shop) => shop.id === activeShopId) ? activeShopId : ''}
          label="Ozon 店铺 / 账号"
          onChange={(event) => onActiveShopChange?.(event.target.value)}
          disabled={!shops.length || !onActiveShopChange}
        >
          {shops.length ? (
            shops.map((shop, index) => (
              <MenuItem key={shop.id} value={shop.id}>
                {getShopName(shop, index)} · {getAccountHint(shop)}
              </MenuItem>
            ))
          ) : (
            <MenuItem value="" disabled>
              暂无可用店铺
            </MenuItem>
          )}
        </Select>
      </FormControl>

      <Box className="customer-consultation-topbar-stats">
        {stats.map((item) => (
          <Box key={item.label} className="customer-consultation-topbar-stat">
            <Typography variant="subtitle2" fontWeight={800} noWrap title={String(item.value ?? '')}>
              {item.value}
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap title={item.label}>
              {item.label}
            </Typography>
          </Box>
        ))}
        <Chip size="small" color={syncTone} variant="outlined" label={syncLabel} title={syncLabel} />
      </Box>
    </Box>
  );
});
