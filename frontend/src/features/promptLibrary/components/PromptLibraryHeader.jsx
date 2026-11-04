import ExtensionRounded from '@mui/icons-material/ExtensionRounded';
import FilterAltRounded from '@mui/icons-material/FilterAltRounded';
import StorefrontRounded from '@mui/icons-material/StorefrontRounded';
import UploadFileRounded from '@mui/icons-material/UploadFileRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControl from '@mui/material/FormControl';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

function getShopDisplayName(shop = {}) {
  return shop.displayName || shop.shopAlias || shop.shopName || shop.shopId || '未命名店铺';
}

export function PromptLibraryHeader({
  shopOptions = [],
  selectedShopId = '',
  onShopChange = () => {},
  onShowAll,
  onCreateTool,
}) {
  const selectedShop = shopOptions.find((shop) => shop.shopId === selectedShopId) || null;
  return (
    <Stack
      direction={{ xs: 'column', md: 'row' }}
      alignItems={{ xs: 'stretch', md: 'center' }}
      justifyContent="space-between"
      spacing={2}
      mb={3}
    >
      <Box>
        <Stack direction="row" spacing={1} alignItems="center">
          <ExtensionRounded color="primary" />
          <Typography variant="h4">智能工具</Typography>
        </Stack>
        <Typography color="text.secondary" mt={0.75}>
          安装 Skill 后自动生成固定输入、内置流程、提示词和输出规则；缺账号或模型时会提示补配置。
        </Typography>
      </Box>
      <Stack direction="row" spacing={1} className="hero-actions">
        <Button variant="outlined" startIcon={<FilterAltRounded />} onClick={onShowAll}>
          全部工具
        </Button>
        <FormControl size="small" className="prompt-library-shop-select">
          <Select
            value={selectedShop?.shopId || ''}
            displayEmpty
            onChange={(event) => onShopChange(event.target.value)}
            inputProps={{ 'aria-label': '智能工具当前店铺' }}
            renderValue={() => (
              <Stack direction="row" spacing={0.75} alignItems="center" minWidth={0}>
                <StorefrontRounded fontSize="small" />
                <Typography component="span" variant="body2" noWrap>
                  {selectedShop ? getShopDisplayName(selectedShop) : '暂无可用店铺'}
                </Typography>
              </Stack>
            )}
          >
            {shopOptions.length ? shopOptions.map((shop) => (
              <MenuItem key={shop.shopId} value={shop.shopId}>
                <Box minWidth={0}>
                  <Typography variant="body2" noWrap>{getShopDisplayName(shop)}</Typography>
                  {shop.shopExternalId && shop.shopExternalId !== shop.shopId ? (
                    <Typography variant="caption" color="text.secondary" noWrap>
                      店铺 ID：{shop.shopExternalId}
                    </Typography>
                  ) : null}
                </Box>
              </MenuItem>
            )) : (
              <MenuItem value="" disabled>暂无可用店铺</MenuItem>
            )}
          </Select>
        </FormControl>
        <Button variant="contained" startIcon={<UploadFileRounded />} onClick={onCreateTool}>
          安装 Skill
        </Button>
      </Stack>
    </Stack>
  );
}
