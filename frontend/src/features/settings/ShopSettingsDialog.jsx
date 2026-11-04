import { settingsModuleTabs, visibleSettingsModuleTabs } from '../../shared/config/appConfigCore.jsx';
import { formatShopBindingTime } from '../../shared/lib/dateTimeFormat.js';
import {
  SAVED_CREDENTIAL_MASK,
} from './lib/credentialMask.js';
import CloudSyncRounded from '@mui/icons-material/CloudSyncRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import MinimizeRounded from '@mui/icons-material/MinimizeRounded';
import SettingsRounded from '@mui/icons-material/SettingsRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import { useMinimizableDialogTask } from '../../shared/ui/minimizedTasks/useMinimizableDialogTask.js';
import SettingsModuleContent from './SettingsModuleContent.jsx';
import ShopLicenseRenewalDialog from './ui/ShopLicenseRenewalDialog.jsx';
import { isShopBoundElsewhereError } from '../licensing/services/shopLicenseEntitlementService.js';
import { PendingAccountRemovalTasks } from './accountRemoval/components/PendingAccountRemovalTasks.jsx';
import {
  OzonShopListCard,
  OzonShopMainPanel,
  OzonShopSidePanel,
} from './OzonShopSettingsSections.jsx';

const EMPTY_SHOP = Object.freeze({
  id: '',
  shopAlias: '',
  sellerName: '',
  clientId: '',
  apiKey: '',
  connectionStatus: '未配置',
  connectionMessage: '暂无店铺，请先点击新增店铺。',
  lastTestAt: '',
  savedAt: '',
  remark: '',
});

const SHOP_CARD_PATTERN = /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/u;

function shopCardErrorMessage(error) {
  const message = String(error?.message || error || '').trim();
  if (error?.code === 'SHOP_LICENSE_RENEWAL_CARD_REQUIRED') {
    return '当前店铺卡密已到期，请先点击“续费卡密”完成续费。';
  }
  if (error?.code !== 'SHOP_BOUND_TO_ANOTHER_LICENSE' && isShopBoundElsewhereError(error)) {
    return '该店铺的 Client ID 已被其他账号的卡密绑定。请先在原账号中解除绑定，或联系管理员处理换绑；不需要续费，也不需要再买新卡。';
  }
  const translations = {
    'Activation code is invalid': '卡密无效，请核对后重试。',
    'Activation code is unavailable': '卡密已使用、已禁用或当前不可用。',
    'Activation code has expired': '卡密已过期，请更换后重试。',
    'Activation code belongs to another project': '该卡密不属于当前软件。',
    'Activation code is bound to another account': '该卡密已绑定其他账号。',
    'Renewal requires a standard shop card': '续费必须使用标准月卡或年卡。',
    'Renewal card belongs to another project': '该续费卡密不属于当前软件。',
    'Only active shop licenses can be renewed': '当前店铺授权状态不可续费，请联系管理员检查。',
    'License not found': '未找到当前店铺对应的卡密授权。',
    'The first-shop introductory card can only be used during registration': '首店 19.9 元卡只能在注册时使用，新增店铺请使用标准月卡或年卡。',
  };
  return translations[message] || message || '店铺卡密验证失败，请稍后重试。';
}

function ShopSettingsDialog({
  open,
  onClose,
  initialModule = 'ozon',
  shops,
  activeShopId,
  onSelect,
  onAdd,
  onRemove,
  onChange,
  onSave,
  onRenewLicense,
  onTest,
  onGetLicenseExpiration,
  onConfirmPurchaseBinding,
  onResetPurchaseBinding,
  accountRemovalBusy = false,
  deferInitialRender = false,
}) {
  const activeShop = React.useMemo(
    () => shops.find((shop) => shop.id === activeShopId) ?? shops[0] ?? EMPTY_SHOP,
    [activeShopId, shops],
  );
  const initialSettingsModule = settingsModuleTabs.some((module) => module.id === initialModule)
    ? initialModule
    : 'ozon';
  const [activeSettingsModule, setActiveSettingsModule] = React.useState(initialSettingsModule);
  const [moduleActionNote, setModuleActionNote] =
    React.useState('点击上方设置分区后，会在这里显示对应的本地配置入口。');
  const [moduleSaveRequestId, setModuleSaveRequestId] = React.useState(0);
  const [apiKeyEditing, setApiKeyEditing] = React.useState(false);
  const [renewalCardOpen, setRenewalCardOpen] = React.useState(false);
  const [renewalCardKey, setRenewalCardKey] = React.useState('');
  const [renewalCardError, setRenewalCardError] = React.useState('');
  const [renewalCardBusy, setRenewalCardBusy] = React.useState(false);
  const [shopSaveError, setShopSaveError] = React.useState('');
  const [shopSaveBusy, setShopSaveBusy] = React.useState(false);
  const [licenseExpiration, setLicenseExpiration] = React.useState({
    status: 'idle',
    expireAt: '',
  });
  const [addCardOpen, setAddCardOpen] = React.useState(false);
  const [addCardKey, setAddCardKey] = React.useState('');
  const [addShopError, setAddShopError] = React.useState('');
  const [addShopBusy, setAddShopBusy] = React.useState(false);
  const [renderStage, setRenderStage] = React.useState(() => (deferInitialRender ? 0 : 3));
  const dialogRef = React.useRef(null);
  const dialogContentRef = React.useRef(null);
  const addCardDialogRef = React.useRef(null);
  const settingsDialogTask = useMinimizableDialogTask({
    open,
    kind: 'settings-dialog',
    title: '店铺管理',
    subtitle: activeShop?.shopAlias || activeShop?.sellerName || '',
    closeDisabled: typeof onClose !== 'function',
    onClose: () => onClose?.(undefined, 'taskClose'),
  });
  const visibleOpen = settingsDialogTask.visibleOpen;

  React.useLayoutEffect(() => {
    if (globalThis.__wangzaiRendererTreeTelemetryEnabled && globalThis.performance?.mark) {
      globalThis.performance.mark(`wangzai-settings-dialog-stage:${renderStage}`);
    }
  }, [renderStage]);

  React.useLayoutEffect(() => {
    if (open && deferInitialRender && renderStage < 2) {
      // The list is control-critical and must be present on the first visible
      // paint. Background Electron windows may pause requestAnimationFrame.
      setRenderStage(2);
    }
  }, [deferInitialRender, open, renderStage]);
  const activeClientId = activeShop?.clientId ?? '';
  const activeApiKey = activeShop?.apiKey ?? '';
  const hasStoredClientId = Boolean(activeShop?.hasClientId || String(activeClientId).trim());
  const hasStoredApiKey = Boolean(activeShop?.hasApiKey || String(activeApiKey).trim());
  const activeApiKeyInputValue = apiKeyEditing
    ? activeApiKey
    : hasStoredApiKey
      ? SAVED_CREDENTIAL_MASK
      : '';
  const canTest = Boolean(activeShop?.id && hasStoredClientId && hasStoredApiKey);
  const connectionColor =
    activeShop?.connectionStatus === '连接成功'
      ? 'success'
      : activeShop?.connectionStatus === '缺少信息' || activeShop?.connectionStatus === '测试中'
        ? 'warning'
        : activeShop?.connectionStatus === '连接失败' || activeShop?.connectionStatus === '浏览器拦截'
          ? 'error'
          : 'default';
  const purchaseManagementStartedAtText = formatShopBindingTime(activeShop?.purchaseManagementStartedAt);
  const licenseLookupShop = React.useMemo(() => ({
    id: activeShop?.id || '',
    clientId: activeShop?.clientId || '',
    client_id: activeShop?.client_id || '',
  }), [activeShop?.clientId, activeShop?.client_id, activeShop?.id]);
  const licenseRequestIdRef = React.useRef(0);
  const refreshLicenseExpiration = React.useCallback(async () => {
    const requestId = licenseRequestIdRef.current + 1;
    licenseRequestIdRef.current = requestId;
    if (typeof onGetLicenseExpiration !== 'function' || !licenseLookupShop.id) {
      setLicenseExpiration({ status: 'unavailable', expireAt: '' });
      return null;
    }
    setLicenseExpiration({ status: 'loading', expireAt: '' });
    try {
      const result = await onGetLicenseExpiration(licenseLookupShop);
      if (licenseRequestIdRef.current !== requestId) return result;
      setLicenseExpiration({
        status: result?.expireAt ? 'ready' : 'missing',
        expireAt: result?.expireAt || '',
      });
      return result;
    } catch {
      if (licenseRequestIdRef.current === requestId) {
        setLicenseExpiration({ status: 'error', expireAt: '' });
      }
      return null;
    }
  }, [licenseLookupShop, onGetLicenseExpiration]);
  const licenseExpirationText = licenseExpiration.status === 'loading'
    ? '正在读取…'
    : formatShopBindingTime(licenseExpiration.expireAt, '暂未获取');

  React.useEffect(() => {
    if (!open) return undefined;
    void refreshLicenseExpiration();
    return () => {
      licenseRequestIdRef.current += 1;
    };
  }, [open, refreshLicenseExpiration]);

  React.useEffect(() => {
    if (!open) return;
    const nextModule = settingsModuleTabs.some((module) => module.id === initialModule) ? initialModule : 'ozon';
    const selected = settingsModuleTabs.find((module) => module.id === nextModule);
    setActiveSettingsModule(nextModule);
    setModuleActionNote(
      nextModule === 'ozon'
        ? '已打开 Ozon 店铺配置，可以继续保存或测试连接。'
        : nextModule === 'platformApi'
          ? '已打开「外部接口」，先选择需要接入的数据服务。'
          : nextModule === 'dataMaintenance'
            ? '已打开数据维护，只检查本机归属和预览，不会调用 Ozon。'
          : `已打开「${selected?.label ?? '设置'}」，先补这里需要的配置。`
    );
  }, [initialModule, open]);

  React.useEffect(() => {
    if (open) {
      setApiKeyEditing(false);
      setRenewalCardOpen(false);
      setRenewalCardKey('');
      setRenewalCardError('');
      setRenewalCardBusy(false);
      setShopSaveError('');
      setShopSaveBusy(false);
      setAddCardOpen(false);
      setAddCardKey('');
      setAddShopError('');
      setAddShopBusy(false);
    }
  }, [activeShop?.id, open]);

  React.useEffect(() => {
    if (!open || !deferInitialRender || renderStage >= 3) return undefined;
    const timerId = globalThis.setTimeout(() => {
      setRenderStage((current) => Math.min(3, current + 1));
    }, 0);
    return () => globalThis.clearTimeout(timerId);
  }, [deferInitialRender, open, renderStage]);

  React.useEffect(() => {
    if (!visibleOpen || typeof document === 'undefined') return undefined;
    const dialogNode = dialogRef.current;
    const previousFocus = document.activeElement;
    const focusTimer = addCardOpen || renewalCardOpen
      ? null
      : globalThis.setTimeout(() => dialogNode?.focus(), 0);
    const handleKeyDown = (event) => {
      if (dialogNode?.closest('[data-settings-open]')?.dataset.settingsOpen !== 'true') return;
      if (addCardOpen || renewalCardOpen) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose?.(event, 'escapeKeyDown');
        return;
      }
      if (event.key !== 'Tab' || !dialogNode) return;
      const focusable = [...dialogNode.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )].filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        dialogNode.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      if (focusTimer !== null) globalThis.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
      const restoreFocus = () => {
        const settingsRoot = dialogNode?.closest('[data-settings-open]');
        if (settingsRoot?.dataset.settingsOpen === 'true') return;
        if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
          previousFocus.focus({ preventScroll: true });
        }
      };
      if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(restoreFocus);
      else globalThis.setTimeout(restoreFocus, 0);
    };
  }, [addCardOpen, onClose, renewalCardOpen, visibleOpen]);

  React.useEffect(() => {
    if (!visibleOpen || !addCardOpen || typeof document === 'undefined') return undefined;
    const gateNode = addCardDialogRef.current;
    const previousFocus = document.activeElement;
    const focusTimer = globalThis.setTimeout(() => {
      gateNode?.querySelector('input:not([disabled])')?.focus();
    }, 0);
    const handleGateKeyDown = (event) => {
      if (event.key === 'Escape' && !addShopBusy) {
        event.preventDefault();
        setAddCardOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !gateNode) return;
      const focusable = [...gateNode.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )].filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        gateNode.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleGateKeyDown);
    return () => {
      globalThis.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleGateKeyDown);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [addCardOpen, addShopBusy, visibleOpen]);

  const handleSelectSettingsModule = React.useCallback((moduleId) => {
    if (moduleId === activeSettingsModule) return;
    if (dialogContentRef.current) dialogContentRef.current.scrollTop = 0;
    const selected = settingsModuleTabs.find((module) => module.id === moduleId);
    setActiveSettingsModule(moduleId);
    setModuleActionNote(
      moduleId === 'ozon'
        ? '已切回 Ozon 店铺配置，可以继续保存或测试连接。'
        : moduleId === 'platformApi'
          ? '已打开「外部接口」分区；固定规则由系统带出，密钥只允许交给 local-api 加密保存。'
          : moduleId === 'dataMaintenance'
            ? '已打开数据维护：先读取归属预览，只有明确确认后才会处理安全项。'
          : `已打开「${selected?.label ?? '设置'}」分区，当前只做本地配置入口，不调用真实接口。`
    );
  }, [activeSettingsModule]);

  React.useLayoutEffect(() => {
    if (!visibleOpen || !dialogContentRef.current) return;
    dialogContentRef.current.scrollTop = 0;
  }, [activeSettingsModule, visibleOpen]);

  const handleModuleAction = React.useCallback((action) => {
    const selected = settingsModuleTabs.find((module) => module.id === activeSettingsModule);
    setModuleActionNote(
      activeSettingsModule === 'platformApi'
        ? `${selected?.label ?? '当前分区'}：已点击「${action}」。连接测试只读取接口状态，不执行写入。`
        : `${selected?.label ?? '当前分区'}：已点击「${action}」。这里先作为本地交互入口，不调用真实接口。`
    );
  }, [activeSettingsModule]);

  const handleModuleSave = React.useCallback(() => {
    setModuleSaveRequestId((current) => current + 1);
    setModuleActionNote(`${settingsModuleTabs.find((module) => module.id === activeSettingsModule)?.label || '当前分区'}：正在保存当前页面设定。`);
  }, [activeSettingsModule]);

  const handleSave = React.useCallback(async () => {
    setShopSaveBusy(true);
    setShopSaveError('');
    try {
      await onSave?.();
      await refreshLicenseExpiration();
      setApiKeyEditing(false);
    } catch (saveError) {
      setShopSaveError(shopCardErrorMessage(saveError));
    } finally {
      setShopSaveBusy(false);
    }
  }, [onSave, refreshLicenseExpiration]);

  const handleOpenRenewalCard = React.useCallback(() => {
    setRenewalCardKey('');
    setRenewalCardError('');
    setRenewalCardOpen(true);
  }, []);

  const handleCloseRenewalCard = React.useCallback(() => {
    if (renewalCardBusy) return;
    setRenewalCardOpen(false);
    setRenewalCardKey('');
    setRenewalCardError('');
  }, [renewalCardBusy]);

  const handleRenewShopLicense = React.useCallback(async () => {
    const normalizedCard = renewalCardKey.trim().toUpperCase();
    if (!SHOP_CARD_PATTERN.test(normalizedCard)) {
      setRenewalCardError('请输入管理系统发放的 16 位月卡或年卡卡密。');
      return;
    }
    setRenewalCardBusy(true);
    setRenewalCardError('');
    try {
      if (typeof onRenewLicense !== 'function') throw new Error('续费服务暂不可用，请稍后重试。');
      const renewalResult = await onRenewLicense({ cardKey: normalizedCard, shopId: activeShop.id });
      const refreshed = await refreshLicenseExpiration();
      if (!refreshed?.expireAt && renewalResult?.expireAt) {
        setLicenseExpiration({ status: 'ready', expireAt: renewalResult.expireAt });
      }
      setRenewalCardOpen(false);
      setRenewalCardKey('');
    } catch (renewalError) {
      setRenewalCardError(shopCardErrorMessage(renewalError));
    } finally {
      setRenewalCardBusy(false);
    }
  }, [activeShop.id, onRenewLicense, refreshLicenseExpiration, renewalCardKey]);

  const handleBeginAdd = React.useCallback(async () => {
    setAddShopBusy(true);
    setAddShopError('');
    setShopSaveError('');
    try {
      await onAdd?.({ cardKey: '' });
    } catch (addError) {
      if (addError?.code === 'ADDITIONAL_SHOP_CARD_REQUIRED') {
        setAddCardKey('');
        setAddCardOpen(true);
      } else {
        setShopSaveError(shopCardErrorMessage(addError));
      }
    } finally {
      setAddShopBusy(false);
    }
  }, [onAdd]);

  const handleActivateAdditionalShop = React.useCallback(async () => {
    const normalizedCard = addCardKey.trim().toUpperCase();
    if (!SHOP_CARD_PATTERN.test(normalizedCard)) {
      setAddShopError('请输入管理系统发放的 16 位月卡或年卡卡密。');
      return;
    }
    setAddShopBusy(true);
    setAddShopError('');
    try {
      await onAdd?.({ cardKey: normalizedCard });
      setAddCardOpen(false);
      setAddCardKey('');
    } catch (addError) {
      setAddShopError(shopCardErrorMessage(addError));
    } finally {
      setAddShopBusy(false);
    }
  }, [addCardKey, onAdd]);

  const handleBackdropClick = (event) => {
    if (event.target === event.currentTarget) onClose?.(event, 'backdropClick');
  };

  const showSettingsTabs = renderStage >= 1;
  const showBodyLoading = renderStage < 2;
  const showShopMain = renderStage >= 3;
  const showSettingsActions = renderStage >= 2;
  const settingsRenderReady = renderStage >= 3;

  const dialogHeader = React.useMemo(
    () => (
      <DialogTitle className="shop-settings-title">
        <Stack direction="row" alignItems="center" spacing={1.5}>
          <Box className="shop-settings-icon">
            <SettingsRounded />
          </Box>
          <Box>
            <Typography id="shop-settings-dialog-title" variant="h6">店铺管理</Typography>
            <Typography variant="body2" color="text.secondary">
              多个 Ozon 店铺的本地配置与连接测试
            </Typography>
          </Box>
          <Stack direction="row" alignItems="center" spacing={0.25} className="shop-settings-dialog-controls">
            <Tooltip title="最小化店铺管理弹窗">
              <IconButton
                size="small"
                className="global-dialog-control global-dialog-minimize-control"
                aria-label="最小化店铺管理弹窗"
                onClick={settingsDialogTask.minimize}
              >
                <MinimizeRounded fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="关闭店铺管理弹窗">
              <IconButton
                size="small"
                className="global-dialog-control global-dialog-close-control"
                aria-label="关闭店铺管理弹窗"
                onClick={onClose}
              >
                <CloseRounded fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        </Stack>
        <PendingAccountRemovalTasks />
        {showSettingsTabs ? (
          <Box className="settings-module-tabs" role="tablist" aria-label="设置分区">
            {visibleSettingsModuleTabs.map((module) => (
              <Box
                key={module.id}
                component="button"
                type="button"
                role="tab"
                aria-selected={activeSettingsModule === module.id}
                className={`settings-module-tab${activeSettingsModule === module.id ? ' active' : ''}`}
                onClick={() => handleSelectSettingsModule(module.id)}
              >
                <Typography variant="subtitle2">{module.label}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {module.caption}
                </Typography>
              </Box>
            ))}
          </Box>
        ) : null}
      </DialogTitle>
    ),
    [activeSettingsModule, handleSelectSettingsModule, onClose, settingsDialogTask.minimize, showSettingsTabs],
  );

  const dialogBody = React.useMemo(
    () => (
      <DialogContent
        ref={dialogContentRef}
        dividers
        className={`shop-settings-content${activeSettingsModule === 'wechatAssistant' ? ' shop-settings-content--wechat-assistant' : ''}`}
      >
        {showBodyLoading ? (
          <Box role="status" aria-live="polite" sx={{ py: 4, textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">正在准备设置内容…</Typography>
          </Box>
        ) : (
          <>
            <Box
              hidden={activeSettingsModule !== 'ozon'}
              aria-hidden={activeSettingsModule !== 'ozon'}
              className="settings-ozon-panel-host"
            >
              {shopSaveError ? <Alert severity="error" sx={{ mb: 1.5 }}>{shopSaveError}</Alert> : null}
              <Box className="shop-settings-layout">
                <OzonShopListCard
                  shops={shops}
                  activeShopId={activeShop.id}
                  onSelect={onSelect}
                  onAdd={handleBeginAdd}
                  onRemove={onRemove}
                  removalBusy={accountRemovalBusy || addShopBusy}
                />
                <Box className="shop-settings-detail">
                  {showShopMain ? (
                    <OzonShopMainPanel
                      activeShop={activeShop}
                      activeClientId={activeClientId}
                      apiKeyInputValue={activeApiKeyInputValue}
                      onChange={onChange}
                      onResetPurchaseBinding={onResetPurchaseBinding}
                      onConfirmPurchaseBinding={onConfirmPurchaseBinding}
                      onRenewLicense={handleOpenRenewalCard}
                      onApiKeyEditingChange={setApiKeyEditing}
                      deferInitialRender={deferInitialRender && activeSettingsModule === 'ozon'}
                    />
                  ) : null}
                  {showShopMain ? (
                    <OzonShopSidePanel
                      activeShop={activeShop}
                      activeClientId={activeClientId}
                      hasStoredApiKey={hasStoredApiKey}
                      connectionColor={connectionColor}
                      purchaseManagementStartedAtText={purchaseManagementStartedAtText}
                      licenseExpirationText={licenseExpirationText}
                      deferInitialRender={deferInitialRender && activeSettingsModule === 'ozon'}
                    />
                  ) : null}
                </Box>
              </Box>
            </Box>
            {activeSettingsModule !== 'ozon' ? (
              <SettingsModuleContent
                activeSettingsModule={activeSettingsModule}
                actionNote={moduleActionNote}
                onAction={handleModuleAction}
                saveRequestId={moduleSaveRequestId}
                shops={shops}
              />
            ) : null}
          </>
        )}
      </DialogContent>
    ),
    [
      activeApiKeyInputValue,
      accountRemovalBusy,
      activeClientId,
      activeSettingsModule,
      activeShop,
      connectionColor,
      handleModuleAction,
      handleBeginAdd,
      handleOpenRenewalCard,
      moduleSaveRequestId,
      hasStoredApiKey,
      moduleActionNote,
      onChange,
      onConfirmPurchaseBinding,
      onRemove,
      onResetPurchaseBinding,
      onSelect,
      purchaseManagementStartedAtText,
      licenseExpirationText,
      deferInitialRender,
      showBodyLoading,
      showShopMain,
      addShopBusy,
      shopSaveError,
      shops,
      visibleOpen,
    ],
  );

  const dialogFooter = React.useMemo(
    () => (
      <DialogActions className="shop-settings-actions">
        <Button disableRipple sx={activeSettingsModule === 'wechatAssistant' ? { borderRadius: '6px !important' } : undefined} onClick={onClose}>关闭</Button>
        {showSettingsActions && activeSettingsModule === 'ozon' ? (
          <>
            <Button
              variant="outlined"
              disabled={!canTest || activeShop.connectionStatus === '测试中'}
              startIcon={<CloudSyncRounded />}
              onClick={onTest}
            >
              {activeShop.connectionStatus === '测试中' ? '测试中' : '测试连接'}
            </Button>
            <Button variant="contained" onClick={handleSave} disabled={shopSaveBusy}>
              {shopSaveBusy ? '保存中…' : '保存'}
            </Button>
          </>
        ) : !showSettingsActions || activeSettingsModule === 'dataMaintenance' ? null : (
          <Button variant="contained" sx={activeSettingsModule === 'wechatAssistant' ? { borderRadius: '6px !important' } : undefined} onClick={handleModuleSave}>
            保存
          </Button>
        )}
      </DialogActions>
    ),
    [activeSettingsModule, activeShop.connectionStatus, canTest, handleModuleSave, handleSave, onClose, onTest, shopSaveBusy, showSettingsActions],
  );

  const dialogSurface = React.useMemo(
    () => (
      <section
        ref={dialogRef}
        className="shop-settings-dialog-paper MuiDialog-paper"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shop-settings-dialog-title"
        tabIndex={-1}
        data-settings-render-ready={settingsRenderReady ? 'true' : 'false'}
        data-settings-render-stage={renderStage}
      >
      {dialogHeader}
      {dialogBody}
      {dialogFooter}
      </section>
    ),
    [dialogBody, dialogFooter, dialogHeader, renderStage, settingsRenderReady],
  );

  return (
    <div
      className="shop-settings-modal shop-settings-backdrop"
      onMouseDown={handleBackdropClick}
      role="presentation"
      data-settings-open={visibleOpen ? 'true' : 'false'}
      aria-hidden={!visibleOpen}
    >
      {dialogSurface}
      <ShopLicenseRenewalDialog
        open={renewalCardOpen}
        shopName={activeShop.shopAlias || activeShop.sellerName}
        clientId={activeClientId || (activeShop.hasClientId ? '已加密保存' : '')}
        expirationText={licenseExpirationText}
        licenseStatus={licenseExpiration.status}
        cardKey={renewalCardKey}
        error={renewalCardError}
        busy={renewalCardBusy}
        onCardKeyChange={(value) => {
          setRenewalCardKey(value);
          if (renewalCardError) setRenewalCardError('');
        }}
        onCancel={handleCloseRenewalCard}
        onSubmit={handleRenewShopLicense}
      />
      {addCardOpen ? (
        <div className="shop-card-gate-backdrop" role="presentation">
          <section
            ref={addCardDialogRef}
            className="shop-card-gate-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="additional-shop-card-title"
            tabIndex={-1}
          >
            <DialogTitle id="additional-shop-card-title">先激活新增店铺卡密</DialogTitle>
            <DialogContent dividers>
              <Stack spacing={2}>
                {addShopError ? <Alert severity="error">{addShopError}</Alert> : null}
                <TextField
                  label="新增店铺卡密"
                  value={addCardKey}
                  onChange={(event) => setAddCardKey(
                    event.target.value.toUpperCase().replace(/[^A-Z0-9-]/gu, '').slice(0, 19),
                  )}
                  placeholder="AAAA-BBBB-CCCC-DDDD"
                  autoComplete="off"
                  disabled={addShopBusy}
                  fullWidth
                />
              </Stack>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setAddCardOpen(false)} disabled={addShopBusy}>取消</Button>
              <Button variant="contained" onClick={handleActivateAdditionalShop} disabled={addShopBusy}>
                {addShopBusy ? '验证中…' : '验证卡密并新增'}
              </Button>
            </DialogActions>
          </section>
        </div>
      ) : null}
    </div>
  );
}

export { ShopSettingsDialog };
export default ShopSettingsDialog;
