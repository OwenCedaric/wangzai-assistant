import { readPurchaseOverrides } from './purchaseOrderOverrideClient.js';

const SUPPORTED_PURCHASE_PLATFORMS = Object.freeze(['1688', '淘宝', '天猫', '拼多多']);
const DEFAULT_BATCH_SIZE = 100;

function clean(value, maximum = 180) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

export function normalizePurchaseSupplierPlatform(value) {
  const text = clean(value, 80).toLowerCase();
  if (text === '1688' || text.includes('阿里巴巴')) return '1688';
  if (text === 'taobao' || text.includes('淘宝')) return '淘宝';
  if (text === 'tmall' || text.includes('天猫')) return '天猫';
  if (['pdd', 'pinduoduo'].includes(text) || text.includes('拼多多')) return '拼多多';
  return '';
}

function firstFilled(...values) {
  return values.find((value) => {
    const text = clean(value);
    return text && !/^(?:未返回|待确认|待拍单|null|undefined|-|—)$/iu.test(text);
  });
}

export function createPurchaseSupplierLogisticsPatch(result = {}, syncedAt = new Date().toISOString()) {
  const logistics = result?.logistics && typeof result.logistics === 'object' ? result.logistics : {};
  const carrier = clean(firstFilled(logistics.carrier, logistics.carrierName), 100);
  const trackingNumber = clean(firstFilled(logistics.trackingNumber), 180);
  if (!carrier || !trackingNumber) return null;
  const source = clean(
    logistics.sourceMethod || result.logisticsSourceMethod || 'cross-border-bus-plugin-original-v1.0.8',
    120,
  );
  return {
    carrierName: carrier,
    expressCompany: carrier,
    domesticCourierCompany: carrier,
    trackingNumber,
    logisticsOrder: trackingNumber,
    domesticTrackingNumber: trackingNumber,
    purchaseTrackingNumber: trackingNumber,
    domesticLogisticsStatus: '已发货',
    purchaseLogisticsStatus: '已发货',
    domesticLogisticsSyncStatus: result.localMirror?.saved > 0 ? '已保存' : '已读取',
    domesticLogisticsSyncedAt: syncedAt,
    domesticLogisticsSource: source,
  };
}

export function collectPurchaseSupplierCandidates(orders = []) {
  return (Array.isArray(orders) ? orders : []).flatMap((order) => {
    const platform = normalizePurchaseSupplierPlatform(firstFilled(
      order?.manualBuyerPlatform,
      order?.buyerPlatform,
      order?.supplier,
      order?.purchasePlatform,
    ));
    const purchaseOrderNumber = clean(firstFilled(
      order?.manualPurchaseOrderNo,
      order?.purchaseOrderNo,
      order?.purchaseOrderNumber,
    ));
    if (!SUPPORTED_PURCHASE_PLATFORMS.includes(platform) || !purchaseOrderNumber) return [];
    return [{ order, platform, purchaseOrderNumber }];
  });
}

function getBridge() {
  return globalThis.window?.wangzaiDesktop?.purchaseBrowser || null;
}

function responseValue(payload = {}) {
  return payload?.result && typeof payload.result === 'object' ? payload.result : payload;
}

function bridgeErrorCode(error) {
  const direct = clean(error?.code, 160);
  if (direct) return direct;
  const message = String(error?.message || error || '');
  return message.match(/(?:CROSS_BORDER|PURCHASE_BROWSER)_[A-Z0-9_]+/u)?.[0]
    || 'CROSS_BORDER_LOGISTICS_SYNC_FAILED';
}

function chunks(rows, size) {
  const output = [];
  for (let index = 0; index < rows.length; index += size) output.push(rows.slice(index, index + size));
  return output;
}

async function readAllPurchaseOverrideOrders() {
  const rows = [];
  const pageSize = 1000;
  for (let page = 1; page <= 20; page += 1) {
    const result = await readPurchaseOverrides({ page, pageSize });
    const pageRows = Array.isArray(result?.rows) ? result.rows : [];
    rows.push(...pageRows);
    const total = Number(result?.total) || rows.length;
    if (rows.length >= total || pageRows.length < pageSize) break;
  }
  return rows.map((row) => ({
    id: row.orderKey || row.postingNumber || row.purchaseOrderNumber,
    purchasePlatform: row.purchasePlatform || row.manualBuyerPlatform || row.buyerPlatform,
    manualBuyerPlatform: row.manualBuyerPlatform || row.purchasePlatform,
    purchaseOrderNumber: row.purchaseOrderNumber || row.manualPurchaseOrderNo,
    manualPurchaseOrderNo: row.manualPurchaseOrderNo || row.purchaseOrderNumber,
  }));
}

export async function readPurchaseSupplierOrders(candidates = [], {
  batchSize = DEFAULT_BATCH_SIZE,
  onProgress,
} = {}) {
  const bridge = getBridge();
  if (typeof bridge?.command !== 'function') throw new Error('桌面采购插件尚未启动，请重启旺崽助手。');
  const safeBatchSize = Math.max(1, Math.min(DEFAULT_BATCH_SIZE, Number(batchSize) || DEFAULT_BATCH_SIZE));
  const rows = Array.isArray(candidates) ? candidates : [];
  const grouped = new Map();
  rows.forEach((candidate) => {
    const key = candidate.platform;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(candidate);
  });

  const uniqueTotal = [...grouped.values()].reduce((total, groupRows) => (
    total + new Set(groupRows.map((row) => row.purchaseOrderNumber)).size
  ), 0);
  let completed = 0;
  const results = [];
  for (const [platform, platformRows] of grouped.entries()) {
    const uniqueRows = [...new Map(platformRows.map((row) => [row.purchaseOrderNumber, row])).values()];
    for (const batch of chunks(uniqueRows, safeBatchSize)) {
      onProgress?.({ completed, total: uniqueTotal, platform, message: `正在同步${platform}采购单` });
      const resultByOrderNumber = new Map();
      let pendingRows = [...batch];
      for (let attempt = 1; attempt <= 3 && pendingRows.length; attempt += 1) {
        try {
          const payload = responseValue(await bridge.command({
            command: 'cross-border-purchase-read',
            orderNumbers: pendingRows.map((row) => row.purchaseOrderNumber),
            platform,
            restoreVisible: false,
          }));
          const batchResults = Array.isArray(payload?.results) ? payload.results : [];
          batchResults.forEach((row) => {
            const orderNumber = clean(row?.purchaseOrderNumber);
            if (orderNumber) resultByOrderNumber.set(orderNumber, row);
          });
        } catch {
          // Keep this exact batch for the bounded retry below.
        }
        pendingRows = pendingRows.filter((row) => resultByOrderNumber.get(row.purchaseOrderNumber)?.ok !== true);
        if (pendingRows.length && attempt < 3) {
          onProgress?.({
            completed,
            total: uniqueTotal,
            platform,
            message: `${platform}有 ${pendingRows.length} 条未返回，正在重试 ${attempt}/2`,
          });
          await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
        }
      }
      batch.forEach((row) => {
        results.push(resultByOrderNumber.get(row.purchaseOrderNumber) || {
          ok: false,
          platformLabel: platform,
          purchaseOrderNumber: row.purchaseOrderNumber,
          status: `${platform}采购账号未连接或读取失败`,
        });
      });
      completed += batch.length;
      onProgress?.({ completed, total: uniqueTotal, platform, message: `已同步 ${completed}/${uniqueTotal} 条采购单` });
    }
  }

  const matched = results.filter((row) => row?.ok === true).length;
  return {
    ok: matched === uniqueTotal,
    total: uniqueTotal,
    matched,
    failed: Math.max(0, uniqueTotal - matched),
    results,
  };
}

export async function syncUnifiedPurchaseLogistics(purchaseOrders = [], {
  batchSize = DEFAULT_BATCH_SIZE,
  onProgress,
} = {}) {
  const bridge = getBridge();
  if (typeof bridge?.command !== 'function') throw new Error('桌面采购插件尚未启动，请重启旺崽助手。');
  const overrideOrders = await readAllPurchaseOverrideOrders().catch(() => []);
  const candidates = collectPurchaseSupplierCandidates([
    ...(Array.isArray(purchaseOrders) ? purchaseOrders : []),
    ...overrideOrders,
  ]);
  let busResult = null;
  let busErrorCode = '';
  onProgress?.({
    stage: 'cross-border-bus',
    completed: 0,
    total: candidates.length,
    message: '正在同步跨境巴士待补物流订单',
  });
  try {
    busResult = responseValue(await bridge.command({
      command: 'cross-border-logistics-sync',
      restoreVisible: false,
    }));
    if (busResult?.ok === false) {
      busErrorCode = clean(busResult.errorCode, 160) || 'CROSS_BORDER_LOGISTICS_SYNC_FAILED';
    }
  } catch (error) {
    busErrorCode = bridgeErrorCode(error);
  }

  const supplierResult = candidates.length
    ? await readPurchaseSupplierOrders(candidates, { batchSize, onProgress })
    : { ok: true, total: 0, matched: 0, failed: 0, results: [] };
  const busFailed = Boolean(busErrorCode)
    || Number(busResult?.failed || 0) > 0
    || Number(busResult?.pendingReadback || 0) > 0
    || Number(busResult?.localFailed || 0) > 0;
  return {
    ok: !busFailed && supplierResult.ok === true,
    bus: busResult,
    busErrorCode,
    supplier: supplierResult,
    synced: Number(busResult?.synced) || 0,
    notShipped: Number(busResult?.notShipped) || 0,
    pendingReadback: Number(busResult?.pendingReadback) || 0,
    localFailed: Number(busResult?.localFailed) || 0,
    total: supplierResult.total,
    matched: supplierResult.matched,
    failed: supplierResult.failed,
    results: supplierResult.results,
  };
}
