import AccountBalanceWalletRounded from '@mui/icons-material/AccountBalanceWalletRounded';
import CleaningServicesRounded from '@mui/icons-material/CleaningServicesRounded';
import LoginRounded from '@mui/icons-material/LoginRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import SaveRounded from '@mui/icons-material/SaveRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import Grid from '@mui/material/Grid';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { listPurchaseAccounts } from '../../../api/localApiClient.js';

import {
  clearPurchasePaymentCredential,
  clearPurchasePaymentSession,
  clearSharedAlipayLogin,
  getSharedAlipayLoginStatus,
  getPurchasePaymentCredentialStatus,
  getPurchasePaymentLoginStatus,
  openSharedAlipayLogin,
  savePurchasePaymentCredential,
  waitForSharedAlipayLogin,
  waitForPurchasePaymentLogin,
} from '../services/purchasePaymentCredentialClient.js';
import {
  DEFAULT_PURCHASE_AUTO_PAY_SETTINGS,
  loadPurchaseAutoPaySettings,
  savePurchaseAutoPaySettings,
} from '../services/purchaseAutoPaySettingsService.js';

const EMPTY_CREDENTIAL = Object.freeze({ accountRef: '', platform: '拼多多', loginAccount: '', paymentPassword: '' });
const WAIT_PAY_URLS = Object.freeze({
  拼多多: 'https://mobile.yangkeduo.com/orders.html?type=1&order_index=75',
  淘宝: 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm?action=itemlist/BoughtQueryAction&event_submit_do_query=1&tabCode=waitPay',
  天猫: 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm?action=itemlist/BoughtQueryAction&event_submit_do_query=1&tabCode=waitPay',
  '1688': 'https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html?tradeStatus=waitbuyerpay&page=1&pageSize=10',
});

function configuredAccountIdsForPlatform(settings, platform) {
  if (platform === '拼多多') return settings.allowedPinduoduoAccountIds;
  if (platform === '1688') return settings.allowed1688AccountIds;
  return settings.allowedTaobaoAccountIds;
}

export function resolvePlatformPaymentAccount(accounts, platform, preferredAccountIds = [], fallbackAccountRef = '') {
  const scopedAccounts = (Array.isArray(accounts) ? accounts : []).filter((account) => (
    platform === '淘宝' || platform === '天猫'
      ? ['淘宝', '天猫'].includes(accountPlatform(account))
      : accountPlatform(account) === platform
  ));
  const preferredIds = Array.isArray(preferredAccountIds) ? preferredAccountIds : [];
  return preferredIds
    .map((id) => scopedAccounts.find((account) => account.id === id))
    .find(Boolean)
    || scopedAccounts.find((account) => account.id === fallbackAccountRef)
    || scopedAccounts[0]
    || null;
}

export function PurchaseAutoPaySettingsDialog({ open, onClose, logs = [] }) {
  const [settings, setSettings] = React.useState(DEFAULT_PURCHASE_AUTO_PAY_SETTINGS);
  const [credential, setCredential] = React.useState(EMPTY_CREDENTIAL);
  const [credentialDrafts, setCredentialDrafts] = React.useState({});
  const [credentialStatusByAccount, setCredentialStatusByAccount] = React.useState({});
  const [loginStatusByAccount, setLoginStatusByAccount] = React.useState({});
  const [accounts, setAccounts] = React.useState([]);
  const [message, setMessage] = React.useState('');
  const [error, setError] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [logsOpen, setLogsOpen] = React.useState(false);
  const [sharedAlipayCredential, setSharedAlipayCredential] = React.useState({ loginAccount: '', loginPassword: '' });
  const [sharedAlipayStatus, setSharedAlipayStatus] = React.useState(null);
  const [sharedAlipayLoading, setSharedAlipayLoading] = React.useState(false);
  const loginPollTokensRef = React.useRef(new Map());

  React.useEffect(() => {
    if (!open) loginPollTokensRef.current.clear();
  }, [open]);

  const refreshAccountRows = React.useCallback(async (rows, platformFilter = '') => {
    const targets = (Array.isArray(rows) ? rows : []).filter((account) => {
      const platform = accountPlatform(account);
      if (!['拼多多', '淘宝', '天猫', '1688'].includes(platform)) return false;
      if (!platformFilter) return true;
      return ['淘宝', '天猫'].includes(platformFilter)
        ? ['淘宝', '天猫'].includes(platform)
        : platform === platformFilter;
    });
    const results = await Promise.all(targets.map(async (account) => {
      const platform = accountPlatform(account);
      const [credentialStatus, loginStatus] = await Promise.all([
        getPurchasePaymentCredentialStatus(account.id).catch(() => ({ accountRef: account.id, configured: false })),
        getPurchasePaymentLoginStatus({ accountRef: account.id, platform }).catch((statusError) => ({
          accountId: account.id,
          platform,
          loggedIn: false,
          cookieSaved: false,
          error: statusError?.message || '登录状态读取失败',
        })),
      ]);
      return { account, platform, credentialStatus, loginStatus };
    }));
    setCredentialStatusByAccount((current) => ({
      ...current,
      ...Object.fromEntries(results.map((row) => [row.account.id, row.credentialStatus])),
    }));
    setLoginStatusByAccount((current) => ({
      ...current,
      ...Object.fromEntries(results.map((row) => [row.account.id, row.loginStatus])),
    }));
    setCredentialDrafts((current) => {
      const next = { ...current };
      for (const row of results) {
        next[row.account.id] = {
          accountRef: row.account.id,
          platform: row.platform,
          loginAccount: next[row.account.id]?.loginAccount
            || row.credentialStatus?.loginAccount
            || row.account.loginAccount
            || '',
          paymentPassword: next[row.account.id]?.paymentPassword || '',
        };
      }
      return next;
    });
    return results;
  }, []);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setMessage('');
    setError('');
    Promise.all([
      loadPurchaseAutoPaySettings().catch(() => DEFAULT_PURCHASE_AUTO_PAY_SETTINGS),
      listPurchaseAccounts({ timeoutMs: 10000 }).catch(() => ({ accounts: [] })),
      getSharedAlipayLoginStatus().catch(() => ({ configured: false, loggedIn: false, loginAccount: '' })),
    ]).then(([nextSettings, accountPayload, alipayStatus]) => {
      if (cancelled) return;
      setSettings(nextSettings);
      const rows = Array.isArray(accountPayload?.accounts) ? accountPayload.accounts : [];
      setAccounts(rows);
      setSharedAlipayStatus(alipayStatus);
      setSharedAlipayCredential((current) => ({
        ...current,
        loginAccount: current.loginAccount || alipayStatus?.loginAccount || '',
      }));
      if (rows[0]?.id) {
        const firstPlatform = accountPlatform(rows[0]) || '拼多多';
        setCredential((current) => current.accountRef ? current : {
          accountRef: rows[0].id,
          platform: firstPlatform,
          loginAccount: rows[0].loginAccount || '',
          paymentPassword: '',
        });
      }
      void refreshAccountRows(rows).catch(() => undefined);
    });
    return () => { cancelled = true; };
  }, [open, refreshAccountRows]);

  const update = (key) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const updateTaotian = (event) => {
    const checked = event.target.checked;
    setSettings((current) => ({ ...current, allowTaobao: checked, allowTmall: checked }));
  };

  const verifySharedAlipay = async () => {
    const loginAccount = sharedAlipayCredential.loginAccount.trim();
    if (!loginAccount) {
      setError('请先输入支付宝账号。');
      return;
    }
    const pddAccount = paymentAccountForPlatform('拼多多');
    if (!pddAccount?.id) {
      setError('请先配置一个拼多多采购账号，用它打开待付款订单进入支付宝收银台。');
      return;
    }
    setError('');
    setSharedAlipayLoading(true);
    try {
      await openSharedAlipayLogin({
        loginAccount,
        loginPassword: sharedAlipayCredential.loginPassword,
        purchaseAccountId: pddAccount.id,
      });
      setSharedAlipayStatus((current) => ({ ...(current || {}), configured: true, checking: true, windowOpen: true }));
      setMessage('支付宝验证窗口已打开；请在拼多多待付款页选择一笔订单进入支付宝，再用支付密码或短信验证码验证。');
      const status = await waitForSharedAlipayLogin();
      setSharedAlipayStatus({ ...status, checking: false });
      if (status.loggedIn) {
        setSharedAlipayCredential((current) => ({ ...current, loginPassword: '' }));
        await refreshAccountRows(accounts);
        setMessage(`支付宝登录已确认，并已同步到 ${status.syncedOwnerCount || 0} 个采购账号。`);
      } else {
        setMessage('尚未检测到支付宝登录成功；验证窗口会保留，可完成验证码后点击验证按钮重试。');
      }
    } catch (loginError) {
      setError(loginError?.message || '打开支付宝验证窗口失败。');
    } finally {
      setSharedAlipayLoading(false);
    }
  };

  const clearSharedAlipay = async () => {
    setSharedAlipayLoading(true);
    setError('');
    try {
      await clearSharedAlipayLogin();
      setSharedAlipayCredential({ loginAccount: '', loginPassword: '' });
      setSharedAlipayStatus({ configured: false, loggedIn: false, cookieSaved: false });
      setMessage('统一支付宝登录凭据和登录会话已清除。');
    } catch (clearError) {
      setError(clearError?.message || '清除支付宝登录失败。');
    } finally {
      setSharedAlipayLoading(false);
    }
  };

  const paymentAccountForPlatform = (platform) => resolvePlatformPaymentAccount(
    accounts,
    platform,
    configuredAccountIdsForPlatform(settings, platform),
    accountPlatform(accounts.find((account) => account.id === credential.accountRef)) === platform
      || (
        ['淘宝', '天猫'].includes(platform)
        && ['淘宝', '天猫'].includes(accountPlatform(accounts.find((account) => account.id === credential.accountRef)))
      )
      ? credential.accountRef
      : '',
  );

  const credentialForPlatform = (platform) => {
    const account = paymentAccountForPlatform(platform);
    if (!account) return { ...EMPTY_CREDENTIAL, platform };
    const draft = credentialDrafts[account.id] || {};
    const saved = credentialStatusByAccount[account.id] || {};
    return {
      accountRef: account.id,
      platform,
      loginAccount: draft.loginAccount || saved.loginAccount || account.loginAccount || '',
      paymentPassword: draft.paymentPassword || '',
    };
  };

  const updatePlatformCredential = (platform) => (updater) => {
    const current = credentialForPlatform(platform);
    const next = typeof updater === 'function' ? updater(current) : updater;
    if (!next?.accountRef) return;
    const normalized = { ...current, ...next, platform };
    setCredentialDrafts((drafts) => ({ ...drafts, [normalized.accountRef]: normalized }));
    setCredential(normalized);
  };

  const selectPaymentAccount = (platform) => {
    const account = paymentAccountForPlatform(platform);
    if (!account) throw new Error(`请先在采购账号设置中添加${platform}采购号。`);
    const selected = {
      ...(credentialDrafts[account.id] || {}),
      accountRef: account.id,
      platform,
      loginAccount: credentialDrafts[account.id]?.loginAccount
        || credentialStatusByAccount[account.id]?.loginAccount
        || account.loginAccount
        || '',
      paymentPassword: credentialDrafts[account.id]?.paymentPassword || '',
    };
    setCredential(selected);
    return account;
  };

  const saveSettings = async () => {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await savePurchaseAutoPaySettings(settings);
      const draftsToSave = Object.values(credentialDrafts).filter((draft) => draft?.accountRef && draft?.paymentPassword);
      const savedRows = await Promise.all(draftsToSave.map((draft) => savePurchasePaymentCredential(draft)));
      if (savedRows.length) {
        setCredentialStatusByAccount((current) => ({
          ...current,
          ...Object.fromEntries(savedRows.map((saved) => [saved.accountRef, { configured: true, ...saved }])),
        }));
        setCredentialDrafts((current) => Object.fromEntries(Object.entries(current).map(([accountRef, draft]) => [
          accountRef,
          { ...draft, paymentPassword: '' },
        ])));
        setCredential((current) => ({ ...current, paymentPassword: '' }));
      }
      setMessage('拍单配置已保存。');
    } catch (saveError) {
      setError(saveError?.message || '保存拍单配置失败。');
    } finally {
      setSaving(false);
    }
  };

  const clearCredential = async () => {
    if (!credential.accountRef) {
      setError('请先填写采购账号标识。');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await clearPurchasePaymentCredential(credential.accountRef);
      setCredentialStatusByAccount((current) => ({ ...current, [credential.accountRef]: { configured: false } }));
      setCredentialDrafts((current) => ({
        ...current,
        [credential.accountRef]: { ...(current[credential.accountRef] || credential), paymentPassword: '' },
      }));
      setMessage('该账号的支付凭据已清除。');
    } catch (clearError) {
      setError(clearError?.message || '清除支付凭据失败。');
    } finally {
      setSaving(false);
    }
  };

  const openManualLogin = async (platformOverride = '') => {
    const platform = platformOverride || credential.platform;
    setError('');
    try {
      const command = globalThis.window?.wangzaiDesktop?.purchaseBrowser?.command;
      if (typeof command !== 'function') throw new Error('桌面端采购浏览器未连接。');
      const account = selectPaymentAccount(platform);
      await command({
        command: 'open-purchase-payment-login',
        accountId: account.id,
        platform,
        platformName: `${platform || '采购'}支付宝登录`,
        accountLabel: account.name || account.loginAccount || credentialForPlatform(platform).loginAccount,
        url: WAIT_PAY_URLS[platform],
      });
      const token = Symbol(`payment-login:${account.id}`);
      loginPollTokensRef.current.set(account.id, token);
      setLoginStatusByAccount((current) => ({
        ...current,
        [account.id]: {
          ...(current[account.id] || {}),
          accountId: account.id,
          platform,
          checking: true,
          windowOpen: true,
        },
      }));
      setMessage(`${platform}支付登录窗口已打开；请从待付款订单进入支付宝，完成验证后状态会自动更新。`);
      void waitForPurchasePaymentLogin({ accountRef: account.id, platform })
        .then((loginStatus) => {
          if (loginPollTokensRef.current.get(account.id) !== token) return;
          loginPollTokensRef.current.delete(account.id);
          setLoginStatusByAccount((current) => ({
            ...current,
            [account.id]: { ...loginStatus, checking: false },
          }));
          if (loginStatus?.loggedIn === true) setMessage(`${platform}采购账号和支付宝登录状态已确认。`);
        })
        .catch((statusError) => {
          if (loginPollTokensRef.current.get(account.id) !== token) return;
          loginPollTokensRef.current.delete(account.id);
          setLoginStatusByAccount((current) => ({
            ...current,
            [account.id]: {
              ...(current[account.id] || {}),
              checking: false,
              loggedIn: false,
              error: statusError?.message || '登录状态读取失败',
            },
          }));
        });
    } catch (loginError) {
      setError(loginError?.message || '打开支付宝登录窗口失败。');
    }
  };

  const refreshAccounts = async (platformOverride = '') => {
    setError('');
    const payload = await listPurchaseAccounts({ timeoutMs: 10000 });
    const rows = Array.isArray(payload?.accounts) ? payload.accounts : [];
    setAccounts(rows);
    await refreshAccountRows(rows, platformOverride);
    setMessage(platformOverride ? `${platformOverride}账号和真实登录状态已刷新。` : '全部采购账号和真实登录状态已刷新。');
  };

  const clearSession = async () => {
    if (!credential.accountRef) {
      setError('请先填写采购账号标识。');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await clearPurchasePaymentSession(credential.accountRef);
      setLoginStatusByAccount((current) => ({
        ...current,
        [credential.accountRef]: { loggedIn: false, cookieSaved: false, verificationSource: 'cleared' },
      }));
      setMessage('支付宝登录缓存、Cookie 和支付窗口状态已清除。');
    } catch (sessionError) {
      setError(sessionError?.message || '清除支付宝缓存失败。');
    } finally {
      setSaving(false);
    }
  };

  const openSelectedWaitPay = async () => {
    try {
      const command = globalThis.window?.wangzaiDesktop?.purchaseBrowser?.command;
      if (typeof command !== 'function') throw new Error('桌面端采购浏览器未连接。');
      const account = selectPaymentAccount(credential.platform);
      await command({
        command: 'open-purchase-payment-login',
        url: WAIT_PAY_URLS[credential.platform],
        accountId: account.id,
        platform: credential.platform,
        platformName: `${credential.platform}待付款`,
        accountLabel: account.name || account.loginAccount || credentialForPlatform(credential.platform).loginAccount,
      });
      setMessage(`${credential.platform}支付专用 Electron 待付款窗口已打开。`);
    } catch (openError) {
      setError(openError?.message || '打开采购待付款窗口失败。');
    }
  };

  const openPlatformWaitPay = async (platform) => {
    try {
      const command = globalThis.window?.wangzaiDesktop?.purchaseBrowser?.command;
      if (typeof command !== 'function') throw new Error('桌面端采购浏览器未连接。');
      const account = selectPaymentAccount(platform);
      await command({
        command: 'open-purchase-payment-login',
        url: WAIT_PAY_URLS[platform],
        accountId: account.id,
        platform,
        platformName: `${platform}支付窗口`,
        accountLabel: account.name || account.loginAccount || credentialForPlatform(platform).loginAccount,
      });
      setMessage(`${platform}独立 Electron 支付窗口已打开。`);
    } catch (openError) {
      setError(openError?.message || `打开${platform}支付窗口失败。`);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={saving ? undefined : onClose}
      fullWidth
      maxWidth="xl"
      PaperProps={{
        sx: {
          width: 'min(1560px, calc(100vw - 32px))',
          maxWidth: 'none',
          height: 'calc(100vh - 24px)',
          maxHeight: 'calc(100vh - 24px)',
          borderRadius: '6px',
          overflow: 'hidden',
          '& .MuiOutlinedInput-root, & .MuiButton-root': { borderRadius: '6px' },
        },
      }}
    >
      <DialogTitle sx={{ px: { xs: 2, md: 3 }, py: 1.5, fontWeight: 800, fontSize: '1.45rem' }}>拍单配置</DialogTitle>
      <DialogContent
        dividers
        sx={{
          px: { xs: 2, md: 3 },
          py: { xs: 1.5, md: 2 },
          overflowY: 'hidden',
          minHeight: 0,
        }}
      >
        <Stack spacing={{ xs: 1.2, md: 1.5 }} sx={{ height: '100%', minHeight: 0, color: 'text.primary' }}>
          {error ? <Alert severity="error">{error}</Alert> : null}
          {message ? <Alert severity="success">{message}</Alert> : null}

          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ minHeight: 58 }}>
            <BoxLabel title="自动支付总开关" detail="开启后，自动拍单会在下单后进入付款流程。" />
            <FormControlLabel
              sx={{ m: 0, flex: '0 0 auto', whiteSpace: 'nowrap', '& .MuiFormControlLabel-label': { fontSize: '1rem' } }}
              control={<Switch checked={settings.enabled} onChange={update('enabled')} />}
              label={settings.enabled ? '已开启' : '已关闭'}
            />
          </Stack>
          <Divider />

          <Box>
            <SectionTitle title="支付设置" />
            <Stack direction="row" flexWrap="nowrap" gap={{ xs: 1.5, md: 4 }} sx={{ mt: 0.5, overflow: 'hidden' }}>
              <FormControlLabel sx={noWrapLabelSx} control={<Checkbox checked={settings.skipPresale} onChange={update('skipPresale')} />} label="预售订单直接跳过" />
              <FormControlLabel sx={noWrapLabelSx} control={<Checkbox checked={settings.allowTogetherPay} onChange={update('allowTogetherPay')} />} label="允许多个订单同时支付" />
              <FormControlLabel sx={noWrapLabelSx} control={<Checkbox checked={settings.autoSubmitOrder} onChange={update('autoSubmitOrder')} />} label="自动提交订单" />
              <FormControlLabel sx={noWrapLabelSx} control={<Checkbox checked={settings.showVerificationWindow} onChange={update('showVerificationWindow')} />} label="验证时弹出支付窗" />
              <FormControlLabel sx={noWrapLabelSx} control={<Checkbox checked={settings.allowCloudPurchase} onChange={update('allowCloudPurchase')} />} label="允许云端采购订单" />
            </Stack>
          </Box>
          <Divider />

          <Box>
            <SectionTitle title="拍单限制" />
            <Grid container spacing={{ xs: 1, md: 2 }} sx={{ mt: 0.5 }}>
              <Grid item xs={12} md={4}>
                <LimitField label="利润低于" suffix="元不拍（负数表示亏损）" value={settings.minProfit} onChange={update('minProfit')} />
              </Grid>
              <Grid item xs={12} md={4}>
                <LimitField label="利润率低于" suffix="%不拍" value={settings.minProfitPercent} onChange={update('minProfitPercent')} />
              </Grid>
              <Grid item xs={12} md={4}>
                <LimitField label="单笔订单金额超过" suffix="元不拍" value={settings.maxPayPrice} onChange={update('maxPayPrice')} />
              </Grid>
            </Grid>
          </Box>
          <Divider />

          <Box>
            <SectionTitle title="定时执行" />
            <Grid container spacing={{ xs: 1, md: 3 }} alignItems="center" sx={{ mt: 0.25 }}>
              <Grid item xs={12} md={3}>
                <ScheduleField label="每天定时开始" checked={settings.needAutoStart} onChange={update('needAutoStart')} value={settings.autoStartTime.slice(0, 5)} disabled={!settings.needAutoStart} onTimeChange={(event) => setSettings((current) => ({ ...current, autoStartTime: `${event.target.value}:00` }))} />
              </Grid>
              <Grid item xs={12} md={3}>
                <ScheduleField label="每天定时停止" checked={settings.needAutoEnd} onChange={update('needAutoEnd')} value={settings.autoEndTime.slice(0, 5)} disabled={!settings.needAutoEnd} onTimeChange={(event) => setSettings((current) => ({ ...current, autoEndTime: `${event.target.value}:00` }))} />
              </Grid>
              <Grid item xs={12} md={6}>
                <Stack direction="row" alignItems="center" justifyContent="flex-end" spacing={0.75} sx={{ minWidth: 0, whiteSpace: 'nowrap' }}>
                  <TextField
                    size="small"
                    label="统一支付宝账号"
                    value={sharedAlipayCredential.loginAccount}
                    onChange={(event) => setSharedAlipayCredential((current) => ({ ...current, loginAccount: event.target.value }))}
                    sx={{ width: 178, flex: '0 0 auto' }}
                  />
                  <TextField
                    size="small"
                    type="password"
                    label="支付密码（验证码可空）"
                    value={sharedAlipayCredential.loginPassword}
                    onChange={(event) => setSharedAlipayCredential((current) => ({ ...current, loginPassword: event.target.value }))}
                    autoComplete="new-password"
                    placeholder={sharedAlipayStatus?.passwordConfigured ? '已保存，留空复用' : ''}
                    sx={{ width: 190, flex: '0 0 auto' }}
                  />
                  <Button size="small" variant="contained" disabled={sharedAlipayLoading} onClick={verifySharedAlipay} sx={{ whiteSpace: 'nowrap', minWidth: 116 }}>
                    {sharedAlipayLoading ? '验证中…' : '打开收银台验证'}
                  </Button>
                  <Typography color={sharedAlipayStatus?.loggedIn ? 'success.main' : 'text.secondary'} variant="body2" sx={{ minWidth: 54, textAlign: 'center' }}>
                    {sharedAlipayStatus?.loggedIn ? '已登录' : sharedAlipayStatus?.checking ? '验证中' : '未登录'}
                  </Typography>
                  <Button size="small" color="error" disabled={sharedAlipayLoading} onClick={clearSharedAlipay} sx={{ whiteSpace: 'nowrap', minWidth: 52 }}>清除</Button>
                </Stack>
              </Grid>
            </Grid>
          </Box>
          <Divider />

          <Box>
            <SectionTitle title="平台自动支付" />
            <Stack spacing={0.8} sx={{ mt: 0.75 }}>
              <PlatformPaymentRow
                label="拼多多"
                platform="拼多多"
                checked={settings.allowPinduoduo}
                onChange={update('allowPinduoduo')}
                interval={settings.pddIntervalMinutes}
                onIntervalChange={update('pddIntervalMinutes')}
                accounts={accounts.filter((account) => accountPlatform(account) === '拼多多')}
                accountValue={settings.allowedPinduoduoAccountIds}
                onAccountChange={(value) => setSettings((current) => ({ ...current, allowedPinduoduoAccountIds: value }))}
                credential={credentialForPlatform('拼多多')}
                onCredentialChange={updatePlatformCredential('拼多多')}
                status={loginStatusByAccount[credentialForPlatform('拼多多').accountRef]}
                onLogin={openManualLogin}
                onRefresh={refreshAccounts}
              />
              <PlatformPaymentRow
                label="淘天"
                platform="淘宝"
                checked={settings.allowTaobao || settings.allowTmall}
                onChange={updateTaotian}
                interval={settings.taobaoIntervalMinutes}
                onIntervalChange={update('taobaoIntervalMinutes')}
                accounts={accounts.filter((account) => ['淘宝', '天猫'].includes(accountPlatform(account)))}
                accountValue={settings.allowedTaobaoAccountIds}
                onAccountChange={(value) => setSettings((current) => ({ ...current, allowedTaobaoAccountIds: value }))}
                credential={credentialForPlatform('淘宝')}
                onCredentialChange={updatePlatformCredential('淘宝')}
                status={loginStatusByAccount[credentialForPlatform('淘宝').accountRef]}
                onLogin={openManualLogin}
                onRefresh={refreshAccounts}
              />
              <PlatformPaymentRow
                label="1688"
                platform="1688"
                checked={settings.allow1688}
                onChange={update('allow1688')}
                interval={settings.alibaba1688IntervalMinutes}
                onIntervalChange={update('alibaba1688IntervalMinutes')}
                accounts={accounts.filter((account) => accountPlatform(account) === '1688')}
                accountValue={settings.allowed1688AccountIds}
                onAccountChange={(value) => setSettings((current) => ({ ...current, allowed1688AccountIds: value }))}
                credential={credentialForPlatform('1688')}
                onCredentialChange={updatePlatformCredential('1688')}
                status={loginStatusByAccount[credentialForPlatform('1688').accountRef]}
                onLogin={openManualLogin}
                onRefresh={refreshAccounts}
              />
            </Stack>
          </Box>
          <Divider />
          <SectionTitle title="支付账号与凭据操作" />
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            gap={0.25}
            sx={{
              minWidth: 0,
              flexWrap: 'nowrap',
              overflow: 'hidden',
              '& .MuiButton-root': {
                flex: '1 1 0',
                minWidth: 0,
                px: 0.35,
                fontSize: '0.78rem',
                lineHeight: 1.25,
                whiteSpace: 'nowrap',
              },
              '& .MuiButton-startIcon': { mr: 0.25 },
              '& .MuiSvgIcon-root': { fontSize: '1rem' },
              '& > .MuiTypography-root': { flex: '0 0 auto', whiteSpace: 'nowrap', fontSize: '0.875rem' },
            }}
          >
            <Typography color={credentialStatusByAccount[credential.accountRef]?.configured ? 'success.main' : 'text.secondary'}>{credentialStatusByAccount[credential.accountRef]?.configured ? '已保存支付凭据' : '尚未保存支付凭据'}</Typography>
            <Button size="small" startIcon={<LoginRounded />} onClick={() => openManualLogin()}>{credential.platform === '拼多多' ? '手动登录支付宝' : '打开支付登录流程'}</Button>
            <Button size="small" onClick={openSelectedWaitPay}>打开采购待付款页</Button>
            <Button size="small" startIcon={<AccountBalanceWalletRounded />} onClick={async () => {
                try {
                  const command = globalThis.window?.wangzaiDesktop?.purchaseBrowser?.command;
                  if (typeof command !== 'function') throw new Error('桌面端采购浏览器未连接。');
                  const result = await command({
                    command: 'show-purchase-payment-window',
                    sourceTabId: credential.accountRef ? `payment-login-${credential.accountRef}` : undefined,
                  });
                  setMessage(result?.shown ? '支付窗口已显示。' : '当前没有正在等待的支付窗口。');
                } catch (windowError) {
                  setError(windowError?.message || '显示支付窗口失败。');
                }
            }}>显示支付窗口</Button>
            <Button size="small" onClick={() => openPlatformWaitPay('淘宝')}>显示淘宝支付窗口</Button>
            <Button size="small" onClick={() => openPlatformWaitPay('1688')}>显示1688支付窗口</Button>
            <Button size="small" onClick={() => setLogsOpen(true)}>查看自动付款日志</Button>
            <Button size="small" onClick={() => refreshAccounts()}>刷新账号</Button>
            <Button size="small" color="error" startIcon={<CleaningServicesRounded />} onClick={clearSession}>清除支付缓存</Button>
            <Button size="small" color="error" startIcon={<CleaningServicesRounded />} onClick={clearCredential}>清除凭据</Button>
          </Stack>

          <Alert severity="info" icon={<AccountBalanceWalletRounded />} sx={{ py: 0.25, borderRadius: '6px', '& .MuiAlert-message': { py: 0.5, whiteSpace: 'nowrap' } }}>遇到验证码、风控或登录失效时，任务会暂停，可处理后从订单行继续。</Alert>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>关闭</Button>
        <Button variant="contained" startIcon={<SaveRounded />} onClick={saveSettings} disabled={saving}>{saving ? '保存中…' : '保存配置'}</Button>
      </DialogActions>
      <Dialog open={logsOpen} onClose={() => setLogsOpen(false)} fullWidth maxWidth="md">
        <DialogTitle sx={{ fontWeight: 800 }}>自动付款日志</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={0.8}>
            {logs.length ? logs.slice(0, 100).map((log) => (
              <Stack key={log.id} direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                <Typography variant="caption" color="text.secondary" sx={{ minWidth: 150 }}>{new Date(log.at).toLocaleString('zh-CN', { hour12: false })}</Typography>
                <Typography variant="body2" fontWeight={700} sx={{ minWidth: 180 }}>{log.posting || '未绑定订单'}</Typography>
                <Typography variant="body2" color={log.status === 'error' ? 'error.main' : 'text.primary'}>{log.message}</Typography>
              </Stack>
            )) : <Typography color="text.secondary">暂无自动付款日志。</Typography>}
          </Stack>
        </DialogContent>
        <DialogActions><Button onClick={() => setLogsOpen(false)}>关闭</Button></DialogActions>
      </Dialog>
    </Dialog>
  );
}

function BoxLabel({ title, detail }) {
  return <Box><Typography fontWeight={800} sx={{ fontSize: '1.15rem', lineHeight: 1.3 }}>{title}</Typography>{detail ? <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>{detail}</Typography> : null}</Box>;
}

const noWrapLabelSx = {
  m: 0,
  flex: '0 0 auto',
  whiteSpace: 'nowrap',
  '& .MuiFormControlLabel-label': { fontSize: '0.95rem' },
};

function SectionTitle({ title, detail }) {
  return <Box><Typography fontWeight={800} sx={{ fontSize: '1.1rem', lineHeight: 1.3 }}>{title}</Typography>{detail ? <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>{detail}</Typography> : null}</Box>;
}

function LimitField({ label, suffix, value, onChange }) {
  return (
    <Stack direction="row" alignItems="center" spacing={0.7} sx={{ minWidth: 0, whiteSpace: 'nowrap' }}>
      <Typography variant="body2" sx={{ fontSize: '0.9rem', flex: '0 0 auto' }}>{label}</Typography>
      <TextField
        size="small"
        type="number"
        value={value}
        onChange={onChange}
        inputProps={{ step: 'any' }}
        sx={{ flex: '1 1 96px', minWidth: 88, '& input': { py: 0.9, fontSize: '0.95rem' } }}
      />
      <Typography variant="body2" sx={{ fontSize: '0.88rem', flex: '0 0 auto' }}>{suffix}</Typography>
    </Stack>
  );
}

function ScheduleField({ label, checked, onChange, value, disabled, onTimeChange }) {
  return (
    <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0 }}>
      <FormControlLabel sx={noWrapLabelSx} control={<Checkbox checked={checked} onChange={onChange} />} label={label} />
      <TextField type="time" size="small" value={value} onChange={onTimeChange} disabled={disabled} sx={{ width: 136, flex: '0 0 auto', '& input': { py: 0.85, fontSize: '0.95rem' } }} />
    </Stack>
  );
}

function PlatformPaymentRow({ platform, label, checked, onChange, interval, onIntervalChange, accounts, accountValue, onAccountChange, credential, onCredentialChange, status, onLogin, onRefresh }) {
  const handleAccountChange = (nextValue) => {
    onAccountChange(nextValue);
    const firstId = nextValue[0] || '';
    const account = accounts.find((item) => item.id === firstId);
    onCredentialChange((current) => ({
      ...current,
      accountRef: firstId || current.accountRef,
      platform,
      loginAccount: account?.loginAccount || current.loginAccount,
    }));
  };

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: {
          xs: '1fr',
          md: 'minmax(250px, 1.35fr) minmax(215px, 1.15fr) minmax(145px, 0.8fr) minmax(130px, 0.75fr) minmax(168px, 0.95fr) minmax(108px, 0.65fr) minmax(92px, 0.55fr) minmax(108px, 0.65fr)',
        },
        alignItems: 'center',
        gap: { xs: 0.75, md: 1.25 },
        px: { xs: 1, md: 1.5 },
        py: { xs: 0.7, md: 0.8 },
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: '6px',
        minWidth: 0,
      }}
    >
      <Stack direction="row" alignItems="center" gap={1} sx={{ minWidth: 0, whiteSpace: 'nowrap' }}>
        <FormControlLabel sx={noWrapLabelSx} control={<Checkbox checked={checked} onChange={onChange} />} label={`支持（${label}）采购自动支付`} />
      </Stack>
      <AccountMultiSelect label={`${label}采购号`} accounts={accounts} value={accountValue} onChange={handleAccountChange} sx={{ minWidth: 0 }} />
      <TextField disabled={!credential.accountRef} size="small" label="支付宝账号" value={credential.loginAccount} onChange={(event) => onCredentialChange((current) => ({ ...current, platform, loginAccount: event.target.value }))} sx={{ minWidth: 0 }} />
      <TextField disabled={!credential.accountRef} size="small" type="password" label="支付密码" value={credential.paymentPassword} onChange={(event) => onCredentialChange((current) => ({ ...current, platform, paymentPassword: event.target.value }))} autoComplete="new-password" sx={{ minWidth: 0 }} />
      <Stack direction="row" alignItems="center" spacing={0.6} sx={{ whiteSpace: 'nowrap' }}>
        <Typography variant="body2" sx={{ fontSize: '0.88rem' }}>每轮支付间隔：</Typography>
        <TextField type="number" size="small" value={interval} onChange={onIntervalChange} inputProps={{ min: 1, max: 60 }} sx={{ width: 78, '& input': { py: 0.8, fontSize: '0.95rem' } }} />
        <Typography variant="body2" sx={{ fontSize: '0.88rem' }}>分钟</Typography>
      </Stack>
      <Button size="small" variant="contained" startIcon={<LoginRounded />} onClick={() => onLogin(platform)} sx={{ minWidth: 0, whiteSpace: 'nowrap', px: 0.75 }}>登录账号</Button>
      <Typography color={status?.loggedIn ? 'success.main' : 'text.secondary'} variant="body2" sx={{ whiteSpace: 'nowrap', fontSize: '0.85rem', textAlign: 'center' }}>{status?.loggedIn ? '已登录' : status?.checking ? '登录中' : status?.marketplaceLoggedIn ? '待登支付宝' : status?.error ? '检测失败' : '未登录'}</Typography>
      <Button size="small" startIcon={<RefreshRounded />} onClick={() => onRefresh(platform)} sx={{ minWidth: 0, whiteSpace: 'nowrap', px: 0.5 }}>刷新账号</Button>
    </Box>
  );
}

function accountPlatform(account = {}) {
  const value = String(account.platformName || account.platform || '').trim();
  const lower = value.toLowerCase();
  if (value === '拼多多' || ['pinduoduo', 'pdd'].includes(lower)) return '拼多多';
  if (value === '天猫' || lower === 'tmall') return '天猫';
  if (value === '淘宝' || lower === 'taobao') return '淘宝';
  if (value === '1688' || ['alibaba', 'alibaba1688'].includes(lower)) return '1688';
  return value;
}

function AccountMultiSelect({ label, accounts, value, onChange, sx }) {
  return (
    <Select
      multiple
      fullWidth
      size="small"
      displayEmpty
      value={value}
      onChange={(event) => onChange(event.target.value)}
      renderValue={(selected) => {
        const names = selected.map((id) => accounts.find((account) => account.id === id)?.name || accounts.find((account) => account.id === id)?.loginAccount || id).filter(Boolean);
        return names.length ? names.join('、') : `${label}：使用默认`;
      }}
      sx={{ minWidth: 0, ...sx, '& .MuiSelect-select': { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }}
    >
      {accounts.map((account) => (
        <MenuItem key={account.id} value={account.id}>
          <Checkbox checked={value.includes(account.id)} />
          {account.name || account.loginAccount || account.id}
        </MenuItem>
      ))}
      {!accounts.length ? <MenuItem disabled>当前没有该平台采购账号</MenuItem> : null}
    </Select>
  );
}
