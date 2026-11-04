import { saveCrossBorderAccountToLocalApi } from '../../entities/order/crossBorderOrderApi.jsx';
import {
  getCrossBorderLocalApiAccountId,
  hasServerCrossBorderAuthorization,
} from '../../entities/order/crossBorderAuthRules.jsx';
import {
  listIntegrationProfiles,
  listPerformanceAccounts,
  listPurchaseAccounts,
  getLocalShops,
  saveIntegrationProfile,
  savePerformanceAccount,
  savePurchaseAccount,
  testPerformanceAccount,
  testPlatformIntegration,
} from '../../api/localApiClient.js';
import {
  authorizeCrossBorderAccountThroughServer,
  readCrossBorderAccountThroughServer,
  readCrossBorderAccounts,
  revokeAndDeleteCrossBorderAccountThroughServer,
  toCrossBorderPublicSettings,
} from '../../services/crossBorderAccountClient';
import { getLicenseRuntime } from '../licensing/services/licenseCenterClient.js';
import { CROSS_BORDER_MAIN_ACCOUNT_ID } from '../../shared/config/appConfigCore.jsx';
import {
  getPurchaseAccountPresetByAlias,
  getPurchaseAccountPresetByPlatform,
  resolvePurchaseAccountPreset,
} from '../../shared/config/purchaseAccountPresets.js';
import {
  selectCredentialMaskOnFocus,
  toCredentialMaskValue,
  toStoredCredentialValue,
} from './lib/credentialMask.js';
import {
  completeOzonShopSellerLogin,
  isOzonShopSellerLoginConnected,
} from './services/ozonShopSellerLoginService.js';
import {
  hydrateCrossBorderSettingsFromLocalApi,
  normalizeCrossBorderServices,
  normalizeCrossBorderWarehouses,
  readSavedCrossBorderSettings,
  releaseCrossBorderSettingsWriteFence,
  saveCrossBorderSettings,
} from '../../shared/ozon/ozonRuntime.jsx';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { AccountRemovalPreviewDialog } from './accountRemoval/components/AccountRemovalPreviewDialog.jsx';
import { OzonBrowserLoginPanel } from './components/OzonBrowserLoginPanel.jsx';
import { useAccountRemovalFlow } from './accountRemoval/model/useAccountRemovalFlow.js';
import { useAccountRemovalCompletionView } from './accountRemoval/model/useAccountRemovalCompletionView.js';
import { usePurchaseAccountLogin } from './model/usePurchaseAccountLogin.js';
import { PurchaseAccountLoginActions } from './ui/PurchaseAccountLoginActions.jsx';
import { STABLE_SELECT_MENU_PROPS } from './ui/stableSelectMenuProps.js';
import {
  cloneStructuredRecord,
  getStructuredFieldIds,
  getStructuredRecordCountLabel,
  buildStructuredEmptyValues,
  getDefaultStructuredRecordTitle,
  createBlankStructuredRecord,
  normalizeStructuredRecord,
  toPurchaseAccountSavePayload,
  toPurchaseStructuredRecord,
  buildPurchaseStructuredRecords,
  buildStructuredProfileItems,
} from './lib/structuredSettingsRecords.js';
import {
  getPlatformIntegrationPreset,
  createBlankPlatformApiRecord,
  getPlatformIntegrationType,
  isRetiredPlatformIntegration,
  isPlatformSaveAction,
  buildPlatformApiProfileItems,
  getPlatformApiErrorMessage,
} from './lib/platformIntegrationRecords.js';
import {
  reconcilePlatformApiSourceRecords,
  toIntegrationProfileSavePayload,
  toIntegrationStructuredRecord,
} from './lib/integrationProfileRecords.js';















function readStructuredRecords(config) {
  // Platform interface records are canonical local-api data. The entries in
  // appConfigRuntime are documentation/default presets only; treating them as
  // saved rows makes a deleted platform reappear after every restart.
  if (config.id === 'platformApi') return [createBlankPlatformApiRecord(config, 1, { placeholder: true })];
  const records = Array.isArray(config.records) && config.records.length > 0 ? config.records : [];
  return records.length
    ? records.map((record, index) => normalizeStructuredRecord(config, record, index))
    : [createBlankStructuredRecord(config, 1)];
}



































function buildCrossBorderDisplayRecord(config, settings) {
  const record = cloneStructuredRecord(config.records?.[0] ?? {});
  const accountId = String(
    settings?.crossBorderAccountId || settings?.id || record.id || '',
  ).trim();
  const hasServerAuthorization = Boolean(
    settings?.hasServerAuthorization || settings?.authorizationRef,
  );
  return {
    ...record,
    id: accountId,
    title: settings?.accountAlias || record.title || '跨境巴士授权',
    meta: hasServerAuthorization ? '服务器授权可用' : '等待服务器授权',
    status: hasServerAuthorization ? '服务器已授权' : '待授权',
    statusColor: hasServerAuthorization ? 'success' : 'default',
    crossBorderSettings: { ...(settings || {}), crossBorderAccountId: accountId },
  };
}

function createCrossBorderDraftSettings(index = 1) {
  const id = `cross-border-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${index}`}`;
  return {
    crossBorderAccountId: id,
    accountAlias: `跨境巴士授权 ${index}`,
    status: 'inactive',
    userName: '',
    password: '',
    shopIds: [],
    warehouseOptions: [],
    serviceOptions: [],
    cooperationWarehouse: '',
    packageService: '',
    authorizationRef: '',
    authorizationExpiresAt: '',
    hasServerAuthorization: false,
    accountSaved: false,
    connectionStatus: '待授权',
    connectionMessage: '请填写账号和密码完成一次性服务器授权。',
  };
}

function StructuredSettingsLayout({
  config,
  actionNote,
  onAction,
  saveRequestId = 0,
  shops = [],
}) {
  const accountRemoval = useAccountRemovalFlow();
  const isCrossBorder = config.id === 'crossBorderBus';
  const isPlatformApi = config.id === 'platformApi';
  const isPurchaseAccount = config.id === 'purchaseAccount';
  const initialStructuredRecordsRef = React.useRef(null);
  if (initialStructuredRecordsRef.current === null) {
    initialStructuredRecordsRef.current = readStructuredRecords(config);
  }
  const [localRecords, setLocalRecords] = React.useState(() => initialStructuredRecordsRef.current);
  const [selectedRecordId, setSelectedRecordId] = React.useState(
    () => initialStructuredRecordsRef.current[0]?.id ?? ''
  );
  const [crossBorderSettings, setCrossBorderSettings] = React.useState(() =>
    readSavedCrossBorderSettings(config.records[0]?.values ?? {})
  );
  const [crossBorderWarehouseOptions, setCrossBorderWarehouseOptions] = React.useState(() => {
    const saved = readSavedCrossBorderSettings(config.records[0]?.values ?? {});
    return Array.isArray(saved.warehouseOptions) ? saved.warehouseOptions : [];
  });
  const [crossBorderServiceOptions, setCrossBorderServiceOptions] = React.useState(() => {
    const saved = readSavedCrossBorderSettings(config.records[0]?.values ?? {});
    return Array.isArray(saved.serviceOptions) ? saved.serviceOptions : [];
  });
  const [crossBorderShopOptions, setCrossBorderShopOptions] = React.useState([]);
  const [crossBorderStatus, setCrossBorderStatus] = React.useState('');
  const [crossBorderLoading, setCrossBorderLoading] = React.useState(false);
  const [crossBorderLoadingAction, setCrossBorderLoadingAction] = React.useState('');
  const [isThinClientV2, setIsThinClientV2] = React.useState(false);
  const crossBorderRequestRef = React.useRef(0);
  const crossBorderWarehouseRefreshRef = React.useRef(null);

  React.useEffect(() => {
    if (!isCrossBorder) return undefined;
    let active = true;
    void getLicenseRuntime()
      .then((runtime) => {
        if (active) setIsThinClientV2(runtime?.thinClient === true);
      })
      .catch(() => {
        if (active) setIsThinClientV2(false);
      });
    return () => { active = false; };
  }, [isCrossBorder]);
  const [platformApiStatus, setPlatformApiStatus] = React.useState('');
  const [platformApiLoading, setPlatformApiLoading] = React.useState(false);
  const [platformApiReadPending, setPlatformApiReadPending] = React.useState(isPlatformApi);
  const [purchaseAccountStatus, setPurchaseAccountStatus] = React.useState('');
  const [purchaseAccountLoading, setPurchaseAccountLoading] = React.useState(false);
  const purchasePersistedIdsRef = React.useRef(new Set());
  const performancePersistedIdsRef = React.useRef(new Set());
  const integrationProfilePersistedIdsRef = React.useRef(new Set());
  const platformApiSourceSnapshotRef = React.useRef({
    profiles: null,
    performanceAccounts: null,
  });
  const activeStructuredConfigIdRef = React.useRef(config.id);
  const platformApiLoadGenerationRef = React.useRef(0);
  useAccountRemovalCompletionView({
    rows: localRecords,
    ownerTypes: isCrossBorder ? ['cross_border_bus'] : isPurchaseAccount ? ['purchase_account'] : isPlatformApi ? ['promotion_account', 'integration_profile'] : [],
    apply: (filter, event) => setLocalRecords(current => {
      const remaining = filter(current);
      if (remaining === current) return current;
      const { ownerType, ownerId } = event.owner;
      if (isPlatformApi) {
        const removedIds = ownerType === 'promotion_account' ? performancePersistedIdsRef.current : integrationProfilePersistedIdsRef.current;
        const retainedIds = ownerType === 'promotion_account' ? integrationProfilePersistedIdsRef.current : performancePersistedIdsRef.current;
        if (!removedIds.has(ownerId)) return current;
        removedIds.delete(ownerId);
        const field = ownerType === 'promotion_account' ? 'performanceAccounts' : 'profiles';
        const source = platformApiSourceSnapshotRef.current;
        platformApiSourceSnapshotRef.current = { ...source, [field]: Array.isArray(source[field]) ? source[field].filter(item => item.id !== ownerId) : source[field] };
        if (retainedIds.has(ownerId)) return current;
      } else if (isPurchaseAccount) {
        if (!purchasePersistedIdsRef.current.has(ownerId)) return current;
        purchasePersistedIdsRef.current.delete(ownerId);
      }
      const replacement = isCrossBorder ? createCrossBorderDraftSettings(1) : null;
      const records = remaining.length ? remaining : [isCrossBorder ? buildCrossBorderDisplayRecord(config, replacement)
        : isPlatformApi ? createBlankPlatformApiRecord(config, 1, { placeholder: true }) : createBlankStructuredRecord(config, 1)];
      setSelectedRecordId(currentId => currentId === ownerId ? records[0].id : currentId);
      if (isCrossBorder) setCrossBorderSettings(currentSettings => getCrossBorderLocalApiAccountId(currentSettings) === ownerId
        ? records[0].crossBorderSettings || replacement : currentSettings);
      return records;
    }),
  });

  React.useEffect(() => {
    let ignore = false;
    const platformApiLoadGeneration = platformApiLoadGenerationRef.current + 1;
    platformApiLoadGenerationRef.current = platformApiLoadGeneration;
    const retryTimers = new Set();
    const isCurrentPlatformApiLoad = () => (
      !ignore
      && config.id === 'platformApi'
      && platformApiLoadGenerationRef.current === platformApiLoadGeneration
    );
    const configChanged = activeStructuredConfigIdRef.current !== config.id;
    activeStructuredConfigIdRef.current = config.id;
    const nextRecords = readStructuredRecords(config);
    if (configChanged) {
      setLocalRecords(nextRecords);
      setSelectedRecordId(nextRecords[0]?.id ?? '');
    }
    if (config.id === 'crossBorderBus') {
      const hydrateRequestId = crossBorderRequestRef.current + 1;
      crossBorderRequestRef.current = hydrateRequestId;
      const isCurrentCrossBorderHydration = () => (
        !ignore
        && config.id === 'crossBorderBus'
        && crossBorderRequestRef.current === hydrateRequestId
      );
      const saved = readSavedCrossBorderSettings(config.records[0]?.values ?? {});
      setCrossBorderSettings(saved);
      setCrossBorderWarehouseOptions(Array.isArray(saved.warehouseOptions) ? saved.warehouseOptions : []);
      setCrossBorderServiceOptions(Array.isArray(saved.serviceOptions) ? saved.serviceOptions : []);
      setCrossBorderStatus(saved.connectionMessage || '');
      setCrossBorderLoading(false);
      setCrossBorderLoadingAction('');
      setCrossBorderShopOptions([]);
      getLocalShops({ timeoutMs: 10000 })
        .then((payload) => {
          if (ignore) return;
          const shops = Array.isArray(payload?.shops)
            ? payload.shops
            : Array.isArray(payload?.rows)
              ? payload.rows
              : [];
          setCrossBorderShopOptions(shops
            .map((shop) => ({
              value: String(shop?.id || '').trim(),
              label: String(shop?.alias || shop?.name || shop?.id || '').trim(),
            }))
            .filter((option) => option.value));
        })
        .catch((error) => {
          if (ignore) return;
          const message = error instanceof Error ? error.message : String(error);
          setCrossBorderStatus(`Ozon 店铺列表读取失败：${message}`);
        });
      hydrateCrossBorderSettingsFromLocalApi(config.records[0]?.values ?? {})
        .then(async (hydrated) => {
          if (!isCurrentCrossBorderHydration()) return;
          const accountsPayload = await readCrossBorderAccounts({ timeoutMs: 10000 }).catch(() => ({ rows: [] }));
          if (!isCurrentCrossBorderHydration()) return;
          const accounts = Array.isArray(accountsPayload?.rows) ? accountsPayload.rows : [];
          const preferredId = getCrossBorderLocalApiAccountId(hydrated);
          const accountSettings = accounts.map((account) => {
            const publicSettings = toCrossBorderPublicSettings(account);
            return account.id === preferredId
              ? { ...hydrated, ...publicSettings }
              : publicSettings;
          });
          const selectedSettings = accountSettings.find(
            (settings) => getCrossBorderLocalApiAccountId(settings) === preferredId,
          ) || accountSettings.find((settings) => settings.status === 'active')
            || accountSettings[0]
            || createCrossBorderDraftSettings(1);
          const records = (accountSettings.length ? accountSettings : [selectedSettings])
            .map((settings) => buildCrossBorderDisplayRecord(config, settings));
          if (!isCurrentCrossBorderHydration()) return;
          setLocalRecords(records);
          setSelectedRecordId(getCrossBorderLocalApiAccountId(selectedSettings));
          setCrossBorderSettings(selectedSettings);
          setCrossBorderWarehouseOptions(
            Array.isArray(selectedSettings.warehouseOptions) ? selectedSettings.warehouseOptions : [],
          );
          setCrossBorderServiceOptions(
            Array.isArray(selectedSettings.serviceOptions) ? selectedSettings.serviceOptions : [],
          );
          setCrossBorderStatus(selectedSettings.connectionMessage || '');
          if (hasServerCrossBorderAuthorization(selectedSettings)) {
            const requestId = crossBorderRequestRef.current + 1;
            crossBorderRequestRef.current = requestId;
            const isCurrentCrossBorderRequest = () =>
              crossBorderRequestRef.current === requestId && config.id === 'crossBorderBus';
            setCrossBorderStatus('正在后台读取最新合作仓库...');
            crossBorderWarehouseRefreshRef
              .current?.(selectedSettings, {
                isCurrent: isCurrentCrossBorderRequest,
              })
              .catch((error) => {
                if (!isCurrentCrossBorderRequest()) return;
                const message = error instanceof Error ? error.message : String(error);
                setCrossBorderStatus(`最新合作仓库读取失败，已保留本地缓存：${message}`);
              });
          }
        })
        .catch(() => undefined);
    }
    if (config.id === 'platformApi') {
      setPlatformApiStatus('');
      setPlatformApiLoading(false);
      setPlatformApiReadPending(true);
      const waitBeforeRetry = () => new Promise((resolve) => {
        const timer = window.setTimeout(() => {
          retryTimers.delete(timer);
          resolve();
        }, 500);
        retryTimers.add(timer);
      });
      const readSourceWithRetry = async (readSource) => {
        try {
          return await readSource();
        } catch (firstError) {
          if (!isCurrentPlatformApiLoad()) throw firstError;
          await waitBeforeRetry();
          if (!isCurrentPlatformApiLoad()) throw firstError;
          return readSource();
        }
      };
      const profileRequest = readSourceWithRetry(() => listIntegrationProfiles({ timeoutMs: 10000 }));
      const performanceRequest = readSourceWithRetry(() => listPerformanceAccounts({ timeoutMs: 10000 }));

      const applyPlatformApiSourceSnapshots = () => {
        if (!isCurrentPlatformApiLoad()) return;
        const snapshots = platformApiSourceSnapshotRef.current;
        const profiles = Array.isArray(snapshots.profiles) ? snapshots.profiles : [];
        const performanceAccounts = Array.isArray(snapshots.performanceAccounts)
          ? snapshots.performanceAccounts
          : [];
        const previousProfileIds = integrationProfilePersistedIdsRef.current;
        const previousPerformanceIds = performancePersistedIdsRef.current;
        const nextProfileIds = new Set(profiles.map((profile) => profile?.id).filter(Boolean));
        const nextPerformanceIds = new Set(
          performanceAccounts.map((account) => account?.id).filter(Boolean)
        );
        setLocalRecords((currentRecords) => reconcilePlatformApiSourceRecords(config, currentRecords, {
          profiles,
          performanceAccounts,
          previousProfileIds,
          previousPerformanceIds,
        }));
        integrationProfilePersistedIdsRef.current = nextProfileIds;
        performancePersistedIdsRef.current = nextPerformanceIds;
      };

      profileRequest.then((payload) => {
        if (!isCurrentPlatformApiLoad()) return;
        const profiles = Array.isArray(payload?.profiles) ? payload.profiles : payload?.rows || [];
        if (profiles.length > 0) setPlatformApiReadPending(false);
        platformApiSourceSnapshotRef.current = {
          ...platformApiSourceSnapshotRef.current,
          profiles,
        };
        applyPlatformApiSourceSnapshots();
      }).catch(() => undefined);

      performanceRequest.then((payload) => {
        if (!isCurrentPlatformApiLoad()) return;
        const performanceAccounts = Array.isArray(payload?.accounts) ? payload.accounts : payload?.rows || [];
        if (performanceAccounts.length > 0) setPlatformApiReadPending(false);
        platformApiSourceSnapshotRef.current = {
          ...platformApiSourceSnapshotRef.current,
          performanceAccounts,
        };
        applyPlatformApiSourceSnapshots();
      }).catch(() => undefined);

      Promise.allSettled([profileRequest, performanceRequest]).then(([profileResult, performanceResult]) => {
        if (!isCurrentPlatformApiLoad()) return;
        const failures = [];
        if (profileResult.status === 'rejected') {
          failures.push(`平台接口：${getPlatformApiErrorMessage(profileResult.reason)}`);
        }
        if (performanceResult.status === 'rejected') {
          failures.push(`Performance：${getPlatformApiErrorMessage(performanceResult.reason)}`);
        }
        setPlatformApiReadPending(false);
        setPlatformApiStatus(failures.length > 0 ? `部分账号读取失败，已保留上次数据。${failures.join('；')}` : '');
      });
    } else {
      setPlatformApiReadPending(false);
    }
    if (config.id === 'purchaseAccount') {
      setPurchaseAccountStatus('');
      setPurchaseAccountLoading(false);
      listPurchaseAccounts({ timeoutMs: 10000 })
        .then((payload) => {
          if (ignore) return;
          const accounts = Array.isArray(payload?.accounts) ? payload.accounts : payload?.rows || [];
          purchasePersistedIdsRef.current = new Set(accounts.map((account) => account.id));
          const savedRecords = buildPurchaseStructuredRecords(config, accounts);
          const resolvedRecords = savedRecords.length > 0 ? savedRecords : nextRecords;
          setLocalRecords(resolvedRecords);
          setSelectedRecordId(resolvedRecords[0]?.id ?? '');
        })
        .catch((error) => {
          if (ignore) return;
          const message = error instanceof Error ? error.message : String(error);
          setPurchaseAccountStatus(`本地账号服务不可用：${message}`);
        });
    }
    return () => {
      ignore = true;
      retryTimers.forEach((timer) => window.clearTimeout(timer));
      retryTimers.clear();
    };
  }, [config]);

  React.useEffect(() => {
    if (!isPlatformApi || localRecords.some((record) => record.id === selectedRecordId)) return;
    const nextRecord = localRecords.find((record) => record?.isPlaceholderDraft !== true) ?? localRecords[0];
    setSelectedRecordId(nextRecord?.id ?? '');
  }, [isPlatformApi, localRecords, selectedRecordId]);

  React.useEffect(() => {
    if (!crossBorderLoading) return undefined;
    const timer = window.setTimeout(() => {
      setCrossBorderLoading(false);
      setCrossBorderLoadingAction('');
      setCrossBorderStatus('请求已超时，请重新点击');
    }, 20000);
    return () => window.clearTimeout(timer);
  }, [crossBorderLoading]);

  const displayRecords = localRecords;
  const visibleDisplayRecords = isPlatformApi
    ? displayRecords.filter((record) => (
      record?.isPlaceholderDraft !== true && !isRetiredPlatformIntegration(record, config)
    ))
    : displayRecords;
  const selectedRecord =
    visibleDisplayRecords.find((record) => record.id === selectedRecordId) ??
    localRecords.find((record) => (
      record.id === selectedRecordId
      && (!isPlatformApi || !isRetiredPlatformIntegration(record, config))
    )) ??
    (isPlatformApi ? localRecords.find((record) => record?.isTransientDraft === true) : null) ??
    visibleDisplayRecords[0] ??
    (isPlatformApi ? createBlankPlatformApiRecord(config, 1) : createBlankStructuredRecord(config, 1));
  const handlePurchaseLoginSaved = React.useCallback((account) => {
    if (!account?.id) return;
    purchasePersistedIdsRef.current.add(account.id);
    setLocalRecords((currentRecords) => currentRecords.map((record, index) => (
      record.id === account.id ? toPurchaseStructuredRecord(config, account, index) : record
    )));
    setPurchaseAccountStatus('登录信息和 Cookie 已保存，独立登录窗口已自动关闭。');
  }, [config]);
  const purchaseBrowserLogin = usePurchaseAccountLogin({
    enabled: isPurchaseAccount && purchasePersistedIdsRef.current.has(selectedRecord.id),
    connected: isPurchaseAccount && selectedRecord.values?.cookieStatus === 'Cookie 已保存',
    accountId: isPurchaseAccount ? selectedRecord.id : '',
    accountLabel: isPurchaseAccount ? selectedRecord.title : '',
    platformName: isPurchaseAccount ? selectedRecord.values?.platformName : '',
    platformUrl: isPurchaseAccount ? selectedRecord.values?.platformUrl : '',
    onLoginSaved: handlePurchaseLoginSaved,
  });
  const getVisibleStructuredFieldValue = (fieldId) => {
    if (isCrossBorder) return crossBorderSettings[fieldId] ?? '';
    return selectedRecord.values?.[fieldId] ?? '';
  };

  const handleSelectRecord = React.useCallback((record) => {
    const recordId = String(record?.id || '');
    if (!recordId || recordId === selectedRecordId) return;
    setSelectedRecordId(recordId);
    if (isCrossBorder) {
      const settings = record?.crossBorderSettings || createCrossBorderDraftSettings(localRecords.length + 1);
      setCrossBorderSettings(settings);
      setCrossBorderWarehouseOptions(
        Array.isArray(settings.warehouseOptions) ? settings.warehouseOptions : [],
      );
      setCrossBorderServiceOptions(
        Array.isArray(settings.serviceOptions) ? settings.serviceOptions : [],
      );
      setCrossBorderStatus(settings.connectionMessage || '');
      if (settings.authorizationRef) {
        const requestId = crossBorderRequestRef.current + 1;
        crossBorderRequestRef.current = requestId;
        Promise.resolve().then(() => crossBorderWarehouseRefreshRef.current?.(settings, {
          isCurrent: () => crossBorderRequestRef.current === requestId,
        })).catch((error) => {
          if (crossBorderRequestRef.current !== requestId) return;
          setCrossBorderStatus(`仓库读取失败：${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }
    // The selected account and its form must update immediately. The operation
    // note lives in the parent settings shell and is only informational, so
    // keep that wider dialog rerender out of the urgent click path.
    React.startTransition(() => {
      onAction(`选择${record.title}`);
    });
  }, [isCrossBorder, localRecords.length, onAction, selectedRecordId]);

  const handleAddRecord = () => {
    if (isCrossBorder) {
      const settings = createCrossBorderDraftSettings(localRecords.length + 1);
      const nextRecord = buildCrossBorderDisplayRecord(config, settings);
      setLocalRecords((records) => [...records, nextRecord]);
      setSelectedRecordId(nextRecord.id);
      setCrossBorderSettings(settings);
      setCrossBorderWarehouseOptions([]);
      setCrossBorderServiceOptions([]);
      setCrossBorderStatus(settings.connectionMessage);
      saveCrossBorderSettings(settings);
      onAction(config.addLabel);
      return;
    }
    const nextRecord = isPlatformApi
      ? createBlankPlatformApiRecord(
        config,
        localRecords.filter((record) => record?.isPlaceholderDraft !== true).length + 1
      )
      : createBlankStructuredRecord(config, localRecords.length + 1);
    const nextRecords = [...localRecords, nextRecord];
    setLocalRecords(nextRecords);
    setSelectedRecordId(nextRecord.id);
    onAction(config.addLabel);
  };

  const removeStructuredRecordFromView = (recordId) => {
    const currentIndex = localRecords.findIndex((record) => record.id === recordId);
    const nextRecords = localRecords.filter((record) => record.id !== recordId);
    const safeRecords =
      nextRecords.length > 0
        ? nextRecords
        : [
          isPlatformApi
            ? createBlankPlatformApiRecord(config, 1, { placeholder: true })
            : createBlankStructuredRecord(config, 1),
        ];
    const nextSelectedRecord = nextRecords[Math.max(0, currentIndex - 1)] || safeRecords[0];
    setLocalRecords(safeRecords);
    setSelectedRecordId(nextSelectedRecord.id);
  };

  const handleDeleteRecord = async () => {
    if (isCrossBorder) {
      handleCrossBorderDeleteAccount();
      return;
    }
    if (isPurchaseAccount && purchasePersistedIdsRef.current.has(selectedRecord.id)) {
      setPurchaseAccountStatus('请在删除预览中核对当前采购账号。');
      const applyPurchaseAccountRemoval = () => {
        purchasePersistedIdsRef.current.delete(selectedRecord.id);
        removeStructuredRecordFromView(selectedRecord.id);
        setPurchaseAccountStatus('当前采购账号已通过完整回读后永久删除。');
        onAction(config.removeLabel);
      };
      accountRemoval.openAccountRemoval({ ownerType: 'purchase_account', ownerId: selectedRecord.id }, {
        onCompleted: applyPurchaseAccountRemoval,
        onMissing: applyPurchaseAccountRemoval,
      });
      return;
    }
    if (isPlatformApi) {
      const isPerformanceAccount = performancePersistedIdsRef.current.has(selectedRecord.id);
      const isSavedProfile = integrationProfilePersistedIdsRef.current.has(selectedRecord.id);
      if (isPerformanceAccount) {
        const recordId = selectedRecord.id;
        const finishPlatformAccountRemoval = () => {
          removeStructuredRecordFromView(recordId);
          setPlatformApiStatus('当前平台账号已通过完整回读后永久删除。');
          onAction(config.removeLabel);
        };
        const finishIntegrationProfileRemoval = () => {
          integrationProfilePersistedIdsRef.current.delete(recordId);
          if (Array.isArray(platformApiSourceSnapshotRef.current.profiles)) {
            platformApiSourceSnapshotRef.current = {
              ...platformApiSourceSnapshotRef.current,
              profiles: platformApiSourceSnapshotRef.current.profiles.filter(
                (profile) => profile?.id !== recordId
              ),
            };
          }
          finishPlatformAccountRemoval();
        };
        const continueRemovingCollidingProfile = () => {
          setPlatformApiStatus('检测到同编号的旧平台配置，正在继续清理第二条残留。');
          window.setTimeout(() => {
            accountRemoval.openAccountRemoval({ ownerType: 'integration_profile', ownerId: recordId }, {
              onCompleted: finishIntegrationProfileRemoval,
              onMissing: finishIntegrationProfileRemoval,
            });
          }, 0);
        };
        const finishPerformanceAccountRemoval = () => {
          performancePersistedIdsRef.current.delete(recordId);
          if (Array.isArray(platformApiSourceSnapshotRef.current.performanceAccounts)) {
            platformApiSourceSnapshotRef.current = {
              ...platformApiSourceSnapshotRef.current,
              performanceAccounts: platformApiSourceSnapshotRef.current.performanceAccounts.filter(
                (account) => account?.id !== recordId
              ),
            };
          }
          if (isSavedProfile && integrationProfilePersistedIdsRef.current.has(recordId)) {
            continueRemovingCollidingProfile();
            return;
          }
          finishPlatformAccountRemoval();
        };
        setPlatformApiStatus('请在删除预览中核对当前推广账号。');
        accountRemoval.openAccountRemoval({ ownerType: 'promotion_account', ownerId: recordId }, {
          onCompleted: finishPerformanceAccountRemoval,
          onMissing: finishPerformanceAccountRemoval,
        });
        return;
      }
      if (isSavedProfile) {
        const applyIntegrationProfileRemoval = () => {
          integrationProfilePersistedIdsRef.current.delete(selectedRecord.id);
          if (Array.isArray(platformApiSourceSnapshotRef.current.profiles)) {
            platformApiSourceSnapshotRef.current = {
              ...platformApiSourceSnapshotRef.current,
              profiles: platformApiSourceSnapshotRef.current.profiles.filter(
                (profile) => profile?.id !== selectedRecord.id
              ),
            };
          }
          removeStructuredRecordFromView(selectedRecord.id);
          setPlatformApiStatus('当前平台配置已通过完整回读后永久删除。');
          onAction(config.removeLabel);
        };
        setPlatformApiStatus('请在删除预览中核对当前平台配置。');
        accountRemoval.openAccountRemoval({ ownerType: 'integration_profile', ownerId: selectedRecord.id }, {
          onCompleted: applyIntegrationProfileRemoval,
          onMissing: applyIntegrationProfileRemoval,
        });
        return;
      }
    }
    removeStructuredRecordFromView(selectedRecord.id);
    if (isPurchaseAccount) setPurchaseAccountStatus('当前采购账号已从 local-api 删除。');
    if (isPlatformApi) setPlatformApiStatus('当前平台配置已从 local-api 删除。');
    onAction(config.removeLabel);
  };

  const updateStructuredRecordField = (fieldId, value) => {
    if (isPlatformApi && fieldId === 'integrationType') {
      const currentIntegrationType = getPlatformIntegrationType(selectedRecord);
      const isPersistedRecord = (
        performancePersistedIdsRef.current.has(selectedRecord.id)
        || integrationProfilePersistedIdsRef.current.has(selectedRecord.id)
      );
      if (isPersistedRecord && String(value || '').trim() !== currentIntegrationType) {
        setPlatformApiStatus('已保存接口不能直接改成另一种账号类型；请新增接口，或先删除当前配置。');
        return;
      }
    }
    const nextRecords = localRecords.map((record) => {
      if (record.id !== selectedRecord.id) return record;
      let values = { ...(record.values ?? {}), [fieldId]: value };
      let status = '本地草稿';
      let statusColor = 'default';
      let title = values.accountAlias || values.platformName || values.apiAlias || record.title;
      let meta = values.loginAccount || values.apiType || values.authMode || values.configStatus || record.meta;
      if (isPurchaseAccount && (fieldId === 'platformName' || fieldId === 'accountAlias')) {
        const preset = fieldId === 'platformName'
          ? getPurchaseAccountPresetByPlatform(value)
          : getPurchaseAccountPresetByAlias(value);
        if (preset) {
          values = {
            ...values,
            accountAlias: preset.accountAlias,
            platformName: preset.platformName,
            platformUrl: preset.platformUrl,
          };
          title = preset.accountAlias;
        }
      }
      if (isPlatformApi) {
        if (fieldId === 'integrationType') {
          const preset = getPlatformIntegrationPreset(value);
          const keepPerformanceCredentials =
            value === 'ozon-performance' && getPlatformIntegrationType(record) === 'ozon-performance';
          const keepExternalCredentials =
            value === getPlatformIntegrationType(record)
            && ['seerfar-open-api', 'linkfox-agent', 'wecom-group-bot'].includes(value);
          values = {
            ...values,
            ...preset.values,
            performanceClientId: keepPerformanceCredentials ? record.values?.performanceClientId || '' : '',
            performanceClientSecret: keepPerformanceCredentials ? record.values?.performanceClientSecret || '' : '',
            hasPerformanceClientId: keepPerformanceCredentials
              ? Boolean(record.values?.hasPerformanceClientId || record.values?.hasClientId)
              : false,
            hasPerformanceClientSecret: keepPerformanceCredentials
              ? Boolean(record.values?.hasPerformanceClientSecret || record.values?.hasClientSecret)
              : false,
            loginAccount: keepExternalCredentials ? record.values?.loginAccount || '' : '',
            loginPassword: keepExternalCredentials ? record.values?.loginPassword || '' : '',
            hasLoginPassword: keepExternalCredentials ? Boolean(record.values?.hasLoginPassword) : false,
            loginPasswordHint: keepExternalCredentials ? record.values?.loginPasswordHint || '' : '',
            apiKey: keepExternalCredentials ? record.values?.apiKey || '' : '',
            hasApiKey: keepExternalCredentials ? Boolean(record.values?.hasApiKey) : false,
            apiKeyHint: keepExternalCredentials ? record.values?.apiKeyHint || '' : '',
            wecomWebhook: keepExternalCredentials ? record.values?.wecomWebhook || '' : '',
            hasWecomWebhook: keepExternalCredentials ? Boolean(record.values?.hasWecomWebhook) : false,
            lastTestStatus: keepExternalCredentials ? record.values?.lastTestStatus || '' : '',
            lastTestAt: keepExternalCredentials ? record.values?.lastTestAt || '' : '',
            lastTestMessage: keepExternalCredentials ? record.values?.lastTestMessage || '' : '',
            remark: record.values?.remark || '',
          };
          title = preset.title;
          meta = preset.meta;
          status = preset.status;
          statusColor = preset.statusColor;
        } else if (
          fieldId === 'performanceClientId'
          || fieldId === 'performanceClientSecret'
          || fieldId === 'baseUrl'
          || fieldId === 'loginAccount'
          || fieldId === 'loginPassword'
          || fieldId === 'apiKey'
          || fieldId === 'wecomWebhook'
        ) {
          values = {
            ...values,
            configStatus: '待测试',
            tokenStatus: fieldId === 'apiKey' ? '待测试' : values.tokenStatus || '待测试',
            lastTestStatus: '',
            lastTestAt: '',
            lastTestMessage: '',
          };
          title = values.platformName || record.title;
          meta = values.apiType || values.authMode || record.meta;
          status = '待测试';
        } else if (fieldId === 'shopId' && getPlatformIntegrationType(record) === 'ozon-browser-session') {
          const selectedShop = (Array.isArray(shops) ? shops : []).find(
            (shop) => String(shop?.id || '').trim() === String(value || '').trim()
          );
          const shopLabel = String(
            selectedShop?.shopAlias || selectedShop?.alias || selectedShop?.name || selectedShop?.sellerName || ''
          ).trim();
          const currentName = String(values.platformName || '').trim();
          if (shopLabel && (!currentName || currentName === 'Ozon 网页登录' || currentName.startsWith('Ozon 网页登录 · '))) {
            values = { ...values, platformName: `Ozon 网页登录 · ${shopLabel}` };
          }
          title = values.platformName || record.title;
          meta = shopLabel ? `独立 Cookie · ${shopLabel}` : record.meta;
          status = values.configStatus === '连接成功' && values.tokenStatus === 'Cookie 已保存'
            ? '已连接'
            : '待登录';
        }
      }
      return normalizeStructuredRecord(
        config,
        {
          ...record,
          values,
          title,
          meta,
          status,
          statusColor,
        },
        localRecords.findIndex((item) => item.id === record.id)
      );
    });
    setLocalRecords(nextRecords);
  };

  const saveCurrentPurchaseAccount = async (options = {}) => {
    const values = selectedRecord.values ?? {};
    const preset = resolvePurchaseAccountPreset(values);
    const loginPassword = String(values.loginPassword ?? '').trim();
    const hasSavedPassword = Boolean(values.hasLoginPassword);
    const hasDirectLoginCredential = Boolean(
      String(values.loginAccount ?? '').trim() || loginPassword || hasSavedPassword
    );
    if (!preset) {
      setPurchaseAccountStatus('请先选择采购平台和对应账号简称。');
      return false;
    }
    if (!String(values.recipientNickname ?? '').trim()) {
      setPurchaseAccountStatus('请先填写收件人昵称。');
      return false;
    }
    if (!String(values.recipientPhone ?? '').trim()) {
      setPurchaseAccountStatus('请先填写收货手机号。');
      return false;
    }
    if (!String(values.recipientAddress ?? '').trim()) {
      setPurchaseAccountStatus('请先填写收货地址。');
      return false;
    }

    const action = options.action || '检查本地资料';
    const isDefault = options.isDefault ?? Boolean(values.isDefault);
    setPurchaseAccountLoading(true);
    setPurchaseAccountStatus('正在加密保存采购账号到 local-api。');
    try {
      const saved = await savePurchaseAccount(
        toPurchaseAccountSavePayload(selectedRecord, {
          keepId: purchasePersistedIdsRef.current.has(selectedRecord.id),
          isDefault,
        }),
        { timeoutMs: 30000 }
      );
      const account = saved?.account;
      if (!account?.id) throw new Error('local-api 未返回采购账号。');
      purchasePersistedIdsRef.current.add(account.id);
      const savedRecord = toPurchaseStructuredRecord(config, account, 0);
      setLocalRecords((currentRecords) =>
        currentRecords.map((record, index) => {
          if (record.id === selectedRecord.id) return { ...savedRecord, id: account.id };
          if (!isDefault) return record;
          return normalizeStructuredRecord(
            config,
            {
              ...record,
              meta: 'local-api 加密保存',
              values: { ...(record.values ?? {}), isDefault: false },
            },
            index
          );
        })
      );
      setSelectedRecordId(account.id);
      setPurchaseAccountStatus(
        isDefault
          ? '已加密保存到 local-api，并已设为默认采购账号。'
          : hasDirectLoginCredential
            ? '已完成本地资料检查并加密保存到 local-api；前端不保存登录密码明文。'
            : '账号资料已加密保存；请点击“打开登录窗口”完成验证码或扫码登录。'
      );
      onAction(action);
      return true;
    } catch (error) {
      setPurchaseAccountStatus(`保存失败：${getPlatformApiErrorMessage(error)}`);
      return false;
    } finally {
      setPurchaseAccountLoading(false);
    }
  };

  const handlePurchaseAccountAction = async (action) => {
    if (!isPurchaseAccount) {
      onAction(action);
      return;
    }
    if (action === '新增账号') {
      handleAddRecord();
      return;
    }
    await saveCurrentPurchaseAccount({ action, isDefault: action === '设为默认' });
  };

  const saveCurrentIntegrationProfile = async (action, options = {}) => {
    const values = selectedRecord.values ?? {};
    const integrationType = getPlatformIntegrationType(selectedRecord);
    if (!integrationType) {
      setPlatformApiStatus('请先选择需要接入的外部服务。');
      return false;
    }
    if (integrationType === 'ozon-browser-session' && !String(values.shopId || '').trim()) {
      setPlatformApiStatus('请先选择这个网页登录所属的 Ozon 店铺。');
      return false;
    }
    if (!String(values.platformName || '').trim()) {
      setPlatformApiStatus('请先填写配置名称。');
      return false;
    }
    setPlatformApiLoading(true);
    setPlatformApiStatus('正在通过 local-api 加密保存接口网址和凭证。');
    try {
      const saved = await saveIntegrationProfile(toIntegrationProfileSavePayload(selectedRecord), { timeoutMs: 30000 });
      const profile = saved?.profile;
      if (!profile?.id) throw new Error('local-api 未返回平台配置。');
      integrationProfilePersistedIdsRef.current.add(profile.id);
      if (Array.isArray(platformApiSourceSnapshotRef.current.profiles)) {
        platformApiSourceSnapshotRef.current = {
          ...platformApiSourceSnapshotRef.current,
          profiles: [
            ...platformApiSourceSnapshotRef.current.profiles.filter((item) => item?.id !== profile.id),
            profile,
          ],
        };
      }
      const savedRecord = toIntegrationStructuredRecord(config, profile, 0, selectedRecord);
      setLocalRecords((currentRecords) => {
        let replaced = false;
        const nextRecords = currentRecords.map((record, index) => {
          if (record.id !== selectedRecord.id) return record;
          replaced = true;
          return toIntegrationStructuredRecord(config, profile, index, record);
        });
        return replaced ? nextRecords : [...nextRecords, savedRecord];
      });
      setSelectedRecordId(profile.id || savedRecord.id);
      setPlatformApiStatus('接口网址和凭证已加密保存；密钥不会写入浏览器缓存。');
      if (!options.silent) onAction(action);
      return profile;
    } catch (error) {
      setPlatformApiStatus(`保存失败：${getPlatformApiErrorMessage(error)}`);
      return null;
    } finally {
      setPlatformApiLoading(false);
    }
  };

  const handleOzonBrowserConnected = async ({ profile, result } = {}) => {
    if (!profile?.id || result?.loggedIn !== true || result?.cookieSaved !== true) {
      throw new Error('Ozon 登录或 Cookie 保存尚未通过验证。');
    }
    setPlatformApiLoading(true);
    setPlatformApiStatus('Ozon 登录已验证，正在核对网页账号与当前店铺 API。');
    try {
      const verifiedProfile = await completeOzonShopSellerLogin({
        profile,
        shopId: profile.shopId || selectedRecord.values?.shopId || '',
        shopName: profile.platformName || selectedRecord.values?.platformName || 'Ozon 店铺',
        result,
      });
      const connectedRecord = {
        ...selectedRecord,
        id: verifiedProfile.id,
        values: {
          ...(selectedRecord.values ?? {}),
          integrationType: 'ozon-browser-session',
          ...verifiedProfile,
        },
      };
      const nextRecord = toIntegrationStructuredRecord(config, verifiedProfile, 0, connectedRecord);
      integrationProfilePersistedIdsRef.current.add(verifiedProfile.id);
      if (Array.isArray(platformApiSourceSnapshotRef.current.profiles)) {
        platformApiSourceSnapshotRef.current = {
          ...platformApiSourceSnapshotRef.current,
          profiles: [
            ...platformApiSourceSnapshotRef.current.profiles.filter(
              (item) => item?.id !== verifiedProfile.id
            ),
            verifiedProfile,
          ],
        };
      }
      setLocalRecords((currentRecords) => {
        let replaced = false;
        const nextRecords = currentRecords.map((record, index) => {
          if (record.id !== selectedRecord.id && record.id !== verifiedProfile.id) return record;
          replaced = true;
          return toIntegrationStructuredRecord(config, verifiedProfile, index, connectedRecord);
        });
        return replaced ? nextRecords : [...nextRecords, nextRecord];
      });
      setSelectedRecordId(verifiedProfile.id);
      setPlatformApiStatus('Ozon 网页账号已与当前店铺 API 自动对应，Cookie 已隔离保存。');
      onAction('Ozon 网页登录连接成功');
      return verifiedProfile;
    } catch (error) {
      setPlatformApiStatus(`Ozon 连接状态保存失败：${getPlatformApiErrorMessage(error)}`);
      throw error;
    } finally {
      setPlatformApiLoading(false);
    }
  };

  const handlePlatformApiAction = async (action) => {
    if (!isPlatformApi) {
      onAction(action);
      return;
    }

    const integrationType = getPlatformIntegrationType(selectedRecord);
    const externalDataIntegrationTypes = ['seerfar-open-api', 'linkfox-agent', 'wecom-group-bot'];
    if (externalDataIntegrationTypes.includes(integrationType)) {
      const values = selectedRecord.values ?? {};
      const isWecomGroupBot = integrationType === 'wecom-group-bot';
      const apiKey = isWecomGroupBot ? String(values.wecomWebhook || '').trim() : String(values.apiKey || '').trim();
      const hasSavedApiKey = isWecomGroupBot ? Boolean(values.hasWecomWebhook) : Boolean(values.hasApiKey);
      if (!isWecomGroupBot && !String(values.baseUrl || '').trim()) {
        setPlatformApiStatus('请先填写接口网址。');
        return;
      }
      if (!apiKey && !hasSavedApiKey) {
        setPlatformApiStatus(isWecomGroupBot ? '请先粘贴企业微信机器人 Webhook 地址。' : '请先填写 API Key / Token。');
        return;
      }
      if (isPlatformSaveAction(action)) {
        await saveCurrentIntegrationProfile(action);
        return;
      }
      if (action !== '测试连接') {
        setPlatformApiStatus(`${action} 只打开本地脱敏日志，不会发起数据查询。`);
        onAction(action);
        return;
      }

      const savedProfile = await saveCurrentIntegrationProfile(action, { silent: true });
      if (!savedProfile?.id) return;
      setPlatformApiLoading(true);
      setPlatformApiStatus(isWecomGroupBot ? '正在发送企业微信机器人测试消息。' : '正在通过 local-api 使用加密凭证测试真实接口。');
      try {
        const result = await testPlatformIntegration(
          { type: integrationType, integrationType, profileId: savedProfile.id },
          { timeoutMs: 45000 }
        );
        const profile = result?.profile || savedProfile;
        const savedRecord = toIntegrationStructuredRecord(config, profile, 0, selectedRecord);
        setLocalRecords((currentRecords) =>
          currentRecords.map((record, index) =>
            record.id === selectedRecord.id || record.id === profile.id
              ? toIntegrationStructuredRecord(config, profile, index, record)
              : record
          )
        );
        setSelectedRecordId(profile.id || savedRecord.id);
        setPlatformApiStatus(result.message || '连接成功，接口凭证可以被业务模块调用。');
        onAction(`${savedRecord.title} 连接成功`);
      } catch (error) {
        const message = getPlatformApiErrorMessage(error);
        const nowText = new Date().toLocaleString('zh-CN', { hour12: false });
        setLocalRecords((currentRecords) =>
          currentRecords.map((record, index) => {
            if (record.id !== selectedRecord.id && record.id !== savedProfile.id) return record;
            return normalizeStructuredRecord(
              config,
              {
                ...record,
                status: '连接失败',
                statusColor: 'error',
                values: {
                  ...(record.values ?? {}),
                  apiKey: '',
                  hasApiKey: Boolean(apiKey || hasSavedApiKey),
                  wecomWebhook: '',
                  hasWecomWebhook: isWecomGroupBot ? Boolean(apiKey || hasSavedApiKey) : Boolean(record.values?.hasWecomWebhook),
                  configStatus: '连接失败',
                  tokenStatus: '测试失败',
                  lastTestStatus: 'error',
                  lastTestAt: nowText,
                  lastTestMessage: message,
                },
              },
              index
            );
          })
        );
        setPlatformApiStatus(`连接失败：${message}`);
      } finally {
        setPlatformApiLoading(false);
      }
      return;
    }

    if (integrationType !== 'ozon-performance') {
      if (isPlatformSaveAction(action)) {
        await saveCurrentIntegrationProfile(action);
        return;
      } else if (action === '测试连接') {
        setPlatformApiStatus('该服务的安全凭证和测试适配器尚未接入；当前不会发起外部请求。');
      } else {
        setPlatformApiStatus(`${action} 仅保留本地入口，不会打开外部写入流程。`);
      }
      onAction(action);
      return;
    }

    const values = selectedRecord.values ?? {};
    const shopId = String(values.shopId || '').trim();
    const clientId = String(values.performanceClientId || '').trim();
    const clientSecret = String(values.performanceClientSecret || '').trim();
    const hasSavedClientId = Boolean(values.hasPerformanceClientId || values.hasClientId);
    const hasSavedClientSecret = Boolean(values.hasPerformanceClientSecret || values.hasClientSecret);
    if (config.fields.some((field) => field.id === 'shopId') && !shopId) {
      setPlatformApiStatus('请先选择这个 Performance API 账号所属的 Ozon 店铺。');
      return;
    }
    if (!clientId && !hasSavedClientId) {
      setPlatformApiStatus('请先填写 Performance client_id。');
      return;
    }
    if (!clientSecret && !hasSavedClientSecret) {
      setPlatformApiStatus('请先填写 Performance client_secret。');
      return;
    }

    const saveAccountAndRecord = async (statusPatch = {}) => {
      const savePayload = {
        id: selectedRecord.id,
        name: values.platformName || selectedRecord.title || 'Ozon Performance API',
        note: values.remark || '',
        shopId,
      };
      if (statusPatch.status) savePayload.status = statusPatch.status;
      if (clientId) savePayload.clientId = clientId;
      if (clientSecret) savePayload.clientSecret = clientSecret;
      const saved = await savePerformanceAccount(savePayload, { timeoutMs: 30000 });
      const account = saved.account;
      if (account?.id) performancePersistedIdsRef.current.add(account.id);
      if (account?.id && Array.isArray(platformApiSourceSnapshotRef.current.performanceAccounts)) {
        platformApiSourceSnapshotRef.current = {
          ...platformApiSourceSnapshotRef.current,
          performanceAccounts: [
            ...platformApiSourceSnapshotRef.current.performanceAccounts.filter(
              (item) => item?.id !== account.id
            ),
            account,
          ],
        };
      }
      const nextRecords = localRecords.map((record) => {
        if (record.id !== selectedRecord.id) return record;
        return normalizeStructuredRecord(
          config,
          {
            ...record,
            id: account?.id || record.id,
            isTransientDraft: false,
            isPlaceholderDraft: false,
            title: account?.title || account?.name || record.title,
            status: statusPatch.recordStatus || record.status,
            statusColor: statusPatch.statusColor || record.statusColor,
            meta: statusPatch.meta || record.meta,
            values: {
              ...(record.values ?? {}),
              performanceClientId: clientId || record.values?.performanceClientId || '',
              performanceClientSecret: '',
              hasPerformanceClientId: Boolean(
                account?.hasClientId || clientId || record.values?.hasPerformanceClientId || record.values?.hasClientId
              ),
              hasPerformanceClientSecret: Boolean(
                account?.hasClientSecret ||
                clientSecret ||
                record.values?.hasPerformanceClientSecret ||
                record.values?.hasClientSecret
              ),
              performanceAccountStatus:
                account?.status || record.values?.performanceAccountStatus || 'inactive',
              configStatus: statusPatch.configStatus || record.values?.configStatus || '已加密保存',
              tokenStatus: statusPatch.tokenStatus || record.values?.tokenStatus || '未获取',
              campaignCount: statusPatch.campaignCount ?? record.values?.campaignCount,
              statisticsTaskCount: statusPatch.statisticsTaskCount ?? record.values?.statisticsTaskCount,
              lastTestAt: statusPatch.lastTestAt || record.values?.lastTestAt || '',
              lastTestMessage: statusPatch.lastTestMessage || record.values?.lastTestMessage || '',
            },
          },
          localRecords.findIndex((item) => item.id === record.id)
        );
      });
      setLocalRecords(nextRecords);
      setSelectedRecordId(account?.id || selectedRecord.id);
      return { saved, nextRecords };
    };

    if (isPlatformSaveAction(action)) {
      setPlatformApiLoading(true);
      setPlatformApiStatus('正在加密保存 Performance API 凭证到 local-api。');
      try {
        await saveAccountAndRecord({
          // 普通保存备注或页面设置不能把已经测试成功的账号降回 inactive。
          // 只有凭证被编辑后才要求重新测试。
          status: clientSecret || values.configStatus === '待测试' ? 'inactive' : undefined,
          recordStatus: '已保存',
          statusColor: 'primary',
          meta: 'local-api 加密保存',
          configStatus: '已加密保存',
          lastTestMessage: '已加密保存到 local-api，前端不保存 client_secret 明文。',
        });
        setPlatformApiStatus('已加密保存到 local-api，前端不保存 client_secret 明文。');
        onAction(action);
      } catch (error) {
        setPlatformApiStatus(`保存失败：${getPlatformApiErrorMessage(error)}`);
      } finally {
        setPlatformApiLoading(false);
      }
      return;
    }

    if (action !== '测试连接') {
      setPlatformApiStatus(`${action} 仍作为本地入口保留，暂未打开外部写入流程。`);
      onAction(action);
      return;
    }

    setPlatformApiLoading(true);
    setPlatformApiStatus('正在通过 local-api 读取加密凭证并测试 Ozon Performance API。');
    try {
      const { saved } = await saveAccountAndRecord({
        status: 'inactive',
        recordStatus: '待测试',
        statusColor: 'default',
        meta: 'local-api 加密保存',
        configStatus: '待测试',
        tokenStatus: '未获取',
      });
      const accountId = saved.account?.id || selectedRecord.id;
      const payload = await testPerformanceAccount(accountId, { timeoutMs: 45000 });
      const nowText = new Date().toLocaleString('zh-CN', { hour12: false });
      const campaignCount = payload.summary?.campaignCount ?? 0;
      const statisticsTaskCount = payload.summary?.statisticsTaskCount ?? 0;
      const nextRecords = localRecords.map((record) => {
        if (record.id !== selectedRecord.id && record.id !== accountId) return record;
        return normalizeStructuredRecord(
          config,
          {
            ...record,
            id: accountId,
            status: '连接成功',
            statusColor: 'success',
            meta: '只读测试通过',
            values: {
              ...(record.values ?? {}),
              performanceClientId: clientId || record.values?.performanceClientId || '',
              performanceClientSecret: '',
              hasPerformanceClientId: Boolean(
                saved.account?.hasClientId ||
                clientId ||
                record.values?.hasPerformanceClientId ||
                record.values?.hasClientId
              ),
              hasPerformanceClientSecret: Boolean(
                saved.account?.hasClientSecret ||
                clientSecret ||
                record.values?.hasPerformanceClientSecret ||
                record.values?.hasClientSecret
              ),
              performanceAccountStatus: 'active',
              configStatus: '连接成功',
              tokenStatus: payload.auth?.expiresIn ? `有效 ${payload.auth.expiresIn}s` : '有效',
              campaignCount,
              statisticsTaskCount,
              lastTestAt: nowText,
              lastTestMessage: `只读测试通过：广告计划 ${campaignCount} 个，统计任务 ${statisticsTaskCount} 个。`,
            },
          },
          localRecords.findIndex((item) => item.id === record.id)
        );
      });
      setLocalRecords(nextRecords);
      setSelectedRecordId(accountId);
      setPlatformApiStatus(
        `连接成功：广告计划 ${campaignCount} 个，统计任务 ${statisticsTaskCount} 个；未执行任何创建、预算、出价或扣费写入。`
      );
      onAction('Performance API 只读连接成功');
    } catch (error) {
      const message = getPlatformApiErrorMessage(error);
      const nowText = new Date().toLocaleString('zh-CN', { hour12: false });
      const nextRecords = localRecords.map((record) => {
        if (record.id !== selectedRecord.id) return record;
        return normalizeStructuredRecord(
          config,
          {
            ...record,
            status: '连接失败',
            statusColor: 'error',
            values: {
              ...(record.values ?? {}),
              performanceClientSecret: '',
              hasPerformanceClientId: Boolean(
                record.values?.hasPerformanceClientId || record.values?.hasClientId || clientId
              ),
              hasPerformanceClientSecret: Boolean(
                record.values?.hasPerformanceClientSecret || record.values?.hasClientSecret || clientSecret
              ),
              performanceAccountStatus: 'error',
              configStatus: '连接失败',
              tokenStatus: '未获取',
              lastTestAt: nowText,
              lastTestMessage: message,
            },
          },
          localRecords.findIndex((item) => item.id === record.id)
        );
      });
      setLocalRecords(nextRecords);
      setPlatformApiStatus(`连接失败：${message}`);
    } finally {
      setPlatformApiLoading(false);
    }
  };

  const persistCrossBorderSettings = (patch) => {
    const saved = readSavedCrossBorderSettings(config.records[0]?.values ?? {});
    const nextSettings = { ...saved, ...crossBorderSettings, ...patch };
    saveCrossBorderSettings(nextSettings);
    setCrossBorderSettings(nextSettings);
    setLocalRecords((records) => {
      const nextRecord = buildCrossBorderDisplayRecord(config, nextSettings);
      const recordId = selectedRecordId || nextRecord.id;
      const index = records.findIndex((record) => record.id === recordId || record.id === nextRecord.id);
      if (index < 0) return [...records, nextRecord];
      const next = [...records];
      next[index] = nextRecord;
      return next;
    });
    return nextSettings;
  };

  const saveCrossBorderAccountWithExplicitRebind = async (settings) => {
    if (!Array.isArray(settings.shopIds) || settings.shopIds.length === 0) {
      throw new Error('请至少绑定一个 Ozon 店铺');
    }
    const ownerId = getCrossBorderLocalApiAccountId(settings);
    const account = await saveCrossBorderAccountToLocalApi(
      { ...settings, ...(ownerId ? { crossBorderAccountId: ownerId } : {}) },
      { accountRemovalRebind: Boolean(ownerId) },
    );
    if (ownerId) releaseCrossBorderSettingsWriteFence(ownerId);
    return account;
  };

  const setCrossBorderMessage = (message) => {
    setCrossBorderStatus(message);
    persistCrossBorderSettings({ connectionMessage: message });
  };

  const requestCrossBorderSettingsRead = async (path, settings, body) => {
    const endpointKey = {
      '/erpapi/storehouse/cooperationStorehouse': 'warehouse.cooperationStorehouse',
      '/erpapi/storehouse/searchStorehouseSection': 'warehouse.searchStorehouseSection',
    }[path];
    if (!endpointKey) throw new Error('跨境巴士服务器接口未登记');
    const result = await readCrossBorderAccountThroughServer(settings, endpointKey, body);
    return result?.data ?? result;
  };

  const fetchCrossBorderServices = async (
    settings,
    warehouseValue = settings.cooperationWarehouse,
    warehouseOptions = crossBorderWarehouseOptions,
    options = {}
  ) => {
    const isCurrent = options.isCurrent || (() => true);
    const selectedWarehouse = warehouseOptions.find((option) => option.value === warehouseValue);
    if (!selectedWarehouse) return settings;

    let data;
    try {
      data = await requestCrossBorderSettingsRead(
        '/erpapi/storehouse/searchStorehouseSection',
        settings,
        {
          sid: selectedWarehouse.sid,
          section_id: selectedWarehouse.sectionId,
        },
        { timeoutMs: 15000 }
      );
    } catch (error) {
      throw error;
    }
    const serviceOptions = normalizeCrossBorderServices(data);
    if (serviceOptions.length === 0) throw new Error('仓库服务接口没有返回可用打包服务');
    if (!isCurrent()) return settings;
    const packageService = serviceOptions.some((option) => option.value === settings.packageService)
      ? settings.packageService
      : serviceOptions[0]?.value || settings.packageService || '';
    const successMessage = `真实连接正常，已读取 ${warehouseOptions.length} 个合作仓库和 ${serviceOptions.length} 项打包服务。`;
    setCrossBorderServiceOptions(serviceOptions);
    setCrossBorderStatus(successMessage);
    return persistCrossBorderSettings({
      ...settings,
      serviceOptions,
      packageService,
      connectionStatus: '真实接口已连接',
      connectionMessage: successMessage,
    });
  };

  const fetchCrossBorderWarehouses = async (settings, options = {}) => {
    const isCurrent = options.isCurrent || (() => true);
    let data;
    try {
      data = await requestCrossBorderSettingsRead(
        '/erpapi/storehouse/cooperationStorehouse',
        settings,
        {},
        { timeoutMs: 15000 }
      );
    } catch (error) {
      throw error;
    }
    const warehouseOptions = normalizeCrossBorderWarehouses(data);
    if (warehouseOptions.length === 0) throw new Error('合作仓库接口没有返回可用仓库');
    if (!isCurrent()) return settings;

    const cooperationWarehouse = warehouseOptions.some((option) => option.value === settings.cooperationWarehouse)
      ? settings.cooperationWarehouse
      : warehouseOptions[0].value;

    setCrossBorderWarehouseOptions(warehouseOptions);
    const warehouseMessage = `已读取 ${warehouseOptions.length} 个合作仓库，正在读取打包服务...`;
    setCrossBorderStatus(warehouseMessage);
    const next = persistCrossBorderSettings({
      ...settings,
      warehouseOptions,
      cooperationWarehouse,
      connectionStatus: '仓库读取成功',
      connectionMessage: warehouseMessage,
    });
    return fetchCrossBorderServices(next, cooperationWarehouse, warehouseOptions, options);
  };
  crossBorderWarehouseRefreshRef.current = fetchCrossBorderWarehouses;

  const authorizeCrossBorderAccount = async (settings, options = {}) => {
    const isCurrent = options.isCurrent || (() => true);
    if (!settings.userName?.trim() || !settings.password?.trim()) {
      throw new Error('请先填写跨境巴士用户名和密码');
    }
    if (!Array.isArray(settings.shopIds) || settings.shopIds.length === 0) {
      throw new Error('请至少绑定一个 Ozon 店铺');
    }
    const accountId = getCrossBorderLocalApiAccountId(settings) || CROSS_BORDER_MAIN_ACCOUNT_ID;
    const payload = await authorizeCrossBorderAccountThroughServer({
      ...settings,
      id: accountId,
    }, { timeoutMs: 60000 });
    if (!isCurrent()) return settings;
    const authorizedSettings = persistCrossBorderSettings({
      ...settings,
      userName: '',
      password: '',
      companySecret: '',
      accessToken: '',
      expiresToken: '',
      appUid: '',
      hasCompanySecret: false,
      hasAccessToken: false,
      hasExpiresToken: false,
      hasAppUid: false,
      ...toCrossBorderPublicSettings(payload.account),
      authorizationRef: payload.authorization_ref,
      authorizationExpiresAt: payload.expires_at,
      hasServerAuthorization: true,
      lastConnectedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      connectionStatus: '服务器授权已连接',
      connectionMessage: payload.message || '跨境巴士服务器授权成功。',
    });
    setSelectedRecordId(getCrossBorderLocalApiAccountId(authorizedSettings));
    return fetchCrossBorderWarehouses(authorizedSettings, options);
  };

  const saveCrossBorderForecastSettings = (settings) => {
    const selectedWarehouse = crossBorderWarehouseOptions.find(
      (option) => option.value === settings.cooperationWarehouse
    );
    const selectedService = crossBorderServiceOptions.find((option) => option.value === settings.packageService);
    const warehouseLabel =
      selectedWarehouse?.label || settings.cooperationWarehouse || settings.selectedWarehouseLabel || '';
    const serviceLabel = selectedService?.label || settings.packageService || settings.selectedServiceLabel || '';

    if (!warehouseLabel || !serviceLabel) {
      throw new Error('请先填写合作仓库和打包服务');
    }

    const next = persistCrossBorderSettings({
      ...settings,
      cooperationWarehouse: settings.cooperationWarehouse || warehouseLabel,
      packageService: settings.packageService || serviceLabel,
      selectedWarehouseLabel: warehouseLabel,
      selectedServiceLabel: serviceLabel,
      savedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    });
    saveCrossBorderAccountToLocalApi(next).catch(() => undefined);
    return next;
  };

  const replaceCrossBorderSettings = (nextSettings) => {
    saveCrossBorderSettings(nextSettings);
    setCrossBorderSettings(nextSettings);
    setCrossBorderWarehouseOptions(Array.isArray(nextSettings.warehouseOptions) ? nextSettings.warehouseOptions : []);
    setCrossBorderServiceOptions(Array.isArray(nextSettings.serviceOptions) ? nextSettings.serviceOptions : []);
    setCrossBorderStatus(nextSettings.connectionMessage || '');
    return nextSettings;
  };

  const buildDeletedCrossBorderSettings = (accountId) => ({
    ...(config.records[0]?.values ?? {}),
    crossBorderAccountId: accountId || CROSS_BORDER_MAIN_ACCOUNT_ID,
    accountAlias: crossBorderSettings.accountAlias || config.records[0]?.title || '跨境巴士授权',
    userName: '',
    password: '',
    companySecret: '',
    expiresToken: '',
    appUid: '',
    accessToken: '',
    authorizationRef: '',
    authorizationExpiresAt: '',
    hasServerAuthorization: false,
    refreshToken: '',
    tokenExpiresIn: '',
    hasCompanySecret: false,
    hasAccessToken: false,
    hasAppUid: false,
    hasUserName: false,
    hasPassword: false,
    accountSaved: false,
    accountSavedAt: '',
    apiSaved: false,
    apiSavedAt: '',
    warehouseOptions: [],
    serviceOptions: [],
    shopIds: [],
    shopCount: 0,
    cooperationWarehouse: '',
    packageService: '',
    selectedWarehouseLabel: '',
    selectedServiceLabel: '',
    savedAt: '',
    lastConnectedAt: '',
    connectionStatus: '已删除授权',
    connectionMessage: '已删除当前跨境巴士授权及账号保存数据。',
  });

  const handleCrossBorderDeleteAccount = async () => {
    const accountId =
      getCrossBorderLocalApiAccountId(crossBorderSettings) || selectedRecord?.id || CROSS_BORDER_MAIN_ACCOUNT_ID;
    const applyDeletedSettings = (verified) => {
      const deletedSettings = buildDeletedCrossBorderSettings(accountId);
      setCrossBorderSettings(deletedSettings);
      setCrossBorderWarehouseOptions([]);
      setCrossBorderServiceOptions([]);
      setCrossBorderStatus(verified
        ? '当前跨境巴士账号已通过完整回读后永久删除。'
        : '当前未保存的跨境巴士草稿已移除。');
      onAction(config.removeLabel);
    };

    if (isThinClientV2) {
      setCrossBorderLoading(true);
      setCrossBorderLoadingAction(config.removeLabel);
      setCrossBorderStatus(
        crossBorderSettings.authorizationRef
          ? '正在解除跨境巴士授权并清理本地引用...'
          : '正在删除本地授权记录...',
      );
      try {
        if (crossBorderSettings.accountSaved || crossBorderSettings.authorizationRef) {
          await revokeAndDeleteCrossBorderAccountThroughServer(
            crossBorderSettings,
            { timeoutMs: 60000 },
          );
        }
        const remaining = localRecords.filter((record) => record.id !== accountId);
        const nextSettings = remaining[0]?.crossBorderSettings
          || createCrossBorderDraftSettings(1);
        const nextRecords = remaining.length
          ? remaining
          : [buildCrossBorderDisplayRecord(config, nextSettings)];
        setLocalRecords(nextRecords);
        setSelectedRecordId(getCrossBorderLocalApiAccountId(nextSettings));
        setCrossBorderSettings(nextSettings);
        setCrossBorderWarehouseOptions(
          Array.isArray(nextSettings.warehouseOptions) ? nextSettings.warehouseOptions : [],
        );
        setCrossBorderServiceOptions(
          Array.isArray(nextSettings.serviceOptions) ? nextSettings.serviceOptions : [],
        );
        saveCrossBorderSettings(nextSettings);
        setCrossBorderStatus('当前跨境巴士授权已解除并删除。');
        onAction(config.removeLabel);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setCrossBorderStatus(`解除授权失败，未删除本地记录：${message}`);
      } finally {
        setCrossBorderLoading(false);
        setCrossBorderLoadingAction('');
      }
      return;
    }

    // The cross-border panel always renders a local draft immediately, while
    // the canonical SQLite row is hydrated asynchronously.  A freshly rebound
    // account can therefore still have accountSaved=false for a short window.
    // Resolve the exact owner from local-api at click time so that a second
    // delete of the same canonical id cannot fall back to the legacy local-only
    // branch and leave credentials behind.
    let persistedAccount = null;
    setCrossBorderLoading(true);
    setCrossBorderLoadingAction(config.removeLabel);
    setCrossBorderStatus('正在核对当前跨境巴士账号...');
    try {
      const payload = await readCrossBorderAccounts({ timeoutMs: 10000 });
      const accounts = Array.isArray(payload?.rows)
        ? payload.rows
        : Array.isArray(payload?.accounts)
          ? payload.accounts
          : [];
      persistedAccount = accounts.find(
        (account) => String(account?.id || '').trim() === String(accountId || '').trim()
      ) || null;
    } catch (error) {
      setCrossBorderLoading(false);
      setCrossBorderLoadingAction('');
      if (crossBorderSettings.accountSaved !== true) {
        const message = error instanceof Error ? error.message : String(error);
        setCrossBorderStatus(`账号核对失败，未执行删除：${message}`);
        return;
      }
    }
    setCrossBorderLoading(false);
    setCrossBorderLoadingAction('');

    if (persistedAccount) {
      const hydratedSettings = {
        ...crossBorderSettings,
        ...toCrossBorderPublicSettings(persistedAccount),
      };
      setCrossBorderSettings(hydratedSettings);
    }
    if (!persistedAccount && crossBorderSettings.accountSaved !== true) {
      applyDeletedSettings(false);
      return;
    }
    setCrossBorderStatus('请在删除预览中核对当前跨境巴士账号。');
    accountRemoval.openAccountRemoval({ ownerType: 'cross_border_bus', ownerId: accountId }, {
      onCompleted: () => applyDeletedSettings(true),
      onMissing: () => applyDeletedSettings(true),
    });
  };

  const handleCrossBorderSectionAction = async (action) => {
    const requestId = crossBorderRequestRef.current + 1;
    crossBorderRequestRef.current = requestId;
    const isCurrentCrossBorderRequest = () => crossBorderRequestRef.current === requestId && isCrossBorder;
    setCrossBorderLoading(true);
    setCrossBorderLoadingAction(action);
    setCrossBorderStatus(`${action}中...`);
    const loadingResetTimer = window.setTimeout(() => {
      if (!isCurrentCrossBorderRequest()) return;
      setCrossBorderLoading(false);
      setCrossBorderLoadingAction('');
      setCrossBorderStatus(`${action}超时，请重新点击`);
    }, action === '获取授权' ? 65000 : 20000);
    try {
      if (action === '获取授权') {
        await authorizeCrossBorderAccount(crossBorderSettings, {
          isCurrent: isCurrentCrossBorderRequest,
        });
        if (!isCurrentCrossBorderRequest()) return;
        setCrossBorderMessage('授权成功，合作仓库和打包服务已自动读取');
      } else if (action === '保存设置') {
        saveCrossBorderForecastSettings(crossBorderSettings);
        setCrossBorderMessage('预报设置已保存到本地');
      }
    } catch (error) {
      if (!isCurrentCrossBorderRequest()) return;
      const message = error instanceof Error ? error.message : String(error);
      const isCorsLike =
        message.includes('Failed to fetch') || message.includes('NetworkError') || message.includes('Load failed');
      const isLocalOnlyAction = action === '保存设置';
      setCrossBorderMessage(
        isCorsLike
          ? '真实连接失败：浏览器跨域拦截。请确认当前是 npm run dev 启动，已启用本地代理。'
          : isLocalOnlyAction
            ? message
            : `真实连接失败：${message}`
      );
    } finally {
      window.clearTimeout(loadingResetTimer);
      if (isCurrentCrossBorderRequest()) {
        setCrossBorderLoading(false);
        setCrossBorderLoadingAction('');
      }
    }
  };

  const saveCurrentPageSettings = async () => {
    if (isPlatformApi) {
      return handlePlatformApiAction('保存接口资料');
    }
    if (isPurchaseAccount) {
      return saveCurrentPurchaseAccount({ action: '保存' });
    }
    if (!isCrossBorder) return false;

    const requestId = crossBorderRequestRef.current + 1;
    crossBorderRequestRef.current = requestId;
    setCrossBorderLoading(true);
    setCrossBorderLoadingAction('保存');
    setCrossBorderStatus('正在保存当前页面设定...');
    try {
      const account = await saveCrossBorderAccountWithExplicitRebind(crossBorderSettings);
      if (crossBorderRequestRef.current !== requestId) return false;
      const nextSettings = persistCrossBorderSettings({
        ...crossBorderSettings,
        ...toCrossBorderPublicSettings(account),
        savedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        connectionMessage: '当前页面设定已保存。',
      });
      setCrossBorderSettings(nextSettings);
      setCrossBorderStatus('当前页面设定已保存。');
      onAction('保存');
      return true;
    } catch (error) {
      if (crossBorderRequestRef.current !== requestId) return false;
      const message = error instanceof Error ? error.message : String(error);
      setCrossBorderStatus(`保存失败：${message}`);
      return false;
    } finally {
      if (crossBorderRequestRef.current === requestId) {
        setCrossBorderLoading(false);
        setCrossBorderLoadingAction('');
      }
    }
  };

  const saveCurrentPageSettingsRef = React.useRef(saveCurrentPageSettings);
  saveCurrentPageSettingsRef.current = saveCurrentPageSettings;
  const handledSaveRequestIdRef = React.useRef(saveRequestId);
  React.useEffect(() => {
    if (saveRequestId === handledSaveRequestIdRef.current) return;
    handledSaveRequestIdRef.current = saveRequestId;
    void saveCurrentPageSettingsRef.current();
  }, [saveRequestId]);

  const updateCrossBorderField = (fieldId, value) => {
    crossBorderRequestRef.current += 1;
    let patch = { [fieldId]: value };
    if (fieldId === 'userName' || fieldId === 'password') {
      patch = {
        ...patch,
        appUid: '',
        accountSaved: false,
        accountSavedAt: '',
        warehouseOptions: [],
        serviceOptions: [],
        cooperationWarehouse: '',
        packageService: '',
        connectionStatus: '账号待授权',
        connectionMessage: '账号信息已修改，请重新获取服务器授权',
      };
      setCrossBorderWarehouseOptions([]);
      setCrossBorderServiceOptions([]);
      setCrossBorderStatus('账号信息已修改，请重新获取服务器授权');
    }
    const next = persistCrossBorderSettings(patch);
    if (fieldId === 'cooperationWarehouse' && value && hasServerCrossBorderAuthorization(next)) {
      fetchCrossBorderServices(next, value).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setCrossBorderMessage(`读取打包服务失败：${message}`);
      });
    }
  };

  const getCrossBorderFieldOptions = (fieldId) => {
    if (fieldId === 'shopIds') return crossBorderShopOptions;
    if (fieldId === 'cooperationWarehouse') return crossBorderWarehouseOptions;
    if (fieldId === 'packageService') return crossBorderServiceOptions;
    return [];
  };

  const getCrossBorderDisplayValue = (fieldId) => {
    if (fieldId === 'cooperationWarehouse') {
      const selected = crossBorderWarehouseOptions.find((option) => option.value === crossBorderSettings[fieldId]);
      return selected?.label || crossBorderSettings.selectedWarehouseLabel || crossBorderSettings[fieldId] || '未选择';
    }
    if (fieldId === 'packageService') {
      const selected = crossBorderServiceOptions.find((option) => option.value === crossBorderSettings[fieldId]);
      return selected?.label || crossBorderSettings.selectedServiceLabel || crossBorderSettings[fieldId] || '未选择';
    }
    return crossBorderSettings[fieldId] || '';
  };

  const profileItems = isCrossBorder
    ? [
          {
            label: '服务器授权',
            value: crossBorderSettings.authorizationRef ? '已授权' : '未授权',
          },
          { label: '绑定店铺', value: `${Array.isArray(crossBorderSettings.shopIds) ? crossBorderSettings.shopIds.length : 0} 个` },
          { label: '仓库数量', value: String(crossBorderWarehouseOptions.length) },
          { label: '打包服务', value: String(crossBorderServiceOptions.length) },
          { label: '合作仓库', value: getCrossBorderDisplayValue('cooperationWarehouse') },
          { label: '保存', value: crossBorderSettings.savedAt || '未保存' },
        ]
    : isPlatformApi
      ? buildPlatformApiProfileItems(selectedRecord)
      : buildStructuredProfileItems(config, selectedRecord);
  const profileChip = isCrossBorder
    ? {
        label: crossBorderSettings.authorizationRef
          ? '服务器已授权'
          : '待授权',
        color: crossBorderSettings.authorizationRef
          ? 'success'
          : 'default',
      }
      : {
        label: selectedRecord.status || config.profileChip.label,
        color: selectedRecord.statusColor || config.profileChip.color,
        };
  const displayRecordCountLabel = isPlatformApi
    ? platformApiReadPending && visibleDisplayRecords.length === 0
      ? '正在读取本机接口账号…'
      : getStructuredRecordCountLabel(config, visibleDisplayRecords.length)
    : getStructuredRecordCountLabel(config, displayRecords.length);
  const profileTitle = isCrossBorder ? config.profileTitle : selectedRecord.title || config.profileTitle;
  const profileSubtitle = isCrossBorder
    ? '企业 API 由管理端统一管理，客户端只保存授权引用'
    : selectedRecord.meta || config.profileSubtitle;
  const selectedIntegrationType = isPlatformApi ? getPlatformIntegrationType(selectedRecord) : '';
  const performanceShopOptions = (Array.isArray(shops) ? shops : [])
    .map((shop) => ({
      value: String(shop?.id || '').trim(),
      label: String(shop?.shopAlias || shop?.alias || shop?.name || shop?.sellerName || shop?.id || '').trim(),
    }))
    .filter((option) => option.value);
  const getStructuredFieldOptions = (field) => {
    if (isPlatformApi && field.id === 'shopId') return performanceShopOptions;
    return Array.isArray(field.options) ? field.options : [];
  };
  const visibleFields = isPlatformApi
    ? config.fields.filter(
        (field) =>
          (!Array.isArray(field.integrationTypes) || field.integrationTypes.includes(selectedIntegrationType))
          && (
            selectedIntegrationType !== 'ozon-browser-session'
            || ['integrationType', 'platformName', 'shopId'].includes(field.id)
          )
      )
    : config.fields;
  const visibleActions = isPlatformApi
    ? selectedIntegrationType === 'ozon-browser-session'
      ? []
      : config.actions.filter(
        (action) =>
          action !== '测试连接'
          || ['seerfar-open-api', 'linkfox-agent', 'ozon-performance', 'wecom-group-bot'].includes(selectedIntegrationType)
      )
    : config.actions;
  const visibleStructuredSections = isCrossBorder
    ? (config.sections || [])
      .filter((section) => section.title !== '企业接口')
      .map((section) => (
        section.title === '账号资料'
          ? { ...section, buttonLabel: '' }
          : section
      ))
    : config.sections;
  return (
    <Box
      className={`shop-settings-layout${isPlatformApi ? ' platform-api-layout' : ''}${
        isCrossBorder ? ' cross-border-settings-layout' : ''
      }`}
    >
      <Box className="shop-list-card">
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} mb={1.5}>
          <Box>
            <Typography variant="h6">{config.listTitle}</Typography>
            <Typography variant="body2" color="text.secondary">
              {displayRecordCountLabel}
            </Typography>
          </Box>
          <Button size="small" variant="contained" onClick={handleAddRecord}>
            {config.addLabel}
          </Button>
        </Stack>
        <Stack spacing={1} className="shop-list">
          {isPlatformApi && visibleDisplayRecords.length === 0 ? (
            <Box className="platform-api-empty-state">
              <Typography variant="subtitle2">
                {platformApiReadPending ? '正在读取已保存接口' : '还没有外部接口'}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {platformApiReadPending
                  ? 'Ozon 登录、Performance 和外部数据接口会分别返回，先返回的先显示。'
                  : '点击“添加接口”，再选择 Ozon 登录、Seerfar、LinkFox 或其他服务。'}
              </Typography>
            </Box>
          ) : null}
          {visibleDisplayRecords.map((record) => (
            <Box
              key={record.id}
              component="button"
              type="button"
              className={`shop-list-item${record.id === selectedRecord.id ? ' active' : ''}`}
              onClick={() => handleSelectRecord(record)}
            >
              <Box>
                <Typography variant="subtitle1">{record.title}</Typography>
                <Typography variant="caption" color="text.secondary" noWrap>
                  {record.meta}
                </Typography>
              </Box>
              <Chip
                size="small"
                color={record.statusColor}
                label={record.isTransientDraft ? '未保存' : record.status}
                variant="outlined"
              />
            </Box>
          ))}
        </Stack>
        {!isPlatformApi || visibleDisplayRecords.length > 0 ? (
          <Button
            className="shop-remove-button"
            size="small"
            color="error"
            variant="outlined"
            disabled={
              (isCrossBorder && crossBorderLoading && crossBorderLoadingAction === config.removeLabel)
              || (isPlatformApi && platformApiLoading)
              || (isPurchaseAccount && purchaseAccountLoading)
            }
            onClick={handleDeleteRecord}
          >
            {isCrossBorder && crossBorderLoadingAction === config.removeLabel
              ? '删除中'
              : isPlatformApi && platformApiLoading
                ? '处理中'
              : isPurchaseAccount && purchaseAccountLoading
                ? '处理中'
                : config.removeLabel}
          </Button>
        ) : null}
      </Box>

      <Box className="shop-settings-detail">
        <Box className="shop-settings-main">
          <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1.5} mb={2}>
            <Box>
              <Typography variant="h6">{config.mainTitle}</Typography>
              <Typography variant="body2" color="text.secondary">
                {isCrossBorder
                  ? '只填写跨境巴士账号和密码完成一次性服务器授权；客户端不保存企业 API 或 Token'
                  : config.mainSubtitle}
              </Typography>
            </Box>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" justifyContent="flex-end">
              <Chip
                color="primary"
                label={isCrossBorder ? '服务器授权' : config.badge}
                variant="outlined"
              />
              {isPurchaseAccount ? <PurchaseAccountLoginActions controller={purchaseBrowserLogin} /> : null}
            </Stack>
          </Stack>

          {visibleStructuredSections ? (
            <Box className="structured-form-sections" key={`${config.id}-${selectedRecord.id}`}>
              {visibleStructuredSections.map((section) => (
                <Box key={section.title} className="structured-form-section">
                  {(() => {
                    const isCurrentCrossBorderAction =
                      isCrossBorder && crossBorderLoading && crossBorderLoadingAction === section.buttonLabel;
                    const isCurrentCrossBorderAuthorization =
                      isCrossBorder
                      && crossBorderLoading
                      && crossBorderLoadingAction === section.authorizationButtonLabel;
                    return (
                      <>
                        <Typography variant="h6">{section.title}</Typography>
                        <Box className="structured-form-row">
                          <Box className="structured-form-fields">
                            {section.fields.map((field) =>
                              (() => {
                                const fieldOptions = isCrossBorder
                                  ? getCrossBorderFieldOptions(field.id)
                                  : getStructuredFieldOptions(field);
                                const fieldValue = getVisibleStructuredFieldValue(field.id);
                                const isMultipleField = field.multiple === true;
                                const fieldDisplayValue =
                                  isCrossBorder &&
                                  fieldOptions.length === 0 &&
                                  (field.id === 'cooperationWarehouse' || field.id === 'packageService')
                                    ? getCrossBorderDisplayValue(field.id)
                                    : fieldValue;
                                const selectValue = isMultipleField
                                  ? (Array.isArray(fieldValue)
                                      ? fieldValue.filter((value) => fieldOptions.some((option) => option.value === value))
                                      : [])
                                  : fieldOptions.length > 0 && !fieldOptions.some((option) => option.value === fieldValue)
                                    ? ''
                                    : fieldDisplayValue;
                                const crossBorderSecretSaved =
                                  (field.id === 'userName' && crossBorderSettings.hasUserName) ||
                                  (field.id === 'password' && crossBorderSettings.hasPassword) ||
                                  (field.id === 'companySecret' && crossBorderSettings.hasCompanySecret) ||
                                  (field.id === 'accessToken' && crossBorderSettings.hasAccessToken) ||
                                  (field.id === 'appUid' && crossBorderSettings.hasAppUid);
                                const structuredSecretSaved =
                                  (isPurchaseAccount && field.id === 'loginPassword' && selectedRecord.values?.hasLoginPassword) ||
                                   (isPlatformApi &&
                                     field.id === 'performanceClientSecret' &&
                                     (selectedRecord.values?.hasPerformanceClientSecret || selectedRecord.values?.hasClientSecret)) ||
                                   (isPlatformApi && field.id === 'apiKey' && selectedRecord.values?.hasApiKey) ||
                                   (isPlatformApi && field.id === 'wecomWebhook' && selectedRecord.values?.hasWecomWebhook) ||
                                   (isPlatformApi && field.id === 'loginPassword' && selectedRecord.values?.hasLoginPassword);
                                const savedSecretHint = isCrossBorder
                                  ? crossBorderSettings[`${field.id}Hint`] || ''
                                  : field.id === 'loginPassword'
                                    ? selectedRecord.values?.loginPasswordHint || ''
                                     : field.id === 'performanceClientSecret'
                                       ? selectedRecord.values?.performanceClientSecretHint || ''
                                       : field.id === 'apiKey'
                                         ? selectedRecord.values?.apiKeyHint || ''
                                         : field.id === 'wecomWebhook'
                                           ? selectedRecord.values?.wecomWebhookHint || ''
                                         : field.id === 'loginPassword'
                                           ? selectedRecord.values?.loginPasswordHint || ''
                                       : '';
                                const isSavedSecretField = crossBorderSecretSaved || structuredSecretSaved;
                                const inputValue = isSavedSecretField
                                  ? toCredentialMaskValue(fieldValue, true)
                                  : fieldValue;
                                const input = (
                                  <TextField
                                    key={field.id}
                                    className={field.className}
                                    size="small"
                                    label={isCrossBorder ? undefined : field.label}
                                    type={field.type}
                                    value={isMultipleField
                                      ? selectValue
                                      : isCrossBorder
                                        ? (isSavedSecretField ? toCredentialMaskValue(selectValue, true) : selectValue)
                                        : inputValue}
                                    placeholder={
                                      isCrossBorder && crossBorderSecretSaved
                                        ? savedSecretHint || '••••••••••'
                                        : !isCrossBorder && structuredSecretSaved
                                          ? savedSecretHint || '••••••••••'
                                        : isCrossBorder
                                          ? ''
                                          : field.placeholder
                                    }
                                    multiline={field.multiline}
                                    minRows={field.minRows}
                                    required={field.required}
                                    select={fieldOptions.length > 0 || isMultipleField}
                                    SelectProps={{
                                      MenuProps: STABLE_SELECT_MENU_PROPS,
                                      ...(isMultipleField
                                        ? {
                                            multiple: true,
                                            renderValue: (values) => {
                                              const selectedValues = Array.isArray(values) ? values : [];
                                              return selectedValues
                                                .map(
                                                  (value) =>
                                                    fieldOptions.find((option) => option.value === value)?.label || value
                                                )
                                                .join('、');
                                            },
                                          }
                                        : {}),
                                    }}
                                    onFocus={isSavedSecretField ? selectCredentialMaskOnFocus : undefined}
                                    onChange={
                                      isCrossBorder
                                        ? (event) =>
                                            updateCrossBorderField(
                                              field.id,
                                              isSavedSecretField
                                                ? toStoredCredentialValue(event.target.value)
                                                : event.target.value
                                            )
                                        : (event) =>
                                            updateStructuredRecordField(
                                              field.id,
                                              isSavedSecretField
                                                ? toStoredCredentialValue(event.target.value)
                                                : event.target.value
                                            )
                                    }
                                  >
                                    {fieldOptions.map((option) => (
                                      <MenuItem key={option.value} value={option.value}>
                                        {option.label}
                                      </MenuItem>
                                    ))}
                                  </TextField>
                                );
                                if (!isCrossBorder) return input;
                                return (
                                  <Box key={field.id} className="structured-field">
                                    <Typography className="structured-field-label" variant="subtitle2">
                                      {field.label}
                                    </Typography>
                                    {input}
                                  </Box>
                                );
                              })()
                            )}
                          </Box>
                          {isCrossBorder && section.authorizationButtonLabel ? (
                            <Box className="structured-form-actions">
                              <Button
                                variant="contained"
                                disabled={isCurrentCrossBorderAuthorization}
                                onClick={() => handleCrossBorderSectionAction(section.authorizationButtonLabel)}
                              >
                                {isCurrentCrossBorderAuthorization ? '授权中' : section.authorizationButtonLabel}
                              </Button>
                              {section.buttonLabel ? (
                                <Button
                                  variant="contained"
                                  disabled={isCurrentCrossBorderAction}
                                  onClick={() => handleCrossBorderSectionAction(section.buttonLabel)}
                                >
                                  {isCurrentCrossBorderAction ? '处理中' : section.buttonLabel}
                                </Button>
                              ) : null}
                            </Box>
                          ) : section.buttonLabel ? (
                            <Button
                              variant="contained"
                              disabled={isCurrentCrossBorderAction}
                              onClick={() =>
                                isCrossBorder
                                  ? handleCrossBorderSectionAction(section.buttonLabel)
                                  : onAction(section.buttonLabel)
                              }
                            >
                              {isCurrentCrossBorderAction ? '处理中' : section.buttonLabel}
                            </Button>
                          ) : null}
                        </Box>
                      </>
                    );
                  })()}
                </Box>
              ))}
            </Box>
          ) : (
            <Box className="shop-form-grid" key={`${config.id}-${selectedRecord.id}`}>
              {visibleFields.map((field) => {
                const fieldOptions = getStructuredFieldOptions(field);
                const fieldValue = getVisibleStructuredFieldValue(field.id);
                const savedStructuredSecret =
                  (isPlatformApi &&
                    field.id === 'performanceClientSecret' &&
                    (selectedRecord.values?.hasPerformanceClientSecret || selectedRecord.values?.hasClientSecret)) ||
                  (isPlatformApi && field.id === 'apiKey' && selectedRecord.values?.hasApiKey) ||
                  (isPlatformApi && field.id === 'wecomWebhook' && selectedRecord.values?.hasWecomWebhook) ||
                  (isPlatformApi && field.id === 'loginPassword' && selectedRecord.values?.hasLoginPassword) ||
                  (isPurchaseAccount && field.id === 'loginPassword' && selectedRecord.values?.hasLoginPassword);
                const savedSecretHint =
                  field.id === 'performanceClientSecret'
                    ? selectedRecord.values?.performanceClientSecretHint || ''
                    : field.id === 'loginPassword'
                      ? selectedRecord.values?.loginPasswordHint || ''
                      : field.id === 'apiKey'
                        ? selectedRecord.values?.apiKeyHint || ''
                      : field.id === 'wecomWebhook'
                        ? selectedRecord.values?.wecomWebhookHint || ''
                      : '';
                const fieldPlaceholder =
                  savedStructuredSecret
                    ? savedSecretHint || '••••••••••'
                    : field.placeholder;
                const inputValue = savedStructuredSecret ? toCredentialMaskValue(fieldValue, true) : fieldValue;
                return (
                  <TextField
                    key={field.id}
                    className={field.className}
                    size="small"
                    label={field.label}
                    type={field.type}
                    value={inputValue}
                    onFocus={savedStructuredSecret ? selectCredentialMaskOnFocus : undefined}
                    onChange={(event) =>
                      updateStructuredRecordField(
                        field.id,
                        savedStructuredSecret ? toStoredCredentialValue(event.target.value) : event.target.value
                      )
                    }
                    placeholder={fieldPlaceholder}
                    multiline={field.multiline}
                    minRows={field.minRows}
                    required={field.required}
                    select={fieldOptions.length > 0}
                    SelectProps={{ MenuProps: STABLE_SELECT_MENU_PROPS }}
                  >
                    {fieldOptions.map((option) => (
                      <MenuItem key={option.value} value={option.value}>
                        {option.label}
                      </MenuItem>
                    ))}
                  </TextField>
                );
              })}
            </Box>
          )}

          {selectedIntegrationType === 'ozon-browser-session' ? (
            <OzonBrowserLoginPanel
              key={selectedRecord.id}
              connected={
                isOzonShopSellerLoginConnected(selectedRecord.values || {})
              }
              cookieStatus={selectedRecord.values?.tokenStatus}
              lastVerifiedAt={selectedRecord.values?.lastTestAt}
              requireCompanyIdentity
              onEnsureProfile={() => saveCurrentIntegrationProfile('保存接口资料', { silent: true })}
              onConnected={handleOzonBrowserConnected}
            />
          ) : config.showNote !== false && (config.noteTitle || config.note) ? (
            <Box className="shop-connect-note">
              <Typography variant="subtitle1">{config.noteTitle}</Typography>
              <Typography variant="body2" color="text.secondary">
                {config.note}
              </Typography>
            </Box>
          ) : null}

          {visibleActions?.length ? (
            <Box className="settings-module-actions">
              {visibleActions.map((action) => (
                <Button
                  key={action}
                  size="small"
                  variant="outlined"
                  disabled={(isPlatformApi && platformApiLoading) || (isPurchaseAccount && purchaseAccountLoading)}
                  onClick={() =>
                    isPlatformApi
                      ? handlePlatformApiAction(action)
                      : isPurchaseAccount
                        ? handlePurchaseAccountAction(action)
                        : onAction(action)
                  }
                >
                  {isPlatformApi && platformApiLoading && action === '测试连接'
                    ? '测试中'
                    : isPurchaseAccount && purchaseAccountLoading
                      ? '处理中'
                      : action}
                </Button>
              ))}
            </Box>
          ) : null}
        </Box>

        <Box className="shop-settings-side">
          <Box className="shop-profile-card">
            <Stack direction="row" alignItems="center" spacing={1.5}>
              <Avatar className={`store-avatar ${config.avatarClass}`}>{config.avatarIcon}</Avatar>
              <Box>
                <Typography variant="subtitle1">{profileTitle}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {profileSubtitle}
                </Typography>
              </Box>
            </Stack>
            <Divider sx={{ my: 1.5 }} />
            <Box className="shop-profile-grid">
              {profileItems.map((item) => (
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
                <Chip size="small" color={profileChip.color} label={profileChip.label} variant="outlined" />
              </Box>
            </Box>
            <Box className="shop-test-result">
              <Typography variant="caption" color="text.secondary">
                操作记录
              </Typography>
              <Typography variant="body2">
                {isCrossBorder
                  ? crossBorderStatus || actionNote
                  : isPlatformApi
                    ? platformApiStatus || selectedRecord.values?.lastTestMessage || actionNote
                    : isPurchaseAccount
                      ? purchaseAccountStatus || actionNote
                      : actionNote}
              </Typography>
            </Box>
          </Box>

        </Box>
      </Box>
      <AccountRemovalPreviewDialog
        flow={accountRemoval.flow}
        busy={accountRemoval.busy}
        onConfirm={accountRemoval.confirmRemoval}
        onExportBackup={accountRemoval.exportBackupBeforeRemoval}
        onUseRecentBackup={accountRemoval.useRecentBackupBeforeRemoval}
        onSkipBackup={accountRemoval.skipBackupBeforeRemoval}
        onRefresh={accountRemoval.refreshPreview}
        onClose={accountRemoval.closeAccountRemoval}
      />
    </Box>
  );
}

export { StructuredSettingsLayout };
export default StructuredSettingsLayout;
