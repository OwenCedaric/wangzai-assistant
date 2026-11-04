import { createHash } from 'node:crypto';
import { decryptSecret, encryptSecret } from '../../security/secretCrypto.js';
import { createStableHash, stableStringify } from '../../utils/stableHash.js';

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const ARCHIVE_ORIGINS = new Set([
  'website-readback',
  'idempotent-readback',
  'purchase-account-removal',
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function parseEncryptedJson(value, code) {
  try {
    const parsed = JSON.parse(decryptSecret(value));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(code);
    return parsed;
  } catch (error) {
    if (error?.code === code) throw error;
    fail(code);
  }
}

function sourceHost(targetUrl) {
  try {
    return new URL(targetUrl).hostname.toLocaleLowerCase('en-US');
  } catch {
    fail('PURCHASE_COMPLETION_HISTORY_SOURCE_INVALID');
  }
}

function receiptEvidence(receipt) {
  return {
    orderNumber: text(receipt?.orderNumber),
    amount: text(receipt?.amount),
    status: text(receipt?.status),
    pageUrl: text(receipt?.pageUrl),
  };
}

function assertHash(value, code) {
  if (!HASH_PATTERN.test(text(value))) fail(code);
  return value;
}

function buildCanonicalPayloads({ taskRow, receiptRow, preview, receipt, platformName }) {
  const accountRefHash = sha256(
    `purchase-account-ref-v1\0${taskRow.owner_id}\0${taskRow.owner_incarnation}`,
  );
  const orderProduct = Object.freeze({
    schemaVersion: 1,
    orderKey: text(taskRow.order_key),
    productKey: text(taskRow.product_key),
    productTitle: text(preview.productTitle),
    variant: text(preview.variant),
    quantity: Number(preview.quantity),
    expectedAmount: text(preview.expectedAmount),
  });
  const sourceSummary = Object.freeze({
    schemaVersion: 1,
    sourceKind: 'purchase-browser',
    sourceHost: sourceHost(preview.targetUrl),
    sourceUrlHash: sha256(`purchase-source-url-v1\0${preview.targetUrl}`),
    platformName: text(platformName),
    accountRefHash,
    attemptId: text(receiptRow.attempt_id),
    taskCreatedAt: text(taskRow.created_at),
  });
  return {
    accountRefHash,
    orderNumberHash: sha256(`purchase-order-number-v1\0${receipt.orderNumber}`),
    orderProduct,
    orderProductHash: createStableHash(orderProduct),
    sourceSummary,
    sourceSummaryHash: createStableHash(sourceSummary),
  };
}

function assertCanonicalInput({ db, taskRow, receiptRow, preview, receipt, archiveOrigin, completedAt }) {
  if (!db || !taskRow || !receiptRow || !preview || !receipt) {
    fail('PURCHASE_COMPLETION_HISTORY_INPUT_INVALID');
  }
  if (!ARCHIVE_ORIGINS.has(archiveOrigin)) fail('PURCHASE_COMPLETION_HISTORY_ORIGIN_INVALID');
  const shopId = text(taskRow.shop_id);
  if (!shopId || !db.prepare('SELECT id FROM shops WHERE id = ?').get(shopId)) {
    fail('PURCHASE_COMPLETION_HISTORY_SHOP_REQUIRED');
  }
  if (
    !text(taskRow.id)
    || !text(taskRow.owner_id)
    || !text(taskRow.owner_incarnation)
    || !text(receiptRow.id)
    || text(receiptRow.task_id) !== text(taskRow.id)
    || text(receiptRow.owner_id) !== text(taskRow.owner_id)
    || text(receiptRow.shop_id) !== shopId
    || !text(completedAt)
  ) {
    fail('PURCHASE_COMPLETION_HISTORY_SCOPE_INVALID');
  }
  assertHash(receiptRow.receipt_hash, 'PURCHASE_COMPLETION_HISTORY_RECEIPT_HASH_INVALID');
  assertHash(
    receiptRow.website_readback_hash,
    'PURCHASE_COMPLETION_HISTORY_READBACK_HASH_INVALID',
  );
  if (sha256(JSON.stringify(receiptEvidence(receipt))) !== receiptRow.receipt_hash) {
    fail('PURCHASE_COMPLETION_HISTORY_RECEIPT_HASH_MISMATCH');
  }
}

function assertHistoryReadback(row, expected) {
  if (
    !row
    || row.shop_id !== expected.shopId
    || row.source_task_id !== expected.taskId
    || row.source_receipt_id !== expected.receiptId
    || row.source_account_ref_hash !== expected.accountRefHash
    || row.order_number_hash !== expected.orderNumberHash
    || row.receipt_hash !== expected.receiptHash
    || row.website_readback_hash !== expected.websiteReadbackHash
    || row.order_product_hash !== expected.orderProductHash
    || row.source_summary_hash !== expected.sourceSummaryHash
    || row.completed_at !== expected.completedAt
  ) {
    fail('PURCHASE_COMPLETION_HISTORY_CONFLICT');
  }
  const storedReceipt = parseEncryptedJson(
    row.receipt_encrypted,
    'PURCHASE_COMPLETION_HISTORY_RECEIPT_INVALID',
  );
  const storedOrderProduct = parseEncryptedJson(
    row.order_product_encrypted,
    'PURCHASE_COMPLETION_HISTORY_ORDER_PRODUCT_INVALID',
  );
  const storedSourceSummary = parseEncryptedJson(
    row.source_summary_encrypted,
    'PURCHASE_COMPLETION_HISTORY_SOURCE_INVALID',
  );
  if (
    stableStringify(storedReceipt) !== stableStringify(expected.receipt)
    || stableStringify(storedOrderProduct) !== stableStringify(expected.orderProduct)
    || stableStringify(storedSourceSummary) !== stableStringify(expected.sourceSummary)
  ) {
    fail('PURCHASE_COMPLETION_HISTORY_CONFLICT');
  }
}

/**
 * Idempotently persists one completed readback as a shop-owned canonical fact.
 * The caller owns the surrounding transaction so task, receipt and history can
 * commit or roll back as one unit.
 */
export function archivePurchaseCompletionRow(db, {
  taskRow,
  receiptRow,
  preview: previewInput,
  receipt: receiptInput,
  platformName = '',
  archiveOrigin,
  completedAt: completedAtInput,
  archivedAt: archivedAtInput,
} = {}) {
  const preview = previewInput || parseEncryptedJson(
    taskRow?.preview_encrypted,
    'PURCHASE_COMPLETION_HISTORY_PREVIEW_INVALID',
  );
  const receipt = receiptInput || parseEncryptedJson(
    receiptRow?.receipt_encrypted,
    'PURCHASE_COMPLETION_HISTORY_RECEIPT_INVALID',
  );
  const completedAt = text(completedAtInput || taskRow?.completed_at || receiptRow?.created_at);
  const archivedAt = text(archivedAtInput || completedAt);
  assertCanonicalInput({
    db,
    taskRow,
    receiptRow,
    preview,
    receipt,
    archiveOrigin,
    completedAt,
  });
  const payloads = buildCanonicalPayloads({ taskRow, receiptRow, preview, receipt, platformName });
  const expected = {
    shopId: text(taskRow.shop_id),
    taskId: taskRow.id,
    receiptId: receiptRow.id,
    receiptHash: receiptRow.receipt_hash,
    websiteReadbackHash: receiptRow.website_readback_hash,
    completedAt,
    receipt,
    ...payloads,
  };
  const insert = db.prepare(`
    INSERT INTO purchase_completion_history (
      shop_id, source_task_id, source_receipt_id,
      source_account_ref_hash, order_number_hash, receipt_encrypted,
      receipt_hash, website_readback_hash, order_product_encrypted,
      order_product_hash, source_summary_encrypted, source_summary_hash,
      archive_origin, completed_at, archived_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_receipt_id) DO NOTHING
  `).run(
    expected.shopId,
    expected.taskId,
    expected.receiptId,
    expected.accountRefHash,
    expected.orderNumberHash,
    receiptRow.receipt_encrypted,
    expected.receiptHash,
    expected.websiteReadbackHash,
    encryptSecret(stableStringify(expected.orderProduct)),
    expected.orderProductHash,
    encryptSecret(stableStringify(expected.sourceSummary)),
    expected.sourceSummaryHash,
    archiveOrigin,
    completedAt,
    archivedAt,
    archivedAt,
    archivedAt,
  );
  const row = db.prepare(`
    SELECT * FROM purchase_completion_history WHERE source_receipt_id = ?
  `).get(receiptRow.id);
  assertHistoryReadback(row, expected);
  return Object.freeze({ inserted: Number(insert.changes || 0) === 1, row });
}

/**
 * Final fail-closed sweep used immediately before purchase-account deletion.
 * Any legacy completed task that cannot be attached to a live Ozon shop blocks
 * deletion instead of silently losing its receipt.
 */
export function archiveCompletedPurchaseHistoryForAccount(db, ownerId, {
  now = () => new Date().toISOString(),
} = {}) {
  const normalizedOwnerId = text(ownerId);
  if (!normalizedOwnerId) fail('PURCHASE_COMPLETION_HISTORY_OWNER_REQUIRED');
  const account = db.prepare(`
    SELECT id, platform_name FROM purchase_accounts WHERE id = ?
  `).get(normalizedOwnerId);
  if (!account) fail('PURCHASE_COMPLETION_HISTORY_OWNER_NOT_FOUND');
  const tasks = db.prepare(`
    SELECT * FROM purchase_browser_tasks
    WHERE owner_id = ? AND status = 'completed'
    ORDER BY completed_at ASC, id ASC
  `).all(normalizedOwnerId);
  let insertedCount = 0;
  for (const taskRow of tasks) {
    const receiptRow = db.prepare(`
      SELECT * FROM purchase_browser_receipts WHERE task_id = ?
    `).get(taskRow.id);
    if (!receiptRow || text(taskRow.receipt_id) !== text(receiptRow.id)) {
      fail('PURCHASE_COMPLETION_HISTORY_RECEIPT_REQUIRED');
    }
    const result = archivePurchaseCompletionRow(db, {
      taskRow,
      receiptRow,
      platformName: account.platform_name || '',
      archiveOrigin: 'purchase-account-removal',
      completedAt: taskRow.completed_at,
      archivedAt: now(),
    });
    if (result.inserted) insertedCount += 1;
  }
  const archivedCount = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM purchase_completion_history history
    JOIN purchase_browser_tasks task ON task.id = history.source_task_id
    WHERE task.owner_id = ? AND task.status = 'completed'
  `).get(normalizedOwnerId)?.count) || 0;
  if (archivedCount !== tasks.length) fail('PURCHASE_COMPLETION_HISTORY_ARCHIVE_INCOMPLETE');
  return Object.freeze({ completedCount: tasks.length, insertedCount, archivedCount });
}
