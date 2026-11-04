import { randomUUID } from 'node:crypto';
import { BUILTIN_CROSS_BORDER_PROFILE_OWNER_TYPE } from './purchaseBrowserBuiltinProfile.js';

const CROSS_BORDER_URL = 'https://www.kuajing84.com/';
const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

const PINDUODUO_ROUTES = Object.freeze({
  'pinduoduo-home': '/',
  'pinduoduo-personal': '/personal.html',
  'pinduoduo-orders': '/orders.html',
  'pinduoduo-addresses': '/addresses.html',
});

function currentTab(controller, requestedTabId = '') {
  const state = controller?.snapshot?.() || {};
  const tabs = Array.isArray(state.tabs) ? state.tabs : [];
  const exactTabId = String(requestedTabId || '').trim() || String(state.activeTabId || '').trim();
  const tab = tabs.find((candidate) => candidate.tabId === exactTabId) || null;
  if (!tab?.tabId) fail('PURCHASE_BROWSER_TAB_NOT_FOUND');
  return { state, tab };
}

function isPinduoduoPage(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    const hostname = parsed.hostname.toLowerCase();
    return ['http:', 'https:'].includes(parsed.protocol)
      && (hostname === 'yangkeduo.com'
        || hostname.endsWith('.yangkeduo.com')
        || hostname === 'pinduoduo.com'
        || hostname.endsWith('.pinduoduo.com'));
  } catch {
    return false;
  }
}

function ownerTypeInput(tab = {}) {
  const ownerType = String(tab?.ownerType || '').trim();
  return ownerType ? { ownerType } : {};
}

function loginFrom(value = {}) {
  return value?.result?.login || value?.result || {};
}

function requireCrossBorderLogin(login = {}) {
  const code = String(login.code || '').trim();
  if (login.ok === false && /^(?:CROSS_BORDER|PURCHASE_BROWSER)_[A-Z0-9_]+$/u.test(code)) fail(code);
  if (login.loggedIn !== true) fail('CROSS_BORDER_LOGIN_REQUIRED');
}

function isCrossBorderPageUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    const hostname = parsed.hostname.toLowerCase();
    return ['http:', 'https:'].includes(parsed.protocol)
      && (hostname === 'kuajing84.com' || hostname.endsWith('.kuajing84.com'))
      && parsed.pathname.toLowerCase() === '/index/finance/record_consume.html';
  } catch {
    return false;
  }
}

function selectedCrossBorderChargePage(value) {
  if (!isCrossBorderPageUrl(value)) fail('CROSS_BORDER_CHARGE_PAGE_REQUIRED');
  const parsed = new URL(String(value).trim());
  const params = new URLSearchParams(parsed.search);
  const hashQueryAt = parsed.hash.indexOf('?');
  if (hashQueryAt >= 0) {
    const hashParams = new URLSearchParams(parsed.hash.slice(hashQueryAt + 1));
    hashParams.forEach((entry, key) => {
      if (!params.has(key)) params.set(key, entry);
    });
  }
  const firstParam = (...keys) => {
    for (const key of keys) {
      const entry = String(params.get(key) || '').trim();
      if (entry) return entry;
    }
    return '';
  };
  return {
    pageUrl: parsed.toString(),
    time: firstParam('time'),
    searchTime: firstParam('search_time', 'searchTime'),
    reason: firstParam('reason'),
  };
}

function compactObject(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => (
    entry !== undefined && entry !== null && entry !== ''
  )));
}

function wangzaiPluginStatus(tab = {}) {
  const extension = tab.extension && typeof tab.extension === 'object' ? tab.extension : {};
  return compactObject({
    enabled: extension.installState === 'active',
    version: extension.extensionVersion,
    runtimeKind: 'builtin',
    connectionMode: '内置在当前浏览器窗口，无需单独安装图标',
    capabilities: '插件状态、识别当前页面',
    safety: '只读；不自动保存货源、不下单、不写 Ozon',
    pageUrl: tab.url,
  });
}

function wangzaiInspectionResult(inspection = {}, tab = {}) {
  return compactObject({
    enabled: true,
    version: inspection.extensionVersion || tab.extension?.extensionVersion,
    runtimeKind: inspection.runtimeKind || 'builtin',
    platform: inspection.platform,
    pageUrl: inspection.pageUrl || tab.url,
    pageTitle: inspection.pageTitle,
    productTitle: inspection.productTitle,
    variant: inspection.variant,
    quantity: inspection.quantity,
    amount: inspection.amount,
    orderNumber: inspection.orderNumber,
    pageType: inspection.pageType,
    purchaseOrderNumber: inspection.purchaseOrderNumber || inspection.orderNumber,
    purchasePrice: inspection.purchasePrice ?? inspection.amount,
    currency: inspection.currency,
    sourceUrl: inspection.sourceUrl || inspection.pageUrl || tab.url,
    trackingNumber: inspection.trackingNumber,
    carrierName: inspection.carrierName,
    logisticsStatus: inspection.logisticsStatus || inspection.status,
    sourceConfidence: inspection.sourceConfidence,
    status: inspection.status,
  });
}

function verifiedReadback(result, readback) {
  const lastSync = readback?.result?.lastSync;
  return Boolean(
    result?.result?.commit === true
    && lastSync?.commit === true
    && lastSync?.finishedAt
    && lastSync.finishedAt === result.result.finishedAt
    && Number(lastSync.total) === Number(result.result.total)
    && Number(lastSync.synced) === Number(result.result.synced),
  );
}

function logisticsRowEvidence(row = {}) {
  const source = row?.logistics && typeof row.logistics === 'object' ? row.logistics : row || {};
  return {
    trackingNumber: String(source.trackingNumber || '').trim(),
    carrierName: String(source.carrierName || source.carrier || '').trim(),
  };
}

function packageIdentity(row = {}) {
  return {
    orderId: String(row?.orderId || '').trim(),
    packId: String(row?.packId || '').trim(),
  };
}

function packageKey(row = {}) {
  const identity = packageIdentity(row);
  return identity.orderId ? JSON.stringify([identity.orderId, identity.packId]) : '';
}

function logisticsRowsMatchExpected(rows = [], expectedLogistics = []) {
  const expected = Array.isArray(expectedLogistics) ? expectedLogistics : [];
  return expected.every((evidence) => {
    const row = (Array.isArray(rows) ? rows : []).find(
      (candidate) => packageKey(candidate) === packageKey(evidence),
    );
    const actual = logisticsRowEvidence(row);
    return Boolean(
      row?.ok === true
      && actual.trackingNumber
      && actual.carrierName
      && actual.carrierName !== '未知快递公司'
      && actual.trackingNumber === String(evidence?.trackingNumber || '').trim()
      && actual.carrierName === String(evidence?.carrierName || '').trim(),
    );
  });
}

function verifiedPackageReadback(result = {}, readback = {}, expectedLogistics = []) {
  if (!verifiedReadback(result, readback)) return false;
  const expected = new Set(
    (Array.isArray(expectedLogistics) ? expectedLogistics : [])
      .map(packageKey)
      .filter(Boolean),
  );
  if (!expected.size) return false;
  const rows = Array.isArray(readback?.result?.lastSync?.results)
    ? readback.result.lastSync.results
    : [];
  const matched = rows.filter((row) => expected.has(packageKey(row)));
  if (matched.length !== expected.size
    || new Set(matched.map(packageKey)).size !== expected.size) return false;
  if (!matched.every((row) => {
    const { trackingNumber, carrierName } = logisticsRowEvidence(row);
    return row?.ok === true
      && row?.status === '已同步'
      && trackingNumber
      && carrierName
      && carrierName !== '未知快递公司';
  })) return false;
  return logisticsRowsMatchExpected(matched, expectedLogistics);
}

function selectUniqueCrossBorderOrders(rows = [], target = {}) {
  const candidates = Array.isArray(rows) ? rows : [];
  const keys = new Set([
    target?.orderKey,
    target?.ozonOrderId,
    target?.purchaseRecordId,
    target?.purchaseOrderNumber,
  ].map((value) => String(value || '').trim()).filter(Boolean));
  const exact = candidates.filter((row) => [row?.orderId, row?.orderKey, row?.ozonOrderId, row?.orderNumber]
    .some((value) => keys.has(String(value || '').trim())));
  if (exact.length) {
    const orderIds = new Set(exact.map((row) => packageIdentity(row).orderId).filter(Boolean));
    if (orderIds.size !== 1) fail('CROSS_BORDER_TARGET_AMBIGUOUS');
    if (exact.length > 1) {
      const packageKeys = exact.map(packageKey);
      if (
        exact.some((row) => !packageIdentity(row).packId)
        || packageKeys.some((value) => !value)
        || new Set(packageKeys).size !== exact.length
      ) fail('CROSS_BORDER_TARGET_AMBIGUOUS');
    }
    return exact;
  }
  // A single unrelated row is still not proof of identity. Never fall back
  // to “the only order on screen”; the target must match an explicit key.
  fail('CROSS_BORDER_TARGET_AMBIGUOUS');
}

function verifiedLogisticsRows(result = {}) {
  const rows = Array.isArray(result?.results) ? result.results : [];
  return rows.filter((row) => {
    const logistics = row?.logistics && typeof row.logistics === 'object' ? row.logistics : row || {};
    return String(logistics.trackingNumber || '').trim()
      && String(logistics.carrierName || logistics.carrier || '').trim();
  });
}

function syncPreviewEvidence(result = {}) {
  const rows = Array.isArray(result?.results) ? result.results : [];
  const values = (selector) => [...new Set(rows.map(selector).map((value) => String(value || '').trim()).filter(Boolean))];
  const carriers = values((row) => row?.logistics?.carrierName || row?.logistics?.carrier || row?.carrierName || row?.carrier);
  const trackingNumbers = values((row) => row?.logistics?.trackingNumber || row?.trackingNumber);
  const statuses = values((row) => row?.logistics?.status || row?.logisticsStatus || row?.status);
  return {
    carrierName: carriers.length === 1 ? carriers[0] : '',
    trackingNumber: trackingNumbers.length === 1 ? trackingNumbers[0] : '',
    logisticsStatus: statuses.length === 1 ? statuses[0] : statuses.join('、'),
  };
}

function sameSyncTarget(left = {}, right = {}) {
  return ['targetId', 'shopId', 'orderKey', 'ozonOrderId', 'sku', 'offerId', 'purchaseRecordId']
    .every((field) => String(left?.[field] || '').trim() === String(right?.[field] || '').trim());
}

export function createPurchaseBrowserToolbarActionHandler({
  getController,
  getLocalApiClient = () => null,
  onCollectionPricingCapture = async () => ({ delivered: false }),
  onPurchaseLoginSaved = async () => ({ delivered: false }),
  onCrossBorderChargesCommitted = async () => ({ delivered: false }),
  now = () => Date.now(),
  createConfirmationToken = () => randomUUID(),
  createPreviewId = () => `cross_border_preview_${randomUUID()}`,
} = {}) {
  if (typeof getController !== 'function') fail('PURCHASE_BROWSER_TOOLBAR_DEPENDENCY_REQUIRED');
  const confirmations = new Map();
  const chargeConfirmations = new Map();

  async function crossBorder(controller, tabId, command, payload) {
    return controller.dispatch({ command, tabId, ...(payload ? { payload } : {}) });
  }

  async function handle({ action, payload = {}, tabId: requestedTabId = '' } = {}) {
    const controller = getController();
    if (!controller?.dispatch || !controller?.snapshot) fail('PURCHASE_BROWSER_TOOLBAR_UNAVAILABLE');
    const recoveryOpenActions = new Set([
      'retry-open',
      'reopen-browser',
      'cross-border-reopen',
      'cross-border-relogin',
    ]);
    const currentState = controller.snapshot() || {};
    const currentTabs = Array.isArray(currentState.tabs) ? currentState.tabs : [];
    const currentTabId = String(currentState.activeTabId || '');
    const hasCurrentTab = Boolean(currentTabs.find((candidate) => candidate?.tabId === currentTabId));
    if (recoveryOpenActions.has(action) && !hasCurrentTab) {
      const accountId = String(payload?.accountId || '').trim().slice(0, 180);
      if (!accountId) fail('PURCHASE_BROWSER_WINDOW_INVALID');
      const requestedUrl = String(payload?.url || '').trim().slice(0, 1800);
      const url = requestedUrl || (action.startsWith('cross-border-') ? CROSS_BORDER_URL : 'about:blank');
      return controller.dispatch({ command: 'open', accountId, url });
    }
    const { state, tab } = currentTab(controller, requestedTabId);
    const tabId = tab.tabId;

    if (PINDUODUO_ROUTES[action]) {
      if (!isPinduoduoPage(tab.url)) fail('PURCHASE_BROWSER_PINDUODUO_PAGE_REQUIRED');
      return controller.dispatch({
        command: 'navigate',
        tabId,
        url: `https://mobile.yangkeduo.com${PINDUODUO_ROUTES[action]}`,
      });
    }

    if (action === 'browser-extensions') {
      return controller.dispatch({ command: 'open-extension-manager', tabId });
    }

    if (action === 'wangzai-status') {
      return {
        ...state,
        toolbar: {
          dialog: {
            kind: 'wangzai-status',
            title: '旺崽助手插件状态',
            result: wangzaiPluginStatus(tab),
          },
        },
      };
    }
    if (action === 'wangzai-inspect') {
      const response = await controller.dispatch({ command: 'inspect', tabId });
      return {
        ...response,
        toolbar: {
          dialog: {
            kind: 'wangzai-inspect',
            title: '旺崽助手页面识别',
            result: wangzaiInspectionResult(response.inspection, tab),
          },
        },
      };
    }

    if (action === 'account-status') {
      return {
        ...state,
        toolbar: {
          dialog: {
            kind: 'account-status',
            title: '当前账号状态',
            result: {
              phase: tab.phase,
              health: tab.health,
              sessionGeneration: tab.generation,
              page: tab.url,
              targetLocked: Boolean(tab.target),
              targetPhase: tab.targetPhase || (tab.target ? 'target-locked' : 'idle'),
              proxyMode: tab.proxyConfigured ? '固定代理' : '直连',
            },
          },
        },
      };
    }

    if (action === 'purchase-login-save') {
      const isOzonIntegrationProfile = tab.ownerType === 'integration_profile';
      const isCrossBorderBuiltinProfile = tab.ownerType === BUILTIN_CROSS_BORDER_PROFILE_OWNER_TYPE;
      const response = await controller.dispatch(
        isOzonIntegrationProfile
          ? { command: 'ozon-login-status', tabId, persistStatus: true }
          : isCrossBorderBuiltinProfile
            ? { command: 'cross-border-login-status', tabId }
            : { command: 'purchase-login-status', tabId },
      );
      const verification = response?.result || {};
      if (isCrossBorderBuiltinProfile) {
        if (verification.loggedIn !== true) {
          return {
            ...response,
            toolbar: {
              dialog: {
                kind: 'purchase-login-save-failed',
                title: '跨境巴士登录未确认',
                result: verification,
              },
            },
          };
        }
        return {
          ...response,
          toolbar: {
            dialog: {
              kind: 'purchase-login-saved',
              title: '跨境巴士登录已确认',
              autoClose: true,
              result: {
                loggedIn: true,
                userCode: String(verification.userCode || '').trim(),
              },
            },
          },
        };
      }
      if (verification.loggedIn !== true || verification.cookieSaved !== true) {
        return {
          ...response,
          toolbar: {
            dialog: {
              kind: 'purchase-login-save-failed',
              title: '登录信息未保存',
              result: verification,
            },
          },
        };
      }
      if (isOzonIntegrationProfile) {
        const profile = verification.profile || {};
        if (
          String(profile.id || '') !== String(tab.accountId || '')
          || profile.tokenStatus !== 'Cookie 已保存'
        ) {
          fail('PURCHASE_BROWSER_INTEGRATION_LOGIN_READBACK_FAILED');
        }
        const identityStatus = String(profile.identityStatus || '').trim();
        const configStatus = String(profile.configStatus || '').trim();
        if (identityStatus === 'mismatch' || configStatus === '账号不匹配') {
          return {
            ...response,
            profile,
            toolbar: {
              dialog: {
                kind: 'purchase-login-shop-mismatch',
                title: 'Ozon 店铺账号不匹配',
                result: {
                  profileId: profile.id,
                  browserCompanyId: profile.browserCompanyId || '',
                  apiIdentityId: profile.apiIdentityId || '',
                  identityStatus: identityStatus || 'mismatch',
                },
              },
            },
          };
        }
        const identityVerified = identityStatus === 'verified'
          || (!identityStatus && configStatus === '连接成功');
        if (!identityVerified) {
          const identityPendingStatuses = new Set(['', 'unverified', 'api-missing', 'browser-matched']);
          const identityPendingConfigStatuses = new Set([
            '待核对',
            '等待账号识别',
            '等待 API 核对',
            '缺少 API Client ID',
          ]);
          if (
            !identityPendingStatuses.has(identityStatus)
            || !identityPendingConfigStatuses.has(configStatus)
          ) {
            fail('PURCHASE_BROWSER_INTEGRATION_LOGIN_READBACK_FAILED');
          }
          return {
            ...response,
            profile,
            toolbar: {
              dialog: {
                kind: 'purchase-login-identity-pending',
                title: 'Ozon 登录已保存',
                autoClose: true,
                result: {
                  profileId: profile.id,
                  cookieStatus: profile.tokenStatus,
                  configStatus,
                  identityStatus: identityStatus || 'unverified',
                  browserCompanyId: profile.browserCompanyId || '',
                  lastLoginVerifiedAt: verification.verifiedAt,
                },
              },
            },
          };
        }
        if (configStatus !== '连接成功') {
          fail('PURCHASE_BROWSER_INTEGRATION_LOGIN_READBACK_FAILED');
        }
        return {
          ...response,
          profile,
          toolbar: {
            dialog: {
              kind: 'purchase-login-saved',
              title: 'Ozon 账号已保存',
              autoClose: true,
              result: {
                profileId: profile.id,
                cookieStatus: profile.tokenStatus,
                lastLoginVerifiedAt: verification.verifiedAt,
              },
            },
          },
        };
      }
      const localApiClient = getLocalApiClient();
      if (!localApiClient?.savePurchaseAccountLoginStatus) {
        fail('PURCHASE_BROWSER_LOGIN_STATUS_SERVICE_UNAVAILABLE');
      }
      const saved = await localApiClient.savePurchaseAccountLoginStatus(tab.accountId, {
        loggedIn: true,
        cookieSaved: true,
        verifiedAt: verification.verifiedAt,
        platformKey: verification.platformKey,
        verificationSource: verification.verificationSource,
      });
      if (saved?.account?.cookieStatus !== 'Cookie 已保存') {
        fail('PURCHASE_BROWSER_LOGIN_READBACK_FAILED');
      }
      await onPurchaseLoginSaved({
        accountId: tab.accountId,
        tabId,
        account: saved.account,
        verification,
        state: response.state,
      });
      return {
        ...response,
        account: saved.account,
        toolbar: {
          dialog: {
            kind: 'purchase-login-saved',
            title: '登录信息已保存',
            autoClose: true,
            result: {
              accountId: tab.accountId,
              cookieStatus: saved.account.cookieStatus,
              lastLoginVerifiedAt: saved.account.lastLoginVerifiedAt,
            },
          },
        },
      };
    }

    if (action === 'more') {
      return {
        ...state,
        toolbar: {
          dialog: {
            kind: 'more',
            title: '恢复与诊断',
            result: {
              recovery: '窗口关闭只会隐藏并保留登录会话；浏览器卡死时点击设置页“重新打开”，系统才会隔离并重建当前会话。',
              retry: '页面加载失败时可点击地址栏刷新；错误状态不会永久停留在加载中。',
              diagnostics: '当前会话、代际和健康状态可在“账号状态”中查看。',
            },
          },
        },
      };
    }

    if (action === 'target-mode') {
      if (!tab.target) {
        return {
          ...state,
          toolbar: {
            dialog: {
            kind: 'target-required',
            title: '目标模式',
            result: { 提示: '请先在拍单管理中明确点击“锁定目标”，选择订单和商品后再进行捕捉。浏览器不会后台猜测或替换目标。' },
            },
          },
        };
      }
      const cleared = await controller.dispatch({ command: 'clear-target', tabId });
      return {
        ...cleared,
        toolbar: {
          dialog: {
            kind: 'target-cleared',
            title: '目标模式已解除',
            result: { 提示: '当前浏览器仍保留登录状态，但捕捉信息不会再提交到原目标。' },
          },
        },
      };
    }

    if (action === 'capture-purchase') {
      const response = await controller.dispatch({ command: 'capture-preview', tabId });
      return {
        ...response,
        toolbar: {
          dialog: {
            kind: response.preview ? 'capture-preview' : 'capture-result',
            title: response.preview ? '采购信息捕捉预览' : '采购信息捕捉结果',
            result: response.preview || response.capture,
            confirmationToken: response.preview?.confirmationToken || '',
          },
        },
      };
    }

    if (action === 'collection-pricing-capture') {
      const response = await controller.dispatch({ command: 'capture-purchase', tabId });
      const capture = response?.capture || response?.inspection || null;
      if (!capture || (!capture.productTitle && !capture.sourceProductId && capture.purchasePrice == null)) {
        fail('PURCHASE_BROWSER_CAPTURE_EMPTY');
      }
      await onCollectionPricingCapture({
        capture,
        tabId,
        accountId: tab.accountId,
        sourceUrl: capture.sourceUrl || capture.pageUrl || tab.url,
      });
      return {
        ...response,
        toolbar: {
          dialog: {
            kind: 'collection-pricing-captured',
            title: '已采集到操作台',
            result: {
              productTitle: capture.productTitle || capture.pageTitle || capture.sourceProductId,
              sourceUrl: capture.sourceUrl || capture.pageUrl || tab.url,
            },
          },
        },
      };
    }

    if (action === 'capture-retry') {
      return handle({ action: 'capture-purchase', payload, tabId });
    }

    if (action === 'capture-confirm') {
      const response = await controller.dispatch({
        command: 'capture-confirm',
        tabId,
        confirmationToken: payload?.confirmationToken,
        acceptConflicts: payload?.acceptConflicts === true,
      });
      return {
        ...response,
        toolbar: {
          dialog: {
            kind: 'capture-complete',
            title: '采购信息已回填',
            result: { ...response.result, readbackVerified: true },
          },
        },
      };
    }

    if (action === 'navigate') {
      const rawUrl = String(payload?.url || '').trim();
      const url = !rawUrl
        ? ''
        : /^[a-z][a-z0-9+.-]*:\/\//iu.test(rawUrl)
          ? rawUrl
          : `https://${rawUrl}`;
      return controller.dispatch({ command: 'navigate', tabId, url });
    }
    if (['back', 'forward', 'reload'].includes(action)) {
      return controller.dispatch({ command: action, tabId });
    }
    if (action === 'cross-border-open') {
      return controller.dispatch({
        command: 'open',
        accountId: tab.accountId,
        ...ownerTypeInput(tab),
        url: CROSS_BORDER_URL,
      });
    }
    if (action === 'cross-border-charges-open') {
      chargeConfirmations.delete(tabId);
      const opened = await controller.dispatch({
        command: 'open',
        accountId: tab.accountId,
        ...ownerTypeInput(tab),
        url: CROSS_BORDER_URL,
      });
      return {
        ...opened,
        toolbar: {
          dialog: {
            kind: 'cross-border-charges-opened',
            title: '跨境巴士实际扣费',
            result: {
              提示: '跨境巴士已打开。请先完成登录，再进入要读取的预报费用页面，最后点击“保存生效”。',
            },
          },
        },
      };
    }
    if (action === 'cross-border-retry-logistics') {
      return handle({ action: 'cross-border-sync-preview', payload, tabId });
    }
    if (action === 'cross-border-relogin') {
      return handle({ action: 'cross-border-open', payload, tabId });
    }
    if (action === 'cross-border-reopen') {
      return controller.dispatch({
        command: 'open',
        accountId: tab.accountId,
        ...ownerTypeInput(tab),
        url: tab.url || CROSS_BORDER_URL,
      });
    }
    if (action === 'retry-open' || action === 'reopen-browser') {
      return controller.dispatch({
        command: 'open',
        accountId: tab.accountId,
        ...ownerTypeInput(tab),
        url: tab.url || 'about:blank',
      });
    }
    if (action === 'cross-border-reenter-target') {
      const cleared = await controller.dispatch({ command: 'clear-target', tabId });
      return {
        ...cleared,
        toolbar: {
          dialog: {
            kind: 'target-required',
            title: '请重新进入目标模式',
            result: { 提示: '目标已清除，请回到拍单管理明确选择订单和商品并点击“锁定目标”。' },
          },
        },
      };
    }
    if (action === 'cross-border-login-status') {
      const response = await crossBorder(controller, tabId, 'cross-border-login-status');
      const login = loginFrom(response);
      return {
        ...response,
        toolbar: {
          loggedIn: login.loggedIn === true,
          dialog: { kind: 'login-status', title: '跨境巴士登录状态', result: login },
        },
      };
    }
    if (action === 'cross-border-orders') {
      const response = await crossBorder(controller, tabId, 'cross-border-orders');
      return {
        ...response,
        toolbar: {
          dialog: { kind: 'orders', title: '跨境巴士订单', result: response.result },
        },
      };
    }
    if (action === 'cross-border-logistics') {
      const response = await crossBorder(controller, tabId, 'cross-border-sync', { commit: false });
      return {
        ...response,
        toolbar: {
          loggedIn: response.result?.loggedIn === true,
          dialog: { kind: 'logistics', title: '物流读取结果', result: response.result },
        },
      };
    }
    if (action === 'cross-border-status') {
      const response = await crossBorder(controller, tabId, 'cross-border-status');
      const login = loginFrom(response);
      return {
        ...response,
        toolbar: {
          loggedIn: login.loggedIn === true,
          dialog: { kind: 'status', title: '跨境巴士状态', result: response.result },
        },
      };
    }
    if (
      action === 'cross-border-charges-save'
      || action === 'cross-border-charges-preview'
      || action === 'cross-border-charges'
    ) {
      const localApiClient = getLocalApiClient();
      if (!localApiClient?.previewCrossBorderCharges) fail('CROSS_BORDER_CHARGE_SERVICE_UNAVAILABLE');
      const chargePage = selectedCrossBorderChargePage(tab.url);
      const response = await crossBorder(controller, tabId, 'cross-border-charges', {
        pageUrl: chargePage.pageUrl,
        pageSize: payload?.pageSize,
        maxPages: payload?.maxPages,
        includeDetails: payload?.includeDetails === true,
        time: payload?.time ?? chargePage.time,
        searchTime: payload?.searchTime ?? chargePage.searchTime,
        reason: payload?.reason ?? chargePage.reason,
      });
      const source = response?.result || {};
      if (source.loggedIn === false || source.ok === false) requireCrossBorderLogin(source);
      // 实际扣费由同一个跨境巴士账号读取后，按预报单号/Ozon 订单号在
      // local-api 内精确匹配所有已绑定店铺。不能继承当前操作台 target.shopId，
      // 否则一个浏览器只会更新当前店，其他店永远读不到。
      const shopId = String(payload?.shopId || '').trim();
      const crossBorderAccountId = String(payload?.crossBorderAccountId || '').trim();
      const previewInput = {
        browserAccountRef: String(source.browserAccountRef || tab.storageRef || '').trim(),
        externalAccountRef: String(source.userCode || '').trim(),
        ...(crossBorderAccountId ? { crossBorderAccountId } : {}),
        ...(shopId ? { shopId } : {}),
        charges: Array.isArray(source.charges) ? source.charges : [],
        orders: Array.isArray(source.orders) ? source.orders : [],
      };
      const preview = await localApiClient.previewCrossBorderCharges(
        previewInput,
        shopId ? { shopId } : {},
      );
      const displayPreview = {
        ...preview,
        selectedPageUrl: String(source.selectedPageUrl || chargePage.pageUrl).trim(),
        pagination: source.pagination && typeof source.pagination === 'object'
          ? source.pagination
          : {},
        detailCoverage: source.detailCoverage && typeof source.detailCoverage === 'object' ? { ...source.detailCoverage } : null,
      };
      chargeConfirmations.set(tabId, {
        previewId: preview.previewId,
        confirmationToken: preview.confirmationToken,
        expiresAt: Date.parse(preview.expiresAt || '') || (Date.now() + CONFIRMATION_TTL_MS),
        storageRef: String(tab.storageRef || '').trim(),
        shopId,
        pageUrl: chargePage.pageUrl,
        detailCoverage: displayPreview.detailCoverage,
      });
      return {
        ...response,
        preview: displayPreview,
        toolbar: {
          loggedIn: source.loggedIn !== false,
          dialog: {
            kind: 'cross-border-charges-preview',
            title: '跨境巴士实际扣费预览',
            result: displayPreview,
            confirmationToken: preview.confirmationToken,
            confirmationAction: 'cross-border-charges-confirm',
          },
        },
      };
    }
    if (action === 'cross-border-charges-confirm') {
      const localApiClient = getLocalApiClient();
      const confirmation = chargeConfirmations.get(tabId);
      if (!localApiClient?.confirmCrossBorderCharges || !confirmation || confirmation.expiresAt < Date.now()) {
        chargeConfirmations.delete(tabId);
        fail('CROSS_BORDER_CHARGE_PREVIEW_REQUIRED');
      }
      if (
        String(payload?.confirmationToken || '') !== confirmation.confirmationToken
        || String(tab.storageRef || '').trim() !== confirmation.storageRef
      ) fail('CROSS_BORDER_CHARGE_CONFIRMATION_REQUIRED');
      chargeConfirmations.delete(tabId);
      const committed = await localApiClient.confirmCrossBorderCharges({
        previewId: confirmation.previewId,
        confirmationToken: confirmation.confirmationToken,
      }, confirmation.shopId ? { shopId: confirmation.shopId } : {});
      if (committed?.readbackVerified !== true || committed?.ok !== true) {
        fail('CROSS_BORDER_CHARGE_READBACK_FAILED');
      }
      await onCrossBorderChargesCommitted({
        tabId,
        accountId: tab.accountId,
        shopId: confirmation.shopId,
        committed,
      });
      return {
        ...committed,
        toolbar: {
          dialog: {
            kind: 'cross-border-charges-complete',
            title: '实际扣费已写入本地账本',
            result: { ...committed, detailCoverage: confirmation.detailCoverage },
          },
        },
      };
    }
    if (action === 'cross-border-sync-preview') {
      const purchaseContext = await controller.dispatch({ command: 'purchase-context', tabId });
      if (!purchaseContext?.target?.orderKey || !purchaseContext?.context?.purchaseOrderNumber) {
        fail('CROSS_BORDER_PACKAGE_CONTEXT_MISSING');
      }
      const loginResponse = await crossBorder(controller, tabId, 'cross-border-login-status');
      const login = loginFrom(loginResponse);
      requireCrossBorderLogin(login);
      const orderResponse = await crossBorder(controller, tabId, 'cross-border-orders');
      const orderRows = Array.isArray(orderResponse?.result?.orders) ? orderResponse.result.orders : [];
      const matchedOrders = selectUniqueCrossBorderOrders(orderRows, {
        ...purchaseContext.target,
        purchaseOrderNumber: purchaseContext.context.purchaseOrderNumber,
      });
      const expectedPackages = matchedOrders.map(packageIdentity);
      const expectedPackageKeys = new Set(expectedPackages.map(packageKey));
      const expectedOrderIds = [...new Set(expectedPackages.map((row) => row.orderId))];
      const beforeResponse = await crossBorder(controller, tabId, 'cross-border-status');
      const preview = await crossBorder(controller, tabId, 'cross-border-sync', {
        commit: false,
        orderIds: expectedOrderIds,
      });
      const verifiedRows = verifiedLogisticsRows(preview.result).filter((row) => (
        expectedPackageKeys.has(packageKey(row))
        && String(row?.logistics?.trackingNumber || '').trim()
        && String(row?.logistics?.carrierName || row?.logistics?.carrier || '').trim() !== '未知快递公司'
      ));
      if (
        verifiedRows.length !== expectedPackages.length
        || new Set(verifiedRows.map(packageKey)).size !== expectedPackages.length
      ) fail('CROSS_BORDER_PACKAGE_CONTEXT_MISSING');
      const expectedLogistics = expectedPackages.map((identity) => ({
        ...identity,
        ...logisticsRowEvidence(
          verifiedRows.find((row) => packageKey(row) === packageKey(identity)),
        ),
      }));
      const token = String(createConfirmationToken());
      const previewId = String(createPreviewId());
      const expiresAtMs = now() + CONFIRMATION_TTL_MS;
      const evidence = syncPreviewEvidence(preview.result);
      confirmations.set(tabId, {
        previewId,
        token,
        expiresAt: expiresAtMs,
        orderKey: purchaseContext.target.orderKey,
        purchaseOrderNumber: purchaseContext.context.purchaseOrderNumber,
        target: purchaseContext.target,
        expectedOrderIds,
        expectedPackages,
        expectedLogistics,
        previewResult: preview.result,
      });
      return {
        ...preview,
        previewId,
        confirmationToken: token,
        target: purchaseContext.target,
        carrierName: evidence.carrierName,
        trackingNumber: evidence.trackingNumber,
        logisticsStatus: evidence.logisticsStatus,
        before: beforeResponse?.result?.lastSync || null,
        after: preview.result,
        expiresAt: new Date(expiresAtMs).toISOString(),
        readbackRequired: true,
        toolbar: {
          loggedIn: true,
          dialog: {
            kind: 'sync-preview',
            title: '同步物流预览',
            result: preview.result,
            confirmationToken: token,
          },
        },
      };
    }
    if (action === 'cross-border-sync-confirm') {
      const confirmation = confirmations.get(tabId);
      if (
        !confirmation
        || confirmation.expiresAt < now()
      ) fail('CROSS_BORDER_SYNC_PREVIEW_REQUIRED');
      if (String(payload?.confirmationToken || '') !== confirmation.token) {
        fail('CROSS_BORDER_CONFIRMATION_REQUIRED');
      }
      confirmations.delete(tabId);
      const loginResponse = await crossBorder(controller, tabId, 'cross-border-login-status');
      requireCrossBorderLogin(loginFrom(loginResponse));
      const purchaseContext = await controller.dispatch({ command: 'purchase-context', tabId });
      if (
        purchaseContext?.target?.orderKey !== confirmation.orderKey
        || purchaseContext?.context?.purchaseOrderNumber !== confirmation.purchaseOrderNumber
        || !sameSyncTarget(purchaseContext.target, confirmation.target)
      ) fail('CROSS_BORDER_CONFIRMATION_REQUIRED');
      const orderResponse = await crossBorder(controller, tabId, 'cross-border-orders');
      const orderRows = Array.isArray(orderResponse?.result?.orders) ? orderResponse.result.orders : [];
      const currentOrders = selectUniqueCrossBorderOrders(orderRows, {
        ...purchaseContext.target,
        purchaseOrderNumber: purchaseContext.context.purchaseOrderNumber,
      });
      const expectedPackageKeys = new Set(confirmation.expectedPackages.map(packageKey));
      if (
        currentOrders.length !== expectedPackageKeys.size
        || currentOrders.some((row) => !expectedPackageKeys.has(packageKey(row)))
      ) {
        fail('CROSS_BORDER_TARGET_AMBIGUOUS');
      }
      const committed = await crossBorder(controller, tabId, 'cross-border-sync', {
        commit: true,
        confirmed: true,
        orderIds: confirmation.expectedOrderIds,
      });
      if (!logisticsRowsMatchExpected(committed.result?.results, confirmation.expectedLogistics)) {
        fail('CROSS_BORDER_READBACK_FAILED');
      }
      const readback = await crossBorder(controller, tabId, 'cross-border-status');
      if (!verifiedPackageReadback(
        committed,
        readback,
        confirmation.expectedLogistics,
      )) fail('CROSS_BORDER_READBACK_FAILED');
      const evidence = syncPreviewEvidence(committed.result);
      return {
        ...committed,
        previewId: confirmation.previewId,
        target: purchaseContext.target,
        carrierName: evidence.carrierName,
        trackingNumber: evidence.trackingNumber,
        logisticsStatus: evidence.logisticsStatus,
        readbackRequired: true,
        readbackVerified: true,
        toolbar: {
          loggedIn: true,
          dialog: {
            kind: 'sync-complete',
            title: '同步完成',
            result: { ...committed.result, readbackVerified: true },
          },
        },
      };
    }
    fail('PURCHASE_BROWSER_COMMAND_INVALID');
  }

  return Object.freeze({ handle });
}
