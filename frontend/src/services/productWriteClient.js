import {
  confirmDomainWrite,
  previewDomainWrite,
  releaseDomainWritePreview,
} from '../api/localApiClient.js';

const PRODUCT_WRITE_COMMANDS = Object.freeze({
  info: Object.freeze({ action: 'product.updateInfo', endpointKey: 'products.import' }),
  price: Object.freeze({ action: 'product.updatePrice', endpointKey: 'products.updatePrices' }),
  stock: Object.freeze({ action: 'product.updateStock', endpointKey: 'products.updateStocks' }),
  archive: Object.freeze({ action: 'product.archive', endpointKey: 'products.archive' }),
  unarchive: Object.freeze({ action: 'product.unarchive', endpointKey: 'products.unarchive' }),
});

function normalizeCommand(kind, command = {}) {
  const contract = PRODUCT_WRITE_COMMANDS[kind];
  if (!contract) throw new Error(`不支持的商品写入类型：${kind}`);
  const shopId = String(command.shopId ?? command.shop_id ?? '').trim();
  if (!shopId) throw new Error('缺少店铺 ID，不能提交商品写入。');
  const payload = command.payload ?? command.after ?? {};
  return {
    shopId,
    action: contract.action,
    endpointKey: contract.endpointKey,
    payload,
    before: command.before ?? null,
    after: command.after ?? payload,
    idempotencyKey: command.idempotencyKey,
    requestedBy: command.requestedBy || 'product-write-client',
  };
}

export function previewProductWrite(payload = {}, options = {}) {
  return previewDomainWrite('products', payload, options);
}

export function confirmProductWrite(payload = {}, options = {}) {
  return confirmDomainWrite('products', payload, options);
}

export function releaseProductWritePreview(payload = {}, options = {}) {
  return releaseDomainWritePreview('products', payload, options);
}

export async function executeProductWrite(kind, command = {}, options = {}) {
  const normalized = normalizeCommand(kind, command);
  const preview = await previewProductWrite(normalized, options);
  if (!preview?.ok || !preview?.previewId) {
    throw new Error(preview?.error?.message || '商品写入预览生成失败。');
  }
  if (options.humanConfirmed !== true && options.confirmed !== true && options.confirm !== true) {
    return { ok: true, preview, confirmed: false, writeConnected: false };
  }
  const confirm = await confirmProductWrite(
    {
      ...normalized,
      previewId: preview.previewId,
      confirm: true,
      realWrite: options.realWrite !== false,
      dryRun: options.dryRun === true,
      fastAck: false,
      asyncWrite: false,
      waitForResult: true,
    },
    options,
  );
  return {
    ok: Boolean(confirm?.ok),
    preview,
    confirm,
    confirmed: true,
    writeConnected: Boolean(confirm?.writeConnected),
    executionNotConnected:
      confirm?.error?.code === 'WRITE_EXECUTION_NOT_CONNECTED' ||
      confirm?.error?.code === 'REAL_OZON_WRITE_DISABLED',
    readBack: confirm?.readBack || null,
    writeStatus: confirm?.writeStatus || '',
  };
}

export const submitProductInfoWrite = (command, options) => executeProductWrite('info', command, options);
export const submitProductPriceWrite = (command, options) => executeProductWrite('price', command, options);
export const submitProductStockWrite = (command, options) => executeProductWrite('stock', command, options);
export const submitProductArchiveWrite = (command, options) => executeProductWrite('archive', command, options);
export const submitProductUnarchiveWrite = (command, options) => executeProductWrite('unarchive', command, options);

export function isProductWriteReadbackComplete(result = {}) {
  return String(result?.readBack?.status || result?.confirm?.readBack?.status || '').toLowerCase() === 'merged';
}

export function isProductWritePendingReadback(result = {}) {
  const status = String(result?.readBack?.status || result?.confirm?.readBack?.status || '').toLowerCase();
  return status === 'pending' || status === 'mismatch' || status === 'failed' || !status;
}

export const previewProductInfoSave = (payload, options) =>
  previewProductWrite(normalizeCommand('info', payload), options);
export const previewProductPriceUpdate = (payload, options) =>
  previewProductWrite(normalizeCommand('price', payload), options);
export const previewProductStockUpdate = (payload, options) =>
  previewProductWrite(normalizeCommand('stock', payload), options);
export const previewProductArchive = (payload, options) =>
  previewProductWrite(normalizeCommand('archive', payload), options);
export const previewProductUnarchive = (payload, options) =>
  previewProductWrite(normalizeCommand('unarchive', payload), options);
