import {
  confirmProductWrite,
  previewProductWrite,
  releaseProductWritePreview,
} from '../../../services/productWriteClient.js';
import { buildCollectionListingCommands } from '../lib/collectionListingDraft.js';
import { normalizeCollectionListingErrorMessage } from '../lib/collectionListingErrorMessage.js';

export const COLLECTION_LISTING_PREVIEW_CHUNK_TARGET_BYTES = 384 * 1024;
export const COLLECTION_LISTING_PREVIEW_CHUNK_HARD_MAX_BYTES = 1792 * 1024;
export const COLLECTION_LISTING_CONFIRM_TIMEOUT_MS = 240_000;

const COMMAND_ARRAY_FIELDS = Object.freeze({
  info: 'items',
  price: 'prices',
  stock: 'stocks',
});

const READBACK_FIELD_LABELS = Object.freeze({
  missing_product: '商品未返回',
  name: '标题',
  weight: '重量',
  depth: '长度',
  width: '宽度',
  height: '高度',
  attributes: '属性',
  complex_attributes: '组合属性',
  images: '图片',
});

function createOperationId() {
  const random = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
  return `collection-listing-${Date.now()}-${random}`;
}

function errorMessage(error) {
  return normalizeCollectionListingErrorMessage(error);
}

function readBackMismatchMessage(response = {}, label = '商品卡') {
  const verification = response?.readBack?.verification;
  if (verification?.reason === 'product_sku_not_ready') {
    const count = Array.isArray(verification?.missingOfferIds)
      ? verification.missingOfferIds.length
      : 0;
    return `${label}已被 Ozon 接收，但${count ? `仍有 ${count} 个 ` : ''}SKU 尚未创建完成；已暂停价格和库存写入，请稍后继续回读。`;
  }
  const mismatches = Array.isArray(verification?.mismatches)
    ? verification.mismatches
    : [];
  if (!mismatches.length) {
    return `${label}已提交，但 Ozon 回读尚未一致，后续写入已停止。`;
  }
  const fields = [...new Set(mismatches.flatMap((item) => (
    Array.isArray(item?.fields) ? item.fields : []
  )))].map((field) => READBACK_FIELD_LABELS[field] || field);
  const checked = Number(verification?.checked) || mismatches.length;
  const countLabel = mismatches.length < checked
    ? `至少 ${mismatches.length}/${checked} 个 SKU`
    : `${mismatches.length} 个 SKU`;
  return `${label}已写入 Ozon，但 ${countLabel}的${fields.join('、') || '字段'}回读不一致；已停止后续价格和库存写入，请重新生成预览后重试。`;
}

function createAbortError() {
  const error = new Error('已取消生成上架预览。');
  error.name = 'AbortError';
  error.code = 'COLLECTION_LISTING_PREVIEW_ABORTED';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError();
}

function positiveByteLimit(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function utf8JsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function commandRows(item = {}) {
  const field = COMMAND_ARRAY_FIELDS[item.kind];
  const rows = field ? item.command?.after?.[field] : null;
  if (!field || !Array.isArray(rows)) {
    const error = new Error(`${item.label || item.kind || '上架'}命令缺少可分片数据。`);
    error.code = 'COLLECTION_LISTING_CHUNK_SOURCE_INVALID';
    throw error;
  }
  return { field, rows };
}

function commandWithRows(item, field, rows, chunkIndex = 0, chunkCount = 0) {
  const original = compactPreviewCommand(item.command);
  const suffix = chunkCount > 1 ? `:chunk:${chunkIndex + 1}:${chunkCount}` : '';
  return {
    ...original,
    after: { [field]: rows },
    idempotencyKey: `${original.idempotencyKey || createOperationId()}${suffix}`,
  };
}

function getOzonCardGroupKey(row = {}) {
  const attributes = Array.isArray(row?.attributes) ? row.attributes : [];
  const modelAttribute = attributes.find((attribute) => (
    String(attribute?.id ?? attribute?.attribute_id ?? '').trim() === '9048'
  ));
  const values = Array.isArray(modelAttribute?.values) ? modelAttribute.values : [];
  return String(values[0]?.value ?? values[0]?.dictionary_value_id ?? '').trim();
}

function buildAtomicCommandRowGroups(item = {}, rows = []) {
  if (item.kind !== 'info') return rows.map((row) => [row]);
  const groups = [];
  const groupedByModel = new Map();
  rows.forEach((row) => {
    const key = getOzonCardGroupKey(row);
    if (!key) {
      groups.push([row]);
      return;
    }
    if (!groupedByModel.has(key)) {
      const group = [];
      groupedByModel.set(key, group);
      groups.push(group);
    }
    groupedByModel.get(key).push(row);
  });
  return groups;
}

async function yieldToEventLoop(signal) {
  throwIfAborted(signal);
  await new Promise((resolve, reject) => {
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(createAbortError());
    };
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, 0);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function compactPreviewCommand(command = {}) {
  const { payload, ...rest } = command;
  return {
    ...rest,
    // writeGuardService derives its execution payload from `after` when the
    // duplicate `payload` field is absent. Large 80-SKU previews therefore
    // cross IPC only once instead of serializing the same product list twice.
    after: command.after ?? payload ?? null,
  };
}

function compactConfirmCommand(command = {}, previewId = '', options = {}) {
  return {
    shopId: command.shopId,
    action: command.action,
    endpointKey: command.endpointKey,
    idempotencyKey: command.idempotencyKey,
    requestedBy: command.requestedBy,
    previewId,
    confirm: true,
    realWrite: options.realWrite !== false,
    dryRun: options.dryRun === true,
    fastAck: false,
    asyncWrite: false,
    waitForResult: true,
    ...(options.resumeReadBackOnly === true ? {
      resumeReadBackOnly: true,
      readBackTaskId: options.readBackTaskId,
      readBackJobId: options.readBackJobId,
    } : {}),
  };
}

export async function splitCollectionListingCommandsByBytes(commandItems = [], options = {}) {
  const signal = options.signal;
  const hardMaxBytes = positiveByteLimit(
    options.previewChunkHardMaxBytes,
    COLLECTION_LISTING_PREVIEW_CHUNK_HARD_MAX_BYTES,
  );
  const targetBytes = Math.min(
    positiveByteLimit(options.previewChunkTargetBytes, COLLECTION_LISTING_PREVIEW_CHUNK_TARGET_BYTES),
    hardMaxBytes,
  );
  const chunks = [];

  for (const item of commandItems) {
    throwIfAborted(signal);
    const { field, rows } = commandRows(item);
    options.onProgress?.({
      phase: 'chunking',
      kind: item.kind,
      label: item.label,
      current: chunks.length,
      total: null,
      message: `正在按数据大小拆分${item.label}…`,
    });
    const rowGroups = [];
    let currentRows = [];
    let processedRows = 0;
    const atomicGroups = buildAtomicCommandRowGroups(item, rows);
    for (const atomicRows of atomicGroups) {
      throwIfAborted(signal);
      const atomicBytes = utf8JsonBytes(
        commandWithRows(item, field, atomicRows, 9998, 9999),
      );
      if (atomicBytes > hardMaxBytes) {
        const firstRow = atomicRows[0] || {};
        const offerId = String(firstRow?.offer_id || firstRow?.offerId || '当前商品卡').trim();
        const error = new Error(
          atomicRows.length > 1
            ? `同一 Ozon 商品卡的 ${atomicRows.length} 个 SKU 数据为 ${formatBytes(atomicBytes)}，超过单次安全上限 ${formatBytes(hardMaxBytes)}。同一商品卡不能拆批上传，请减少该商品卡的超长属性或图片地址后重试。`
            : `${item.label}中的单个 SKU“${offerId}”数据为 ${formatBytes(atomicBytes)}，超过单分片安全上限 ${formatBytes(hardMaxBytes)}。请缩短该 SKU 的超长属性、标题或图片地址后重试。`,
        );
        error.code = atomicRows.length > 1
          ? 'COLLECTION_LISTING_CARD_GROUP_TOO_LARGE'
          : 'COLLECTION_LISTING_ITEM_TOO_LARGE';
        error.details = {
          kind: item.kind,
          label: item.label,
          offerId,
          itemCount: atomicRows.length,
          byteLength: atomicBytes,
          hardMaxBytes,
        };
        throw error;
      }

      const candidateRows = [...currentRows, ...atomicRows];
      const candidateBytes = utf8JsonBytes(commandWithRows(item, field, candidateRows, 9998, 9999));
      if (!currentRows.length || candidateBytes <= targetBytes) {
        currentRows = candidateRows;
      } else {
        rowGroups.push(currentRows);
        currentRows = [...atomicRows];
      }
      processedRows += atomicRows.length;
      if (processedRows % 8 === 0 || atomicRows.length > 8) await yieldToEventLoop(signal);
    }
    if (currentRows.length) rowGroups.push(currentRows);

    const chunkCount = rowGroups.length;
    rowGroups.forEach((group, chunkIndex) => {
      const command = commandWithRows(item, field, group, chunkIndex, chunkCount);
      const byteLength = utf8JsonBytes(command);
      if (byteLength > hardMaxBytes) {
        const error = new Error(`${item.label}分片超过单次传输安全上限，请重新生成。`);
        error.code = 'COLLECTION_LISTING_CHUNK_TOO_LARGE';
        error.details = { kind: item.kind, chunkIndex, chunkCount, byteLength, hardMaxBytes };
        throw error;
      }
      chunks.push({
        ...item,
        label: chunkCount > 1 ? `${item.label} ${chunkIndex + 1}/${chunkCount}` : item.label,
        command,
        chunkIndex,
        chunkCount,
        itemCount: group.length,
        byteLength,
      });
    });
    await yieldToEventLoop(signal);
  }
  return chunks;
}

export async function releaseCollectionListingPreview(preview, options = {}) {
  const steps = Array.isArray(preview?.steps) ? preview.steps : [];
  const previewIds = [...new Set(steps.map((step) => String(step?.preview?.previewId || '')).filter(Boolean))];
  if (!previewIds.length) return { ok: true, released: 0 };
  try {
    const result = await releaseProductWritePreview({
      previewIds,
      shopId: preview?.draftSnapshot?.shopId || steps[0]?.command?.shopId,
    }, { ...options, signal: undefined, timeoutMs: 2_000, transportRetry: false, observe: false });
    return { ok: true, released: Number(result?.releasedCount) || (result?.released ? previewIds.length : 0) };
  } catch {
    // The write guard also expires previews by TTL. Cleanup is best-effort
    // and must never turn a user cancellation into another blocking error.
    return { ok: true, released: 0 };
  }
}

export async function previewCollectionListing(draft = {}, options = {}) {
  throwIfAborted(options.signal);
  const operationId = createOperationId();
  const built = buildCollectionListingCommands(draft, operationId);
  const commandChunks = await splitCollectionListingCommandsByBytes(built.commands, options);
  const hardMaxBytes = positiveByteLimit(
    options.previewChunkHardMaxBytes,
    COLLECTION_LISTING_PREVIEW_CHUNK_HARD_MAX_BYTES,
  );
  const targetBytes = Math.min(
    positiveByteLimit(options.previewChunkTargetBytes, COLLECTION_LISTING_PREVIEW_CHUNK_TARGET_BYTES),
    hardMaxBytes,
  );
  const steps = [];
  try {
    for (let index = 0; index < commandChunks.length; index += 1) {
      throwIfAborted(options.signal);
      const item = commandChunks[index];
      options.onProgress?.({
        phase: 'previewing',
        kind: item.kind,
        label: item.label,
        current: index + 1,
        total: commandChunks.length,
        message: `正在生成上架预览分片 ${index + 1}/${commandChunks.length}（${item.label}）…`,
      });
      const preview = await previewProductWrite(item.command, options);
      if (!preview?.ok || !preview?.previewId) {
        const error = new Error(preview?.error?.message || `${item.label}写入预览生成失败。`);
        error.code = preview?.error?.code || 'COLLECTION_LISTING_PREVIEW_FAILED';
        throw error;
      }
      steps.push({ ...item, preview });
      await yieldToEventLoop(options.signal);
    }
  } catch (error) {
    await releaseCollectionListingPreview({ steps, draftSnapshot: draft }, options);
    throw error;
  }
  return {
    ok: true,
    operationId,
    createdAt: new Date().toISOString(),
    draftSnapshot: structuredClone(draft),
    validation: built.validation,
    product: built.infoItem,
    price: built.priceItem,
    products: built.infoItems,
    prices: built.priceItems,
    stocks: built.stockItems,
    transport: {
      chunkCount: steps.length,
      targetBytes,
      hardMaxBytes,
      totalBytes: steps.reduce((total, step) => total + step.byteLength, 0),
    },
    steps,
  };
}

export async function confirmCollectionListing(preview, options = {}) {
  if (!preview?.operationId || !Array.isArray(preview.steps) || !preview.steps.length) {
    const error = new Error('上架预览已失效，请重新生成。');
    error.code = 'COLLECTION_LISTING_PREVIEW_REQUIRED';
    throw error;
  }
  const results = [];
  for (let index = 0; index < preview.steps.length; index += 1) {
    throwIfAborted(options.signal);
    const step = preview.steps[index];
    options.onProgress?.({
      phase: 'confirming',
      kind: step.kind,
      label: step.label,
      current: index + 1,
      total: preview.steps.length,
      message: `正在上传并回读分片 ${index + 1}/${preview.steps.length}（${step.label}）…`,
    });
    const response = await confirmProductWrite(
      compactConfirmCommand(step.command, step.preview.previewId, options),
      {
        ...options,
        timeoutMs: positiveByteLimit(
          options.confirmTimeoutMs,
          COLLECTION_LISTING_CONFIRM_TIMEOUT_MS,
        ),
      },
    );
    const readBackStatus = String(response?.readBack?.status || '').toLowerCase();
    const result = {
      kind: step.kind,
      label: step.label,
      ok: response?.ok === true,
      writeConnected: response?.writeConnected === true,
      writeStatus: String(response?.writeStatus || ''),
      readBackStatus,
      error: response?.ok === true ? '' : errorMessage(response),
      response,
    };
    results.push(result);
    if (!result.ok || readBackStatus !== 'merged') {
      return {
        ok: false,
        completed: false,
        status: result.ok ? 'pending_readback' : 'failed',
        operationId: preview.operationId,
        stoppedAt: step.kind,
        results,
        message: result.ok
          ? readBackMismatchMessage(response, step.label)
          : result.error,
      };
    }
    await yieldToEventLoop(options.signal);
  }
  const completed = {
    ok: true,
    completed: true,
    status: 'completed',
    operationId: preview.operationId,
    stoppedAt: '',
    results,
    message: '商品卡、价格和库存已通过 Ozon 回读校验。',
  };
  await releaseCollectionListingPreview(preview, options);
  return completed;
}

export function canResumeCollectionListingReadBack(result = {}) {
  if (result?.completed === true || !Array.isArray(result?.results)) return false;
  const pending = result.results.find((item) => (
    String(item?.readBackStatus || '').toLowerCase() !== 'merged'
  ));
  const readBack = pending?.response?.readBack;
  const readBackStatus = String(
    readBack?.status || pending?.readBackStatus || '',
  ).toLowerCase();
  const pendingReadBack =
    ['pending', 'mismatch'].includes(readBackStatus) &&
    readBack?.verification?.terminal !== true;
  if (!pendingReadBack) return false;
  if (pending?.kind === 'info') {
    return Boolean(readBack?.importTask?.failed !== true && readBack?.importTask?.taskId);
  }
  return readBackStatus === 'pending' &&
    ['price', 'stock'].includes(pending?.kind) &&
    pending?.writeConnected === true;
}

export async function continueCollectionListingReadBack(preview, priorResult = {}, options = {}) {
  if (!preview?.operationId || !Array.isArray(preview.steps) || !preview.steps.length) {
    const error = new Error('上架预览已失效，无法继续回读。');
    error.code = 'COLLECTION_LISTING_PREVIEW_REQUIRED';
    throw error;
  }
  const priorResults = Array.isArray(priorResult?.results) ? priorResult.results : [];
  const pendingIndex = priorResults.findIndex((item) => (
    String(item?.readBackStatus || '').toLowerCase() !== 'merged'
  ));
  const pending = pendingIndex >= 0 ? priorResults[pendingIndex] : null;
  const taskId = pending?.response?.readBack?.importTask?.taskId;
  const resumableInfo = pending?.kind === 'info' && Boolean(taskId);
  const resumableMutation = ['price', 'stock'].includes(pending?.kind) && pending?.writeConnected === true;
  if (pendingIndex < 0 || (!resumableInfo && !resumableMutation)) {
    const error = new Error('当前任务没有可继续的 Ozon 导入回读；本次没有重复上传。');
    error.code = 'COLLECTION_LISTING_READBACK_RESUME_UNAVAILABLE';
    throw error;
  }

  const results = priorResults.slice(0, pendingIndex);
  for (let index = pendingIndex; index < preview.steps.length; index += 1) {
    throwIfAborted(options.signal);
    const step = preview.steps[index];
    const resumeCurrentStep = index === pendingIndex;
    options.onProgress?.({
      phase: resumeCurrentStep ? 'readback-resume' : 'confirming',
      kind: step.kind,
      label: step.label,
      current: index + 1,
      total: preview.steps.length,
      message: resumeCurrentStep
        ? `正在继续回读 ${step.label}，不会重复上传商品…`
        : `正在上传并回读分片 ${index + 1}/${preview.steps.length}（${step.label}）…`,
    });
    const confirmOptions = resumeCurrentStep
      ? {
          ...options,
          resumeReadBackOnly: true,
          readBackTaskId: taskId,
          readBackJobId: pending?.response?.schedulerResult?.jobId,
        }
      : options;
    const response = await confirmProductWrite(
      compactConfirmCommand(step.command, step.preview.previewId, confirmOptions),
      {
        ...options,
        timeoutMs: positiveByteLimit(
          options.confirmTimeoutMs,
          COLLECTION_LISTING_CONFIRM_TIMEOUT_MS,
        ),
      },
    );
    const readBackStatus = String(response?.readBack?.status || '').toLowerCase();
    const result = {
      kind: step.kind,
      label: step.label,
      ok: response?.ok === true,
      writeConnected: response?.writeConnected === true,
      writeStatus: String(response?.writeStatus || ''),
      readBackStatus,
      error: response?.ok === true ? '' : errorMessage(response),
      response,
    };
    results.push(result);
    if (!result.ok || readBackStatus !== 'merged') {
      return {
        ok: false,
        completed: false,
        status: result.ok ? 'pending_readback' : 'failed',
        operationId: preview.operationId,
        stoppedAt: step.kind,
        results,
        message: result.ok
          ? readBackMismatchMessage(response, step.label)
          : result.error,
      };
    }
    await yieldToEventLoop(options.signal);
  }

  const completed = {
    ok: true,
    completed: true,
    status: 'completed',
    operationId: preview.operationId,
    stoppedAt: '',
    results,
    message: '商品卡、价格和库存已通过 Ozon 回读校验。',
  };
  await releaseCollectionListingPreview(preview, options);
  return completed;
}

export function getCollectionListingErrorMessage(error) {
  if (error?.name === 'AbortError' || error?.code === 'COLLECTION_LISTING_PREVIEW_ABORTED') {
    return '已取消生成上架预览。';
  }
  if (error?.code === 'COLLECTION_LISTING_DRAFT_INVALID') {
    return error?.details?.errors?.[0] || '上架草稿未通过校验。';
  }
  return errorMessage(error);
}
