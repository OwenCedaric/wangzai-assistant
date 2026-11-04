import CheckRounded from '@mui/icons-material/CheckRounded';
import StorefrontRounded from '@mui/icons-material/StorefrontRounded';
import Box from '@mui/material/Box';
import FormControl from '@mui/material/FormControl';
import FormHelperText from '@mui/material/FormHelperText';
import InputLabel from '@mui/material/InputLabel';
import ListItemIcon from '@mui/material/ListItemIcon';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

function optionName(shop) {
  return shop?.shopName || shop?.displayName || shop?.shopAlias || '未命名店铺';
}

function optionId(shop) {
  return shop?.shopExternalId || shop?.shopId || '未绑定';
}

function aliasText(shop) {
  const alias = String(shop?.shopAlias || '').trim();
  return alias && alias !== optionName(shop) ? alias : '';
}

function SelectedShop({ shop }) {
  if (!shop) return <Typography color="text.secondary">请选择店铺</Typography>;
  return (
    <Stack minWidth={0} spacing={0.1}>
      <Typography fontWeight={800} noWrap>{optionName(shop)}</Typography>
      <Typography variant="caption" color="text.secondary" noWrap>
        店铺 ID：{optionId(shop)}{aliasText(shop) ? ` · 简称：${aliasText(shop)}` : ''}
      </Typography>
    </Stack>
  );
}

export function DataBackupShopSelect({
  idPrefix,
  label,
  value,
  options = [],
  disabled = false,
  helperText = '',
  onChange,
}) {
  const labelId = `${idPrefix}-label`;
  const selected = options.find((shop) => shop.shopId === value) || null;
  return (
    <FormControl fullWidth size="small" disabled={disabled}>
      <InputLabel id={labelId}>{label}</InputLabel>
      <Select
        labelId={labelId}
        id={`${idPrefix}-select`}
        value={value}
        label={label}
        autoWidth
        renderValue={() => <SelectedShop shop={selected} />}
        onChange={(event) => onChange?.(event.target.value)}
        MenuProps={{
          anchorOrigin: { vertical: 'bottom', horizontal: 'left' },
          transformOrigin: { vertical: 'top', horizontal: 'left' },
          PaperProps: {
            elevation: 8,
            sx: {
              mt: 0.75,
              width: 'min(460px, calc(100vw - 32px))',
              maxHeight: 360,
              borderRadius: 3,
              border: '1px solid',
              borderColor: 'divider',
              boxShadow: '0 18px 48px rgba(15, 23, 42, 0.18)',
            },
          },
          MenuListProps: { sx: { p: 1 } },
        }}
        sx={{
          borderRadius: 2.5,
          bgcolor: 'background.paper',
          '& .MuiSelect-select': {
            minHeight: '44px !important',
            py: '8px !important',
            display: 'flex',
            alignItems: 'center',
          },
        }}
      >
        {options.map((shop) => {
          const active = shop.shopId === value;
          return (
            <MenuItem
              key={shop.shopId}
              value={shop.shopId}
              sx={{
                minHeight: 68,
                px: 1.25,
                py: 1,
                mb: 0.5,
                borderRadius: 2,
                border: '1px solid',
                borderColor: active ? 'primary.light' : 'transparent',
                bgcolor: active ? 'primary.50' : 'transparent',
                '&:last-of-type': { mb: 0 },
                '&.Mui-selected': { bgcolor: 'primary.50' },
                '&.Mui-selected:hover': { bgcolor: 'primary.100' },
              }}
            >
              <ListItemIcon sx={{ minWidth: 46 }}>
                <Box
                  sx={{
                    width: 36,
                    height: 36,
                    display: 'grid',
                    placeItems: 'center',
                    borderRadius: 2,
                    color: active ? 'primary.main' : 'text.secondary',
                    bgcolor: active ? 'primary.100' : 'action.hover',
                  }}
                >
                  <StorefrontRounded fontSize="small" />
                </Box>
              </ListItemIcon>
              <Stack minWidth={0} flex={1} spacing={0.25}>
                <Typography fontWeight={800} noWrap>{optionName(shop)}</Typography>
                <Typography variant="caption" color="text.secondary" noWrap>
                  店铺 ID：{optionId(shop)}
                </Typography>
                {aliasText(shop) ? (
                <Typography variant="caption" color="primary.main" noWrap>
                    简称：{aliasText(shop)}
                </Typography>
                ) : null}
              </Stack>
              {active ? <CheckRounded color="primary" fontSize="small" /> : null}
            </MenuItem>
          );
        })}
      </Select>
      {helperText ? <FormHelperText>{helperText}</FormHelperText> : null}
    </FormControl>
  );
}
