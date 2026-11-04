import {
  LOGISTICS_PRICING_PRESET_VERSION,
  LOGISTICS_PRICING_PROVIDERS,
  LOGISTICS_PRICING_ROUTES,
} from '../../../shared/config/logisticsPricingPresets.js';
import {
  emptyLogisticsPricingSelection,
  normalizeLogisticsPricingSelection,
  setLogisticsPricingScopeSelection,
} from '../../../services/logisticsPricingSettingsStore.js';
import {
  loadLogisticsPricingSettings,
  readSavedLogisticsPricingSettings,
  saveLogisticsPricingSettings,
} from '../../../services/logisticsPricingSettingsRuntime.js';
import LocalShippingRounded from '@mui/icons-material/LocalShippingRounded';
import SaveRounded from '@mui/icons-material/SaveRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';

const SERVICE_OPTIONS = [
  { value: 'auto', label: '按 Ozon 线路名称自动匹配' },
  { value: 'express', label: 'Express 特快' },
  { value: 'standard', label: 'Standard 标准' },
  { value: 'economy', label: 'Economy 经济' },
  { value: 'hk', label: '香港空运' },
];

const STABLE_SELECT_MENU_PROPS = Object.freeze({
  disableScrollLock: true,
});

function parseScopeKey(scopeKey) {
  const [type = 'global', ...idParts] = String(scopeKey || 'global').split(':');
  return { type, id: idParts.join(':') };
}

function shopForScopeKey(shops, scopeKey) {
  const scope = parseScopeKey(scopeKey);
  const source = Array.isArray(shops) ? shops : [];
  return source.find((shop) => {
    const shopId = String(shop?.id || '').trim();
    const clientId = String(shop?.clientId || shop?.client_id || '').trim();
    return scope.type === 'account' ? clientId === scope.id : scope.type === 'shop' && shopId === scope.id;
  }) || null;
}

function getDirectScopeSelection(settings, scopeKey, shops = []) {
  const scope = parseScopeKey(scopeKey);
  if (scope.type === 'shop') return settings.shopSelections[scope.id] || null;
  if (scope.type === 'account') {
    const direct = settings.accountSelections[scope.id] || null;
    if (direct) return direct;
    const legacyShopId = String(shopForScopeKey(shops, scopeKey)?.id || '').trim();
    return legacyShopId ? settings.shopSelections[legacyShopId] || null : null;
  }
  return settings.globalSelection;
}

function getScopeOptions(shops = []) {
  const source = Array.isArray(shops) ? shops : [];
  const options = [{ value: 'global', label: '全局默认（所有用户/店铺）' }];
  source.forEach((shop) => {
    const shopId = String(shop?.id || '').trim();
    const clientId = String(shop?.clientId || shop?.client_id || '').trim();
    const label = String(shop?.shopAlias || shop?.sellerName || shop?.name || shopId || clientId).trim();
    if (!shopId && !clientId) return;
    options.push({
      value: clientId ? `account:${clientId}` : `shop:${shopId}`,
      label: clientId ? `${label}（${clientId}）` : label,
    });
  });
  return options.filter((option, index, values) => values.findIndex((item) => item.value === option.value) === index);
}

export function LogisticsPricingSettingsCard({ shops = [], onAction, saveRequestId = 0 }) {
  const [settings, setSettings] = React.useState(() => readSavedLogisticsPricingSettings());
  const [scopeKey, setScopeKey] = React.useState('global');
  const [status, setStatus] = React.useState('本机 SQLite 读取中');
  const scopeOptions = React.useMemo(() => getScopeOptions(shops), [shops]);
  const directSelection = getDirectScopeSelection(settings, scopeKey, shops);
  const inherited = scopeKey !== 'global' && directSelection === null;
  const [draft, setDraft] = React.useState(() => normalizeLogisticsPricingSelection(directSelection));

  React.useEffect(() => {
    let cancelled = false;
    loadLogisticsPricingSettings()
      .then((loaded) => {
        if (cancelled) return;
        setSettings(loaded);
        setStatus('本机 SQLite 已同步');
      })
      .catch(() => {
        if (cancelled) return;
        setStatus('本机 SQLite 读取失败，请重试');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    const selected = getDirectScopeSelection(settings, scopeKey, shops) || settings.globalSelection;
    setDraft(normalizeLogisticsPricingSelection(selected || emptyLogisticsPricingSelection));
  }, [scopeKey, settings, shops]);

  const provider = LOGISTICS_PRICING_PROVIDERS.find((item) => item.id === draft.providerId) || null;
  const marketOptions = provider
    ? provider.marketOptions
    : Object.values(Object.fromEntries(LOGISTICS_PRICING_PROVIDERS.flatMap((item) => item.marketOptions).map((item) => [item.value, item])));
  const availableRouteCount = LOGISTICS_PRICING_ROUTES.filter((route) =>
    (draft.providerId === 'auto' || route.providerId === draft.providerId) &&
    route.market === draft.market &&
    (draft.serviceLevel === 'auto' || route.serviceLevel === draft.serviceLevel)
  ).length;

  const updateDraft = (field) => (event) => {
    const value = event.target.value;
    setDraft((current) => {
      const next = { ...current, [field]: value, routeId: '' };
      if (field === 'providerId' && value !== 'auto') {
        const nextProvider = LOGISTICS_PRICING_PROVIDERS.find((item) => item.id === value);
        if (nextProvider && !nextProvider.markets.includes(current.market)) next.market = nextProvider.markets[0];
      }
      return normalizeLogisticsPricingSelection(next);
    });
  };

  const persistSelection = React.useCallback((actionLabel = '保存物流预估设置') => {
    const scope = parseScopeKey(scopeKey);
    let next = setLogisticsPricingScopeSelection(settings, scope, draft);
    const legacyShopId = scope.type === 'account'
      ? String(shopForScopeKey(shops, scopeKey)?.id || '').trim()
      : '';
    if (legacyShopId && next.shopSelections[legacyShopId]) {
      const shopSelections = { ...next.shopSelections };
      delete shopSelections[legacyShopId];
      next = { ...next, shopSelections };
    }
    const saved = saveLogisticsPricingSettings(next);
    setSettings(saved);
    setStatus('已提交本机 SQLite');
    onAction?.(actionLabel);
  }, [draft, onAction, scopeKey, settings, shops]);

  const resetScope = () => {
    const scope = parseScopeKey(scopeKey);
    if (scope.type === 'global') {
      const next = saveLogisticsPricingSettings({ ...settings, globalSelection: emptyLogisticsPricingSelection });
      setSettings(next);
      onAction?.('恢复全局物流默认设置');
      return;
    }
    const accountSelections = { ...settings.accountSelections };
    const shopSelections = { ...settings.shopSelections };
    if (scope.type === 'account') {
      delete accountSelections[scope.id];
      const legacyShopId = String(shopForScopeKey(shops, scopeKey)?.id || '').trim();
      if (legacyShopId) delete shopSelections[legacyShopId];
    } else {
      delete shopSelections[scope.id];
    }
    const next = saveLogisticsPricingSettings({ ...settings, accountSelections, shopSelections });
    setSettings(next);
    onAction?.('恢复继承全局物流设置');
  };

  const persistRef = React.useRef(persistSelection);
  persistRef.current = persistSelection;
  const handledSaveRequestIdRef = React.useRef(saveRequestId);
  React.useEffect(() => {
    if (saveRequestId === handledSaveRequestIdRef.current) return;
    handledSaveRequestIdRef.current = saveRequestId;
    persistRef.current('保存');
  }, [saveRequestId]);

  return (
    <Box className="structured-form-section">
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} mb={1.5}>
        <Box>
          <Stack direction="row" alignItems="center" spacing={1}>
            <LocalShippingRounded color="primary" />
            <Typography variant="h6">物流运费预估</Typography>
          </Stack>
          <Typography variant="body2" color="text.secondary">
            CEL、GUOO、ZTO、URAL、兴远共 {LOGISTICS_PRICING_ROUTES.length} 条线路；每个店铺独立设置，新店自动继承全局默认。
          </Typography>
        </Box>
        <Chip size="small" color="primary" variant="outlined" label={`预设 ${LOGISTICS_PRICING_PRESET_VERSION}`} />
      </Stack>

      <Box className="structured-form-row">
        <Box className="structured-form-fields logistics-pricing-fields">
          <Box className="structured-field">
            <Typography className="structured-field-label" variant="subtitle2">应用范围</Typography>
            <Select
              size="small"
              value={scopeKey}
              onChange={(event) => setScopeKey(event.target.value)}
              MenuProps={STABLE_SELECT_MENU_PROPS}
            >
              {scopeOptions.map((option) => <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>)}
            </Select>
          </Box>
          <Box className="structured-field">
            <Typography className="structured-field-label" variant="subtitle2">物流服务商</Typography>
            <Select
              size="small"
              value={draft.providerId}
              onChange={updateDraft('providerId')}
              MenuProps={STABLE_SELECT_MENU_PROPS}
            >
              <MenuItem value="auto">自动识别服务商</MenuItem>
              {LOGISTICS_PRICING_PROVIDERS.map((item) => <MenuItem key={item.id} value={item.id}>{item.label}</MenuItem>)}
            </Select>
          </Box>
          <Box className="structured-field">
            <Typography className="structured-field-label" variant="subtitle2">目的市场</Typography>
            <Select
              size="small"
              value={draft.market}
              onChange={updateDraft('market')}
              MenuProps={STABLE_SELECT_MENU_PROPS}
            >
              {marketOptions.map((item) => <MenuItem key={item.value} value={item.value}>{item.label}</MenuItem>)}
            </Select>
          </Box>
          <Box className="structured-field">
            <Typography className="structured-field-label" variant="subtitle2">默认运输等级</Typography>
            <Select
              size="small"
              value={draft.serviceLevel}
              onChange={updateDraft('serviceLevel')}
              MenuProps={STABLE_SELECT_MENU_PROPS}
            >
              {SERVICE_OPTIONS.map((item) => <MenuItem key={item.value} value={item.value}>{item.label}</MenuItem>)}
            </Select>
          </Box>
        </Box>
      </Box>

      <Box className="logistics-pricing-footer">
        <Box className="logistics-pricing-status">
          <Chip size="small" color={inherited ? 'default' : 'success'} label={inherited ? '当前继承全局' : '当前范围已独立配置'} />
          <Typography variant="caption" color="text.secondary">
            当前筛选可用 {availableRouteCount} 条线路 · {status}
          </Typography>
        </Box>
        <Box className="logistics-pricing-actions">
          <Button size="small" variant="outlined" onClick={resetScope}>{scopeKey === 'global' ? '恢复默认' : '恢复继承'}</Button>
          <Button size="small" variant="contained" startIcon={<SaveRounded />} onClick={() => persistSelection()}>
            保存此范围
          </Button>
        </Box>
      </Box>
    </Box>
  );
}
