import { getProfileSetting, saveProfileSetting } from '../../../api/localApiClient.js';

export const PURCHASE_AUTO_PAY_LOG_NAMESPACE = 'purchase-auto-pay-run-logs';
const MAX_LOGS = 500;
let writeChain = Promise.resolve();

function normalizeLog(value = {}) {
  return {
    id: String(value.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`).slice(0, 160),
    at: String(value.at || new Date().toISOString()).slice(0, 80),
    section: String(value.section || '').slice(0, 80),
    rowId: String(value.rowId || '').slice(0, 260),
    posting: String(value.posting || '').slice(0, 260),
    status: String(value.status || '').slice(0, 40),
    message: String(value.message || '').replace(/\s+/gu, ' ').trim().slice(0, 1000),
    platform: String(value.platform || '').slice(0, 40),
    orderNumber: String(value.orderNumber || '').slice(0, 260),
    amount: Number.isFinite(Number(value.amount)) ? Number(value.amount) : null,
    transactionNo: String(value.transactionNo || '').slice(0, 260),
  };
}

export async function loadPurchaseAutoPayLogs(options = {}) {
  const result = await (options.read || getProfileSetting)(PURCHASE_AUTO_PAY_LOG_NAMESPACE, options);
  const value = result?.setting?.value || result?.value || {};
  return (Array.isArray(value.logs) ? value.logs : []).map(normalizeLog).slice(0, MAX_LOGS);
}

export function appendPurchaseAutoPayLog(entry, options = {}) {
  const log = normalizeLog(entry);
  writeChain = writeChain.catch(() => undefined).then(async () => {
    const logs = await loadPurchaseAutoPayLogs(options).catch(() => []);
    const next = [log, ...logs.filter((item) => item.id !== log.id)].slice(0, MAX_LOGS);
    await (options.save || saveProfileSetting)(PURCHASE_AUTO_PAY_LOG_NAMESPACE, {
      version: 1,
      logs: next,
      updatedAt: new Date().toISOString(),
    }, options);
    return log;
  });
  return writeChain;
}

export function clearPurchaseAutoPayLogs(options = {}) {
  writeChain = writeChain.catch(() => undefined).then(() => (
    (options.save || saveProfileSetting)(PURCHASE_AUTO_PAY_LOG_NAMESPACE, {
      version: 1,
      logs: [],
      updatedAt: new Date().toISOString(),
    }, options)
  ));
  return writeChain;
}
