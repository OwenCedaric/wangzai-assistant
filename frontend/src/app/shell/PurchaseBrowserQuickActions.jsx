import ClickAwayListener from '@mui/material/ClickAwayListener';
import IconButton from '@mui/material/IconButton';
import OpenInBrowserRounded from '@mui/icons-material/OpenInBrowserRounded';
import RestartAltRounded from '@mui/icons-material/RestartAltRounded';
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded';
import LocalMallRounded from '@mui/icons-material/LocalMallRounded';
import ShoppingCartRounded from '@mui/icons-material/ShoppingCartRounded';
import StorefrontRounded from '@mui/icons-material/StorefrontRounded';
import ShoppingBagRounded from '@mui/icons-material/ShoppingBagRounded';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import React from 'react';
import { listPurchaseAccounts, savePurchaseAccount } from '../../api/localApiClient.js';
import {
  forceResetPurchaseBrowserLogin,
  openPurchaseBrowserLogin,
  readPurchaseBrowserState,
} from '../../features/settings/services/purchaseBrowserLoginClient.js';
import { PURCHASE_ACCOUNT_PRESETS } from '../../shared/config/purchaseAccountPresets.js';

const PLATFORM_ICONS = Object.freeze({
  拼多多: ShoppingCartRounded,
  淘宝: LocalMallRounded,
  天猫: StorefrontRounded,
  '1688': Inventory2Rounded,
  Ozon买家: ShoppingBagRounded,
});

// The top-bar shortcut is the real purchase-browser entrance, not a mirror of
// every historical platform parser.  Only the five platforms whose login and
// Cookie persistence flows are complete are exposed here.
export const QUICK_PURCHASE_ACCOUNT_PRESETS = Object.freeze(
  PURCHASE_ACCOUNT_PRESETS.filter((preset) => Boolean(PLATFORM_ICONS[preset.platformName])),
);

function accountRows(payload) {
  const rows = Array.isArray(payload?.accounts) ? payload.accounts : payload?.rows;
  return Array.isArray(rows) ? rows.filter((account) => account?.id && account?.platformName) : [];
}

function pickAccount(accounts, platformName, activeAccountId = '') {
  const matching = accounts.filter((account) => account.platformName === platformName);
  return matching.find((account) => account.id === activeAccountId)
    || matching.find((account) => account.isDefault === true)
    || matching[0]
    || null;
}

export function PurchaseBrowserQuickActions() {
  const [platformOpen, setPlatformOpen] = React.useState(false);
  const [accounts, setAccounts] = React.useState([]);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');

  const loadAccounts = React.useCallback(async () => {
    try {
      const payload = await listPurchaseAccounts({ timeoutMs: 10000 });
      setAccounts(accountRows(payload));
    } catch {
      setAccounts([]);
    }
  }, []);

  React.useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  const openPlatform = React.useCallback(async (preset) => {
    setBusy(true);
    setMessage('');
    try {
      let account = pickAccount(accounts, preset.platformName);
      if (!account) {
        const saved = await savePurchaseAccount({
          name: preset.accountAlias,
          accountAlias: preset.accountAlias,
          platformName: preset.platformName,
          platformUrl: preset.platformUrl,
          isDefault: accounts.length === 0,
        }, { timeoutMs: 30000 });
        account = saved?.account || null;
        if (!account?.id) throw new Error('PURCHASE_BROWSER_ACCOUNT_SAVE_FAILED');
        setAccounts((current) => {
          const withoutSameId = current.filter((candidate) => candidate.id !== account.id);
          return [...withoutSameId, account];
        });
      }
      await openPurchaseBrowserLogin({
        accountId: account.id,
        accountLabel: account.name || preset.accountAlias,
        platformName: account.platformName || preset.platformName,
        platformUrl: account.platformUrl || preset.platformUrl,
      });
      setPlatformOpen(false);
    } catch {
      setMessage(`${preset.platformName}内置浏览器打开失败，请稍后重试。`);
    } finally {
      setBusy(false);
    }
  }, [accounts]);

  const resetCurrent = React.useCallback(async () => {
    setBusy(true);
    setMessage('');
    try {
      const state = await readPurchaseBrowserState().catch(() => null);
      const activeTab = state?.tabs?.find((tab) => tab.tabId === state.activeTabId) || null;
      const activeAccount = pickAccount(accounts, activeTab?.platformName || '', activeTab?.accountId || '')
        || accounts.find((account) => account.id === activeTab?.accountId)
        || accounts.find((account) => account.isDefault === true)
        || accounts[0];
      if (!activeAccount) {
        setMessage('请先在设置中保存采购账号。');
        return;
      }
      await forceResetPurchaseBrowserLogin({
        accountId: activeAccount.id,
        accountLabel: activeAccount.name,
        platformName: activeAccount.platformName,
        platformUrl: activeAccount.platformUrl,
      });
    } catch {
      setMessage('浏览器强制刷新失败，请稍后重试。');
    } finally {
      setBusy(false);
    }
  }, [accounts]);

  return (
    <ClickAwayListener onClickAway={() => setPlatformOpen(false)}>
      <Stack direction="row" spacing={0.5} alignItems="center" sx={{ position: 'relative' }}>
        <Tooltip title="打开内置浏览器">
          <span>
            <IconButton
              className="top-icon"
              aria-label="打开内置浏览器"
              disabled={busy}
              onClick={() => setPlatformOpen((current) => !current)}
            >
              <OpenInBrowserRounded />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="强制关闭并刷新内置浏览器（不清除登录信息）">
          <span>
            <IconButton
              className="top-icon"
              aria-label="强制刷新内置浏览器"
              disabled={busy}
              onClick={resetCurrent}
            >
              <RestartAltRounded />
            </IconButton>
          </span>
        </Tooltip>
        {platformOpen ? (
          <Paper
            elevation={8}
            role="menu"
            aria-label="选择采购平台"
            sx={{
              position: 'absolute',
              top: 'calc(100% + 8px)',
              right: 46,
              zIndex: 1500,
              p: 0.75,
              borderRadius: 2,
            }}
          >
            <Stack direction="row" spacing={0.5}>
              {QUICK_PURCHASE_ACCOUNT_PRESETS.map((preset) => {
                const PlatformIcon = PLATFORM_ICONS[preset.platformName];
                const account = pickAccount(accounts, preset.platformName);
                return (
                  <Tooltip
                    key={preset.platformCode}
                    title={account ? `打开${preset.platformName}` : `打开${preset.platformName}并创建独立登录环境`}
                  >
                    <span>
                      <IconButton
                        size="small"
                        role="menuitem"
                        aria-label={`打开${preset.platformName}`}
                        disabled={busy}
                        onClick={() => openPlatform(preset)}
                        sx={{
                          width: 36,
                          height: 36,
                          border: '1px solid',
                          borderColor: 'divider',
                        }}
                      >
                        <PlatformIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                );
              })}
            </Stack>
          </Paper>
        ) : null}
        {message ? (
          <Tooltip open title={message} placement="bottom">
            <span aria-live="polite" style={{ width: 0, height: 0 }} />
          </Tooltip>
        ) : null}
      </Stack>
    </ClickAwayListener>
  );
}

export default PurchaseBrowserQuickActions;
