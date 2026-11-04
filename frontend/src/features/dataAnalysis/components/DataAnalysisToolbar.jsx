import { dataAnalysisDatePresets } from '../constants/dataAnalysisCatalog.js';
import { getOzonShopAlias, normalizeOzonShopOption } from '../../../shared/ozon/ozonShopOption.js';
import ArrowForwardRounded from '@mui/icons-material/ArrowForwardRounded';
import DateRangeRounded from '@mui/icons-material/DateRangeRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import StorefrontRounded from '@mui/icons-material/StorefrontRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import FormControl from '@mui/material/FormControl';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

function getShopValue(shop = {}) {
  return String(shop?.id || shop?.shopId || '').trim();
}

function getShopDisplay(shop = {}) {
  const option = normalizeOzonShopOption(shop);
  return {
    name: option.shopName || option.displayName || option.shopId || '未命名店铺',
    id: option.shopExternalId || option.shopId || '未绑定',
    alias: getOzonShopAlias(option),
  };
}

function ShopOptionContent({ shop }) {
  const display = getShopDisplay(shop);
  return (
    <Box minWidth={0} className="data-analysis-shop-option-content">
      <Typography component="span" className="data-analysis-shop-option-name" noWrap title={display.name}>
        {display.name}
      </Typography>
      <Typography component="span" className="data-analysis-shop-option-meta" noWrap>
        店铺 ID：{display.id}{display.alias ? ` · 简称：${display.alias}` : ''}
      </Typography>
    </Box>
  );
}

export function DataAnalysisToolbar({
  shops = [],
  filters,
  loading,
  onShopChange,
  onPresetChange,
  onRangeChange,
  onRefresh,
}) {
  const selectedShop = shops.find((shop) => getShopValue(shop) === String(filters.shopId || '').trim());
  return (
    <Card component="section" aria-label="数据筛选条件" className="data-analysis-toolbar-card">
      <Box className="data-analysis-toolbar-layout">
        <Box className="data-analysis-toolbar-field data-analysis-toolbar-shop-field">
          <Box className="data-analysis-toolbar-icon" aria-hidden="true">
            <StorefrontRounded fontSize="small" />
          </Box>
          <Box className="data-analysis-toolbar-field-body">
            <Typography component="span" className="data-analysis-toolbar-label">
              店铺范围
            </Typography>
            <FormControl variant="standard" fullWidth>
              <Select
                value={filters.shopId || ''}
                onChange={(event) => onShopChange(event.target.value)}
                displayEmpty
                disableUnderline
                inputProps={{ 'aria-label': '店铺范围' }}
                renderValue={(value) => {
                  if (!value) return <Typography component="span" className="data-analysis-shop-all-label">全部店铺</Typography>;
                  return selectedShop ? <ShopOptionContent shop={selectedShop} /> : '未命名店铺';
                }}
              >
                <MenuItem value="">全部店铺</MenuItem>
                {shops.map((shop) => {
                  const value = getShopValue(shop);
                  return (
                    <MenuItem key={value} value={value}>
                      <ShopOptionContent shop={shop} />
                    </MenuItem>
                  );
                })}
              </Select>
            </FormControl>
          </Box>
        </Box>

        <Box className="data-analysis-toolbar-field data-analysis-toolbar-period-field">
          <Box className="data-analysis-toolbar-field-body">
            <Typography component="span" className="data-analysis-toolbar-label">
              统计周期
            </Typography>
            <FormControl variant="standard" fullWidth>
              <Select
                value={filters.presetId}
                onChange={(event) => onPresetChange(event.target.value)}
                disableUnderline
                inputProps={{ 'aria-label': '统计周期' }}
              >
                {dataAnalysisDatePresets.map((preset) => (
                  <MenuItem key={preset.id} value={preset.id}>
                    {preset.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>
        </Box>

        <Box className="data-analysis-toolbar-field data-analysis-toolbar-date-field">
          <Box className="data-analysis-toolbar-icon data-analysis-toolbar-date-icon" aria-hidden="true">
            <DateRangeRounded fontSize="small" />
          </Box>
          <Box className="data-analysis-toolbar-field-body">
            <Typography component="span" className="data-analysis-toolbar-label">
              日期范围
            </Typography>
            <Box className="data-analysis-toolbar-date-row">
              <TextField
                variant="standard"
                type="date"
                value={filters.startDate}
                onChange={(event) => onRangeChange({ startDate: event.target.value })}
                slotProps={{
                  input: { disableUnderline: true },
                  htmlInput: { 'aria-label': '开始日期' },
                }}
              />
              <ArrowForwardRounded className="data-analysis-toolbar-date-arrow" aria-hidden="true" />
              <TextField
                variant="standard"
                type="date"
                value={filters.endDate}
                onChange={(event) => onRangeChange({ endDate: event.target.value })}
                slotProps={{
                  input: { disableUnderline: true },
                  htmlInput: { 'aria-label': '结束日期' },
                }}
              />
            </Box>
          </Box>
        </Box>

        <Button
          className="data-analysis-toolbar-sync"
          variant="contained"
          startIcon={<RefreshRounded />}
          disabled={loading}
          onClick={onRefresh}
          disableElevation
        >
          同步流量
        </Button>
      </Box>
    </Card>
  );
}
