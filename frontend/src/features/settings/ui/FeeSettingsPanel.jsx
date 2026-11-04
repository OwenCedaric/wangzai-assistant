import {
  createFeePlan,
  emptyFeeSettings,
  normalizeFeePlanState,
  normalizeFeeSettings,
} from '../../../services/feeSettingsStore';
import {
  feePlatformOptions,
  formatFeeMetric,
  readSavedFeePlanState,
  saveFeePlanState,
  toFiniteFeeNumber,
} from '../lib/feeSettings.jsx';
import { loadFeePlanState } from '../lib/feeSettings.jsx';
import PriceCheckRounded from '@mui/icons-material/PriceCheckRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import SaveRounded from '@mui/icons-material/SaveRounded';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { LogisticsPricingSettingsCard } from './LogisticsPricingSettingsCard.jsx';
import { STABLE_SELECT_MENU_PROPS } from './stableSelectMenuProps.js';

export function FeeSettingsPanel({ onAction, saveRequestId = 0, shops = [] }) {
  const [feePlanState, setFeePlanState] = React.useState(() => readSavedFeePlanState());
  const [feeSettingsStatus, setFeeSettingsStatus] = React.useState('本机 SQLite 读取中');
  const activePlan =
    feePlanState.plans.find((plan) => plan.id === feePlanState.activeId) || feePlanState.plans[0] || createFeePlan(1);
  const settings = activePlan.settings;

  React.useEffect(() => {
    let cancelled = false;
    setFeeSettingsStatus('本机 SQLite 读取中');
    loadFeePlanState()
      .then((state) => {
        if (cancelled) return;
        setFeePlanState(state);
        setFeeSettingsStatus('本机 SQLite 已同步');
      })
      .catch(() => {
        if (cancelled) return;
        setFeePlanState(readSavedFeePlanState());
        setFeeSettingsStatus('本机 SQLite 读取失败，请重试');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateActivePlanSettings = (updater, shouldPersist = false) => {
    setFeePlanState((current) => {
      const nextState = {
        ...current,
        plans: current.plans.map((plan) =>
          plan.id === current.activeId
            ? {
                ...plan,
                settings: normalizeFeeSettings(
                  typeof updater === 'function' ? updater(plan.settings) : { ...plan.settings, ...updater }
                ),
              }
            : plan
        ),
      };
      return shouldPersist ? saveFeePlanState(nextState) : normalizeFeePlanState(nextState);
    });
  };

  const updateField = (field) => (event) => {
    updateActivePlanSettings((current) => ({ ...current, [field]: event.target.value }));
  };

  const selectFeePlan = (id) => {
    setFeePlanState((current) => saveFeePlanState({ ...current, activeId: id }));
  };

  const addFeePlan = () => {
    setFeePlanState((current) => {
      const nextPlan = createFeePlan(current.plans.length + 1);
      const nextState = {
        activeId: nextPlan.id,
        plans: [...current.plans, nextPlan],
      };
      return saveFeePlanState(nextState);
    });
    onAction('新增费用方案');
  };

  const deleteFeePlan = () => {
    setFeePlanState((current) => {
      const currentIndex = current.plans.findIndex((plan) => plan.id === current.activeId);
      const nextPlans = current.plans.filter((plan) => plan.id !== current.activeId);
      const safePlans = nextPlans.length > 0 ? nextPlans : [createFeePlan(1)];
      const nextActivePlan = nextPlans[Math.max(0, currentIndex - 1)] || safePlans[0];
      return saveFeePlanState({
        activeId: nextActivePlan.id,
        plans: safePlans,
      });
    });
    onAction('删除费用方案');
  };

  const resetSettings = () => {
    updateActivePlanSettings(emptyFeeSettings, true);
    onAction('恢复默认');
  };

  const saveSettings = (action = '保存设定') => {
    const nextSettings = {
      ...settings,
      savedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    };
    updateActivePlanSettings(nextSettings, true);
    onAction(action);
  };

  const saveSettingsRef = React.useRef(saveSettings);
  saveSettingsRef.current = saveSettings;
  const handledSaveRequestIdRef = React.useRef(saveRequestId);
  React.useEffect(() => {
    if (saveRequestId === handledSaveRequestIdRef.current) return;
    handledSaveRequestIdRef.current = saveRequestId;
    saveSettingsRef.current('保存');
  }, [saveRequestId]);

  const labelFeeUnit = toFiniteFeeNumber(settings.labelFeeUnit);
  const rechargeAmount = toFiniteFeeNumber(settings.rechargeAmount);
  const giftAmount = toFiniteFeeNumber(settings.giftAmount) ?? 0;
  const forecastOrderFee = toFiniteFeeNumber(settings.forecastOrderFee);
  const rechargeRate = rechargeAmount !== null && rechargeAmount + giftAmount > 0
    ? rechargeAmount / (rechargeAmount + giftAmount)
    : null;
  const labelFee = labelFeeUnit !== null && rechargeRate !== null ? labelFeeUnit * rechargeRate : null;
  const totalFee = labelFeeUnit !== null && forecastOrderFee !== null && rechargeRate !== null
    ? (labelFeeUnit + forecastOrderFee) * rechargeRate
    : null;

  const feeMetrics = [
    { label: '平台贴单费', value: labelFee },
    { label: '预报订单费', value: forecastOrderFee },
    { label: '折算现金成本', value: totalFee },
  ];
  const selectedPlatformLabel =
    feePlatformOptions.find((option) => option.value === settings.platform)?.label || '未选择';
  const hasAnyFeeSetting = Object.entries(settings).some(
    ([key, value]) => key !== 'savedAt' && String(value ?? '').trim() !== ''
  );
  const feeStatusLabel = hasAnyFeeSetting ? '已配置' : '待配置';
  const feeProfileItems = [
    { label: '费用平台', value: selectedPlatformLabel },
    { label: '贴单单价', value: settings.labelFeeUnit || '未填写' },
    { label: '充值金额', value: settings.rechargeAmount || '未填写' },
    { label: '赠送金额', value: settings.giftAmount || '未填写' },
    { label: '现金折算系数', value: rechargeRate === null ? '未填写' : rechargeRate.toFixed(6) },
    { label: '预报订单费', value: settings.forecastOrderFee || '未填写' },
    { label: '配置来源', value: feeSettingsStatus },
    { label: '保存', value: settings.savedAt || '未保存' },
  ];

  return (
    <Box className="shop-settings-layout fee-settings-layout">
      <Box className="shop-list-card">
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} mb={1.5}>
          <Box>
            <Typography variant="h6">全局费用方案</Typography>
            <Typography variant="body2" color="text.secondary">
              共 {feePlanState.plans.length} 个方案
            </Typography>
          </Box>
          <Button size="small" variant="contained" onClick={addFeePlan}>
            新增
          </Button>
        </Stack>
        <Stack spacing={1} className="shop-list">
          {feePlanState.plans.map((plan) => {
            const planHasSetting = Object.entries(plan.settings).some(
              ([key, value]) => key !== 'savedAt' && String(value ?? '').trim() !== ''
            );
            return (
              <Box
                key={plan.id}
                component="button"
                type="button"
                className={`shop-list-item${plan.id === feePlanState.activeId ? ' active' : ''}`}
                onClick={() => selectFeePlan(plan.id)}
              >
                <Box>
                  <Typography variant="subtitle1">{plan.name}</Typography>
                  <Typography variant="caption" color="text.secondary" noWrap>
                    {plan.settings.savedAt ? `已保存 ${plan.settings.savedAt}` : '全局利润口径待填写'}
                  </Typography>
                </Box>
                <Chip
                  size="small"
                  color={planHasSetting ? 'primary' : 'default'}
                  label={planHasSetting ? '已配置' : '待配置'}
                  variant="outlined"
                />
              </Box>
            );
          })}
        </Stack>
        <Button className="shop-remove-button" size="small" color="error" variant="outlined" onClick={deleteFeePlan}>
          删除当前方案
        </Button>
      </Box>

      <Box className="shop-settings-detail">
        <Box className="shop-settings-main">
          <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1.5} mb={2}>
            <Box>
              <Typography variant="h6">全局费用设定</Typography>
              <Typography variant="body2" color="text.secondary">
                所有店铺进入利润核算页后都会自动按这套费用口径计算，不需要手动点击计算。
              </Typography>
            </Box>
            <Chip color="primary" label="本机配置库" variant="outlined" />
          </Stack>

          <Box className="structured-form-sections fee-form-sections">
            <Box className="structured-form-section">
              <Typography variant="h6">费用平台</Typography>
              <Box className="structured-form-row">
                <Box className="structured-form-fields">
                  <Box className="structured-field">
                    <Typography className="structured-field-label" variant="subtitle2">
                      费用平台
                    </Typography>
                    <Select
                      size="small"
                      value={settings.platform}
                      displayEmpty
                      onChange={updateField('platform')}
                      MenuProps={STABLE_SELECT_MENU_PROPS}
                      renderValue={(selected) =>
                        feePlatformOptions.find((option) => option.value === selected)?.label || ''
                      }
                    >
                      <MenuItem value="">
                        <em>不选择</em>
                      </MenuItem>
                      {feePlatformOptions.map((option) => (
                        <MenuItem key={option.value} value={option.value}>
                          {option.label}
                        </MenuItem>
                      ))}
                    </Select>
                  </Box>
                </Box>
                <Button variant="contained" onClick={() => saveSettings('保存平台')}>
                  保存平台
                </Button>
              </Box>
            </Box>

            <Box className="structured-form-section">
              <Typography variant="h6">贴单费用</Typography>
              <Box className="structured-form-row">
                <Box className="structured-form-fields fee-triple-fields">
                  <Box className="structured-field">
                    <Typography className="structured-field-label" variant="subtitle2">
                      贴单计费单价（元）
                    </Typography>
                    <TextField
                      size="small"
                      type="number"
                      value={settings.labelFeeUnit}
                      onChange={updateField('labelFeeUnit')}
                    />
                  </Box>
                  <Box className="structured-field">
                    <Typography className="structured-field-label" variant="subtitle2">
                      充值金额（元）
                    </Typography>
                    <TextField
                      size="small"
                      type="number"
                      value={settings.rechargeAmount}
                      onChange={updateField('rechargeAmount')}
                    />
                  </Box>
                  <Box className="structured-field">
                    <Typography className="structured-field-label" variant="subtitle2">
                      赠送金额（元）
                    </Typography>
                    <TextField
                      size="small"
                      type="number"
                      value={settings.giftAmount}
                      onChange={updateField('giftAmount')}
                    />
                  </Box>
                </Box>
                <Button variant="contained" onClick={() => saveSettings('保存贴单费')}>
                  保存贴单费
                </Button>
              </Box>
            </Box>

            <Box className="structured-form-section">
              <Typography variant="h6">预报费用</Typography>
              <Box className="structured-form-row">
                <Box className="structured-form-fields">
                  <Box className="structured-field">
                    <Typography className="structured-field-label" variant="subtitle2">
                      预报订单费（元）
                    </Typography>
                    <TextField
                      size="small"
                      type="number"
                      value={settings.forecastOrderFee}
                      onChange={updateField('forecastOrderFee')}
                    />
                  </Box>
                </Box>
                <Button variant="contained" onClick={() => saveSettings('保存订单费')}>
                  保存订单费
                </Button>
              </Box>
            </Box>

            <Box className="structured-form-section">
              <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
                <Box>
                  <Typography variant="h6">充值折算记录</Typography>
                  <Typography variant="body2" color="text.secondary">
                    每次修改实付和赠送后保存，系统自动追加生效记录；旧订单继续使用当时的比例。
                  </Typography>
                </Box>
                <Chip
                  size="small"
                  color={settings.rechargeRateHistory.length ? 'primary' : 'default'}
                  label={`${settings.rechargeRateHistory.length} 条`}
                  variant="outlined"
                />
              </Stack>
              <Stack spacing={1} mt={1.5}>
                {settings.rechargeRateHistory.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    保存当前充值设置后自动生成第一条折算记录。
                  </Typography>
                ) : settings.rechargeRateHistory.slice().reverse().slice(0, 8).map((entry) => {
                  const paid = Number(entry.rechargeAmount);
                  const gift = Number(entry.giftAmount);
                  const rate = paid > 0 && paid + gift > 0 ? paid / (paid + gift) : 1;
                  const effectiveAtMs = Date.parse(entry.effectiveAt);
                  const effectiveAtLabel = Number.isFinite(effectiveAtMs)
                    ? new Date(effectiveAtMs).toLocaleString('zh-CN')
                    : '最早适用记录';
                  return (
                    <Box key={entry.id} className="shop-profile-grid">
                      <Box>
                        <Typography variant="caption" color="text.secondary">生效时间</Typography>
                        <Typography variant="subtitle2">{effectiveAtLabel}</Typography>
                      </Box>
                      <Box>
                        <Typography variant="caption" color="text.secondary">充值/赠送</Typography>
                        <Typography variant="subtitle2">¥{paid.toFixed(2)} + ¥{gift.toFixed(2)}</Typography>
                      </Box>
                      <Box>
                        <Typography variant="caption" color="text.secondary">现金系数</Typography>
                        <Typography variant="subtitle2">{rate.toFixed(6)}</Typography>
                      </Box>
                    </Box>
                  );
                })}
              </Stack>
            </Box>

            <LogisticsPricingSettingsCard
              shops={shops}
              onAction={onAction}
              saveRequestId={saveRequestId}
            />
          </Box>

          <Box className="shop-connect-note">
            <Typography variant="subtitle1">使用说明</Typography>
            <Typography variant="body2" color="text.secondary">
              这里保存的是全局利润核算默认费用，不会触发真实下单、付款、Ozon 提交或跨境巴士预报。
            </Typography>
          </Box>

          <Box className="settings-module-actions fee-settings-global-actions">
            <Button size="small" variant="outlined" startIcon={<RefreshRounded />} onClick={resetSettings}>
              恢复默认
            </Button>
            <Button size="small" variant="contained" startIcon={<SaveRounded />} onClick={() => saveSettings()}>
              保存设定
            </Button>
          </Box>
        </Box>

        <Box className="shop-settings-side">
          <Box className="shop-profile-card">
            <Stack direction="row" alignItems="center" spacing={1.5}>
              <Avatar className="store-avatar store-primary">
                <PriceCheckRounded />
              </Avatar>
              <Box>
                <Typography variant="subtitle1">全局利润费用口径</Typography>
                <Typography variant="caption" color="text.secondary">
                  本地配置，不触发业务接口
                </Typography>
              </Box>
            </Stack>
            <Divider sx={{ my: 1.5 }} />
            <Box className="shop-profile-grid">
              {feeProfileItems.map((item) => (
                <Box key={item.label}>
                  <Typography variant="caption" color="text.secondary">
                    {item.label}
                  </Typography>
                  <Typography variant="subtitle1" noWrap title={item.value}>
                    {item.value}
                  </Typography>
                </Box>
              ))}
              <Box>
                <Typography variant="caption" color="text.secondary">
                  状态
                </Typography>
                <Chip
                  size="small"
                  color={hasAnyFeeSetting ? 'primary' : 'default'}
                  label={feeStatusLabel}
                  variant="outlined"
                />
              </Box>
            </Box>
          </Box>

          <Box className="api-check-card">
            <Stack direction="row" alignItems="center" justifyContent="space-between" mb={1.5}>
              <Typography variant="h6">当前预估口径</Typography>
              <Chip size="small" color="primary" label="本地核算" variant="outlined" />
            </Stack>
            <Box className="fee-metric-grid">
              {feeMetrics.map((metric) => (
                <Box key={metric.label} className="fee-metric-card">
                  <Typography variant="body2" color="text.secondary">
                    {metric.label}
                  </Typography>
                  <Typography variant="h5">{formatFeeMetric(metric.value)}</Typography>
                </Box>
              ))}
            </Box>
            <Typography variant="body2" color="text.secondary" className="fee-settings-description">
              贴单费、预报费和真实跨境巴士流水统一按“实付充值 ÷（实付充值 + 赠送额度）”折算。
              真实流水保留余额扣费原值，利润只扣折算后的现金成本；退款沿用原扣费比例冲回。
            </Typography>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
