import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { archivePurchaseCompletionRow } from '../../db/repositories/purchaseCompletionHistoryRepository.js';
import { decryptSecret, encryptSecret } from '../../security/secretCrypto.js';

const ACTIVE_EXECUTION_STATUSES = Object.freeze(['executing', 'receipt_pending']);
const TASK_ID_PATTERN = /^purchase_task_[a-f0-9-]{36}$/u;
const SAFE_KEY_PATTERN = /^[A-Za-z0-9._:@/+\-=]{1,260}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/u;
const ALLOWED_PURCHASE_HOSTS = Object.freeze([
  '1688.com',
  'alibaba.com',
  'alipay.com',
  'taobao.com',
  'tmall.com',
  'yangkeduo.com',
  'pinduoduo.com',
]);

function nowIso() {
  return new Date().toISOString();
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function fail(code, message = code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function requiredText(value, code, maximum = 260) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > maximum) {
    fail(code);
  }
  if (/[\u0000-\u001F\u007F]/u.test(value)) fail(code);
  return value;
}

function optionalText(value, code, maximum = 260) {
  if (value === undefined || value === null || value === '') return '';
  return requiredText(value, code, maximum);
}

function safeKey(value, code) {
  const text = requiredText(value, code, 260);
  if (!SAFE_KEY_PATTERN.test(text)) fail(code);
  return text;
}

function normalizeMoney(value, code = 'PURCHASE_BROWSER_AMOUNT_INVALID') {
  const text = requiredText(String(value ?? ''), code, 32).replace(/^\s*[¥￥]\s*/u, '');
  if (!/^\d{1,9}(?:\.\d{1,2})?$/u.test(text)) fail(code);
  return Number(text).toFixed(2);
}

function normalizeQuantity(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 9999) {
    fail('PURCHASE_BROWSER_QUANTITY_INVALID');
  }
  return number;
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase().replace(/^\[|\]$/gu, '');
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

function normalizeTargetUrl(value) {
  const text = requiredText(value, 'PURCHASE_BROWSER_TARGET_URL_INVALID', 1600);
  let url;
  try {
    url = new URL(text);
  } catch {
    fail('PURCHASE_BROWSER_TARGET_URL_INVALID');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    fail('PURCHASE_BROWSER_TARGET_URL_INVALID');
  }
  const host = url.hostname.toLowerCase();
  if (
    !isLoopbackHostname(host)
    && !ALLOWED_PURCHASE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
  ) {
    fail('PURCHASE_BROWSER_TARGET_HOST_FORBIDDEN');
  }
  return url.toString();
}

function canonicalPreview(input, account) {
  const ownerId = safeKey(input.ownerId, 'PURCHASE_BROWSER_OWNER_ID_INVALID');
  if (account.id !== ownerId) fail('PURCHASE_BROWSER_OWNER_NOT_FOUND');
  return Object.freeze({
    ownerId,
    ownerIncarnation: account.created_at,
    shopId: optionalText(input.shopId, 'PURCHASE_BROWSER_SHOP_ID_INVALID', 128),
    orderKey: safeKey(input.orderKey, 'PURCHASE_BROWSER_ORDER_KEY_INVALID'),
    productKey: safeKey(input.productKey, 'PURCHASE_BROWSER_PRODUCT_KEY_INVALID'),
    productTitle: requiredText(input.productTitle, 'PURCHASE_BROWSER_PRODUCT_TITLE_REQUIRED', 300),
    variant: requiredText(input.variant, 'PURCHASE_BROWSER_VARIANT_REQUIRED', 200),
    quantity: normalizeQuantity(input.quantity),
    address: requiredText(input.address, 'PURCHASE_BROWSER_ADDRESS_REQUIRED', 500),
    expectedAmount: normalizeMoney(input.expectedAmount),
    targetUrl: normalizeTargetUrl(input.targetUrl),
  });
}

function parseEncrypted(value) {
  try {
    return JSON.parse(decryptSecret(value));
  } catch {
    fail('PURCHASE_BROWSER_ENCRYPTED_PAYLOAD_INVALID');
  }
}

function constantTimeHashMatches(expectedHash, value) {
  if (!expectedHash || !value) return false;
  const expected = Buffer.from(expectedHash, 'hex');
  const actual = Buffer.from(sha256(value), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function publicReceipt(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    ...parseEncrypted(row.receipt_encrypted),
    receiptHash: row.receipt_hash,
    websiteReadbackHash: row.website_readback_hash,
    createdAt: row.created_at,
  };
}

function publicTask(row, receiptRow = null) {
  if (!row) return null;
  return {
    id: row.id,
    ownerId: row.owner_id,
    shopId: row.shop_id || '',
    orderKey: row.order_key,
    productKey: row.product_key,
    preview: parseEncrypted(row.preview_encrypted),
    previewFingerprint: row.preview_fingerprint,
    status: row.status,
    attemptCount: Number(row.attempt_count) || 0,
    lastErrorCode: row.last_error_code || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at || '',
    completedAt: row.completed_at || '',
    receipt: publicReceipt(receiptRow),
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createPurchaseBrowserTaskService(db, {
  now = nowIso,
  createTaskId = () => `purchase_task_${randomUUID()}`,
  createCapability = () => randomBytes(32).toString('base64url'),
  createAttemptId = () => `purchase_attempt_${randomUUID()}`,
  createReceiptId = () => `purchase_receipt_${randomUUID()}`,
} = {}) {
  const fencedOwners = new Set();

  // A process crash must never cause an automatic second website submission.
  // The interrupted task remains visible and requires a fresh user preview.
  db.prepare(`
    UPDATE purchase_browser_tasks
    SET status = 'interrupted', execution_capability_hash = NULL,
      attempt_id = NULL, last_error_code = 'PURCHASE_BROWSER_PROCESS_INTERRUPTED',
      updated_at = ?
    WHERE status IN ('executing', 'receipt_pending')
  `).run(now());

  function accountRow(ownerId) {
    return db.prepare(`
      SELECT id, created_at, platform_name
      FROM purchase_accounts WHERE id = ?
    `).get(ownerId) || null;
  }

  function rowById(taskId) {
    if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) {
      fail('PURCHASE_BROWSER_TASK_ID_INVALID');
    }
    return db.prepare('SELECT * FROM purchase_browser_tasks WHERE id = ?').get(taskId) || null;
  }

  function receiptByTaskId(taskId) {
    return db.prepare('SELECT * FROM purchase_browser_receipts WHERE task_id = ?').get(taskId) || null;
  }

  function getTask(taskId) {
    const row = rowById(taskId);
    if (!row) fail('PURCHASE_BROWSER_TASK_NOT_FOUND');
    return publicTask(row, receiptByTaskId(taskId));
  }

  function assertOwnerAvailable(ownerId) {
    if (fencedOwners.has(ownerId)) fail('PURCHASE_BROWSER_OWNER_FENCED');
    const account = accountRow(ownerId);
    if (!account) fail('PURCHASE_BROWSER_OWNER_NOT_FOUND');
    return account;
  }

  function previewTask(input = {}) {
    const ownerId = safeKey(input.ownerId, 'PURCHASE_BROWSER_OWNER_ID_INVALID');
    const account = assertOwnerAvailable(ownerId);
    const idempotencyKey = requiredText(input.idempotencyKey, 'PURCHASE_BROWSER_IDEMPOTENCY_KEY_REQUIRED', 180);
    if (idempotencyKey.length < 16) fail('PURCHASE_BROWSER_IDEMPOTENCY_KEY_INVALID');
    const preview = canonicalPreview(input, account);
    const requestFingerprint = sha256(JSON.stringify(preview));
    const idempotencyKeyHash = sha256(`purchase-browser-idempotency-v1\0${idempotencyKey}`);
    const existing = db.prepare('SELECT * FROM purchase_browser_tasks WHERE idempotency_key_hash = ?').get(idempotencyKeyHash);
    if (existing) {
      if (existing.request_fingerprint !== requestFingerprint) {
        fail('PURCHASE_BROWSER_IDEMPOTENCY_KEY_CONFLICT');
      }
      return { ok: true, reused: true, task: publicTask(existing, receiptByTaskId(existing.id)) };
    }
    const timestamp = now();
    const taskId = createTaskId();
    const previewFingerprint = sha256(`purchase-browser-preview-v1\0${requestFingerprint}\0${taskId}`);
    db.prepare(`
      INSERT INTO purchase_browser_tasks (
        id, owner_id, owner_incarnation, shop_id, order_key, product_key,
        idempotency_key_hash, request_fingerprint, preview_encrypted,
        preview_fingerprint, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'previewed', ?, ?)
    `).run(
      taskId,
      preview.ownerId,
      preview.ownerIncarnation,
      preview.shopId || null,
      preview.orderKey,
      preview.productKey,
      idempotencyKeyHash,
      requestFingerprint,
      encryptSecret(JSON.stringify(preview)),
      previewFingerprint,
      timestamp,
      timestamp,
    );
    return { ok: true, reused: false, task: getTask(taskId) };
  }

  function confirmTask(taskId, input = {}) {
    const row = rowById(taskId);
    if (!row) fail('PURCHASE_BROWSER_TASK_NOT_FOUND');
    assertOwnerAvailable(row.owner_id);
    if (input.confirm !== true) fail('PURCHASE_BROWSER_HUMAN_CONFIRMATION_REQUIRED');
    if (input.previewFingerprint !== row.preview_fingerprint) {
      fail('PURCHASE_BROWSER_PREVIEW_FINGERPRINT_MISMATCH');
    }
    if (row.status === 'completed') return { ok: true, alreadyCompleted: true, task: getTask(taskId) };
    // Once a capability has been issued or an attempt has failed/interrupted,
    // this preview can never mint another website-execution capability.  A
    // retry requires a new preview/idempotency key and a fresh human review.
    if (row.status !== 'previewed') fail('PURCHASE_BROWSER_FRESH_PREVIEW_REQUIRED');
    const preview = parseEncrypted(row.preview_encrypted);
    const confirmation = input.confirmation && typeof input.confirmation === 'object'
      ? input.confirmation
      : {};
    const canonicalConfirmation = {
      productTitle: requiredText(confirmation.productTitle, 'PURCHASE_BROWSER_CONFIRMATION_MISMATCH', 300),
      variant: requiredText(confirmation.variant, 'PURCHASE_BROWSER_CONFIRMATION_MISMATCH', 200),
      quantity: normalizeQuantity(confirmation.quantity),
      address: requiredText(confirmation.address, 'PURCHASE_BROWSER_CONFIRMATION_MISMATCH', 500),
      expectedAmount: normalizeMoney(confirmation.expectedAmount, 'PURCHASE_BROWSER_CONFIRMATION_MISMATCH'),
    };
    const expected = {
      productTitle: preview.productTitle,
      variant: preview.variant,
      quantity: preview.quantity,
      address: preview.address,
      expectedAmount: preview.expectedAmount,
    };
    if (JSON.stringify(canonicalConfirmation) !== JSON.stringify(expected)) {
      fail('PURCHASE_BROWSER_CONFIRMATION_MISMATCH');
    }
    const currentAccount = accountRow(row.owner_id);
    if (!currentAccount || currentAccount.created_at !== row.owner_incarnation) {
      fail('PURCHASE_BROWSER_OWNER_INCARNATION_CHANGED');
    }
    const capability = createCapability();
    const timestamp = now();
    db.prepare(`
      UPDATE purchase_browser_tasks
      SET status = 'confirmed', execution_capability_hash = ?, attempt_id = NULL,
        last_error_code = NULL, confirmed_at = ?, completed_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(sha256(capability), timestamp, timestamp, taskId);
    return { ok: true, task: getTask(taskId), executionCapability: capability };
  }

  function claimTask(taskId, input = {}) {
    const row = rowById(taskId);
    if (!row) fail('PURCHASE_BROWSER_TASK_NOT_FOUND');
    if (fencedOwners.has(row.owner_id)) fail('PURCHASE_BROWSER_OWNER_FENCED');
    if (row.status === 'completed') return { ok: true, alreadyCompleted: true, task: getTask(taskId) };
    if (row.status !== 'confirmed') fail('PURCHASE_BROWSER_TASK_NOT_CONFIRMED');
    const capability = requiredText(input.executionCapability, 'PURCHASE_BROWSER_EXECUTION_CAPABILITY_REQUIRED', 180);
    if (!constantTimeHashMatches(row.execution_capability_hash, capability)) {
      fail('PURCHASE_BROWSER_EXECUTION_CAPABILITY_INVALID');
    }
    const attemptId = createAttemptId();
    const timestamp = now();
    const changed = db.prepare(`
      UPDATE purchase_browser_tasks
      SET status = 'executing', execution_capability_hash = NULL, attempt_id = ?,
        attempt_count = attempt_count + 1, last_error_code = NULL, updated_at = ?
      WHERE id = ? AND status = 'confirmed' AND execution_capability_hash = ?
    `).run(attemptId, timestamp, taskId, row.execution_capability_hash);
    if (changed.changes !== 1) fail('PURCHASE_BROWSER_TASK_CLAIM_CONFLICT');
    return { ok: true, attemptId, task: getTask(taskId) };
  }

  function failTask(taskId, input = {}) {
    const row = rowById(taskId);
    if (!row) fail('PURCHASE_BROWSER_TASK_NOT_FOUND');
    const attemptId = requiredText(input.attemptId, 'PURCHASE_BROWSER_ATTEMPT_ID_REQUIRED', 120);
    if (row.attempt_id !== attemptId || !ACTIVE_EXECUTION_STATUSES.includes(row.status)) {
      fail('PURCHASE_BROWSER_ATTEMPT_CONFLICT');
    }
    const errorCode = requiredText(input.errorCode, 'PURCHASE_BROWSER_FAILURE_CODE_REQUIRED', 120);
    db.prepare(`
      UPDATE purchase_browser_tasks
      SET status = 'failed', attempt_id = NULL, last_error_code = ?, updated_at = ?
      WHERE id = ? AND attempt_id = ?
    `).run(errorCode, now(), taskId, attemptId);
    return { ok: true, task: getTask(taskId) };
  }

  function completeTask(taskId, input = {}) {
    const row = rowById(taskId);
    if (!row) fail('PURCHASE_BROWSER_TASK_NOT_FOUND');
    if (row.status === 'completed') {
      const existingReceipt = receiptByTaskId(taskId);
      if (existingReceipt && input.receiptHash === existingReceipt.receipt_hash) {
        const account = accountRow(row.owner_id);
        if (!account) fail('PURCHASE_BROWSER_OWNER_NOT_FOUND');
        db.exec('BEGIN IMMEDIATE');
        try {
          archivePurchaseCompletionRow(db, {
            taskRow: row,
            receiptRow: existingReceipt,
            platformName: account.platform_name || '',
            archiveOrigin: 'idempotent-readback',
            completedAt: row.completed_at,
            archivedAt: now(),
          });
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        return { ok: true, alreadyCompleted: true, task: getTask(taskId) };
      }
      fail('PURCHASE_BROWSER_RECEIPT_CONFLICT');
    }
    const attemptId = requiredText(input.attemptId, 'PURCHASE_BROWSER_ATTEMPT_ID_REQUIRED', 120);
    if (row.status !== 'executing' || row.attempt_id !== attemptId) {
      fail('PURCHASE_BROWSER_ATTEMPT_CONFLICT');
    }
    if (input.websiteReadbackVerified !== true) {
      fail('PURCHASE_BROWSER_WEBSITE_READBACK_REQUIRED');
    }
    const rawReceipt = input.receipt && typeof input.receipt === 'object' ? input.receipt : {};
    const receiptEvidence = Object.freeze({
      orderNumber: safeKey(rawReceipt.orderNumber, 'PURCHASE_BROWSER_RECEIPT_ORDER_NUMBER_REQUIRED'),
      amount: normalizeMoney(rawReceipt.amount, 'PURCHASE_BROWSER_RECEIPT_AMOUNT_INVALID'),
      status: requiredText(rawReceipt.status, 'PURCHASE_BROWSER_RECEIPT_STATUS_REQUIRED', 120),
      pageUrl: normalizeTargetUrl(rawReceipt.pageUrl),
    });
    const receipt = Object.freeze({ ...receiptEvidence, receivedAt: now() });
    const preview = parseEncrypted(row.preview_encrypted);
    if (receipt.amount !== preview.expectedAmount) {
      fail('PURCHASE_BROWSER_RECEIPT_AMOUNT_MISMATCH');
    }
    // The website/main-process proof hashes only website-observed fields.  The
    // server timestamp is appended afterwards and therefore cannot make the
    // caller guess a future value.
    const receiptHash = sha256(JSON.stringify(receiptEvidence));
    if (input.receiptHash !== receiptHash) fail('PURCHASE_BROWSER_RECEIPT_HASH_MISMATCH');
    const websiteReadbackHash = requiredText(
      input.websiteReadbackHash,
      'PURCHASE_BROWSER_WEBSITE_READBACK_HASH_REQUIRED',
      64,
    );
    if (!SHA256_PATTERN.test(websiteReadbackHash)) fail('PURCHASE_BROWSER_WEBSITE_READBACK_HASH_INVALID');
    const timestamp = now();
    const receiptId = createReceiptId();
    const receiptEncrypted = encryptSecret(JSON.stringify(receipt));
    db.exec('BEGIN IMMEDIATE');
    try {
      const changed = db.prepare(`
        UPDATE purchase_browser_tasks
        SET status = 'receipt_pending', updated_at = ?
        WHERE id = ? AND status = 'executing' AND attempt_id = ?
      `).run(timestamp, taskId, attemptId);
      if (changed.changes !== 1) fail('PURCHASE_BROWSER_ATTEMPT_CONFLICT');
      db.prepare(`
      INSERT INTO purchase_browser_receipts (
          id, task_id, owner_id, shop_id, attempt_id, receipt_encrypted,
          receipt_hash, website_readback_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        receiptId,
        taskId,
        row.owner_id,
        row.shop_id || null,
        attemptId,
        receiptEncrypted,
        receiptHash,
        websiteReadbackHash,
        timestamp,
      );
      const readback = receiptByTaskId(taskId);
      if (
        !readback
        || readback.receipt_hash !== receiptHash
        || JSON.stringify(parseEncrypted(readback.receipt_encrypted)) !== JSON.stringify(receipt)
      ) {
        fail('PURCHASE_BROWSER_RECEIPT_READBACK_FAILED');
      }
      const account = accountRow(row.owner_id);
      if (!account) fail('PURCHASE_BROWSER_OWNER_NOT_FOUND');
      archivePurchaseCompletionRow(db, {
        taskRow: row,
        receiptRow: readback,
        preview,
        receipt,
        platformName: account.platform_name || '',
        archiveOrigin: 'website-readback',
        completedAt: timestamp,
        archivedAt: timestamp,
      });
      const completedChange = db.prepare(`
        UPDATE purchase_browser_tasks
        SET status = 'completed', receipt_id = ?, attempt_id = NULL,
          completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'receipt_pending'
      `).run(receiptId, timestamp, timestamp, taskId);
      if (completedChange.changes !== 1) fail('PURCHASE_BROWSER_RECEIPT_READBACK_FAILED');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const completed = getTask(taskId);
    if (completed.status !== 'completed' || completed.receipt?.receiptHash !== receiptHash) {
      fail('PURCHASE_BROWSER_RECEIPT_READBACK_FAILED');
    }
    const history = db.prepare(`
      SELECT receipt_hash FROM purchase_completion_history WHERE source_receipt_id = ?
    `).get(receiptId);
    if (history?.receipt_hash !== receiptHash) fail('PURCHASE_BROWSER_RECEIPT_READBACK_FAILED');
    return { ok: true, task: completed };
  }

  function listTasks(ownerId, { limit = 50 } = {}) {
    const normalizedOwnerId = safeKey(ownerId, 'PURCHASE_BROWSER_OWNER_ID_INVALID');
    const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    return db.prepare(`
      SELECT * FROM purchase_browser_tasks
      WHERE owner_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(normalizedOwnerId, boundedLimit).map((row) => publicTask(row, receiptByTaskId(row.id)));
  }

  function recordPluginState(input = {}) {
    const ownerId = safeKey(input.ownerId, 'PURCHASE_BROWSER_OWNER_ID_INVALID');
    const account = accountRow(ownerId);
    if (!account) fail('PURCHASE_BROWSER_OWNER_NOT_FOUND');
    const extensionId = requiredText(input.extensionId, 'PURCHASE_BROWSER_EXTENSION_ID_INVALID', 32);
    if (!EXTENSION_ID_PATTERN.test(extensionId)) fail('PURCHASE_BROWSER_EXTENSION_ID_INVALID');
    const extensionVersion = requiredText(input.extensionVersion, 'PURCHASE_BROWSER_EXTENSION_VERSION_INVALID', 40);
    if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(extensionVersion)) {
      fail('PURCHASE_BROWSER_EXTENSION_VERSION_INVALID');
    }
    const packageSha256 = requiredText(input.packageSha256, 'PURCHASE_BROWSER_EXTENSION_HASH_INVALID', 64);
    if (!SHA256_PATTERN.test(packageSha256)) fail('PURCHASE_BROWSER_EXTENSION_HASH_INVALID');
    const installState = requiredText(input.installState, 'PURCHASE_BROWSER_EXTENSION_STATE_INVALID', 20);
    if (!['verified', 'active', 'rollback', 'failed'].includes(installState)) {
      fail('PURCHASE_BROWSER_EXTENSION_STATE_INVALID');
    }
    db.prepare(`
      INSERT INTO purchase_browser_plugin_state (
        owner_id, owner_incarnation, extension_id, extension_version,
        package_sha256, install_state, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_id) DO UPDATE SET
        owner_incarnation = excluded.owner_incarnation,
        extension_id = excluded.extension_id,
        extension_version = excluded.extension_version,
        package_sha256 = excluded.package_sha256,
        install_state = excluded.install_state,
        updated_at = excluded.updated_at
    `).run(
      ownerId,
      account.created_at,
      extensionId,
      extensionVersion,
      packageSha256,
      installState,
      now(),
    );
    return { ok: true, ownerId, extensionId, extensionVersion, packageSha256, installState };
  }

  function activeCount(ownerId) {
    return Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM purchase_browser_tasks
      WHERE owner_id = ? AND status IN ('executing', 'receipt_pending')
    `).get(ownerId)?.count) || 0;
  }

  function getAccountRemovalStatus(owner) {
    if (owner?.ownerType !== 'purchase_account') return { fenced: false, active: 0 };
    return { fenced: fencedOwners.has(owner.ownerId), active: activeCount(owner.ownerId) };
  }

  function getOwnerBinding(ownerId) {
    const normalizedOwnerId = safeKey(ownerId, 'PURCHASE_BROWSER_OWNER_ID_INVALID');
    const account = assertOwnerAvailable(normalizedOwnerId);
    return Object.freeze({
      accountId: account.id,
      accountIncarnation: account.created_at,
      platformName: account.platform_name || '',
    });
  }

  async function quiesceAccountRemoval(owner, { timeoutMs = 30_000 } = {}) {
    if (owner?.ownerType !== 'purchase_account') return { ok: true, fenced: false, active: 0 };
    const ownerId = safeKey(owner.ownerId, 'PURCHASE_BROWSER_OWNER_ID_INVALID');
    fencedOwners.add(ownerId);
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    while (activeCount(ownerId) > 0 && Date.now() < deadline) await delay(20);
    const active = activeCount(ownerId);
    if (active > 0) fail('ACCOUNT_REMOVAL_QUIESCE_TIMEOUT');
    return { ok: true, fenced: true, active: 0 };
  }

  function releaseAccountRemovalFence(owner) {
    if (owner?.ownerType === 'purchase_account') fencedOwners.delete(owner.ownerId);
    return { ok: true, fenced: false, active: 0 };
  }

  return Object.freeze({
    claimTask,
    completeTask,
    confirmTask,
    failTask,
    getAccountRemovalStatus,
    getOwnerBinding,
    getTask,
    listTasks,
    previewTask,
    quiesceAccountRemoval,
    recordPluginState,
    releaseAccountRemovalFence,
  });
}
