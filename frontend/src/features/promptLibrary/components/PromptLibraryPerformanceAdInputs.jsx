import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { getSmartToolUsageInputSpec } from '../lib/smartToolUsage.js';
import {
  loadPerformanceAdAccounts,
  loadPerformanceAdCampaignOptions,
  PERFORMANCE_AD_USAGE_LABELS,
  selectPerformanceAdAccount,
  selectPerformanceAdCampaign,
} from '../services/smartToolPerformanceAdDataService.js';

function getErrorMessage(error, fallback) {
  return String(error?.payload?.error?.message
    || error?.payload?.message
    || (error instanceof Error ? error.message : error)
    || fallback);
}

export function PromptLibraryPerformanceAdInputs({
  selectedPrompt,
  selectedShopId = '',
  values = {},
  validationErrors = {},
  runAttempted = false,
  onChangeValue = () => {},
}) {
  const [accounts, setAccounts] = React.useState([]);
  const [campaigns, setCampaigns] = React.useState([]);
  const [accountLoading, setAccountLoading] = React.useState(true);
  const [campaignLoading, setCampaignLoading] = React.useState(false);
  const [accountError, setAccountError] = React.useState('');
  const [campaignError, setCampaignError] = React.useState('');

  const accountValue = String(values[PERFORMANCE_AD_USAGE_LABELS.account] || '').trim();
  const campaignValue = String(values[PERFORMANCE_AD_USAGE_LABELS.campaign] || '').trim();
  const dateRangeSpec = getSmartToolUsageInputSpec(
    selectedPrompt,
    PERFORMANCE_AD_USAGE_LABELS.dateRange,
  );
  const selectedAccount = React.useMemo(
    () => selectPerformanceAdAccount(accounts, accountValue),
    [accountValue, accounts],
  );

  React.useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setAccounts([]);
    setCampaigns([]);
    setAccountError('');
    setCampaignError('');
    setAccountLoading(true);
    loadPerformanceAdAccounts({
      signal: controller.signal,
      ...(selectedShopId ? { shopId: selectedShopId } : {}),
    })
      .then((rows) => {
        if (!active) return;
        setAccounts(rows);
      })
      .catch((error) => {
        if (!active || error?.name === 'AbortError') return;
        setAccountError(getErrorMessage(error, '推广账号读取失败。'));
      })
      .finally(() => {
        if (active) setAccountLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [selectedPrompt?.id, selectedShopId]);

  React.useEffect(() => {
    if (accountLoading) return;
    const nextAccount = selectPerformanceAdAccount(accounts, accountValue) || accounts[0] || null;
    const nextAccountId = nextAccount?.id || '';
    if (accountValue !== nextAccountId) {
      onChangeValue(PERFORMANCE_AD_USAGE_LABELS.account, nextAccountId);
    }
  }, [accountLoading, accountValue, accounts, onChangeValue]);

  React.useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setCampaigns([]);
    setCampaignError('');
    if (!selectedAccount) {
      setCampaignLoading(false);
      return () => controller.abort();
    }
    setCampaignLoading(true);
    loadPerformanceAdCampaignOptions(selectedAccount, { signal: controller.signal })
      .then((rows) => {
        if (!active) return;
        setCampaigns(rows);
      })
      .catch((error) => {
        if (!active || error?.name === 'AbortError') return;
        setCampaignError(getErrorMessage(error, '广告计划读取失败。'));
      })
      .finally(() => {
        if (active) setCampaignLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [selectedAccount]);

  React.useEffect(() => {
    if (campaignLoading || !campaignValue) return;
    const selectedCampaign = selectPerformanceAdCampaign(campaigns, campaignValue);
    const nextCampaignId = selectedCampaign?.id || '';
    if (campaignValue !== nextCampaignId) {
      onChangeValue(PERFORMANCE_AD_USAGE_LABELS.campaign, nextCampaignId);
    }
  }, [campaignLoading, campaignValue, campaigns, onChangeValue]);

  const handleAccountChange = React.useCallback((event) => {
    onChangeValue(PERFORMANCE_AD_USAGE_LABELS.campaign, '');
    onChangeValue(PERFORMANCE_AD_USAGE_LABELS.account, event.target.value);
  }, [onChangeValue]);

  return (
    <Stack className="prompt-library-performance-ad-inputs" spacing={1.1}>
      <TextField
        className="prompt-library-standard-usage-field"
        size="small"
        select
        fullWidth
        label="推广账号"
        InputLabelProps={{ shrink: true }}
        value={selectedAccount?.id || ''}
        disabled={accountLoading || !accounts.length}
        helperText={accountLoading
          ? '正在读取小齿轮中保存的推广账号…'
          : accounts.length
            ? '账号来自「设置 → 平台接口」，不会在这里显示密钥。'
            : '请先在小齿轮中配置 Ozon Performance API。'}
        onChange={handleAccountChange}
        SelectProps={{
          displayEmpty: true,
          renderValue: (value) => accounts.find((account) => account.id === value)?.title
            || (accountLoading ? '正在读取推广账号…' : '暂无可用推广账号'),
        }}
        InputProps={{
          endAdornment: accountLoading ? <CircularProgress size={14} /> : undefined,
        }}
      >
        {accounts.length ? accounts.map((account) => (
          <MenuItem key={account.id} value={account.id}>{account.title}</MenuItem>
        )) : (
          <MenuItem value="" disabled>暂无可用推广账号</MenuItem>
        )}
      </TextField>

      <TextField
        className="prompt-library-standard-usage-field"
        size="small"
        select
        fullWidth
        label="广告计划"
        InputLabelProps={{ shrink: true }}
        value={selectPerformanceAdCampaign(campaigns, campaignValue)?.id || ''}
        disabled={!selectedAccount || campaignLoading}
        helperText={campaignLoading
          ? '正在读取当前账号的广告计划…'
          : campaigns.length
            ? `已读取 ${campaigns.length} 个计划，可直接选择。`
            : selectedAccount
              ? '当前账号没有返回广告计划。'
              : '选择推广账号后自动读取广告计划。'}
        onChange={(event) => onChangeValue(PERFORMANCE_AD_USAGE_LABELS.campaign, event.target.value)}
        SelectProps={{
          displayEmpty: true,
          renderValue: (value) => selectPerformanceAdCampaign(campaigns, value)?.label || '全部计划',
        }}
        InputProps={{
          endAdornment: campaignLoading ? <CircularProgress size={14} /> : undefined,
        }}
      >
        <MenuItem value="">全部计划</MenuItem>
        {campaigns.map((campaign) => (
          <MenuItem key={campaign.id} value={campaign.id}>{campaign.label}</MenuItem>
        ))}
      </TextField>

      <TextField
        className="prompt-library-standard-usage-field"
        size="small"
        select
        fullWidth
        label="统计范围"
        InputLabelProps={{ shrink: true }}
        value={values[PERFORMANCE_AD_USAGE_LABELS.dateRange] || dateRangeSpec?.defaultValue || '7'}
        helperText={runAttempted && validationErrors[PERFORMANCE_AD_USAGE_LABELS.dateRange]
          ? validationErrors[PERFORMANCE_AD_USAGE_LABELS.dateRange]
          : '点击分析时会重新读取这个时间范围的完整实时数据。'}
        error={runAttempted && Boolean(validationErrors[PERFORMANCE_AD_USAGE_LABELS.dateRange])}
        onChange={(event) => onChangeValue(PERFORMANCE_AD_USAGE_LABELS.dateRange, event.target.value)}
      >
        {(dateRangeSpec?.options || []).map((option) => (
          <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
        ))}
      </TextField>

      {accountError ? <Alert severity="warning">{accountError}</Alert> : null}
      {campaignError ? <Alert severity="warning">{campaignError}</Alert> : null}
      {!accountLoading && !accountError && !accounts.length ? (
        <Typography variant="caption" color="text.secondary">
          保存账号后重新打开此功能，即可直接选择。
        </Typography>
      ) : null}
    </Stack>
  );
}
