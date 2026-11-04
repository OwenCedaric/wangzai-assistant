import {
  BUILTIN_CROSS_BORDER_PROFILE_OWNER_TYPE,
  CROSS_BORDER_LOGISTICS_PROFILE_ACCOUNT_ID,
} from './purchaseBrowserBuiltinProfile.js';

const CROSS_BORDER_HOME_URL = 'https://www.kuajing84.com/';
const SUPPORTED_PLATFORMS = Object.freeze(['1688', 'taobao', 'tmall', 'pinduoduo']);

function syncError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function clean(value, maximum = 240) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

export function normalizePurchaseLogisticsPlatform(value) {
  const text = clean(value, 80).toLowerCase();
  if (text === '1688' || text.includes('阿里巴巴')) return '1688';
  if (text === 'taobao' || text.includes('淘宝')) return 'taobao';
  if (text === 'tmall' || text.includes('天猫')) return 'tmall';
  if (['pdd', 'pinduoduo'].includes(text) || text.includes('拼多多')) return 'pinduoduo';
  return '';
}

function purchasePlatformLabel(value) {
  const platform = normalizePurchaseLogisticsPlatform(value);
  if (platform === 'taobao') return '淘宝';
  if (platform === 'tmall') return '天猫';
  if (platform === 'pinduoduo') return '拼多多';
  return platform;
}

function samePurchasePlatformFamily(left, right) {
  const normalizedLeft = normalizePurchaseLogisticsPlatform(left);
  const normalizedRight = normalizePurchaseLogisticsPlatform(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  return ['taobao', 'tmall'].includes(normalizedLeft)
    && ['taobao', 'tmall'].includes(normalizedRight);
}

function normalizeRequestedOrderNumbers(values = []) {
  const rows = Array.isArray(values) ? values : [values];
  return rows
    .map((value) => clean(value, 180))
    .filter((value, index, all) => value && all.indexOf(value) === index);
}

function normalizePurchaseOrderStatus(value) {
  const text = clean(value, 160);
  const rules = [
    [/极速退款成功|退款成功|已退款|退款完成/u, '退款成功'],
    [/交易关闭|订单关闭|已关闭|已取消|交易取消/u, '交易关闭'],
    [/交易成功|已完成/u, '交易成功'],
    [/已发货|待收货|等待买家收货/u, '已发货'],
    [/买家已付款|已付款|待发货|等待卖家发货|等待商家发货/u, '待发货'],
    [/待付款|等待付款/u, '待付款'],
  ];
  return rules.find(([pattern]) => pattern.test(text))?.[1] || text;
}

function normalizeDirectPurchaseResult(response = {}, { orderNumber, platform, account } = {}) {
  const purchase = response?.purchase && typeof response.purchase === 'object'
    ? response.purchase
    : {};
  const capturedOrderNumber = clean(purchase.purchaseOrderNumber || purchase.orderNumber, 180);
  const capturedPlatform = normalizePurchaseLogisticsPlatform(purchase.platform || platform);
  const purchasePrice = Number(purchase.purchasePrice);
  const purchaseOrderStatus = normalizePurchaseOrderStatus(
    purchase.purchaseOrderStatus || purchase.orderStatus || purchase.status,
  );
  if (
    response?.ok !== true
    || response?.pluginVerified !== true
    || capturedOrderNumber !== orderNumber
    || !samePurchasePlatformFamily(capturedPlatform, platform)
    || !Number.isFinite(purchasePrice)
    || purchasePrice <= 0
    || !purchaseOrderStatus
  ) return null;
  return Object.freeze({
    ok: true,
    pluginVerified: true,
    readMethod: 'cross-border-sync-plugin-direct',
    accountId: clean(account?.id, 128),
    accountAlias: clean(account?.accountAlias || account?.name || account?.title, 160),
    platform: capturedPlatform,
    platformLabel: purchasePlatformLabel(capturedPlatform),
    purchaseOrderNumber: capturedOrderNumber,
    purchasePrice,
    currency: clean(purchase.currency, 12) || 'CNY',
    purchaseOrderStatus,
    paymentConfirmed: purchase.paymentConfirmed === true,
    refundConfirmed: purchase.refundConfirmed === true,
    logistics: response?.logistics && typeof response.logistics === 'object'
      ? { ...response.logistics }
      : {},
    sourceMethod: clean(purchase.sourceMethod, 120),
    fetchedAt: clean(purchase.fetchedAt || purchase.capturedAt, 80),
  });
}

function accountRows(payload = {}) {
  if (Array.isArray(payload?.accounts)) return payload.accounts;
  if (Array.isArray(payload?.rows)) return payload.rows;
  return [];
}

export function selectExactPurchaseLogisticsAccount(accounts = [], platform = '') {
  const normalizedPlatform = normalizePurchaseLogisticsPlatform(platform);
  if (!SUPPORTED_PLATFORMS.includes(normalizedPlatform)) {
    throw syncError('CROSS_BORDER_PLATFORM_UNSUPPORTED', { platform: normalizedPlatform || clean(platform, 80) });
  }
  const candidates = accounts.filter((account) => (
    normalizePurchaseLogisticsPlatform(account?.platformName || account?.platform) === normalizedPlatform
  ));
  if (!candidates.length) {
    throw syncError('CROSS_BORDER_PURCHASE_ACCOUNT_MISSING', { platform: normalizedPlatform });
  }
  if (candidates.length === 1) return candidates[0];
  const defaults = candidates.filter((account) => account?.isDefault === true);
  if (defaults.length === 1) return defaults[0];
  throw syncError('CROSS_BORDER_PURCHASE_ACCOUNT_AMBIGUOUS', {
    platform: normalizedPlatform,
    accountIds: candidates.map((account) => clean(account?.id, 128)).filter(Boolean),
  });
}

function responseResult(response = {}) {
  return response?.result && typeof response.result === 'object' ? response.result : response;
}

function findTab(state = {}, { accountId, ownerType = '' } = {}) {
  const tabs = Array.isArray(state?.tabs) ? state.tabs : [];
  return tabs.find((tab) => (
    clean(tab?.accountId, 128) === clean(accountId, 128)
    && (!ownerType || clean(tab?.ownerType, 80) === ownerType)
  )) || null;
}

function packageKey(order = {}) {
  return `${clean(order?.orderId, 180)}\u0000${clean(order?.packId, 180)}`;
}

function normalizePendingOrder(order = {}) {
  return Object.freeze({
    orderId: clean(order?.orderId, 180),
    packId: clean(order?.packId, 180),
    collectionNumber: clean(order?.collectionNumber, 180),
    orderStatus: clean(order?.orderStatus, 120),
    fromName: clean(order?.fromName, 40),
    forecastTime: clean(order?.forecastTime, 80),
  });
}

function publicFailure(order, error, extra = {}) {
  return {
    ...order,
    ok: false,
    status: '同步失败',
    errorCode: clean(error?.code || error?.message || 'CROSS_BORDER_LOGISTICS_SYNC_FAILED', 160),
    ...extra,
  };
}

async function mapWithConcurrency(rows = [], limit = 8, worker) {
  const output = new Array(rows.length);
  let cursor = 0;
  const concurrency = Math.max(1, Math.min(rows.length || 1, Number(limit) || 1));
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await worker(rows[index], index);
    }
  }));
  return output;
}

function exactPurchaseOrderNumber(value) {
  return clean(value, 180);
}

function exactPostingFromOverride(override = {}, fallback = '') {
  const direct = clean(fallback, 180);
  if (direct) return direct;
  const orderKey = clean(override.orderKey || override.order_key || override.postingNumber, 240);
  if (orderKey.includes(':')) return clean(orderKey.split(':').at(-1), 180);
  return clean(override.ozonOrderId || override.ozon_order_id || orderKey, 180);
}

export function createPurchaseDomesticLogisticsPatch(logistics = {}, options = {}) {
  const carrier = clean(logistics.carrier || logistics.carrierName, 100);
  const trackingNumber = clean(logistics.trackingNumber, 180);
  if (!carrier || !trackingNumber) return null;
  const syncedAt = clean(options.syncedAt, 80) || new Date().toISOString();
  const sourceMethod = clean(
    logistics.sourceMethod || options.sourceMethod || 'cross-border-bus-plugin-original-v1.0.8',
    120,
  );
  return Object.freeze({
    carrierName: carrier,
    expressCompany: carrier,
    domesticCourierCompany: carrier,
    trackingNumber,
    logisticsOrder: trackingNumber,
    domesticTrackingNumber: trackingNumber,
    purchaseTrackingNumber: trackingNumber,
    domesticLogisticsStatus: '已发货',
    purchaseLogisticsStatus: '已发货',
    domesticLogisticsSyncStatus: clean(options.syncStatus, 80) || '已读取',
    domesticLogisticsSyncedAt: syncedAt,
    domesticLogisticsSource: sourceMethod,
  });
}

export async function mirrorPurchaseDomesticLogistics({
  order = {},
  logistics = {},
  syncStatus = '已读取',
  listPurchaseOverrides,
  savePurchaseOverride,
  saveCrossBorderRecord,
} = {}) {
  const purchaseOrderNumber = exactPurchaseOrderNumber(order.orderId || order.purchaseOrderNumber);
  const patch = createPurchaseDomesticLogisticsPatch(logistics, { syncStatus });
  if (!purchaseOrderNumber || !patch) {
    return { ok: false, matched: 0, saved: 0, failed: 0, errorCode: 'CROSS_BORDER_LOGISTICS_EVIDENCE_INVALID' };
  }
  if (
    typeof listPurchaseOverrides !== 'function'
    || typeof savePurchaseOverride !== 'function'
    || typeof saveCrossBorderRecord !== 'function'
  ) {
    return { ok: true, matched: 0, saved: 0, failed: 0, persistenceAvailable: false };
  }
  let payload;
  try {
    payload = await listPurchaseOverrides({ keyword: purchaseOrderNumber, limit: 200 });
  } catch (error) {
    return {
      ok: false,
      matched: 0,
      saved: 0,
      failed: 1,
      purchaseOrderNumber,
      errorCode: clean(error?.code || error?.message || 'PURCHASE_DOMESTIC_LOGISTICS_LOCAL_READ_FAILED', 160),
    };
  }
  const exactOverrides = (Array.isArray(payload?.rows) ? payload.rows : [])
    .filter((override) => exactPurchaseOrderNumber(
      override?.purchaseOrderNumber || override?.purchase_order_number || override?.manualPurchaseOrderNo,
    ) === purchaseOrderNumber);
  let saved = 0;
  let failed = 0;
  for (const override of exactOverrides) {
    const shopId = clean(override.shopId || override.shop_id, 128);
    const orderKey = clean(override.orderKey || override.order_key || override.postingNumber, 240);
    if (!shopId || !orderKey) {
      failed += 1;
      continue;
    }
    const platformOrder = exactPostingFromOverride(override, order.collectionNumber);
    const recordKey = [platformOrder || purchaseOrderNumber, clean(order.packId, 180) || patch.trackingNumber]
      .filter(Boolean)
      .join(':');
    try {
      await savePurchaseOverride({
        ...override,
        ...patch,
        shopId,
        orderKey,
      });
      await saveCrossBorderRecord({
        ...patch,
        shopId,
        recordKey,
        orderId: clean(order.packId, 180) || platformOrder,
        platformOrder,
        collectionNumber: clean(order.collectionNumber, 180),
        purchaseOrderNumber,
        trackingNumber: patch.trackingNumber,
        logisticsOrder: patch.trackingNumber,
        status: patch.domesticLogisticsStatus,
        readStatus: patch.domesticLogisticsSyncStatus,
        source: patch.domesticLogisticsSource,
      });
      saved += 1;
    } catch {
      failed += 1;
    }
  }
  return {
    ok: failed === 0,
    matched: exactOverrides.length,
    saved,
    failed,
    purchaseOrderNumber,
  };
}

export function createPurchaseLogisticsSyncService({
  listAccounts,
  openSession,
  executeCommand,
  listPurchaseOverrides,
  savePurchaseOverride,
  saveCrossBorderRecord,
  emitProgress = () => undefined,
} = {}) {
  if (
    typeof listAccounts !== 'function'
    || typeof openSession !== 'function'
    || typeof executeCommand !== 'function'
  ) {
    throw syncError('CROSS_BORDER_LOGISTICS_SYNC_DEPENDENCY_REQUIRED');
  }

  let activeRun = null;
  let activeDirectRead = null;

  async function ensureTab(openInput, expected) {
    const state = await openSession(openInput);
    const tab = findTab(state, expected);
    if (!tab?.tabId) throw syncError('PURCHASE_BROWSER_TAB_NOT_FOUND', expected);
    return tab;
  }

  async function execute() {
    if (activeRun) return activeRun;
    activeRun = (async () => {
      const startedAt = new Date().toISOString();
      emitProgress({ stage: 'bus-login', completed: 0, total: 0, message: '正在核对跨境巴士登录状态' });
      const busTab = await ensureTab({
        accountId: CROSS_BORDER_LOGISTICS_PROFILE_ACCOUNT_ID,
        ownerType: BUILTIN_CROSS_BORDER_PROFILE_OWNER_TYPE,
        url: CROSS_BORDER_HOME_URL,
        restoreVisible: false,
      }, {
        accountId: CROSS_BORDER_LOGISTICS_PROFILE_ACCOUNT_ID,
        ownerType: BUILTIN_CROSS_BORDER_PROFILE_OWNER_TYPE,
      });
      const login = responseResult(await executeCommand({
        tabId: busTab.tabId,
        command: 'cross-border-login-status',
      }));
      if (login?.loggedIn !== true) {
        throw syncError('CROSS_BORDER_LOGIN_REQUIRED', { loginWindowRequired: true });
      }

      const pendingResponse = responseResult(await executeCommand({
        tabId: busTab.tabId,
        command: 'cross-border-orders',
      }));
      const pending = (Array.isArray(pendingResponse?.orders) ? pendingResponse.orders : [])
        .map(normalizePendingOrder)
        .filter((order, index, rows) => (
          order.orderId
          && order.packId
          && rows.findIndex((candidate) => packageKey(candidate) === packageKey(order)) === index
        ));
      if (!pending.length) {
        return {
          ok: true,
          total: 0,
          synced: 0,
          notShipped: 0,
          failed: 0,
          pendingReadback: 0,
          results: [],
          startedAt,
          finishedAt: new Date().toISOString(),
        };
      }

      const accounts = accountRows(await listAccounts());
      const accountByPlatform = new Map();
      const tabByAccountId = new Map();
      const results = [];

      for (let index = 0; index < pending.length; index += 1) {
        const order = pending[index];
        emitProgress({
          stage: 'supplier-read',
          completed: index,
          total: pending.length,
          message: `正在读取国内物流 ${index + 1}/${pending.length}`,
        });
        try {
          const platform = normalizePurchaseLogisticsPlatform(order.fromName);
          let account = accountByPlatform.get(platform);
          if (!account) {
            account = selectExactPurchaseLogisticsAccount(accounts, platform);
            accountByPlatform.set(platform, account);
          }
          const accountId = clean(account?.id, 128);
          if (!accountId) throw syncError('CROSS_BORDER_PURCHASE_ACCOUNT_MISSING', { platform });
          let supplierTab = tabByAccountId.get(accountId);
          if (!supplierTab) {
            supplierTab = await ensureTab({
              accountId,
              ownerType: 'purchase_account',
              url: clean(account?.platformUrl, 1000),
              restoreVisible: false,
            }, { accountId, ownerType: 'purchase_account' });
            const purchaseLogin = responseResult(await executeCommand({
              tabId: supplierTab.tabId,
              command: 'purchase-login-status',
            }));
            if (purchaseLogin?.loggedIn !== true || purchaseLogin?.cookieSaved !== true) {
              throw syncError('CROSS_BORDER_PURCHASE_LOGIN_REQUIRED', { accountId, platform });
            }
            tabByAccountId.set(accountId, supplierTab);
          }

          const supplierRead = responseResult(await executeCommand({
            tabId: supplierTab.tabId,
            command: 'cross-border-sync',
            payload: { mode: 'supplier-read', commit: false, includePurchaseInfo: true, order },
          }));
          const logistics = supplierRead?.logistics || {};
          const purchase = supplierRead?.purchase && typeof supplierRead.purchase === 'object'
            ? supplierRead.purchase
            : null;
          if (supplierRead?.status === '未发货') {
            results.push({
              ...order,
              ok: false,
              status: '未发货',
              logistics,
              purchase,
              purchaseInfoComplete: supplierRead?.purchaseInfoComplete === true,
              accountId,
            });
            continue;
          }
          if (supplierRead?.ok !== true) {
            throw syncError(supplierRead?.errorCode || 'CROSS_BORDER_SUPPLIER_REQUEST_FAILED');
          }

          const update = responseResult(await executeCommand({
            tabId: busTab.tabId,
            command: 'cross-border-sync',
            payload: {
              mode: 'package-update',
              commit: true,
              confirmed: true,
              order,
              logistics,
            },
          }));
          const localMirror = update?.readbackVerified === true
            ? await mirrorPurchaseDomesticLogistics({
                order,
                logistics,
                syncStatus: '已同步',
                listPurchaseOverrides,
                savePurchaseOverride,
                saveCrossBorderRecord,
              })
            : null;
          results.push({
            ...order,
            accountId,
            logistics,
            purchase,
            purchaseInfoComplete: supplierRead?.purchaseInfoComplete === true,
            ok: update?.readbackVerified === true,
            writeAccepted: update?.writeAccepted === true,
            readbackVerified: update?.readbackVerified === true,
            localMirror,
            status: update?.readbackVerified === true ? '已同步' : '已写入待回读',
            updateMessage: clean(update?.updateMessage, 200),
          });
        } catch (error) {
          results.push(publicFailure(order, error, {
            accountId: clean(error?.accountId, 128),
            platform: clean(error?.platform, 80),
          }));
        }
      }

      const synced = results.filter((row) => row.status === '已同步' && row.readbackVerified === true).length;
      const notShipped = results.filter((row) => row.status === '未发货').length;
      const pendingReadback = results.filter((row) => row.status === '已写入待回读').length;
      const failed = results.length - synced - notShipped - pendingReadback;
      const localFailed = results.reduce((total, row) => total + Number(row.localMirror?.failed || 0), 0);
      emitProgress({
        stage: 'completed',
        completed: pending.length,
        total: pending.length,
        message: `物流同步完成：成功 ${synced}，未发货 ${notShipped}，失败 ${failed}，本地写入失败 ${localFailed}`,
      });
      return {
        ok: failed === 0 && pendingReadback === 0 && localFailed === 0,
        total: pending.length,
        synced,
        notShipped,
        failed,
        pendingReadback,
        localFailed,
        results,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    })();
    try {
      return await activeRun;
    } finally {
      activeRun = null;
    }
  }

  async function readOrders({ orderNumbers = [], platform = '' } = {}) {
    if (activeDirectRead) return activeDirectRead;
    activeDirectRead = (async () => {
      const startedAt = new Date().toISOString();
      const requestedOrderNumbers = normalizeRequestedOrderNumbers(orderNumbers);
      if (!requestedOrderNumbers.length) throw syncError('CROSS_BORDER_PURCHASE_ORDER_NUMBER_REQUIRED');
      const requestedPlatform = normalizePurchaseLogisticsPlatform(platform);
      if (platform && !requestedPlatform) {
        throw syncError('CROSS_BORDER_PLATFORM_UNSUPPORTED', { platform: clean(platform, 80) });
      }

      const accounts = accountRows(await listAccounts())
        .map((account) => {
          const accountPlatform = normalizePurchaseLogisticsPlatform(account?.platformName || account?.platform);
          return {
            account,
            accountPlatform,
            platform: requestedPlatform && samePurchasePlatformFamily(requestedPlatform, accountPlatform)
              ? requestedPlatform
              : accountPlatform,
          };
        })
        .filter((entry) => (
          SUPPORTED_PLATFORMS.includes(entry.platform)
          && (!requestedPlatform || samePurchasePlatformFamily(entry.accountPlatform, requestedPlatform))
        ));
      if (!accounts.length) {
        throw syncError('CROSS_BORDER_PURCHASE_ACCOUNT_MISSING', { platform: requestedPlatform });
      }

      const accountReadiness = await Promise.all(accounts.map(async (entry) => {
        const accountId = clean(entry.account?.id, 128);
        if (!accountId) return null;
        try {
          const tab = await ensureTab({
            accountId,
            ownerType: 'purchase_account',
            url: clean(entry.account?.platformUrl, 1000),
            restoreVisible: false,
          }, { accountId, ownerType: 'purchase_account' });
          const login = responseResult(await executeCommand({
            tabId: tab.tabId,
            command: 'purchase-login-status',
          }));
          if (login?.loggedIn !== true || login?.cookieSaved !== true) {
            throw syncError('CROSS_BORDER_PURCHASE_LOGIN_REQUIRED', {
              accountId,
              platform: entry.platform,
            });
          }
          return { ok: true, entry: { ...entry, accountId, tab } };
        } catch (error) {
          return { ok: false, unavailable: {
            accountId,
            platform: entry.platform,
            errorCode: clean(error?.code || error?.message, 160),
          } };
        }
      }));
      const readyAccounts = accountReadiness
        .filter((row) => row?.ok === true)
        .map((row) => row.entry);
      const unavailableAccounts = accountReadiness
        .filter((row) => row?.ok === false)
        .map((row) => row.unavailable);
      if (!readyAccounts.length) {
        throw syncError('CROSS_BORDER_PURCHASE_LOGIN_REQUIRED', { unavailableAccounts });
      }

      emitProgress({
        stage: 'supplier-order-read',
        completed: 0,
        total: requestedOrderNumbers.length,
        message: `正在并行匹配 ${requestedOrderNumbers.length} 个采购单`,
      });

      const probesByOrder = new Map(requestedOrderNumbers.map((orderNumber) => [orderNumber, []]));
      const accountBatches = readyAccounts.map((entry) => {
        const candidateOrderNumbers = requestedOrderNumbers.filter((orderNumber) => {
          if (requestedPlatform) return true;
          return entry.platform === 'pinduoduo' ? orderNumber.includes('-') : !orderNumber.includes('-');
        });
        return { entry, candidateOrderNumbers };
      }).filter((batch) => batch.candidateOrderNumbers.length > 0);

      const batchResults = await Promise.all(accountBatches.map(async ({ entry, candidateOrderNumbers }) => {
        try {
          const response = responseResult(await executeCommand({
            tabId: entry.tab.tabId,
            command: 'cross-border-sync',
            payload: {
              mode: 'supplier-orders-read',
              commit: false,
              orders: candidateOrderNumbers.map((orderNumber) => ({
                orderId: orderNumber,
                fromName: purchasePlatformLabel(entry.platform),
              })),
            },
          }));
          const rows = Array.isArray(response?.results) ? response.results : [];
          return candidateOrderNumbers.map((orderNumber) => {
            const candidate = rows.find((row) => clean(
              row?.order?.orderId || row?.purchase?.purchaseOrderNumber || row?.purchase?.orderNumber,
              180,
            ) === orderNumber);
            const normalized = normalizeDirectPurchaseResult(candidate, {
              orderNumber,
              platform: entry.platform,
              account: entry.account,
            });
            return normalized || {
              ok: false,
              purchaseOrderNumber: orderNumber,
              platform: entry.platform,
              accountId: entry.accountId,
              errorCode: clean(candidate?.errorCode || 'CROSS_BORDER_PURCHASE_ORDER_NOT_FOUND', 160),
            };
          });
        } catch (error) {
          return candidateOrderNumbers.map((orderNumber) => ({
            ok: false,
            purchaseOrderNumber: orderNumber,
            platform: entry.platform,
            accountId: entry.accountId,
            errorCode: clean(error?.code || error?.message || 'CROSS_BORDER_PURCHASE_ORDER_NOT_FOUND', 160),
          }));
        }
      }));
      batchResults.flat().forEach((probe) => {
        const orderNumber = clean(probe?.purchaseOrderNumber, 180);
        if (probesByOrder.has(orderNumber)) probesByOrder.get(orderNumber).push(probe);
      });

      const results = requestedOrderNumbers.map((orderNumber) => {
        const probes = probesByOrder.get(orderNumber) || [];
        const matches = probes.filter((row) => row?.ok === true);
        if (matches.length === 1) {
          return matches[0];
        }
        if (matches.length > 1) {
          return {
            ok: false,
            purchaseOrderNumber: orderNumber,
            status: '匹配到多个采购账号',
            errorCode: 'CROSS_BORDER_PURCHASE_ORDER_AMBIGUOUS',
            matches,
          };
        }
        const failures = probes.filter((row) => row?.ok === false);
        const primaryFailure = failures.find((row) => row.errorCode !== 'CROSS_BORDER_PURCHASE_ORDER_NOT_FOUND')
          || failures[0];
        return {
          ok: false,
          purchaseOrderNumber: orderNumber,
          status: primaryFailure?.errorCode === 'CROSS_BORDER_PURCHASE_ORDER_INCOMPLETE'
            ? '已找到订单，但金额或状态尚未读取完整'
            : primaryFailure?.errorCode === 'CROSS_BORDER_PURCHASE_LOGIN_REQUIRED'
              ? '采购账号需要重新登录'
              : '未找到采购订单',
          errorCode: primaryFailure?.errorCode || 'CROSS_BORDER_PURCHASE_ORDER_NOT_FOUND',
        };
      });

      const mirroredResults = await mapWithConcurrency(results, 8, async (row) => {
        if (row?.ok !== true || !createPurchaseDomesticLogisticsPatch(row.logistics)) return row;
        const localMirror = await mirrorPurchaseDomesticLogistics({
          order: { orderId: row.purchaseOrderNumber },
          logistics: row.logistics,
          syncStatus: '已读取',
          listPurchaseOverrides,
          savePurchaseOverride,
          saveCrossBorderRecord,
        });
        return { ...row, localMirror };
      });
      const matched = mirroredResults.filter((row) => row.ok === true).length;
      const failed = mirroredResults.length - matched;
      const localFailed = mirroredResults.reduce((total, row) => total + Number(row.localMirror?.failed || 0), 0);
      emitProgress({
        stage: 'supplier-order-completed',
        completed: requestedOrderNumbers.length,
        total: requestedOrderNumbers.length,
        message: `采购订单直接读取完成：匹配 ${matched}，未匹配 ${failed}`,
      });
      return {
        ok: failed === 0 && localFailed === 0,
        directRead: true,
        pluginVerified: true,
        total: requestedOrderNumbers.length,
        matched,
        failed,
        localFailed,
        results: mirroredResults,
        unavailableAccounts,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    })();
    try {
      return await activeDirectRead;
    } finally {
      activeDirectRead = null;
    }
  }

  return Object.freeze({ execute, readOrders });
}
