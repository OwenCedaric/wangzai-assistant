import { getOzonShopClientId } from '../../../entities/order/orderShopScope.jsx';
import { calculateLogisticsFreight } from '../../../services/logisticsPricingService.js';
import {
  loadLogisticsPricingSettings,
  readSavedLogisticsPricingSettings,
} from '../../../services/logisticsPricingSettingsRuntime.js';
import { resolveLogisticsPricingSelection } from '../../../services/logisticsPricingSettingsStore.js';
import {
  LOGISTICS_PRICING_PROVIDERS,
} from '../../../shared/config/logisticsPricingPresets.js';
import {
  buildWarehouseFreightRouteText,
  completeWarehouseFreightCurrencyDraft,
  normalizeWarehouseFreightProductProfile,
  toWarehouseFreightDraft,
} from '../lib/warehouseFreightEstimate.js';
import {
  requestWarehouseFreightProductProfile,
  requestWarehouseFreightRubCnyRate,
} from '../services/warehouseFreightProductService.js';
import { WarehouseProductIdentity } from './WarehouseProductIdentity.jsx';
import CalculateRounded from '@mui/icons-material/CalculateRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import FormControl from '@mui/material/FormControl';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';

const SERVICE_OPTIONS = [
  { value: 'auto', label: '自动识别运输等级' },
  { value: 'express', label: 'Express 特快' },
  { value: 'standard', label: 'Standard 标准' },
  { value: 'economy', label: 'Economy 经济' },
  { value: 'hk', label: '香港空运' },
];

const ALL_MARKET_OPTIONS = Object.values(
  Object.fromEntries(
    LOGISTICS_PRICING_PROVIDERS.flatMap((provider) => provider.marketOptions).map((item) => [item.value, item])
  )
);

const FREIGHT_MENU_PROPS = {
  PaperProps: { className: 'warehouse-freight-menu-paper' },
  MenuListProps: { className: 'warehouse-freight-menu-list' },
};

function getProviderLabel(providerId = '') {
  return LOGISTICS_PRICING_PROVIDERS.find((provider) => provider.id === providerId)?.label || providerId || '未识别';
}

function formatWeight(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(3)} kg` : '未返回';
}

function FreightMetric({ label, value, highlight = false }) {
  return (
    <Box className={`warehouse-freight-metric ${highlight ? 'is-highlight' : ''}`}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant={highlight ? 'h5' : 'subtitle2'}>{value}</Typography>
    </Box>
  );
}

export function WarehouseFreightEstimatorCard({
  activeShop,
  warehouses = [],
  methodRows = [],
  productRows = [],
  selectedWarehouse,
  selectedMethod,
  selectedProduct,
  onWarehouseChange,
  onMethodChange,
  onProductChange,
}) {
  const [pricingSettings, setPricingSettings] = React.useState(() => readSavedLogisticsPricingSettings());
  React.useEffect(() => {
    let cancelled = false;
    loadLogisticsPricingSettings()
      .then((loaded) => {
        if (!cancelled) setPricingSettings(loaded);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const scopedSelection = React.useMemo(
    () =>
      resolveLogisticsPricingSelection(pricingSettings, {
        accountId: getOzonShopClientId(activeShop),
        shopClientId: getOzonShopClientId(activeShop),
        shopId: activeShop?.id,
      }),
    [activeShop, pricingSettings]
  );
  const [providerId, setProviderId] = React.useState(scopedSelection.providerId);
  const [market, setMarket] = React.useState(scopedSelection.market);
  const [serviceLevel, setServiceLevel] = React.useState(scopedSelection.serviceLevel);
  const [routeId, setRouteId] = React.useState(scopedSelection.routeId);
  const [draft, setDraft] = React.useState(() =>
    toWarehouseFreightDraft(normalizeWarehouseFreightProductProfile(selectedProduct))
  );
  const [profileState, setProfileState] = React.useState({ status: 'idle', source: 'local-cache', message: '' });
  const [exchangeRateState, setExchangeRateState] = React.useState({
    status: 'loading',
    rubToCnyRate: null,
    source: '',
  });
  const profileRequestRef = React.useRef(0);

  React.useEffect(() => {
    let cancelled = false;
    requestWarehouseFreightRubCnyRate()
      .then((result) => {
        if (!cancelled) setExchangeRateState({ status: 'ready', ...result });
      })
      .catch(() => {
        if (!cancelled) setExchangeRateState({ status: 'error', rubToCnyRate: null, source: '' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    setProviderId(scopedSelection.providerId);
    setMarket(scopedSelection.market);
    setServiceLevel(scopedSelection.serviceLevel);
    setRouteId(scopedSelection.routeId);
  }, [scopedSelection]);

  React.useEffect(() => {
    const profile = normalizeWarehouseFreightProductProfile(selectedProduct);
    setDraft(toWarehouseFreightDraft(profile));
    setProfileState({
      status: profile.complete ? 'ready' : 'idle',
      source: profile.source,
      message: profile.complete ? '已从本机商品快照带入材积' : '',
    });
    setRouteId('');
  }, [selectedProduct]);

  React.useEffect(() => {
    setRouteId('');
  }, [selectedMethod?.id]);

  React.useEffect(() => {
    setDraft((current) => completeWarehouseFreightCurrencyDraft(current, exchangeRateState.rubToCnyRate));
  }, [draft.productValueCny, draft.productValueRub, exchangeRateState.rubToCnyRate]);

  const selectedProvider = LOGISTICS_PRICING_PROVIDERS.find((provider) => provider.id === providerId) || null;
  const marketOptions = selectedProvider ? selectedProvider.marketOptions : ALL_MARKET_OPTIONS;

  React.useEffect(() => {
    if (marketOptions.some((option) => option.value === market)) return;
    setMarket(marketOptions[0]?.value || 'RU');
    setRouteId('');
  }, [market, marketOptions]);

  const updateDraft = (field) => (event) => {
    setDraft((current) => ({ ...current, [field]: event.target.value }));
    setRouteId('');
  };

  const selectProvider = (nextProviderId) => {
    setProviderId(nextProviderId);
    const provider = LOGISTICS_PRICING_PROVIDERS.find((item) => item.id === nextProviderId);
    if (provider && !provider.markets.includes(market)) setMarket(provider.markets[0]);
    setRouteId('');
  };

  const routeText = React.useMemo(() => buildWarehouseFreightRouteText(selectedMethod), [selectedMethod]);
  const estimate = React.useMemo(
    () =>
      calculateLogisticsFreight({
        ...draft,
        providerId,
        market,
        serviceLevel,
        routeId,
        routeText,
      }),
    [draft, market, providerId, routeId, routeText, serviceLevel]
  );

  const readProductProfile = async () => {
    if (!selectedProduct) return;
    const requestId = profileRequestRef.current + 1;
    profileRequestRef.current = requestId;
    setProfileState({ status: 'loading', source: '', message: '' });
    try {
      const result = await requestWarehouseFreightProductProfile(activeShop, selectedProduct);
      if (profileRequestRef.current !== requestId) return;
      setDraft(toWarehouseFreightDraft(result.profile));
      setRouteId('');
      setProfileState({
        status: 'ready',
        source: 'ozon-live',
        message: result.warnings.length ? result.warnings.join('；') : '已从 Ozon 读取商品材积和价格',
      });
    } catch (error) {
      if (profileRequestRef.current !== requestId) return;
      setProfileState({
        status: 'error',
        source: '',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const renderSelectedProduct = (value) => {
    const product = productRows.find((item) => item.id === value);
    return product ? <WarehouseProductIdentity product={product} compact /> : '请选择商品';
  };

  const renderSelectedWarehouse = (value) => {
    const warehouse = warehouses.find((item) => item.id === value);
    if (!warehouse) return '请选择仓库';
    return (
      <Box className="warehouse-freight-select-value">
        <Typography variant="subtitle2" noWrap>{warehouse.name}</Typography>
        <Typography variant="caption" color="text.secondary" noWrap>仓库编号 {warehouse.rawId}</Typography>
      </Box>
    );
  };

  const renderSelectedMethod = (value) => {
    const method = methodRows.find((item) => item.id === value);
    if (!method) return '请选择配送方式';
    return (
      <Box className="warehouse-freight-select-value">
        <Typography variant="subtitle2" noWrap title={method.name}>{method.name}</Typography>
        <Typography variant="caption" color="text.secondary" noWrap>方式编号 {method.rawId}</Typography>
      </Box>
    );
  };

  return (
    <Card className="warehouse-logistics-card warehouse-bind-card warehouse-freight-card">
      <CardContent>
        <Stack direction="row" alignItems="center" spacing={1} mb={1.25}>
          <CalculateRounded color="primary" />
          <Typography variant="h6">物流运费测算</Typography>
        </Stack>

        <Stack spacing={1.5}>
          <Box>
            <Typography variant="caption" className="warehouse-bind-label">
              物流公司测算页
            </Typography>
            <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap className="warehouse-provider-tabs">
              <Button
                size="small"
                variant={providerId === 'auto' ? 'contained' : 'outlined'}
                onClick={() => selectProvider('auto')}
              >
                自动识别
              </Button>
              {LOGISTICS_PRICING_PROVIDERS.map((provider) => (
                <Button
                  key={provider.id}
                  size="small"
                  variant={providerId === provider.id ? 'contained' : 'outlined'}
                  onClick={() => selectProvider(provider.id)}
                >
                  {provider.label}
                </Button>
              ))}
            </Stack>
          </Box>

          <Box className="warehouse-freight-select-grid">
            <FormControl size="small" fullWidth className="warehouse-bind-field warehouse-freight-select">
              <Typography variant="caption" className="warehouse-bind-label">选择仓库</Typography>
              <Select
                value={selectedWarehouse?.id || ''}
                displayEmpty
                renderValue={renderSelectedWarehouse}
                MenuProps={FREIGHT_MENU_PROPS}
                onChange={(event) => onWarehouseChange?.(event.target.value)}
              >
                <MenuItem value="">请选择仓库</MenuItem>
                {warehouses.map((warehouse) => (
                  <MenuItem key={warehouse.id} value={warehouse.id} className="warehouse-freight-menu-item">
                    <Box className="warehouse-select-option">
                      <Typography variant="subtitle2" noWrap>{warehouse.name}</Typography>
                      <Typography variant="caption" color="text.secondary" noWrap>仓库编号：{warehouse.rawId}</Typography>
                    </Box>
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl size="small" fullWidth className="warehouse-bind-field warehouse-freight-select">
              <Typography variant="caption" className="warehouse-bind-label">选择 Ozon 配送方式</Typography>
              <Select
                value={selectedMethod?.id || ''}
                displayEmpty
                renderValue={renderSelectedMethod}
                MenuProps={FREIGHT_MENU_PROPS}
                onChange={(event) => onMethodChange?.(event.target.value)}
              >
                <MenuItem value="">请选择配送方式</MenuItem>
                {methodRows.map((method) => (
                  <MenuItem key={method.id} value={method.id} className="warehouse-freight-menu-item">
                    <Box className="warehouse-select-option">
                      <Typography variant="subtitle2" noWrap title={method.name}>{method.name}</Typography>
                      <Typography variant="caption" color="text.secondary" noWrap>方式编号：{method.rawId}</Typography>
                    </Box>
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>

          <FormControl size="small" fullWidth className="warehouse-bind-field warehouse-product-bind-field warehouse-freight-select warehouse-freight-product-select">
            <Typography variant="caption" className="warehouse-bind-label">选择商品</Typography>
            <Select
              value={selectedProduct?.id || ''}
              displayEmpty
              MenuProps={FREIGHT_MENU_PROPS}
              onChange={(event) => onProductChange?.(event.target.value)}
              renderValue={renderSelectedProduct}
            >
              <MenuItem value="">请选择商品</MenuItem>
              {productRows.map((product) => (
                <MenuItem key={product.id} value={product.id} className="warehouse-select-menu-item warehouse-product-select-menu-item">
                  <WarehouseProductIdentity product={product} compact />
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'stretch', sm: 'center' }}>
            <Button
              size="small"
              variant="outlined"
              startIcon={profileState.status === 'loading' ? <CircularProgress size={16} /> : <RefreshRounded />}
              disabled={!selectedProduct || profileState.status === 'loading'}
              onClick={readProductProfile}
            >
              从 Ozon 读取材积/价格
            </Button>
            <Typography variant="caption" color={profileState.status === 'error' ? 'error' : 'text.secondary'}>
              {profileState.message || '本机快照没有材积时，可手动填写或点击读取'}
            </Typography>
          </Stack>

          <Box className="warehouse-freight-input-grid">
            <TextField size="small" label="实重 (kg)" value={draft.weightKg} onChange={updateDraft('weightKg')} />
            <TextField size="small" label="长 (cm)" value={draft.lengthCm} onChange={updateDraft('lengthCm')} />
            <TextField size="small" label="宽 (cm)" value={draft.widthCm} onChange={updateDraft('widthCm')} />
            <TextField size="small" label="高 (cm)" value={draft.heightCm} onChange={updateDraft('heightCm')} />
            <TextField size="small" label="货值 (RUB)" value={draft.productValueRub} onChange={updateDraft('productValueRub')} />
            <TextField size="small" label="货值 (CNY)" value={draft.productValueCny} onChange={updateDraft('productValueCny')} />
          </Box>

          <Box className="warehouse-freight-select-grid">
            <FormControl size="small" fullWidth className="warehouse-freight-select warehouse-freight-select-compact">
              <Typography variant="caption" className="warehouse-bind-label">目的市场</Typography>
              <Select value={market} MenuProps={FREIGHT_MENU_PROPS} onChange={(event) => { setMarket(event.target.value); setRouteId(''); }}>
                {marketOptions.map((option) => (
                  <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl size="small" fullWidth className="warehouse-freight-select warehouse-freight-select-compact">
              <Typography variant="caption" className="warehouse-bind-label">运输等级</Typography>
              <Select value={serviceLevel} MenuProps={FREIGHT_MENU_PROPS} onChange={(event) => { setServiceLevel(event.target.value); setRouteId(''); }}>
                {SERVICE_OPTIONS.map((option) => (
                  <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>

          {estimate.ambiguous && estimate.candidates.length ? (
            <FormControl size="small" fullWidth className="warehouse-freight-select warehouse-freight-select-compact">
              <Typography variant="caption" className="warehouse-bind-label">匹配到多条线路，请确认</Typography>
              <Select value={routeId} displayEmpty MenuProps={FREIGHT_MENU_PROPS} onChange={(event) => setRouteId(event.target.value)}>
                <MenuItem value="">请选择精确线路</MenuItem>
                {estimate.candidates.map((candidate) => (
                  <MenuItem key={candidate.routeId} value={candidate.routeId}>
                    {getProviderLabel(candidate.providerId)} · {candidate.routeLabel} · ¥{Number(candidate.amount).toFixed(2)}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          ) : null}

          {selectedProduct && estimate.ok ? (
            <Box className="warehouse-freight-result">
              <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1} mb={1.5}>
                <Box>
                  <Typography variant="caption" color="text.secondary">自动匹配结果</Typography>
                  <Typography variant="subtitle1" fontWeight={800}>{estimate.providerLabel} · {estimate.routeLabel}</Typography>
                </Box>
                <Chip color="success" label={estimate.display} />
              </Stack>
              <Box className="warehouse-freight-metric-grid">
                <FreightMetric label="预估运费" value={estimate.display} highlight />
                <FreightMetric label="实重" value={formatWeight(estimate.actualWeight)} />
                <FreightMetric label="体积重" value={formatWeight(estimate.volumeWeight)} />
                <FreightMetric label="计费重量" value={formatWeight(estimate.chargeWeight)} />
                <FreightMetric label="kg 单价" value={`¥${Number(estimate.kgFee).toFixed(2)}`} />
                <FreightMetric label="票费" value={`¥${Number(estimate.ticketFee).toFixed(2)}`} />
              </Box>
            </Box>
          ) : null}
        </Stack>
      </CardContent>
    </Card>
  );
}
